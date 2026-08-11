// Firebase Cloud Functions for "In the Loop" push notifications.
//
// What this does:
// Watches Firestore for new documents in `mod_alerts` and `mod_notifications`
// (the same collections the app already writes to when a moderator posts
// something), and the instant one appears, sends a real Web Push
// notification to every device that's subscribed — even if nobody has the
// website open in a browser tab.
//
// Also runs `syncLastSeenCars`, a scheduled function (every 1 minute) that
// polls MBTA's vehicle feeds for all 4 lines server-side and writes each
// car's last-tracked station to Firestore. This replaces what used to be a
// write every visitor's browser made independently (redundant duplicate
// writes any time more than one person had the site open) with a single
// centralized writer, regardless of how many people are viewing the site.
// The same run also maintains two more pieces of roster data from that
// same MBTA data, at no extra API cost:
//   - firstTrackedToday / trackingDay on each roster doc: when a car was
//     first seen active today, holding steady through brief tracker gaps
//     and only resetting once it's been missing longer than a grace
//     period (see FIRST_TRACKED_GRACE_MS below).
//   - a pair_history/{key} doc per car logging which other car it's been
//     physically coupled with over time (from the same "carriages" data
//     already fetched for last-seen tracking), with a from/to timestamp
//     per stretch — including "unpaired" stretches.
//
// What this does NOT do (yet):
// Automatic detections made client-side (double Type 8s, Type 9 cars, Pride
// car, etc.) still only fire while someone has a browser tab open and
// polling MBTA's API. Making those trigger real push too would need a
// separate scheduled function that does its own MBTA polling server-side —
// a follow-up piece, not part of this file.
//
// ---- One-time setup (see the deployment instructions provided alongside
// this file for the full walkthrough) ----
// 1. This file and package.json go in a `functions/` folder at the root of
//    your project (same repo as index.html, alongside it, not inside it).
// 2. Your Firebase project needs to be on the Blaze (pay-as-you-go) plan —
//    Cloud Functions can't make outbound network calls (which sending a
//    push requires) on the free Spark plan.
// 3. Store the VAPID private key as a Firebase secret (never commit it to
//    the repo):
//      firebase functions:secrets:set VAPID_PRIVATE_KEY
//    (paste the private key when prompted)
// 4. Deploy with: firebase deploy --only functions

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const webpush = require('web-push');

admin.initializeApp();
const db = admin.firestore();

const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');

// Must match VAPID_PUBLIC_KEY in index.html exactly — this is the public
// half of the same key pair, safe to hardcode here since it's not a secret.
const VAPID_PUBLIC_KEY = 'BHEIq4o6pknFsV-fssjBnXccc-5tX1w8V9ojTS4ilQ2YEuNYJR2cW2BNlObuckum_6mbTireruMCe8kjUx3dYaA';

// Sends one push payload to every currently-subscribed device, cleaning up
// any subscription the push service reports as dead (expired, unsubscribed,
// or the device revoked permission) so push_subscriptions doesn't
// accumulate stale entries forever.
async function sendToAllSubscribers(payload){
  webpush.setVapidDetails(
    'mailto:noreply@thembtaloop.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY.value()
  );

  const snap = await db.collection('push_subscriptions').get();
  if(snap.empty) return;

  const payloadStr = JSON.stringify(payload);
  const deletions = [];

  await Promise.all(snap.docs.map(async (doc) => {
    const { subscription } = doc.data();
    if(!subscription) return;
    try{
      await webpush.sendNotification(subscription, payloadStr);
    }catch(err){
      // 404/410 = the push service says this subscription is gone for good.
      if(err.statusCode === 404 || err.statusCode === 410){
        deletions.push(doc.ref.delete());
      }else{
        console.error('Push send failed for', doc.id, err.statusCode, err.message);
      }
    }
  }));

  if(deletions.length) await Promise.all(deletions);
}

