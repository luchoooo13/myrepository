package com.alertaemergencia.client;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.HashMap;
import java.util.Map;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "alerta_config";
    private static final String KEY_URL = "server_url";

    private static final int REQ_NOTIF = 2001;
    private static final int REQ_CAMERA = 2002;

    private WebView webView;

    // Identificador de build visible en pantalla / notificación para que el
    // usuario pueda confirmar de un vistazo que está corriendo el APK nuevo.
    // Subir este valor cuando cambiamos algo importante del nativo para que
    // sea obvio si el APK viejo quedó instalado por algún motivo.
    public static final String BUILD_TAG = "v3-pausa";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Pantalla siempre prendida (útil para recibir alertas en cualquier momento).
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Toast visible apenas arranca la app. Sirve para confirmar qué versión
        // del APK quedó instalada (crítico cuando el instalador silencia
        // errores o el usuario cree que actualizó pero no).
        try {
            Toast.makeText(
                    getApplicationContext(),
                    "SchoolAlerts " + BUILD_TAG,
                    Toast.LENGTH_SHORT).show();
        } catch (Exception ignored) {
        }

        requestRuntimePermissions();

        String url = getSavedUrl();
        if (url == null || url.isEmpty()) {
            showConfigScreen(null);
        } else {
            showWebView(url);
            startAlertService(url);
        }

        // Para que el servicio sobreviva a "cerrar desde multitarea", la
        // app necesita estar fuera del ahorro de batería. Pedimos la exención
        // una sola vez; el usuario puede aceptar o rechazar.
        requestBatteryOptimizationExemption();
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            @SuppressLint("BatteryLife")
            Intent i = new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception ignored) {
            // Algunos OEM no tienen esta intent; el usuario tendrá que
            // hacerlo a mano desde Ajustes → Batería → SchoolAlerts.
        }
    }

    private void requestRuntimePermissions() {
        // Android 13+: notificaciones en runtime.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this,
                    Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQ_NOTIF);
            }
        }
        // Cámara: necesaria para el flash (torch).
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.CAMERA},
                    REQ_CAMERA);
        }
    }

    private void startAlertService(String url) {
        Intent i = new Intent(this, AlertService.class);
        i.setAction(AlertService.ACTION_START);
        i.putExtra(AlertService.EXTRA_SERVER_URL, url);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i);
            } else {
                startService(i);
            }
        } catch (Exception ignored) {
        }
    }

    private void stopAlertService() {
        Intent i = new Intent(this, AlertService.class);
        i.setAction(AlertService.ACTION_STOP);
        try {
            startService(i);
        } catch (Exception ignored) {
        }
    }

    private String getSavedUrl() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        return prefs.getString(KEY_URL, "");
    }

    private void saveUrl(String url) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
    }

    private void showConfigScreen(String errorMsg) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF000000);
        int pad = dp(24);
        root.setPadding(pad, dp(64), pad, pad);

        TextView title = new TextView(this);
        title.setText("SchoolAlerts");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Conectate al servidor de la PC que está en la misma WiFi.");
        subtitle.setTextColor(0xFFA3A3A3);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        subtitle.setPadding(0, dp(8), 0, dp(24));
        root.addView(subtitle);

        TextView label = new TextView(this);
        label.setText("Dirección del servidor");
        label.setTextColor(0xFFFFFFFF);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        root.addView(label);

        final EditText input = new EditText(this);
        input.setHint("192.168.1.39   (o 192.168.1.39:3000)");
        input.setHintTextColor(0xFF6E6E6E);
        input.setTextColor(0xFFFFFFFF);
        input.setBackgroundColor(0xFF0A0A0A);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setPadding(dp(12), dp(12), dp(12), dp(12));
        String existing = getSavedUrl();
        if (existing != null && !existing.isEmpty()) {
            input.setText(existing);
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        input.setLayoutParams(lp);
        root.addView(input);

        TextView hint = new TextView(this);
        hint.setText("Ejemplos válidos:\n• 192.168.1.39\n• 192.168.1.39:3000\n• http://192.168.1.39:3000/client");
        hint.setTextColor(0xFF6E6E6E);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setPadding(0, dp(8), 0, dp(24));
        root.addView(hint);

        final TextView errView = new TextView(this);
        errView.setTextColor(0xFFF87171);
        errView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        errView.setPadding(0, 0, 0, dp(12));
        if (errorMsg != null) {
            errView.setText(errorMsg);
        } else {
            errView.setVisibility(View.GONE);
        }
        root.addView(errView);

        Button connect = new Button(this);
        connect.setText("Conectar");
        connect.setAllCaps(false);
        connect.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        connect.setBackgroundColor(0xFFFFFFFF);
        connect.setTextColor(0xFF000000);
        connect.setPadding(dp(12), dp(14), dp(12), dp(14));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.topMargin = dp(8);
        connect.setLayoutParams(clp);
        connect.setOnClickListener(v -> {
            String raw = input.getText().toString().trim();
            String full = normalizeUrl(raw);
            if (full == null) {
                errView.setText("Dirección inválida. Probá con 192.168.1.39");
                errView.setVisibility(View.VISIBLE);
                return;
            }
            saveUrl(full);
            showWebView(full);
            startAlertService(full);
        });
        root.addView(connect);

        setContentView(root);
    }

    private String normalizeUrl(String raw) {
        if (raw == null) return null;
        raw = raw.trim();
        if (raw.isEmpty()) return null;

        String url = raw;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            // Si no tiene :PUERTO, usamos 3000 por default.
            if (!url.matches(".*:\\d+.*")) {
                url = url + ":3000";
            }
            url = "http://" + url;
        }
        // Quitamos / finales.
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);

        // Si no tiene /client, /host u otra ruta, agregamos /client.
        // Extraemos host:port para decidir.
        int schemeEnd = url.indexOf("://");
        int pathStart = url.indexOf('/', schemeEnd + 3);
        if (pathStart == -1) {
            url = url + "/client";
        }

        // Validación mínima.
        if (!url.matches("^https?://[^/]+/.+")) {
            return null;
        }
        return url;
    }

    private void showWebView(String url) {
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(0xFF000000);

        webView = new WebView(this);
        // Forzamos que cada arranque baje los archivos frescos del server.
        // Sin esto el WebView cachea agresivamente el client.js y se queda
        // con la versión vieja aunque el server ya sirva una nueva (por ej.
        // no tiene pushPausedUntilToBridge y entonces la pausa en APK no
        // llega al servicio nativo).
        try {
            webView.clearCache(true);
        } catch (Exception ignored) {
        }
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // User-Agent custom (sin Mozilla/Chrome) por dos motivos:
        //  1. Marcamos que corre dentro del APK para que el JS del /client
        //     desactive sirena/flash/vibración en la web (lo hace el servicio
        //     nativo para que funcione también en background).
        //  2. ngrok muestra una página intersticial de "visit site" a cualquier
        //     request cuyo User-Agent parezca un navegador. Usando un UA custom
        //     ngrok no lo marca como browser y salteamos el warning.
        try {
            s.setUserAgentString("SchoolAlertsAPK/2.0 (Android)");
        } catch (Exception ignored) {
        }
        webView.setBackgroundColor(0xFF000000);

        // Puente JS → nativo para que la pestaña "Ajustes" pueda:
        //  - probar la alerta localmente (AlertBridge.testAlert)
        //  - cambiar el volumen del stream de alarma (AlertBridge.setAlarmVolume)
        // El JS del cliente detecta si `window.AlertBridge` existe y, si sí,
        // delega en él; si no, cae a la simulación vieja dentro del webview.
        try {
            webView.addJavascriptInterface(new AlertBridge(), "AlertBridge");
        } catch (Exception ignored) {
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode,
                                        String description, String failingUrl) {
                showConfigScreen("No se pudo conectar a " + failingUrl
                        + "\n\n(" + description + ")\n\n"
                        + "Revisá que el servidor esté corriendo y que estés en la misma WiFi.");
            }

            // Si la URL es de ngrok y el usuario toca "Visit Site" en la
            // página intersticial (o si por alguna razón aparece), le
            // agregamos el header ngrok-skip-browser-warning a la recarga
            // para que ngrok no la vuelva a mostrar.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view,
                                                     WebResourceRequest request) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
                String u = request.getUrl() != null
                        ? request.getUrl().toString() : "";
                if (u.contains("ngrok") || u.contains("trycloudflare")) {
                    view.loadUrl(u, ngrokHeaders());
                    return true;
                }
                return false;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Permitimos por default (el cliente no usa cámara/mic, pero por las dudas).
                request.grant(request.getResources());
            }
        });

        // Cargamos la URL con el header ngrok-skip-browser-warning para evitar
        // que ngrok muestre la página intersticial de "abuse warning".
        webView.loadUrl(url, ngrokHeaders());

        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        // Botón flotante chico para reconfigurar servidor. Lo mandamos al
        // costado inferior derecho, apenas arriba de la barra de pestañas web
        // (~84px desde el fondo), para no tapar el header ni el botón X de
        // cerrar alerta (que vive arriba a la derecha).
        Button cfg = new Button(this);
        cfg.setText("⚙");
        cfg.setAllCaps(false);
        cfg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        cfg.setTextColor(0xFFFFFFFF);
        cfg.setBackgroundColor(0x66000000);
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(dp(34), dp(34));
        flp.gravity = Gravity.BOTTOM | Gravity.END;
        flp.bottomMargin = dp(92);
        flp.rightMargin = dp(10);
        cfg.setLayoutParams(flp);
        cfg.setOnClickListener(v -> confirmReconfigure());
        container.addView(cfg);

        setContentView(container);
    }

    private void confirmReconfigure() {
        new AlertDialog.Builder(this)
                .setTitle("Cambiar servidor")
                .setMessage("¿Querés conectarte a otro servidor? " +
                        "Tu configuración actual se va a poder editar.")
                .setPositiveButton("Sí", (d, w) -> {
                    stopAlertService();
                    showConfigScreen(null);
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private int dp(int v) {
        float d = getResources().getDisplayMetrics().density;
        return (int) (v * d + 0.5f);
    }

    private static Map<String, String> ngrokHeaders() {
        Map<String, String> h = new HashMap<>();
        // Cualquier valor alcanza; ngrok solo chequea que el header exista.
        h.put("ngrok-skip-browser-warning", "true");
        return h;
    }

    /**
     * Puente JavaScript ↔ Java expuesto al webview del cliente. Los métodos
     * marcados con @JavascriptInterface corren en un hilo binder, no el hilo
     * de UI; para tocar cosas de UI las posteamos al main thread.
     */
    private class AlertBridge {
        private SharedPreferences prefs() {
            return getSharedPreferences(
                    AlertService.PREFS, Context.MODE_PRIVATE);
        }

        /**
         * Ajusta el volumen del stream de alarma (el que usa el servicio
         * nativo para la sirena) a un porcentaje 0..100. Persistimos para
         * que el servicio también lo aplique cuando dispare una alerta
         * (en startSiren) aunque la UI no esté abierta.
         */
        @JavascriptInterface
        public void setAlarmVolume(int percent) {
            final int clamped = Math.max(0, Math.min(100, percent));
            runOnUiThread(() -> {
                try {
                    AudioManager am = (AudioManager)
                            getSystemService(Context.AUDIO_SERVICE);
                    if (am == null) return;
                    int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                    int target = Math.round((clamped / 100f) * max);
                    am.setStreamVolume(AudioManager.STREAM_ALARM, target, 0);
                } catch (Exception ignored) {
                }
                prefs().edit()
                        .putInt(AlertService.KEY_SET_VOLUME, clamped)
                        .apply();
            });
        }

        /**
         * Guarda si el usuario quiere vibración durante la alerta. El
         * servicio nativo lo lee antes de llamar a startVibrationLoop.
         */
        @JavascriptInterface
        public void setVibrationEnabled(boolean enabled) {
            prefs().edit()
                    .putBoolean(AlertService.KEY_SET_VIBRATION, enabled)
                    .apply();
        }

        /**
         * Guarda si el usuario quiere flash de cámara durante la alerta.
         */
        @JavascriptInterface
        public void setStrobeEnabled(boolean enabled) {
            prefs().edit()
                    .putBoolean(AlertService.KEY_SET_STROBE, enabled)
                    .apply();
        }

        /**
         * Guarda si el usuario quiere voz durante la alerta.
         */
        @JavascriptInterface
        public void setVoiceEnabled(boolean enabled) {
            prefs().edit()
                    .putBoolean(AlertService.KEY_SET_VOICE, enabled)
                    .apply();
        }

        /**
         * Guarda el timestamp (ms) hasta el que el usuario pausó las
         * notificaciones en este dispositivo. El servicio nativo lo lee en
         * onAlertStart y descarta las alertas mientras la pausa siga
         * vigente. 0 = no pausado. Number.MAX_SAFE_INTEGER = indefinido.
         */
        @JavascriptInterface
        public void setPausedUntil(double ms) {
            final long value = ms < 0 ? 0L : (long) ms;
            prefs().edit()
                    .putLong(AlertService.KEY_PAUSED_UNTIL, value)
                    .apply();
            // Feedback visual: si el usuario activó/desactivó una pausa,
            // mostramos un toast en el UI thread. Sirve también como
            // confirmación de que el APK nuevo (con este bridge) está
            // instalado y que el JS llegó al nativo.
            runOnUiThread(() -> {
                try {
                    long now = System.currentTimeMillis();
                    String msg;
                    if (value > now) {
                        if (value >= Long.MAX_VALUE / 2) {
                            msg = "Notificaciones pausadas (indefinido)";
                        } else {
                            long mins = Math.max(1, (value - now) / 60000);
                            if (mins >= 60) {
                                long hours = mins / 60;
                                msg = "Notificaciones pausadas por ~" + hours + " h";
                            } else {
                                msg = "Notificaciones pausadas por ~" + mins + " min";
                            }
                        }
                    } else {
                        msg = "Notificaciones reactivadas";
                    }
                    Toast.makeText(
                            getApplicationContext(), msg, Toast.LENGTH_SHORT).show();
                } catch (Exception ignored) {
                }
            });
            // Avisamos al servicio para que refresque la notificación
            // persistente ("Conectado · esperando alertas" → "⏸ Pausado…").
            try {
                Intent i = new Intent(
                        MainActivity.this, AlertService.class);
                i.setAction(AlertService.ACTION_REFRESH_PAUSE);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(i);
                } else {
                    startService(i);
                }
            } catch (Exception ignored) {
            }
        }

        /**
         * Dispara una alerta de prueba local de 5 segundos en el servicio
         * nativo — reproduce sirena + voz + flash + vibración sin pasar por
         * el server, así el usuario puede validar que todo funciona.
         */
        @JavascriptInterface
        public void testAlert() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(
                            MainActivity.this, AlertService.class);
                    i.setAction(AlertService.ACTION_TEST_ALERT);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(i);
                    } else {
                        startService(i);
                    }
                } catch (Exception ignored) {
                }
            });
        }
    }
}
