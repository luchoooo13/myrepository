package com.alertaemergencia.client;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/**
 * Pantalla de bienvenida / onboarding que se muestra la primera vez que
 * se abre la app. Explica qué hace SchoolAlerts, pide los permisos
 * necesarios y lleva al usuario a {@link MainActivity}.
 */
public class OnboardingActivity extends AppCompatActivity {

    private static final String PREFS = "alerta_config";
    private static final String KEY_ONBOARDING_DONE = "onboarding_done";

    private static final int REQ_NOTIF = 3001;
    private static final int REQ_CAMERA = 3002;

    private LinearLayout pagesContainer;
    private int currentPage = 0;
    private static final int TOTAL_PAGES = 4;

    // Colores M3-ish
    private static final int BG = 0xFF0e0e11;
    private static final int SURFACE = 0xFF1a1a20;
    private static final int PRIMARY = 0xFFbac8ff;
    private static final int ON_SURFACE = 0xFFf0f0f5;
    private static final int ON_SURFACE_VARIANT = 0xFFa3a3b0;
    private static final int ON_SURFACE_MUTED = 0xFF6e6e7a;

    private View[] dots;
    private Button nextBtn;
    private Button skipBtn;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Si ya hizo el onboarding, ir directo a MainActivity.
        if (isOnboardingDone()) {
            goToMain();
            return;
        }

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        setContentView(buildUI());
        showPage(0);
    }

    private boolean isOnboardingDone() {
        return getSharedPreferences(PREFS, MODE_PRIVATE)
                .getBoolean(KEY_ONBOARDING_DONE, false);
    }

    private void markOnboardingDone() {
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit().putBoolean(KEY_ONBOARDING_DONE, true).apply();
    }

    private void goToMain() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    // ── UI ───────────────────────────────────────────────────────────────

    private View buildUI() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        // Container de páginas (se intercambia su contenido)
        pagesContainer = new LinearLayout(this);
        pagesContainer.setOrientation(LinearLayout.VERTICAL);
        pagesContainer.setGravity(Gravity.CENTER);
        int padH = dp(32);
        pagesContainer.setPadding(padH, dp(80), padH, dp(160));
        root.addView(pagesContainer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        // Bottom bar con dots + botones
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);
        bottom.setPadding(padH, dp(16), padH, dp(32));
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM);
        root.addView(bottom, blp);

        // Dots
        LinearLayout dotsRow = new LinearLayout(this);
        dotsRow.setOrientation(LinearLayout.HORIZONTAL);
        dotsRow.setGravity(Gravity.CENTER);
        dots = new View[TOTAL_PAGES];
        for (int i = 0; i < TOTAL_PAGES; i++) {
            View dot = new View(this);
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.OVAL);
            bg.setColor(ON_SURFACE_MUTED);
            bg.setSize(dp(8), dp(8));
            dot.setBackground(bg);
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(8), dp(8));
            dlp.setMargins(dp(4), 0, dp(4), 0);
            dotsRow.addView(dot, dlp);
            dots[i] = dot;
        }
        bottom.addView(dotsRow);

        // Botón principal
        nextBtn = new Button(this);
        nextBtn.setText("Siguiente");
        nextBtn.setAllCaps(false);
        nextBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        nextBtn.setTypeface(null, Typeface.BOLD);
        nextBtn.setTextColor(0xFF0e0e11);
        GradientDrawable nextBg = new GradientDrawable();
        nextBg.setColor(PRIMARY);
        nextBg.setCornerRadius(dp(16));
        nextBtn.setBackground(nextBg);
        nextBtn.setPadding(dp(24), dp(14), dp(24), dp(14));
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        nlp.topMargin = dp(24);
        bottom.addView(nextBtn, nlp);
        nextBtn.setOnClickListener(v -> onNext());

        // Botón "Omitir"
        skipBtn = new Button(this);
        skipBtn.setText("Omitir");
        skipBtn.setAllCaps(false);
        skipBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        skipBtn.setTextColor(ON_SURFACE_MUTED);
        skipBtn.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(8);
        slp.gravity = Gravity.CENTER_HORIZONTAL;
        bottom.addView(skipBtn, slp);
        skipBtn.setOnClickListener(v -> {
            markOnboardingDone();
            goToMain();
        });

        return root;
    }

    // ── Pages ────────────────────────────────────────────────────────────

    private void showPage(int page) {
        currentPage = page;
        pagesContainer.removeAllViews();

        switch (page) {
            case 0: buildWelcomePage(); break;
            case 1: buildFeaturesPage(); break;
            case 2: buildPermissionsPage(); break;
            case 3: buildReadyPage(); break;
        }

        // Update dots
        for (int i = 0; i < TOTAL_PAGES; i++) {
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.OVAL);
            bg.setColor(i == page ? PRIMARY : ON_SURFACE_MUTED);
            bg.setSize(dp(8), dp(8));
            dots[i].setBackground(bg);
        }

        // Update buttons
        if (page == TOTAL_PAGES - 1) {
            nextBtn.setText("Empezar");
            skipBtn.setVisibility(View.GONE);
        } else if (page == 2) {
            nextBtn.setText("Conceder permisos");
            skipBtn.setVisibility(View.VISIBLE);
        } else {
            nextBtn.setText("Siguiente");
            skipBtn.setVisibility(View.VISIBLE);
        }
    }

    private void onNext() {
        if (currentPage == 2) {
            requestAllPermissions();
            return;
        }
        if (currentPage >= TOTAL_PAGES - 1) {
            markOnboardingDone();
            goToMain();
            return;
        }
        showPage(currentPage + 1);
    }

    // ── Page 0: Bienvenida ──

    private void buildWelcomePage() {
        addIcon("\uD83D\uDEA8", 64); // 🚨
        addTitle("Bienvenido a\nSchoolAlerts");
        addBody("El sistema de alertas de emergencia para tu institución. " +
                "Recibí alertas en tiempo real con sirena, flash y vibración.");
    }

    // ── Page 1: Funciones ──

    private void buildFeaturesPage() {
        addIcon("⚡", 48);
        addTitle("¿Qué hace la app?");
        addFeatureItem("🔔", "Alertas en tiempo real",
                "Recibí notificaciones instantáneas de emergencia.");
        addFeatureItem("📢", "Sirena y voz",
                "Sonido de alerta con voz que indica el tipo de emergencia.");
        addFeatureItem("📱", "Flash y vibración",
                "El flash de la cámara y la vibración se activan automáticamente.");
        addFeatureItem("🔇", "Control total",
                "Configurá volumen, tono de sirena y horarios de silencio.");
    }

    // ── Page 2: Permisos ──

    private void buildPermissionsPage() {
        addIcon("🔐", 48);
        addTitle("Permisos necesarios");
        addBody("Para funcionar correctamente, SchoolAlerts necesita estos permisos:");

        addPermissionItem("🔔", "Notificaciones",
                "Para mostrarte alertas aunque la app esté en segundo plano.",
                hasNotificationPermission());
        addPermissionItem("📸", "Cámara",
                "Para activar el flash de la cámara durante una emergencia.",
                hasCameraPermission());
        addPermissionItem("🔋", "Sin restricción de batería",
                "Para que el servicio no se detenga en segundo plano.",
                hasBatteryExemption());
    }

    // ── Page 3: Listo ──

    private void buildReadyPage() {
        addIcon("✅", 64);
        addTitle("¡Todo listo!");
        addBody("Ya podés conectarte al servidor de alertas. " +
                "En la siguiente pantalla, ingresá la dirección del servidor " +
                "que te dio tu administrador.");
    }

    // ── Helpers de UI ────────────────────────────────────────────────────

    private void addIcon(String emoji, int sizeSp) {
        TextView tv = new TextView(this);
        tv.setText(emoji);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        tv.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.bottomMargin = dp(24);
        pagesContainer.addView(tv, lp);
    }

    private void addTitle(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(ON_SURFACE);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        tv.setTypeface(null, Typeface.BOLD);
        tv.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(16);
        pagesContainer.addView(tv, lp);
    }

    private void addBody(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(ON_SURFACE_VARIANT);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setGravity(Gravity.CENTER);
        tv.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(20);
        pagesContainer.addView(tv, lp);
    }

    private void addFeatureItem(String emoji, String title, String desc) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(10), 0, dp(10));

        TextView icon = new TextView(this);
        icon.setText(emoji);
        icon.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                dp(40), ViewGroup.LayoutParams.WRAP_CONTENT);
        row.addView(icon, ilp);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);

        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(ON_SURFACE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setTypeface(null, Typeface.BOLD);
        col.addView(t);

        TextView d = new TextView(this);
        d.setText(desc);
        d.setTextColor(ON_SURFACE_VARIANT);
        d.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        col.addView(d);

        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        row.addView(col, clp);

        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        pagesContainer.addView(row, rlp);
    }

    private void addPermissionItem(String emoji, String title, String desc,
                                    boolean granted) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable rowBg = new GradientDrawable();
        rowBg.setColor(SURFACE);
        rowBg.setCornerRadius(dp(16));
        row.setBackground(rowBg);
        row.setPadding(dp(16), dp(14), dp(16), dp(14));

        TextView icon = new TextView(this);
        icon.setText(emoji);
        icon.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                dp(36), ViewGroup.LayoutParams.WRAP_CONTENT);
        row.addView(icon, ilp);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);

        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(ON_SURFACE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        t.setTypeface(null, Typeface.BOLD);
        col.addView(t);

        TextView d = new TextView(this);
        d.setText(desc);
        d.setTextColor(ON_SURFACE_MUTED);
        d.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        col.addView(d);

        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        clp.leftMargin = dp(4);
        row.addView(col, clp);

        // Status badge
        TextView badge = new TextView(this);
        if (granted) {
            badge.setText("✓");
            badge.setTextColor(0xFF69e0a5);
        } else {
            badge.setText("•");
            badge.setTextColor(0xFFffc84a);
        }
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        badge.setTypeface(null, Typeface.BOLD);
        row.addView(badge);

        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = dp(8);
        pagesContainer.addView(row, rlp);
    }

    // ── Permisos ─────────────────────────────────────────────────────────

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(this,
                Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(this,
                Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void requestAllPermissions() {
        // Notificaciones (Android 13+)
        if (!hasNotificationPermission()) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQ_NOTIF);
        }
        // Cámara
        if (!hasCameraPermission()) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.CAMERA},
                    REQ_CAMERA);
        }
        // Batería
        if (!hasBatteryExemption()) {
            try {
                @SuppressLint("BatteryLife")
                Intent i = new Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getPackageName()));
                startActivity(i);
            } catch (Exception ignored) {
            }
        }
        // Avanzar a la última página tras pedir permisos
        showPage(TOTAL_PAGES - 1);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                            int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Refresh la página de permisos para mostrar los checks actualizados
        if (currentPage == 2) {
            showPage(2);
        }
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics());
    }
}
