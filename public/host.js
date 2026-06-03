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

  const roleMeta = document.querySelector('meta[name="host-role"]');
  const tokenMeta = document.querySelector('meta[name="host-token"]');
  const hostRole = roleMeta ? roleMeta.content : "";
  const hostToken = tokenMeta ? tokenMeta.content : "";
  const isAdmin = hostRole === "admin";

  const socket = io({ auth: { token: hostToken } });

  socket.on("alert:start",  (alert) => showCurrent(alert));
  socket.on("alert:stop",   ()      => hideCurrent());

  socket.on("connect", () => {
    console.log("Conectado con ID:", socket.id);
    socket.emit("host:register");
  });

  socket.on("host:devices-update", (dispositivos) => {
    const container = document.getElementById("devices-container"); 
    if (!container) return;

    container.innerHTML = ""; 

    if (dispositivos.length === 0) {
      container.innerHTML = `<p style="color: var(--muted); padding: 1rem; font-size: 0.9rem;">No hay dispositivos vinculados.</p>`;
      return;
    }

    dispositivos.forEach(disp => {
      let statusClass = "badge--offline";
      let icon = "phonelink_off";
      
      if (disp.status === "Activo") {
        statusClass = "badge--online";
        icon = "smartphone";
      } else if (disp.status === "Segundo Plano") {
        statusClass = "badge--background";
        icon = "background_blur_minus"; 
      }

      const itemHtml = `
        <div class="device-item" style="display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; background: var(--surface-2); border-radius: 12px; margin-bottom: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <span class="material-symbols-outlined ${statusClass}" style="font-size: 1.3rem;">${icon}</span>
            <div>
              <span style="font-weight: 500; display: block; color: var(--text);">${disp.aula}</span>
              <span style="font-size: 0.75rem; color: var(--text-2);">${disp.status}</span>
            </div>
          </div>
          <span class="device-badge ${statusClass}" style="width: 8px; height: 8px; border-radius: 50%;"></span>
        </div>
      `;
      container.insertAdjacentHTML("beforeend", itemHtml);
    });
  });

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
  const pwdForm = document.getElementById("pwdForm");
  const pwdCurrentEl = document.getElementById("pwdCurrent");
  const pwdNextEl = document.getElementById("pwdNext");
  const pwdConfirmEl = document.getElementById("pwdConfirm");
  const pwdSubmitEl = document.getElementById("pwdSubmit");
  const pwdStatusEl = document.getElementById("pwdStatus");
  const pwdRoleLabelEl = document.getElementById("pwdRoleLabel");
  const devicesListEl = document.getElementById("devicesList");
  const devicesAdminHintEl = document.getElementById("devicesAdminHint");
  const historyListEl = document.getElementById("historyList");

  // --- Elementos de Mensajes ---
  const msgForm = document.getElementById("msgForm");
  const msgTarget = document.getElementById("msgTarget");
  const msgText = document.getElementById("msgText");
  const msgCharCount = document.getElementById("msgCharCount");
  const msgStatus = document.getElementById("msgStatus");
  const msgSentList = document.getElementById("msgSentList");

  let currentAlert = null;
  let tickTimer = null;
  let recsState = {};

  // Pestañas (Tabs)
  const tabBtns = document.querySelectorAll('.host__tab-btn');
  const tabContents = document.querySelectorAll('.host__tab-content');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('is-active'));
      tabContents.forEach(c => c.hidden = true);
      btn.classList.add('is-active');
      document.getElementById(btn.dataset.target).hidden = false;
    });
  });

