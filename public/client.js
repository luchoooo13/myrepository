// Archivo: client.js
(function () {
  const socket = io();
  socket.io.opts.reconnection = true;
    socket.io.opts.reconnectionAttempts = Infinity;
    socket.io.opts.reconnectionDelay = 1000;
    socket.onAny((event, ...args) => {
  console.log("¡LOG DE RED: Evento capturado!", event, args);
});

  // ── alert:start / alert:stop — registrados al tope para no perder
  // el evento que el server emite en io.on("connection") antes de que
  // el código de abajo termine de registrar sus propios listeners.
  socket.on("alert:start", (alert) => {
    if (isPaused()) { if (!alert.__test) addLocalHistoryEntry(alert); return; }
    if (!alert.__test && isInSilentWindow()) { reportClientState("silenced"); addLocalHistoryEntry(alert); return; }
    showAlert(alert);
  });
  socket.on("alert:stop", () => {
    dismissedStartedAt = 0;
    hideAlert();
  });

  const IS_APK =
    typeof window !== "undefined" &&
      typeof window.AlertBridge !== "undefined"
    || /SchoolAlertsAPK|AlertaClienteAPK/i.test(navigator.userAgent || "");

  // --- DOM -------------------------------------------------------------
  const app = document.getElementById("app");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const connStatusText = document.getElementById("connStatusText");
  const audioStatusText = document.getElementById("audioStatusText");
  const lastAlertText = document.getElementById("lastAlertText");
  const enableBtn = document.getElementById("enableBtn");
  const enableCard = document.getElementById("enableCard");
  const connChip = document.getElementById("connChip");
  const connChipText = document.getElementById("connChipText");

  const overlay = document.getElementById("alertOverlay");
  const alertTypeEl = document.getElementById("alertType");
  const alertTimeEl = document.getElementById("alertTime");
  const alertCloseBtn = document.getElementById("alertCloseBtn");
  const alertUnlockHint = document.getElementById("alertUnlockHint");
  const alertRecsEl = document.getElementById("alertRecs");
  const alertRecsListEl = document.getElementById("alertRecsList");
  const infoRecsListEl = document.getElementById("infoRecsList");
const alertBody = document.getElementById("alertBody");
  const historyListEl = document.getElementById("historyList");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const deviceNameInput = document.getElementById("deviceNameInput");
  const deviceNameSaveBtn = document.getElementById("deviceNameSaveBtn");
  const deviceNameStatus = document.getElementById("deviceNameStatus");
  const silentEnabled = document.getElementById("silentEnabled");
  const silentFields = document.getElementById("silentFields");
  const silentFromEl = document.getElementById("silentFrom");
  const silentToEl = document.getElementById("silentTo");
  const silentDaysEl = document.getElementById("silentDays");
  const silentSummary = document.getElementById("silentSummary");
  const silentStatus = document.getElementById("silentStatus");
  const pushCard = document.getElementById("pushCard");
  const pushEnableBtn = document.getElementById("pushEnableBtn");
  const pushHelp = document.getElementById("pushHelp");
  const pushStatus = document.getElementById("pushStatus");
  const pauseSelect = document.getElementById("pauseSelect");
  const pauseStatus = document.getElementById("pauseStatus");
  const setVibration = document.getElementById("setVibration");
  const setStrobe = document.getElementById("setStrobe");
  const setVoice = document.getElementById("setVoice");
  const setSirenVolume = document.getElementById("setSirenVolume");
  const sirenVolumeLabel = document.getElementById("sirenVolumeLabel");
  const setVoiceVolume = document.getElementById("setVoiceVolume");
  const voiceVolumeLabel = document.getElementById("voiceVolumeLabel");
  const tonePicker = document.getElementById("tonePicker");
  const testAlertBtn = document.getElementById("testAlertBtn");
  const resetDataBtn = document.getElementById("resetDataBtn");
  const setConnNotif = document.getElementById("setConnNotif");

  // --- NUEVO: DOM Notificaciones ---
  const notifListEl = document.getElementById("notifList");
  const notifBadgeEl = document.getElementById("notifBadge");
  const clearNotifsBtn = document.getElementById("clearNotifsBtn");

  // --- Estado ----------------------------------------------------------
  let sirenAudio = null;
  let voiceAudio = null;
  let currentAlert = null;
  let currentAlertIsTest = false;
  let tickTimer = null;
  let voiceTimer = null;
  let vibrationTimer = null;
  let enabled = false;
  let dismissedStartedAt = 0;
  let currentVoiceObjectUrl = null;
  let clientRecsState = {};

  const SIREN_SRC = "/sounds/siren.mp3";
  const SIREN_TONES = {
    default: "/sounds/siren.mp3",
    eas:     "/sounds/eas.mp3",
  };
  const VOICE_BASE = "/sounds/voice/";
  const VOICE_REPEAT_MS = 5000;
  const HISTORY_KEY = "alertas.history.v1"; 
  const SETTINGS_KEY = "alertas.settings.v1";
  const DEVICE_KEY = "alertas.device.v1";
  const SILENT_KEY = "alertas.silent.v1";
  const CLIENT_ID_KEY = "alertas.clientid.v1";
  const NOTIFS_KEY = "alertas.notifs.v1";
  let unreadNotifs = 0;
  
  function getOrCreateClientId() {
    try {
      const existing = localStorage.getItem(CLIENT_ID_KEY);
      if (existing && typeof existing === "string" && existing.length > 0) return existing.slice(0, 64);
    } catch { }
    let id = "";
    try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") id = crypto.randomUUID(); } catch { }
    if (!id) id = "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(CLIENT_ID_KEY, id); } catch { }
    return id;
  }
  const CLIENT_ID = getOrCreateClientId();
  const HISTORY_MAX = 50;

  function sirenVolumeMultiplier(type) {
    if (type === "intruso") return 0;
    if (type === "simulacro") return 1;
    return 1;
  }
  function voiceVolumeMultiplier(type) {
    if (type === "intruso") return 0.45;
    return 1;
  }

  // --- PUENTE SEGURO ---
  window.bridgeReady = false;

  function safeCall(methodName, param1 = "", param2 = "") {
      if (window.AndroidInterface && typeof window.AndroidInterface[methodName] === 'function') {
          window.AndroidInterface[methodName](param1, param2);
      } else {
          setTimeout(() => safeCall(methodName, param1, param2), 500);
      }
  }

  // --- Lógica Notificaciones (Mensajería) ------------------------------
  function loadNotifs() {
    try {
      const raw = localStorage.getItem(NOTIFS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveNotifs(list) {
    try { localStorage.setItem(NOTIFS_KEY, JSON.stringify(list.slice(0, 50))); } catch {}
  }

  function addNotif(type, label, text) {
    const list = loadNotifs();
    list.unshift({ type, label, text, time: Date.now() });
    saveNotifs(list);
    unreadNotifs++;
    renderNotifs();
    updateNotifBadge();
  }
   
  // En lugar de poner esto suelto al final del archivo:
// const overlay = document.getElementById("alertOverlay"); 
// --- RECONEXIÓN AGRESIVA PARA iOS (iPhone) ---
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Si volvemos a la app y el socket está desconectado, forzamos conexión
      if (socket && socket.disconnected) {
        socket.connect();
      } else if (socket && socket.connected) {
        // Si parece conectado, enviamos un ping para asegurar que la conexión no esté "zombie"
        sendNetPing();
      }
    }
  });

// Ponelo dentro de una función de inicialización o usalo solo cuando sea necesario:
function mostrarMensajeOverlay(text) {
    const overlay = document.getElementById("alertOverlay");
    const alertBody = document.getElementById("alertBody");
    
    if (overlay && alertBody) {
        alertBody.textContent = text;
        overlay.hidden = false;
    } else {
        console.error("No se encontró el overlay en el HTML. Revisá index.html");
    }
}

  function renderNotifs() {
    if (!notifListEl) return;
    const list = loadNotifs();
    if (list.length === 0) {
      notifListEl.innerHTML = '<div style="text-align:center; padding:3rem; color:var(--md-on-surface-muted);">No hay notificaciones.</div>';
      return;
    }
    notifListEl.innerHTML = "";
    
    // Mostramos el mensaje más reciente primero
    for (const n of list) {
      const isMsg = n.type === "message";
      
      const el = document.createElement("div");
      // ESTILOS MEJORADOS PARA EL CARTEL
      el.style.cssText = `
        background: #ffffff;
        border-left: 6px solid #4a90e2;
        border-radius: 8px;
        padding: 1.5rem;
        margin-bottom: 1rem;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        animation: popIn 0.3s ease-out;
      `;

      el.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; color: #4a90e2; font-weight: bold;">
          <span class="material-symbols-outlined">campaign</span>
          <span>${escapeHtml(n.label)}</span>
        </div>
        <div style="font-size: 1.1rem; color: #333; font-weight: 500;">
          ${escapeHtml(n.text)}
        </div>
        <div style="font-size: 0.75rem; color: #888; align-self: flex-end;">
          ${formatDateTime(n.time)}
        </div>
      `;
      notifListEl.appendChild(el);
    }
  }

  function updateNotifBadge() {
    if (!notifBadgeEl) return;
    const activeTab = document.querySelector('.tabs__btn.is-active');
    if (activeTab && activeTab.getAttribute('data-tab-target') === 'notifications') {
      unreadNotifs = 0;
    }

    if (unreadNotifs > 0) {
      notifBadgeEl.textContent = unreadNotifs > 9 ? "9+" : unreadNotifs;
      notifBadgeEl.hidden = false;
      // Forzamos estilos inline para asegurar que se vea el globito rojo
      notifBadgeEl.style.position = "absolute";
      notifBadgeEl.style.top = "0.3rem";
      notifBadgeEl.style.right = "0.5rem";
      notifBadgeEl.style.background = "#f27a7a";
      notifBadgeEl.style.color = "#fff";
      notifBadgeEl.style.fontSize = "0.6rem";
      notifBadgeEl.style.fontWeight = "700";
      notifBadgeEl.style.padding = "0.08rem 0.35rem";
      notifBadgeEl.style.borderRadius = "999px";
      notifBadgeEl.style.minWidth = "1rem";
      notifBadgeEl.style.textAlign = "center";
    } else {
      notifBadgeEl.hidden = true;
    }
  }

  if (clearNotifsBtn) {
    clearNotifsBtn.addEventListener("click", () => {
      if (!confirm("¿Borrar todas las notificaciones locales?")) return;
      localStorage.removeItem(NOTIFS_KEY);
      unreadNotifs = 0;
      renderNotifs();
      updateNotifBadge();
    });
  }

  // --- Settings --------------------------------------------------------
  const defaultSettings = {
    vibration: true, strobe: true, voice: true, sirenTone: "default",
    sirenVolume: 600, voiceVolume: 100, pausedUntil: 0, connNotif: true,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...defaultSettings };
      const parsed = JSON.parse(raw);
      const merged = { ...defaultSettings, ...parsed };
      if (typeof parsed.volume === "number" && parsed.sirenVolume == null && parsed.voiceVolume == null) {
        merged.sirenVolume = parsed.volume; merged.voiceVolume = parsed.volume;
      }
      return merged;
    } catch { return { ...defaultSettings }; }
  }

  function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { } }

  let settings = loadSettings();

  function applySettingsToUI() {
    setVibration.checked = !!settings.vibration;
    setStrobe.checked = !!settings.strobe;
    setVoice.checked = !!settings.voice;
    setSirenVolume.value = String(settings.sirenVolume);
    sirenVolumeLabel.textContent = Math.round(settings.sirenVolume) + " %";
    setVoiceVolume.value = String(settings.voiceVolume);
    voiceVolumeLabel.textContent = Math.round(settings.voiceVolume) + " %";
    if (setConnNotif) setConnNotif.checked = settings.connNotif !== false;
    if (tonePicker) {
      const radio = tonePicker.querySelector('input[name="sirenTone"][value="' + (settings.sirenTone || "default") + '"]');
      if (radio) radio.checked = true;
    }
    applyVolumeToAudio();
    applyStrobeClass();
    pushSettingsToBridge();
    renderPauseUI();
  }

  // --- Pausa de notificaciones ------------------------------------------
  function isPaused() { return settings.pausedUntil && settings.pausedUntil > Date.now(); }

  function formatPausedUntil(ms) {
    if (ms >= Number.MAX_SAFE_INTEGER / 2) return "hasta que la desactives";
    try {
      return "hasta " + new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
    } catch { return "hasta " + new Date(ms).toLocaleString("es-AR"); }
  }

  function renderPauseUI() {
    if (!pauseSelect || !pauseStatus) return;
    if (isPaused()) {
      pauseStatus.hidden = false;
      pauseStatus.textContent = "⏸ Pausado " + formatPausedUntil(settings.pausedUntil);
      pauseStatus.style.color = "#f59e0b";
    } else {
      pauseStatus.hidden = true; pauseStatus.textContent = "";
      if (settings.pausedUntil && settings.pausedUntil <= Date.now()) {
        settings.pausedUntil = 0; saveSettings(settings); syncPauseWithServer();
      }
      pauseSelect.value = "0";
    }
  }

  function computePausedUntil(option) {
    const now = Date.now();
    switch (option) {
      case "4h": return now + 4 * 60 * 60 * 1000;
      case "12h": return now + 12 * 60 * 60 * 1000;
      case "tomorrow6": {
        try {
          const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" });
          const parts = {};
          for (const p of fmt.formatToParts(new Date(now))) { if (p.type !== "literal") parts[p.type] = p.value; }
          const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
          d.setUTCDate(d.getUTCDate() + 1);
          const iso = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0") + "T06:00:00-03:00";
          return new Date(iso).getTime();
        } catch { return now + 12 * 60 * 60 * 1000; }
      }
      case "forever": return Number.MAX_SAFE_INTEGER;
      default: return 0;
    }
  }

  async function syncPauseWithServer() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await fetch("/push/pause", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint, pausedUntil: settings.pausedUntil || 0 })
      });
    } catch (err) {}
  }

  function sendToAndroid(action, title, message, retries = 5) {
      if (window.AndroidInterface && typeof window.AndroidInterface[action] === 'function') {
          window.AndroidInterface[action](title || "", message || "");
      } else if (retries > 0) {
          setTimeout(() => sendToAndroid(action, title, message, retries - 1), 500);
      }
  }

  function pushPausedUntilToBridge() {
    try {
      if (typeof window.AlertBridge !== "undefined" && window.AlertBridge !== null && typeof window.AlertBridge.setPausedUntil === "function") {
        window.AlertBridge.setPausedUntil(settings.pausedUntil || 0);
      }
    } catch (err) {}
  }

  if (pauseSelect) {
    pauseSelect.addEventListener("change", () => {
      const opt = pauseSelect.value;
      settings.pausedUntil = computePausedUntil(opt);
      saveSettings(settings);
      renderPauseUI(); syncPauseWithServer(); pushPausedUntilToBridge();
    });
  }

  setInterval(() => {
    if (settings.pausedUntil && settings.pausedUntil < Number.MAX_SAFE_INTEGER / 2 && settings.pausedUntil <= Date.now()) { renderPauseUI(); }
  }, 60 * 1000);

  function bridgeAvailable() { return (IS_APK && typeof window.AlertBridge !== "undefined" && window.AlertBridge !== null); }

  function pushSettingsToBridge() {
    if (!bridgeAvailable()) return;
    try {
      if (typeof window.AlertBridge.setVibrationEnabled === "function") window.AlertBridge.setVibrationEnabled(!!settings.vibration);
      if (typeof window.AlertBridge.setStrobeEnabled === "function") window.AlertBridge.setStrobeEnabled(!!settings.strobe);
      if (typeof window.AlertBridge.setVoiceEnabled === "function") window.AlertBridge.setVoiceEnabled(!!settings.voice);
      if (typeof window.AlertBridge.setAlarmVolume === "function") {
        const maxV = Math.max(parseInt(settings.sirenVolume, 50) || 0, parseInt(settings.voiceVolume, 10) || 0);
        window.AlertBridge.setAlarmVolume(maxV);
      }
      if (typeof window.AlertBridge.setSirenVolume === "function") window.AlertBridge.setSirenVolume(parseInt(settings.sirenVolume, 30) || 0);
      if (typeof window.AlertBridge.setVoiceVolume === "function") window.AlertBridge.setVoiceVolume(parseInt(settings.voiceVolume, 10) || 0);
      if (typeof window.AlertBridge.setPausedUntil === "function") window.AlertBridge.setPausedUntil(settings.pausedUntil || 0);
      if (typeof window.AlertBridge.setSirenTone === "function") window.AlertBridge.setSirenTone(settings.sirenTone || "default");
      if (typeof window.AlertBridge.setBadConnectionNotificationsEnabled === "function") window.AlertBridge.setBadConnectionNotificationsEnabled(settings.connNotif !== false);
    } catch (err) {}
  }

  function applyVolumeToAudio() {
    const sirenBase = Math.max(0, Math.min(1, settings.sirenVolume / 500));
    const voiceBase = Math.max(0, Math.min(1, settings.voiceVolume / 100));
    const type = currentAlert ? currentAlert.type : null;
    if (sirenAudio) sirenAudio.volume = Math.max(0, Math.min(1, sirenBase * sirenVolumeMultiplier(type)));
    if (voiceAudio) voiceAudio.volume = Math.max(0, Math.min(1, voiceBase * voiceVolumeMultiplier(type)));
  }

  function applyStrobeClass() { overlay.classList.toggle("is-nostrobe", !settings.strobe); }

  // --- Historial -------------------------------------------------------
  let serverHistory = [];

  function loadLocalHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch { return []; }
  }

  function saveLocalHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch { }
  }

  function addLocalHistoryEntry(alert) {
    if (!alert || alert.__test) return;
    const list = loadLocalHistory();
    const entry = { type: alert.type, label: alert.label || alert.type, startedAt: alert.startedAt || Date.now() };
    if (list.length && list[0].startedAt === entry.startedAt) return;
    list.unshift(entry);
    saveLocalHistory(list);
    
    // Agregarlo a la pestaña de notificaciones como registro de alerta
    addNotif("alert", alert.label || alert.type, "Alerta general disparada.");
  }

  function effectiveHistory() {
    if (Array.isArray(serverHistory) && serverHistory.length > 0) return serverHistory;
    return loadLocalHistory();
  }

  function formatDateTime(ms) {
    try {
      return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleString("es-AR");
    }
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return "—";
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? m + "m " + s + "s" : s + " s";
  }

  function renderHistory() {
    const list = effectiveHistory();
    if (list.length === 0) {
      historyListEl.innerHTML = '<div class="history__empty">Todavía no se registraron alertas.</div>';
      return;
    }
    historyListEl.innerHTML = "";
    for (const e of list) {
      const details = document.createElement("details");
      details.className = "history__item";
      if (e.type === "simulacro") details.classList.add("is-simulacro");
      const summary = document.createElement("summary");
      summary.className = "history__item-summary";
      summary.innerHTML = '<div class="history__item-icon" aria-hidden="true">' + iconForType(e.type) + "</div>" + '<div class="history__item-main">' + '<div class="history__item-type">' + escapeHtml(e.label || e.type) + "</div>" + '<div class="history__item-time">' + formatDateTime(e.startedAt) + "</div>" + "</div>" + '<span class="history__item-arrow" aria-hidden="true">›</span>';
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "history__item-body";
      const rows = [];
      if (e.triggeredBy) {
        const role = e.triggeredBy === "admin" ? "Administrador" : e.triggeredBy === "operator" ? "Preceptor" : e.triggeredBy === "schedule" ? "Programada" : e.triggeredBy === "system" ? "Sistema" : e.triggeredBy;
        rows.push(["Disparada por", role]);
      }
      if (typeof e.recipients === "number") {
        let r = String(e.recipients) + " dispositivo" + (e.recipients === 1 ? "" : "s");
        if (typeof e.silenced === "number" && e.silenced > 0) r += " (" + e.silenced + " silenciado" + (e.silenced === 1 ? "" : "s") + ")";
        rows.push(["Recibido por", r]);
      }
      if (e.endedAt && e.durationMs) {
        const reason = e.endedReason === "timeout" ? " (terminó sola)" : e.endedReason === "manual" ? " (cortada manualmente)" : "";
        rows.push(["Duración", formatDuration(e.durationMs) + reason]);
      }
      if (Array.isArray(e.recommendations) && e.recommendations.length > 0) {
        const ul = document.createElement("ul");
        ul.className = "history__item-recs";
        for (const line of e.recommendations) {
          if (typeof line !== "string" || !line.trim()) continue;
          const li = document.createElement("li");
          li.textContent = line.trim();
          ul.appendChild(li);
        }
        const wrap = document.createElement("div");
        wrap.className = "history__item-row";
        wrap.innerHTML = '<span class="history__item-row-label">Recomendaciones</span>';
        wrap.appendChild(ul);
        body.appendChild(wrap);
      }
      for (const [k, v] of rows) {
        const row = document.createElement("div");
        row.className = "history__item-row";
        row.innerHTML = '<span class="history__item-row-label">' + escapeHtml(k) + "</span>" + '<span class="history__item-row-value">' + escapeHtml(v) + "</span>";
        body.appendChild(row);
      }
      details.appendChild(body);
      historyListEl.appendChild(details);
    }
  }

  function updateLastAlert(entry) {
    if (!entry) {
      const list = effectiveHistory();
      if (!list.length) { lastAlertText.textContent = "Ninguna"; return; }
      entry = list[0];
    }
    lastAlertText.textContent = `${entry.label || entry.type} · ${formatDateTime(entry.startedAt)}`;
  }

  // --- Recomendaciones -------------------------------------------------
  const INFO_RECS_ORDER = ["sismo", "incendio", "evacuacion", "medica", "intruso", "gas", "bomba", "tormenta", "simulacro", "custom"];

  function renderInfoRecs() {
    if (!infoRecsListEl) return;
    infoRecsListEl.innerHTML = "";
    const keys = Object.keys(clientRecsState || {});
    const ordered = INFO_RECS_ORDER.filter((k) => keys.includes(k)).concat(keys.filter((k) => !INFO_RECS_ORDER.includes(k)).sort());
    if (ordered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "info-recs-empty";
      empty.textContent = "No hay recomendaciones cargadas.";
      infoRecsListEl.appendChild(empty);
      return;
    }
    for (const k of ordered) {
      const r = clientRecsState[k];
      if (!r || !Array.isArray(r.lines) || r.lines.length === 0) continue;
      const details = document.createElement("details");
      details.className = "info";
      const summary = document.createElement("summary");
      summary.className = "info__summary";
      summary.innerHTML = `<span class="info__icon" aria-hidden="true">${escapeHtml(r.icon || "")}</span>` + `<span>${escapeHtml(r.label || k)}</span>`;
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "info__body";
      const ul = document.createElement("ul");
      for (const line of r.lines) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      body.appendChild(ul);
      details.appendChild(body);
      infoRecsListEl.appendChild(details);
    }
  }

  function renderAlertRecs(lines) {
    if (!alertRecsEl || !alertRecsListEl) return;
    alertRecsListEl.innerHTML = "";
    if (!Array.isArray(lines) || lines.length === 0) {
      alertRecsEl.hidden = true; return;
    }
    for (const line of lines) {
      if (typeof line !== "string" || !line.trim()) continue;
      const li = document.createElement("li");
      li.textContent = line.trim();
      alertRecsListEl.appendChild(li);
    }
    alertRecsEl.hidden = false;
  }

  async function loadRecsInitial() {
    try {
      const res = await fetch("/recommendations", { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      if (j && j.recommendations) {
        clientRecsState = j.recommendations;
        renderInfoRecs();
      }
    } catch { }
  }

  function iconForType(t) {
    switch ((t || "").toLowerCase()) {
      case "simulacro": return "🧪"; case "incendio": return "🔥";
      case "sismo": return "🌐"; case "evacuacion": return "🚪";
      case "intruso": return "🛡️"; case "medica": return "🧑‍⚕️";
      case "gas": return "💨"; case "bomba": return "💣";
      case "tormenta": return "⛈️"; case "custom": return "📣";
      default: return "⚠️";
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c)); }

  // --- Status ----------------------------------------------------------
  function setStatus(text, state) {
    statusText.textContent = text;
    connStatusText.textContent = text;
    statusDot.classList.toggle("is-online", state === "online");
  }

  // --- Monitor de calidad de conexión ----------------------------------
  const CONN_WARN_RTT     = 350;
  const CONN_CRITICAL_RTT = 700;
  const CONN_PONG_TIMEOUT_MS = 8000;

  let connQuality = "good"; 
  let lastPongAt  = Date.now();
  let connChipTimer = null;   
  let connNotifTimer = null;  

  function playConnWarningSound() {
    if (!enabled || currentAlert) return;
    try {
      // Si tenés sonido de conexión débil, iría acá.
    } catch { }
  }

  function sendConnNotification(quality) {
    if (settings.connNotif === false) return;
    try {
      if (!Notification || Notification.permission !== "granted") return;
      const body = quality === "offline"
        ? "Sin conexión con el servidor. Las alertas no llegarán hasta que se recupere."
        : quality === "critical"
          ? "Conexión muy débil. Las alertas podrían llegar con retraso."
          : "Conexión débil detectada. Posibles retrasos en alertas.";
      new Notification("SchoolAlerts · Conexión", {
        body, icon: "/icon-192.png", tag: "conn-warn", renotify: true, requireInteraction: false, silent: false,
      });
    } catch { }
  }

  function clearConnNotification() {
    try {
      if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
      navigator.serviceWorker.ready.then((reg) => {
        reg.getNotifications({ tag: "conn-warn" }).then((notifs) => {
          notifs.forEach((n) => n.close());
        });
      }).catch(() => {});
    } catch { }
  }

  function setConnQuality(quality) {
    if (quality === connQuality) return;
    const prev = connQuality;
    connQuality = quality;
    clearTimeout(connChipTimer); clearTimeout(connNotifTimer);

    if (quality === "good") {
      if (connChip) { connChip.hidden = true; connChip.classList.remove("is-critical"); }
      clearConnNotification();
      return;
    }

    connChipTimer = setTimeout(() => {
      if (!connChip) return;
      connChip.hidden = false;
      const icon = connChip.querySelector(".conn-chip__icon");
      if (quality === "offline") {
        connChip.classList.add("is-critical");
        if (icon) icon.textContent = "wifi_off";
        if (connChipText) connChipText.textContent = "Sin conexión";
      } else if (quality === "critical") {
        connChip.classList.add("is-critical");
        if (icon) icon.textContent = "signal_wifi_bad";
        if (connChipText) connChipText.textContent = "Conexión muy débil";
      } else {
        connChip.classList.remove("is-critical");
        if (icon) icon.textContent = "signal_disconnected";
        if (connChipText) connChipText.textContent = "Conexión inestable";
      }
    }, 2500);

    if (prev === "good") {
      connNotifTimer = setTimeout(() => {
        if (connQuality === "good") return;
        playConnWarningSound(); sendConnNotification(connQuality);
      }, 2500);
    }
  }

  setInterval(() => {
    if (!socket || !socket.connected) return;
    const sinceLastPong = Date.now() - lastPongAt;
    if (sinceLastPong > CONN_PONG_TIMEOUT_MS * 1.5) setConnQuality("critical");
  }, 5000);

  function formatRemaining(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // --- Sirena ----------------------------------------------------------
  function ensureSirenAudio(src) {
    const wanted = src || SIREN_SRC;
    if (!sirenAudio) {
      sirenAudio = new Audio(wanted); sirenAudio.loop = true; sirenAudio.preload = "auto"; sirenAudio.__src = wanted;
    } else if ((sirenAudio.__src || "") !== wanted) {
      try { sirenAudio.pause(); } catch { }
      try { sirenAudio.src = wanted; sirenAudio.load(); } catch { }
      sirenAudio.__src = wanted;
    }
    applyVolumeToAudio(); return sirenAudio;
  }

  function startSiren(src) {
    const audio = ensureSirenAudio(src);
    try { audio.currentTime = 0; } catch { }
    const tryPlay = () => {
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch((err) => console.warn("No se pudo reproducir la sirena:", err));
    };
    if (audio.readyState >= 2) tryPlay();
    else { audio.addEventListener("canplay", function onReady() { audio.removeEventListener("canplay", onReady); if (alertActive()) tryPlay(); }); }
  }
  function alertActive() { return !!currentAlert; }
  function stopSiren() { if (!sirenAudio) return; try { sirenAudio.pause(); sirenAudio.currentTime = 0; } catch { } }

  // --- Voz -------------------------------------------------------------
  function resolveVoiceSrc(alertObj) {
    if (alertObj.type === "custom") {
      const remote = "/tts?text=" + encodeURIComponent(alertObj.label || "Alerta");
      return fetch(remote)
        .then((r) => { if (!r.ok) throw new Error("tts http " + r.status); return r.blob(); })
        .then((blob) => {
          if (currentVoiceObjectUrl) { try { URL.revokeObjectURL(currentVoiceObjectUrl); } catch { } }
          currentVoiceObjectUrl = URL.createObjectURL(blob);
          return currentVoiceObjectUrl;
        });
    }
    return Promise.resolve(VOICE_BASE + alertObj.type + ".mp3");
  }

  const VOICE_PLAYBACK_RATE = 1.2;
  function applyVoicePitch(audio) {
    if (!audio) return;
    try { audio.preservesPitch = false; audio.webkitPreservesPitch = false; audio.mozPreservesPitch = false; audio.playbackRate = VOICE_PLAYBACK_RATE; } catch { }
  }

  function ensureVoiceAudio(src) {
    if (!voiceAudio) { voiceAudio = new Audio(src); voiceAudio.preload = "auto"; } 
    else if (voiceAudio.src.indexOf(src) === -1) { voiceAudio.src = src; try { voiceAudio.load(); } catch { } }
    applyVoicePitch(voiceAudio); applyVolumeToAudio(); return voiceAudio;
  }

  function playVoiceOnce(src) {
    const audio = ensureVoiceAudio(src);
    try { audio.currentTime = 0; } catch { }
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch((err) => console.warn("No se pudo reproducir la voz:", err));
  }

  function startSpeakingLoop(alertObj) {
    stopSpeakingLoop();
    if (!settings.voice) return;
    if (alertObj && alertObj.skipVoice) return;
    const myAlert = alertObj;
    resolveVoiceSrc(alertObj)
      .then((src) => {
        if (!currentAlert || currentAlert !== myAlert) return;
        playVoiceOnce(src);
        voiceTimer = setInterval(() => {
          if (!currentAlert) return;
          if (voiceAudio && !voiceAudio.paused && !voiceAudio.ended) return;
          playVoiceOnce(src);
        }, VOICE_REPEAT_MS);
      }).catch((err) => { console.warn("No se pudo preparar la voz:", err); });
  }

  function stopSpeakingLoop() {
    if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
    if (voiceAudio) { try { voiceAudio.pause(); voiceAudio.currentTime = 0; } catch { } }
    if (currentVoiceObjectUrl) { try { URL.revokeObjectURL(currentVoiceObjectUrl); } catch { } currentVoiceObjectUrl = null; }
  }

  // --- Vibración -------------------------------------------------------
  function startVibration() {
    if (!settings.vibration) return;
    if (!("vibrate" in navigator)) return;
    const tick = () => { try { navigator.vibrate([600, 300]); } catch { } };
    tick();
    if (vibrationTimer) clearInterval(vibrationTimer);
    vibrationTimer = setInterval(tick, 900);
  }
  function stopVibration() {
    if (vibrationTimer) { clearInterval(vibrationTimer); vibrationTimer = null; }
    if ("vibrate" in navigator) { try { navigator.vibrate(0); } catch { } }
  }

  // --- Overlay ---------------------------------------------------------
  function showAlert(alert) {
    if (alert && alert.startedAt && alert.startedAt === dismissedStartedAt) return;
    
    currentAlert = alert; currentAlertIsTest = !!alert.__test;
    const label = alert.label || alert.type;
    alertTypeEl.textContent = label;

    overlay.classList.remove("is-simulacro");
    if (alert.type === "simulacro" || currentAlertIsTest) overlay.classList.add("is-simulacro");
    applyStrobeClass(); overlay.hidden = false;
    if (app) app.setAttribute("aria-hidden", "true");

    const remaining0 = alert.endsAt - Date.now();
    if (remaining0 <= 0) { hideAlert(); return; }

    const update = () => {
      const remaining = alert.endsAt - Date.now();
      alertTimeEl.textContent = formatRemaining(remaining);
      if (remaining <= 0) hideAlert();
    };
    update();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(update, 250);

    const muteSound = !!alert.muteSound; const muteVoice = !!alert.muteVoice; const muteVibration = !!alert.muteVibration;
    
    if (!IS_APK || alert.__runLocally) {
      if ((enabled || alert.__runLocally) && !muteSound) {
        const sirenSrc = alert.sirenUrl || (alert.type !== "simulacro" ? (SIREN_TONES[settings.sirenTone] || SIREN_SRC) : null);
        startSiren(sirenSrc);
      }
      if ((enabled || alert.__runLocally) && !muteVoice) startSpeakingLoop(alert);
      if (!muteVibration) startVibration();
    }
    if (!muteSound && !muteVoice && !muteVibration) reportClientState("alerting");

    refreshAlertUnlockHint();
    if (!currentAlertIsTest) addLocalHistoryEntry(alert);

    let recLines = alert && Array.isArray(alert.recommendations) ? alert.recommendations : null;
    if (!recLines) {
      const cached = clientRecsState[alert.type];
      recLines = cached && Array.isArray(cached.lines) ? cached.lines : [];
    }
    renderAlertRecs(recLines);
  }

  function refreshAlertUnlockHint() {
    if (!alertUnlockHint) return;
    const needsWebAudio = currentAlert && (!IS_APK || currentAlert.__runLocally) && !enabled;
    alertUnlockHint.hidden = !needsWebAudio;
  }

  function hideAlert() {
    currentAlert = null; currentAlertIsTest = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    overlay.hidden = true;
    if (app) app.removeAttribute("aria-hidden");
    renderAlertRecs([]); stopSiren(); stopSpeakingLoop(); stopVibration(); refreshAlertUnlockHint();
    if (isPaused()) reportClientState("paused");
    else if (isInSilentWindow()) reportClientState("silenced");
    else reportClientState("idle");
  }

  function dismissLocally() {
    if (!currentAlert) return;
    if (currentAlert.startedAt) dismissedStartedAt = currentAlert.startedAt;
    hideAlert();
  }

  alertCloseBtn.addEventListener("click", dismissLocally);

  // --- Activar audio ---------------------------------------------------
  function warmUpAudio(audio) {
    if (!audio) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { try { audio.pause(); audio.currentTime = 0; } catch { } audio.muted = false; resolve(); };
      try {
        audio.muted = true;
        const warm = audio.play();
        if (warm && typeof warm.then === "function") { warm.then(finish).catch(() => { audio.muted = false; resolve(); }); } else finish();
      } catch { audio.muted = false; resolve(); }
    });
  }

  function markEnabled() {
    enabled = true; enableBtn.textContent = "Sonido activado ✓"; enableBtn.disabled = true; enableBtn.classList.add("is-enabled");
    audioStatusText.textContent = "Activo"; audioStatusText.classList.add("is-positive");
    if (enableCard) enableCard.classList.add("is-done");
    refreshAlertUnlockHint();
  }

  function unlockAudioAndPlayCurrent() {
    const pending = currentAlert; const wasEnabled = enabled; markEnabled();
    const warmSirenSrc = pending && pending.sirenUrl ? pending.sirenUrl : (settings.sirenTone !== "default" ? (SIREN_TONES[settings.sirenTone] || null) : null);
    
    return Promise.all([
      warmUpAudio(ensureSirenAudio(warmSirenSrc)), warmUpAudio(ensureVoiceAudio(VOICE_BASE + "simulacro.mp3")),
    ]).then(() => {
      if (pending && currentAlert === pending && !wasEnabled) {
        if (!IS_APK || pending.__runLocally) {
          const unlockSrc = pending.sirenUrl || (pending.type !== "simulacro" ? (SIREN_TONES[settings.sirenTone] || SIREN_SRC) : null);
          startSiren(unlockSrc); startSpeakingLoop(pending);
        }
      }
    });
  }
  function unlockAudioAndPlayCurrent() {
    const pending = currentAlert; const wasEnabled = enabled; markEnabled();
    const warmSirenSrc = pending && pending.sirenUrl ? pending.sirenUrl : (settings.sirenTone !== "default" ? (SIREN_TONES[settings.sirenTone] || null) : null);
    
    // 1. Instanciamos los elementos de audio inmediatamente
    const sAudio = ensureSirenAudio(warmSirenSrc);
    const vAudio = ensureVoiceAudio(VOICE_BASE + "simulacro.mp3");

    // ── DETONACIÓN SÍNCRONA PARA IPHONE (iOS Safari) ──
    // Forzamos el inicio AQUÍ MISMO. Al ejecutar 'startSiren' y 'play' en este punto,
    // nos aseguramos de estar dentro del mismo ciclo del click/touchstart del usuario,
    // evitando que iOS bloquee el audio por culpa del delay asincrónico del .then().
    if (pending && !wasEnabled) {
      if (!IS_APK || pending.__runLocally) {
        const unlockSrc = pending.sirenUrl || (pending.type !== "simulacro" ? (SIREN_TONES[settings.sirenTone] || SIREN_SRC) : null);
        
        // Truco maestro para iOS: Le damos un play síncrono ultra rápido a los objetos nativos
        if (sAudio) { sAudio.src = unlockSrc; sAudio.play().catch(() => {}); }
        if (vAudio) { vAudio.play().catch(() => {}); }
        
        // Ejecutamos tus funciones de control que gestionan los loops
        startSiren(unlockSrc); 
        startSpeakingLoop(pending);
      }
    }
    
    // Devolvemos la promesa original para no romper el flujo del resto del sistema o de la APK
    return Promise.all([
      warmUpAudio(sAudio), warmUpAudio(vAudio),
    ]);
  }

  // ── PERSISTENCIA DE RUTA / ESTADO PARA WEB APPS (iOS) ──
  const esPWA = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

  if (esPWA) {
    // Al cargar la app, revisamos si el usuario estaba en una sección específica antes de cerrarse
    const ultimaSeccion = localStorage.getItem("pwa_last_section");
    if (ultimaSeccion) {
      console.log("Restaurando estado en iOS:", ultimaSeccion);
      // Aquí ejecutas la lógica de tu app para cambiar a esa pestaña o vista
      // Ejemplo: switchTab(ultimaSeccion);
    }

    // Cada vez que el usuario cambie de pestaña o interactúe, guardamos dónde está.
    // Puedes llamar a esta línea dentro de tus funciones que cambian de pantalla:
    // localStorage.setItem("pwa_last_section", idDeLaPantallaActual);
  }

document.addEventListener('click', function(e) {
    const target = e.target.closest('a');
    if (target && esPWA) {
      const href = target.getAttribute('href');
      
      // Si el enlace es externo, lo obligamos a abrirse en una ventana modal interna
      // en vez de romper la PWA y abrir Safari.
      if (href && href.startsWith('http') && !href.includes(window.location.host)) {
        e.preventDefault();
        window.open(href, '_blank'); // iOS mantendrá una pestaña interna temporal
      }
    }
  });

  enableBtn.addEventListener("click", () => { unlockAudioAndPlayCurrent(); });
  overlay.addEventListener("click", (ev) => {
    if (enabled || !currentAlert || (IS_APK && !currentAlert.__runLocally)) return;
    if (alertCloseBtn && alertCloseBtn.contains(ev.target)) return;
    unlockAudioAndPlayCurrent();
  });

 function silentWarmup() { 
    // Forzamos las rutas reales para que iOS descargue los buffers en memoria
    warmUpAudio(ensureSirenAudio(SIREN_SRC)); 
    warmUpAudio(ensureVoiceAudio(VOICE_BASE + "simulacro.mp3")); 
    markEnabled(); 
  }
  document.addEventListener("pointerdown", silentWarmup, { once: true });
  document.addEventListener("touchstart", silentWarmup, { once: true, passive: true });

  // --- Nombre del dispositivo ------------------------------------------
  function loadDeviceName() { try { const raw = localStorage.getItem(DEVICE_KEY); if (!raw) return ""; const parsed = JSON.parse(raw); if (parsed && typeof parsed.name === "string") return parsed.name; } catch { } return ""; }
  function saveDeviceName(name) { try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ name })); } catch { } }
  let deviceName = loadDeviceName();
  if (deviceNameInput) deviceNameInput.value = deviceName;

  function setDeviceNameStatus(msg, ok) {
    if (!deviceNameStatus) return;
    if (!msg) { deviceNameStatus.hidden = true; deviceNameStatus.textContent = ""; return; }
    deviceNameStatus.hidden = false; deviceNameStatus.textContent = msg;
    deviceNameStatus.classList.toggle("is-positive", !!ok);
  }

  if (deviceNameSaveBtn) {
    deviceNameSaveBtn.addEventListener("click", () => {
      const v = (deviceNameInput.value || "").trim().slice(0, 60);
      if (!v) { setDeviceNameStatus("Poné un nombre (no puede estar vacío).", false); return; }
      deviceName = v; saveDeviceName(deviceName); identifyToServer(); pushDeviceNameToBridge(); setDeviceNameStatus("Nombre guardado: " + deviceName, true);
    });
  }

  function pushDeviceNameToBridge() { if (!bridgeAvailable() || typeof window.AlertBridge.setDeviceName !== "function") return; try { window.AlertBridge.setDeviceName(deviceName || ""); } catch (err) {} }
  function pushClientIdToBridge() { if (!bridgeAvailable() || typeof window.AlertBridge.setClientId !== "function") return; try { window.AlertBridge.setClientId(CLIENT_ID || ""); } catch (err) {} }
  pushClientIdToBridge();

  // --- Silenciar por horario -------------------------------------------
  function loadSilentWindow() { try { const raw = localStorage.getItem(SILENT_KEY); if (!raw) return null; const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") return parsed; } catch { } return null; }
  function saveSilentWindow(sw) { try { localStorage.setItem(SILENT_KEY, JSON.stringify(sw)); } catch { } }
  let silentWindow = loadSilentWindow() || { enabled: false, from: "22:00", to: "07:00", days: [1, 2, 3, 4, 5] };

  function applySilentWindowToUI() {
    if (silentEnabled) silentEnabled.checked = !!silentWindow.enabled;
    if (silentFromEl && silentWindow.from) silentFromEl.value = silentWindow.from;
    if (silentToEl && silentWindow.to) silentToEl.value = silentWindow.to;
    if (silentDaysEl) {
      const chips = silentDaysEl.querySelectorAll(".day-chip");
      const sel = new Set((silentWindow.days || []).map(Number));
      chips.forEach((chip) => { const d = parseInt(chip.getAttribute("data-day"), 10); chip.classList.toggle("is-on", sel.has(d)); });
    }
    if (silentFields) silentFields.hidden = !silentWindow.enabled;
    renderSilentSummary();
  }

  function renderSilentSummary() {
    if (!silentSummary) return;
    if (!silentWindow.enabled) { silentSummary.textContent = "Desactivado"; return; }
    const days = (silentWindow.days || []).slice().sort();
    const names = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    let dayStr;
    if (days.length === 0) dayStr = "ningún día";
    else if (days.length === 7) dayStr = "todos los días";
    else dayStr = days.map((d) => names[d]).join(" · ");
    silentSummary.textContent = "De " + (silentWindow.from || "?") + " a " + (silentWindow.to || "?") + " · " + dayStr;
  }

  function persistSilentWindow() { saveSilentWindow(silentWindow); applySilentWindowToUI(); identifyToServer(); pushSilentWindowToBridge(); }

  function pushSilentWindowToBridge() {
    if (!bridgeAvailable() || typeof window.AlertBridge.setSilentWindow !== "function") return;
    try { const days = (silentWindow.days || []).join(","); window.AlertBridge.setSilentWindow(!!silentWindow.enabled, silentWindow.from || "", silentWindow.to || "", days); } catch (err) {}
  }

  if (silentEnabled) { silentEnabled.addEventListener("change", () => { silentWindow.enabled = !!silentEnabled.checked; persistSilentWindow(); }); }
  if (silentFromEl) { silentFromEl.addEventListener("change", () => { silentWindow.from = silentFromEl.value; persistSilentWindow(); }); }
  if (silentToEl) { silentToEl.addEventListener("change", () => { silentWindow.to = silentToEl.value; persistSilentWindow(); }); }
  if (silentDaysEl) {
    silentDaysEl.addEventListener("click", (ev) => {
      const chip = ev.target.closest(".day-chip"); if (!chip) return;
      const d = parseInt(chip.getAttribute("data-day"), 10); if (isNaN(d)) return;
      const cur = new Set((silentWindow.days || []).map(Number));
      if (cur.has(d)) cur.delete(d); else cur.add(d);
      silentWindow.days = Array.from(cur).sort((a, b) => a - b);
      persistSilentWindow();
    });
  }

  applySilentWindowToUI(); pushSilentWindowToBridge(); pushDeviceNameToBridge();

  let lastClientState = "idle";
  function reportClientState(state) {
    if (state === lastClientState) return;
    lastClientState = state;
    try { socket.emit("client:state", { state }); } catch { }
  }

  function identifyToServer() { try { socket.emit("client:identify", { clientId: CLIENT_ID, name: deviceName || "", silentWindow: silentWindow, isApk: IS_APK, }); } catch { } }

  // --- Tabs ------------------------------------------------------------
  const tabButtons = document.querySelectorAll(".tabs__btn");
  const tabSections = document.querySelectorAll(".tab");
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab-target");
      tabButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      tabSections.forEach((sec) => { sec.hidden = sec.getAttribute("data-tab") !== target; });
      if (target === "history") renderHistory();
      if (target === "notifications") { unreadNotifs = 0; updateNotifBadge(); }
    });
  });

  // --- Settings handlers ----------------------------------------------
  function persistAndApply() { saveSettings(settings); applyVolumeToAudio(); applyStrobeClass(); }

  setVibration.addEventListener("change", () => {
    settings.vibration = setVibration.checked; persistAndApply();
    if (bridgeAvailable() && typeof window.AlertBridge.setVibrationEnabled === "function") { try { window.AlertBridge.setVibrationEnabled(!!settings.vibration); } catch (err) { } }
    if (!settings.vibration) stopVibration(); else if (currentAlert) startVibration();
  });

  setStrobe.addEventListener("change", () => {
    settings.strobe = setStrobe.checked; persistAndApply();
    if (bridgeAvailable() && typeof window.AlertBridge.setStrobeEnabled === "function") { try { window.AlertBridge.setStrobeEnabled(!!settings.strobe); } catch (err) { } }
  });

  setVoice.addEventListener("change", () => {
    settings.voice = setVoice.checked; persistAndApply();
    if (bridgeAvailable() && typeof window.AlertBridge.setVoiceEnabled === "function") { try { window.AlertBridge.setVoiceEnabled(!!settings.voice); } catch (err) { } }
    if (!settings.voice) stopSpeakingLoop(); else if (currentAlert) startSpeakingLoop(currentAlert);
  });

  setSirenVolume.addEventListener("input", () => {
    settings.sirenVolume = parseInt(setSirenVolume.value, 10) || 0; sirenVolumeLabel.textContent = settings.sirenVolume + " %"; persistAndApply();
    if (bridgeAvailable()) {
      try { if (typeof window.AlertBridge.setSirenVolume === "function") window.AlertBridge.setSirenVolume(settings.sirenVolume);
            if (typeof window.AlertBridge.setAlarmVolume === "function") window.AlertBridge.setAlarmVolume(Math.max(settings.sirenVolume, settings.voiceVolume)); } catch (err) { }
    }
  });

  setVoiceVolume.addEventListener("input", () => {
    settings.voiceVolume = parseInt(setVoiceVolume.value, 10) || 0; voiceVolumeLabel.textContent = settings.voiceVolume + " %"; persistAndApply();
    if (bridgeAvailable()) {
      try { if (typeof window.AlertBridge.setVoiceVolume === "function") window.AlertBridge.setVoiceVolume(settings.voiceVolume);
            if (typeof window.AlertBridge.setAlarmVolume === "function") window.AlertBridge.setAlarmVolume(Math.max(settings.sirenVolume, settings.voiceVolume)); } catch (err) { }
    }
  });

  if (tonePicker) {
    tonePicker.querySelectorAll('input[name="sirenTone"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        settings.sirenTone = radio.value; persistAndApply();
        if (bridgeAvailable() && typeof window.AlertBridge.setSirenTone === "function") { try { window.AlertBridge.setSirenTone(settings.sirenTone); } catch (err) { } }
      });
    });
  }

  clearHistoryBtn.addEventListener("click", () => {
    if (!confirm("¿Seguro que querés borrar el historial local?")) return;
    localStorage.removeItem(HISTORY_KEY); serverHistory = []; renderHistory(); updateLastAlert();
  });

  testAlertBtn.addEventListener("click", () => {
    if (currentAlert) return;
    if (IS_APK && typeof window.AlertBridge !== "undefined" && typeof window.AlertBridge.testAlert === "function") { try { window.AlertBridge.testAlert(); return; } catch (err) {} }
    if (!enabled && !IS_APK) { alert('Primero tocá "Activar sonido y voz" en la pestaña Inicio para que se escuche la sirena.'); return; }
    const fake = { type: "simulacro", label: "Simulacro", startedAt: Date.now(), endsAt: Date.now() + 5000, __test: true, __runLocally: true };
    showAlert(fake); setTimeout(() => { if (currentAlert === fake) hideAlert(); }, 5000);
  });

  if (setConnNotif) {
    setConnNotif.addEventListener("change", () => {
      settings.connNotif = setConnNotif.checked; saveSettings(settings);
      if (bridgeAvailable() && typeof window.AlertBridge.setBadConnectionNotificationsEnabled === "function") { try { window.AlertBridge.setBadConnectionNotificationsEnabled(settings.connNotif); } catch(err) {} }
    });
  }

  resetDataBtn.addEventListener("click", () => {
    if (!confirm("Esto borra el historial y vuelve los ajustes a sus valores por defecto. ¿Continuar?")) return;
    localStorage.removeItem(HISTORY_KEY); localStorage.removeItem(SETTINGS_KEY);
    serverHistory = []; settings = loadSettings(); applySettingsToUI(); renderHistory(); updateLastAlert();
  });
  // --- Lógica de Silencio por Horario ---
function isInSilentWindow() {
    if (!silentWindow || !silentWindow.enabled) return false;
    
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const dayOfWeek = now.getDay(); // 0 (Dom) a 6 (Sáb)
    
    if (!silentWindow.days.includes(dayOfWeek)) return false;

    const [fromH, fromM] = silentWindow.from.split(':').map(Number);
    const [toH, toM] = silentWindow.to.split(':').map(Number);
    const fromMinutes = fromH * 60 + fromM;
    const toMinutes = toH * 60 + toM;

    if (fromMinutes <= toMinutes) {
        // Rango normal (ej: 08:00 a 17:00)
        return currentMinutes >= fromMinutes && currentMinutes < toMinutes;
    } else {
        // Rango nocturno (ej: 22:00 a 07:00 del día siguiente)
        return currentMinutes >= fromMinutes || currentMinutes < toMinutes;
    }
}
  // --- Socket ----------------------------------------------------------
socket.on("connect", () => {
    setStatus("En línea · esperando alertas", "online");
    lastPongAt = Date.now(); 
    setConnQuality("good"); 
    socket.emit("role:client", { clientId: CLIENT_ID });
    identifyToServer(); 
    lastClientState = "";
    
    // --- NUEVO: Obtener y enviar datos de red al servidor ---
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const netType = connection ? connection.effectiveType : "WiFi/Ethernet"; 
    socket.emit("client:report", {
      netType: netType
    });
    // --------------------------------------------------------
    
    // Verificamos si la función existe antes de llamarla
    const silent = (typeof isInSilentWindow === 'function') ? isInSilentWindow() : false;
    
    if (currentAlert) reportClientState("alerting"); 
    else if (isPaused()) reportClientState("paused"); 
    else if (silent) reportClientState("silenced"); 
    else reportClientState("idle");
    
    sendNetPing(); 
    if (window.AndroidInterface) { window.AndroidInterface.hideNetworkWarning(); }
  });
 // --- MANTENIMIENTO DE CONEXIÓN ---
        // (Tu lógica anterior de socket y status sigue aquí abajo...)

      // Función para manejar la visibilidad del Overlay
  function mostrarMensajeOverlay(text) {
    const overlay = document.getElementById("alertOverlay");
    const alertBody = document.getElementById("alertBody");
    
    if (overlay && alertBody) {
        alertBody.textContent = text;
        overlay.hidden = false; // Muestra el overlay que agregaste en index.html
    }
  }

  // Lógica para cerrar el overlay
 
  if (alertCloseBtn) {
    alertCloseBtn.addEventListener("click", () => {
        const overlay = document.getElementById("alertOverlay");
        if (overlay) overlay.hidden = true;
    });
  }
  function showFloatingChip(text) {
    const container = document.getElementById("floating-toast-container");
    const chip = document.createElement("div");
    chip.className = "toast-chip";
    chip.innerHTML = `
        <span class="material-symbols-outlined" style="color:#4a90e2">notifications_active</span>
        <span style="font-weight:600; color:#333; font-size:0.9rem;">${text}</span>
    `;
    
    container.appendChild(chip);
    
    // Eliminar el elemento del DOM después de la animación (4.5s)
    setTimeout(() => {
        chip.remove();
    }, 4500);
  }
  // ----------------------------------------------------------------------

  let pendingNetPingT0 = 0;
  function sendNetPing() { try { pendingNetPingT0 = Date.now(); socket.emit("client:ping", { t0: pendingNetPingT0 }); } catch { } }
  socket.on("client:pong", (payload) => {
    if (!payload || typeof payload.t0 !== "number") return;
    const rtt = Date.now() - payload.t0; if (rtt < 0) return; lastPongAt = Date.now();
    if (rtt >= CONN_CRITICAL_RTT) setConnQuality("critical"); else if (rtt >= CONN_WARN_RTT) setConnQuality("weak"); else setConnQuality("good");
    let effectiveType = null;
    try { const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection; if (conn && typeof conn.effectiveType === "string") effectiveType = conn.effectiveType; } catch { }
    try { socket.emit("client:netinfo", { rttMs: rtt, effectiveType }); } catch { }
  });
  setInterval(() => { if (socket && socket.connected) sendNetPing(); }, 15 * 1000);
  
  socket.on("client:renamed", (payload) => {
    if (!payload || typeof payload.name !== "string") return;
    const name = payload.name.trim().slice(0, 60); if (!name) return;
    deviceName = name; saveDeviceName(deviceName);
    if (deviceNameInput) deviceNameInput.value = deviceName;
    setDeviceNameStatus("El admin renombró este dispositivo: " + deviceName, true); pushDeviceNameToBridge();
  });

if (alertCloseBtn) {
    alertCloseBtn.addEventListener("click", () => {
        overlay.hidden = true;
    });
}

  socket.on("alerts:history", (payload) => {
    if (!payload || !Array.isArray(payload.history)) return;
    serverHistory = payload.history; renderHistory(); updateLastAlert();
  });
  
  socket.on("disconnect", () => {
    setStatus("Desconectado", "offline"); setConnQuality("offline");
    sendToAndroid("showNetworkWarning", "Conexión Inestable", "Reconectando...");
    if (window.AndroidInterface) { safeCall("showNetworkWarning", "Conexión inestable", "Reconectando..."); }

  });
  
  socket.on("connect_error", () => { });
  socket.on("recommendations:update", (payload) => {
    if (!payload || typeof payload.recommendations !== "object") return;
    clientRecsState = payload.recommendations; renderInfoRecs();
  });

  // --- APK tweaks ------------------------------------------------------
  if (IS_APK) {
    enabled = true; audioStatusText.textContent = "Gestionado por la app"; audioStatusText.classList.add("is-positive");
    if (enableCard) {
      enableCard.innerHTML = '<div class="card__title">Modo app</div><div class="card__body"><p class="card__text" style="margin:0">La sirena, voz, flash de la cámara y vibración se manejan automáticamente por la app — funciona aún con la pantalla bloqueada o la app minimizada.</p></div>';
      enableCard.classList.add("is-done");
    }
    if (testAlertBtn) testAlertBtn.title = "Dispara una alerta local de 5 segundos con sirena, flash y vibración para verificar que todo funciona.";
  }

  // --- Web Push --------------------------------------------------------
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64); const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  }

  function isStandalonePWA() { return ((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true); }
  function pushSupported() { return ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window); }

  function setPushStatus(msg) {
    if (!pushStatus) return; if (!msg) { pushStatus.hidden = true; pushStatus.textContent = ""; return; }
    pushStatus.hidden = false; pushStatus.textContent = msg;
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try { return await navigator.serviceWorker.register("/sw.js"); } catch (err) { return null; }
  }

  async function subscribeToPush() {
    if (!pushSupported()) { setPushStatus("Tu navegador no soporta notificaciones push."); return; }
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS && !isStandalonePWA()) { setPushStatus("En iPhone, primero tenés que agregar la app a la pantalla de inicio (botón Compartir → Agregar a pantalla de inicio) y abrirla desde el ícono del home."); return; }

    pushEnableBtn.disabled = true;
    try {
      const reg = await registerServiceWorker();
      if (!reg) { setPushStatus("No se pudo activar el service worker."); pushEnableBtn.disabled = false; return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setPushStatus("Permiso de notificaciones denegado. Activalo desde Ajustes del sistema."); pushEnableBtn.disabled = false; return; }
      const keyRes = await fetch("/vapid-public-key");
      if (!keyRes.ok) throw new Error("no vapid key");
      const { publicKey } = await keyRes.json();
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) { subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }); }
      await fetch("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription) });
      setPushStatus("Notificaciones activadas ✓"); pushEnableBtn.textContent = "Notificaciones activadas"; pushEnableBtn.classList.add("is-enabled"); pushEnableBtn.disabled = true;
    } catch (err) { setPushStatus("No se pudieron activar las notificaciones: " + err.message); pushEnableBtn.disabled = false; }
  }

  async function initPushUI() {
    if (IS_APK) return; if (!pushCard) return; pushCard.hidden = false;
    if (!pushSupported()) {
      const flags = { sw: "serviceWorker" in navigator, pm: "PushManager" in window, n: "Notification" in window, standalone: isStandalonePWA() };
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      let msg = "Este navegador no soporta notificaciones push.";
      if (isIOS && !flags.standalone) msg = "En iPhone / iPad, las notificaciones push funcionan sólo si agregás la app a la pantalla de inicio.";
      else if (isIOS && flags.standalone && !flags.pm) msg = "Tu versión de iOS no soporta notificaciones push (se necesita iOS 16.4 o superior). Actualizá el sistema.";
      setPushStatus(msg + " [debug sw=" + flags.sw + " pm=" + flags.pm + " n=" + flags.n + " standalone=" + flags.standalone + "]");
      pushEnableBtn.disabled = true; return;
    }
    if (Notification.permission === "granted") {
      try {
        const reg = await registerServiceWorker();
        if (reg) {
          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            try { await fetch("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(existing) }); } catch { }
            setPushStatus("Notificaciones activadas ✓"); pushEnableBtn.textContent = "Notificaciones activadas"; pushEnableBtn.classList.add("is-enabled"); pushEnableBtn.disabled = true; return;
          }
        }
      } catch { }
    }
    if (pushEnableBtn) pushEnableBtn.addEventListener("click", subscribeToPush);
  }

  setTimeout(() => { if (window.AndroidInterface) { window.AndroidInterface.testBridge(); } }, 3000);

  // --- Init ------------------------------------------------------------
  applySettingsToUI(); renderHistory(); updateLastAlert();
  setStatus("Conectando…"); initPushUI(); loadRecsInitial();
  
  // Renderizar notificaciones al cargar
  renderNotifs();
  // --- ACTIVACIÓN INVISIBLE PARA NAVEGADORES WEB ---
// --- ACTIVACIÓN INVISIBLE PARA iOS / NAVEGADORES WEB ---
  (function() {
      function forceBrowserActivation() {
          // Usamos tu función existente que ya prepara las instancias reales de audio
          silentWarmup(); 
          
          console.log("Sistema de audio desbloqueado tras interacción del usuario.");
          
          document.removeEventListener('click', forceBrowserActivation);
          document.removeEventListener('touchstart', forceBrowserActivation);
      }

      // iPhone requiere gestos explícitos. 'touchstart' y 'click' cubren ambas bases.
      document.addEventListener('click', forceBrowserActivation, { once: true });
      document.addEventListener('touchstart', forceBrowserActivation, { once: true, passive: true });
  })();
 // <-- Cierre de tu IIFE principal original
}()
);