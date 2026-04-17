(function () {
  // Reloj en vivo en horario de Buenos Aires, Argentina.
  // Si el reloj de la PC que corre el server está corrido unos segundos,
  // mostrar ese reloj llevaría a hora equivocada. Sincronizamos con el
  // endpoint /time del server, que a su vez pide la hora real a una fuente
  // externa (worldtimeapi / Google) al arrancar.
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

  let serverOffsetMs = 0;

  async function syncWithServer() {
    try {
      const t0 = Date.now();
      const r = await fetch("/time", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const t1 = Date.now();
      const latency = (t1 - t0) / 2;
      // j.now refleja el momento aprox (t0 + latency) en tiempo real.
      serverOffsetMs = j.now - (t0 + latency);
    } catch {
      /* ignore: usamos reloj local */
    }
  }

  function tick() {
    const now = new Date(Date.now() + serverOffsetMs);
    const timeEls = document.querySelectorAll("[data-clock-time]");
    const dateEls = document.querySelectorAll("[data-clock-date]");
    const time = fmt.format(now);
    const date = dateFmt.format(now);
    for (const el of timeEls) el.textContent = time;
    for (const el of dateEls) el.textContent = date;
  }

  function start() {
    tick();
    const msToNextSecond = 1000 - ((Date.now() + serverOffsetMs) % 1000);
    setTimeout(() => {
      tick();
      setInterval(tick, 1000);
    }, msToNextSecond);
  }

  // Sincronizamos una vez y después arrancamos el tick. Si falla el fetch,
  // arrancamos igual con el reloj local.
  syncWithServer().finally(start);
  setInterval(syncWithServer, 5 * 60 * 1000);
})();
