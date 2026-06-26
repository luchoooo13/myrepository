const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const googleTTS = require("google-tts-api");
const webpush = require("web-push");
const os = require("os");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ALERT_DURATION_MS = 60 * 1000;
const ALERT_DURATION_MIN_MS = 10 * 1000;
const ALERT_DURATION_MAX_MS = 10 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "200kb" }));

// ─────────────────────────────────────────────
// MONITOR LOGS
// ─────────────────────────────────────────────
const monitorLogs = [];

function addMonitorLog(type, message) {
  const log = { type, message, time: Date.now() };
  monitorLogs.unshift(log);
  if (monitorLogs.length > 300) monitorLogs.pop();
  console.log(`[MONITOR] ${type.toUpperCase()} | ${message}`);
  io.emit("monitor:newlog", log);
}

// ─────────────────────────────────────────────
// AUTH — HOST PASSWORDS
// ─────────────────────────────────────────────
const HOST_PASSWORDS_FILE = path.join(__dirname, "host-passwords.json");
const DEFAULT_HOST_PASSWORDS = { admin: "cambiame-admin", operator: "cambiame-preceptor" };
let hostPasswords;
try {
  hostPasswords = JSON.parse(fs.readFileSync(HOST_PASSWORDS_FILE, "utf8"));
} catch {
  hostPasswords = { ...DEFAULT_HOST_PASSWORDS };
  try {
    fs.writeFileSync(HOST_PASSWORDS_FILE, JSON.stringify(hostPasswords, null, 2));
    console.log("[auth] host-passwords.json creado con contraseñas por defecto.");
    console.log("[auth]   admin    = " + hostPasswords.admin);
    console.log("[auth]   operator = " + hostPasswords.operator);
  } catch (err) {
    console.warn("[auth] no se pudo guardar host-passwords.json:", err.message);
  }
}

const hostSessions = new Map();
const HOST_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
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

function requireAdmin(req, res) {
  const cookies = parseCookies(req);
  const sess = getSessionByToken(cookies.hostToken);
  if (!sess || sess.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return null;
  }
  return sess;
}

// ─────────────────────────────────────────────
// RECOMENDACIONES
// ─────────────────────────────────────────────
const RECS_FILE = path.join(__dirname, "recommendations.json");
const DEFAULT_RECOMMENDATIONS = {
  sismo:      { label: "Sismo",              icon: "🌐", lines: ["Agachate, cubrite y sostenete.", "Alejate de ventanas y objetos que puedan caer.", "No uses el ascensor. Esperá a que pare el movimiento."] },
  incendio:   { label: "Incendio",           icon: "🔥", lines: ["Si hay humo, agachate y avanzá lo más bajo posible.", "Cerrá las puertas detrás tuyo para frenar el fuego.", "No uses el ascensor, salí por la escalera."] },
  evacuacion: { label: "Evacuación",         icon: "🚪", lines: ["Salí con calma siguiendo las señales de evacuación.", "No vuelvas por objetos personales.", "Dirigite al punto de reunión y esperá instrucciones."] },
  medica:     { label: "Emergencia médica",  icon: "⛑️", lines: ["Llamá al 107 (SAME) o al 911.", "No muevas al paciente si no es imprescindible.", "Mantené la calma y seguí las instrucciones del operador."] },
  intruso:    { label: "Intruso / Amenaza",  icon: "🚨", lines: ["Si podés huir con seguridad, hacelo.", "Si no, escondete. Trabá puertas, apagá luces y silenciá el celular.", "Llamá al 911 apenas sea seguro."] },
  gas:        { label: "Fuga de gas",        icon: "☣️", lines: ["No prendas ni apagues luces ni artefactos eléctricos.", "Abrí puertas y ventanas para ventilar.", "Evacuá y llamá al 911 desde afuera."] },
  bomba:      { label: "Amenaza de bomba",   icon: "💣", lines: ["No toques objetos sospechosos.", "Evacuá con calma siguiendo indicaciones del personal.", "Alejate al menos 100 metros del edificio."] },
  tormenta:   { label: "Tormenta severa",    icon: "⛈️", lines: ["Mantenete adentro, lejos de ventanas.", "Desenchufá equipos eléctricos sensibles.", "Seguí las indicaciones de Defensa Civil (103)."] },
  simulacro:  { label: "Simulacro",          icon: "🧪", lines: ["Esto es un simulacro: seguí el protocolo como si fuera una emergencia real.", "Respetá los tiempos y rutas marcadas.", "Reportá al referente cualquier inconveniente detectado."] },
  custom:     { label: "Mensaje personalizado", icon: "✏️", lines: ["Seguí las instrucciones del personal del establecimiento."] },
};

function cloneDefaultRecommendations() {
  const out = {};
  for (const key of Object.keys(DEFAULT_RECOMMENDATIONS)) {
    const src = DEFAULT_RECOMMENDATIONS[key];
    out[key] = { label: src.label, icon: src.icon, lines: src.lines.slice() };
  }
  return out;
}

let recommendations = cloneDefaultRecommendations();
try {
  const rawRecs = fs.readFileSync(RECS_FILE, "utf8");
  const parsedRecs = JSON.parse(rawRecs);
  if (parsedRecs && typeof parsedRecs === "object") {
    for (const key of Object.keys(parsedRecs)) {
      const src = parsedRecs[key];
      if (!src || typeof src !== "object") continue;
      const lines = Array.isArray(src.lines)
        ? src.lines.map((l) => (typeof l === "string" ? l.trim() : "")).filter((l) => l.length > 0)
        : recommendations[key] ? recommendations[key].lines : [];
      const base = recommendations[key] || {};
      recommendations[key] = {
        label: typeof src.label === "string" && src.label.trim() ? src.label.trim() : base.label || key,
        icon:  typeof src.icon === "string"  && src.icon.trim()  ? src.icon.trim()  : base.icon  || "",
        lines,
      };
    }
  }
} catch {
  try { fs.writeFileSync(RECS_FILE, JSON.stringify(recommendations, null, 2)); } catch {}
}

