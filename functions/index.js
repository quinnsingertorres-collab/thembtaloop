// Firebase Cloud Functions for "In the Loop" push notifications.
//
// What this does:
// Watches Firestore for new/changed documents in several collections the
// app already writes to — mod_alerts, mod_notifications, destination_overrides,
// branch_reassignments, car_out_of_service — and the instant one appears,
// sends a real Web Push notification to every subscribed device that's
// opted into that category, even if nobody has the website open in a
// browser tab. Moderator alerts/notifications go to everyone subscribed
// (no per-category opt-out); the community-reported categories are each
// gated by their own boolean field on the subscriber's push_subscriptions
// doc (see sendToFilteredSubscribers), synced from that person's own
// Settings toggles by index.html's syncPushPreferences().
//
// Also runs `syncLastSeenCars`, a scheduled function (every 1 minute) that
// polls MBTA's vehicle feeds for all 4 lines server-side and writes each
// car's last-tracked station to Firestore. This replaces what used to be a
// write every visitor's browser made independently (redundant duplicate
// writes any time more than one person had the site open) with a single
// centralized writer, regardless of how many people are viewing the site.
// The same run also maintains three more things from that same MBTA data,
// at no extra API cost:
//   - firstTrackedToday / trackingDay on each roster doc: when a car was
//     first seen active today, holding steady through brief tracker gaps
//     and only resetting once it's been missing longer than a grace
//     period (see FIRST_TRACKED_GRACE_MS below).
//   - pairing history logging which other car each one's been physically
//     coupled with over time (from the same "carriages" data already
//     fetched for last-seen tracking) — lives in a Google Sheet, not
//     Firestore, to keep this collection off the Firestore bill entirely.
//     See the GOOGLE_SHEETS_CREDENTIALS comment below for the one-time
//     setup this specifically needs, and commitPairChanges/getPairHistory
//     further down for how it's read and written.
//   - Green Line train-spotting push alerts (double Type 8s, the Pride car)
//     — the server-side equivalent of index.html's own checkTrainNotifications,
//     which only fires while a tab is open. See the bottom of syncLastSeenCars.
//   - "Car back after a long gap" push alerts: reuses the same
//     firstTrackedToday bookkeeping above to notice when a car reappears
//     after being absent longer than a subscriber's own chosen threshold
//     (Settings' longGapThresholdDays), flagging the notification as
//     possibly inaccurate if the roster still lists that car as Out of
//     Service, Retired, or Scrapped.
//
// Also polls MBTA's alerts feed once a minute (still inside syncLastSeenCars)
// for T-Alerts pushes, gated per line/branch by another set of boolean
// fields on push_subscriptions (see ALERT_ROUTE_PREF_FIELDS below).
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
// 4. Set up pairing history's Google Sheet + service account — see the
//    GOOGLE_SHEETS_CREDENTIALS comment below for the full 8-step walkthrough.
// 5. Deploy with: firebase deploy --only functions

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const webpush = require('web-push');
const { google } = require('googleapis');

admin.initializeApp();
const db = admin.firestore();

const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');

// Must match VAPID_PUBLIC_KEY in index.html exactly — this is the public
// half of the same key pair, safe to hardcode here since it's not a secret.
const VAPID_PUBLIC_KEY = 'BHEIq4o6pknFsV-fssjBnXccc-5tX1w8V9ojTS4ilQ2YEuNYJR2cW2BNlObuckum_6mbTireruMCe8kjUx3dYaA';

// ---- Pair history now lives in a Google Sheet instead of Firestore ----
// See the big comment above commitPairChanges below for the full design —
// short version: this whole sheet is an append-only event log (one row per
// pairing CHANGE, not per car), which trades a Firestore doc-per-car
// read+write on every change for a single cheap Sheets API append, and
// moves reads (only ever needed for the one car a user actually opens) off
// Firestore entirely too, onto a Cloud Function that reads the sheet
// directly.
//
// ---- One-time setup for this specific feature ----
// 1. Create a Google Sheet. Add a tab named exactly "PairHistory" with a
//    header row: CarKey | Partner | From
// 2. In Google Cloud Console (same project as this Firebase project, or
//    any project — it just needs the Sheets API enabled): APIs & Services
//    -> Library -> enable "Google Sheets API".
// 3. IAM & Admin -> Service Accounts -> Create service account (any name,
//    e.g. "pair-history-writer"). No project roles needed — access is
//    granted by sharing the sheet with it directly, not via IAM.
// 4. Open that service account -> Keys -> Add key -> JSON. This downloads
//    a JSON key file — its contents (the whole file, as one string) are
//    what GOOGLE_SHEETS_CREDENTIALS holds below.
// 5. Back in the Google Sheet: Share -> add the service account's email
//    (looks like ...@...iam.gserviceaccount.com, found in the JSON key
//    file's "client_email" field) as an Editor.
// 6. Copy the sheet's ID out of its URL:
//    https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit
//    and paste it into PAIR_HISTORY_SHEET_ID below.
// 7. Store the JSON key file's contents as a secret (paste the ENTIRE file
//    contents, including the { } braces, when prompted):
//      firebase functions:secrets:set GOOGLE_SHEETS_CREDENTIALS
// 8. cd functions && npm install (picks up the googleapis dependency added
//    to package.json), then firebase deploy --only functions from the
//    project root.
const GOOGLE_SHEETS_CREDENTIALS = defineSecret('GOOGLE_SHEETS_CREDENTIALS');
// Replace with your own Sheet ID (step 6 above) before deploying.
const PAIR_HISTORY_SHEET_ID = '1E0G2gaQQY1RAhpN0dR0BZfADU9giO40GyCaPs27zO68';
const PAIR_HISTORY_SHEET_TAB = 'PairHistory';

