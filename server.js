const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const googleTTS = require("google-tts-api");
const webpush = require("web-push");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ALERT_DURATION_MS = 60 * 1000; // 1 minuto

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "200kb" }));

// --- Auth del /host ---------------------------------------------------
// El /host (panel que dispara alertas) está protegido por contraseña. Hay
// dos roles: "admin" (ve todo: scheduler, mensajes personalizados, etc.)
// y "operator" (solo los botones básicos de alerta, para preceptor/director).
// Las contraseñas viven en host-passwords.json (gitignored); si no existe
// al arrancar, lo generamos con valores por defecto para que el admin los
// edite a mano. Las sesiones son un Map en memoria: token -> { role }.
// Si se reinicia el server los tokens caducan, no es problema — son pocos
// usuarios y cada uno vuelve a ingresar la password.
const HOST_PASSWORDS_FILE = path.join(__dirname, "host-passwords.json");
const DEFAULT_HOST_PASSWORDS = {
  admin: "cambiame-admin",
  operator: "cambiame-preceptor",
};
let hostPasswords;
try {
  hostPasswords = JSON.parse(fs.readFileSync(HOST_PASSWORDS_FILE, "utf8"));
} catch {
  hostPasswords = { ...DEFAULT_HOST_PASSWORDS };
  try {
    fs.writeFileSync(
      HOST_PASSWORDS_FILE,
      JSON.stringify(hostPasswords, null, 2),
    );
    console.log(
      "[auth] host-passwords.json creado con contraseñas por defecto.",
    );
    console.log(
      "[auth]   admin    = " + hostPasswords.admin,
    );
    console.log(
      "[auth]   operator = " + hostPasswords.operator,
    );
    console.log(
      "[auth] Editá host-passwords.json y reiniciá el server antes de usarlo en producción.",
    );
  } catch (err) {
    console.warn(
      "[auth] no se pudo guardar host-passwords.json:",
      err.message,
    );
  }
}

const hostSessions = new Map(); // token -> { role, createdAt }
const HOST_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const piece of header.split(";")) {
    const i = piece.indexOf("=");
    if (i === -1) continue;
    const k = piece.slice(0, i).trim();
    const v = piece.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function getSessionByToken(token) {
  if (!token) return null;
  const sess = hostSessions.get(token);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > HOST_SESSION_TTL_MS) {
    hostSessions.delete(token);
    return null;
  }
  return sess;
}

