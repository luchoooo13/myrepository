// Archivo: MainActivity.java
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
import android.util.Log;
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

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.HashMap;
import java.util.Map;

public class MainActivity extends AppCompatActivity {

    private TextView networkWarningChip;

    private static final String PREFS = "alerta_config";
    private static final String KEY_URL = "server_url";

    private static final int REQ_NOTIF = 2001;
    private static final int REQ_CAMERA = 2002;

    private WebView webView;

    public static final String BUILD_TAG = "v4-antiphantom";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        WebView myWebView = findViewById(R.id.webView);
        if(myWebView != null) {
            myWebView.getSettings().setJavaScriptEnabled(true);
            myWebView.getSettings().setDomStorageEnabled(true);
            Log.d("DEBUG_BRIDGE", "INTENTANDO REGISTRAR EL PUENTE...");
            myWebView.addJavascriptInterface(new WebAppInterface(this), "AndroidInterface");
            Log.d("DEBUG_BRIDGE", "PUENTE REGISTRADO. AHORA CARGAMOS LA URL.");
            myWebView.loadUrl("https://raptorial-cecila-uncatastrophically.ngrok-free.dev/client");
        }

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        requestRuntimePermissions();

        String url = getSavedUrl();
        if (url == null || url.isEmpty()) {
            showConfigScreen(null);
        } else {
            showWebView(url);
            startAlertService(url);
        }

