(function () {
  const socket = io();

  const idleEl = document.getElementById("idle");
  const statusEl = document.getElementById("status");
  const enableBtn = document.getElementById("enableBtn");
  const overlay = document.getElementById("alertOverlay");
  const alertTypeEl = document.getElementById("alertType");
  const alertTimeEl = document.getElementById("alertTime");

  let sirenAudio = null;
  let voiceAudio = null;
  let currentAlert = null;
  let tickTimer = null;
  let voiceTimer = null;
  let enabled = false;
  let currentVoiceObjectUrl = null; // blob URL para voces personalizadas (iOS friendly)

  const SIREN_SRC = "/sounds/siren.mp3";
  const VOICE_BASE = "/sounds/voice/";
  // Cuánto esperar entre repeticiones del audio de voz (ms).
  const VOICE_REPEAT_MS = 5000;

  function setStatus(text, state) {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-online", state === "online");
    statusEl.classList.toggle("is-offline", state === "offline");
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // --- Sirena (archivo MP3 en loop) -------------------------------------
  function ensureSirenAudio() {
    if (!sirenAudio) {
      sirenAudio = new Audio(SIREN_SRC);
      sirenAudio.loop = true;
      sirenAudio.preload = "auto";
      sirenAudio.volume = 1.0;
    }
    return sirenAudio;
  }

  function startSiren() {
    const audio = ensureSirenAudio();
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

  // --- Voz (archivo MP3 pre-generado con Google TTS) --------------------
  // iOS Safari es quisquilloso con cambiar el `src` de un <audio> sobre la
  // marcha: a veces queda mudo. Para el mensaje personalizado bajamos el MP3
  // con fetch() y lo convertimos a un Blob URL, así el <audio> lo ve como
  // un archivo local ya cargado y lo reproduce sin problemas.
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
      voiceAudio.volume = 1.0;
    } else if (voiceAudio.src.indexOf(src) === -1) {
      voiceAudio.src = src;
      // iOS Safari requiere load() después de cambiar src.
      try {
        voiceAudio.load();
      } catch {
        /* ignore */
      }
    }
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
    const myAlert = alertObj;
    resolveVoiceSrc(alertObj)
      .then((src) => {
        // Si mientras bajábamos el MP3 cambió/terminó la alerta, cortamos.
        if (!currentAlert || currentAlert !== myAlert) return;
        playVoiceOnce(src);
        voiceTimer = setInterval(() => {
          if (!currentAlert) return;
          // si el audio aun se está reproduciendo, no lo reinicies
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

  // --- Overlay ---------------------------------------------------------
  function showAlert(alert) {
    currentAlert = alert;
    const label = alert.label || alert.type;
    alertTypeEl.textContent = label;
    overlay.classList.toggle("is-simulacro", alert.type === "simulacro");
    overlay.hidden = false;
    idleEl.hidden = true;

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

    if (enabled) {
      startSiren();
      startSpeakingLoop(alert);
    }
  }

  function hideAlert() {
    currentAlert = null;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    overlay.hidden = true;
    idleEl.hidden = false;
    stopSiren();
    stopSpeakingLoop();
  }

  // --- Activar audio (gesto requerido por navegadores) ------------------
  function warmUpAudio(audio) {
    if (!audio) return;
    try {
      audio.muted = true;
      const warm = audio.play();
      const finish = () => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          /* ignore */
        }
        audio.muted = false;
      };
      if (warm && typeof warm.then === "function") {
        warm.then(finish).catch(() => {
          audio.muted = false;
        });
      } else {
        finish();
      }
    } catch {
      /* ignore */
    }
  }

  enableBtn.addEventListener("click", () => {
    enabled = true;
    // "Warm up" de los <audio> para desbloquear reproducción en móviles.
    warmUpAudio(ensureSirenAudio());
    // Arranca un voice para que también quede desbloqueado (simulacro como placeholder).
    warmUpAudio(ensureVoiceAudio(VOICE_BASE + "simulacro.mp3"));

    enableBtn.textContent = "Sonido activado";
    enableBtn.disabled = true;

    // si ya hay una alerta activa, arrancá sirena y voz
    if (currentAlert) {
      startSiren();
      startSpeakingLoop(currentAlert);
    }
  });

  // --- Socket ----------------------------------------------------------
  socket.on("connect", () => setStatus("Listo · esperando alertas", "online"));
  socket.on("disconnect", () => setStatus("Desconectado", "offline"));
  socket.on("connect_error", () => setStatus("Error de conexión", "offline"));

  socket.on("alert:start", (alert) => {
    showAlert(alert);
  });
  socket.on("alert:stop", () => {
    hideAlert();
  });

  setStatus("Conectando…");
})();