// --- Recomendaciones editables por el admin ---------------------------
// Las recomendaciones que se muestran en la pestaña "Guía rápida" del
// cliente y abajo del cartel negro durante una alerta. Vive en
// recommendations.json (gitignored), autogenerado la primera vez con los
// defaults de abajo. El admin las puede editar desde /host — el operator
// no. Al cambiar, se broadcast a todos los clientes por socket así se
// refresca la UI en vivo (y en la próxima alert:start el server las
// adjunta al payload).
const RECS_FILE = path.join(__dirname, "recommendations.json");
const DEFAULT_RECOMMENDATIONS = {
  sismo: {
    label: "Sismo",
    icon: "🌐",
    lines: [
      "Agachate, cubrite y sostenete. Debajo de una mesa resistente si hay.",
      "Alejate de ventanas, espejos y objetos que puedan caer.",
      "En la calle, andá a un espacio abierto lejos de cables y paredes.",
      "No uses el ascensor. Esperá a que pare el movimiento para evacuar.",
    ],
  },
  incendio: {
    label: "Incendio",
    icon: "🔥",
    lines: [
      "Si hay humo, agachate y avanzá lo más bajo posible.",
      "Cerrá las puertas detrás tuyo para frenar el fuego.",
      "No uses el ascensor, salí por la escalera.",
      "Tocá las puertas con el dorso de la mano antes de abrirlas.",
    ],
  },
  evacuacion: {
    label: "Evacuación",
    icon: "🚪",
    lines: [
      "Salí con calma siguiendo las señales de evacuación.",
      "No vuelvas por objetos personales.",
      "Ayudá a quienes necesiten asistencia.",
      "Dirigite al punto de reunión y esperá instrucciones.",
    ],
  },
  medica: {
    label: "Emergencia médica",
    icon: "⛑️",
    lines: [
      "Llamá al 107 (SAME) o al 911.",
      "No muevas al paciente si no es imprescindible.",
      "Si hay un DEA cerca y la persona está inconsciente, usalo.",
      "Mantené la calma y seguí las instrucciones del operador.",
    ],
  },
  intruso: {
    label: "Intruso / Amenaza",
    icon: "🚨",
    lines: [
      "Si podés huir con seguridad, hacelo.",
      "Si no, escondete. Trabá puertas, apagá luces y silenciá el celular.",
      "Llamá al 911 apenas sea seguro.",
      "Seguí las indicaciones del personal de seguridad.",
    ],
  },
  gas: {
    label: "Fuga de gas",
    icon: "☣️",
    lines: [
      "No prendas ni apagues luces ni artefactos eléctricos.",
      "Abrí puertas y ventanas para ventilar.",
      "Evacuá el edificio y llamá al 911 desde afuera.",
      "No uses el ascensor.",
    ],
  },
  bomba: {
    label: "Amenaza de bomba",
    icon: "💣",
    lines: [
      "No toques objetos sospechosos.",
      "Evacuá con calma siguiendo indicaciones del personal.",
      "Una vez afuera, alejate al menos 100 metros del edificio.",
      "No uses el celular cerca del objeto sospechoso.",
    ],
  },
  tormenta: {
    label: "Tormenta severa",
    icon: "⛈️",
    lines: [
      "Mantenete adentro, lejos de ventanas.",
      "Desenchufá equipos eléctricos sensibles.",
      "No te refugies debajo de árboles ni estructuras metálicas si estás afuera.",
      "Seguí las indicaciones de Defensa Civil (103).",
    ],
  },
  simulacro: {
    label: "Simulacro",
    icon: "🧪",
    lines: [
      "Esto es un simulacro: seguí el protocolo como si fuera una emergencia real.",
      "Respetá los tiempos y rutas marcadas.",
      "Reportá al referente cualquier inconveniente detectado.",
    ],
  },
  custom: {
    label: "Mensaje personalizado",
    icon: "✏️",
    lines: [
      "Seguí las instrucciones del personal del establecimiento.",
    ],
  },
};

// Clonamos los defaults para no mutarlos si alguien escribe sobre
// recommendations (paranoia; no pasa en este código, pero asegura que
// POST /recommendations/reset siempre vuelve al estado original).
function cloneDefaultRecommendations() {
  const out = {};
  for (const key of Object.keys(DEFAULT_RECOMMENDATIONS)) {
    const src = DEFAULT_RECOMMENDATIONS[key];
    out[key] = {
      label: src.label,
      icon: src.icon,
      lines: src.lines.slice(),
    };
  }
  return out;
}

let recommendations = cloneDefaultRecommendations();
try {
  const rawRecs = fs.readFileSync(RECS_FILE, "utf8");
  const parsedRecs = JSON.parse(rawRecs);
  if (parsedRecs && typeof parsedRecs === "object") {
    // Merge con defaults: si el admin agregó un tipo custom o dejó
    // alguno incompleto, no explotamos.
    for (const key of Object.keys(parsedRecs)) {
      const src = parsedRecs[key];
      if (!src || typeof src !== "object") continue;
      const lines = Array.isArray(src.lines)
        ? src.lines
            .map((l) => (typeof l === "string" ? l.trim() : ""))
            .filter((l) => l.length > 0)
        : recommendations[key]
          ? recommendations[key].lines
          : [];
      const baseLabel =
        recommendations[key] && recommendations[key].label
          ? recommendations[key].label
          : key;
      const baseIcon =
        recommendations[key] && recommendations[key].icon
          ? recommendations[key].icon
          : "";
      recommendations[key] = {
        label:
          typeof src.label === "string" && src.label.trim().length > 0
            ? src.label.trim()
            : baseLabel,
        icon:
          typeof src.icon === "string" && src.icon.trim().length > 0
            ? src.icon.trim()
            : baseIcon,
        lines,
      };
    }
  }
} catch {
  // Archivo no existe todavía. Lo creamos con los defaults así el admin
  // lo puede editar a mano si prefiere tocar el JSON.
  try {
    fs.writeFileSync(
      RECS_FILE,
      JSON.stringify(recommendations, null, 2),
    );
  } catch (err) {
    console.warn(
      "[recs] no se pudo guardar recommendations.json:",
      err.message,
    );
  }
}