function saveRecommendations() {
  try { fs.writeFileSync(RECS_FILE, JSON.stringify(recommendations, null, 2)); }
  catch (err) { console.warn("[recs] no se pudo guardar:", err.message); }
}

function sanitizeRecLines(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.slice(0, 400));
    if (out.length >= 20) break;
  }
  return out;
}

function serializeRecommendations() {
  const out = {};
  for (const key of Object.keys(recommendations)) {
    const r = recommendations[key];
    out[key] = { label: r.label, icon: r.icon, lines: r.lines.slice() };
  }
  return out;
}

// ─────────────────────────────────────────────
// HISTORIAL
// ─────────────────────────────────────────────
const ALERTS_HISTORY_FILE = path.join(__dirname, "alerts-history.json");
const ALERTS_HISTORY_LIMIT = 50;
let alertsHistory = [];
try {
  const raw = fs.readFileSync(ALERTS_HISTORY_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) alertsHistory = parsed.slice(0, ALERTS_HISTORY_LIMIT);
} catch { alertsHistory = []; }

function saveAlertsHistory() {
  try { fs.writeFileSync(ALERTS_HISTORY_FILE, JSON.stringify(alertsHistory, null, 2)); }
  catch (err) { console.warn("[history] no se pudo guardar:", err.message); }
}
function broadcastAlertsHistory() { io.emit("alerts:history", { history: alertsHistory }); }
function pushAlertHistory(entry) {
  alertsHistory.unshift(entry);
  if (alertsHistory.length > ALERTS_HISTORY_LIMIT) alertsHistory.length = ALERTS_HISTORY_LIMIT;
  saveAlertsHistory();
  broadcastAlertsHistory();
}

// ─────────────────────────────────────────────
// CLIENTES / DISPOSITIVOS
// ─────────────────────────────────────────────
const clientsInfo = new Map();
const netinfoByClientId = new Map();
const NETINFO_TTL_MS = 90 * 1000;
const clientNameByClientId = new Map();
let nextClientNum = 1;

const KNOWN_DEVICES_FILE = path.join(__dirname, "known-devices.json");
const knownDevices = new Map();

function sanitizeSilentWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const enabled = !!raw.enabled;
  const from = typeof raw.from === "string" ? raw.from.slice(0, 5) : "";
  const to   = typeof raw.to   === "string" ? raw.to.slice(0, 5)   : "";
  const fromOk = /^\d{2}:\d{2}$/.test(from);
  const toOk   = /^\d{2}:\d{2}$/.test(to);
  let days = [];
  if (Array.isArray(raw.days)) {
    const seen = new Set();
    for (const d of raw.days) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) continue;
      if (seen.has(n)) continue;
      seen.add(n); days.push(n);
    }
    days.sort((a, b) => a - b);
  }
  return { enabled: enabled && fromOk && toOk && days.length > 0, from: fromOk ? from : "", to: toOk ? to : "", days };
}

try {
  const raw = fs.readFileSync(KNOWN_DEVICES_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.devices)) {
    for (const d of parsed.devices) {
      if (!d || typeof d.clientId !== "string" || !d.clientId) continue;
      knownDevices.set(d.clientId, {
        clientId: d.clientId,
        name: typeof d.name === "string" ? d.name : "",
        silentWindow: sanitizeSilentWindow(d.silentWindow) || { enabled: false, from: "", to: "", days: [] },
        lastSeen: typeof d.lastSeen === "number" ? d.lastSeen : 0,
        ip: typeof d.ip === "string" ? d.ip : "",
      });
      if (d.name) clientNameByClientId.set(d.clientId, d.name);
    }
  }
} catch { /* primera vez */ }

try {
  let maxN = 0;
  for (const name of clientNameByClientId.values()) {
    const m = /^Cliente (\d+)$/.exec(name || "");
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > maxN) maxN = n; }
  }
  if (maxN >= nextClientNum) nextClientNum = maxN + 1;
} catch { /* default 1 */ }

function saveKnownDevices() {
  try { fs.writeFileSync(KNOWN_DEVICES_FILE, JSON.stringify({ devices: Array.from(knownDevices.values()) }, null, 2)); }
  catch (err) { console.warn("[devices] no se pudo guardar:", err && err.message); }
}
function rememberDevice(info) {
  if (!info || !info.clientId) return;
  const prev = knownDevices.get(info.clientId) || {};
  knownDevices.set(info.clientId, {
    clientId: info.clientId,
    name: info.name || prev.name || "",
    silentWindow: sanitizeSilentWindow(info.silentWindow) || prev.silentWindow || { enabled: false, from: "", to: "", days: [] },
    lastSeen: Date.now(),
    ip: info.ip || prev.ip || "",
  });
  saveKnownDevices();
}
function forgetDevice(clientId) {
  if (!clientId) return false;
  const had = knownDevices.delete(clientId);
  clientNameByClientId.delete(clientId);
  if (had) saveKnownDevices();
  return had;
}
function shortenIp(ip) {
  if (!ip) return "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}
function sanitizeDeviceName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 60);
}
function sanitizeClientId(payload) {
  let id = null;
  if (payload && typeof payload === "object") id = payload.clientId || payload.id || null;
  else if (typeof payload === "string") id = payload;
  if (typeof id !== "string" || !id.trim()) return null;
  return id.trim().slice(0, 64);
}

const STATE_PRIORITY = { alerting: 4, paused: 3, silenced: 2, idle: 1 };