        requestBatteryOptimizationExemption();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(this)) {
                Toast.makeText(this, "Por favor, permití que SchoolAlerts se muestre sobre otras apps para las alertas.", Toast.LENGTH_LONG).show();
                Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            }
        }
    }

    private void createNetworkChip() {
        ViewGroup root = findViewById(android.R.id.content);
        networkWarningChip = new TextView(this);
        networkWarningChip.setText("Mala conexión");
        networkWarningChip.setTextColor(Color.WHITE);
        networkWarningChip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        networkWarningChip.setPadding(dp(14), dp(6), dp(14), dp(6));
        networkWarningChip.setGravity(Gravity.CENTER);
        networkWarningChip.setVisibility(View.GONE);

        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(Color.parseColor("#D32F2F"));
        bg.setCornerRadius(dp(16));
        networkWarningChip.setBackground(bg);

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.topMargin = dp(40);
        root.addView(networkWarningChip, params);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    public class WebAppInterface {
        Context mContext;
        WebAppInterface(Context c) { mContext = c; }

        @JavascriptInterface
        public void showNetworkWarning(String title, String message) {
            // Implementación según UI de in-app
        }

        @JavascriptInterface
        public void hideNetworkWarning() {
            // Cancelar warning in-app
        }

        @JavascriptInterface
        public void testBridge() {
            Log.d("DEBUG_BRIDGE", "Puente AndroidInterface funcionando correctamente");
        }
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            @SuppressLint("BatteryLife")
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception ignored) {}
    }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    private void startAlertService(String url) {
        Intent i = new Intent(this, AlertService.class);
        i.setAction(AlertService.ACTION_START);
        i.putExtra(AlertService.EXTRA_SERVER_URL, url);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
            else startService(i);
        } catch (Exception ignored) {}
    }

    private void stopAlertService() {
        Intent i = new Intent(this, AlertService.class);
        i.setAction(AlertService.ACTION_STOP);
        try { startService(i); } catch (Exception ignored) {}
    }

    private String getSavedUrl() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, "");
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
        if (existing != null && !existing.isEmpty()) input.setText(existing);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
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
        if (errorMsg != null) errView.setText(errorMsg);
        else errView.setVisibility(View.GONE);
        root.addView(errView);

        Button connect = new Button(this);
        connect.setText("Conectar");
        connect.setAllCaps(false);
        connect.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        connect.setBackgroundColor(0xFFFFFFFF);
        connect.setTextColor(0xFF000000);
        connect.setPadding(dp(12), dp(14), dp(12), dp(14));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
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
        if (raw == null || raw.trim().isEmpty()) return null;
        String url = raw.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            if (!url.matches(".*:\\d+.*")) url = url + ":3000";
            url = "http://" + url;
        }
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        int schemeEnd = url.indexOf("://");
        int pathStart = url.indexOf('/', schemeEnd + 3);
        if (pathStart == -1) url = url + "/client";
        return url.matches("^https?://[^/]+/.+") ? url : null;
    }

    private void showWebView(String url) {
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(0xFF000000);

        webView = new WebView(this);
        try { webView.clearCache(true); } catch (Exception ignored) {}
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        try { s.setUserAgentString("SchoolAlertsAPK/2.0 (Android)"); } catch (Exception ignored) {}
        webView.setBackgroundColor(0xFF000000);

        try { webView.addJavascriptInterface(new AlertBridge(), "AlertBridge"); } catch (Exception ignored) {}

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showConfigScreen("No se pudo conectar a " + failingUrl + "\n\n(" + description + ")\n\n" + "Revisá que el servidor esté corriendo y que estés en la misma WiFi.");
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
                String u = request.getUrl() != null ? request.getUrl().toString() : "";
                if (u.contains("ngrok") || u.contains("trycloudflare")) {
                    view.loadUrl(u, ngrokHeaders());
                    return true;
                }
                return false;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) { request.grant(request.getResources()); }
        });

        webView.loadUrl(url, ngrokHeaders());
        container.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

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
                .setMessage("¿Querés conectarte a otro servidor? Tu configuración actual se va a poder editar.")
                .setPositiveButton("Sí", (d, w) -> { stopAlertService(); showConfigScreen(null); })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) { webView.goBack(); return true; }
        return super.onKeyDown(keyCode, event);
    }

    private static Map<String, String> ngrokHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("ngrok-skip-browser-warning", "true");
        return h;
    }

    private class AlertBridge {
        private SharedPreferences prefs() { return getSharedPreferences(AlertService.PREFS, Context.MODE_PRIVATE); }

        @JavascriptInterface
        public void setAlarmVolume(int percent) {
            final int clamped = Math.max(0, Math.min(100, percent));
            runOnUiThread(() -> {
                try {
                    AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    if (am != null) {
                        int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                        int target = Math.round((clamped / 100f) * max);
                        am.setStreamVolume(AudioManager.STREAM_ALARM, target, 0);
                    }
                } catch (Exception ignored) {}
                prefs().edit().putInt(AlertService.KEY_SET_VOLUME, clamped).apply();
            });
        }

        @JavascriptInterface
        public void setSirenVolume(int percent) {
            prefs().edit().putInt(AlertService.KEY_SET_SIREN_VOLUME, Math.max(0, Math.min(100, percent))).apply();
        }

        @JavascriptInterface
        public void setVoiceVolume(int percent) {
            prefs().edit().putInt(AlertService.KEY_SET_VOICE_VOLUME, Math.max(0, Math.min(100, percent))).apply();
        }

        @JavascriptInterface
        public void setVibrationEnabled(boolean enabled) {
            prefs().edit().putBoolean(AlertService.KEY_SET_VIBRATION, enabled).apply();
        }

        @JavascriptInterface
        public void setStrobeEnabled(boolean enabled) {
            prefs().edit().putBoolean(AlertService.KEY_SET_STROBE, enabled).apply();
        }

        @JavascriptInterface
        public void setVoiceEnabled(boolean enabled) {
            prefs().edit().putBoolean(AlertService.KEY_SET_VOICE, enabled).apply();
        }

        @JavascriptInterface
        public void setSirenTone(String tone) {
            prefs().edit().putString(AlertService.KEY_SET_SIREN_TONE, tone == null || tone.isEmpty() ? "default" : tone).apply();
        }

        @JavascriptInterface
        public void setPausedUntil(double ms) {
            final long value = ms < 0 ? 0L : (long) ms;
            prefs().edit().putLong(AlertService.KEY_PAUSED_UNTIL, value).apply();
            runOnUiThread(() -> {
                try {
                    long now = System.currentTimeMillis();
                    String msg;
                    if (value > now) {
                        if (value >= Long.MAX_VALUE / 2) msg = "Notificaciones pausadas (indefinido)";
                        else {
                            long mins = Math.max(1, (value - now) / 60000);
                            msg = mins >= 60 ? "Notificaciones pausadas por ~" + (mins / 60) + " h" : "Notificaciones pausadas por ~" + mins + " min";
                        }
                    } else msg = "Notificaciones reactivadas";
                    Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_SHORT).show();
                } catch (Exception ignored) {}
            });
            try {
                Intent i = new Intent(MainActivity.this, AlertService.class); i.setAction(AlertService.ACTION_REFRESH_PAUSE);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i); else startService(i);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void setSilentWindow(boolean enabled, String from, String to, String daysCsv) {
            prefs().edit().putBoolean(AlertService.KEY_SILENT_ENABLED, enabled)
                    .putString(AlertService.KEY_SILENT_FROM, from == null ? "" : from)
                    .putString(AlertService.KEY_SILENT_TO, to == null ? "" : to)
                    .putString(AlertService.KEY_SILENT_DAYS, daysCsv == null ? "" : daysCsv).apply();
        }

        @JavascriptInterface
        public void setDeviceName(String name) {
            prefs().edit().putString(AlertService.KEY_DEVICE_NAME, name == null ? "" : name.trim().substring(0, Math.min(name.trim().length(), 60))).apply();
        }

        @JavascriptInterface
        public void setClientId(String id) {
            String safe = id == null ? "" : id.trim().substring(0, Math.min(id.trim().length(), 64));
            String previous = prefs().getString(AlertService.KEY_CLIENT_ID, "");
            prefs().edit().putString(AlertService.KEY_CLIENT_ID, safe).apply();
            if (!safe.isEmpty() && !safe.equals(previous)) {
                runOnUiThread(() -> {
                    try {
                        Intent i = new Intent(MainActivity.this, AlertService.class); i.setAction(AlertService.ACTION_REFRESH_CLIENT_ID);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i); else startService(i);
                    } catch (Exception ignored) {}
                });
            }
        }

        @JavascriptInterface
        public String getDeviceName() {
            try { return prefs().getString(AlertService.KEY_DEVICE_NAME, ""); } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public void testAlert() {
            runOnUiThread(() -> {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Prueba de Sistema")
                        .setMessage("Esto activará la sirena, la vibración y el flash de la cámara a máximo volumen durante 5 segundos para comprobar el funcionamiento.\n\n¿Querés continuar con la prueba?")
                        .setPositiveButton("Sí, probar", (dialog, which) -> {
                            try {
                                Intent i = new Intent(MainActivity.this, AlertService.class); i.setAction(AlertService.ACTION_TEST_ALERT);
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i); else startService(i);
                            } catch (Exception ignored) {}
                        }).setNegativeButton("Cancelar", (dialog, which) -> dialog.dismiss()).setCancelable(true).show();
            });
        }

        @JavascriptInterface
        public void setBadConnectionNotificationsEnabled(boolean enabled) {
            try { prefs().edit().putBoolean(AlertService.KEY_BAD_CONNECTION_NOTIFS, enabled).apply(); } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public boolean getBadConnectionNotificationsEnabled() {
            try { return prefs().getBoolean(AlertService.KEY_BAD_CONNECTION_NOTIFS, true); } catch (Exception ignored) { return true; }
        }
    }
}