function saveRecommendations() {
  try {
    fs.writeFileSync(
      RECS_FILE,
      JSON.stringify(recommendations, null, 2),
    );
  } catch (err) {
    console.warn(
      "[recs] no se pudo guardar recommendations.json:",
      err.message,
    );
  }
}

// Sanea las líneas que manda el admin: recorta, descarta vacías y limita
// longitud / cantidad para evitar payloads absurdos que rompan la UI.
function sanitizeRecLines(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 400));
    if (out.length >= 20) break;
  }
  return out;
}

function serializeRecommendations() {
  // Copia superficial para no exponer el objeto interno.
  const out = {};
  for (const key of Object.keys(recommendations)) {
    const r = recommendations[key];
    out[key] = {
      label: r.label,
      icon: r.icon,
      lines: r.lines.slice(),
    };
  }
  return out;
}

app.get("/recommendations", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ recommendations: serializeRecommendations() });
});

// Sólo admin puede editar. No usamos el socket para esto porque el admin
// podría estar editando desde una tab sin socket conectado, y la cookie
// ya tenemos la del /host.
function requireAdmin(req, res) {
  const cookies = parseCookies(req);
  const sess = getSessionByToken(cookies.hostToken);
  if (!sess || sess.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return null;
  }
  return sess;
}

// Editar un tipo de alerta: { type: "incendio", lines: ["...", "..."] }.
// Creamos el tipo si no existía (no hay ALERT_TYPES hardcodeado — el
// server acepta cualquier type; el host.js decide qué botones muestra).
app.post("/recommendations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const type =
    typeof body.type === "string" && body.type.trim().length > 0
      ? body.type.trim().slice(0, 40)
      : null;
  const lines = sanitizeRecLines(body.lines);
  if (!type || lines == null) {
    res.status(400).json({ error: "type y lines son requeridos" });
    return;
  }
  const base = recommendations[type] || DEFAULT_RECOMMENDATIONS[type] || {};
  const label =
    typeof body.label === "string" && body.label.trim().length > 0
      ? body.label.trim().slice(0, 80)
      : base.label || type;
  const icon =
    typeof body.icon === "string" && body.icon.trim().length > 0
      ? body.icon.trim().slice(0, 8)
      : base.icon || "";
  recommendations[type] = { label, icon, lines };
  saveRecommendations();
  io.emit("recommendations:update", {
    recommendations: serializeRecommendations(),
  });
  res.json({ ok: true, recommendations: serializeRecommendations() });
});

// Restaurar defaults de un tipo (o de todos si no se pasa type).
app.post("/recommendations/reset", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (type) {
    if (DEFAULT_RECOMMENDATIONS[type]) {
      const d = DEFAULT_RECOMMENDATIONS[type];
      recommendations[type] = {
        label: d.label,
        icon: d.icon,
        lines: d.lines.slice(),
      };
    } else {
      delete recommendations[type];
    }
  } else {
    recommendations = cloneDefaultRecommendations();
  }
  saveRecommendations();
  io.emit("recommendations:update", {
    recommendations: serializeRecommendations(),
  });
  res.json({ ok: true, recommendations: serializeRecommendations() });
});

app.post("/host-login", (req, res) => {
  const pwd =
    req.body && typeof req.body.password === "string" ? req.body.password : "";
  let role = null;
  if (pwd && pwd === hostPasswords.admin) role = "admin";
  else if (pwd && pwd === hostPasswords.operator) role = "operator";
  if (!role) {
    res.status(401).json({ error: "Contraseña incorrecta" });
    return;
  }
  const token = makeToken();
  hostSessions.set(token, { role, createdAt: Date.now() });
  const maxAgeSec = Math.floor(HOST_SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `hostToken=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${maxAgeSec}; SameSite=Lax`,
  );
  res.json({ ok: true, role });
});