function serializeClients() {
  const byKey = new Map();
  const liveClientIds = new Set();
  const netByKey = new Map();
  for (const info of clientsInfo.values()) {
    const key = info.clientId || ("sock:" + info.id);
    if (info.clientId) liveClientIds.add(info.clientId);
    if (info.netinfo) {
      const cur = netByKey.get(key);
      if (!cur || (info.netinfo.at || 0) > (cur.at || 0)) netByKey.set(key, info.netinfo);
    }
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, info); continue; }
    const pPrev = STATE_PRIORITY[prev.state] || 0;
    const pCur  = STATE_PRIORITY[info.state]  || 0;
    if (pCur > pPrev) byKey.set(key, info);
    else if (pCur === pPrev && info.lastSeen > prev.lastSeen) byKey.set(key, info);
  }
  const out = [];
  const now = Date.now();
  for (const [key, info] of byKey.entries()) {
    let netinfo = netByKey.get(key) || null;
    if (!netinfo && info.clientId) {
      const cached = netinfoByClientId.get(info.clientId);
      if (cached && now - (cached.at || 0) < NETINFO_TTL_MS) netinfo = cached;
    }
    out.push({ id: info.id, clientId: info.clientId || null, name: info.name, state: info.state, silentWindow: info.silentWindow, lastSeen: info.lastSeen, ip: info.ip, netinfo });
  }
  for (const dev of knownDevices.values()) {
    if (liveClientIds.has(dev.clientId)) continue;
    out.push({ id: "offline:" + dev.clientId, clientId: dev.clientId, name: dev.name || "Cliente", state: "offline", silentWindow: dev.silentWindow || { enabled: false, from: "", to: "", days: [] }, lastSeen: dev.lastSeen || 0, ip: dev.ip || "" });
  }
  out.sort((a, b) => {
    if (a.state === "alerting" && b.state !== "alerting") return -1;
    if (b.state === "alerting" && a.state !== "alerting") return 1;
    if (a.state === "offline"  && b.state !== "offline")  return 1;
    if (b.state === "offline"  && a.state !== "offline")  return -1;
    return String(a.name).localeCompare(String(b.name));
  });
  return out;
}

function broadcastClients() {
  const payload = { clients: serializeClients() };
  for (const s of io.sockets.sockets.values()) {
    if (s.data && (s.data.role === "admin" || s.data.role === "operator")) s.emit("clients:list", payload);
  }
}

function setClientState(socketId, state) {
  const info = clientsInfo.get(socketId);
  if (!info || info.state === state) return;
  info.state = state;
  info.lastSeen = Date.now();
  broadcastClients();
}

