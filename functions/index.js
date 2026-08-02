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
    carNums.forEach(carNum => results.push({ key: rosterStorageKey(line, carNum), stopName }));
  });
  return results;
}

// Firestore batched writes cap at 500 operations each, so writes get
// chunked across as many batches as needed rather than assuming everything
// fits in one.
async function commitInChunks(writes, ts){
  const CHUNK_SIZE = 450;
  for(let i = 0; i < writes.length; i += CHUNK_SIZE){
    const chunk = writes.slice(i, i + CHUNK_SIZE);
    const batch = db.batch();
    chunk.forEach(({ key, stopName }) => {
      batch.set(db.collection('roster').doc(key), {
        lastSeenAt: ts, lastSeenStop: stopName
      }, { merge: true });
    });
    await batch.commit();
  }
}

// Every invocation of a scheduled function starts with a clean process — no
// memory of the last run — so "did this car's station actually change"
// has to be persisted somewhere between runs. Without this, the first
// version of this function wrote every currently-tracked car's position on
// every single 1-minute run regardless of whether it moved, which is what
// the client-side throttling (lastSeenCache) used to prevent. A single
// small state doc (same pattern as functions-webhooks' bot_state/
// train_spotting) holds the last-known station per car; only cars whose
// station actually changed since the last run get an actual roster write.
const LAST_SEEN_STATE_REF = () => db.collection('bot_state').doc('roster_last_seen');

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

  const stateRef = LAST_SEEN_STATE_REF();
  const stateSnap = await stateRef.get();
  const priorStops = stateSnap.exists ? (stateSnap.data().stops || {}) : {};

  const nextStops = {};
  const changed = [];
  current.forEach(({ key, stopName }) => {
    nextStops[key] = stopName;
    if(priorStops[key] !== stopName){
      changed.push({ key, stopName });
    }
  });

  const now = Date.now();
  if(changed.length) await commitInChunks(changed, now);
  await stateRef.set({ stops: nextStops, updatedAt: now });
});
