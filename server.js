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
