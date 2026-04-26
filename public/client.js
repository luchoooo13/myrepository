(function () {
  const socket = io();

  // Detectamos si corremos dentro del APK nativo. En ese caso el servicio
  // Android se encarga de la sirena, la vibración, el flash de la cámara y
  // el overlay a pantalla completa (AlertActivity) aunque la app esté en
  // background o el celu bloqueado. Para no duplicar sirena/voz/flash, el JS
  // web sólo actualiza UI + historial.
  // Chequeamos tres cosas (cualquiera alcanza, para ser tolerantes a cambios
  // de User-Agent entre versiones del APK):
  //  - window.AlertBridge: el puente nativo inyectado por el APK (lo más
  //    confiable, no se puede spoofear desde el navegador).
  //  - User-Agent que contenga SchoolAlertsAPK (nuevo, >=2026) o
  //    AlertaClienteAPK (legacy, <=2025).
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

  const overlay = document.getElementById("alertOverlay");
  const alertTypeEl = document.getElementById("alertType");
  const alertTimeEl = document.getElementById("alertTime");
  const alertCloseBtn = document.getElementById("alertCloseBtn");
  const alertUnlockHint = document.getElementById("alertUnlockHint");
  const alertRecsEl = document.getElementById("alertRecs");
  const alertRecsListEl = document.getElementById("alertRecsList");
  const infoRecsListEl = document.getElementById("infoRecsList");

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
  const setVolume = document.getElementById("setVolume");
  const volumeLabel = document.getElementById("volumeLabel");
  const testAlertBtn = document.getElementById("testAlertBtn");
  const resetDataBtn = document.getElementById("resetDataBtn");

  // --- Estado ----------------------------------------------------------
  let sirenAudio = null;
  let voiceAudio = null;
  let currentAlert = null;
  let currentAlertIsTest = false;
  let tickTimer = null;
  let voiceTimer = null;
  let vibrationTimer = null;
  let enabled = false;
  // startedAt de la alerta que el usuario descartó con la X en ESTE equipo.
  // Lo guardamos por separado de currentAlert porque hideAlert() deja
  // currentAlert = null, y el server re-emite `alert:start` al reconectar
  // el socket (o al abrir una nueva pestaña), por lo que necesitamos
  // recordar qué alerta ya fue cerrada acá para ignorar esos replays.
  let dismissedStartedAt = 0;
  let currentVoiceObjectUrl = null;
  // Recomendaciones globales (type -> { label, icon, lines }). Las levantamos
  // al arrancar y nos suscribimos a recommendations:update para refrescar
  // la pestaña "Guía rápida" cuando el admin edita desde /host. Durante una
  // alerta, las recomendaciones que se muestran en el overlay vienen en el
  // mismo payload de alert:start (snapshot del momento del disparo), para
  // no cambiarlas a mitad si el admin las edita mientras suena.
  let clientRecsState = {};

  const SIREN_SRC = "/sounds/siren.mp3";
  const VOICE_BASE = "/sounds/voice/";
  const VOICE_REPEAT_MS = 5000;
  const HISTORY_KEY = "alertas.history.v1"; // legacy local cache
  const SETTINGS_KEY = "alertas.settings.v1";
  const DEVICE_KEY = "alertas.device.v1";
  const SILENT_KEY = "alertas.silent.v1";
  // Id estable del dispositivo. Se genera la primera vez y se persiste.
  // Lo usamos para que el server no cree un "Cliente N" nuevo en cada
  // reconexión (cada vez que se pierde y vuelve la red, socket.io
  // genera un socket.id distinto y antes eso aparecía como un cliente
  // nuevo aunque sea el mismo celu).
  const CLIENT_ID_KEY = "alertas.clientid.v1";
  function getOrCreateClientId() {
    try {
      const existing = localStorage.getItem(CLIENT_ID_KEY);
      if (existing && typeof existing === "string" && existing.length > 0) {
        return existing.slice(0, 64);
      }
    } catch {
      /* ignore */
    }
    let id = "";
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        id = crypto.randomUUID();
      }
    } catch {
      /* ignore */
    }
    if (!id) {
      id = "c-" + Date.now().toString(36) + "-" +
        Math.random().toString(36).slice(2, 10);
    }
    try {
      localStorage.setItem(CLIENT_ID_KEY, id);
    } catch {
      /* ignore */
    }
    return id;
  }
  const CLIENT_ID = getOrCreateClientId();
  const HISTORY_MAX = 50;

  // Volúmenes por tipo de alerta. El usuario puede bajarlos con el slider
  // global de Ajustes; estos multiplicadores se aplican al final.
  // - intruso: NO tiene que sonar la sirena (alertaría al intruso). Sólo
  //   queda la voz a volumen bajo + flash + vibración. Visualmente se
  //   nota igual.
  // - simulacro: 100% / 100% (es prueba, queremos que se escuche tal
  //   cual sonaría una alerta real).
  // - resto: la sirena va más baja para que la voz se entienda por
  //   arriba y la gente sepa qué está pasando (incendio/sismo/etc).
  //   La voz ya está al máximo (1.0) — el navegador y MediaPlayer no
  //   nos dejan superar 1.0, así que para que la voz "suene más" hay
  //   que bajar la sirena (lo hacemos a 0.4).
  function sirenVolumeMultiplier(type) {
    if (type === "intruso") return 0;
    if (type === "simulacro") return 1;
    return 0.4;
  }
  function voiceVolumeMultiplier(type) {
    if (type === "intruso") return 0.45;
    return 1;
  }

  // --- Settings --------------------------------------------------------
  const defaultSettings = {
    vibration: true,
    strobe: true,
    voice: true,
    volume: 100,
    // pausedUntil: ms timestamp. 0 = no pausado. Number.MAX_SAFE_INTEGER = pausa
    // indefinida (hasta que el usuario la desactive manualmente).
    pausedUntil: 0,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...defaultSettings };
      const parsed = JSON.parse(raw);
      return { ...defaultSettings, ...parsed };
    } catch {
      return { ...defaultSettings };
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }

  let settings = loadSettings();

  function applySettingsToUI() {
    setVibration.checked = !!settings.vibration;
    setStrobe.checked = !!settings.strobe;
    setVoice.checked = !!settings.voice;
    setVolume.value = String(settings.volume);
    volumeLabel.textContent = Math.round(settings.volume) + " %";
    applyVolumeToAudio();
    applyStrobeClass();
    pushSettingsToBridge();
    renderPauseUI();
  }

  // --- Pausa de notificaciones ------------------------------------------
  function isPaused() {
    return settings.pausedUntil && settings.pausedUntil > Date.now();
  }

  function formatPausedUntil(ms) {
    if (ms >= Number.MAX_SAFE_INTEGER / 2) return "hasta que la desactives";
    try {
      return "hasta " +
        new Intl.DateTimeFormat("es-AR", {
          timeZone: "America/Argentina/Buenos_Aires",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(ms));
    } catch {
      return "hasta " + new Date(ms).toLocaleString("es-AR");
    }
  }

  function renderPauseUI() {
    if (!pauseSelect || !pauseStatus) return;
    if (isPaused()) {
      pauseStatus.hidden = false;
      pauseStatus.textContent =
        "⏸ Pausado " + formatPausedUntil(settings.pausedUntil);
      pauseStatus.style.color = "#f59e0b";
    } else {
      pauseStatus.hidden = true;
      pauseStatus.textContent = "";
      // Si expiró, reseteamos el select al default.
      if (settings.pausedUntil && settings.pausedUntil <= Date.now()) {
        settings.pausedUntil = 0;
        saveSettings(settings);
        syncPauseWithServer();
      }
      pauseSelect.value = "0";
    }
  }

  function computePausedUntil(option) {
    const now = Date.now();
    switch (option) {
      case "4h":
        return now + 4 * 60 * 60 * 1000;
      case "12h":
        return now + 12 * 60 * 60 * 1000;
      case "tomorrow6": {
        // Mañana 6:00 AM hora Buenos Aires. Usamos el mismo truco que en el
        // server: formateamos el "hoy" de BA y sumamos 1 día.
        try {
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Argentina/Buenos_Aires",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          const parts = {};
          for (const p of fmt.formatToParts(new Date(now))) {
            if (p.type !== "literal") parts[p.type] = p.value;
          }
          const d = new Date(Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
          ));
          d.setUTCDate(d.getUTCDate() + 1);
          const iso =
            d.getUTCFullYear() +
            "-" + String(d.getUTCMonth() + 1).padStart(2, "0") +
            "-" + String(d.getUTCDate()).padStart(2, "0") +
            "T06:00:00-03:00";
          return new Date(iso).getTime();
        } catch {
          return now + 12 * 60 * 60 * 1000;
        }
      }
      case "forever":
        return Number.MAX_SAFE_INTEGER;
      default:
        return 0;
    }
  }

  // Avisa al server del cambio de pausa para que no envíe push notifs a
  // esta suscripción. Si no hay suscripción push, es no-op.
  async function syncPauseWithServer() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await fetch("/push/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          pausedUntil: settings.pausedUntil || 0,
        }),
      });
    } catch (err) {
      console.warn("syncPauseWithServer falló:", err);
    }
  }

  // En el APK, el servicio nativo Android (AlertService) abre su propio
  // socket al server y reproduce sirena/voz/flash aunque la WebView no
  // esté abierta. No alcanza con bloquearlo del lado JS: hay que decirle
  // al servicio (via AlertBridge.setPausedUntil) que está pausado así
  // también ignora los alert:start que le llegan por su cuenta.
  function pushPausedUntilToBridge() {
    try {
      if (
        typeof window.AlertBridge !== "undefined" &&
        window.AlertBridge !== null &&
        typeof window.AlertBridge.setPausedUntil === "function"
      ) {
        window.AlertBridge.setPausedUntil(settings.pausedUntil || 0);
      }
    } catch (err) {
      console.warn("AlertBridge.setPausedUntil falló:", err);
    }
  }

  if (pauseSelect) {
    pauseSelect.addEventListener("change", () => {
      const opt = pauseSelect.value;
      settings.pausedUntil = computePausedUntil(opt);
      saveSettings(settings);
      renderPauseUI();
      syncPauseWithServer();
      pushPausedUntilToBridge();
    });
  }

  // Chequea cada minuto si la pausa expiró (para refrescar la UI sin
  // depender de que el usuario recargue la página).
  setInterval(() => {
    if (settings.pausedUntil &&
        settings.pausedUntil < Number.MAX_SAFE_INTEGER / 2 &&
        settings.pausedUntil <= Date.now()) {
      renderPauseUI();
    }
  }, 60 * 1000);

  // En el APK, el servicio Android (AlertService) no conoce los toggles que
  // el usuario guarda en localStorage — corren en mundos distintos. Los
  // empujamos vía AlertBridge para que el servicio los persista en sus
  // SharedPreferences y los respete cuando dispare la alerta.
  function bridgeAvailable() {
    return (
      IS_APK &&
      typeof window.AlertBridge !== "undefined" &&
      window.AlertBridge !== null
    );
  }

  function pushSettingsToBridge() {
    if (!bridgeAvailable()) return;
    try {
      if (typeof window.AlertBridge.setVibrationEnabled === "function") {
        window.AlertBridge.setVibrationEnabled(!!settings.vibration);
      }
      if (typeof window.AlertBridge.setStrobeEnabled === "function") {
        window.AlertBridge.setStrobeEnabled(!!settings.strobe);
      }
      if (typeof window.AlertBridge.setVoiceEnabled === "function") {
        window.AlertBridge.setVoiceEnabled(!!settings.voice);
      }
      if (typeof window.AlertBridge.setAlarmVolume === "function") {
        window.AlertBridge.setAlarmVolume(parseInt(settings.volume, 10) || 0);
      }
      if (typeof window.AlertBridge.setPausedUntil === "function") {
        window.AlertBridge.setPausedUntil(settings.pausedUntil || 0);
      }
    } catch (err) {
      console.warn("pushSettingsToBridge falló:", err);
    }
  }

  function applyVolumeToAudio() {
    const base = Math.max(0, Math.min(1, settings.volume / 100));
    const type = currentAlert ? currentAlert.type : null;
    if (sirenAudio) {
      const m = sirenVolumeMultiplier(type);
      sirenAudio.volume = Math.max(0, Math.min(1, base * m));
    }
    if (voiceAudio) {
      const m = voiceVolumeMultiplier(type);
      voiceAudio.volume = Math.max(0, Math.min(1, base * m));
    }
  }

  function applyStrobeClass() {
    overlay.classList.toggle("is-nostrobe", !settings.strobe);
  }

  // --- Historial -------------------------------------------------------
  // El historial viene del server (último 50 alertas globales) y se
  // empuja vía socket "alerts:history". Como fallback (caso APK con app
  // legacy o cliente recién conectado) mantenemos también un cache local
  // en localStorage que se actualiza cuando llega una alert:start.
  let serverHistory = [];

  function loadLocalHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      return [];
    }
  }

  function saveLocalHistory(list) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch {
      /* ignore */
    }
  }

  function addLocalHistoryEntry(alert) {
    if (!alert || alert.__test) return;
    const list = loadLocalHistory();
    const entry = {
      type: alert.type,
      label: alert.label || alert.type,
      startedAt: alert.startedAt || Date.now(),
    };
    if (list.length && list[0].startedAt === entry.startedAt) return;
    list.unshift(entry);
    saveLocalHistory(list);
  }

  function effectiveHistory() {
    // Si tenemos historial del server, lo preferimos (tiene más metadatos).
    if (Array.isArray(serverHistory) && serverHistory.length > 0) {
      return serverHistory;
    }
    return loadLocalHistory();
  }

  function formatDateTime(ms) {
    try {
      return new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleString("es-AR");
    }
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return "—";
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m > 0) return m + "m " + s + "s";
    return s + " s";
  }

  function renderHistory() {
    const list = effectiveHistory();
    if (list.length === 0) {
      historyListEl.innerHTML =
        '<div class="history__empty">Todavía no se registraron alertas.</div>';
      return;
    }
    historyListEl.innerHTML = "";
    for (const e of list) {
      const details = document.createElement("details");
      details.className = "history__item";
      if (e.type === "simulacro") details.classList.add("is-simulacro");
      const summary = document.createElement("summary");
      summary.className = "history__item-summary";
      summary.innerHTML =
        '<div class="history__item-icon" aria-hidden="true">' +
        iconForType(e.type) +
        "</div>" +
        '<div class="history__item-main">' +
        '<div class="history__item-type">' + escapeHtml(e.label || e.type) + "</div>" +
        '<div class="history__item-time">' + formatDateTime(e.startedAt) + "</div>" +
        "</div>" +
        '<span class="history__item-arrow" aria-hidden="true">›</span>';
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "history__item-body";
      const rows = [];
      if (e.triggeredBy) {
        const role =
          e.triggeredBy === "admin"
            ? "Administrador"
            : e.triggeredBy === "operator"
              ? "Preceptor"
              : e.triggeredBy === "schedule"
                ? "Programada"
                : e.triggeredBy === "system"
                  ? "Sistema"
                  : e.triggeredBy;
        rows.push(["Disparada por", role]);
      }
      if (typeof e.recipients === "number") {
        let r = String(e.recipients) + " dispositivo" + (e.recipients === 1 ? "" : "s");
        if (typeof e.silenced === "number" && e.silenced > 0) {
          r += " (" + e.silenced + " silenciado" + (e.silenced === 1 ? "" : "s") + ")";
        }
        rows.push(["Recibido por", r]);
      }
      if (e.endedAt && e.durationMs) {
        const reason =
          e.endedReason === "timeout"
            ? " (terminó sola)"
            : e.endedReason === "manual"
              ? " (cortada manualmente)"
              : "";
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
        row.innerHTML =
          '<span class="history__item-row-label">' + escapeHtml(k) + "</span>" +
          '<span class="history__item-row-value">' + escapeHtml(v) + "</span>";
        body.appendChild(row);
      }
      details.appendChild(body);
      historyListEl.appendChild(details);
    }
  }

  function updateLastAlert(entry) {
    if (!entry) {
      const list = effectiveHistory();
      if (!list.length) {
        lastAlertText.textContent = "Ninguna";
        return;
      }
      entry = list[0];
    }
    lastAlertText.textContent = `${entry.label || entry.type} · ${formatDateTime(
      entry.startedAt,
    )}`;
  }

  // --- Recomendaciones (Guía rápida + overlay) -----------------------
  // Orden de aparición en la pestaña "Guía rápida". Si el admin agrega
  // tipos nuevos (o alguno del server viene fuera de la lista) los
  // pegamos al final.
  const INFO_RECS_ORDER = [
    "sismo", "incendio", "evacuacion", "medica", "intruso",
    "gas", "bomba", "tormenta", "simulacro", "custom",
  ];

  function renderInfoRecs() {
    if (!infoRecsListEl) return;
    infoRecsListEl.innerHTML = "";
    const keys = Object.keys(clientRecsState || {});
    const ordered = INFO_RECS_ORDER.filter((k) => keys.includes(k)).concat(
      keys.filter((k) => !INFO_RECS_ORDER.includes(k)).sort(),
    );
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
      summary.innerHTML =
        `<span class="info__icon" aria-hidden="true">${escapeHtml(r.icon || "")}</span>` +
        `<span>${escapeHtml(r.label || k)}</span>`;
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

  // Muestra las recomendaciones abajo del cartel negro durante una alerta.
  // `lines` viene en el payload de alert:start (snapshot del server). Si
  // está vacío, ocultamos el bloque (no mostramos "no hay recomendaciones"
  // en mitad de la alerta — queda más limpio).
  function renderAlertRecs(lines) {
    if (!alertRecsEl || !alertRecsListEl) return;
    alertRecsListEl.innerHTML = "";
    if (!Array.isArray(lines) || lines.length === 0) {
      alertRecsEl.hidden = true;
      return;
    }
    for (const line of lines) {
      if (typeof line !== "string" || !line.trim()) continue;
      const li = document.createElement("li");
      li.textContent = line.trim();
      alertRecsListEl.appendChild(li);
    }
    alertRecsEl.hidden = alertRecsListEl.children.length === 0;
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
    } catch {
      /* si falla silenciamos, no es crítico — la Guía queda con el placeholder */
    }
  }

  function iconForType(t) {
    switch ((t || "").toLowerCase()) {
      case "simulacro":
        return "🧪";
      case "incendio":
        return "🔥";
      case "sismo":
        return "🌐";
      case "evacuacion":
        return "🚪";
      case "intruso":
        return "🛡️";
      case "medica":
        return "🧑‍⚕️";
      case "gas":
        return "💨";
      case "bomba":
        return "💣";
      case "tormenta":
        return "⛈️";
      case "custom":
        return "📣";
      default:
        return "⚠️";
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      return (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c
      );
    });
  }

  // --- Status ----------------------------------------------------------
  function setStatus(text, state) {
    statusText.textContent = text;
    connStatusText.textContent = text;
    statusDot.classList.toggle("is-online", state === "online");
    statusDot.classList.toggle("is-offline", state === "offline");
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // --- Sirena ----------------------------------------------------------
  // Permitimos que el server mande una sirena custom por tipo de alerta
  // (ej. simulacro trae una sirena con voz incluida). Reutilizamos SIEMPRE
  // el mismo objeto Audio — Safari en iOS sólo "desbloquea" el elemento en
  // el que se llamó play() dentro del gesto del usuario. Si creáramos uno
  // nuevo al cambiar de sirena, ese nuevo elemento quedaría bloqueado y no
  // sonaría (exactamente el síntoma del iPhone: la voz se oye pero el mp3
  // de la sirena no). Por eso sólo cambiamos .src sobre el mismo Audio.
  function ensureSirenAudio(src) {
    const wanted = src || SIREN_SRC;
    if (!sirenAudio) {
      sirenAudio = new Audio(wanted);
      sirenAudio.loop = true;
      sirenAudio.preload = "auto";
      sirenAudio.__src = wanted;
    } else if ((sirenAudio.__src || "") !== wanted) {
      try {
        sirenAudio.pause();
      } catch {
        /* ignore */
      }
      try {
        sirenAudio.src = wanted;
        sirenAudio.load();
      } catch {
        /* ignore */
      }
      sirenAudio.__src = wanted;
    }
    applyVolumeToAudio();
    return sirenAudio;
  }

  function startSiren(src) {
    const audio = ensureSirenAudio(src);
    try {
      audio.currentTime = 0;
    } catch {
      /* ignore */
    }
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => console.warn("No se pudo reproducir la sirena:", err));
    }
  }

  function stopSiren() {
    if (!sirenAudio) return;
    try {
      sirenAudio.pause();
      sirenAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  // --- Voz -------------------------------------------------------------
  function resolveVoiceSrc(alertObj) {
    if (alertObj.type === "custom") {
      const remote =
        "/tts?text=" + encodeURIComponent(alertObj.label || "Alerta");
      return fetch(remote)
        .then((r) => {
          if (!r.ok) throw new Error("tts http " + r.status);
          return r.blob();
        })
        .then((blob) => {
          if (currentVoiceObjectUrl) {
            try {
              URL.revokeObjectURL(currentVoiceObjectUrl);
            } catch {
              /* ignore */
            }
          }
          currentVoiceObjectUrl = URL.createObjectURL(blob);
          return currentVoiceObjectUrl;
        });
    }
    return Promise.resolve(VOICE_BASE + alertObj.type + ".mp3");
  }

  function ensureVoiceAudio(src) {
    if (!voiceAudio) {
      voiceAudio = new Audio(src);
      voiceAudio.preload = "auto";
    } else if (voiceAudio.src.indexOf(src) === -1) {
      voiceAudio.src = src;
      try {
        voiceAudio.load();
      } catch {
        /* ignore */
      }
    }
    applyVolumeToAudio();
    return voiceAudio;
  }

  function playVoiceOnce(src) {
    const audio = ensureVoiceAudio(src);
    try {
      audio.currentTime = 0;
    } catch {
      /* ignore */
    }
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => console.warn("No se pudo reproducir la voz:", err));
    }
  }

  function startSpeakingLoop(alertObj) {
    stopSpeakingLoop();
    if (!settings.voice) return;
    // Algunas alertas (ej. simulacro) traen la voz incluida en el propio
    // mp3 de la sirena — en ese caso el server manda skipVoice=true y no
    // superponemos la voz de Google.
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
      })
      .catch((err) => {
        console.warn("No se pudo preparar la voz:", err);
      });
  }

  function stopSpeakingLoop() {
    if (voiceTimer) {
      clearInterval(voiceTimer);
      voiceTimer = null;
    }
    if (voiceAudio) {
      try {
        voiceAudio.pause();
        voiceAudio.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
    if (currentVoiceObjectUrl) {
      try {
        URL.revokeObjectURL(currentVoiceObjectUrl);
      } catch {
        /* ignore */
      }
      currentVoiceObjectUrl = null;
    }
  }

  // --- Vibración -------------------------------------------------------
  function startVibration() {
    if (!settings.vibration) return;
    if (!("vibrate" in navigator)) return;
    const tick = () => {
      try {
        navigator.vibrate([600, 300]);
      } catch {
        /* ignore */
      }
    };
    tick();
    if (vibrationTimer) clearInterval(vibrationTimer);
    vibrationTimer = setInterval(tick, 900);
  }

  function stopVibration() {
    if (vibrationTimer) {
      clearInterval(vibrationTimer);
      vibrationTimer = null;
    }
    if ("vibrate" in navigator) {
      try {
        navigator.vibrate(0);
      } catch {
        /* ignore */
      }
    }
  }

  // --- Overlay ---------------------------------------------------------
  function showAlert(alert) {
    // Si el usuario ya descartó esta misma alerta en este equipo, ignoramos
    // los replays del server (al reconectar socket, al abrir otra pestaña,
    // etc.). Comparamos startedAt, que es único por alerta.
    if (
      alert &&
      alert.startedAt &&
      alert.startedAt === dismissedStartedAt
    ) {
      return;
    }
    currentAlert = alert;
    currentAlertIsTest = !!alert.__test;
    const label = alert.label || alert.type;
    alertTypeEl.textContent = label;

    overlay.classList.remove("is-simulacro");
    if (alert.type === "simulacro" || currentAlertIsTest) {
      overlay.classList.add("is-simulacro");
    }
    applyStrobeClass();
    overlay.hidden = false;
    if (app) app.setAttribute("aria-hidden", "true");

    // Si la alerta ya venció (ej. el server la replay-ea a un cliente que
    // se conecta justo al final), salimos sin arrancar sirena ni timer para
    // no escuchar 250ms de sirena antes del cleanup.
    const remaining0 = alert.endsAt - Date.now();
    if (remaining0 <= 0) {
      hideAlert();
      return;
    }

    const update = () => {
      const remaining = alert.endsAt - Date.now();
      alertTimeEl.textContent = formatRemaining(remaining);
      if (remaining <= 0) {
        hideAlert();
      }
    };
    update();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(update, 250);

    // Dentro del APK, el servicio Android se encarga de la sirena, la voz
    // y la vibración — no las duplicamos en la WebView para evitar solapes.
    // Excepción: cuando se prueba la alerta desde "Ajustes" con __runLocally
    // (fallback si el puente nativo no está), reproducimos todo en el webview
    // para que el usuario escuche algo aunque no haya servicio disponible.
    // En modo "silenciado por horario", el server / cliente marca la alerta
    // con muteSound/muteVoice/muteVibration. Mostramos el cartel pero no
    // arrancamos audio ni vibración.
    const muteSound = !!alert.muteSound;
    const muteVoice = !!alert.muteVoice;
    const muteVibration = !!alert.muteVibration;
    if (!IS_APK || alert.__runLocally) {
      if ((enabled || alert.__runLocally) && !muteSound) {
        startSiren(alert.sirenUrl || null);
      }
      if ((enabled || alert.__runLocally) && !muteVoice) {
        startSpeakingLoop(alert);
      }
      if (!muteVibration) startVibration();
    }
    if (!muteSound && !muteVoice && !muteVibration) {
      reportClientState("alerting");
    }

    refreshAlertUnlockHint();

    if (!currentAlertIsTest) addLocalHistoryEntry(alert);

    // Recomendaciones debajo del cartel negro. Si el server incluyó lines
    // en el payload las usamos tal cual; si no (ej. alerta vieja o test
    // local que no pasa por server), caemos al estado cacheado del tipo.
    let recLines =
      alert && Array.isArray(alert.recommendations)
        ? alert.recommendations
        : null;
    if (!recLines) {
      const cached = clientRecsState[alert.type];
      recLines = cached && Array.isArray(cached.lines) ? cached.lines : [];
    }
    renderAlertRecs(recLines);
  }

  // Muestra/oculta el hint "Tocá la pantalla para escuchar la sirena"
  // arriba del overlay. Aparece SOLO cuando hay una alerta activa que tiene
  // que sonar en esta WebView (fuera del APK o en un test local) y el
  // usuario todavía no desbloqueó el audio. En iOS via PWA es el caso más
  // común — el usuario llega a la app por una notificación push y el audio
  // está bloqueado hasta que haga un tap dentro del documento.
  function refreshAlertUnlockHint() {
    if (!alertUnlockHint) return;
    const needsWebAudio =
      currentAlert &&
      (!IS_APK || currentAlert.__runLocally) &&
      !enabled;
    alertUnlockHint.hidden = !needsWebAudio;
  }

  function hideAlert() {
    currentAlert = null;
    currentAlertIsTest = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    overlay.hidden = true;
    if (app) app.removeAttribute("aria-hidden");
    renderAlertRecs([]);
    stopSiren();
    stopSpeakingLoop();
    stopVibration();
    refreshAlertUnlockHint();
    // Volvemos a "idle" así el server (y por ende el panel del host) ven
    // al dispositivo como en escucha. Sin esto, lastClientState se queda
    // en "alerting" y la dedupe de reportClientState() saltea el envío
    // del próximo "alerting" en la siguiente alerta — el host vería al
    // celu como verde aunque la alerta esté sonando.
    reportClientState("idle");
  }

  function dismissLocally() {
    if (!currentAlert) return;
    // Recordamos el startedAt ANTES de llamar a hideAlert() (que limpia
    // currentAlert), así sobrevive al re-envio de alert:start del server.
    if (currentAlert.startedAt) {
      dismissedStartedAt = currentAlert.startedAt;
    }
    hideAlert();
  }

  alertCloseBtn.addEventListener("click", dismissLocally);

  // --- Activar audio ---------------------------------------------------
  // Esto "desbloquea" el audio del navegador: hay que llamar a play() dentro
  // del click del usuario al menos una vez para que después podamos
  // reproducir sin interacción. Lo hacemos en mute y pausamos enseguida.
  // Devuelve una promise que resuelve cuando el warm-up terminó, para que el
  // caller no arranque audio real encima del mute y se pise.
  function warmUpAudio(audio) {
    if (!audio) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          /* ignore */
        }
        audio.muted = false;
        resolve();
      };
      try {
        audio.muted = true;
        const warm = audio.play();
        if (warm && typeof warm.then === "function") {
          warm.then(finish).catch(() => {
            audio.muted = false;
            resolve();
          });
        } else {
          finish();
        }
      } catch {
        audio.muted = false;
        resolve();
      }
    });
  }

  function markEnabled() {
    enabled = true;
    enableBtn.textContent = "Sonido activado ✓";
    enableBtn.disabled = true;
    enableBtn.classList.add("is-enabled");
    audioStatusText.textContent = "Activo";
    audioStatusText.classList.add("is-positive");
    if (enableCard) enableCard.classList.add("is-done");
    refreshAlertUnlockHint();
  }

  // Desbloquea el audio del navegador y, si hay una alerta activa que
  // necesita sirena/voz en la WebView, la arranca. Es idempotente: se
  // puede llamar desde cualquier user-gesture (el botón "Activar sonido
  // y voz", un click en el overlay de alerta, o el primer tap en
  // cualquier lado). Devuelve la promise del warm-up por si el caller
  // quiere encadenar algo.
  function unlockAudioAndPlayCurrent() {
    // Capturamos la alerta activa ahora: si el warm-up tarda y la alerta
    // termina mientras tanto, no queremos arrancar una sirena "huérfana".
    const pending = currentAlert;
    const wasEnabled = enabled;
    markEnabled();
    // Si ya hay una alerta activa con sirena custom (ej. simulacro usa
    // /sounds/siren-simulacro.mp3), tenemos que calentar ESE audio y no el
    // default — si no, pisaríamos el audio actual con el default.
    const warmSirenSrc = pending && pending.sirenUrl ? pending.sirenUrl : null;
    return Promise.all([
      warmUpAudio(ensureSirenAudio(warmSirenSrc)),
      warmUpAudio(ensureVoiceAudio(VOICE_BASE + "simulacro.mp3")),
    ]).then(() => {
      // Después del warm-up, recién ahí arrancamos la sirena real — así no
      // se pisa con el audio.pause() del finish() del warm-up. Solo
      // arrancamos si hay alerta viva y estábamos desbloqueando por una
      // alerta activa (no si el user clickeó el botón "Activar" sin alerta
      // en curso — ese caso ya estaba cubierto por el flujo viejo).
      if (pending && currentAlert === pending && !wasEnabled) {
        if (!IS_APK || pending.__runLocally) {
          startSiren(pending.sirenUrl || null);
          startSpeakingLoop(pending);
        }
      }
    });
  }

  enableBtn.addEventListener("click", () => {
    unlockAudioAndPlayCurrent();
  });

  // Tap en el overlay de alerta: si el audio está bloqueado, lo
  // desbloqueamos y arrancamos la sirena. Esto resuelve el caso tipico
  // de iPad/iPhone: usuario recibe push, toca la notificacion, la PWA
  // abre con la alerta pero iOS Safari no deja que suene la sirena hasta
  // un user-gesture dentro del documento. Con este listener, basta con
  // tocar cualquier parte del overlay rojo para que arranque el sonido.
  // Excluimos el boton X (cierre) para que un tap accidental ahi no
  // arranque la sirena cuando el usuario quiso cerrar.
  overlay.addEventListener("click", (ev) => {
    if (enabled) return;
    if (!currentAlert) return;
    if (IS_APK && !currentAlert.__runLocally) return;
    if (alertCloseBtn && alertCloseBtn.contains(ev.target)) return;
    unlockAudioAndPlayCurrent();
  });

  // Ultimo recurso: cualquier user-gesture dentro de la pagina desbloquea
  // el audio silenciosamente. Util si el usuario entra a la app antes de
  // recibir la alerta (pasa a una pestaña, toca un boton, etc.) — queda
  // desbloqueado y cuando llegue una alerta, suena sin que tenga que
  // volver a tocar nada. Listener 'once' se remueve solo despues del
  // primer disparo.
  function silentWarmup() {
    warmUpAudio(ensureSirenAudio(null));
    warmUpAudio(ensureVoiceAudio(VOICE_BASE + "simulacro.mp3"));
    markEnabled();
  }
  document.addEventListener("pointerdown", silentWarmup, { once: true });
  document.addEventListener("touchstart", silentWarmup, {
    once: true,
    passive: true,
  });

  // --- Nombre del dispositivo ------------------------------------------
  // Lo que muestra el panel del host. Persiste en localStorage y se manda
  // al server cada vez que conectamos / cambia.
  function loadDeviceName() {
    try {
      const raw = localStorage.getItem(DEVICE_KEY);
      if (!raw) return "";
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.name === "string") return parsed.name;
    } catch {
      /* ignore */
    }
    return "";
  }
  function saveDeviceName(name) {
    try {
      localStorage.setItem(DEVICE_KEY, JSON.stringify({ name }));
    } catch {
      /* ignore */
    }
  }
  let deviceName = loadDeviceName();
  if (deviceNameInput) deviceNameInput.value = deviceName;

  function setDeviceNameStatus(msg, ok) {
    if (!deviceNameStatus) return;
    if (!msg) {
      deviceNameStatus.hidden = true;
      deviceNameStatus.textContent = "";
      return;
    }
    deviceNameStatus.hidden = false;
    deviceNameStatus.textContent = msg;
    deviceNameStatus.classList.toggle("is-positive", !!ok);
  }

  if (deviceNameSaveBtn) {
    deviceNameSaveBtn.addEventListener("click", () => {
      const v = (deviceNameInput.value || "").trim().slice(0, 60);
      if (!v) {
        setDeviceNameStatus("Poné un nombre (no puede estar vacío).", false);
        return;
      }
      deviceName = v;
      saveDeviceName(deviceName);
      identifyToServer();
      pushDeviceNameToBridge();
      setDeviceNameStatus("Nombre guardado: " + deviceName, true);
    });
  }

  function pushDeviceNameToBridge() {
    if (!bridgeAvailable() ||
        typeof window.AlertBridge.setDeviceName !== "function") return;
    try {
      window.AlertBridge.setDeviceName(deviceName || "");
    } catch (err) {
      console.warn("AlertBridge.setDeviceName falló:", err);
    }
  }

  // Empujamos el CLIENT_ID al servicio nativo del APK así, cuando éste
  // se conecta por su propio socket (independiente del webview), manda
  // el mismo clientId al server. Sin esto el server veía el socket
  // nativo y el del webview como dos dispositivos distintos y se veían
  // duplicados en el panel de Dispositivos del host.
  function pushClientIdToBridge() {
    if (!bridgeAvailable() ||
        typeof window.AlertBridge.setClientId !== "function") return;
    try {
      window.AlertBridge.setClientId(CLIENT_ID || "");
    } catch (err) {
      console.warn("AlertBridge.setClientId falló:", err);
    }
  }
  pushClientIdToBridge();

  // --- Silenciar por horario -------------------------------------------
  // Distinto de la pausa manual. La pausa: te quita las alertas por X
  // tiempo. El silencio por horario: durante una franja del día (y los
  // días que elegiste), las alertas llegan pero sin sirena/voz/vibración.
  function loadSilentWindow() {
    try {
      const raw = localStorage.getItem(SILENT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* ignore */
    }
    return null;
  }
  function saveSilentWindow(sw) {
    try {
      localStorage.setItem(SILENT_KEY, JSON.stringify(sw));
    } catch {
      /* ignore */
    }
  }
  let silentWindow = loadSilentWindow() || {
    enabled: false,
    from: "22:00",
    to: "07:00",
    days: [1, 2, 3, 4, 5], // Lun-Vie
  };

  function applySilentWindowToUI() {
    if (silentEnabled) silentEnabled.checked = !!silentWindow.enabled;
    if (silentFromEl && silentWindow.from) silentFromEl.value = silentWindow.from;
    if (silentToEl && silentWindow.to) silentToEl.value = silentWindow.to;
    if (silentDaysEl) {
      const chips = silentDaysEl.querySelectorAll(".day-chip");
      const sel = new Set((silentWindow.days || []).map(Number));
      chips.forEach((chip) => {
        const d = parseInt(chip.getAttribute("data-day"), 10);
        chip.classList.toggle("is-on", sel.has(d));
      });
    }
    if (silentFields) silentFields.hidden = !silentWindow.enabled;
    renderSilentSummary();
  }

  function renderSilentSummary() {
    if (!silentSummary) return;
    if (!silentWindow.enabled) {
      silentSummary.textContent = "Desactivado";
      return;
    }
    const days = (silentWindow.days || []).slice().sort();
    const names = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    let dayStr;
    if (days.length === 0) dayStr = "ningún día";
    else if (days.length === 7) dayStr = "todos los días";
    else dayStr = days.map((d) => names[d]).join(" · ");
    silentSummary.textContent =
      "De " + (silentWindow.from || "?") + " a " +
      (silentWindow.to || "?") + " · " + dayStr;
  }

  function isInSilentWindow() {
    if (!silentWindow || !silentWindow.enabled) return false;
    const days = silentWindow.days || [];
    if (!days.length) return false;
    const now = new Date();
    const day = now.getDay(); // 0=Dom..6=Sáb
    const from = parseHHMM(silentWindow.from);
    const to = parseHHMM(silentWindow.to);
    if (from == null || to == null) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    if (from === to) return false;
    if (from < to) {
      // Misma noche (ej. 12:00 a 14:00). Tiene que estar el día actual.
      if (!days.includes(day)) return false;
      return cur >= from && cur < to;
    }
    // Cruza medianoche (ej. 22:00 a 07:00).
    // Si estamos antes de medianoche: contamos el día actual.
    // Si estamos después: contamos el día anterior.
    if (cur >= from) {
      return days.includes(day);
    }
    if (cur < to) {
      const prev = (day + 6) % 7;
      return days.includes(prev);
    }
    return false;
  }

  function parseHHMM(s) {
    if (typeof s !== "string") return null;
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    if (isNaN(h) || isNaN(mn) || h < 0 || h > 23 || mn < 0 || mn > 59) return null;
    return h * 60 + mn;
  }

  function persistSilentWindow() {
    saveSilentWindow(silentWindow);
    applySilentWindowToUI();
    identifyToServer();
    pushSilentWindowToBridge();
  }

  function pushSilentWindowToBridge() {
    if (!bridgeAvailable() ||
        typeof window.AlertBridge.setSilentWindow !== "function") return;
    try {
      const days = (silentWindow.days || []).join(",");
      window.AlertBridge.setSilentWindow(
        !!silentWindow.enabled,
        silentWindow.from || "",
        silentWindow.to || "",
        days,
      );
    } catch (err) {
      console.warn("AlertBridge.setSilentWindow falló:", err);
    }
  }

  if (silentEnabled) {
    silentEnabled.addEventListener("change", () => {
      silentWindow.enabled = !!silentEnabled.checked;
      persistSilentWindow();
    });
  }
  if (silentFromEl) {
    silentFromEl.addEventListener("change", () => {
      silentWindow.from = silentFromEl.value;
      persistSilentWindow();
    });
  }
  if (silentToEl) {
    silentToEl.addEventListener("change", () => {
      silentWindow.to = silentToEl.value;
      persistSilentWindow();
    });
  }
  if (silentDaysEl) {
    silentDaysEl.addEventListener("click", (ev) => {
      const chip = ev.target.closest(".day-chip");
      if (!chip) return;
      const d = parseInt(chip.getAttribute("data-day"), 10);
      if (isNaN(d)) return;
      const cur = new Set((silentWindow.days || []).map(Number));
      if (cur.has(d)) cur.delete(d);
      else cur.add(d);
      silentWindow.days = Array.from(cur).sort((a, b) => a - b);
      persistSilentWindow();
    });
  }

  applySilentWindowToUI();

  // --- Estado y comunicación con el server -----------------------------
  let lastClientState = "idle";
  function reportClientState(state) {
    if (state === lastClientState) return;
    lastClientState = state;
    try {
      socket.emit("client:state", { state });
    } catch {
      /* ignore */
    }
  }

  function identifyToServer() {
    try {
      socket.emit("client:identify", {
        clientId: CLIENT_ID,
        name: deviceName || "",
        silentWindow: silentWindow,
        isApk: IS_APK,
      });
    } catch {
      /* ignore */
    }
  }

  // --- Tabs ------------------------------------------------------------
  const tabButtons = document.querySelectorAll(".tabs__btn");
  const tabSections = document.querySelectorAll(".tab");
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab-target");
      tabButtons.forEach((b) =>
        b.classList.toggle("is-active", b === btn),
      );
      tabSections.forEach((sec) => {
        sec.hidden = sec.getAttribute("data-tab") !== target;
      });
      if (target === "history") renderHistory();
    });
  });

  // --- Settings handlers ----------------------------------------------
  function persistAndApply() {
    saveSettings(settings);
    applyVolumeToAudio();
    applyStrobeClass();
  }

  setVibration.addEventListener("change", () => {
    settings.vibration = setVibration.checked;
    persistAndApply();
    if (bridgeAvailable() &&
        typeof window.AlertBridge.setVibrationEnabled === "function") {
      try {
        window.AlertBridge.setVibrationEnabled(!!settings.vibration);
      } catch (err) {
        console.warn("AlertBridge.setVibrationEnabled falló:", err);
      }
    }
    if (!settings.vibration) stopVibration();
    else if (currentAlert) startVibration();
  });

  setStrobe.addEventListener("change", () => {
    settings.strobe = setStrobe.checked;
    persistAndApply();
    if (bridgeAvailable() &&
        typeof window.AlertBridge.setStrobeEnabled === "function") {
      try {
        window.AlertBridge.setStrobeEnabled(!!settings.strobe);
      } catch (err) {
        console.warn("AlertBridge.setStrobeEnabled falló:", err);
      }
    }
  });

  setVoice.addEventListener("change", () => {
    settings.voice = setVoice.checked;
    persistAndApply();
    if (bridgeAvailable() &&
        typeof window.AlertBridge.setVoiceEnabled === "function") {
      try {
        window.AlertBridge.setVoiceEnabled(!!settings.voice);
      } catch (err) {
        console.warn("AlertBridge.setVoiceEnabled falló:", err);
      }
    }
    if (!settings.voice) stopSpeakingLoop();
    else if (currentAlert) startSpeakingLoop(currentAlert);
  });

  setVolume.addEventListener("input", () => {
    settings.volume = parseInt(setVolume.value, 10) || 0;
    volumeLabel.textContent = settings.volume + " %";
    persistAndApply();
    // En el APK, el audio lo maneja el servicio Android (stream ALARM). El
    // slider del webview no puede tocar el volumen de ese stream desde JS,
    // así que usamos un puente Java expuesto por MainActivity.
    if (bridgeAvailable() &&
        typeof window.AlertBridge.setAlarmVolume === "function") {
      try {
        window.AlertBridge.setAlarmVolume(settings.volume);
      } catch (err) {
        console.warn("AlertBridge.setAlarmVolume falló:", err);
      }
    }
  });

  clearHistoryBtn.addEventListener("click", () => {
    if (!confirm("¿Seguro que querés borrar el historial local?")) return;
    localStorage.removeItem(HISTORY_KEY);
    // El historial que se muestra ahora viene del server (preferido sobre
    // el cache local). Si no vaciamos también la copia en memoria, el
    // botón parece no hacer nada — la lista se sigue viendo idéntica.
    // El próximo "alerts:history" del server lo repuebla solo.
    serverHistory = [];
    renderHistory();
    updateLastAlert();
  });

  testAlertBtn.addEventListener("click", () => {
    if (currentAlert) return;
    // En el APK, pedimos al servicio Android que dispare una alerta de
    // prueba (5 seg) con sirena + voz + flash + vibración nativos. Si no
    // está disponible el puente, caemos a una simulación dentro del webview.
    if (
      IS_APK &&
      typeof window.AlertBridge !== "undefined" &&
      typeof window.AlertBridge.testAlert === "function"
    ) {
      try {
        window.AlertBridge.testAlert();
        return;
      } catch (err) {
        console.warn("AlertBridge.testAlert falló:", err);
      }
    }
    if (!enabled && !IS_APK) {
      alert(
        'Primero tocá "Activar sonido y voz" en la pestaña Inicio para que se escuche la sirena.',
      );
      return;
    }
    const fake = {
      type: "simulacro",
      label: "Prueba (5 seg)",
      startedAt: Date.now(),
      endsAt: Date.now() + 5000,
      __test: true,
      __runLocally: true,
    };
    showAlert(fake);
    setTimeout(() => {
      if (currentAlert === fake) hideAlert();
    }, 5000);
  });

  resetDataBtn.addEventListener("click", () => {
    if (
      !confirm(
        "Esto borra el historial y vuelve los ajustes a sus valores por defecto. ¿Continuar?",
      )
    )
      return;
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    // Mismo motivo que en clearHistoryBtn: limpiamos también la copia
    // del historial que vino del server, si no la lista visible no se vacía.
    serverHistory = [];
    settings = loadSettings();
    applySettingsToUI(); // ya empuja los defaults al AlertBridge
    renderHistory();
    updateLastAlert();
  });

  // --- Socket ----------------------------------------------------------
  socket.on("connect", () => {
    setStatus("En línea · esperando alertas", "online");
    socket.emit("role:client", { clientId: CLIENT_ID });
    identifyToServer();
    // Reportamos estado actual al reconectar.
    lastClientState = "";
    if (currentAlert) reportClientState("alerting");
    else if (isPaused()) reportClientState("paused");
    else if (isInSilentWindow()) reportClientState("silenced");
    else reportClientState("idle");
  });
  socket.on("client:renamed", (payload) => {
    if (!payload || typeof payload.name !== "string") return;
    const name = payload.name.trim().slice(0, 60);
    if (!name) return;
    deviceName = name;
    saveDeviceName(deviceName);
    if (deviceNameInput) deviceNameInput.value = deviceName;
    setDeviceNameStatus("El admin renombró este dispositivo: " + deviceName, true);
    pushDeviceNameToBridge();
  });
  socket.on("alerts:history", (payload) => {
    if (!payload || !Array.isArray(payload.history)) return;
    serverHistory = payload.history;
    renderHistory();
    updateLastAlert();
  });
  socket.on("disconnect", () => setStatus("Desconectado", "offline"));
  socket.on("connect_error", () => setStatus("Error de conexión", "offline"));

  socket.on("alert:start", (alert) => {
    // Si el usuario pausó las notificaciones en este dispositivo, ignoramos
    // la alerta del server (no hay overlay, ni sirena, ni voz). El server
    // igual respeta la pausa a nivel de push notifs (via /push/pause), pero
    // chequeamos acá también por si la alerta llega por socket antes de que
    // el server haya registrado la pausa o si no hay suscripción push.
    if (isPaused()) {
      // Igual guardamos el historial para que si después despausa, tenga
      // registro de lo que pasó mientras no estaba recibiendo.
      if (!alert.__test) addLocalHistoryEntry(alert);
      return;
    }
    // Silenciar por horario: NO mostramos overlay, NO suena, NO vibra,
    // NO hace flash. El dispositivo queda 100% en silencio durante la
    // franja. Igual la guardamos en el historial local así el usuario
    // puede revisar después qué alertas pasó si miraba.
    if (!alert.__test && isInSilentWindow()) {
      reportClientState("silenced");
      addLocalHistoryEntry(alert);
      return;
    }
    showAlert(alert);
  });
  socket.on("recommendations:update", (payload) => {
    if (!payload || typeof payload.recommendations !== "object") return;
    clientRecsState = payload.recommendations;
    renderInfoRecs();
  });
  socket.on("alert:stop", () => {
    // Cuando la alerta realmente termina en el server, reseteamos el
    // guardián para que la próxima alerta (aunque sea del mismo tipo)
    // sí se muestre.
    dismissedStartedAt = 0;
    hideAlert();
  });

  // --- APK tweaks ------------------------------------------------------
  // En el APK, la sirena/voz/flash/vibración los maneja el servicio nativo.
  // Ocultamos el botón "Activar sonido y voz" (no hace falta) y avisamos al
  // usuario. También tildamos como activo el estado de audio.
  if (IS_APK) {
    enabled = true;
    audioStatusText.textContent = "Gestionado por la app";
    audioStatusText.classList.add("is-positive");
    if (enableCard) {
      enableCard.innerHTML =
        '<div class="card__title">Modo app</div>' +
        '<div class="card__body">' +
        '<p class="card__text" style="margin:0">' +
        "La sirena, voz, flash de la cámara y vibración se manejan " +
        "automáticamente por la app — funciona aún con la pantalla bloqueada o " +
        "la app minimizada." +
        "</p>" +
        "</div>";
      enableCard.classList.add("is-done");
    }
    // "Probar alerta": en el APK lo deriva al servicio nativo vía el puente
    // AlertBridge.testAlert(). Si el puente no está (APK viejo contra este
    // JS nuevo) el click cae a una simulación dentro del webview.
    if (testAlertBtn) {
      testAlertBtn.title =
        "Dispara una alerta local de 5 segundos con sirena, flash y vibración para verificar que todo funciona.";
    }
  }

  // --- Web Push (iOS 16.4+, Android Chrome, desktop) -------------------
  // Permite recibir notificaciones aunque la app esté cerrada o el celu
  // bloqueado. Requiere:
  //  - Service worker registrado (public/sw.js).
  //  - Suscripción al PushManager con la clave VAPID del server.
  //  - En iOS: la PWA debe estar instalada en la pantalla de inicio.
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isStandalonePWA() {
    return (
      (window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true
    );
  }

  function pushSupported() {
    return (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  function setPushStatus(msg) {
    if (!pushStatus) return;
    if (!msg) {
      pushStatus.hidden = true;
      pushStatus.textContent = "";
      return;
    }
    pushStatus.hidden = false;
    pushStatus.textContent = msg;
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      return reg;
    } catch (err) {
      console.warn("[push] no se pudo registrar SW:", err);
      return null;
    }
  }

  async function subscribeToPush() {
    if (!pushSupported()) {
      setPushStatus("Tu navegador no soporta notificaciones push.");
      return;
    }
    // iOS sólo permite push si la PWA está instalada en pantalla de inicio.
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS && !isStandalonePWA()) {
      setPushStatus(
        "En iPhone, primero tenés que agregar la app a la pantalla de inicio (botón Compartir → Agregar a pantalla de inicio) y abrirla desde el ícono del home.",
      );
      return;
    }

    pushEnableBtn.disabled = true;
    try {
      const reg = await registerServiceWorker();
      if (!reg) {
        setPushStatus("No se pudo activar el service worker.");
        pushEnableBtn.disabled = false;
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushStatus(
          "Permiso de notificaciones denegado. Activalo desde Ajustes del sistema.",
        );
        pushEnableBtn.disabled = false;
        return;
      }
      const keyRes = await fetch("/vapid-public-key");
      if (!keyRes.ok) throw new Error("no vapid key");
      const { publicKey } = await keyRes.json();
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      await fetch("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
      setPushStatus("Notificaciones activadas ✓");
      pushEnableBtn.textContent = "Notificaciones activadas";
      pushEnableBtn.classList.add("is-enabled");
      pushEnableBtn.disabled = true;
    } catch (err) {
      console.warn("[push] error:", err);
      setPushStatus("No se pudieron activar las notificaciones: " + err.message);
      pushEnableBtn.disabled = false;
    }
  }

  async function initPushUI() {
    // Dentro del APK nativo no hace falta: el servicio Android ya recibe
    // las alertas por WebSocket y las muestra en pantalla completa.
    if (IS_APK) return;
    if (!pushCard) return;
    // Siempre mostramos la tarjeta: si el navegador no soporta push, le
    // damos un mensaje explicando qué falta (en vez de esconderla y que
    // parezca un bug).
    pushCard.hidden = false;
    if (!pushSupported()) {
      const flags = {
        sw: "serviceWorker" in navigator,
        pm: "PushManager" in window,
        n: "Notification" in window,
        standalone: isStandalonePWA(),
      };
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      let msg = "Este navegador no soporta notificaciones push.";
      if (isIOS && !flags.standalone) {
        msg =
          "En iPhone / iPad, las notificaciones push funcionan sólo si agregás la app a la pantalla de inicio (Compartir → Agregar a pantalla de inicio, con 'Abrir como app web' en ON) y la abrís desde el ícono del home.";
      } else if (isIOS && flags.standalone && !flags.pm) {
        msg =
          "Tu versión de iOS no soporta notificaciones push (se necesita iOS 16.4 o superior). Actualizá el sistema.";
      }
      setPushStatus(
        msg + " [debug sw=" + flags.sw + " pm=" + flags.pm + " n=" + flags.n +
          " standalone=" + flags.standalone + "]",
      );
      pushEnableBtn.disabled = true;
      return;
    }
    // Si ya había permiso previo, intentá rehidratar la suscripción.
    if (Notification.permission === "granted") {
      try {
        const reg = await registerServiceWorker();
        if (reg) {
          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            // Reenviamos la suscripción por si el server reinició y perdió
            // el archivo de subs (o simplemente para idempotencia).
            try {
              await fetch("/push/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(existing),
              });
            } catch {
              /* ignore */
            }
            setPushStatus("Notificaciones activadas ✓");
            pushEnableBtn.textContent = "Notificaciones activadas";
            pushEnableBtn.classList.add("is-enabled");
            pushEnableBtn.disabled = true;
            return;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (pushEnableBtn) {
      pushEnableBtn.addEventListener("click", subscribeToPush);
    }
  }

  // --- Init ------------------------------------------------------------
  applySettingsToUI();
  renderHistory();
  updateLastAlert();
  setStatus("Conectando…");
  initPushUI();
  loadRecsInitial();
})();