// Reemplaza tu función setStatus actual con esta versión blindada
function setStatus(id, text) {
  if (!id) return;
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

// Parche para la línea 328 (Busca el bloque donde está esa línea y pon esto)
const targetElement = document.getElementById("ID_DE_LA_LINEA_328"); // Reemplaza ID_DE_LA_LINEA_328 por el id que tengas ahí
if (targetElement) {
    targetElement.textContent = "tu valor";
} else {
    console.warn("Línea 328: El elemento no estaba en el HTML, pero el código sigue vivo.");
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
    const update = () => {const icons = {
  incendio: "🔥",
  sismo: "🌎",
  evacuacion: "🚨",
  intruso: "⚠️",
  medica: "⛑️",
  gas: "☣️",
  bomba: "💣",
  tormenta: "⛈️",
  simulacro: "🧪",
  custom: "📢"
};

const icon = icons[alert.type] || "🚨";

currentType.innerHTML = `${icon} ${alert.label || alert.type}`;
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

  function renderScheduleOptions() {
    scheduleTypeEl.innerHTML = "";
    for (const alert of ALERTS) {
      if (alert.customPrompt) continue; 
      const opt = document.createElement("option");
      opt.value = alert.type;
      opt.textContent = alert.label;
      scheduleTypeEl.appendChild(opt);
    }
    scheduleTypeEl.value = "simulacro";
  }

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
    const time = scheduleTimeEl.value; 
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

  // Protección anti-doble clic: deshabilita el botón por ms milisegundos.
  // Evita que por nervios se disparen 2-3 alertas seguidas.
  function withDebounce(btn, ms, fn) {
    if (btn.disabled) return;
    fn();
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, ms);
  }

  // ── Duration picker modal ─────────────────────────────────────────────
  // Opciones de duración que aparecen cuando el usuario hace clic en un
  // botón de alerta antes de confirmar el disparo.
  const DURATION_OPTIONS = [
    { label: "30 s",  ms: 30000  },
    { label: "1 min", ms: 60000  },
    { label: "90 s",  ms: 90000  },
    { label: "2 min", ms: 120000 },
    { label: "5 min", ms: 300000 },
  ];
  const DEFAULT_DURATION_MS = 60000;

  let activePicker = null; // referencia al picker abierto actualmente

  function closePicker() {
    if (activePicker) {
      activePicker.remove();
      activePicker = null;
    }
  }

  /**
   * Muestra el picker de duración anclado encima del botón `btn`.
   * Cuando el usuario elige una duración, llama a `onConfirm(durationMs)`.
   */
  function showDurationPicker(btn, alertDef, onConfirm) {
    closePicker(); // cierra cualquier picker previo

    const picker = document.createElement("div");
    picker.className = "duration-picker";
    // Posicionamos encima del botón
    const btnRect = btn.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    picker.style.cssText = `
      position: absolute;
      z-index: 9999;
      left: ${btnRect.left}px;
      top: ${btnRect.top + scrollY - 8}px;
      transform: translateY(-100%);
      background: #1a1a20;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      padding: 12px 14px 10px;
      min-width: 220px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.55);
      display: flex;
      flex-direction: column;
      gap: 8px;
      animation: picker-in 0.15s ease;
    `;

    const header = document.createElement("div");
    header.style.cssText = "font-size:.72rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6e6e80;margin-bottom:2px;";
    header.textContent = "Duración · " + alertDef.label;
    picker.appendChild(header);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

    for (const opt of DURATION_OPTIONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = opt.label;
      chip.style.cssText = `
        padding: 6px 14px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(255,255,255,0.07);
        color: #f0f0f5;
        font-size: .82rem;
        font-weight: 600;
        cursor: pointer;
        transition: background .15s, border-color .15s;
      `;
      chip.addEventListener("mouseenter", () => {
        chip.style.background = "rgba(255,255,255,0.16)";
        chip.style.borderColor = "rgba(255,255,255,0.35)";
      });
      chip.addEventListener("mouseleave", () => {
        chip.style.background = "rgba(255,255,255,0.07)";
        chip.style.borderColor = "rgba(255,255,255,0.15)";
      });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        closePicker();
        onConfirm(opt.ms);
      });
      row.appendChild(chip);
    }
    picker.appendChild(row);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancelar";
    cancelBtn.style.cssText = "background:none;border:none;color:#6e6e80;font-size:.78rem;cursor:pointer;text-align:left;padding:2px 0 0;";
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); closePicker(); btn.disabled = false; });
    picker.appendChild(cancelBtn);

    document.body.appendChild(picker);
    activePicker = picker;

    // Cierra si se hace clic afuera
    setTimeout(() => {
      document.addEventListener("click", closePicker, { once: true });
    }, 0);
  }

  function renderButtons() {
    grid.innerHTML = "";

    // Inyectamos el CSS de animación del picker si no está ya
    if (!document.getElementById("duration-picker-style")) {
      const s = document.createElement("style");
      s.id = "duration-picker-style";
      s.textContent = `
        @keyframes picker-in {
          from { opacity:0; transform: translateY(calc(-100% + 10px)); }
          to   { opacity:1; transform: translateY(-100%); }
        }
      `;
      document.head.appendChild(s);
    }

    for (const alert of ALERTS) {
      if (alert.adminOnly && !isAdmin) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `alert-btn alert-btn--${alert.className}`;
      btn.innerHTML = `
        <span class="alert-btn__icon" aria-hidden="true">${alert.icon}</span>
        <span class="alert-btn__label">${alert.label}</span>
      `;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        btn.disabled = true;

        if (alert.customPrompt) {
          // Mensaje personalizado: pedir texto primero, luego duración
          const raw = window.prompt(
            "Escribí el mensaje que va a leer la voz en todos los clientes:", ""
          );
          if (raw === null) { btn.disabled = false; return; }
          const text = raw.trim().slice(0, 200);
          if (!text) { btn.disabled = false; return; }
          showDurationPicker(btn, alert, (durationMs) => {
            if (!window.confirm(`¿Enviar alerta con mensaje: "${text}"?`)) {
              btn.disabled = false; return;
            }
            socket.emit("alert:trigger", { type: "custom", label: text, durationMs });
            setTimeout(() => { btn.disabled = false; }, 2000);
          });
          return;
        }

        // Simulacro: pide duración directamente, sin confirm extra
        if (alert.type === "simulacro") {
          showDurationPicker(btn, alert, (durationMs) => {
            socket.emit("alert:trigger", { type: alert.type, label: alert.label, durationMs });
            setTimeout(() => { btn.disabled = false; }, 2000);
          });
          return;
        }

        // Todos los demás tipos: mostrar picker → confirmar
        showDurationPicker(btn, alert, (durationMs) => {
          if (!window.confirm(`¿Enviar alerta de "${alert.label}" por ${durationMs/1000|0}s a todos los clientes?`)) {
            btn.disabled = false; return;
          }
          socket.emit("alert:trigger", { type: alert.type, label: alert.label, durationMs });
          setTimeout(() => { btn.disabled = false; }, 2000);
        });
      });
      grid.appendChild(btn);
    }
  }

  stopBtn.addEventListener("click", () => {
    withDebounce(stopBtn, 2000, () => socket.emit("alert:stop"));
  });

  // ── Chip de conexión del host ──────────────────────────────────────────
  const hostConnChip = document.getElementById("hostConnChip");
  const hostConnText = document.getElementById("hostConnText");

  function setHostConn(state) {
    if (!hostConnChip) return;
    hostConnChip.className = "host-conn-chip host-conn-chip--" + state;
    if (hostConnText) {
      hostConnText.textContent =
        state === "online"      ? "En línea" :
        state === "offline"     ? "Sin conexión" :
                                  "Conectando…";
    }
  }

  socket.on("connect",       () => { setStatus("Conectado", "online");  setHostConn("online");      });
  socket.on("disconnect",    () => { setStatus("Desconectado", "offline"); setHostConn("offline");   });
  socket.on("connect_error", () => { setStatus("Error de conexión", "offline"); setHostConn("offline"); });
  socket.on("schedule:list", (list) => { renderSchedules(list); });
  socket.on("clients:count", (payload) => {
    const n = payload && typeof payload.count === "number" ? payload.count : 0;
    clientsCountEl.textContent = String(n);
  });
  
  // Agrega esto arriba de cualquier lógica de setStatus o manipulación de DOM
