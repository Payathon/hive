// hive service worker: only shows Web Push notifications and opens the order a tap points at.
// Nothing is cached; the app always loads from the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const m = e.data ? e.data.json() : { title: "hive", body: "", url: "/" };
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, tag: m.tag, data: { url: m.url } }));
});

// Reuse an open hive tab when there is one; otherwise open a new window.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? "/", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        try {
          await w.focus();
          await w.navigate(url);
          return;
        } catch {
          // Not ours to steer; fall through to a new window.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
