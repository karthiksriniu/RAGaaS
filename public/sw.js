// Service worker for admin push notifications.
//
// Scope is the whole origin because it is served from the root, but it does
// exactly one job: show a notification when the payments queue has something
// waiting, and take a tap to /admin/billing. It deliberately does NOT cache
// anything - this is not an offline story, and a stale cached admin page would
// be worse than no service worker at all.

// Take over as soon as a new version is installed, rather than waiting for
// every tab to close. Push handlers change rarely, but when one does, waiting
// means the fix does not apply until the admin happens to close every tab.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const FALLBACK = {
  title: "MyBizCare",
  body: "A payment is waiting to be confirmed.",
  url: "/admin/billing",
};

self.addEventListener("push", (event) => {
  // A push with no data, or with data that is not the JSON we send, must still
  // produce a notification: Chrome will show its own generic "site updated in
  // the background" message if a push event ends without one, which looks
  // broken and tells the admin nothing.
  let payload = FALLBACK;
  if (event.data) {
    try {
      payload = { ...FALLBACK, ...event.data.json() };
    } catch {
      payload = { ...FALLBACK, body: event.data.text() || FALLBACK.body };
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/notification-icon.png",
      // Same tag for every payment alert, so a second one REPLACES the first
      // rather than stacking. The queue is the source of truth; five
      // notifications for five orders is noise, and the newest one carries the
      // count anyway.
      tag: "mybizcare-payment",
      renotify: true,
      // The admin should decide when this goes away, not a timeout - the whole
      // point is that a provisional licence expires if nobody acts.
      requireInteraction: true,
      data: { url: payload.url || FALLBACK.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || FALLBACK.url;

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus a tab already on the billing page rather than opening a second
      // one. Matching on pathname, not the full URL, so a tab sitting on the
      // page with a query string still counts.
      for (const client of all) {
        try {
          if (new URL(client.url).pathname === target && "focus" in client) {
            return client.focus();
          }
        } catch {
          // A client URL we cannot parse is not a match; keep looking.
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })()
  );
});