exports.sendPushOnModAlert = onDocumentCreated(
  { document: 'mod_alerts/{alertId}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const data = event.data.data();
    if(!data || !data.text) return;
    await sendToAllSubscribers({
      title: 'In the Loop — Service Alert',
      body: data.text.slice(0, 180),
      url: './'
    });
  }
);

exports.sendPushOnModNotification = onDocumentCreated(
  { document: 'mod_notifications/{notifId}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const data = event.data.data();
    if(!data || !data.subject) return;
    await sendToAllSubscribers({
      title: data.subject.slice(0, 100),
      body: (data.body || '').slice(0, 180),
      url: './'
    });
  }
);

// ---------------------------------------------------------------------------
// syncLastSeenCars — centralizes "last tracked station" writes for the Fleet
// Roster. Used to be written by every visitor's own browser (index.html's
// updateLastSeenTracking); now written once per minute by this function
// instead, so Firestore write volume no longer scales with concurrent
// viewers. Mirrors the same key format (rosterStorageKey), same
// carriages-vs-label preference (getCarNumbersForVehicle), and same Blue
// Line 4-digit zero-padding as the client code in index.html — if any of
// that logic changes there, mirror the change here too.
//
// Not treated as a secret: this is the same public MBTA v3 API key already
// shipped client-side in index.html (registered key for higher rate limits,
// not sensitive credentials).
const MBTA_API_KEY = '7171c5e6f11c447bb3591c1fc1f3b5a9';
const MBTA_HEADERS = { 'Accept': 'application/vnd.api+json' };

const LAST_SEEN_LINE_FEEDS = [
  {
    line: 'green',
    url: 'https://api-v3.mbta.com/vehicles?filter[route]=Green-B,Green-C,Green-D,Green-E,Mattapan&include=stop&fields[vehicle]=label&fields[stop]=name'
  },
  {
    line: 'red',
    url: 'https://api-v3.mbta.com/vehicles?filter[route]=Red&include=stop&fields[vehicle]=label,carriages&fields[stop]=name'
  },
  {
    line: 'orange',
    url: 'https://api-v3.mbta.com/vehicles?filter[route]=Orange&include=stop&fields[vehicle]=label,carriages&fields[stop]=name'
  },
  {
    line: 'blue',
    url: 'https://api-v3.mbta.com/vehicles?filter[route]=Blue&include=stop&fields[vehicle]=label,carriages&fields[stop]=name'
  }
];

function rosterStorageKey(line, carNum){
  return line === 'green' ? String(carNum) : `${line}-${carNum}`;
}

// Same logic as index.html's getCarNumbersForVehicle: prefer the full
// carriages list (one entry per real physical car) over the label (often
// just the lead car/pair) when carriages is more complete. Blue Line car
// numbers additionally get zero-padded to 4 digits to match the roster's
// storage keys (see index.html buildRosterCarList).
function getCarNumbersForVehicle(line, label, carriages){
  const labelParts = String(label).split('-');
  const carriageLabels = (carriages || []).map(c => c.label).filter(Boolean);
  let nums = carriageLabels.length > labelParts.length ? carriageLabels : labelParts;
  if(line === 'blue'){
    nums = nums.map(n => String(n).padStart(4, '0'));
  }
  return nums;
}

