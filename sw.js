// Murph Test 2026 push service worker. Receives Web Push and shows a notification.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Murph Test", body: "Matt logged a Murph segment 💪" };
  if (event.data) {
    try { data = event.data.json(); }
    catch { data.body = event.data.text(); }
  }
  const url = data.url || "/";
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/murph-tracker/icon-192.png",
      badge: "/murph-tracker/icon-192.png",
      data: { url },
      tag: "murph-segment",
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
