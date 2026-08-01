// Firebase Cloud Functions that mirror mod alerts/notifications and
// train-spotting detections (double Type 8s, Type 9 cars, the Pride car)
// to a Discord webhook. This is a separate codebase from ../functions
// (which handles browser push notifications and the roster's last-seen
// sync) — it was originally deployed on its own, outside this repo, and
// was reconstructed here from the live deployed source on 2026-08-01 so
// it's tracked in git and won't get silently deleted by a future
// `firebase deploy` prompting to remove "orphaned" functions.
//
// One-time setup:
// 1. firebase functions:secrets:set DISCORD_WEBHOOK_URL
//    (paste your Discord channel's webhook URL when prompted)
// 2. Optionally raise MBTA's public rate limit by setting an API key at
//    deploy time when prompted for MBTA_API_KEY (blank is fine otherwise).
// 3. Deploy with: firebase deploy --only functions:webhooks
//    (deploys only this codebase — see firebase.json for the codebase list;
//    the roster/push codebase in ../functions deploys separately as
//    functions:default, or omit --only functions:<name> to deploy both)

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getCarType, PRIDE_CAR_NUMBER } from './carTypes.js';

initializeApp();
const db = getFirestore();

// Set with: firebase functions:secrets:set DISCORD_WEBHOOK_URL
const DISCORD_WEBHOOK_URL = defineSecret('DISCORD_WEBHOOK_URL');

// Not sensitive — raises MBTA's public rate limit. Set with:
// firebase functions:config wouldn't apply here; instead set as an
// environment-style param at deploy time (see README), default '' is fine.
const MBTA_API_KEY = defineString('MBTA_API_KEY', { default: '' });

const GREEN_AND_MATTAPAN = ['Green-B', 'Green-C', 'Green-D', 'Green-E', 'Mattapan'];

async function postToDiscord(webhookUrl, embed) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });
  if (!res.ok) {
    console.error('Discord webhook post failed:', res.status, await res.text());
  }
}

/* ---------------- Moderator alerts / notifications ---------------- */

export const onModAlert = onDocumentCreated(
  { document: 'mod_alerts/{alertId}', secrets: [DISCORD_WEBHOOK_URL] },
  async event => {
    const data = event.data.data();
    await postToDiscord(DISCORD_WEBHOOK_URL.value(), {
      title: '⚠️ Alert',
      description: data.text || '',
      color: 0xd64545,
      footer: data.postedBy ? { text: `Posted by ${data.postedBy}` } : undefined,
      timestamp: new Date(data.ts || Date.now()).toISOString()
    });
  }
);

export const onModNotification = onDocumentCreated(
  { document: 'mod_notifications/{notifId}', secrets: [DISCORD_WEBHOOK_URL] },
  async event => {
    const data = event.data.data();
    await postToDiscord(DISCORD_WEBHOOK_URL.value(), {
      title: `📢 ${data.subject || 'Notification'}`,
      description: data.body || '',
      color: 0x3498db,
      footer: data.postedBy ? { text: `Posted by ${data.postedBy}` } : undefined,
      timestamp: new Date(data.ts || Date.now()).toISOString()
    });
  }
);

/* ---------------- Train-spotting (scheduled poll) ----------------
   Cloud Scheduler's minimum interval is 1 minute (the app's own client-side
   check runs every 15s while a browser tab is open — this is the closest
   equivalent for a serverless job). "Currently notified" ids are persisted
   in Firestore between runs since each invocation starts with a clean
   process, unlike the always-running bot version. */

export const trainSpottingPoll = onSchedule(
  { schedule: 'every 1 minutes', secrets: [DISCORD_WEBHOOK_URL] },
  async () => {
    const webhookUrl = DISCORD_WEBHOOK_URL.value();
    const apiKey = MBTA_API_KEY.value();

    const url =
      `https://api-v3.mbta.com/vehicles?filter[route]=${GREEN_AND_MATTAPAN.join(',')}` +
      `&include=trip&fields[vehicle]=label&fields[trip]=headsign`;
    const headers = apiKey ? { 'x-api-key': apiKey } : {};

    let json;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`MBTA fetch failed: ${res.status}`);
      json = await res.json();
    } catch (e) {
      console.error('MBTA fetch failed:', e.message);
      return;
    }

    const included = {};
    (json.included || []).forEach(item => {
      included[`${item.type}:${item.id}`] = item.attributes;
    });

    const vehicles = (json.data || []).map(v => {
      const routeId = v.relationships?.route?.data?.id || '';
      const tripRel = v.relationships?.trip?.data;
      const headsign = tripRel ? included[`trip:${tripRel.id}`]?.headsign : null;
      return { id: v.id, route: routeId, label: v.attributes.label || v.id, headsign };
    });

    const stateRef = db.collection('bot_state').doc('train_spotting');
    const stateSnap = await stateRef.get();
    const prior = stateSnap.exists ? stateSnap.data() : { double: [], pride: [], type9: [] };

    const notifiedDouble = new Set(prior.double || []);
    const notifiedPride = new Set(prior.pride || []);
    const notifiedType9 = new Set(prior.type9 || []);

    const seenDouble = new Set();
    const seenPride = new Set();
    const seenType9 = new Set();
    const toSend = [];

    vehicles.forEach(v => {
      const cars = String(v.label).split('-');
      const line = v.route.replace('Green-', '');
      const dest = v.headsign || 'Unknown destination';
      const description = `${line} line to ${dest}. Cars: ${v.label}`;

      if (cars.length >= 2 && cars.every(c => getCarType(c) === 'Type 8')) {
        seenDouble.add(v.id);
        if (!notifiedDouble.has(v.id)) {
          notifiedDouble.add(v.id);
          toSend.push({ title: '🚋 Double Type 8s spotted', description, color: 0x2ecc71 });
        }
      }

      if (cars.includes(PRIDE_CAR_NUMBER)) {
        seenPride.add(v.id);
        if (!notifiedPride.has(v.id)) {
          notifiedPride.add(v.id);
          toSend.push({ title: '🏳️‍🌈 Pride train spotted', description, color: 0xe91e63 });
        }
      }

      if (cars.some(c => getCarType(c) === 'Type 9')) {
        seenType9.add(v.id);
        if (!notifiedType9.has(v.id)) {
          notifiedType9.add(v.id);
          toSend.push({ title: '🚈 Type 9 car spotted', description, color: 0x9b59b6 });
        }
      }
    });

    // Drop ids that dropped off the feed so the same physical train can
    // re-trigger a notification the next time it appears.
    [...notifiedDouble].forEach(id => { if (!seenDouble.has(id)) notifiedDouble.delete(id); });
    [...notifiedPride].forEach(id => { if (!seenPride.has(id)) notifiedPride.delete(id); });
    [...notifiedType9].forEach(id => { if (!seenType9.has(id)) notifiedType9.delete(id); });

    await stateRef.set({
      double: [...notifiedDouble],
      pride: [...notifiedPride],
      type9: [...notifiedType9]
    });

    for (const embed of toSend) {
      await postToDiscord(webhookUrl, { ...embed, timestamp: new Date().toISOString() });
    }
  }
);