socket.on("comando_recibido", (data) => {
    console.log("¡CONFIRMADO! El servidor recibió el comando:", data);
    
    // FORZAMOS el envío sin importar si el DOM falla
    io.emit("alert:start", data); 
    console.log("¡Se emitió la alerta a todos!");
});

  socket.on("clients:list", (payload) => {
    if (!payload || !Array.isArray(payload.clients)) return;
    renderDevices(payload.clients);
  });
  socket.on("alerts:history", (payload) => {
    if (!payload || !Array.isArray(payload.history)) return;
    renderAlertHistory(payload.history);
  });
  socket.on("recommendations:update", (payload) => {
    if (!payload || typeof payload.recommendations !== "object") return;
    recsState = payload.recommendations;
    renderRecs();
    showRecsStatus("Recomendaciones actualizadas.", "ok");
  });

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
            showRecsStatus("No se pudo guardar: " + (err && err.message ? err.message : err), "err");
          })
          .finally(() => { saveBtn.disabled = false; });
      });
      actions.appendChild(saveBtn);

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "btn btn--reset";
      resetBtn.textContent = "Restaurar default";
      resetBtn.addEventListener("click", () => {
        if (!window.confirm('Volver las recomendaciones de "' + (r.label || type) + '" al texto original?')) return;
        resetBtn.disabled = true;
        resetRecsForType(type)
          .catch((err) => {
            showRecsStatus("No se pudo restaurar: " + (err && err.message ? err.message : err), "err");
          })
          .finally(() => { resetBtn.disabled = false; });
      });
      actions.appendChild(resetBtn);

      card.appendChild(actions);
      recsListEl.appendChild(card);
    }
  }

  async function saveRecsForType(type, textareaValue, label, icon) {
    const lines = String(textareaValue || "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const res = await fetch("/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, label, icon, lines }),
    });
    if (!res.ok) throw new Error(res.statusText);
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
    if (!res.ok) throw new Error(res.statusText);
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
    } catch (err) {}
  }

  if (roleBadgeEl) {
    roleBadgeEl.textContent = isAdmin ? "admin" : hostRole === "operator" ? "preceptor" : "—";
  }
  if (!isAdmin) {
    if (schedulerSection) schedulerSection.hidden = true;
    if (recsSection) recsSection.hidden = true;
  }
  if (isAdmin && recsSection) {
    recsSection.hidden = false;
    loadRecsInitial();
  }

  function stateBadge(state) {
    if (state === "alerting") return '<span class="dev__state dev__state--alert">🔴 sonando</span>';
    if (state === "silenced") return '<span class="dev__state dev__state--silenced">🌙 silenciado</span>';
    if (state === "paused") return '<span class="dev__state dev__state--paused">⏸ pausado</span>';
    if (state === "offline") return '<span class="dev__state dev__state--offline">⚫ offline</span>';
    return '<span class="dev__state dev__state--idle">🟢 escuchando</span>';
  }

  function formatLastSeen(ms) {
    if (!ms) return "nunca";
    const diff = Date.now() - ms;
    if (diff < 60 * 1000) return "hace instantes";
    if (diff < 60 * 60 * 1000) return "hace " + Math.round(diff / 60000) + " min";
    if (diff < 24 * 60 * 60 * 1000) return "hace " + Math.round(diff / 3600000) + " h";
    try {
      return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleString();
    }
  }

  function netSignalInfo(net) {
    if (!net || typeof net !== "object") return { level: 0, label: "Sin datos", title: "Sin medición de red" };
    const rtt = Number.isFinite(net.rttMs) ? net.rttMs : null;
    const eff = typeof net.effectiveType === "string" ? net.effectiveType : "";
    let level = 0, qual = "Sin datos";
    if (rtt != null) {
      if (rtt < 60) { level = 4; qual = "Excelente"; }
      else if (rtt < 150) { level = 3; qual = "Buena"; }
      else if (rtt < 350) { level = 2; qual = "Regular"; }
      else { level = 1; qual = "Débil"; }
    }
    if (eff === "slow-2g" || eff === "2g") { if (level > 1) level = 1; qual = "Débil"; }
    let title = qual;
    if (rtt != null) title += " · " + rtt + " ms";
    if (eff) title += " (" + eff + ")";
    return { level, label: qual, title };
  }

  function signalBadge(net) {
    const info = netSignalInfo(net);
    let bars = "";
    for (let i = 1; i <= 4; i++) {
      const cls = i <= info.level ? "dev__sig-bar is-on" : "dev__sig-bar";
      bars += '<span class="' + cls + '"></span>';
    }
    const lvlClass = "dev__sig dev__sig--lvl" + info.level;
    return '<span class="' + lvlClass + '" title="' + escapeHtml(info.title) + '">' +
      '<span class="dev__sig-bars" aria-hidden="true">' + bars + "</span>" +
      '<span class="dev__sig-label">' + escapeHtml(info.label) + "</span></span>";
  }

  function silentWindowSummary(sw) {
    if (!sw || !sw.enabled) return "Sin silencio horario";
    const days = (sw.days || []).slice().sort();
    const names = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    let dayStr = days.length === 0 ? "ningún día" : days.length === 7 ? "todos los días" : days.map((d) => names[d]).join("·");
    return "Silencio " + (sw.from || "?") + "→" + (sw.to || "?") + " (" + dayStr + ")";
  }

  function parseHHMM(s) {
    if (typeof s !== "string") return null;
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10), mn = parseInt(m[2], 10);
    if (isNaN(h) || isNaN(mn) || h < 0 || h > 23 || mn < 0 || mn > 59) return null;
    return h * 60 + mn;
  }

  function isInSilentWindow(sw) {
    if (!sw || !sw.enabled) return false;
    const days = sw.days || [];
    if (!days.length) return false;
    const now = new Date();
    const day = now.getDay();
    const from = parseHHMM(sw.from);
    const to = parseHHMM(sw.to);
    if (from == null || to == null) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    if (from === to) return false;
    if (from < to) {
      if (!days.includes(day)) return false;
      return cur >= from && cur < to;
    }
    if (cur >= from) return days.includes(day);
    if (cur < to) {
      const prev = (day + 6) % 7;
      return days.includes(prev);
    }
    return false;
  }

  function getEffectiveState(c) {
    if (c.state === "alerting") return "alerting";
    if (c.state === "paused") return "paused";
    if (isInSilentWindow(c.silentWindow)) return "silenced";
    return c.state || "idle";
  }

  function renderDevices(list) {
    // --- Actualización del Select de Mensajes ---
    if (msgTarget) {
      const currentVal = msgTarget.value;
      msgTarget.innerHTML = '<option value="all">Todos los dispositivos conectados</option>';
      if (list && list.length > 0) {
        for (const c of list) {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = c.name || `Dispositivo (${c.id.substring(0,4)})`;
          msgTarget.appendChild(opt);
        }
      }
      if (Array.from(msgTarget.options).some(o => o.value === currentVal)) {
        msgTarget.value = currentVal;
      }
    }

    if (!devicesListEl) return;
    if (devicesAdminHintEl) devicesAdminHintEl.hidden = !isAdmin;
    if (!list || list.length === 0) {
      devicesListEl.innerHTML = '<div class="host__devices-empty">No hay dispositivos registrados.</div>';
      return;
    }
    devicesListEl.innerHTML = "";
    
    for (const c of list) {
      const isOffline = c.state === "offline";
      const effectiveState = getEffectiveState(c);
      const card = document.createElement("div");
      card.className = "host__devices-card dev";
      if (isOffline) card.classList.add("dev--offline");
      card.dataset.state = effectiveState;

      const top = document.createElement("div");
      top.className = "dev__top";

      let badgeHtml = stateBadge(effectiveState);
      if (isOffline) {
        if (effectiveState === "silenced") {
          badgeHtml = '<span class="dev__state dev__state--silenced" style="opacity:0.6">🌙 silenciado (off)</span>';
        } else if (effectiveState === "paused") {
          badgeHtml = '<span class="dev__state dev__state--paused" style="opacity:0.6">⏸ pausado (off)</span>';
        } else {
          badgeHtml = '<span class="dev__state dev__state--offline">⚫ offline</span>';
        }
      }

      top.innerHTML = '<div class="dev__name">' + escapeHtml(c.name || "(sin nombre)") + "</div>" + badgeHtml;
      card.appendChild(top);

      const meta = document.createElement("div");
      meta.className = "dev__meta";
      const sigHtml = isOffline ? "" : signalBadge(c.netinfo);
      const ipStr = c.ip ? "IP " + escapeHtml(c.ip) : "";
      const swStr = escapeHtml(silentWindowSummary(c.silentWindow));
      const lastSeenStr = isOffline ? "Última conexión: " + escapeHtml(formatLastSeen(c.lastSeen)) : "";
      meta.innerHTML = sigHtml + (ipStr ? '<span>' + ipStr + "</span>" : "") + '<span>' + swStr + "</span>" + (lastSeenStr ? '<span>' + lastSeenStr + "</span>" : "");
      card.appendChild(meta);

      if (isAdmin) {
        const actions = document.createElement("div");
        actions.className = "dev__actions";
        const renameBtn = document.createElement("button");
        renameBtn.type = "button";
        renameBtn.className = "btn btn--mini";
        renameBtn.textContent = "✏️ Renombrar";
        renameBtn.addEventListener("click", () => {
          const next = window.prompt("Nuevo nombre para este dispositivo:", c.name || "");
          if (next == null) return;
          const trimmed = next.trim().slice(0, 60);
          if (!trimmed) return;
          socket.emit("clients:rename", { id: c.id, name: trimmed });
        });
        actions.appendChild(renameBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn--mini btn--danger";
        removeBtn.textContent = "🗑 Quitar";
        removeBtn.title = isOffline ? "Sacar este dispositivo del panel" : "Desconectar y olvidar este dispositivo";
        removeBtn.addEventListener("click", () => {
          const msg = isOffline ? '¿Sacar a "' + (c.name || "este dispositivo") + '" del panel? (Si vuelve a abrir la app, va a aparecer de nuevo con un nombre genérico.)' : '¿Desconectar y sacar a "' + (c.name || "este dispositivo") + '" del panel?';
          if (!window.confirm(msg)) return;
          socket.emit("clients:remove", { id: c.id });
        });
        actions.appendChild(removeBtn);
        card.appendChild(actions);
      }
      devicesListEl.appendChild(card);
    }
  }

  function formatHistoryDateTime(ms) {
    try {
      return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleString("es-AR");
    }
  }

  function formatHistoryDuration(ms) {
    if (!ms || ms < 0) return "—";
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m > 0) return m + "m " + s + "s";
    return s + " s";
  }

  function roleLabel(r) {
    if (r === "admin") return "Administrador";
    if (r === "operator") return "Preceptor";
    if (r === "schedule") return "Programada";
    if (r === "system") return "Sistema";
    return r || "—";
  }

  function renderAlertHistory(list) {
    if (!historyListEl) return;
    if (!list || list.length === 0) {
      historyListEl.innerHTML = '<div class="host__history-empty">Todavía no se registraron alertas.</div>';
      return;
    }
    historyListEl.innerHTML = "";
    for (const e of list) {
      const det = document.createElement("details");
      det.className = "host__history-item";
      if (e.type === "simulacro") det.classList.add("is-simulacro");
      const sum = document.createElement("summary");
      sum.className = "host__history-item-summary";
      const recCount = typeof e.recipients === "number" ? e.recipients : 0;
      sum.innerHTML =
        '<div class="host__history-item-main">' +
        '<div class="host__history-item-type">' + escapeHtml(e.label || e.type) + "</div>" +
        '<div class="host__history-item-time">' + formatHistoryDateTime(e.startedAt) + "</div>" +
        "</div>" +
        '<div class="host__history-item-count">' + recCount + " 📺</div>";
      det.appendChild(sum);

      const body = document.createElement("div");
      body.className = "host__history-item-body";
      const rows = [];
      rows.push(["Disparada por", roleLabel(e.triggeredBy)]);
      if (e.triggeredByName) rows.push(["Origen", e.triggeredByName]);
      let r = recCount + " dispositivo" + (recCount === 1 ? "" : "s");
      if (typeof e.silenced === "number" && e.silenced > 0) {
        r += " · " + e.silenced + " silenciado" + (e.silenced === 1 ? "" : "s");
      }
      if (typeof e.paused === "number" && e.paused > 0) {
        r += " · " + e.paused + " pausado" + (e.paused === 1 ? "" : "s");
      }
      rows.push(["Recibido por", r]);
      if (e.endedAt && e.durationMs) {
        const reason = e.endedReason === "timeout" ? " (terminó sola)" : e.endedReason === "manual" ? " (cortada manualmente)" : "";
        rows.push(["Duración", formatHistoryDuration(e.durationMs) + reason]);
      }
      for (const [k, v] of rows) {
        const row = document.createElement("div");
        row.className = "host__history-item-row";
        row.innerHTML = '<span class="host__history-item-row-label">' + escapeHtml(k) + "</span>" + '<span class="host__history-item-row-value">' + escapeHtml(v) + "</span>";
        body.appendChild(row);
      }
      if (Array.isArray(e.deviceNames) && e.deviceNames.length > 0) {
        const list2 = document.createElement("div");
        list2.className = "host__history-item-row";
        list2.innerHTML = '<span class="host__history-item-row-label">Dispositivos</span>' + '<span class="host__history-item-row-value">' + e.deviceNames.map((n) => escapeHtml(n)).join(", ") + "</span>";
        body.appendChild(list2);
      }
      det.appendChild(body);
      historyListEl.appendChild(det);
    }
  }
  
  function showPwdStatus(msg, level) {
    if (!pwdStatusEl) return;
    pwdStatusEl.hidden = false;
    pwdStatusEl.textContent = msg;
    pwdStatusEl.dataset.level = level || "info";
  }

  if (pwdRoleLabelEl) {
    pwdRoleLabelEl.textContent = isAdmin ? "admin" : hostRole === "operator" ? "preceptor" : hostRole || "—";
  }

  if (pwdForm) {
    pwdForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const current = pwdCurrentEl.value || "";
      const next = pwdNextEl.value || "";
      const confirm = pwdConfirmEl.value || "";
      if (next.length < 6) { showPwdStatus("La nueva contraseña tiene que tener al menos 6 caracteres.", "err"); return; }
      if (next !== confirm) { showPwdStatus("Las dos contraseñas nuevas no coinciden.", "err"); return; }
      if (next === current) { showPwdStatus("La nueva contraseña tiene que ser distinta a la actual.", "err"); return; }
      pwdSubmitEl.disabled = true;
      try {
        const res = await fetch("/host/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current, next }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { showPwdStatus(j.error || "No se pudo cambiar la contraseña.", "err"); return; }
        pwdForm.reset();
        showPwdStatus("Contraseña actualizada. La próxima vez ingresás con la nueva.", "ok");
      } catch (err) {
        showPwdStatus("Error de red: " + (err && err.message), "err");
      } finally {
        pwdSubmitEl.disabled = false;
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try { await fetch("/host-logout", { method: "POST" }); } catch {}
      window.location.href = "/host-login";
    });
  }

  // --- LOGICA DE ENVIO DE MENSAJES (Integrada sin romper) ---
  if (msgText && msgCharCount) {
    msgText.addEventListener("input", () => {
      msgCharCount.textContent = `${msgText.value.length} / 300`;
    });
  }

  if (msgForm) {
    const msgSendBtn = msgForm.querySelector("[type=submit]") || msgForm.querySelector("button");
    msgForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = msgText ? msgText.value.trim() : "";
      if (!text) return;
      withDebounce(msgSendBtn, 2000, () => {
        socket.emit("host:message", { text });

        if (msgStatus) {
          msgStatus.textContent = "✓ Mensaje enviado a todos los dispositivos.";
          msgStatus.dataset.level = "ok";
          msgStatus.hidden = false;
          setTimeout(() => { if (msgStatus) msgStatus.hidden = true; }, 3000);
        }

        if (msgSentList) {
          const empty = msgSentList.querySelector(".host__scheduler-empty");
          if (empty) empty.remove();
          const timeStr = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
          const item = document.createElement("div");
          item.style.cssText = "padding:.7rem .9rem;background:var(--surface-3,#26262f);border-radius:12px;border-left:3px solid var(--accent,#7c9dff);margin-bottom:.5rem;";
          item.innerHTML =
            '<div style="font-size:.9rem;color:var(--text,#e8e8f0);line-height:1.4;margin-bottom:.2rem;">' + escapeHtml(text) + "</div>" +
            '<div style="font-size:.74rem;color:var(--muted,#6e6e80);">' + timeStr + "</div>";
          msgSentList.prepend(item);
        }

        msgForm.reset();
        if (msgCharCount) msgCharCount.textContent = "0";
        if (msgSendBtn) msgSendBtn.disabled = false;
      });
    });
  }