// Cambio de contraseña desde el panel /host. El usuario logueado puede
// cambiar la contraseña de SU propio rol (admin cambia la de admin,
// operator la de operator). Exigimos la contraseña actual para evitar que
// alguien con la cookie robada cambie la pass sin conocerla. Al cambiar,
// invalidamos todas las demás sesiones activas del mismo rol para obligar
// un re-login (la del que cambió la pass se mantiene).
app.post("/host/change-password", (req, res) => {
  const cookies = parseCookies(req);
  const sess = getSessionByToken(cookies.hostToken);
  if (!sess) {
    res.status(401).json({ error: "no hay sesión" });
    return;
  }
  const body = req.body || {};
  const current =
    typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (!current || !next) {
    res
      .status(400)
      .json({ error: "Faltan la contraseña actual o la nueva." });
    return;
  }
  if (next.length < 6) {
    res
      .status(400)
      .json({ error: "La nueva contraseña tiene que tener al menos 6 caracteres." });
    return;
  }
  if (next.length > 120) {
    res.status(400).json({ error: "La nueva contraseña es demasiado larga." });
    return;
  }
  const expected = hostPasswords[sess.role];
  if (!expected || current !== expected) {
    res.status(401).json({ error: "La contraseña actual no es correcta." });
    return;
  }
  if (current === next) {
    res
      .status(400)
      .json({ error: "La nueva contraseña tiene que ser distinta a la actual." });
    return;
  }
  hostPasswords[sess.role] = next;
  try {
    fs.writeFileSync(
      HOST_PASSWORDS_FILE,
      JSON.stringify(hostPasswords, null, 2),
    );
  } catch (err) {
    console.warn(
      "[auth] no se pudo persistir la nueva contraseña:",
      err.message,
    );
    res
      .status(500)
      .json({ error: "No se pudo guardar la nueva contraseña." });
    return;
  }
  // Invalidamos el resto de las sesiones del mismo rol (que ya no saben la
  // pass nueva). La del usuario que cambió la pass queda viva.
  for (const [token, s] of hostSessions.entries()) {
    if (s.role === sess.role && token !== cookies.hostToken) {
      hostSessions.delete(token);
    }
  }
  res.json({ ok: true });
});

app.post("/host-logout", (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.hostToken) hostSessions.delete(cookies.hostToken);
  res.setHeader(
    "Set-Cookie",
    "hostToken=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax",
  );
  res.json({ ok: true });
});

app.get("/host-login", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "host-login.html"));
});

// /host.html pedido directo → mandamos al login. Esto tiene que ir ANTES
// del middleware express.static de abajo, porque static sirve host.html
// literal sin auth (index:false no afecta archivos con nombre específico,
// sólo el índice de directorios).
app.get("/host.html", (_req, res) => {
  res.redirect("/host");
});

// /host: inyectamos el rol + token en meta tags para que host.js los lea.
// Si no hay sesión válida, redirigimos al login.
app.get("/host", (req, res) => {
  const cookies = parseCookies(req);
  const sess = getSessionByToken(cookies.hostToken);
  if (!sess) {
    res.redirect("/host-login");
    return;
  }
  let html;
  try {
    html = fs.readFileSync(
      path.join(__dirname, "public", "host.html"),
      "utf8",
    );
  } catch (err) {
    res.status(500).send("No se pudo leer host.html");
    return;
  }
  const metaTags =
    `<meta name="host-role" content="${sess.role}" />\n` +
    `    <meta name="host-token" content="${cookies.hostToken}" />`;
  const withMeta = html.replace("</head>", `    ${metaTags}\n  </head>`);
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(withMeta);
});

// Servimos los archivos del cliente sin caché en el navegador para que los
// profes no queden atascados con una versión vieja del HTML/JS después de un
// update. Los mp3 / png sí se pueden cachear (no cambian seguido).
// Cuidado: este middleware se registra DESPUÉS de las rutas /host* para que
// /host no caiga en host.html directo (queremos que pase por el handler de
// auth de arriba).
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|json|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
    index: false,
  }),
);


