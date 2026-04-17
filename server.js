const path = require("path");
const os = require("os");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const googleTTS = require("google-tts-api");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ALERT_DURATION_MS = 90 * 1000; // 1 minuto 30 segundos

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

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
function nextFireAtBA(hour, minute) {
  const now = new Date();
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
    }));
}

function addSchedule({ hour, minute, type, label }) {
  const fireAt = nextFireAtBA(hour, minute);
  const entry = {
    id: nextScheduleId++,
    hour,
    minute,
    type,
    label,
    fireAt,
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

// Chequea cada 10 segundos si alguna programación llegó a su hora.
setInterval(() => {
  const now = Date.now();
  const due = schedules.filter((s) => s.fireAt <= now);
  if (due.length === 0) return;
  for (const s of due) {
    const idx = schedules.indexOf(s);
    if (idx !== -1) schedules.splice(idx, 1);
    console.log(`[schedule] disparando ${s.type} (${s.label}) programada`);
    startAlert({ type: s.type, label: s.label });
  }
  broadcastSchedules();
}, 10 * 1000);

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

function startAlert(payload) {
  clearAlertTimer();
  const now = Date.now();
  currentAlert = {
    type: payload.type,
    label: payload.label,
    startedAt: now,
    endsAt: now + ALERT_DURATION_MS,
    durationMs: ALERT_DURATION_MS,
  };
  io.emit("alert:start", currentAlert);
  alertTimer = setTimeout(() => {
    stopAlert("timeout");
  }, ALERT_DURATION_MS);
}

io.on("connection", (socket) => {
  // Al conectarse, sincronizar con la alerta activa si existe
  if (currentAlert && Date.now() < currentAlert.endsAt) {
    socket.emit("alert:start", currentAlert);
  }
  // Sincronizar lista de programaciones
  socket.emit("schedule:list", serializeSchedules());

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
    addSchedule({ hour, minute, type: payload.type, label: rawLabel });
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