async function fetchLineVehicles(line, url){
  const fullUrl = url + (url.includes('?') ? '&' : '?') + 'api_key=' + MBTA_API_KEY;
  const res = await fetch(fullUrl, { headers: MBTA_HEADERS });
  if(!res.ok) throw new Error(`MBTA API returned ${res.status} for ${line}`);
  const json = await res.json();

  const included = {};
  (json.included || []).forEach(item => { included[item.type + ':' + item.id] = item.attributes; });

  const results = [];
  (json.data || []).forEach(v => {
    const stopRel = v.relationships && v.relationships.stop && v.relationships.stop.data;
    const stopName = stopRel ? (included['stop:' + stopRel.id] || {}).name : null;
    if(!stopName) return;
    const carNums = getCarNumbersForVehicle(line, v.attributes.label, v.attributes.carriages);
    const keys = carNums.map(n => rosterStorageKey(line, n));
    // Married pairs are fixed 2-car units — a 4-car train (two pairs
    // coupled together) isn't one big "partner group," it's two separate
    // pairs, so partners are matched up by adjacent position in the
    // consist (0-1, 2-3, ...) rather than treating everyone in the train
    // as everyone else's partner. A car with no adjacent partner (running
    // alone, or an odd one out) has partner: null ("unpaired").
    keys.forEach((key, i) => {
      const pairStart = i - (i % 2);
      const partnerIdx = (i % 2 === 0) ? pairStart + 1 : pairStart;
      const partner = keys[partnerIdx] || null;
      results.push({ key, stopName, partner });
    });
  });
  return results;
}

// Firestore batched writes cap at 500 operations each, so writes get
// chunked across as many batches as needed rather than assuming everything
// fits in one.
async function commitRosterPatches(entries){
  const CHUNK_SIZE = 450;
  for(let i = 0; i < entries.length; i += CHUNK_SIZE){
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const batch = db.batch();
    chunk.forEach(([key, patch]) => {
      batch.set(db.collection('roster').doc(key), patch, { merge: true });
    });
    await batch.commit();
  }
}

// A car missing from the live feed for less than this is assumed to be a
// brief tracker/AVL hiccup rather than actually pulled from service —
// matches index.html's own "10 minute grace period before a train
// disappears from the map" convention (NON_TERMINUS_KEEP_ALIVE_MS), with a
// little extra buffer since this runs on a 1-minute server poll rather
// than continuous client-side GPS.
const FIRST_TRACKED_GRACE_MS = 15 * 60 * 1000; // 15 minutes

// Bounds how far back a car's pair-history entries are kept (Eamon's "last
// 2 weeks or so," with headroom) and how many stretches a single doc can
// accumulate, so pair_history docs don't grow unbounded.
const PAIR_HISTORY_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000; // 3 weeks
const PAIR_HISTORY_MAX_ENTRIES = 40;

