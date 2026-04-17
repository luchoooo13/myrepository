const path = require("path");
const os = require("os");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ALERT_DURATION_MS = 90 * 1000; // 1 minuto 30 segundos

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

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
