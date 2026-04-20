// Service worker de SchoolAlerts.
// Funciones:
//  1) Recibir push notifications (VAPID) y mostrar una notificacion del
//     sistema, incluso con la pantalla bloqueada o la app cerrada.
//  2) Interceptar todos los fetch same-origin y agregar el header
//     "ngrok-skip-browser-warning" para que ngrok NO muestre la pagina
//     interstitial de "You are about to visit..." cuando el server esta
//     expuesto via un tunel ngrok free-tier. Sin esto, cada vez que iOS
//     reciclea el SW / la cache (ej. tras reiniciar el iPad), la PWA
//     muestra el interstitial de ngrok en lugar de la app.
//  3) Cachear el app-shell (HTML/JS/CSS/manifest/icons/sonidos) para que
//     al reabrir la PWA sobreviva aunque ngrok este caido o lento.
//
// iOS 16.4+ requiere que:
//  - La PWA este instalada en la pantalla de inicio (no desde Safari).
//  - Cada evento `push` muestre una notificacion (no se permiten pushes
//    silenciosos); si no, iOS revoca el permiso.
//
// El service worker NO comparte estado con la pagina. Se ejecuta en
// background aunque la pestana este cerrada.

// Bumpear CACHE_NAME obliga al browser a tirar la cache vieja y pedir los
// assets de nuevo. Lo subimos cada vez que cambia el app-shell
// (client.html/client.js/styles.css) o este mismo SW.
const CACHE_NAME = "schoolalerts-v2";
const APP_SHELL = [
  "/client",
  "/client.html",
  "/client.js",
  "/styles.css",
  "/clock.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/socket.io/socket.io.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Usamos fetchWithNgrokSkip asi la pre-cache inicial tampoco pega
      // contra el interstitial de ngrok. Si alguno falla seguimos (no
      // queremos bloquear la instalacion por un 404 de un asset opcional).
      await Promise.all(
        APP_SHELL.map(async (url) => {
          try {
            const resp = await fetchWithNgrokSkip(new Request(url));
            if (resp && resp.ok) {
              await cache.put(url, resp.clone());
            }
          } catch (_) {
            /* ignore */
          }
        }),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Borramos caches viejos de versiones anteriores del SW.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Fetch clonando el Request con el header ngrok-skip-browser-warning
// seteado. Este header (con cualquier valor) le dice a ngrok que somos
// una app, no un humano, y que NO muestre el interstitial. Lo aplicamos
// a TODO fetch same-origin: no tiene costo y evita que ngrok interfiera
// con cualquier request (HTML, JS, XHR, etc.). El header es ignorado por
// servers que no son ngrok, asi que es seguro tenerlo siempre.
function fetchWithNgrokSkip(request) {
  // Request.headers es read-only, asi que armamos uno nuevo.
  const headers = new Headers(request.headers);
  headers.set("ngrok-skip-browser-warning", "1");
  const init = {
    method: request.method,
    headers,
    // mode "navigate" no se puede usar en fetch() — pasamos a "cors".
    mode: request.mode === "navigate" ? "cors" : request.mode,
    credentials: request.credentials,
    redirect: "follow",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Para POST/PUT/DELETE clonamos para no consumir el body original.
    init.body = request.clone().body;
  }
  return fetch(request.url, init);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Solo same-origin: a CDNs externos / APIs de terceros los dejamos pasar
  // sin tocar (fetch default).
  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Navegaciones (abrir la PWA, recargar): cache-first con actualizacion
  // en background. Si tenemos el HTML cacheado, lo servimos al instante
  // — asi la PWA abre aunque ngrok este colgado o muestre el interstitial
  // en la primera request despues de un restart del iPad.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match("/client.html");
        const networkPromise = fetchWithNgrokSkip(req)
          .then((resp) => {
            if (resp && resp.ok && req.method === "GET") {
              // Guardamos bajo la key fija "/client.html" asi sirve tanto
              // para /client como para /client.html.
              cache.put("/client.html", resp.clone()).catch(() => {});
            }
            return resp;
          })
          .catch(() => null);
        if (cached) {
          // Servimos cache; el fetch corre en background para actualizar.
          event.waitUntil(networkPromise);
          return cached;
        }
        const networkResp = await networkPromise;
        if (networkResp) return networkResp;
        // Sin red y sin cache: pagina minima de error.
        return new Response(
          "<!doctype html><meta charset=utf-8><title>Sin conexion</title>" +
            "<body style=\"font-family:system-ui;padding:2rem;text-align:center\">" +
            "<h1>Sin conexion</h1><p>No se pudo cargar SchoolAlerts. " +
            "Proba de nuevo en un momento.</p></body>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      })(),
    );
    return;
  }

  // Assets estaticos (CSS/JS/imagenes/sonidos): stale-while-revalidate.
  // Para APIs (POST /push/subscribe, /push/pause, etc.) vamos directo a
  // red con el header anti-interstitial.
  const isGet = req.method === "GET";
  const isStatic =
    isGet &&
    (url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".ico") ||
      url.pathname.endsWith(".mp3") ||
      url.pathname.endsWith(".json") ||
      url.pathname.endsWith(".html") ||
      url.pathname === "/client" ||
      url.pathname === "/host");

  if (isStatic) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        const networkPromise = fetchWithNgrokSkip(req)
          .then((resp) => {
            if (resp && resp.ok) {
              cache.put(req, resp.clone()).catch(() => {});
            }
            return resp;
          })
          .catch(() => null);
        if (cached) {
          event.waitUntil(networkPromise);
          return cached;
        }
        const networkResp = await networkPromise;
        if (networkResp) return networkResp;
        return new Response("", { status: 504, statusText: "offline" });
      })(),
    );
    return;
  }

  // Requests dinamicos (APIs, socket.io polling): red directa con el
  // header anti-ngrok-interstitial.
  event.respondWith(fetchWithNgrokSkip(req));
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
