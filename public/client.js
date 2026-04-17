(function () {
  const socket = io();

  const idleEl = document.getElementById("idle");
  const statusEl = document.getElementById("status");
  const enableBtn = document.getElementById("enableBtn");
  const overlay = document.getElementById("alertOverlay");
  const alertTypeEl = document.getElementById("alertType");
  const alertTimeEl = document.getElementById("alertTime");

  let audioCtx = null;
  let sirenNodes = null;
  let currentAlert = null;
  let tickTimer = null;
  let ttsTimer = null;
  let enabled = false;

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

  // --- Sirena (Web Audio API) -------------------------------------------
  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Sirena estilo Alerta Sísmica (SkyAlert / SASSLA / SASMEX):
  // dos tonos agudos cuadrados alternándose rápido con breves silencios.
  function startSiren() {
    stopSiren();
    const ctx = ensureAudioCtx();
    if (!ctx) return;

    // Dos osciladores cuadrados para timbre agresivo, apilados como armónicos.
    const osc1 = ctx.createOscillator();
    osc1.type = "square";
    const osc2 = ctx.createOscillator();
    osc2.type = "square";

    // Filtro pasa bajos suave para sacarle un poco el filo y que no lastime.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 3200;
    filter.Q.value = 0.7;

    // Nodo de ganancia que abre y cierra rápido = staccato de la alarma.
    const gate = ctx.createGain();
    gate.gain.value = 0;

    const master = ctx.createGain();
    master.gain.value = 0.5;

    osc1.connect(gate);
    osc2.connect(gate);
    gate.connect(filter);
    filter.connect(master);
    master.connect(ctx.destination);

    const startT = ctx.currentTime + 0.05;
    osc1.start(startT);
    osc2.start(startT);

    // Patrón: dos frecuencias agudas en quinta para resultar penetrante
    // (similar al SASMEX). Beep ~150ms con silencio ~50ms entre beeps.
    const f1 = 932.33; // A#5
    const f2 = 1396.91; // F6
    const beepSec = 0.15;
    const silenceSec = 0.05;
    const cycleSec = (beepSec + silenceSec) * 2;
    const totalSec = 120; // margen para cualquier duración de alerta

    // Pre-programar todos los cambios al scheduler de audio para precisión.
    for (let t = 0; t < totalSec; t += cycleSec) {
      const b1Start = startT + t;
      const b1End = b1Start + beepSec;
      const b2Start = b1End + silenceSec;
      const b2End = b2Start + beepSec;

      // Frecuencia del beep 1 (grave) y 2 (agudo). osc1 da la fundamental,
      // osc2 agrega un armónico de octava para espesar el tono.
      osc1.frequency.setValueAtTime(f1, b1Start);
      osc2.frequency.setValueAtTime(f1 * 2, b1Start);
      osc1.frequency.setValueAtTime(f2, b2Start);
      osc2.frequency.setValueAtTime(f2 * 2, b2Start);

      // Envolvente ADSR corto para evitar clicks pero mantener staccato.
      gate.gain.setValueAtTime(0, b1Start);
      gate.gain.linearRampToValueAtTime(0.45, b1Start + 0.008);
      gate.gain.setValueAtTime(0.45, b1End - 0.01);
      gate.gain.linearRampToValueAtTime(0, b1End);

      gate.gain.setValueAtTime(0, b2Start);
      gate.gain.linearRampToValueAtTime(0.45, b2Start + 0.008);
      gate.gain.setValueAtTime(0.45, b2End - 0.01);
      gate.gain.linearRampToValueAtTime(0, b2End);
    }

    sirenNodes = { osc1, osc2, gate, filter, master };
  }

  function stopSiren() {
    if (!sirenNodes || !audioCtx) return;
    const { osc1, osc2, gate, master } = sirenNodes;
    const now = audioCtx.currentTime;
    try {
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(gate.gain.value, now);
      gate.gain.linearRampToValueAtTime(0, now + 0.05);
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + 0.08);
      osc1.stop(now + 0.1);
      osc2.stop(now + 0.1);
    } catch {
      /* ignore */
    }
    sirenNodes = null;
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
    ensureAudioCtx();
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