// ─────────────────────────────────────────────
// VOICE TEXTS
// ─────────────────────────────────────────────
const VOICE_TEXTS_FILE = path.join(__dirname, "voice-texts.json");
let voiceTexts = {};
try {
  const raw = fs.readFileSync(VOICE_TEXTS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object") voiceTexts = parsed;
} catch { voiceTexts = {}; }

function saveVoiceTexts() {
  try { fs.writeFileSync(VOICE_TEXTS_FILE, JSON.stringify(voiceTexts, null, 2)); } catch {}
}

const DEFAULT_VOICE_TEXTS = {
  incendio:   "Atención. Alerta de incendio. Seguir instrucciones.",
  sismo:      "Alerta sísmica. Intensidad estimada moderado.",
  evacuacion: "Atención. Alerta de evacuación. Evacuar de inmediato.",
  intruso:    "Atención. Intruso detectado. Permanezcan en sus aulas y aseguren las puertas.",
  medica:     "Atención. Emergencia médica. Solicitar asistencia de inmediato.",
  gas:        "Atención. Fuga de gas. Evacuar el edificio.",
  bomba:      "Atención. Amenaza de bomba. Evacuar el edificio de inmediato.",
  tormenta:   "Atención. Tormenta severa. Permanezcan en interiores alejados de ventanas.",
};

// ─────────────────────────────────────────────
// ALERT STATE
// ─────────────────────────────────────────────
let alertTimer = null;
let currentAlert = null;

const ALERT_OVERRIDES = {
  simulacro: { sirenUrl: "/sounds/siren-simulacro.mp3", skipVoice: true },
};

let nextHistoryId = alertsHistory.reduce((max, h) => (h && typeof h.id === "number" && h.id > max ? h.id : max), 0) + 1;

function clearAlertTimer() {
  if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
}

function stopAlert(reason = "manual") {
  clearAlertTimer();
  if (currentAlert && currentAlert.historyId) {
    const idx = alertsHistory.findIndex((h) => h.id === currentAlert.historyId);
    if (idx !== -1) {
      alertsHistory[idx].endedAt = realNow();
      alertsHistory[idx].endedReason = reason;
      alertsHistory[idx].durationMs = alertsHistory[idx].endedAt - alertsHistory[idx].startedAt;
      saveAlertsHistory();
      broadcastAlertsHistory();
    }
  }
  currentAlert = null;
  io.emit("alert:stop", { reason, at: Date.now() });
  for (const info of clientsInfo.values()) {
    if (info.state === "alerting") {
      info.state = "idle";
      info.lastSeen = Date.now();
    }
  }
  io.emit("monitor:alertState", { active: false });
  broadcastClients();
}

function startAlert(payload) {
  clearAlertTimer();
  if (currentAlert && currentAlert.historyId) {
    const idx = alertsHistory.findIndex((h) => h.id === currentAlert.historyId);
    if (idx !== -1) {
      alertsHistory[idx].endedAt = realNow();
      alertsHistory[idx].endedReason = "replaced";
      alertsHistory[idx].durationMs = alertsHistory[idx].endedAt - alertsHistory[idx].startedAt;
      saveAlertsHistory();
    }
  }
  const now = realNow();
  const requestedDuration = payload.durationMs != null ? Number(payload.durationMs) : ALERT_DURATION_MS;
  const effectiveDuration = Math.min(ALERT_DURATION_MAX_MS, Math.max(ALERT_DURATION_MIN_MS, requestedDuration));
  const override = ALERT_OVERRIDES[payload.type] || {};
  const recForType = recommendations[payload.type] || null;

  const historyId = nextHistoryId++;
  currentAlert = {
    type: payload.type, label: payload.label,
    startedAt: now, endsAt: now + effectiveDuration, durationMs: effectiveDuration,
    sirenUrl: override.sirenUrl || null, skipVoice: !!override.skipVoice,
    historyId, triggeredBy: payload.triggeredBy || "system",
    recommendations: recForType && Array.isArray(recForType.lines) ? recForType.lines.slice() : [],
    voiceText: payload.type !== "simulacro" && payload.type !== "custom"
      ? (voiceTexts[payload.type] || DEFAULT_VOICE_TEXTS[payload.type] || "") : "",
  };

  io.emit("alert:start", currentAlert);

  setImmediate(() => {
    const dedupByDevice = new Map();
    for (const info of clientsInfo.values()) {
      const key = info.clientId || ("sock:" + info.id);
      const prev = dedupByDevice.get(key);
      if (!prev) { dedupByDevice.set(key, info); continue; }
      const pPrev = STATE_PRIORITY[prev.state] || 0;
      const pCur  = STATE_PRIORITY[info.state]  || 0;
      if (pCur > pPrev) dedupByDevice.set(key, info);
      else if (pCur === pPrev && info.lastSeen > prev.lastSeen) dedupByDevice.set(key, info);
    }
    let recipients = 0, silenced = 0, paused = 0;
    const deviceNames = [];
    for (const info of dedupByDevice.values()) {
      if (info.state === "paused") paused++;
      else if (info.state === "silenced") silenced++;
      else { recipients++; if (info.name) deviceNames.push(info.name); }
    }

    pushAlertHistory({
      id: historyId, type: currentAlert.type, label: currentAlert.label,
      startedAt: currentAlert.startedAt, endedAt: null, endedReason: null, durationMs: null,
      triggeredBy: currentAlert.triggeredBy, triggeredByName: payload.triggeredByName || null,
      recipients, silenced, paused, deviceNames, recommendations: currentAlert.recommendations,
    });
  });

  sendPushToAll({
    title: "🚨 ALERTA: " + (currentAlert.label || currentAlert.type),
    body: "Abrí SchoolAlerts para ver la alerta en pantalla completa.",
    type: currentAlert.type, startedAt: currentAlert.startedAt,
  }).catch((err) => { console.warn("[web-push] fallo al notificar:", err && err.message); });
  alertTimer = setTimeout(() => { stopAlert("timeout"); }, effectiveDuration);
  addMonitorLog("bad", `ALERTA ENVIADA: ${currentAlert.label}`);
  io.emit("monitor:alertState", { active: true, type: payload.type });
}

// ─────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────
const schedules = [];
let nextScheduleId = 1;
const BA_TZ = "America/Argentina/Buenos_Aires";

function nextFireAtBA(hour, minute, afterMs) {
  const base = afterMs || realNow();
  const now = new Date(base);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: BA_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = {};
  for (const p of fmt.formatToParts(now)) { if (p.type !== "literal") parts[p.type] = p.value; }
  let y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const nowBaMin = Number(parts.hour) * 60 + Number(parts.minute);
  const targetMin = hour * 60 + minute;
  if (targetMin <= nowBaMin) {
    const next = new Date(Date.UTC(y, m - 1, d));
    next.setUTCDate(next.getUTCDate() + 1);
    y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00-03:00`;
  return new Date(iso).getTime();
}

function broadcastSchedules() { io.emit("schedule:list", serializeSchedules()); }
function serializeSchedules() {
  return schedules.slice().sort((a, b) => a.fireAt - b.fireAt)
    .map((s) => ({ id: s.id, hour: s.hour, minute: s.minute, type: s.type, label: s.label, fireAt: s.fireAt, recurring: s.recurring }));
}
function addSchedule({ hour, minute, type, label, recurring }) {
  const entry = { id: nextScheduleId++, hour, minute, type, label, fireAt: nextFireAtBA(hour, minute), recurring: !!recurring };
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

setInterval(() => {
  const now = realNow();
  const due = schedules.filter((s) => s.fireAt <= now);
  if (due.length === 0) return;
  for (const s of due) {
    startAlert({ type: s.type, label: s.label, triggeredBy: "schedule" });
    if (s.recurring) s.fireAt = nextFireAtBA(s.hour, s.minute, now + 60 * 1000);
    else { const idx = schedules.indexOf(s); if (idx !== -1) schedules.splice(idx, 1); }
  }
  broadcastSchedules();
}, 1000);

// ─────────────────────────────────────────────
// NTP / RELOJ
// ─────────────────────────────────────────────
let timeOffsetMs = 0;
async function fetchWithTimeout(url, ms, method = "GET") {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { method, signal: controller.signal }); }
  finally { clearTimeout(id); }
}
async function sampleSource(src) {
  const t0 = Date.now(); const ext = await src(); const t1 = Date.now();
  return { offset: ext - (t0 + (t1 - t0) / 2), latency: (t1 - t0) / 2 };
}
const TIME_SOURCES = [
  async () => { const r = await fetchWithTimeout("https://worldtimeapi.org/api/timezone/America/Argentina/Buenos_Aires", 4000); if (!r.ok) throw new Error("worldtimeapi " + r.status); const j = await r.json(); return new Date(j.datetime).getTime(); },
  async () => { const r = await fetchWithTimeout("https://www.google.com", 4000, "HEAD"); const h = r.headers.get("date"); if (!h) throw new Error("google no date"); return new Date(h).getTime(); },
];
async function syncClock() {
  for (const src of TIME_SOURCES) {
    try {
      const samples = [];
      for (let i = 0; i < 5; i++) { try { samples.push(await sampleSource(src)); } catch {} }
      if (samples.length === 0) throw new Error("sin muestras");
      samples.sort((a, b) => a.latency - b.latency);
      timeOffsetMs = Math.round(samples[0].offset);
      console.log(`[time-sync] offset = ${timeOffsetMs}ms`);
      return;
    } catch (err) { console.warn("[time-sync] fuente fallida:", err.message); }
  }
  console.warn("[time-sync] ninguna fuente respondió, uso reloj local");
}
function realNow() { return Date.now() + timeOffsetMs; }
syncClock();
setInterval(syncClock, 15 * 60 * 1000);

// ─────────────────────────────────────────────
// WEB PUSH
// ─────────────────────────────────────────────
const VAPID_FILE = path.join(__dirname, "vapid-keys.json");
let vapidKeys;
try { vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); }
catch {
  vapidKeys = webpush.generateVAPIDKeys();
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2)); console.log("[web-push] claves VAPID generadas."); }
  catch (err) { console.warn("[web-push] no se pudo guardar vapid-keys.json:", err.message); }
}
webpush.setVapidDetails(process.env.VAPID_CONTACT || "mailto:schoolalerts@example.com", vapidKeys.publicKey, vapidKeys.privateKey);

const SUBS_FILE = path.join(__dirname, "push-subs.json");
let pushSubs = [];
try { const raw = fs.readFileSync(SUBS_FILE, "utf8"); const parsed = JSON.parse(raw); if (Array.isArray(parsed)) pushSubs = parsed; } catch { pushSubs = []; }
function savePushSubs() { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubs, null, 2)); } catch (err) { console.warn("[web-push] no se pudo guardar:", err.message); } }

async function sendPushToAll(payload) {
  if (pushSubs.length === 0) return;
  const body = JSON.stringify(payload);
  const dead = [];
  const now = Date.now();
  await Promise.all(pushSubs.map(async (sub) => {
    if (sub.pausedUntil && sub.pausedUntil > now) return;
    try { await webpush.sendNotification(sub, body); }
    catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(sub.endpoint);
      else { const code = err && err.statusCode ? err.statusCode : "?"; console.warn(`[web-push] error ${code}:`, err && err.message); }
    }
  }));
  if (dead.length > 0) { pushSubs = pushSubs.filter((s) => !dead.includes(s.endpoint)); savePushSubs(); }
}

// ─────────────────────────────────────────────
// TTS PROXY
// ─────────────────────────────────────────────
const ttsCache = new Map();

// ─────────────────────────────────────────────
// MONITOR STATS
// ─────────────────────────────────────────────
setInterval(() => {
  let totalPing = 0, pingCount = 0;
  for (const client of clientsInfo.values()) { if (typeof client.rttMs === "number") { totalPing += client.rttMs; pingCount++; } }
  io.emit("monitor:stats", { clients: clientsInfo.size, avgPing: pingCount > 0 ? Math.round(totalPing / pingCount) : 0 });
}, 2000);

setInterval(() => {
  const mem = process.memoryUsage();
  addMonitorLog(mem.heapUsed > 250000000 ? "warn" : "good", `RAM Node: ${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
}, 30000);

// ─────────────────────────────────────────────
// RUTAS HTTP
// ─────────────────────────────────────────────

app.use((req, res, next) => { addMonitorLog("good", `${req.method} ${req.url}`); next(); });

app.post('/api/cmd-alert', (req, res) => {
  const data = req.body;
  console.log("Servidor: Recibí comando API, emitiendo...", data);
  io.emit("alert:start", data);
  res.status(200).send("Alerta disparada");
});

app.post("/host-login", (req, res) => {
  const pwd = req.body && typeof req.body.password === "string" ? req.body.password : "";
  let role = null;
  if (pwd && pwd === hostPasswords.admin) role = "admin";
  else if (pwd && pwd === hostPasswords.operator) role = "operator";
  if (!role) { res.status(401).json({ error: "Contraseña incorrecta" }); return; }
  const token = makeToken();
  hostSessions.set(token, { role, createdAt: Date.now() });
  const maxAgeSec = Math.floor(HOST_SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `hostToken=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${maxAgeSec}; SameSite=Lax`);
  res.json({ ok: true, role });
});

app.post("/host-logout", (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.hostToken) hostSessions.delete(cookies.hostToken);
  res.setHeader("Set-Cookie", "hostToken=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
  res.json({ ok: true });
});

app.post("/host/change-password", (req, res) => {
  const cookies = parseCookies(req);
  const sess = getSessionByToken(cookies.hostToken);
  if (!sess) { res.status(401).json({ error: "no hay sesión" }); return; }
  const body = req.body || {};
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (!current || !next) { res.status(400).json({ error: "Faltan la contraseña actual o la nueva." }); return; }
  if (next.length < 6) { res.status(400).json({ error: "La nueva contraseña tiene que tener al menos 6 caracteres." }); return; }
  if (next.length > 120) { res.status(400).json({ error: "La nueva contraseña es demasiado larga." }); return; }
  const expected = hostPasswords[sess.role];
  if (!expected || current !== expected) { res.status(401).json({ error: "La contraseña actual no es correcta." }); return; }
  if (current === next) { res.status(400).json({ error: "La nueva contraseña tiene que ser distinta a la actual." }); return; }
  const previous = hostPasswords[sess.role];
  hostPasswords[sess.role] = next;
  try { fs.writeFileSync(HOST_PASSWORDS_FILE, JSON.stringify(hostPasswords, null, 2)); }
  catch (err) { hostPasswords[sess.role] = previous; res.status(500).json({ error: "No se pudo guardar la nueva contraseña." }); return; }
  for (const [token, s] of hostSessions.entries()) { if (s.role === sess.role && token !== cookies.hostToken) hostSessions.delete(token); }
  res.json({ ok: true });
});

app.get("/host-login", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "host-login.html"));
});

