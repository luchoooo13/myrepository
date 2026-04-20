// Service worker de SchoolAlerts.
// Se encarga de recibir los push notifications enviados por el server
// (vía web-push / VAPID) y mostrar una notificación del sistema,
// incluso con la pantalla bloqueada o la app cerrada.
//
// iOS 16.4+ requiere que:
//  - La PWA esté instalada en la pantalla de inicio (no desde Safari).
//  - Cada evento `push` muestre una notificación (no se permiten pushes
//    "silenciosos"); si no, iOS revoca el permiso.
//
// El service worker NO comparte estado con la página. Se ejecuta en
// background aunque la pestaña esté cerrada.

self.addEventListener("install", () => {
  // Tomamos control apenas se instala, sin esperar al próximo reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "SchoolAlerts", body: "Nueva alerta" };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: "SchoolAlerts", body: event.data.text() };
    }
  }
  const title = data.title || "SchoolAlerts";
  const options = {
    body: data.body || "Nueva alerta",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // tag + renotify: si llegan varios pushes seguidos los agrupa pero
    // hace sonar / vibrar cada uno.
    tag: data.startedAt ? "alert-" + data.startedAt : "schoolalerts",
    renotify: true,
    requireInteraction: true,
    data: data,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = "/client";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const c of all) {
        if (c.url.indexOf(target) !== -1 && "focus" in c) {
          return c.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
    })(),
  );
});
