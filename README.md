# Alerta de Emergencia (LAN)

Sistema web de alertas de emergencia para **red local WiFi**. Una página **host**
permite disparar alertas con botones (Simulacro, Incendio, Sismo, Evacuación,
Intruso, Médica, Fuga de Gas, Amenaza de Bomba, Tormenta). Todos los
dispositivos **cliente** conectados al mismo servidor reciben la alerta en
tiempo real: la pantalla se pone con fondo rojo parpadeante, suena una sirena y
una voz femenina en español repite el tipo de alerta durante **1 minuto**.

## Requisitos

- Node.js 18 o superior.
- Todos los dispositivos en la misma red WiFi que la PC donde corre el
  servidor.

## Instalación

```bash
npm install
```

## Ejecución

```bash
npm start
```

Al iniciar, la consola imprime las URLs a las que se puede acceder desde los
otros dispositivos de la red, por ejemplo:

```
Servidor de Alertas de Emergencia iniciado
  Local:   http://localhost:3000/
  LAN:     http://192.168.1.42:3000/
```

Desde cualquier teléfono/tablet/PC en la misma red WiFi:

- **Host (el que dispara alertas):** `http://<IP-del-servidor>:3000/host`
- **Cliente (el que recibe la alerta):** `http://<IP-del-servidor>:3000/client`

## Uso

1. Abrí `http://<IP-del-servidor>:3000/client` en cada dispositivo que vaya a
   mostrar la alerta y tocá **“Activar sonido y voz”** una vez. Los navegadores
   no permiten reproducir audio ni voz sin un gesto del usuario, por eso este
   paso es obligatorio.
2. Desde otro dispositivo abrí `http://<IP-del-servidor>:3000/host` y tocá el
   botón del tipo de emergencia correspondiente. Para tipos distintos de
   Simulacro se pide confirmación antes de enviar.
3. Todos los clientes muestran pantalla roja parpadeante con el nombre de la
   alerta, suena la sirena y la voz femenina en español repite el tipo hasta
   que pasa 1 minuto o hasta que el host toca **“Detener alerta”**..**.

## Cómo funciona

- **Servidor:** Node.js con Express (archivos estáticos) y Socket.IO
  (websockets para broadcast en tiempo real). Mantiene el estado de la alerta
  activa para sincronizar clientes que se conectan en medio de una alerta.
- **Sirena:** generada en el cliente con la Web Audio API (sin depender de
  archivos mp3), modulando la frecuencia para un efecto de sirena.
- **Voz:** usa la Web Speech API del navegador (`speechSynthesis`) eligiendo
  una voz en español y prefiriendo voces femeninas disponibles en el sistema.
- **Duración:** 1 minuto fija, configurable en `server.js`
  (`ALERT_DURATION_MS`).

## Troubleshooting

- **No suena nada en el cliente:** asegurate de tocar “Activar sonido y voz”
  antes de la primera alerta. Algunos navegadores silencian audio si la pestaña
  está en segundo plano; dejala al frente.
- **La voz no habla en español:** el navegador usa las voces instaladas en el
  sistema operativo. En Windows/macOS instalá una voz en español; en Chrome
  Android suele estar disponible “Google español”.
- **Los clientes no ven el host:** verificá que estén en la misma red WiFi y
  que el firewall de la PC servidor permita conexiones entrantes al puerto
  `3000`.
