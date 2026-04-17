(function () {
  // Reloj en vivo en horario de Buenos Aires, Argentina.
  const TZ = "America/Argentina/Buenos_Aires";
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const dateFmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
  });

  function tick() {
    const now = new Date();
    const timeEls = document.querySelectorAll("[data-clock-time]");
    const dateEls = document.querySelectorAll("[data-clock-date]");
    const time = fmt.format(now);
    const date = dateFmt.format(now);
    for (const el of timeEls) el.textContent = time;
    for (const el of dateEls) el.textContent = date;
  }

  tick();
  // Re-sincronizá al próximo segundo para que el segundero salte limpio.
  const msToNextSecond = 1000 - (Date.now() % 1000);
  setTimeout(() => {
    tick();
    setInterval(tick, 1000);
  }, msToNextSecond);
})();
