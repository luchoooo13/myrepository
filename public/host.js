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
      adminOnly: true,
    },
  ];

  // El server nos inyecta rol ("admin"/"operator") y token en meta tags de
  // <head>. Usamos el rol para esconder secciones avanzadas al operador, y
  // el token para autenticar el socket (el middleware del server valida el
  // token contra las sesiones en memoria y sólo el admin puede programar).
  const roleMeta = document.querySelector('meta[name="host-role"]');
  const tokenMeta = document.querySelector('meta[name="host-token"]');
  const hostRole = roleMeta ? roleMeta.content : "";
  const hostToken = tokenMeta ? tokenMeta.content : "";
  const isAdmin = hostRole === "admin";

  const socket = io({ auth: { token: hostToken } });
  const statusEl = document.getElementById("status");
  const grid = document.getElementById("buttons");
  const currentBox = document.getElementById("current");
  const currentType = document.getElementById("currentType");
  const currentTime = document.getElementById("currentTime");
  const stopBtn = document.getElementById("stopBtn");
  const scheduleForm = document.getElementById("scheduleForm");
  const scheduleTimeEl = document.getElementById("scheduleTime");
  const scheduleTypeEl = document.getElementById("scheduleType");
  const scheduleRecurringEl = document.getElementById("scheduleRecurring");
  const scheduleListEl = document.getElementById("scheduleList");
  const clientsCountEl = document.getElementById("clientsCount");
  const roleBadgeEl = document.getElementById("roleBadge");
  const logoutBtn = document.getElementById("logoutBtn");
  const schedulerSection = document.querySelector(".host__scheduler");
  const recsSection = document.getElementById("recsSection");
  const recsListEl = document.getElementById("recsList");
  const recsStatusEl = document.getElementById("recsStatus");

  let currentAlert = null;
  let tickTimer = null;
  // Mapa type -> { label, icon, lines } con lo último que nos confirmó el
  // server. Se usa para detectar si lo que hay en el textarea es distinto
  // al estado remoto, para el estado del botón "Guardar" y para
  // restaurar al cancelar.
  let recsState = {};

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

  // --- Scheduler ------------------------------------------------------
  function renderScheduleOptions() {
    scheduleTypeEl.innerHTML = "";
    for (const alert of ALERTS) {
      if (alert.customPrompt) continue; // no programamos mensajes personalizados
      const opt = document.createElement("option");
      opt.value = alert.type;
      opt.textContent = alert.label;
      scheduleTypeEl.appendChild(opt);
    }
    scheduleTypeEl.value = "simulacro";
  }

  // Escapamos HTML antes de interpolar contenido controlado por el usuario
  // en template strings que van a innerHTML. Evita que un admin con mala
  // intención (o un bug) inyecte <script>/<img onerror=...> vía schedule:add
  // y lo ejecute en la sesión de otros hosts cuando reciben schedule:list.
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatFireAt(fireAt) {
    try {
      const fmt = new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return fmt.format(new Date(fireAt));
    } catch {
      return new Date(fireAt).toLocaleString();
    }
  }

  function renderSchedules(list) {
    scheduleListEl.innerHTML = "";
    if (!list || list.length === 0) {
      const empty = document.createElement("li");
      empty.className = "host__scheduler-empty";
      empty.textContent = "No hay alertas programadas.";
      scheduleListEl.appendChild(empty);
      return;
    }
    for (const s of list) {
      const li = document.createElement("li");
      li.className = "host__scheduler-item";
      const hhmm =
        String(s.hour).padStart(2, "0") + ":" + String(s.minute).padStart(2, "0");
      const info = document.createElement("div");
      info.className = "host__scheduler-item-info";
      const recBadge = s.recurring
        ? '<em class="host__scheduler-badge">diaria</em>'
        : "";
      info.innerHTML = `
        <strong>${escapeHtml(hhmm)}</strong>
        <span>${escapeHtml(s.label)}</span>
        ${recBadge}
        <small>${escapeHtml(formatFireAt(s.fireAt))}</small>
      `;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn--cancel";
      cancel.textContent = "Cancelar";
      cancel.addEventListener("click", () => {
        socket.emit("schedule:remove", { id: s.id });
      });
      li.appendChild(info);
      li.appendChild(cancel);
      scheduleListEl.appendChild(li);
    }
  }

  scheduleForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const time = scheduleTimeEl.value; // "HH:MM"
    const type = scheduleTypeEl.value;
    if (!time || !type) return;
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) return;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const alertDef = ALERTS.find((a) => a.type === type);
    const label = alertDef ? alertDef.label : type;
    const recurring = !!scheduleRecurringEl.checked;
    socket.emit("schedule:add", { hour, minute, type, label, recurring });
    scheduleForm.reset();
  });

  function renderButtons() {
    grid.innerHTML = "";
    for (const alert of ALERTS) {
      // El operator no ve alertas "adminOnly" (ej. mensaje personalizado).
      if (alert.adminOnly && !isAdmin) continue;
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
  socket.on("schedule:list", (list) => {
    renderSchedules(list);
  });
  socket.on("clients:count", (payload) => {
    const n = payload && typeof payload.count === "number" ? payload.count : 0;
    clientsCountEl.textContent = String(n);
  });
  socket.on("recommendations:update", (payload) => {
    if (!payload || typeof payload.recommendations !== "object") return;
    recsState = payload.recommendations;
    renderRecs();
    showRecsStatus("Recomendaciones actualizadas.", "ok");
  });

  // --- Editor de recomendaciones (sólo admin) ------------------------
  // Orden con el que se muestran los tipos en el editor. Coincide con los
  // botones de arriba (ALERTS). Si el server devuelve un type que no está
  // acá (ej. un custom nuevo), lo mostramos al final igual.
  const RECS_ORDER = [
    "simulacro", "incendio", "sismo", "evacuacion", "intruso",
    "medica", "gas", "bomba", "tormenta", "custom",
  ];

  function sortedRecTypes() {
    const keys = Object.keys(recsState || {});
    const known = RECS_ORDER.filter((t) => keys.includes(t));
    const extra = keys.filter((t) => !RECS_ORDER.includes(t)).sort();
    return known.concat(extra);
  }

  function showRecsStatus(text, level) {
    if (!recsStatusEl) return;
    recsStatusEl.textContent = text;
    recsStatusEl.dataset.level = level || "info";
    recsStatusEl.hidden = false;
    clearTimeout(showRecsStatus._t);
    showRecsStatus._t = setTimeout(() => {
      recsStatusEl.hidden = true;
    }, 4000);
  }

  function renderRecs() {
    if (!recsListEl) return;
    recsListEl.innerHTML = "";
    const types = sortedRecTypes();
    if (types.length === 0) {
      const empty = document.createElement("p");
      empty.className = "host__recs-empty";
      empty.textContent = "No hay recomendaciones configuradas todavía.";
      recsListEl.appendChild(empty);
      return;
    }
    for (const type of types) {
      const r = recsState[type] || { label: type, icon: "", lines: [] };
      const card = document.createElement("div");
      card.className = "host__recs-card";
      card.dataset.type = type;

      const header = document.createElement("div");
      header.className = "host__recs-card-header";
      const title = document.createElement("h3");
      title.className = "host__recs-card-title";
      title.innerHTML =
        `<span class="host__recs-card-icon" aria-hidden="true">${escapeHtml(r.icon || "")}</span>` +
        `<span>${escapeHtml(r.label || type)}</span>`;
      header.appendChild(title);
      card.appendChild(header);

      const ta = document.createElement("textarea");
      ta.className = "host__recs-textarea";
      ta.rows = Math.max(4, (r.lines || []).length + 1);
      ta.placeholder = "Una recomendación por línea";
      ta.value = (r.lines || []).join("\n");
      card.appendChild(ta);

      const actions = document.createElement("div");
      actions.className = "host__recs-actions";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn--save";
      saveBtn.textContent = "Guardar";
      saveBtn.addEventListener("click", () => {
        saveBtn.disabled = true;
        saveRecsForType(type, ta.value, r.label, r.icon)
          .catch((err) => {
            showRecsStatus(
              "No se pudo guardar: " + (err && err.message ? err.message : err),
              "err",
            );
          })
          .finally(() => {
            saveBtn.disabled = false;
          });
      });
      actions.appendChild(saveBtn);

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "btn btn--reset";
      resetBtn.textContent = "Restaurar default";
      resetBtn.addEventListener("click", () => {
        if (!window.confirm(
          'Volver las recomendaciones de "' + (r.label || type) +
          '" al texto original?',
        )) return;
        resetBtn.disabled = true;
        resetRecsForType(type)
          .catch((err) => {
            showRecsStatus(
              "No se pudo restaurar: " + (err && err.message ? err.message : err),
              "err",
            );
          })
          .finally(() => {
            resetBtn.disabled = false;
          });
      });
      actions.appendChild(resetBtn);

      card.appendChild(actions);
      recsListEl.appendChild(card);
    }
  }

  async function saveRecsForType(type, textareaValue, label, icon) {
    const lines = String(textareaValue || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const res = await fetch("/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, label, icon, lines }),
    });
    if (!res.ok) {
      let err = res.statusText;
      try {
        const j = await res.json();
        if (j && j.error) err = j.error;
      } catch {
        /* ignore */
      }
      throw new Error(err);
    }
    const j = await res.json();
    if (j && j.recommendations) {
      recsState = j.recommendations;
      renderRecs();
    }
    showRecsStatus("Guardado.", "ok");
  }

  async function resetRecsForType(type) {
    const res = await fetch("/recommendations/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    if (!res.ok) {
      let err = res.statusText;
      try {
        const j = await res.json();
        if (j && j.error) err = j.error;
      } catch {
        /* ignore */
      }
      throw new Error(err);
    }
    const j = await res.json();
    if (j && j.recommendations) {
      recsState = j.recommendations;
      renderRecs();
    }
    showRecsStatus("Restaurado al default.", "ok");
  }

  async function loadRecsInitial() {
    try {
      const res = await fetch("/recommendations", { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      if (j && j.recommendations) {
        recsState = j.recommendations;
        renderRecs();
      }
    } catch (err) {
      console.warn("No se pudo cargar /recommendations:", err);
    }
  }

  // --- Logout y UI por rol -------------------------------------------
  if (roleBadgeEl) {
    roleBadgeEl.textContent = isAdmin
      ? "admin"
      : hostRole === "operator"
        ? "preceptor"
        : "—";
  }
  if (!isAdmin && schedulerSection) {
    // El operator no tiene acceso al scheduler — lo escondemos del DOM
    // (el server igual rechaza los eventos si alguien intenta forzarlo).
    schedulerSection.hidden = true;
  }
  if (isAdmin && recsSection) {
    recsSection.hidden = false;
    loadRecsInitial();
  }
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await fetch("/host-logout", { method: "POST" });
      } catch {
        /* ignore */
      }
      window.location.href = "/host-login";
    });
  }

  renderButtons();
  if (isAdmin) renderScheduleOptions();
  renderSchedules([]);
  setStatus("Conectando…");
})();
