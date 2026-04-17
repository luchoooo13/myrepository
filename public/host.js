(function () {
  const ALERTS = [
    { type: "simulacro", label: "Simulacro", icon: "🧪", className: "simulacro" },
    { type: "incendio", label: "Incendio", icon: "🔥", className: "incendio" },
    { type: "sismo", label: "Sismo", icon: "🌐", className: "sismo" },
    { type: "evacuacion", label: "Evacuación", icon: "🚪", className: "evacuacion" },
    { type: "intruso", label: "Intruso", icon: "🚨", className: "intruso" },
    { type: "medica", label: "Emergencia Médica", icon: "⛑️", className: "medica" },
    { type: "gas", label: "Fuga de Gas", icon: "☣️", className: "gas" },
    { type: "bomba", label: "Amenaza de Bomba", icon: "💣", className: "bomba" },
    { type: "tormenta", label: "Tormenta Severa", icon: "⛈️", className: "tormenta" },
    {
      type: "custom",
      label: "Mensaje Personalizado",
      icon: "✏️",
      className: "custom",
      customPrompt: true,
    },
  ];

  const socket = io();
  const statusEl = document.getElementById("status");
  const grid = document.getElementById("buttons");
  const currentBox = document.getElementById("current");
  const currentType = document.getElementById("currentType");
  const currentTime = document.getElementById("currentTime");
  const stopBtn = document.getElementById("stopBtn");

  let currentAlert = null;
  let tickTimer = null;

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

  function stopTick() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function showCurrent(alert) {
    currentAlert = alert;
    currentBox.hidden = false;
    currentType.textContent = alert.label || alert.type;
    const update = () => {
      const remaining = alert.endsAt - Date.now();
      if (remaining <= 0) {
        hideCurrent();
        return;
      }
      currentTime.textContent = `Tiempo restante: ${formatRemaining(remaining)}`;
    };
    update();
    stopTick();
    tickTimer = setInterval(update, 250);
  }

  function hideCurrent() {
    currentAlert = null;
    stopTick();
    currentBox.hidden = true;
  }

  function renderButtons() {
    grid.innerHTML = "";
    for (const alert of ALERTS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `alert-btn alert-btn--${alert.className}`;
      btn.innerHTML = `
        <span class="alert-btn__icon" aria-hidden="true">${alert.icon}</span>
        <span class="alert-btn__label">${alert.label}</span>
      `;
      btn.addEventListener("click", () => {
        if (alert.customPrompt) {
          const raw = window.prompt(
            "Escribí el mensaje que va a leer la voz en todos los clientes:",
            ""
          );
          if (raw === null) return;
          const text = raw.trim().slice(0, 200);
          if (!text) return;
          if (!window.confirm(`¿Enviar alerta con mensaje: "${text}"?`)) return;
          socket.emit("alert:trigger", { type: "custom", label: text });
          return;
        }
        const confirmed =
          alert.type === "simulacro" ||
          window.confirm(`¿Enviar alerta de "${alert.label}" a todos los clientes?`);
        if (!confirmed) return;
        socket.emit("alert:trigger", { type: alert.type, label: alert.label });
      });
      grid.appendChild(btn);
    }
  }

  stopBtn.addEventListener("click", () => {
    socket.emit("alert:stop");
  });

  socket.on("connect", () => setStatus("Conectado", "online"));
  socket.on("disconnect", () => setStatus("Desconectado", "offline"));
  socket.on("connect_error", () => setStatus("Error de conexión", "offline"));

  socket.on("alert:start", (alert) => {
    showCurrent(alert);
  });
  socket.on("alert:stop", () => {
    hideCurrent();
  });

  renderButtons();
  setStatus("Conectando…");
})();