// --- Web Push (VAPID) --------------------------------------------------
// Genera las claves VAPID la primera vez que se arranca el server y las
// guarda en vapid-keys.json (gitignored) para que sean estables entre
// reinicios. Las suscripciones de los navegadores se guardan en
// push-subs.json para que sobrevivan reinicios del server.
const VAPID_FILE = path.join(__dirname, "vapid-keys.json");
let vapidKeys;
try {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
    console.log(
      "[web-push] claves VAPID generadas y guardadas en vapid-keys.json",
    );
  } catch (err) {
    console.warn("[web-push] no se pudo guardar vapid-keys.json:", err.message);
  }
}
// Apple (web.push.apple.com) rechaza el JWT VAPID si el subject no es
// una URL https:// o un mailto: con un TLD válido. "@local" no es
// un TLD válido y hace que Apple devuelva 400/403.
webpush.setVapidDetails(
  process.env.VAPID_CONTACT || "mailto:schoolalerts@example.com",
  vapidKeys.publicKey,
  vapidKeys.privateKey,
);

const SUBS_FILE = path.join(__dirname, "push-subs.json");
let pushSubs = [];
try {
  const raw = fs.readFileSync(SUBS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) pushSubs = parsed;
} catch {
  pushSubs = [];
}
function savePushSubs() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubs, null, 2));
  } catch (err) {
    console.warn("[web-push] no se pudo guardar push-subs.json:", err.message);
  }
}

app.get("/vapid-public-key", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post("/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys) {
    res.status(400).json({ error: "missing subscription" });
    return;
  }
  const idx = pushSubs.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx === -1) {
    pushSubs.push(sub);
    savePushSubs();
    console.log(
      `[web-push] nueva suscripción (total: ${pushSubs.length})`,
    );
  }
  res.json({ ok: true });
});

app.post("/push/unsubscribe", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) {
    res.status(400).json({ error: "missing endpoint" });
    return;
  }
  const before = pushSubs.length;
  pushSubs = pushSubs.filter((s) => s.endpoint !== endpoint);
  if (pushSubs.length !== before) savePushSubs();
  res.json({ ok: true });
});

// Pausar / despausar notificaciones push para una suscripción puntual.
// El cliente manda { endpoint, pausedUntil } donde pausedUntil es un
// timestamp ms (0 = no pausada, Number.MAX_SAFE_INTEGER = pausa indefinida).
// Mientras pausedUntil > Date.now(), sendPushToAll salta esta suscripción.
app.post("/push/pause", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  const pausedUntil = req.body && Number(req.body.pausedUntil);
  if (!endpoint) {
    res.status(400).json({ error: "missing endpoint" });
    return;
  }
  const sub = pushSubs.find((s) => s.endpoint === endpoint);
  if (!sub) {
    res.status(404).json({ error: "endpoint not found" });
    return;
  }
  sub.pausedUntil = Number.isFinite(pausedUntil) ? pausedUntil : 0;
  savePushSubs();
  res.json({ ok: true, pausedUntil: sub.pausedUntil });
});

async function sendPushToAll(payload) {
  if (pushSubs.length === 0) return;
  const body = JSON.stringify(payload);
  const dead = [];
  const now = Date.now();
  await Promise.all(
    pushSubs.map(async (sub) => {
      // Respetar la pausa del usuario (toggle "Pausar notificaciones" del
      // cliente). Si todavía no venció, no mandamos la push a esta
      // suscripción. La pausa se acuerda via POST /push/pause.
      if (sub.pausedUntil && sub.pausedUntil > now) return;
      try {
        await webpush.sendNotification(sub, body);
      } catch (err) {
        // 404/410 = suscripción expirada/revocada: limpiamos.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          dead.push(sub.endpoint);
        } else {
          const code = err && err.statusCode ? err.statusCode : "?";
          const body =
            err && err.body ? String(err.body).slice(0, 200) : "";
          const host = (() => {
            try {
              return new URL(sub.endpoint).host;
            } catch {
              return "?";
            }
          })();
          console.warn(
            `[web-push] error ${code} enviando a ${host}:`,
            (err && err.message) || err,
            body,
          );
        }
      }
    }),
  );
  if (dead.length > 0) {
    pushSubs = pushSubs.filter((s) => !dead.includes(s.endpoint));
    savePushSubs();
    console.log(
      `[web-push] ${dead.length} suscripciones vencidas eliminadas (quedan ${pushSubs.length})`,
    );
  }
}

// Rutas amigables (sin extensión) para usar desde los otros dispositivos.
// /host está definido arriba (con auth); acá sólo el /client.
app.get("/client", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "client.html"));
});

