# APK de Alertas (cliente Android)

Aplicación Android mínima que abre la pantalla `/client` del servidor en una WebView
con audio habilitado y la pantalla siempre prendida. Al abrirla por primera vez te
pide la IP del servidor de la PC (ej. `192.168.1.39`) y la guarda. Después podés
cambiarla con el botón ⚙ arriba a la derecha.

## Requisitos para recompilar

- JDK 17
- Android SDK (cmdline-tools, `platforms;android-34`, `build-tools;34.0.0`)
- Gradle 8.6+

## Cómo compilar

```bash
cd apk/android
gradle assembleDebug
```

El APK queda en `app/build/outputs/apk/debug/app-debug.apk`.

## Instalar en el celular

1. Pasá el `.apk` al celular (WhatsApp, Drive, cable, etc.).
2. Abrilo desde el celular — la primera vez Android te va a pedir habilitar
   "Instalar apps de orígenes desconocidos" para el navegador/app que lo abrió.
3. Instalalo. Primera pantalla: ingresá la IP del servidor (la que te imprime el
   `npm start`, tipo `192.168.1.39`). Tocá **Conectar**.
4. Se conecta al `/client` y queda listo para recibir alertas.