app.get("/host.html", (_req, res) => { res.redirect("/host"); });

app.get("/host", (req, res) => {
  const cookies = parseCookies(req);
  const sess = getSessionByToken(cookies.hostToken);
  if (!sess) { res.redirect("/host-login"); return; }
  let html;
  try { html = fs.readFileSync(path.join(__dirname, "public", "host.html"), "utf8"); }
  catch { res.status(500).send("No se pudo leer host.html"); return; }
  const metaTags = `<meta name="host-role" content="${sess.role}" />\n    <meta name="host-token" content="${cookies.hostToken}" />`;
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html.replace("</head>", `    ${metaTags}\n  </head>`));
});

app.get("/client", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "client.html"));
});
app.get("/client.html", (_req, res) => { res.redirect("/client"); });

app.get("/radio", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "radio.html"));
});

app.get("/monitor", (_req, res) => {
  res.sendFile(path.join(__dirname, "monitor.html"));
});

app.get("/", (_req, res) => { res.redirect("/client"); });

app.get("/time", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ now: realNow() }); });
app.get("/recommendations", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ recommendations: serializeRecommendations() }); });
app.get("/alerts-history", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ history: alertsHistory }); });
app.get("/vapid-public-key", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ publicKey: vapidKeys.publicKey }); });
app.get("/voice-texts", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ voiceTexts, defaults: DEFAULT_VOICE_TEXTS }); });