// Proxy a Google TTS para alertas con mensaje personalizado.
// Devuelve un MP3 con la voz de Google leyendo el texto pedido.
const ttsCache = new Map(); // text -> Buffer
app.get("/tts", async (req, res) => {
  const raw = (req.query.text || "").toString().trim();
  const text = raw.slice(0, 500);
  if (!text) {
    res.status(400).send("missing text");
    return;
  }
  try {
    let mp3 = ttsCache.get(text);
    if (!mp3) {
      const chunks = await googleTTS.getAllAudioBase64(text, {
        lang: "es",
        slow: false,
        host: "https://translate.google.com",
        splitPunct: ",.?!;",
      });
      const buffers = chunks.map((c) => Buffer.from(c.base64, "base64"));
      mp3 = Buffer.concat(buffers);
      // cache chico para no pegarle a Google cada 5 segundos
      if (ttsCache.size > 50) ttsCache.clear();
      ttsCache.set(text, mp3);
    }
    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", String(mp3.length));
    res.set("Cache-Control", "public, max-age=86400");
    res.send(mp3);
  } catch (err) {
    console.error("TTS error:", err.message);
    res.status(502).send("tts error");
  }
});

// --- Sincronización con hora real (NTP "pobre" via HTTP) ---------------
// Cuando el reloj de la PC que corre el server está corrido algunos
// segundos, queremos mostrar la hora correcta y disparar las alertas en el
// momento correcto igualmente. Probamos varias fuentes de hora.
let timeOffsetMs = 0; // realNow - Date.now()
const TIME_SOURCES = [
  async () => {
    const r = await fetchWithTimeout(
      "https://worldtimeapi.org/api/timezone/America/Argentina/Buenos_Aires",
      4000,
    );
    if (!r.ok) throw new Error("worldtimeapi " + r.status);
    const j = await r.json();
    return new Date(j.datetime).getTime();
  },
  async () => {
    const r = await fetchWithTimeout("https://www.google.com", 4000, "HEAD");
    const h = r.headers.get("date");
    if (!h) throw new Error("google no date");
    return new Date(h).getTime();
  },
];

async function fetchWithTimeout(url, ms, method = "GET") {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { method, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function sampleSource(src) {
  const t0 = Date.now();
  const ext = await src();
  const t1 = Date.now();
  const latency = (t1 - t0) / 2;
  return { offset: ext - (t0 + latency), latency };
}

async function syncClock() {
  // Tomamos 5 muestras y nos quedamos con la de menor latencia,
  // para minimizar el error causado por una conexión lenta.
  for (const src of TIME_SOURCES) {
    try {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        try {
          samples.push(await sampleSource(src));
        } catch {
          /* ignore sample */
        }
      }
      if (samples.length === 0) throw new Error("sin muestras");
      samples.sort((a, b) => a.latency - b.latency);
      const best = samples[0];
      timeOffsetMs = Math.round(best.offset);
      console.log(
        `[time-sync] offset = ${timeOffsetMs}ms (latencia ${Math.round(best.latency)}ms, ${samples.length} muestras)`,
      );
      return;
    } catch (err) {
      console.warn("[time-sync] fuente fallida:", err.message);
    }
  }
  console.warn("[time-sync] ninguna fuente respondió, uso reloj local");
}

function realNow() {
  return Date.now() + timeOffsetMs;
}

syncClock();
setInterval(syncClock, 15 * 60 * 1000);

app.get("/time", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ now: realNow() });
});

// Estado actual de la alerta (permite sincronizar clientes que se conectan tarde)
let currentAlert = null; // { type, label, startedAt, endsAt }
let alertTimer = null;

// --- Programación de alertas (hora Buenos Aires) -----------------------
// schedule: { id, hour, minute, type, label, fireAt }
const schedules = [];
let nextScheduleId = 1;
const BA_TZ = "America/Argentina/Buenos_Aires";