// ESCUDO CONTRA ERRORES DE DOM
window.safeSetText = function(id, text) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = text;
    } else {
        console.log("Elemento " + id + " no encontrado, saltando...");
    }
};
  // ── Editor de textos de voz ───────────────────────────────────────────
  const voiceTextsSection = document.getElementById("voiceTextsSection");
  const voiceTextsList    = document.getElementById("voiceTextsList");
  const voiceTextsStatus  = document.getElementById("voiceTextsStatus");

  // Todos los usuarios del host pueden ver y editar los textos de voz
  if (voiceTextsSection) voiceTextsSection.hidden = false;

  const VOICE_ALERT_TYPES = [
    { type: "incendio",   label: "Incendio",          icon: "🔥" },
    { type: "sismo",      label: "Sismo",              icon: "🌐" },
    { type: "evacuacion", label: "Evacuación",         icon: "🚪" },
    { type: "intruso",    label: "Intruso",            icon: "🚨" },
    { type: "medica",     label: "Emergencia Médica",  icon: "⛑️" },
    { type: "gas",        label: "Fuga de Gas",        icon: "☣️" },
    { type: "bomba",      label: "Amenaza de Bomba",   icon: "💣" },
    { type: "tormenta",   label: "Tormenta Severa",    icon: "⛈️" },
  ];

  let voiceTextsState = {};
  let voiceTextsDefaults = {};

  function showVoiceTextsStatus(text, level) {
    if (!voiceTextsStatus) return;
    voiceTextsStatus.textContent = text;
    voiceTextsStatus.dataset.level = level || "info";
    voiceTextsStatus.hidden = false;
    clearTimeout(showVoiceTextsStatus._t);
    showVoiceTextsStatus._t = setTimeout(() => { voiceTextsStatus.hidden = true; }, 4000);
  }

  function renderVoiceTexts() {
    if (!voiceTextsList) return;
    voiceTextsList.innerHTML = "";
    VOICE_ALERT_TYPES.forEach(({ type, label, icon }) => {
      const current = voiceTextsState[type] || "";
      const def = voiceTextsDefaults[type] || "";
      const card = document.createElement("div");
      card.className = "host__recs-card";
      card.innerHTML = `
        <div class="host__recs-card-header">
          <h3 class="host__recs-card-title">
            <span class="host__recs-card-icon">${escapeHtml(icon)}</span>
            <span>${escapeHtml(label)}</span>
          </h3>
        </div>
        <textarea class="host__recs-textarea" rows="3"
          placeholder="${escapeHtml(def)}"
          data-type="${escapeHtml(type)}"
        >${escapeHtml(current)}</textarea>
        <div style="font-size:.75rem;color:var(--muted,#6e6e80);margin-top:.3rem;">
          Default: <em>${escapeHtml(def)}</em>
        </div>
        <div class="host__recs-actions">
          <button class="btn btn--save" data-save="${escapeHtml(type)}">Guardar</button>
          <button class="btn btn--reset" data-reset="${escapeHtml(type)}">Restaurar default</button>
        </div>
      `;
      voiceTextsList.appendChild(card);
    });

    voiceTextsList.querySelectorAll("[data-save]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const type = btn.dataset.save;
        const ta = voiceTextsList.querySelector(`textarea[data-type="${type}"]`);
        const text = ta ? ta.value.trim() : "";
        btn.disabled = true;
        try {
          const res = await fetch("/voice-texts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, text }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { showVoiceTextsStatus(j.error || "Error al guardar.", "err"); return; }
          voiceTextsState = j.voiceTexts || voiceTextsState;
          showVoiceTextsStatus("Guardado.", "ok");
        } catch (err) {
          showVoiceTextsStatus("Error de red: " + (err && err.message), "err");
        } finally { btn.disabled = false; }
      });
    });

    voiceTextsList.querySelectorAll("[data-reset]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const type = btn.dataset.reset;
        if (!confirm(`¿Restaurar el texto de voz de "${type}" al predeterminado?`)) return;
        btn.disabled = true;
        try {
          const res = await fetch("/voice-texts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, text: "" }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { showVoiceTextsStatus(j.error || "Error.", "err"); return; }
          voiceTextsState = j.voiceTexts || voiceTextsState;
          const ta = voiceTextsList.querySelector(`textarea[data-type="${type}"]`);
          if (ta) ta.value = "";
          showVoiceTextsStatus("Restaurado al default.", "ok");
        } catch (err) {
          showVoiceTextsStatus("Error de red.", "err");
        } finally { btn.disabled = false; }
      });
    });
  }

  async function loadVoiceTextsInitial() {
    try {
      const res = await fetch("/voice-texts", { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      voiceTextsState = j.voiceTexts || {};
      voiceTextsDefaults = j.defaults || {};
      renderVoiceTexts();
    } catch {}
  }

  socket.on("voice-texts:update", payload => {
    if (!payload) return;
    voiceTextsState = payload.voiceTexts || voiceTextsState;
    voiceTextsDefaults = payload.defaults || voiceTextsDefaults;
    renderVoiceTexts();
  });

  loadVoiceTextsInitial();

  renderButtons();
  if (isAdmin) renderScheduleOptions();
  renderSchedules([]);
  setStatus("Conectando…");
})();