// Archivo: client.js - OPTIMIZADO PARA DISPOSITIVOS ANTIGUOS
(function () {
  const socket = io();
  socket.io.opts.reconnection = true;
  socket.io.opts.reconnectionAttempts = Infinity;
  socket.io.opts.reconnectionDelay = 1000;

  // ── Listeners de alerta al tope ──
  socket.on("alert:start", (alert) => {
    if (isPaused()) { if (!alert.__test) addLocalHistoryEntry(alert); return; }
    if (!alert.__test && isInSilentWindow()) { reportClientState("silenced"); addLocalHistoryEntry(alert); return; }
    showAlert(alert);
  });
  socket.on("alert:stop", () => {
    dismissedStartedAt = 0;
    hideAlert();
  });

  const IS_APK = typeof window.AlertBridge !== "undefined" || /SchoolAlertsAPK|AlertaClienteAPK/i.test(navigator.userAgent || "");

  // --- DOM (lazy loading) -----------------------------------------------
  const app = document.getElementById("app");
  const overlay = document.getElementById("alertOverlay");
  const alertTypeEl = document.getElementById("alertType");
  const alertTimeEl = document.getElementById("alertTime");
  const alertCloseBtn = document.getElementById("alertCloseBtn");
  const enableBtn = document.getElementById("enableBtn");
  const enableCard = document.getElementById("enableCard");
  const setSirenVolume = document.getElementById("setSirenVolume");
  const sirenVolumeLabel = document.getElementById("sirenVolumeLabel");
  const setVoiceVolume = document.getElementById("setVoiceVolume");
  const voiceVolumeLabel = document.getElementById("voiceVolumeLabel");
  const testAlertBtn = document.getElementById("testAlertBtn");
  const resetDataBtn = document.getElementById("resetDataBtn");

  // --- Estado Global -------------------------------------------------------
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

  const SIREN_SRC = "/sounds/siren.mp3";
  const SIREN_TONES = { default: "/sounds/siren.mp3", eas: "/sounds/eas.mp3" };
  const VOICE_BASE = "/sounds/voice/";
  const VOICE_REPEAT_MS = 5000;
  const HISTORY_KEY = "alertas.history.v1";
  const SETTINGS_KEY = "alertas.settings.v1";
  const DEVICE_KEY = "alertas.device.v1";
  const SILENT_KEY = "alertas.silent.v1";
  const CLIENT_ID_KEY = "alertas.clientid.v1";

  // --- Configuración -------------------------------------------------------
  const defaultSettings = {
    vibration: true, strobe: true, voice: true, sirenTone: "default",
    sirenVolume: 100, voiceVolume: 100, pausedUntil: 0, connNotif: true,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
    } catch { return { ...defaultSettings }; }
  }

  function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { } }
  let settings = loadSettings();

  // --- Cliente ID ----------------------------------------------------------
  function getOrCreateClientId() {
    try {
      const existing = localStorage.getItem(CLIENT_ID_KEY);
      if (existing && typeof existing === "string" && existing.length > 0) return existing.slice(0, 64);
    } catch { }
    let id = "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(CLIENT_ID_KEY, id); } catch { }
    return id;
  }
  const CLIENT_ID = getOrCreateClientId();

  // --- Silenciar por horario -----------------------------------------------
  function loadSilentWindow() {
    try {
      const raw = localStorage.getItem(SILENT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  let silentWindow = loadSilentWindow() || { enabled: false, from: "22:00", to: "07:00", days: [1, 2, 3, 4, 5] };

  function isInSilentWindow() {
    if (!silentWindow || !silentWindow.enabled) return false;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const dayOfWeek = now.getDay();
    if (!silentWindow.days.includes(dayOfWeek)) return false;
    const [fromH, fromM] = silentWindow.from.split(':').map(Number);
    const [toH, toM] = silentWindow.to.split(':').map(Number);
    const fromMinutes = fromH * 60 + fromM;
    const toMinutes = toH * 60 + toM;
    if (fromMinutes <= toMinutes) {
      return currentMinutes >= fromMinutes && currentMinutes < toMinutes;
    } else {
      return currentMinutes >= fromMinutes || currentMinutes < toMinutes;
    }
  }

  function isPaused() { return settings.pausedUntil && settings.pausedUntil > Date.now(); }

  // --- Motor de Audio (Optimizado) -----------------------------------------
  function ensureSirenAudio(src) {
    const wanted = src || SIREN_SRC;
    if (!sirenAudio) {
      sirenAudio = new Audio(wanted);
      sirenAudio.loop = true;
      sirenAudio.preload = "auto";
      sirenAudio.__src = wanted;
    } else if ((sirenAudio.__src || "") !== wanted) {
      try { sirenAudio.pause(); } catch { }
      sirenAudio.src = wanted;
      sirenAudio.__src = wanted;
    }
    // Aplicar volumen de sirena
    if (sirenAudio) {
      const vol = (settings.sirenVolume || 100) / 100;
      sirenAudio.volume = Math.max(0, Math.min(1, vol));
    }
    return sirenAudio;
  }

  function startSiren(src) {
    const audio = ensureSirenAudio(src);
    try { audio.currentTime = 0; } catch { }
    const tryPlay = () => {
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };
    if (audio.readyState >= 2) tryPlay();
    else {
      const handler = () => {
        audio.removeEventListener("canplay", handler);
        if (currentAlert) tryPlay();
      };
      audio.addEventListener("canplay", handler, { once: true });
    }
  }

  function stopSiren() {
    if (!sirenAudio) return;
    try { sirenAudio.pause(); sirenAudio.currentTime = 0; } catch { }
  }

  // --- Voz -----------------------------------------------------------------
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

  function ensureVoiceAudio(src) {
    if (!voiceAudio) {
      voiceAudio = new Audio(src);
      voiceAudio.preload = "auto";
    } else if (voiceAudio.src.indexOf(src) === -1) {
      voiceAudio.src = src;
    }
    // Aplicar volumen de voz
    if (voiceAudio) {
      const vol = (settings.voiceVolume || 100) / 100;
      voiceAudio.volume = Math.max(0, Math.min(1, vol));
      voiceAudio.playbackRate = 1.2;
    }
    return voiceAudio;
  }

  function playVoiceOnce(src) {
    const audio = ensureVoiceAudio(src);
    try { audio.currentTime = 0; } catch { }
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
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
      }).catch(() => {});
  }

  function stopSpeakingLoop() {
    if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
    if (voiceAudio) { try { voiceAudio.pause(); voiceAudio.currentTime = 0; } catch { } }
    if (currentVoiceObjectUrl) { try { URL.revokeObjectURL(currentVoiceObjectUrl); } catch { } currentVoiceObjectUrl = null; }
  }

  // --- Vibración -----------------------------------------------------------
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

  // --- Overlay de Alerta ---------------------------------------------------
  function formatRemaining(ms) {
    const total = Math.ceil(ms / 1000);
    if (total <= 0) return "0:00";
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function showAlert(alert) {
    if (alert && alert.startedAt && alert.startedAt === dismissedStartedAt) return;

    currentAlert = alert;
    currentAlertIsTest = !!alert.__test;
    const label = alert.label || alert.type;
    alertTypeEl.textContent = label;

    overlay.classList.remove("is-simulacro");
    if (alert.type === "simulacro" || currentAlertIsTest) overlay.classList.add("is-simulacro");
    overlay.hidden = false;
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

    const muteSound = !!alert.muteSound;
    const muteVoice = !!alert.muteVoice;
    const muteVibration = !!alert.muteVibration;

    if (!IS_APK || alert.__runLocally) {
      if ((enabled || alert.__runLocally) && !muteSound) {
        const sirenSrc = alert.sirenUrl || (alert.type !== "simulacro" ? (SIREN_TONES[settings.sirenTone] || SIREN_SRC) : null);
        startSiren(sirenSrc);
      }
      if ((enabled || alert.__runLocally) && !muteVoice) startSpeakingLoop(alert);
      if (!muteVibration) startVibration();
    }

    if (!currentAlertIsTest) addLocalHistoryEntry(alert);
  }

  function hideAlert() {
    currentAlert = null;
    currentAlertIsTest = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    overlay.hidden = true;
    if (app) app.removeAttribute("aria-hidden");
    stopSiren();
    stopSpeakingLoop();
    stopVibration();
    reportClientState("idle");
  }

  function dismissLocally() {
    if (!currentAlert) return;
    if (currentAlert.startedAt) dismissedStartedAt = currentAlert.startedAt;
    hideAlert();
  }

  alertCloseBtn.addEventListener("click", dismissLocally);

  // --- Activar Audio -------------------------------------------------------
  function markEnabled() {
    enabled = true;
    enableBtn.textContent = "Sonido activado ✓";
    enableBtn.disabled = true;
    enableBtn.classList.add("is-enabled");
  }

  function unlockAudioAndPlayCurrent() {
    const pending = currentAlert;
    const wasEnabled = enabled;
    markEnabled();

    if (pending && currentAlert === pending && !wasEnabled) {
      if (!IS_APK || pending.__runLocally) {
        const unlockSrc = pending.sirenUrl || (pending.type !== "simulacro" ? (SIREN_TONES[settings.sirenTone] || SIREN_SRC) : null);
        startSiren(unlockSrc);
        startSpeakingLoop(pending);
      }
    }
  }

  enableBtn.addEventListener("click", () => { unlockAudioAndPlayCurrent(); });
  overlay.addEventListener("click", (ev) => {
    if (enabled || !currentAlert || (IS_APK && !currentAlert.__runLocally)) return;
    if (alertCloseBtn && alertCloseBtn.contains(ev.target)) return;
    unlockAudioAndPlayCurrent();
  });

  // Warmup en primer toque
  document.addEventListener("pointerdown", () => { markEnabled(); }, { once: true });
  document.addEventListener("touchstart", () => { markEnabled(); }, { once: true, passive: true });

  // --- Controles de Volumen ------------------------------------------------
  if (setSirenVolume) {
    setSirenVolume.addEventListener("input", () => {
      settings.sirenVolume = parseInt(setSirenVolume.value, 10) || 0;
      if (sirenVolumeLabel) sirenVolumeLabel.textContent = settings.sirenVolume + " %";
      if (sirenAudio) sirenAudio.volume = Math.max(0, Math.min(1, settings.sirenVolume / 100));
      saveSettings(settings);
    });
    setSirenVolume.value = String(settings.sirenVolume);
    if (sirenVolumeLabel) sirenVolumeLabel.textContent = settings.sirenVolume + " %";
  }

  if (setVoiceVolume) {
    setVoiceVolume.addEventListener("input", () => {
      settings.voiceVolume = parseInt(setVoiceVolume.value, 10) || 0;
      if (voiceVolumeLabel) voiceVolumeLabel.textContent = settings.voiceVolume + " %";
      if (voiceAudio) voiceAudio.volume = Math.max(0, Math.min(1, settings.voiceVolume / 100));
      saveSettings(settings);
    });
    setVoiceVolume.value = String(settings.voiceVolume);
    if (voiceVolumeLabel) voiceVolumeLabel.textContent = settings.voiceVolume + " %";
  }

  // --- Botones de Control --------------------------------------------------
  if (testAlertBtn) {
    testAlertBtn.addEventListener("click", () => {
      if (currentAlert) return;
      if (IS_APK && typeof window.AlertBridge !== "undefined" && typeof window.AlertBridge.testAlert === "function") {
        try { window.AlertBridge.testAlert(); return; } catch (err) {}
      }
      if (!enabled && !IS_APK) {
        alert('Primero tocá "Activar sonido y voz" en la pestaña Inicio para que se escuche la sirena.');
        return;
      }
      const fake = { type: "simulacro", label: "Simulacro", startedAt: Date.now(), endsAt: Date.now() + 5000, __test: true, __runLocally: true };
      showAlert(fake);
      setTimeout(() => { if (currentAlert === fake) hideAlert(); }, 5000);
    });
  }

  if (resetDataBtn) {
    resetDataBtn.addEventListener("click", () => {
      if (!confirm("Esto borra el historial y vuelve los ajustes a sus valores por defecto. ¿Continuar?")) return;
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(SETTINGS_KEY);
      settings = loadSettings();
      if (setSirenVolume) setSirenVolume.value = String(settings.sirenVolume);
      if (setVoiceVolume) setVoiceVolume.value = String(settings.voiceVolume);
      if (sirenVolumeLabel) sirenVolumeLabel.textContent = settings.sirenVolume + " %";
      if (voiceVolumeLabel) voiceVolumeLabel.textContent = settings.voiceVolume + " %";
    });
  }

  // --- Socket ---------------------------------------------------------------
  let lastPongAt = Date.now();

  socket.on("connect", () => {
    socket.emit("role:client", { clientId: CLIENT_ID });
    const silent = isInSilentWindow();
    if (currentAlert) reportClientState("alerting");
    else if (isPaused()) reportClientState("paused");
    else if (silent) reportClientState("silenced");
    else reportClientState("idle");
  });

  socket.on("disconnect", () => {
    // Mantener el estado actual
  });

  let lastClientState = "idle";
  function reportClientState(state) {
    if (state === lastClientState) return;
    lastClientState = state;
    try { socket.emit("client:state", { state }); } catch { }
  }

  // --- Historial Local (Minimalista) ----------------------------------------
  function addLocalHistoryEntry(alert) {
    try {
      const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      history.unshift({
        type: alert.type,
        label: alert.label,
        startedAt: alert.startedAt,
        endsAt: alert.endsAt,
      });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
    } catch { }
  }

  // --- Reconexión para iOS -------------------------------------------------
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (socket && socket.disconnected) {
        socket.connect();
      }
    }
  });

  // --- Inicialización -------------------------------------------------------
  if (setSirenVolume) setSirenVolume.value = String(settings.sirenVolume);
  if (setVoiceVolume) setVoiceVolume.value = String(settings.voiceVolume);
  if (sirenVolumeLabel) sirenVolumeLabel.textContent = settings.sirenVolume + " %";
  if (voiceVolumeLabel) voiceVolumeLabel.textContent = settings.voiceVolume + " %";
})();