let _sheetsClientPromise = null;
function getSheetsClient(){
  if(!_sheetsClientPromise){
    _sheetsClientPromise = (async () => {
      const credentials = JSON.parse(GOOGLE_SHEETS_CREDENTIALS.value());
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      const authClient = await auth.getClient();
      return google.sheets({ version: 'v4', auth: authClient });
    })().catch((e) => {
      // Without this, a single failure on the FIRST call (bad/stale
      // credentials, sheet not shared yet, a transient auth hiccup) would
      // memoize the REJECTED promise forever — every later call on this
      // same warm instance would immediately re-reject with that same
      // stale error, permanently and silently breaking writes/reads until
      // the instance happened to recycle, with nothing in the logs to
      // suggest it was ever retried. Clearing the cache here means the
      // next call gets a genuine fresh attempt instead.
      _sheetsClientPromise = null;
      throw e;
    });
  }
  return _sheetsClientPromise;
}

// CORS is wide open (matches pair_history's old Firestore rule, which was
// allow read: if true) — this is public, non-sensitive data (which cars
// have been coupled together and when), same as before.
function applyCors(res){
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

// Sends one push payload to every doc in a given push_subscriptions
// snapshot, cleaning up any subscription the push service reports as dead
// (expired, unsubscribed, or the device revoked permission) so
// push_subscriptions doesn't accumulate stale entries forever. Shared by
// both sendToAllSubscribers (moderator alerts — no filtering) and
// sendToFilteredSubscribers (the community-reported categories, gated by a
// per-subscriber preference field) below.
async function deliverToSubscriptionSnapshot(snap, payload){
  if(snap.empty) return;
  webpush.setVapidDetails(
    'mailto:noreply@thembtaloop.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY.value()
  );

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

// Moderator alerts/notifications go to every subscribed device unconditionally
// — there's no per-category opt-out for those, matching how they've always
// worked (a moderator posting something is assumed important enough for
// everyone who's opted into push at all).
async function sendToAllSubscribers(payload){
  const snap = await db.collection('push_subscriptions').get();
  await deliverToSubscriptionSnapshot(snap, payload);
}

// The community-reported categories (destination changes, line/branch
// reassignments, cars marked out of service, double Type 8s, the Pride car)
// are opt-in per subscriber — prefField is one of the boolean fields
// index.html's syncPushPreferences() keeps in sync with that person's
// Settings toggles (notifyDestinationChange, notifyLineChange,
// notifyOutOfService, notifyDoubleType8, notifyPride). A single-field
// equality filter like this doesn't need a composite Firestore index.
async function sendToFilteredSubscribers(prefField, payload){
  const snap = await db.collection('push_subscriptions').where(prefField, '==', true).get();
  await deliverToSubscriptionSnapshot(snap, payload);
}

// Same opt-in-boolean pattern as sendToFilteredSubscribers, plus a
// per-subscriber NUMERIC threshold (Firestore can't combine an equality
// filter on one field with a range comparison against a per-document value
// on another in one query) — so this fetches everyone opted into prefField
// with one plain equality query, then filters in memory by comparing each
// subscriber's own saved threshold against this specific event's actual
// value. Used by the "car back after a long gap" alert below, where
// thresholdField holds how many days of absence that person wants to hear
// about (index.html's longGapThresholdDays Settings selector).
async function sendToFilteredSubscribersWithThreshold(prefField, thresholdField, actualValue, payload){
  const snap = await db.collection('push_subscriptions').where(prefField, '==', true).get();
  if(snap.empty) return;
  const qualifying = snap.docs.filter(doc => {
    const threshold = doc.data()[thresholdField];
    return typeof threshold === 'number' && actualValue >= threshold;
  });
  if(qualifying.length === 0) return;
  await deliverToSubscriptionSnapshot({ empty: false, docs: qualifying }, payload);
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

// Fires on both a fresh destination-change report and a later correction to
// an existing one (onDocumentWritten covers create + update), but not on
// deletion (event.data.after.exists is false) — that just means the
// override auto-cleared because MBTA's own headsign caught up, which isn't
// push-worthy.
exports.sendPushOnDestinationOverride = onDocumentWritten(
  { document: 'destination_overrides/{vehicleId}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    if(!event.data.after.exists) return;
    const data = event.data.after.data();
    if(!data || !data.destination) return;
    const car = data.carLabel ? `Car ${data.carLabel}` : 'A train';
    const was = data.originalHeadsign ? ` (was ${data.originalHeadsign})` : '';
    await sendToFilteredSubscribers('notifyDestinationChange', {
      title: 'Destination change reported',
      body: `${car} now signed for ${data.destination}${was}`,
      url: './'
    });
  }
);

// Same create-or-update reasoning as the destination override trigger above
// — a correction to an existing reassignment is still worth pushing about.
exports.sendPushOnLineChange = onDocumentWritten(
  { document: 'branch_reassignments/{vehicleId}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    if(!event.data.after.exists) return;
    const data = event.data.after.data();
    if(!data || !data.correctBranch) return;
    const branchLabel = data.line === 'green'
      ? data.correctBranch
      : (data.correctBranch === 'ashmont' ? 'Ashmont' : 'Braintree');
    const car = data.carLabel ? `Car ${data.carLabel}` : 'A train';
    await sendToFilteredSubscribers('notifyLineChange', {
      title: 'Train reassigned to a different branch',
      body: `${car} corrected to the ${branchLabel} branch`,
      url: './'
    });
  }
);

// car_out_of_service docs are keyed by car number and deleted the moment a
// car is cleared back to service (see index.html's clearCarOutOfService) —
// so onDocumentCreated alone already captures every real "just got marked
// OOS" moment; no update case to worry about the way the two triggers above
// need it (this doc's own document ID is stable, but it doesn't get
// re-written while already OOS the way an override can be corrected).
exports.sendPushOnCarOutOfService = onDocumentCreated(
  { document: 'car_out_of_service/{carNum}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const data = event.data.data();
    if(!data || !data.outOfService) return;
    const carNum = event.params.carNum;
    const reason = data.reason ? `: ${data.reason.slice(0, 100)}` : '';
    await sendToFilteredSubscribers('notifyOutOfService', {
      title: 'Car marked out of service',
      body: `Car ${carNum} marked out of service${reason}`,
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

// ---- T-Alerts push notifications ----
// Maps each MBTA route id this app cares about to the boolean field on a
// subscriber's push_subscriptions doc that opts them into pushes for THAT
// specific line/branch — same "one prefField per category" convention as
// notifyDestinationChange etc. above, just one field per route instead of
// one per event type. Green Line is split by branch (B/C/D/E) plus Mattapan,
// matching MBTA's own route ids and the granularity index.html's own T-Alerts
// modal already fetches by (see getAlertRouteIds) — Red/Orange/Blue don't
// have separate branch-level route ids in MBTA's alerts feed, so those three
// are each a single toggle.
const ALERT_ROUTE_PREF_FIELDS = {
  'Green-B': 'notifyAlertsGreenB',
  'Green-C': 'notifyAlertsGreenC',
  'Green-D': 'notifyAlertsGreenD',
  'Green-E': 'notifyAlertsGreenE',
  'Mattapan': 'notifyAlertsMattapan',
  'Red': 'notifyAlertsRed',
  'Orange': 'notifyAlertsOrange',
  'Blue': 'notifyAlertsBlue'
};
const ALERT_ROUTE_IDS = Object.keys(ALERT_ROUTE_PREF_FIELDS);
// Human-readable labels for the same 8 routes, for push notification copy —
// must match index.html's own ALERT_ROUTE_LABELS (used for its composer's
// line/branch picker and for labeling posted diversions in the list).
const ALERT_ROUTE_LABELS = {
  'Green-B': 'Green Line B', 'Green-C': 'Green Line C', 'Green-D': 'Green Line D', 'Green-E': 'Green Line E',
  'Mattapan': 'Mattapan Line', 'Red': 'Red Line', 'Orange': 'Orange Line', 'Blue': 'Blue Line'
};

// Same activity/datetime filtering as index.html's own fetchAlerts (only
// currently-active alerts relevant to boarding/riding, not every historical
// alert MBTA has on file) but across all 8 routes in one call instead of
// per-line, and pulling informed_entity instead of header/description text
// (all this needs is which routes each alert touches, to know who to push).
async function fetchServiceAlertsForPush(){
  const url = 'https://api-v3.mbta.com/alerts?filter[route]=' + ALERT_ROUTE_IDS.join(',') +
    '&filter[activity]=BOARD,EXIT,RIDE&filter[datetime]=NOW&fields[alert]=header,effect,severity,informed_entity' +
    '&api_key=' + MBTA_API_KEY;
  const res = await fetch(url, { headers: MBTA_HEADERS });
  if(!res.ok) throw new Error('MBTA alerts API returned ' + res.status);
  const json = await res.json();
  return (json.data || []).map(a => {
    const routes = new Set();
    (a.attributes.informed_entity || []).forEach(ie => { if(ie.route) routes.add(ie.route); });
    return {
      id: a.id,
      header: a.attributes.header || '',
      effect: a.attributes.effect || '',
      severity: a.attributes.severity || 0,
      routes: Array.from(routes).filter(r => ALERT_ROUTE_PREF_FIELDS[r])
    };
  }).filter(a => a.routes.length > 0);
}

const SERVICE_ALERTS_STATE_REF = () => db.collection('bot_state').doc('service_alerts');

// A moderator/trusted member posting a diversion or closure (see
// index.html's showAlertsModal composer) pushes to the SAME per-branch
// subscriber set as an official MBTA T-Alert for that route — reusing
// ALERT_ROUTE_PREF_FIELDS rather than the unconditional sendToAllSubscribers
// every mod_alerts post uses, since this is meant to be a targeted,
// line-specific report, not a site-wide announcement.
exports.sendPushOnCommunityAlert = onDocumentCreated(
  { document: 'community_alerts/{alertId}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const data = event.data.data();
    if(!data || !data.text || !data.route) return;
    const prefField = ALERT_ROUTE_PREF_FIELDS[data.route];
    if(!prefField) return;
    await sendToFilteredSubscribers(prefField, {
      title: `${ALERT_ROUTE_LABELS[data.route] || data.route} diversion/closure`,
      body: data.text.slice(0, 180),
      url: './'
    });
  }
);

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

// Returns both the flattened per-car entries (carEntries — one row per
// physical car, used for last-seen/pair tracking) and a per-vehicle list
// (vehicles — one row per actual train/consist, with its raw car numbers
// still grouped together) from the same single MBTA fetch. The per-vehicle
// shape is only used by the Green Line train-spotting alerts below (double
// Type 8s, the Pride car both need to know which cars belong to the SAME
// train, which the flattened carEntries rows don't preserve on their own
// beyond the adjacent-pair `partner` field) — returning it from here avoids
// a second API call just for that.
async function fetchLineVehicles(line, url){
  const fullUrl = url + (url.includes('?') ? '&' : '?') + 'api_key=' + MBTA_API_KEY;
  const res = await fetch(fullUrl, { headers: MBTA_HEADERS });
  if(!res.ok) throw new Error(`MBTA API returned ${res.status} for ${line}`);
  const json = await res.json();

  const included = {};
  (json.included || []).forEach(item => { included[item.type + ':' + item.id] = item.attributes; });

  const carEntries = [];
  const vehicles = [];
  (json.data || []).forEach(v => {
    const stopRel = v.relationships && v.relationships.stop && v.relationships.stop.data;
    const stopName = stopRel ? (included['stop:' + stopRel.id] || {}).name : null;
    if(!stopName) return;
    const carNums = getCarNumbersForVehicle(line, v.attributes.label, v.attributes.carriages);
    const keys = carNums.map(n => rosterStorageKey(line, n));
    // Green Line married pairs are fixed 2-car units — a 4-car train (two
    // pairs coupled together) isn't one big "partner group," it's two
    // separate pairs, so partners are matched up by adjacent position in
    // the consist (0-1, 2-3, ...) rather than treating everyone in the
    // train as everyone else's partner. A car with no adjacent partner
    // (running alone, or an odd one out) has partners: [] ("unpaired").
    //
    // Red/Orange/Blue don't run as separate married-pair sub-units the
    // same way — their whole consist is one assembled "set" of cars, so
    // for those lines partners is every OTHER car in the same vehicle,
    // not just an adjacent one. This is what index.html's "Set history"
    // (non-Green) vs. "Pairing history" (Green) distinction is built on.
    keys.forEach((key, i) => {
      let partners;
      if(line === 'green'){
        const pairStart = i - (i % 2);
        const partnerIdx = (i % 2 === 0) ? pairStart + 1 : pairStart;
        partners = keys[partnerIdx] ? [keys[partnerIdx]] : [];
      }else{
        partners = keys.filter((k, idx) => idx !== i);
      }
      // carNum/line included alongside the roster storage key so callers
      // that need a human-readable car number (push notification copy) or
      // the owning line (e.g. to look up its roster doc) don't have to
      // reverse-parse `key`, which is only unprefixed for Green.
      carEntries.push({ key, stopName, partners, carNum: carNums[i], line });
    });
    vehicles.push({ id: v.id, label: v.attributes.label, carNums });
  });
  return { carEntries, vehicles };
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

// Bounds how far back pair-history is shown (Eamon's "last 2 weeks or so,"
// with headroom) and how many stretches getPairHistory returns for one
// car. The sheet itself isn't trimmed by either of these — it's an
// append-only log now, so old rows just sit there unread past this
// window rather than ever being deleted. (10M-cell Sheets limit means this
// isn't a practical concern for a long while; if it ever needs active
// pruning, that'd be a separate periodic cleanup function.)
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
// Also holds the Green Line train-spotting alert state (an `alerts` field
// alongside `cars`) — see the shared read/write at the end of
// syncLastSeenCars, which piggybacks that onto this same doc rather than
// paying for a whole separate one.
const PAIR_STATE_REF = () => db.collection('bot_state').doc('pair_tracking');

// Same numeric range as index.html's getCarType() uses for 'Type 8' — kept
// minimal here (just the one range this needs) rather than porting the
// whole car-type lookup table server-side. If Type 8 numbering ever
// changes, update both places.
function isType8CarNumber(num){
  const n = parseInt(String(num).replace(/[^0-9]/g, ''), 10);
  return !isNaN(n) && n >= 3800 && n <= 3899;
}
const PRIDE_CAR_NUMBER = '3706';

// Used to replace what used to be a Firestore read+write PER CAR on every
// pairing change (a get() to find the previous entry so its "to" could be
// filled in, then a set() with the whole updated array) with a single
// Sheets API append covering every changed car in this run at once.
//
// The Firestore version stored one doc per car holding an array of
// {partner, from, to} stretches, with "to" explicitly filled in on the
// PREVIOUS entry the moment a new one started. Reproducing that exact
// shape here would mean looking up which row a car's last entry lives on
// and editing it in place — Sheets doesn't have anything as cheap as
// Firestore's per-field update for that, and doing it would mean a read
// per car again, defeating the point.
//
// Instead this just appends one new row per change: [key, partner, from].
// No "to" column at all — a car's history reconstructs itself once rows
// are sorted by time: entry N's "to" is simply entry N+1's "from", and the
// last row for that car is the one still "ongoing" (see getPairHistory
// below, which does exactly that). One API call, no per-car lookups,
// genuinely append-only.
// Green Line only ever has at most one partner, but Red/Orange/Blue's
// "whole consist is one set" model can have several — column B stores
// however many apply as a single comma-joined cell (sorted so the same
// set of cars always serializes to the same string regardless of the
// order the API happened to return them in, which matters for the
// change-detection comparison in syncLastSeenCars below).
function serializePartners(partners){
  return (partners || []).slice().sort().join(',');
}
function parsePartnersCell(cell){
  return String(cell || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function commitPairChanges(changes, ts){
  if(!changes.length) return;
  const fromIso = new Date(ts).toISOString();
  const append = async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: PAIR_HISTORY_SHEET_ID,
      range: `${PAIR_HISTORY_SHEET_TAB}!A:C`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: changes.map(({ key, partners }) => [key, serializePartners(partners), fromIso])
      }
    });
  };
  try{
    await append();
  }catch(e){
    // One retry, since getSheetsClient no longer memoizes a broken client
    // forever (see its own comment) — a transient auth hiccup on the first
    // attempt now gets a genuinely fresh client on the second, instead of
    // silently dropping this run's pairing changes. Logs the actual
    // status/message (not just the error object's default toString, which
    // for a googleapis error often just says "Error") so a REAL persistent
    // problem — sheet not shared with the service account, wrong tab name,
    // stale/malformed GOOGLE_SHEETS_CREDENTIALS — is diagnosable from the
    // Cloud Functions logs instead of vanishing into "Failed to append."
    console.error('Pair history append failed on first attempt, retrying once:',
      e.code || e.status || '', e.message || e);
    try{
      await append();
    }catch(e2){
      console.error('Pair history append failed on retry too — giving up for this run:',
        e2.code || e2.status || '', e2.message || e2, e2.errors || '');
    }
  }
}

// Both the sheet's row count AND its actual values are cached briefly,
// in-memory, on the Cloud Functions instance — shared across every car
// this endpoint is asked about, not per-key. Previously every single
// request re-read the ENTIRE sheet from scratch, unconditionally; since
// it's an append-only log that's never trimmed, that read only ever got
// slower as more history piled up, which is almost certainly why opening
// a car's info (Pairing/Set history section) could take a very long
// time — made worse recently by the full-"set" tracking on Red/Orange/Blue
// appending several rows per change instead of Green's one. TTL matches
// the 30s Cache-Control already on this endpoint's HTTP response, so this
// doesn't add any staleness beyond what clients already tolerated.
const PAIR_HISTORY_CACHE_TTL_MS = 45 * 1000;
// Hard cap on how many of the sheet's most recent rows are ever read in
// one call — without this, the read cost still grows forever even with
// caching, just more slowly. 8000 rows comfortably covers
// PAIR_HISTORY_MAX_AGE_MS (3 weeks) at any realistic append rate here.
const PAIR_HISTORY_ROW_CAP = 8000;
let _pairHistoryRowsCache = { rows: null, ts: 0 };

async function getPairHistoryRows(){
  const now = Date.now();
  if(_pairHistoryRowsCache.rows && (now - _pairHistoryRowsCache.ts) < PAIR_HISTORY_CACHE_TTL_MS){
    return _pairHistoryRowsCache.rows;
  }
  const sheets = await getSheetsClient();
  // Starting at row 2 (skipping the header row) by default, so every path
  // below returns pure data rows with no special-casing needed elsewhere.
  let range = `${PAIR_HISTORY_SHEET_TAB}!A2:C`;
  try{
    // Metadata-only lookup (no cell data transferred, so it's cheap
    // regardless of sheet size) — used just to bound the real read below
    // to the most recent PAIR_HISTORY_ROW_CAP rows instead of the whole
    // sheet. Falls back to the unbounded range above if this fails for any
    // reason (a brand new sheet, an unexpected API shape, quota hiccup) —
    // worse latency that day, not a broken feature.
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: PAIR_HISTORY_SHEET_ID,
      ranges: [PAIR_HISTORY_SHEET_TAB],
      fields: 'sheets.properties.gridProperties.rowCount'
    });
    const rowCount = meta.data.sheets && meta.data.sheets[0] &&
      meta.data.sheets[0].properties.gridProperties.rowCount;
    if(rowCount && rowCount > PAIR_HISTORY_ROW_CAP){
      const startRow = Math.max(2, rowCount - PAIR_HISTORY_ROW_CAP);
      range = `${PAIR_HISTORY_SHEET_TAB}!A${startRow}:C${rowCount}`;
    }
  }catch(e){
    console.error('Pair history row-count lookup failed, falling back to a full read:', e);
  }
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: PAIR_HISTORY_SHEET_ID, range });
  const rows = result.data.values || [];
  _pairHistoryRowsCache = { rows, ts: now };
  return rows;
}

// HTTPS endpoint index.html's loadPairHistory() calls instead of reading
// Firestore directly (see PAIR_HISTORY_ENDPOINT there). Filters the cached/
// bounded rows above to the requested car, and reconstructs the same
// {partners, from, to} shape the client already expects — from/to chaining
// explained in the big comment on commitPairChanges above.
exports.getPairHistory = onRequest({ secrets: [GOOGLE_SHEETS_CREDENTIALS] }, async (req, res) => {
  applyCors(res);
  if(req.method === 'OPTIONS'){ res.status(204).send(''); return; }

  const key = String(req.query.key || '').trim();
  if(!key){ res.status(400).json({ error: 'Missing ?key=' }); return; }

  try{
    const rows = await getPairHistoryRows();

    // Filter to this car, sort oldest-first (append order should already
    // be chronological, but sorting is cheap insurance against any
    // out-of-order writes).
    const carRows = rows
      .filter(r => r[0] === key)
      .map(r => ({ partners: parsePartnersCell(r[1]), from: new Date(r[2]).getTime() }))
      .filter(r => !isNaN(r.from))
      .sort((a, b) => a.from - b.from);

    // Chain each row's "to" from the NEXT row's "from" — the last row for
    // this car has no next row, so it stays ongoing (to: null), same
    // meaning "to: null" always had in the old Firestore entries.
    const now = Date.now();
    const entries = carRows.map((entry, i) => ({
      partners: entry.partners,
      from: entry.from,
      to: (i < carRows.length - 1) ? carRows[i + 1].from : null
    }));

    // Same bounding the old Firestore version applied when writing: drop
    // anything older than the retention window, but always keep at least
    // the most recent entry (even if it's old) so "what's true right now"
    // never disappears just because nothing's changed in 3 weeks. Cap the
    // total count too, keeping the newest.
    const cutoff = now - PAIR_HISTORY_MAX_AGE_MS;
    const recent = entries.filter((e, i) => i === entries.length - 1 || (e.to || now) >= cutoff);
    const trimmed = recent.slice(-PAIR_HISTORY_MAX_ENTRIES);

    res.set('Cache-Control', 'public, max-age=30');
    res.status(200).json({ entries: trimmed });
  }catch(e){
    console.error(`Failed to read pair history for ${key}:`, e);
    res.status(500).json({ error: 'Failed to read pair history' });
  }
});

// secrets: [VAPID_PRIVATE_KEY] is needed here now too — the train-spotting
// alerts block at the end of this function calls sendToFilteredSubscribers,
// which needs that secret's value to send a push, same as the Firestore
// triggers above. GOOGLE_SHEETS_CREDENTIALS is needed for commitPairChanges
// above, which now authenticates to the Sheets API instead of writing to
// Firestore.
exports.syncLastSeenCars = onSchedule({ schedule: 'every 1 minutes', secrets: [VAPID_PRIVATE_KEY, GOOGLE_SHEETS_CREDENTIALS] }, async () => {
  const settled = await Promise.allSettled(
    LAST_SEEN_LINE_FEEDS.map(({ line, url }) => fetchLineVehicles(line, url))
  );

  const current = [];
  let greenVehicles = [];
  settled.forEach((result, i) => {
    if(result.status === 'fulfilled'){
      current.push(...result.value.carEntries);
      if(LAST_SEEN_LINE_FEEDS[i].line === 'green') greenVehicles = result.value.vehicles;
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
  // "Car back after a long gap" push candidates, gathered below and acted
  // on after this loop (once nextStops/nextActive/rosterPatches are all
  // settled) — see that block for why lastActiveAt (already tracked here
  // for the first-tracked-today feature) is the right signal to reuse
  // rather than a separate read.
  const longGapCandidates = [];
  // Floor below which a gap isn't even worth querying subscribers about —
  // chiefly to skip the routine multi-hour overnight shutdown every car
  // has every single day, which would otherwise "reappear" as a candidate
  // every single morning for every single car. The lowest selectable
  // threshold in Settings (longGapThresholdDays) is 3 days, so 1 day of
  // slack here costs nothing real while cutting out nearly all the noise.
  const MIN_GAP_DAYS_TO_CONSIDER = 1;

  current.forEach(({ key, stopName, carNum, line }) => {
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
      // prior.lastActiveAt (when it exists) is exactly how long ago this
      // car was last confirmed active, however long that gap turns out to
      // be — a brief AVL blip, an overnight shutdown, or a genuine
      // multi-week absence. No prior at all means this is the very first
      // time this car's ever been tracked, which isn't a "return."
      if(prior && prior.lastActiveAt){
        const gapDays = (now - prior.lastActiveAt) / (24 * 60 * 60 * 1000);
        if(gapDays >= MIN_GAP_DAYS_TO_CONSIDER){
          longGapCandidates.push({ key, carNum, line, gapDays });
        }
      }
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

  // ---- "Car back after a long gap" push notifications ----
  // Own try/catch, same reasoning as the T-Alerts block further down: a
  // failure here shouldn't undo the tracking work that's already committed
  // above. Only reads roster docs for the (typically 0-2 per run) actual
  // candidates gathered above, not every car — the status field is only
  // needed here, for the "may be inaccurate" caveat below, so there's no
  // reason to pay for it on every run either.
  if(longGapCandidates.length){
    try{
      const rosterSnaps = await Promise.all(
        longGapCandidates.map(c => db.collection('roster').doc(c.key).get())
      );
      const INACCURATE_IF_STATUS = ['Out of Service', 'Retired', 'Scrapped'];
      const longGapPushes = longGapCandidates.map((c, i) => {
        const data = rosterSnaps[i].exists ? rosterSnaps[i].data() : {};
        const caveat = INACCURATE_IF_STATUS.includes(data.status)
          ? ` — roster still lists it as ${data.status}, so this may be inaccurate`
          : '';
        const days = Math.round(c.gapDays);
        const gapText = `${days} day${days === 1 ? '' : 's'}`;
        return sendToFilteredSubscribersWithThreshold('notifyLongGapReturn', 'longGapThresholdDays', c.gapDays, {
          title: 'Car back in service',
          body: `Car ${c.carNum} is tracking again after ${gapText} untracked${caveat}`,
          url: './'
        });
      });
      await Promise.all(longGapPushes);
    }catch(e){
      console.error('Long-gap car return push check failed:', e);
    }
  }

  // ---- pair tracking + Green Line train-spotting push alerts, sharing one
  // state doc read/write ----
  // These are two different concerns (which car is paired with which; which
  // vehicles are currently double-Type-8s or the Pride car) but both only
  // need one get()+set() per run to remember their state between
  // invocations, so they share PAIR_STATE_REF's doc (an `alerts` field
  // alongside the existing `cars` field) instead of each having their own —
  // a second full state doc here would just be another +1,440 reads and
  // +1,440 writes/day for something that fits in the read/write this
  // function is already doing anyway.
  const pairStateRef = PAIR_STATE_REF();
  const pairStateSnap = await pairStateRef.get();
  const priorState = pairStateSnap.exists ? pairStateSnap.data() : {};
  const priorPairs = priorState.cars || {};
  const priorAlerts = priorState.alerts || {};

  const nextPairs = {};
  const pairChanges = [];
  current.forEach(({ key, partners }) => {
    const serialized = serializePartners(partners);
    nextPairs[key] = serialized;
    if((priorPairs[key] || '') !== serialized){
      pairChanges.push({ key, partners: partners || [] });
    }
  });
  // Carry forward any car that isn't in this particular run's data (a train
  // between trips, a brief AVL gap, or just not currently in service) rather
  // than dropping it from state entirely. Without this, the write below
  // would silently wipe its last-known pairing every time it's temporarily
  // untracked — so the next time it reappears, even paired with the exact
  // same partner as before, priorPairs[key] would read as undefined and
  // this run's comparison above would wrongly treat that as a brand-new
  // pairing, writing a spurious pair_history entry for a partner that never
  // actually changed. This mirrors the same "don't lose state just because
  // a car missed one poll" reasoning as the first-tracked-today carry-forward
  // above — just without a grace-period cutoff, since there's no harm in
  // remembering a car's last pairing indefinitely (it only prevents noise;
  // it never touches the actual pair_history docs by itself).
  Object.keys(priorPairs).forEach(key=>{
    if(!Object.prototype.hasOwnProperty.call(nextPairs, key)) nextPairs[key] = priorPairs[key];
  });
  if(pairChanges.length) await commitPairChanges(pairChanges, now);

  // ---- Green Line train-spotting push alerts (double Type 8s, Pride car) ----
  // Server-side equivalent of index.html's checkTrainNotifications, which
  // only fires while someone has a tab open — this is what makes the same
  // two conditions trigger a real push even when nobody does. Green Line
  // only: Type 8s and the Pride car (3706) don't run on any other line.
  // Tracks which vehicle ids were already alerted-on between runs so a
  // train doesn't get pushed about again every single minute it's still
  // running the same consist — only when it newly starts (or resumes)
  // matching.
  const priorDoubleType8 = new Set(priorAlerts.doubleType8 || []);
  const priorPride = new Set(priorAlerts.pride || []);
  const nextDoubleType8 = [];
  const nextPride = [];
  const pushes = [];

  greenVehicles.forEach(v => {
    const cars = v.carNums || [];
    if(cars.length >= 2 && isType8CarNumber(cars[0]) && isType8CarNumber(cars[1])){
      nextDoubleType8.push(v.id);
      if(!priorDoubleType8.has(v.id)){
        pushes.push(sendToFilteredSubscribers('notifyDoubleType8', {
          title: 'Double Type 8s spotted',
          body: `Cars ${v.label} are both Type 8s`,
          url: './'
        }));
      }
    }
    if(cars.includes(PRIDE_CAR_NUMBER)){
      nextPride.push(v.id);
      if(!priorPride.has(v.id)){
        pushes.push(sendToFilteredSubscribers('notifyPride', {
          title: 'Pride train spotted',
          body: `Car ${v.label} is running today`,
          url: './'
        }));
      }
    }
  });
  if(pushes.length) await Promise.all(pushes);

  // ---- T-Alerts push notifications (per line/branch) ----
  // A separate MBTA endpoint (alerts, not vehicles) and its own small state
  // doc — wrapped in its own try/catch so a failure fetching or pushing
  // alerts never undoes the vehicle-tracking/pair-history work above, which
  // has already committed by this point regardless.
  try{
    const serviceAlerts = await fetchServiceAlertsForPush();
    const alertsStateRef = SERVICE_ALERTS_STATE_REF();
    const alertsStateSnap = await alertsStateRef.get();
    // A map of id -> firstPushedAt, NOT just an array of currently-active
    // ids — a long-running or recurring alert (e.g. one whose active_period
    // is only weekdays, or has scheduled gaps) drops out of MBTA's
    // filter[datetime]=NOW results during those gaps, and previously this
    // whole list got REPLACED each run with only what was active THIS run —
    // so the moment a long-term alert's id disappeared from one run's
    // results, it looked brand new again the next time it reappeared and
    // got pushed a second (or third...) time. Accumulating instead of
    // replacing means once an id's been pushed, it stays suppressed
    // through any number of later on/off gaps, not just while it happens
    // to stay continuously active.
    const priorSeen = alertsStateSnap.exists ? (alertsStateSnap.data().seen || {}) : {};
    const nextSeen = Object.assign({}, priorSeen);
    const alertPushes = [];

    serviceAlerts.forEach(alert => {
      if(Object.prototype.hasOwnProperty.call(priorSeen, alert.id)) return; // already pushed about this one, ever
      nextSeen[alert.id] = now;
      // One push per distinct branch this alert touches, not per route id
      // blindly repeated — an alert naming both Green-B and Green-C, for
      // example, still only sends one push to a Green-B-only subscriber and
      // one to a Green-C-only subscriber, not two of each.
      const prefFields = new Set(alert.routes.map(r => ALERT_ROUTE_PREF_FIELDS[r]).filter(Boolean));
      prefFields.forEach(prefField => {
        alertPushes.push(sendToFilteredSubscribers(prefField, {
          title: 'T-Alert',
          body: alert.header.slice(0, 180),
          url: './'
        }));
      });
    });

    if(alertPushes.length) await Promise.all(alertPushes);

    // Bound growth — an id genuinely worth suppressing forever would mean
    // this map growing without limit over years. 90 days comfortably
    // outlasts any real MBTA alert's lifespan (even long-term construction
    // notices get reissued with a new id well before then); if the exact
    // same id somehow resurfaces after 90+ days of total silence, treating
    // that as "new" again is a reasonable trade, not a real duplicate.
    const PRUNE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
    Object.keys(nextSeen).forEach(id => {
      if((now - nextSeen[id]) > PRUNE_AFTER_MS) delete nextSeen[id];
    });

    await alertsStateRef.set({ seen: nextSeen, updatedAt: now });
  }catch(e){
    console.error('T-Alerts push check failed:', e);
  }

  await pairStateRef.set({
    cars: nextPairs,
    alerts: { doubleType8: nextDoubleType8, pride: nextPride },
    updatedAt: now
  });
});
