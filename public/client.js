(function () {
  const socket = io();

  const idleEl = document.getElementById("idle");
  const statusEl = document.getElementById("status");
  const enableBtn = document.getElementById("enableBtn");
  const overlay = document.getElementById("alertOverlay");
  const alertTypeEl = document.getElementById("alertType");
  const alertTimeEl = document.getElementById("alertTime");

  let sirenAudio = null;
  let currentAlert = null;
  let tickTimer = null;
  let ttsTimer = null;
  let enabled = false;

  const SIREN_SRC = "/sounds/siren.mp3";

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

  // --- Voz (Web Speech API) ---------------------------------------------
  let cachedSpanishFemaleVoice = null;

  function pickSpanishFemaleVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    const spanish = voices.filter((v) =>
      (v.lang || "").toLowerCase().startsWith("es")
    );
    if (spanish.length === 0) return voices[0] || null;

    const femaleHints = [
      "female",
      "mujer",
      "mónica",
      "monica",
      "paulina",
      "helena",
      "lucia",
      "lucía",
      "sabina",
      "marisol",
      "esperanza",
      "elena",
      "laura",
      "google español",
      "microsoft sabina",
      "microsoft helena",
      "microsoft paulina",
    ];
    const byName = spanish.find((v) => {
      const n = (v.name || "").toLowerCase();
      return femaleHints.some((h) => n.includes(h));
    });
    if (byName) return byName;

    const notMale = spanish.find((v) => {
      const n = (v.name || "").toLowerCase();
      return !/(male|hombre|jorge|diego|carlos|juan|pablo)/i.test(n);
    });
    return notMale || spanish[0];
  }

  function ensureVoice() {
    if (cachedSpanishFemaleVoice) return cachedSpanishFemaleVoice;
    cachedSpanishFemaleVoice = pickSpanishFemaleVoice();
    return cachedSpanishFemaleVoice;
  }

  function speakOnce(text) {
    if (!("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "es-ES";
    const voice = ensureVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang || "es-ES";
    }
    utter.rate = 1;
    utter.pitch = 1.1;
    utter.volume = 1;
    try {
      window.speechSynthesis.speak(utter);
    } catch {
      /* ignore */
    }
  }

  function startSpeakingLoop(label) {
    stopSpeakingLoop();
    const phrase = `Atención. ${label}. ${label}.`;
    // hablar inmediatamente y luego repetir
    speakOnce(phrase);
    ttsTimer = setInterval(() => {
      if (!currentAlert) return;
      // evita apilar utterances si el anterior aun habla
      if (window.speechSynthesis && window.speechSynthesis.speaking) return;
      speakOnce(phrase);
    }, 4500);
  }

  function stopSpeakingLoop() {
    if (ttsTimer) {
      clearInterval(ttsTimer);
      ttsTimer = null;
    }
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
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
      startSpeakingLoop(label);
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
  enableBtn.addEventListener("click", () => {
    enabled = true;
    // "Warm up" del <audio> para desbloquear reproducción en móviles.
    const audio = ensureSirenAudio();
    try {
      audio.muted = true;
      const warm = audio.play();
      if (warm && typeof warm.then === "function") {
        warm
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = false;
          })
          .catch(() => {
            audio.muted = false;
          });
      } else {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
      }
    } catch {
      /* ignore */
    }
    // dispara una utterance vacía para "desbloquear" la voz en mobile
    if ("speechSynthesis" in window) {
      try {
        const warm = new SpeechSynthesisUtterance(" ");
        warm.volume = 0;
        window.speechSynthesis.speak(warm);
      } catch {
        /* ignore */
      }
    }
    enableBtn.textContent = "Sonido activado";
    enableBtn.disabled = true;

    // si ya hay una alerta activa, arrancá sirena y voz
    if (currentAlert) {
      startSiren();
      startSpeakingLoop(currentAlert.label || currentAlert.type);
    }
  });

  // refrescar la lista de voces cuando estén disponibles
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {
      cachedSpanishFemaleVoice = null;
      ensureVoice();
    };
  }

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
