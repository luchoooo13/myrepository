const path = require("path");
const os = require("os");
const fs = require("fs");
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
app.use(express.static(path.join(__dirname, "public")));

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
webpush.setVapidDetails(
  process.env.VAPID_CONTACT || "mailto:schoolalerts@local",
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

async function sendPushToAll(payload) {
  if (pushSubs.length === 0) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(
    pushSubs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (err) {
        // 404/410 = suscripción expirada/revocada: limpiamos.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          dead.push(sub.endpoint);
        } else {
          console.warn(
            "[web-push] error enviando push:",
            err && err.message ? err.message : err,
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

// Rutas amigables (sin extensión) para usar desde los otros dispositivos
app.get("/host", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});
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
  currentAlert = {
    type: payload.type,
    label: payload.label,
    startedAt: now,
    endsAt: now + ALERT_DURATION_MS,
    durationMs: ALERT_DURATION_MS,
    sirenUrl: override.sirenUrl || null,
    skipVoice: !!override.skipVoice,
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
    if (!payload || typeof payload.type !== "string") return;
    const label =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : payload.type;
    startAlert({ type: payload.type, label });
  });

  socket.on("alert:stop", () => {
    stopAlert("manual");
  });

  socket.on("schedule:add", (payload) => {
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