// Calcula el próximo timestamp en UTC para una hora:minuto en Buenos Aires.
// Buenos Aires está en UTC-3 todo el año (sin horario de verano).
function nextFireAtBA(hour, minute, afterMs) {
  const base = afterMs || realNow();
  const now = new Date(base);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  let y = Number(parts.year);
  let m = Number(parts.month);
  let d = Number(parts.day);
  const nowBaMin = Number(parts.hour) * 60 + Number(parts.minute);
  const targetMin = hour * 60 + minute;
  // Si la hora objetivo ya pasó (o es este mismo minuto), programá para mañana.
  if (targetMin <= nowBaMin) {
    const next = new Date(Date.UTC(y, m - 1, d));
    next.setUTCDate(next.getUTCDate() + 1);
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  const iso =
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T` +
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-03:00`;
  return new Date(iso).getTime();
}

function broadcastSchedules() {
  io.emit("schedule:list", serializeSchedules());
}

function serializeSchedules() {
  return schedules
    .slice()
    .sort((a, b) => a.fireAt - b.fireAt)
    .map((s) => ({
      id: s.id,
      hour: s.hour,
      minute: s.minute,
      type: s.type,
      label: s.label,
      fireAt: s.fireAt,
      recurring: s.recurring,
    }));
}

function addSchedule({ hour, minute, type, label, recurring }) {
  const fireAt = nextFireAtBA(hour, minute);
  const entry = {
    id: nextScheduleId++,
    hour,
    minute,
    type,
    label,
    fireAt,
    recurring: !!recurring,
  };
  schedules.push(entry);
  broadcastSchedules();
  return entry;
}

function removeSchedule(id) {
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  schedules.splice(idx, 1);
  broadcastSchedules();
  return true;
}

// Chequea cada 1 segundo si alguna programación llegó a su hora.
// Con 1s de granularidad, el máximo retraso es <1s (en 10s era de hasta ~10s).
setInterval(() => {
  const now = realNow();
  const due = schedules.filter((s) => s.fireAt <= now);
  if (due.length === 0) return;
  for (const s of due) {
    console.log(
      `[schedule] disparando ${s.type} (${s.label})` +
        (s.recurring ? " [diaria]" : ""),
    );
    startAlert({ type: s.type, label: s.label });
    if (s.recurring) {
      // Reprogramá para el próximo día a la misma hora.
      s.fireAt = nextFireAtBA(s.hour, s.minute, now + 60 * 1000);
    } else {
      const idx = schedules.indexOf(s);
      if (idx !== -1) schedules.splice(idx, 1);
    }
  }
  broadcastSchedules();
}, 1000);

function clearAlertTimer() {
  if (alertTimer) {
    clearTimeout(alertTimer);
    alertTimer = null;
  }
}

function stopAlert(reason = "manual") {
  clearAlertTimer();
  currentAlert = null;
  io.emit("alert:stop", { reason, at: Date.now() });
}

// Overrides por tipo de alerta: algunos tipos traen una sirena propia que
// ya incluye la locución grabada; para esos skipVoice = true así el cliente
// no superpone la voz de Google TTS sobre la locución de la sirena.
const ALERT_OVERRIDES = {
  simulacro: {
    sirenUrl: "/sounds/siren-simulacro.mp3",
    skipVoice: true,
  },
};

function startAlert(payload) {
  clearAlertTimer();
  // Usamos realNow() (no Date.now()) así startedAt/endsAt están en la
  // misma escala que el reloj de los clientes; si el reloj de la PC
  // server está corrido varios segundos, el cliente igual ve el
  // countdown correcto.
  const now = realNow();
  const override = ALERT_OVERRIDES[payload.type] || {};
  const recForType = recommendations[payload.type] || null;
  currentAlert = {
    type: payload.type,
    label: payload.label,
    startedAt: now,
    endsAt: now + ALERT_DURATION_MS,
    durationMs: ALERT_DURATION_MS,
    sirenUrl: override.sirenUrl || null,
    skipVoice: !!override.skipVoice,
    // Incluimos las recomendaciones vigentes en el mismo payload para que
    // el cliente las pueda mostrar debajo del cartel negro sin tener que
    // volver a pegar el GET /recommendations (además así gana el snapshot
    // exacto al momento del disparo: si después el admin edita mientras
    // la alerta está activa, la pantalla no cambia de recs a mitad).
    recommendations:
      recForType && Array.isArray(recForType.lines)
        ? recForType.lines.slice()
        : [],
  };
  io.emit("alert:start", currentAlert);
  // Notificación push a iPhones / Androids con la PWA instalada y
  // notificaciones permitidas. Llega aunque la app esté cerrada o el
  // celu esté bloqueado. No bloqueamos la alerta si falla.
  sendPushToAll({
    title: "🚨 ALERTA: " + (currentAlert.label || currentAlert.type),
    body: "Abrí SchoolAlerts para ver la alerta en pantalla completa.",
    type: currentAlert.type,
    startedAt: currentAlert.startedAt,
  }).catch((err) => {
    console.warn("[web-push] fallo al notificar:", err && err.message);
  });
  alertTimer = setTimeout(() => {
    stopAlert("timeout");
  }, ALERT_DURATION_MS);
}

// --- Contador de clientes conectados (solo /client) --------------------
const clientSockets = new Set();
function broadcastClientCount() {
  io.emit("clients:count", { count: clientSockets.size });
}

// Socket.io middleware: si el handshake trae un token de host (lo inyecta
// host.js desde la meta tag server-rendered), lo validamos contra las
// sesiones en memoria y adjuntamos el rol al socket. Los sockets de /client
// no mandan token y caen como role=null — pueden recibir alertas pero no
// pueden disparar/programar.
io.use((socket, next) => {
  const token =
    socket.handshake &&
    socket.handshake.auth &&
    typeof socket.handshake.auth.token === "string"
      ? socket.handshake.auth.token
      : null;
  const sess = getSessionByToken(token);
  socket.data.role = sess ? sess.role : null;
  next();
});

function isHost(socket) {
  return socket.data.role === "admin" || socket.data.role === "operator";
}

io.on("connection", (socket) => {
  // Al conectarse, sincronizar con la alerta activa si existe.
  // Comparamos contra realNow() para ser consistentes con startAlert().
  if (currentAlert && realNow() < currentAlert.endsAt) {
    socket.emit("alert:start", currentAlert);
  }
  // Sincronizar lista de programaciones
  socket.emit("schedule:list", serializeSchedules());
  socket.emit("clients:count", { count: clientSockets.size });

  socket.on("role:client", () => {
    if (!clientSockets.has(socket.id)) {
      clientSockets.add(socket.id);
      broadcastClientCount();
    }
  });

  socket.on("disconnect", () => {
    if (clientSockets.delete(socket.id)) {
      broadcastClientCount();
    }
  });

  socket.on("alert:trigger", (payload) => {
    // Sólo admin y operator pueden disparar alertas. Operator además no
    // puede disparar mensajes personalizados — eso es sólo de admin.
    if (!isHost(socket)) return;
    if (!payload || typeof payload.type !== "string") return;
    if (socket.data.role === "operator" && payload.type === "custom") return;
    const label =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : payload.type;
    startAlert({ type: payload.type, label });
  });

  socket.on("alert:stop", () => {
    if (!isHost(socket)) return;
    stopAlert("manual");
  });

  socket.on("schedule:add", (payload) => {
    // Scheduler es sólo para admin.
    if (socket.data.role !== "admin") return;
    if (!payload || typeof payload.type !== "string") return;
    const hour = Number(payload.hour);
    const minute = Number(payload.minute);
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return;
    }
    const rawLabel =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim().slice(0, 200)
        : payload.type;
    addSchedule({
      hour,
      minute,
      type: payload.type,
      label: rawLabel,
      recurring: !!payload.recurring,
    });
  });

  socket.on("schedule:remove", (payload) => {
    if (socket.data.role !== "admin") return;
    const id = payload && Number(payload.id);
    if (!Number.isInteger(id)) return;
    removeSchedule(id);
  });
});

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        result.push(net.address);
      }
    }
  }
  return result;
}

server.listen(PORT, "0.0.0.0", () => {
  const lan = getLanAddresses();
  console.log("Servidor de Alertas de Emergencia iniciado");
  console.log(`  Local:   http://localhost:${PORT}/`);
  if (lan.length === 0) {
    console.log("  LAN:     (no se detectaron interfaces de red)");
  } else {
    for (const ip of lan) {
      console.log(`  LAN:     http://${ip}:${PORT}/`);
    }
  }
  console.log("Rutas:");
  console.log("  /         -> menu");
  console.log("  /host     -> panel para disparar alertas");
  console.log("  /client   -> pantalla cliente que recibe alertas");
});
