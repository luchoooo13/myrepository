# ProGuard / R8 rules para SchoolAlerts client.
#
# Objetivo: minificar/ofuscar el código propio para que el APK sea más
# chico y opaco (menos superficie que Play Protect escanee), pero
# mantener intactas las partes que fallarían con ofuscación.

# Mantener nombres de clases esenciales de Android (servicios, receivers,
# activities) — son referenciadas desde el AndroidManifest por string.
-keep class com.alertaemergencia.client.MainActivity { *; }
-keep class com.alertaemergencia.client.AlertActivity { *; }
-keep class com.alertaemergencia.client.AlertService { *; }
-keep class com.alertaemergencia.client.RestartReceiver { *; }

# La clase del JavascriptInterface expone @JavascriptInterface a la
# WebView; si R8 le cambia los nombres a los métodos, el JS del cliente
# no los encuentra.
-keepattributes *Annotation*
-keep @interface android.webkit.JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Socket.IO + engine.io usan reflección interna. Mantener sus clases
# tal cual para no romper la conexión websocket.
-keep class io.socket.** { *; }
-keep class com.github.nkzawa.** { *; }
-keep class okhttp3.** { *; }
-keep class okio.** { *; }
-dontwarn okhttp3.**
-dontwarn okio.**

# Evitar warnings por clases ausentes en runtime específicas a ciertas
# configuraciones (JSR305, conscrypt, kotlin stdlib).
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn kotlin.**