app.post("/voice-texts", (req, res) => {
  const cookies = parseCookies(req);
  const sess = getSessionByToken(cookies.hostToken);
  if (!sess) { res.status(403).json({ error: "Sin sesión activa" }); return; }
  const { type, text } = req.body || {};
  if (!type || typeof type !== "string") return res.status(400).json({ error: "type requerido" });
  if (type === "simulacro" || type === "custom") return res.status(400).json({ error: "No se puede editar simulacro ni custom" });
  if (text === null || text === undefined || String(text).trim() === "") delete voiceTexts[type];
  else voiceTexts[type] = String(text).trim().slice(0, 400);
  saveVoiceTexts();
  io.emit("voice-texts:update", { voiceTexts, defaults: DEFAULT_VOICE_TEXTS });
  res.json({ ok: true, voiceTexts });
});

app.post("/recommendations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim().slice(0, 40) : null;
  const lines = sanitizeRecLines(body.lines);
  if (!type || lines == null) { res.status(400).json({ error: "type y lines son requeridos" }); return; }
  const base = recommendations[type] || DEFAULT_RECOMMENDATIONS[type] || {};
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : base.label || type;
  const icon  = typeof body.icon  === "string" && body.icon.trim()  ? body.icon.trim().slice(0, 8)   : base.icon  || "";
  recommendations[type] = { label, icon, lines };
  saveRecommendations();
  io.emit("recommendations:update", { recommendations: serializeRecommendations() });
  res.json({ ok: true, recommendations: serializeRecommendations() });
});

app.post("/recommendations/reset", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const type = typeof req.body.type === "string" ? req.body.type.trim() : "";
  if (type) {
    if (DEFAULT_RECOMMENDATIONS[type]) { const d = DEFAULT_RECOMMENDATIONS[type]; recommendations[type] = { label: d.label, icon: d.icon, lines: d.lines.slice() }; }
    else delete recommendations[type];
  } else { recommendations = cloneDefaultRecommendations(); }
  saveRecommendations();
  io.emit("recommendations:update", { recommendations: serializeRecommendations() });
  res.json({ ok: true, recommendations: serializeRecommendations() });
});

app.post("/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys) { res.status(400).json({ error: "missing subscription" }); return; }
  if (pushSubs.findIndex((s) => s.endpoint === sub.endpoint) === -1) { pushSubs.push(sub); savePushSubs(); }
  res.json({ ok: true });
});
app.post("/push/unsubscribe", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) { res.status(400).json({ error: "missing endpoint" }); return; }
  const before = pushSubs.length;
  pushSubs = pushSubs.filter((s) => s.endpoint !== endpoint);
  if (pushSubs.length !== before) savePushSubs();
  res.json({ ok: true });
});
app.post("/push/pause", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  const pausedUntil = req.body && Number(req.body.pausedUntil);
  if (!endpoint) { res.status(400).json({ error: "missing endpoint" }); return; }
  const sub = pushSubs.find((s) => s.endpoint === endpoint);
  if (!sub) { res.status(404).json({ error: "endpoint not found" }); return; }
  sub.pausedUntil = Number.isFinite(pausedUntil) ? pausedUntil : 0;
  savePushSubs();
  res.json({ ok: true, pausedUntil: sub.pausedUntil });
});

app.get("/tts", async (req, res) => {
  const text = (req.query.text || "").toString().trim().slice(0, 500);
  if (!text) { res.status(400).send("missing text"); return; }
  try {
    let mp3 = ttsCache.get(text);
    if (!mp3) {
      const chunks = await googleTTS.getAllAudioBase64(text, { lang: "es", slow: false, host: "https://translate.google.com", splitPunct: ",.?!;" });
      mp3 = Buffer.concat(chunks.map((c) => Buffer.from(c.base64, "base64")));
      if (ttsCache.size > 50) ttsCache.clear();
      ttsCache.set(text, mp3);
    }
    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", String(mp3.length));
    res.set("Cache-Control", "public, max-age=86400");
    res.send(mp3);
  } catch (err) { console.error("TTS error:", err.message); res.status(502).send("tts error"); }
});

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => { if (/\.(html|js|json|css)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate"); },
  index: false,
}));

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
const clientSockets = new Set();
function broadcastClientCount() { io.emit("clients:count", { count: clientSockets.size }); }

