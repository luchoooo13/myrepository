# Corrección de Sincronización de Alertas

## Problema Identificado

En algunos dispositivos con `/cliente` (web) y la app Android, las alertas finalizaban **~4 segundos antes** que en el servidor, mostrando un tiempo restante adelantado.

### Causa Raíz

1. **Servidor**: Calcula `endsAt = realNow() + effectiveDuration` usando sincronización NTP (`timeOffsetMs`)
2. **Cliente Web**: Sincroniza con `/time` vía HTTP y calcula `remaining = alert.endsAt - (Date.now() + serverOffsetMs)`
3. **App Android**: Similar, sincroniza con `/time` y calcula `remaining = alertEndsAt - (System.currentTimeMillis() + serverTimeOffsetMs)`

**El problema**: Ambos clientes cerraban la alerta **localmente** cuando `remaining <= 0`, sin esperar al `alert:stop` del servidor.

Esto causaba desincronismos porque:
- La sincronización NTP (servidor) es más precisa que HTTP (clientes)
- Hay latencia variable en la red
- Los relojes locales pueden estar desalineados

## Solución Implementada

### 1. Cliente Web (`public/client.js`)

**Cambio**: Remover el cierre automático por tiempo local.

```javascript
// ANTES (INCORRECTO):
const update = () => {
  const nowRealUpdate = Date.now() + serverOffsetMs;
  const remaining = alert.endsAt - nowRealUpdate;
  alertTimeEl.textContent = formatRemaining(remaining);
  if (remaining <= 0) hideAlert();  // ❌ CIERRA LOCALMENTE
};

// DESPUÉS (CORRECTO):
const update = () => {
  const nowRealUpdate = Date.now() + serverOffsetMs;
  const remaining = alert.endsAt - nowRealUpdate;
  alertTimeEl.textContent = formatRemaining(remaining);
  // Solo mostrar el contador, pero NO cerrar automáticamente
  // El cierre debe venir del servidor via alert:stop
};
```

**Beneficio**: El cliente solo **muestra** el contador visual, pero espera el evento `alert:stop` del servidor para cerrar realmente.

### 2. App Android (`apk/android/app/src/main/java/com/alertaemergencia/client/AlertActivity.java`)

**Cambio**: Remover el cierre automático en `startCountdown()`.

```java
// ANTES (INCORRECTO):
if (remaining == 0) {
    if (countdownRing != null) countdownRing.jumpToFraction(0f);
    return;  // ❌ CIERRA LOCALMENTE
}

// DESPUÉS (CORRECTO):
// CORRECCIÓN: Solo mostrar el contador, NO cerrar automáticamente
// El cierre debe venir del servidor via BroadcastReceiver (ACTION_CLOSE)
// Esto evita desincronismos por diferencias en sincronización NTP vs HTTP
```

**Beneficio**: La Activity solo **anima** el countdown, pero espera el `BroadcastReceiver` (ACTION_CLOSE) del servidor para cerrar.

## Flujo Correcto Ahora

```
1. Servidor emite alert:start con endsAt (tiempo autoritativo)
   ↓
2. Cliente recibe alert:start
   ├─ Sincroniza con /time para obtener serverOffsetMs
   ├─ Calcula remaining = endsAt - (now + offset)
   └─ Muestra contador visual actualizado cada 250ms
   ↓
3. Servidor espera effectiveDuration ms
   ↓
4. Servidor emite alert:stop (evento autoritativo)
   ↓
5. Cliente recibe alert:stop
   └─ Cierra la alerta (hideAlert)
```

## Archivos Modificados

- `public/client.js`: Remover `if (remaining <= 0) hideAlert();` de la función `update()`
- `apk/android/app/src/main/java/com/alertaemergencia/client/AlertActivity.java`: Remover cierre por timeout en `startCountdown()`

## Página de Radio EAS-SAME

Se agregó una nueva página `/radio.html` con:

- **Interfaz retro** estilo receptor EAS-SAME con tema verde terminal
- **Botones de reproducción**: Tono EAS, Sirena, Voz
- **Visualizador de ondas** animado
- **Control de volumen** interactivo
- **Archivos de audio**: `eas.mp3`, `siren.mp3`, `alerta.mp3`

### Acceso

```
http://localhost:3000/radio.html
```

### Características

- Tono EAS-SAME (853 Hz)
- Sirena de emergencia (800 Hz)
- Mensaje de voz de alerta
- Indicadores de estado visuales
- Soporte para teclado (1, 2, 3, Espacio)

## Verificación

Para verificar que la corrección funciona:

1. Disparar una alerta desde el host
2. Observar que en `/cliente` y la app el contador se detiene en 0 pero **no cierra**
3. Esperar a que el servidor emita `alert:stop` (después de `effectiveDuration`)
4. Verificar que la alerta se cierra **exactamente** cuando el servidor lo ordena

## Commits Relacionados

- `902f173`: CORRECIÓN: Remover cierre automático de alertas en cliente web
- `5767916`: CORRECIÓN: Remover cierre automático de alertas en app Android
- `149a917`: Agregar página de radio EAS-SAME con sonidos
