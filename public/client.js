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

  const historyListEl = document.getElementById("historyList");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const pushCard = document.getElementById("pushCard");
  const pushEnableBtn = document.getElementById("pushEnableBtn");
  const pushHelp = document.getElementById("pushHelp");
  const pushStatus = document.getElementById("pushStatus");
  const pauseSelect = document.getElementById("pauseSelect");
  const pauseStatus = document.getElementById("pauseStatus");
  const quietEnabled = document.getElementById("quietEnabled");
  const quietFrom = document.getElementById("quietFrom");
  const quietTo = document.getElementById("quietTo");
  const quietDaily = document.getElementById("quietDaily");
  const quietStatus = document.getElementById("quietStatus");
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

  const SIREN_SRC = "/sounds/siren.mp3";
  const VOICE_BASE = "/sounds/voice/";
  const VOICE_REPEAT_MS = 5000;
  const HISTORY_KEY = "alertas.history.v1";
  const SETTINGS_KEY = "alertas.settings.v1";
  const HISTORY_MAX = 50;

  // --- Settings --------------------------------------------------------
  const defaultSettings = {
    vibration: true,
    strobe: true,
    voice: true,
    volume: 100,
    // pausedUntil: ms timestamp. 0 = no pausado. Number.MAX_SAFE_INTEGER = pausa
    // indefinida (hasta que el usuario la desactive manualmente).
    pausedUntil: 0,
    // Silencio programado: franja horaria fija (ej. 22:00 a 06:00) en hora
    // de Buenos Aires durante la cual no queremos recibir alertas. Se
    // aplica a este dispositivo, es independiente del pause manual.
    // Si daily=false, se silencia sólo la próxima ocurrencia de la ventana
    // y después se auto-desactiva (usamos oneShotEndTs internamente para
    // saber cuándo fue la última ventana que aplicamos).
    quietHours: {
      enabled: false,
      from: "22:00",
      to: "06:00",
      daily: true,
      oneShotEndTs: 0,
    },
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...defaultSettings };
      const parsed = JSON.parse(raw);
      // Mergeamos shallow, pero quietHours es un objeto — si existe en
      // parsed usamos el parseado, si no el default. Si parsed.quietHours
      // existe pero le faltan campos (versión vieja), mergeamos con los
      // defaults para que no falle por campos undefined.
      const qh =
        parsed && typeof parsed.quietHours === "object" && parsed.quietHours
          ? { ...defaultSettings.quietHours, ...parsed.quietHours }
          : { ...defaultSettings.quietHours };
      return { ...defaultSettings, ...parsed, quietHours: qh };
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
    renderQuietHoursUI();
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
    // Lo mismo con silencio programado: si el one-shot venció, desarmar.
    tickQuietHours();
  }, 60 * 1000);

  // --- Silencio programado ---------------------------------------------
  // Franja horaria fija (ej. 22:00 a 06:00) durante la cual ignoramos
  // alertas en este dispositivo. Se evalúa en hora de Buenos Aires (igual
  // que el server, así coinciden). La lógica está duplicada intencionalmente
  // server-side (en /push/quiet-hours) porque las PWAs pueden estar
  // cerradas y sólo reciben alertas por push — el server tiene que saber
  // por sí mismo si silenciar.
  function parseHHMM(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
    if (!m) return null;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
  }

  function getBANowParts(atMs) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const parts = {};
      for (const p of fmt.formatToParts(new Date(atMs || Date.now()))) {
        if (p.type !== "literal") parts[p.type] = p.value;
      }
      const h = Number(parts.hour);
      const mi = Number(parts.minute);
      return {
        y: Number(parts.year),
        mo: Number(parts.month),
        d: Number(parts.day),
        h: h === 24 ? 0 : h,
        mi,
        minutesOfDay: (h === 24 ? 0 : h) * 60 + mi,
      };
    } catch {
      return null;
    }
  }

  // Construye un timestamp ms para "hoy (o hoy+dayOffset) en BA a las
  // minutesOfDay minutos". Argentina = UTC-03:00 fijo (no tiene DST).
  function timestampAtBAMinutes(minutesOfDay, dayOffset) {
    const now = getBANowParts();
    if (!now) return 0;
    const d = new Date(Date.UTC(now.y, now.mo - 1, now.d));
    d.setUTCDate(d.getUTCDate() + (dayOffset || 0));
    const h = Math.floor(minutesOfDay / 60);
    const mi = minutesOfDay % 60;
    const iso =
      d.getUTCFullYear() +
      "-" + String(d.getUTCMonth() + 1).padStart(2, "0") +
      "-" + String(d.getUTCDate()).padStart(2, "0") +
      "T" + String(h).padStart(2, "0") +
      ":" + String(mi).padStart(2, "0") +
      ":00-03:00";
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // True si ahora mismo estamos dentro de la ventana configurada.
  function isInQuietHours() {
    const q = settings.quietHours;
    if (!q || !q.enabled) return false;
    if (!q.daily && q.oneShotEndTs && Date.now() > q.oneShotEndTs) return false;
    const fromMin = parseHHMM(q.from);
    const toMin = parseHHMM(q.to);
    if (fromMin == null || toMin == null || fromMin === toMin) return false;
    const nowParts = getBANowParts();
    if (!nowParts) return false;
    const nowMin = nowParts.minutesOfDay;
    if (fromMin < toMin) {
      return nowMin >= fromMin && nowMin < toMin;
    }
    return nowMin >= fromMin || nowMin < toMin;
  }

  // Calcula cuándo termina la próxima ocurrencia (o la actual si estamos
  // adentro) de la ventana. Devuelve un timestamp ms. Se usa para el modo
  // one-shot (daily=false): una vez que Date.now() supera este valor, el
  // silencio se auto-desactiva.
  function computeOneShotEndTs(fromStr, toStr) {
    const fromMin = parseHHMM(fromStr);
    const toMin = parseHHMM(toStr);
    if (fromMin == null || toMin == null || fromMin === toMin) return 0;
    const durationMin = ((toMin - fromMin) + 24 * 60) % (24 * 60);
    const nowParts = getBANowParts();
    if (!nowParts) return 0;
    const nowMin = nowParts.minutesOfDay;
    const insideIntraday = fromMin < toMin
      ? (nowMin >= fromMin && nowMin < toMin)
      : false;
    const insideCrossing = fromMin > toMin
      ? (nowMin >= fromMin || nowMin < toMin)
      : false;
    let startDayOffset = 0;
    if (insideIntraday) {
      // Ventana actual arrancó hoy.
      startDayOffset = 0;
    } else if (insideCrossing) {
      // Si nowMin < toMin, la ventana arrancó ayer. Si no, arrancó hoy.
      startDayOffset = nowMin < toMin ? -1 : 0;
    } else {
      // Afuera de la ventana. Próxima ocurrencia: hoy si from todavía no
      // pasó, si no mañana.
      startDayOffset = nowMin < fromMin ? 0 : 1;
    }
    const startTs = timestampAtBAMinutes(fromMin, startDayOffset);
    if (!startTs) return 0;
    return startTs + durationMin * 60 * 1000;
  }

  function formatClockBA(ms) {
    try {
      return new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleTimeString("es-AR");
    }
  }

  function renderQuietHoursUI() {
    if (!quietEnabled || !quietFrom || !quietTo || !quietDaily) return;
    const q = settings.quietHours || {};
    quietEnabled.checked = !!q.enabled;
    quietFrom.value = /^\d{2}:\d{2}$/.test(q.from) ? q.from : "22:00";
    quietTo.value = /^\d{2}:\d{2}$/.test(q.to) ? q.to : "06:00";
    quietDaily.checked = q.daily !== false; // default true
    if (!quietStatus) return;
    if (!q.enabled) {
      quietStatus.hidden = true;
      quietStatus.textContent = "";
      return;
    }
    if (isInQuietHours()) {
      quietStatus.hidden = false;
      quietStatus.style.color = "#f59e0b";
      quietStatus.textContent =
        "⏸ Silenciado ahora (ventana " + q.from + "–" + q.to + ")";
    } else if (!q.daily && q.oneShotEndTs && Date.now() > q.oneShotEndTs) {
      // Expiró el one-shot: la UI real lo reseteará en el próximo tick.
      quietStatus.hidden = true;
      quietStatus.textContent = "";
    } else {
      quietStatus.hidden = false;
      quietStatus.style.color = "#64748b";
      const endTs = computeOneShotEndTs(q.from, q.to);
      const label = q.daily
        ? "Se silenciará todos los días " + q.from + " a " + q.to + " (hora AR)"
        : "Próxima ventana silenciada: "
          + q.from + " a " + q.to
          + (endTs ? " (termina " + formatClockBA(endTs) + ")" : "");
      quietStatus.textContent = label;
    }
  }

  async function syncQuietHoursWithServer() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      const q = settings.quietHours || {};
      await fetch("/push/quiet-hours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          quietHours: q.enabled
            ? {
                enabled: true,
                from: q.from,
                to: q.to,
                daily: !!q.daily,
                oneShotEndTs: q.oneShotEndTs || 0,
              }
            : null,
        }),
      });
    } catch (err) {
      console.warn("syncQuietHoursWithServer falló:", err);
    }
  }

  function pushQuietHoursToBridge() {
    try {
      if (
        typeof window.AlertBridge !== "undefined" &&
        window.AlertBridge !== null &&
        typeof window.AlertBridge.setQuietHours === "function"
      ) {
        const q = settings.quietHours || {};
        window.AlertBridge.setQuietHours(
          !!q.enabled,
          q.from || "",
          q.to || "",
          !!q.daily,
          q.oneShotEndTs || 0,
        );
      }
    } catch (err) {
      console.warn("AlertBridge.setQuietHours falló:", err);
    }
  }

  function onQuietHoursChanged() {
    const enabled = !!quietEnabled.checked;
    const from = /^\d{2}:\d{2}$/.test(quietFrom.value) ? quietFrom.value : "22:00";
    const to = /^\d{2}:\d{2}$/.test(quietTo.value) ? quietTo.value : "06:00";
    const daily = !!quietDaily.checked;
    const prev = settings.quietHours || {};
    const oneShotEndTs =
      enabled && !daily
        ? computeOneShotEndTs(from, to)
        : 0;
    settings.quietHours = { enabled, from, to, daily, oneShotEndTs };
    // Si el usuario tocó algo mientras había un one-shot activo, lo
    // recomputamos para la ventana nueva (no arrastramos un oneShotEndTs
    // viejo con los valores viejos).
    void prev;
    saveSettings(settings);
    renderQuietHoursUI();
    syncQuietHoursWithServer();
    pushQuietHoursToBridge();
  }

  if (quietEnabled) quietEnabled.addEventListener("change", onQuietHoursChanged);
  if (quietFrom) quietFrom.addEventListener("change", onQuietHoursChanged);
  if (quietTo) quietTo.addEventListener("change", onQuietHoursChanged);
  if (quietDaily) quietDaily.addEventListener("change", onQuietHoursChanged);

  function tickQuietHours() {
    const q = settings.quietHours;
    if (!q || !q.enabled) return;
    if (!q.daily && q.oneShotEndTs && Date.now() > q.oneShotEndTs) {
      // One-shot expiró: auto-desactivamos.
      settings.quietHours = { ...q, enabled: false, oneShotEndTs: 0 };
      saveSettings(settings);
      renderQuietHoursUI();
      syncQuietHoursWithServer();
      pushQuietHoursToBridge();
      return;
    }
    // Refresh UI para que el estado "silenciado ahora" se actualice al
    // entrar / salir de la ventana sin esperar que el usuario recargue.
    renderQuietHoursUI();
  }

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
      if (typeof window.AlertBridge.setQuietHours === "function") {
        const q = settings.quietHours || {};
        window.AlertBridge.setQuietHours(
          !!q.enabled,
          q.from || "",
          q.to || "",
          !!q.daily,
          q.oneShotEndTs || 0,
        );
      }
    } catch (err) {
      console.warn("pushSettingsToBridge falló:", err);
    }
  }

  function applyVolumeToAudio() {
    const v = Math.max(0, Math.min(1, settings.volume / 100));
    if (sirenAudio) sirenAudio.volume = v;
    if (voiceAudio) voiceAudio.volume = v;
  }

  function applyStrobeClass() {
    overlay.classList.toggle("is-nostrobe", !settings.strobe);
  }

  // --- Historial -------------------------------------------------------
  function loadHistory() {
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

  function saveHistory(list) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch {
      /* ignore */
    }
  }

  function addHistoryEntry(alert) {
    if (!alert || alert.__test) return;
    const list = loadHistory();
    const entry = {
      type: alert.type,
      label: alert.label || alert.type,
      startedAt: alert.startedAt || Date.now(),
    };
    // Evitar duplicados consecutivos (mismo startedAt).
    if (list.length && list[0].startedAt === entry.startedAt) return;
    list.unshift(entry);
    saveHistory(list);
    renderHistory();
    updateLastAlert(entry);
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

  function renderHistory() {
    const list = loadHistory();
    if (list.length === 0) {
      historyListEl.innerHTML =
        '<div class="history__empty">Todavía no recibiste ninguna alerta.</div>';
      return;
    }
    historyListEl.innerHTML = "";
    for (const e of list) {
      const row = document.createElement("div");
      row.className = "history__item";
      if (e.type === "simulacro") row.classList.add("is-simulacro");
      row.innerHTML = `
        <div class="history__item-main">
          <div class="history__item-type">${escapeHtml(e.label || e.type)}</div>
          <div class="history__item-time">${formatDateTime(e.startedAt)}</div>
        </div>
        <div class="history__item-icon" aria-hidden="true">${iconForType(e.type)}</div>
      `;
      historyListEl.appendChild(row);
    }
  }

  function updateLastAlert(entry) {
    if (!entry) {
      const list = loadHistory();
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
    if (!IS_APK || alert.__runLocally) {
      if (enabled || alert.__runLocally) {
        startSiren(alert.sirenUrl || null);
        startSpeakingLoop(alert);
      }
      startVibration();
    }

    refreshAlertUnlockHint();

    if (!currentAlertIsTest) addHistoryEntry(alert);
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
    stopSiren();
    stopSpeakingLoop();
    stopVibration();
    refreshAlertUnlockHint();
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
    settings = loadSettings();
    applySettingsToUI(); // ya empuja los defaults al AlertBridge
    renderHistory();
    updateLastAlert();
  });

  // --- Socket ----------------------------------------------------------
  socket.on("connect", () => {
    setStatus("En línea · esperando alertas", "online");
    socket.emit("role:client");
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
      if (!alert.__test) addHistoryEntry(alert);
      return;
    }
    // Silencio programado: misma idea que la pausa manual, pero en una
    // franja horaria fija (ej. 22:00 a 06:00). El server también chequea
    // esto a nivel push, pero acá lo reforzamos por si llega por socket.
    if (isInQuietHours()) {
      if (!alert.__test) addHistoryEntry(alert);
      return;
    }
    showAlert(alert);
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
})();