// ── NUEVO: debounce push de conexión débil/caída ──────────────────────────
const connWarnPushSentAt = new Map(); // clientId → timestamp último push
const CONN_WARN_PUSH_COOLDOWN_MS = 5 * 60 * 1000; // 5 min entre pushes del mismo dispositivo
// ─────────────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake && socket.handshake.auth && typeof socket.handshake.auth.token === "string" ? socket.handshake.auth.token : null;
  socket.data.role = getSessionByToken(token) ? getSessionByToken(token).role : null;
  next();
});

function isHost(socket) { return socket.data.role === "admin" || socket.data.role === "operator"; }

function dropStaleEntriesForClientId(clientId, currentSocketId) {
  for (const [sid, info] of clientsInfo) { if (info.clientId === clientId && sid !== currentSocketId) clientsInfo.delete(sid); }
}

io.on("connection", (socket) => {
  if (currentAlert) socket.emit("alert:start", currentAlert);
  addMonitorLog("good", `Socket conectado ${socket.id}`);

  function syncHost() {
    if (currentAlert) socket.emit("alert:start", currentAlert);
    socket.emit("clients:list", { clients: serializeClients() });
    socket.emit("clients:count", { count: clientSockets.size });
    socket.emit("alerts:history", { history: alertsHistory });
    socket.emit("schedule:list", serializeSchedules());
  }
  socket.on("host:register", syncHost);
  socket.on("role:host", syncHost);

  socket.on("monitor:join", () => {
    socket.join("monitor");
    if (currentAlert) socket.emit("alert:start", currentAlert);
    socket.emit("clients:list", { clients: serializeClients() });
    socket.emit("clients:count", { count: clientSockets.size });
  });

  socket.on("client:identify", (payload) => {
    const clientId = sanitizeClientId(payload);
    if (!clientId) return;
    dropStaleEntriesForClientId(clientId, socket.id);
    if (!clientsInfo.has(socket.id)) {
      const autoName = clientNameByClientId.get(clientId) || ("Cliente " + nextClientNum++);
      clientsInfo.set(socket.id, { id: socket.id, clientId, name: autoName, state: "idle", silentWindow: { enabled: false, from: "", to: "", days: [] }, lastSeen: Date.now(), ip: shortenIp(socket.handshake.address || ""), rttMs: 0 });
    }
    const info = clientsInfo.get(socket.id);
    if (!info) return;
    if (clientId && info.clientId !== clientId) {
      info.clientId = clientId;
      if (clientNameByClientId.has(clientId)) info.name = clientNameByClientId.get(clientId);
      else clientNameByClientId.set(clientId, info.name);
    }
    if (payload && typeof payload === "object") {
      const name = sanitizeDeviceName(payload.name);
      const sw = sanitizeSilentWindow(payload.silentWindow);
      if (info.clientId) {
        for (const other of clientsInfo.values()) {
          if (other.clientId !== info.clientId) continue;
          if (name) other.name = name;
          if (sw) other.silentWindow = sw;
          other.lastSeen = Date.now();
        }
        if (name) clientNameByClientId.set(info.clientId, name);
      } else {
        if (name) info.name = name;
        if (sw) info.silentWindow = sw;
      }
    }
    info.lastSeen = Date.now();
    rememberDevice(info);
    broadcastClients();
  });

  socket.on("client:ping", (payload) => {
    const t0 = payload && typeof payload.t0 === "number" ? payload.t0 : 0;
    try { socket.emit("client:pong", { t0, t1: realNow() }); } catch {}
  });

  socket.on("client:netinfo", (data = {}) => {
    const client = clientsInfo.get(socket.id);
    if (!client) return;
    client.rttMs = data.rttMs || 0;
    if (!client.netinfo) client.netinfo = { effectiveType: "WiFi/Ethernet" };
    client.netinfo.rttMs = client.rttMs;
    client.netinfo.at = Date.now();
    if (client.clientId) netinfoByClientId.set(client.clientId, client.netinfo);
    broadcastClients();
    if (client.rttMs > 3500) {
      addMonitorLog("bad", `MALA CONEXIÓN ${client.clientId || socket.id} (${client.rttMs}ms)`);
      // ── NUEVO: push iOS cuando RTT es crítico ──────────────────────────
      if (client.clientId) {
        const last = connWarnPushSentAt.get(client.clientId) || 0;
        if (Date.now() - last > CONN_WARN_PUSH_COOLDOWN_MS) {
          connWarnPushSentAt.set(client.clientId, Date.now());
          sendPushToAll({
            title: "⚠️ Señal muy débil — " + (client.name || client.clientId),
            body: "Este dispositivo tiene señal crítica (" + client.rttMs + "ms). Las alertas podrían no llegar.",
            tag: "conn-warn-" + client.clientId,
          }).catch(() => {});
        }
      }
      // ───────────────────────────────────────────────────────────────────
    } else if (client.rttMs > 1200) {
      addMonitorLog("warn", `Conexión lenta ${client.clientId || socket.id} (${client.rttMs}ms)`);
    }
    io.to("monitor").emit("client:netinfo", { rttMs: client.rttMs, effectiveType: client.netinfo && client.netinfo.effectiveType, clientId: client.clientId, name: client.name, id: socket.id });
  });

  socket.on("client:report", (data) => {
    const client = clientsInfo.get(socket.id);
    if (!client) return;
    if (!client.netinfo) client.netinfo = { rttMs: client.rttMs || 0, at: Date.now() };
    client.netinfo.effectiveType = data.netType;
    client.netinfo.at = Date.now();
    if (client.clientId) netinfoByClientId.set(client.clientId, client.netinfo);
    broadcastClients();
  });

  socket.on("client:state", (payload) => {
    if (!payload || typeof payload.state !== "string") return;
    const allowed = ["idle", "alerting", "silenced", "paused"];
    if (!allowed.includes(payload.state)) return;
    setClientState(socket.id, payload.state);
  });

  socket.on("disconnect", () => {
    if (clientSockets.delete(socket.id)) broadcastClientCount();
    const info = clientsInfo.get(socket.id);
    if (info) {
      rememberDevice(info);
      clientsInfo.delete(socket.id);
      broadcastClients();
      // ── NUEVO: push iOS cuando el dispositivo cliente se desconecta ────
      if (info.clientId && !isHost(socket)) {
        const last = connWarnPushSentAt.get(info.clientId) || 0;
        if (Date.now() - last > CONN_WARN_PUSH_COOLDOWN_MS) {
          connWarnPushSentAt.set(info.clientId, Date.now());
          sendPushToAll({
            title: "📵 Sin conexión — " + (info.name || info.clientId),
            body: "Este dispositivo se desconectó del servidor y no recibirá alertas.",
            tag: "conn-warn-" + info.clientId,
          }).catch(() => {});
        }
      }
      // ───────────────────────────────────────────────────────────────────
    }
    addMonitorLog("warn", `Socket desconectado ${socket.id}`);
  });

  socket.on("alert:trigger", (payload) => {
    if (!isHost(socket)) return;
    if (!payload || typeof payload.type !== "string") return;
    if (socket.data.role === "operator" && payload.type === "custom") return;
    const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim() : payload.type;
    startAlert({ type: payload.type, label, durationMs: payload.durationMs, triggeredBy: socket.data.role || "host", triggeredByName: payload.triggeredByName || null });
  });

  socket.on("alert:stop", () => { if (!isHost(socket)) return; stopAlert("manual"); });

  socket.on("host:alert", (payload) => {
    if (socket.data.role !== "admin") return;
    startAlert({ type: payload.type, label: payload.label, triggeredBy: "host" });
  });

  socket.on("clients:rename", (payload) => {
    if (!isHost(socket)) return;
    if (!payload || typeof payload !== "object") return;
    const id = typeof payload.id === "string" ? payload.id : "";
    const name = sanitizeDeviceName(payload.name);
    if (!id || !name) return;
    if (id.startsWith("offline:")) {
      const clientId = id.slice("offline:".length);
      const dev = knownDevices.get(clientId);
      if (!dev) return;
      dev.name = name; dev.lastSeen = Date.now();
      knownDevices.set(clientId, dev); clientNameByClientId.set(clientId, name);
      saveKnownDevices(); broadcastClients(); return;
    }
    const info = clientsInfo.get(id);
    if (!info) return;
    const targets = [];
    if (info.clientId) {
      for (const [sid, other] of clientsInfo) { if (other.clientId === info.clientId) { other.name = name; other.lastSeen = Date.now(); targets.push(sid); } }
      clientNameByClientId.set(info.clientId, name);
    } else { info.name = name; info.lastSeen = Date.now(); targets.push(id); }
    rememberDevice(info); broadcastClients();
    for (const sid of targets) io.to(sid).emit("client:renamed", { name });
  });

  socket.on("clients:remove", (payload) => {
    if (!isHost(socket)) return;
    if (!payload || typeof payload !== "object") return;
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) return;
    let clientIdToForget = null;
    if (id.startsWith("offline:")) { clientIdToForget = id.slice("offline:".length); }
    else {
      const info = clientsInfo.get(id);
      if (info) {
        clientIdToForget = info.clientId || null;
        if (clientIdToForget) { for (const [sid, other] of clientsInfo) { if (other.clientId === clientIdToForget) { const sock = io.sockets.sockets.get(sid); if (sock) sock.disconnect(true); } } }
        else { const sock = io.sockets.sockets.get(id); if (sock) sock.disconnect(true); }
      }
    }
    if (clientIdToForget) forgetDevice(clientIdToForget);
    broadcastClients();
  });

  socket.on("schedule:add", (payload) => {
    if (socket.data.role !== "admin") return;
    if (!payload || typeof payload.type !== "string") return;
    const hour = Number(payload.hour); const minute = Number(payload.minute);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return;
    const rawLabel = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim().slice(0, 200) : payload.type;
    addSchedule({ hour, minute, type: payload.type, label: rawLabel, recurring: !!payload.recurring });
  });

  socket.on("schedule:remove", (payload) => {
    if (socket.data.role !== "admin") return;
    const id = payload && Number(payload.id);
    if (!Number.isInteger(id)) return;
    removeSchedule(id);
  });
});

// ─────────────────────────────────────────────
// ARRANQUE — UN SOLO server.listen
// ─────────────────────────────────────────────
function getLanAddresses() {
  const nets = os.networkInterfaces(); const result = [];
  for (const name of Object.keys(nets)) { for (const net of nets[name] || []) { if (net.family === "IPv4" && !net.internal) result.push(net.address); } }
  return result;
}

process.on("uncaughtException",   (err) => { addMonitorLog("bad", "CRASH: " + err.message); console.error(err); });
process.on("unhandledRejection",  (err) => { addMonitorLog("bad", "PROMISE ERROR: " + err); });

server.listen(PORT, "0.0.0.0", () => {
  const lan = getLanAddresses();
  console.log(`\n✅ SchoolAlerts corriendo en el puerto ${PORT}`);
  console.log(`   Local:  http://localhost:${PORT}/`);
  for (const ip of lan) console.log(`   LAN:    http://${ip}:${PORT}/`);
  console.log("\n   Rutas disponibles:");
  console.log("   /          → cliente (redirect)");
  console.log("   /client    → pantalla cliente");
  console.log("   /host      → panel de alertas");
  console.log("   /radio     → receptor Midland (radio monitor)");
  console.log("   /monitor   → monitor técnico");
});