// MBTA's service day doesn't end at midnight — matches index.html's own
// todayDateString(): shifting back 3.5h before taking the date means a
// late-night trip before ~3:30am Eastern still counts as the previous
// day's service, instead of flipping over at midnight.
function todayDateString(){
  const shifted = new Date(Date.now() - (3.5 * 60 * 60 * 1000));
  return shifted.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Every invocation of a scheduled function starts with a clean process — no
// memory of the last run — so "did anything actually change" has to be
// persisted somewhere between runs, for all three things this function
// tracks. Without this, the first version of this function wrote every
// currently-tracked car's position on every single 1-minute run regardless
// of whether it moved. Three small state docs (same pattern as
// functions-webhooks' bot_state/train_spotting) hold what was true as of
// the last run; only real changes turn into an actual roster/pair_history
// write.
const LAST_SEEN_STATE_REF = () => db.collection('bot_state').doc('roster_last_seen');
const FIRST_TRACKED_STATE_REF = () => db.collection('bot_state').doc('first_tracked_today');
const PAIR_STATE_REF = () => db.collection('bot_state').doc('pair_tracking');

async function commitPairChanges(changes, ts){
  await Promise.all(changes.map(async ({ key, partner }) => {
    const ref = db.collection('pair_history').doc(key);
    try{
      const snap = await ref.get();
      const entries = snap.exists ? (snap.data().entries || []) : [];
      if(entries.length){
        entries[entries.length - 1].to = ts;
      }
      entries.push({ partner, from: ts, to: null });
      const cutoff = ts - PAIR_HISTORY_MAX_AGE_MS;
      const trimmed = entries.filter(e => (e.to || ts) >= cutoff).slice(-PAIR_HISTORY_MAX_ENTRIES);
      await ref.set({ entries: trimmed, updatedAt: ts });
    }catch(e){
      console.error(`Failed to update pair history for ${key}:`, e);
    }
  }));
}

exports.syncLastSeenCars = onSchedule('every 1 minutes', async () => {
  const settled = await Promise.allSettled(
    LAST_SEEN_LINE_FEEDS.map(({ line, url }) => fetchLineVehicles(line, url))
  );

  const current = [];
  settled.forEach((result, i) => {
    if(result.status === 'fulfilled'){
      current.push(...result.value);
    }else{
      console.error(`Failed to sync ${LAST_SEEN_LINE_FEEDS[i].line} last-seen data:`, result.reason);
    }
  });
  if(current.length === 0) return;

  const now = Date.now();
  const today = todayDateString();

  // ---- last-seen station + first-tracked-today, merged into one roster
  // write per car when either changes ----
  const stateRef = LAST_SEEN_STATE_REF();
  const firstTrackedRef = FIRST_TRACKED_STATE_REF();
  const [stateSnap, firstTrackedSnap] = await Promise.all([stateRef.get(), firstTrackedRef.get()]);
  const priorStops = stateSnap.exists ? (stateSnap.data().stops || {}) : {};
  const priorActive = firstTrackedSnap.exists ? (firstTrackedSnap.data().cars || {}) : {};

  const nextStops = {};
  const nextActive = {};
  const rosterPatches = {};
  const currentKeys = new Set();

  current.forEach(({ key, stopName }) => {
    currentKeys.add(key);
    nextStops[key] = stopName;
    if(priorStops[key] !== stopName){
      rosterPatches[key] = Object.assign({}, rosterPatches[key], { lastSeenAt: now, lastSeenStop: stopName });
    }

    const prior = priorActive[key];
    if(prior && prior.trackingDay === today){
      // Already tracked today and hasn't been gone long enough to reset —
      // keep the original first-tracked time, just refresh the
      // still-active clock used to judge the next gap.
      nextActive[key] = { lastActiveAt: now, trackingDay: today, firstTrackedToday: prior.firstTrackedToday };
    }else{
      // Either a new service day, or this car's prior session already
      // timed out and was reset below — this run counts as a fresh
      // "pull out."
      nextActive[key] = { lastActiveAt: now, trackingDay: today, firstTrackedToday: now };
      rosterPatches[key] = Object.assign({}, rosterPatches[key], { firstTrackedToday: now, trackingDay: today });
    }
  });

  // Cars that were being tracked but are missing this run: carry them
  // forward unchanged while still inside the grace period, or reset once
  // they've been gone longer — so a later reappearance starts a genuinely
  // new "pull out" instead of resuming the old one.
  Object.keys(priorActive).forEach(key=>{
    if(currentKeys.has(key)) return;
    const prior = priorActive[key];
    if((now - prior.lastActiveAt) > FIRST_TRACKED_GRACE_MS){
      rosterPatches[key] = Object.assign({}, rosterPatches[key], { firstTrackedToday: null, trackingDay: null });
    }else{
      nextActive[key] = prior;
    }
  });

  const patchEntries = Object.entries(rosterPatches);
  if(patchEntries.length) await commitRosterPatches(patchEntries);
  await stateRef.set({ stops: nextStops, updatedAt: now });
  await firstTrackedRef.set({ cars: nextActive, updatedAt: now });

  // ---- pair tracking, from the same carriages data ----
  const pairStateRef = PAIR_STATE_REF();
  const pairStateSnap = await pairStateRef.get();
  const priorPairs = pairStateSnap.exists ? (pairStateSnap.data().cars || {}) : {};
  const nextPairs = {};
  const pairChanges = [];
  current.forEach(({ key, partner }) => {
    nextPairs[key] = partner || null;
    if((priorPairs[key] || null) !== (partner || null)){
      pairChanges.push({ key, partner: partner || null });
    }
  });
  if(pairChanges.length) await commitPairChanges(pairChanges, now);
  await pairStateRef.set({ cars: nextPairs, updatedAt: now });
});
