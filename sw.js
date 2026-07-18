// Service worker for "In the Loop".
//
// What this does:
// - Satisfies the installability requirement so the app can be added to a
//   phone's home screen (Android "Install app" prompt / iOS "Add to Home
//   Screen") as a standalone PWA.
// - Lets the page call `registration.showNotification()` to display OS-level
//   notifications while the app is open or recently backgrounded.
// - Handles real Web Push events (see the `push` listener below) so
//   notifications can arrive even when the app/browser is fully closed.
//   The actual sending happens server-side via a Firebase Cloud Function
//   (see /functions in the project repo), triggered the moment a moderator
//   posts an alert or notification in Firestore.

const CACHE_NAME = 'itl-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fetch listener intentionally does nothing — NOT calling event.respondWith()
// means the browser handles every request completely natively, exactly as if
// this listener didn't exist. An earlier version of this file called
// event.respondWith(fetch(event.request)) for every request, which re-routed
// cross-origin API calls (MBTA vehicles/alerts/schedules, Open-Meteo weather)
// through the service worker. Combined with skipWaiting()+clients.claim()
// below, a freshly-deployed update would take control of an already-open tab
// immediately — which could break or stall those live API calls right at the
// moment an update was pushed, falling back to demo mode. Just having this
// listener registered (even empty) is enough for installability checks.
self.addEventListener('fetch', (event) => {
  // no-op on purpose
});

// If a real push payload ever does arrive (once/if server-side push is added
// later), show it.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch (e) { payload = { title: 'In the Loop', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'In the Loop', {
      body: payload.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: payload.url || './' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
