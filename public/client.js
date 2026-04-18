(function () {
  const socket = io();

  // Detectamos si corremos dentro del APK nativo. En ese caso el servicio
  // Android se encarga de la sirena, la vibración, el flash de la cámara y
  // el overlay a pantalla completa (AlertActivity) aunque la app esté en
  // background o el celu bloqueado. Para no duplicar sirena/voz/flash, el JS
  // web sólo actualiza UI + historial.
  const IS_APK = /AlertaClienteAPK/i.test(navigator.userAgent || "");

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

  const historyListEl = document.getElementById("historyList");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
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
  let locallyDismissed = false;
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
  // (ej. simulacro trae una sirena con voz incluida). Si el alert.sirenUrl
  // es distinto al actual, recreamos el Audio para no mezclar.
  function ensureSirenAudio(src) {
    const wanted = src || SIREN_SRC;
    if (!sirenAudio || (sirenAudio.__src || "") !== wanted) {
      if (sirenAudio) {
        try {
          sirenAudio.pause();
        } catch {
          /* ignore */
        }
      }
      sirenAudio = new Audio(wanted);
      sirenAudio.loop = true;
      sirenAudio.preload = "auto";
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
    if (
      locallyDismissed &&
      currentAlert &&
      currentAlert.startedAt === alert.startedAt
    ) {
      return;
    }
    locallyDismissed = false;
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

    if (!currentAlertIsTest) addHistoryEntry(alert);
  }

  function hideAlert() {
    currentAlert = null;
    currentAlertIsTest = false;
    locallyDismissed = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    overlay.hidden = true;
    if (app) app.removeAttribute("aria-hidden");
    stopSiren();
    stopSpeakingLoop();
    stopVibration();
  }

  function dismissLocally() {
    if (!currentAlert) return;
    locallyDismissed = true;
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
  }

  enableBtn.addEventListener("click", () => {
    // Capturamos la alerta activa ahora: si el warm-up tarda y la alerta
    // termina mientras tanto, no queremos arrancar una sirena "huérfana".
    const pending = currentAlert;
    markEnabled();
    // Si ya hay una alerta activa con sirena custom (ej. simulacro usa
    // /sounds/siren-simulacro.mp3), tenemos que calentar ESE audio y no el
    // default — si no, pisaríamos el audio actual con el default.
    const warmSirenSrc = pending && pending.sirenUrl ? pending.sirenUrl : null;
    Promise.all([
      warmUpAudio(ensureSirenAudio(warmSirenSrc)),
      warmUpAudio(ensureVoiceAudio(VOICE_BASE + "simulacro.mp3")),
    ]).then(() => {
      // Después del warm-up, recién ahí arrancamos la sirena real — así no
      // se pisa con el audio.pause() del finish() del warm-up.
      if (pending && currentAlert === pending) {
        startSiren(pending.sirenUrl || null);
        startSpeakingLoop(pending);
      }
    });
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
    showAlert(alert);
  });
  socket.on("alert:stop", () => {
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

  // --- Init ------------------------------------------------------------
  applySettingsToUI();
  renderHistory();
  updateLastAlert();
  setStatus("Conectando…");
})();
