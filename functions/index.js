// Firebase Cloud Functions for "In the Loop" push notifications.
//
// What this does:
// Watches Firestore for new documents in `mod_alerts` and `mod_notifications`
// (the same collections the app already writes to when a moderator posts
// something), and the instant one appears, sends a real Web Push
// notification to every device that's subscribed — even if nobody has the
// website open in a browser tab.
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
    'mailto:noreply@thembtaloop.vercel.app',
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
