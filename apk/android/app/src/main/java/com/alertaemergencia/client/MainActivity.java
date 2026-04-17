package com.alertaemergencia.client;

import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "alerta_config";
    private static final String KEY_URL = "server_url";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Pantalla siempre prendida (útil para recibir alertas en cualquier momento).
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String url = getSavedUrl();
        if (url == null || url.isEmpty()) {
            showConfigScreen(null);
        } else {
            showWebView(url);
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
        root.setBackgroundColor(0xFF0B1220);
        int pad = dp(24);
        root.setPadding(pad, dp(64), pad, pad);

        TextView title = new TextView(this);
        title.setText("Alertas de Emergencia");
        title.setTextColor(0xFFF8FAFC);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Conectate al servidor de la PC que está en la misma WiFi.");
        subtitle.setTextColor(0xFF94A3B8);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        subtitle.setPadding(0, dp(8), 0, dp(24));
        root.addView(subtitle);

        TextView label = new TextView(this);
        label.setText("Dirección del servidor");
        label.setTextColor(0xFFE2E8F0);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        root.addView(label);

        final EditText input = new EditText(this);
        input.setHint("192.168.1.39   (o 192.168.1.39:3000)");
        input.setHintTextColor(0xFF64748B);
        input.setTextColor(0xFFF8FAFC);
        input.setBackgroundColor(0xFF111827);
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
        hint.setTextColor(0xFF64748B);
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
        connect.setBackgroundColor(0xFF0EA5E9);
        connect.setTextColor(0xFFFFFFFF);
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
        container.setBackgroundColor(0xFF0B1220);

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        webView.setBackgroundColor(0xFF0B1220);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode,
                                        String description, String failingUrl) {
                showConfigScreen("No se pudo conectar a " + failingUrl
                        + "\n\n(" + description + ")\n\n"
                        + "Revisá que el servidor esté corriendo y que estés en la misma WiFi.");
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Permitimos por default (el cliente no usa cámara/mic, pero por las dudas).
                request.grant(request.getResources());
            }
        });

        webView.loadUrl(url);

        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        // Botón flotante chico para reconfigurar servidor.
        Button cfg = new Button(this);
        cfg.setText("⚙");
        cfg.setAllCaps(false);
        cfg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        cfg.setTextColor(0xFFFFFFFF);
        cfg.setBackgroundColor(0x80000000);
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(dp(48), dp(48));
        flp.gravity = Gravity.TOP | Gravity.END;
        flp.topMargin = dp(8);
        flp.rightMargin = dp(8);
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
                .setPositiveButton("Sí", (d, w) -> showConfigScreen(null))
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
}
