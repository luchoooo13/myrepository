package com.alertaemergencia.client;


import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;


/**
 * Activity de alerta a pantalla completa — UI rediseñada estilo Material
 * Design moderno. Pulso de fondo, tarjeta de vidrio, chip de categoría,
 * recomendaciones numeradas y botón FAB animado.
 *
 * En landscape: pantalla dividida — izquierda con la alerta principal,
 * derecha con las recomendaciones. Todo entra sin scroll en la mayoría
 * de dispositivos.
 *
 * Brillo: fuerza máximo al entrar, restaura al salir.
 * Sonido / flash / vibración: manejados por AlertService.
 */
public class AlertActivity extends Activity {

    public static final String EXTRA_TYPE            = "alert_type";
    public static final String EXTRA_LABEL           = "alert_label";
    public static final String EXTRA_RECOMMENDATIONS = "alert_recommendations";
    public static final String EXTRA_ENDS_AT         = "alert_ends_at";
    public static final String EXTRA_DURATION_MS     = "alert_duration_ms";
    public static final String ACTION_CLOSE =
            "com.alertaemergencia.client.ALERT_CLOSE";

    // ── Paleta ────────────────────────────────────────────────────────
    private static final int C_EMERGENCY      = 0xffff0000;
    private static final int C_EMERGENCY_DARK = 0xff360101;
    private static final int C_SIMULACRO      = 0xFF1D4ED8;
    private static final int C_SIMULACRO_DARK = 0xFF1E3A8A;
    private static final int C_CARD           = 0xF2111111;
    private static final int C_TEXT_PRIMARY   = 0xFFFFFFFF;
    private static final int C_TEXT_SECONDARY = 0xCCFFFFFF;
    private static final int C_ACCENT_WARM    = 0xFFFCD34D; // amarillo
    private static final int C_ACCENT_COOL    = 0xFF93C5FD; // azul cielo

    // Divider semitransparente entre los dos paneles en landscape
    private static final int C_DIVIDER        = 0x20FFFFFF;

    private ValueAnimator bgAnim;
    private ValueAnimator ringAnim;
    private View root;
    private View pulseRing;
    private BroadcastReceiver closeReceiver;
    private float originalBrightness = -1.0f;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private GestureDetector gestureDetector;

    // ── Countdown circular ────────────────────────────────────────────
    private CountdownRingView countdownRing;
    private Runnable countdownTick;
    private long alertEndsAt     = 0;
    private long alertDurationMs = 60000L;

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Permitimos que el sensor de orientación actúe libremente:
        // si el usuario rota a landscape, mostramos el split-screen;
        // si está en portrait, mostramos el layout vertical original.
        // En tablets grandes forzamos landscape directamente.
        int screenLayout = getResources().getConfiguration().screenLayout
                & Configuration.SCREENLAYOUT_SIZE_MASK;
        if (screenLayout >= Configuration.SCREENLAYOUT_SIZE_LARGE) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        } else {
            // Desbloquear rotación para que el split-screen funcione cuando
            // el usuario o el sistema rota el dispositivo.
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
        }

        setupShowOverLockscreen();
        setupImmersive();
        buildUi();
        registerCloseReceiver();
        forceBrightnessMax();
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (gestureDetector != null) {
            gestureDetector.onTouchEvent(ev);
        }
        return super.dispatchTouchEvent(ev);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        buildUi();
    }

    /**
     * onConfigurationChanged se llama cuando cambia la orientación.
     * Reconstruimos la UI completa para cambiar entre layout vertical
     * (portrait) y split-screen horizontal (landscape).
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        buildUi();
    }

    @Override
    protected void onDestroy() {
        if (bgAnim  != null) bgAnim.cancel();
        if (ringAnim != null) ringAnim.cancel();
        stopCountdown();
        handler.removeCallbacksAndMessages(null);
        if (closeReceiver != null) {
            try { unregisterReceiver(closeReceiver); } catch (Exception ignored) {}
            closeReceiver = null;
        }
        restoreOriginalBrightness();
        super.onDestroy();
    }

    @Override public void onBackPressed() { /* bloqueado */ }

    // ------------------------------------------------------------------
    // Brillo
    // ------------------------------------------------------------------

    private void forceBrightnessMax() {
        Window w = getWindow();
        if (w == null) return;
        WindowManager.LayoutParams lp = w.getAttributes();
        originalBrightness = lp.screenBrightness;
        lp.screenBrightness = 1.0f;
        w.setAttributes(lp);
    }

    private void restoreOriginalBrightness() {
        Window w = getWindow();
        if (w == null) return;
        WindowManager.LayoutParams lp = w.getAttributes();
        lp.screenBrightness = originalBrightness;
        w.setAttributes(lp);
    }

    // ------------------------------------------------------------------
    // Ventana
    // ------------------------------------------------------------------

    private void setupShowOverLockscreen() {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
    }

    private void setupImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    // ------------------------------------------------------------------
    // UI — punto de entrada que elige el layout según orientación
    // ------------------------------------------------------------------

    private void buildUi() {
        alertEndsAt = getIntent().getLongExtra(
                EXTRA_ENDS_AT,
                System.currentTimeMillis() + 60000L
        );

        alertDurationMs = getIntent().getLongExtra(
                EXTRA_DURATION_MS,
                60000L
        );
        String type  = getIntent().getStringExtra(EXTRA_TYPE);
        String label = getIntent().getStringExtra(EXTRA_LABEL);
        String[] recs = getIntent().getStringArrayExtra(EXTRA_RECOMMENDATIONS);
        if (label == null || label.isEmpty())
            label = (type == null || type.isEmpty()) ? "ALERTA" : type;

        final boolean isSimulacro = "simulacro".equalsIgnoreCase(type);
        final int cMain   = isSimulacro ? C_SIMULACRO      : C_EMERGENCY;
        final int cDark   = isSimulacro ? C_SIMULACRO_DARK : C_EMERGENCY_DARK;
        final int cAccent = isSimulacro ? C_ACCENT_COOL    : C_ACCENT_WARM;

        boolean isLandscape = getResources().getConfiguration().orientation
                == Configuration.ORIENTATION_LANDSCAPE;

        if (isLandscape && recs != null && recs.length > 0) {
            buildLandscapeUi(label, isSimulacro, cMain, cDark, cAccent, recs);
        } else {
            buildPortraitUi(label, isSimulacro, cMain, cDark, cAccent, recs);
        }
    }

    // ------------------------------------------------------------------
    // Layout PORTRAIT — igual que antes (vertical, scrolleable)
    // ------------------------------------------------------------------

    private void buildPortraitUi(String label, boolean isSimulacro,
                                 int cMain, int cDark, int cAccent, String[] recs) {
        // Cancela animaciones previas si buildUi se llama más de una vez
        if (bgAnim  != null) { bgAnim.cancel();  bgAnim  = null; }
        if (ringAnim != null) { ringAnim.cancel(); ringAnim = null; }

        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(cDark);
        this.root = layout;

        // Anillo de pulso
        View ring = new View(this);
        GradientDrawable ringBg = new GradientDrawable();
        ringBg.setShape(GradientDrawable.OVAL);
        ringBg.setColor(Color.argb(55,
                Color.red(cMain), Color.green(cMain), Color.blue(cMain)));
        ring.setBackground(ringBg);
        int ringSize = dp(360);
        FrameLayout.LayoutParams ringLp =
                new FrameLayout.LayoutParams(ringSize, ringSize);
        ringLp.gravity = Gravity.CENTER;
        ring.setLayoutParams(ringLp);
        layout.addView(ring);
        this.pulseRing = ring;

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(dp(18), dp(68), dp(18), dp(80));

        column.addView(mainCard(label, isSimulacro, cMain, cAccent));

        if (recs != null && recs.length > 0)
            column.addView(recsCard(recs, cAccent));

        scroll.addView(column);
        layout.addView(scroll);
        layout.addView(closeButton());

        setContentView(layout);
        startAnimations(cMain, cDark);
        enterAnimation(column);
    }

    // ------------------------------------------------------------------
    // Layout LANDSCAPE — split-screen 50/50
    //   Izquierda: alerta principal (chip + título + calma)
    //   Derecha:   recomendaciones "Qué hacer ahora"
    //   Divisor:   línea semitransparente vertical
    // ------------------------------------------------------------------

    private void buildLandscapeUi(String label, boolean isSimulacro,
                                  int cMain, int cDark, int cAccent, String[] recs) {
        if (bgAnim  != null) { bgAnim.cancel();  bgAnim  = null; }
        if (ringAnim != null) { ringAnim.cancel(); ringAnim = null; }

        // Contenedor raíz
        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(cDark);
        this.root = layout;

        // Anillo de pulso difuso centrado en toda la pantalla
        View ring = new View(this);
        GradientDrawable ringBg = new GradientDrawable();
        ringBg.setShape(GradientDrawable.OVAL);
        ringBg.setColor(Color.argb(45,
                Color.red(cMain), Color.green(cMain), Color.blue(cMain)));
        ring.setBackground(ringBg);
        int ringSize = dp(420);
        FrameLayout.LayoutParams ringLp =
                new FrameLayout.LayoutParams(ringSize, ringSize);
        ringLp.gravity = Gravity.CENTER;
        ring.setLayoutParams(ringLp);
        layout.addView(ring);
        this.pulseRing = ring;

        // Fila horizontal que ocupa toda la pantalla
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        // ── Panel IZQUIERDO — alerta principal ──────────────────────
        LinearLayout leftPanel = new LinearLayout(this);
        leftPanel.setOrientation(LinearLayout.VERTICAL);
        leftPanel.setGravity(Gravity.CENTER);
        leftPanel.setPadding(dp(20), dp(20), dp(16), dp(20));
        LinearLayout.LayoutParams leftLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
        leftPanel.setLayoutParams(leftLp);

        leftPanel.addView(mainCardLandscape(label, isSimulacro, cMain, cAccent));
        row.addView(leftPanel);

        // ── Divisor vertical ────────────────────────────────────────
        View divider = new View(this);
        divider.setBackgroundColor(C_DIVIDER);
        LinearLayout.LayoutParams divLp = new LinearLayout.LayoutParams(dp(1),
                ViewGroup.LayoutParams.MATCH_PARENT);
        divLp.topMargin   = dp(16);
        divLp.bottomMargin = dp(16);
        divider.setLayoutParams(divLp);
        row.addView(divider);

        // ── Panel DERECHO — recomendaciones ─────────────────────────
        ScrollView rightScroll = new ScrollView(this);
        rightScroll.setFillViewport(true);
        rightScroll.setVerticalScrollBarEnabled(true);
        LinearLayout.LayoutParams rightLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
        rightScroll.setLayoutParams(rightLp);

        LinearLayout rightPanel = new LinearLayout(this);
        rightPanel.setOrientation(LinearLayout.VERTICAL);
        rightPanel.setPadding(dp(16), dp(20), dp(20), dp(20));
        rightPanel.addView(recsCardLandscape(recs, cAccent));

        rightScroll.addView(rightPanel);
        row.addView(rightScroll);

        layout.addView(row);
        layout.addView(closeButton());

        setContentView(layout);
        startAnimations(cMain, cDark);

        // Animamos cada panel por separado para que entren desde lados distintos
        enterAnimationFromLeft(leftPanel);
        enterAnimationFromRight(rightPanel);
    }

    // ------------------------------------------------------------------
    // Tarjeta principal — versión portrait (original)
    // ------------------------------------------------------------------

    private LinearLayout mainCard(String label, boolean isSimulacro,
                                  int cMain, int cAccent) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(26), dp(30), dp(26), dp(34));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_CARD);
        bg.setCornerRadius(dp(28));
        bg.setStroke(dp(1), 0x25FFFFFF);
        card.setBackground(bg);
        card.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        card.addView(chip(isSimulacro, cMain, cAccent));
        card.addView(colorBar(cMain));
        card.addView(alertTitleView(label, TypedValue.COMPLEX_UNIT_SP, 40));
        card.addView(buildCountdownBlock(cMain, dp(185)));
        card.addView(separator());
        card.addView(calmHint());

        return card;
    }

    // ------------------------------------------------------------------
    // Tarjeta principal — versión landscape (más compacta, sin card wrapper)
    // Ocupa todo el panel izquierdo centrada verticalmente.
    // ------------------------------------------------------------------

    private LinearLayout mainCardLandscape(String label, boolean isSimulacro,
                                           int cMain, int cAccent) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(22), dp(22), dp(22), dp(26));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_CARD);
        bg.setCornerRadius(dp(24));
        bg.setStroke(dp(1), 0x25FFFFFF);
        card.setBackground(bg);
        card.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        card.addView(chip(isSimulacro, cMain, cAccent));
        card.addView(colorBar(cMain));

        // Título más pequeño en landscape para que entre en el panel
        card.addView(alertTitleView(label, TypedValue.COMPLEX_UNIT_SP, 30));
        card.addView(buildCountdownBlock(cMain, dp(135)));
        card.addView(separator());
        card.addView(calmHint());

        return card;
    }

    // ── Helpers compartidos para mainCard y mainCardLandscape ─────────

    private TextView alertTitleView(String label, int unit, float sp) {
        TextView tv = new TextView(this);
        tv.setText(label.toUpperCase());
        tv.setTextColor(C_TEXT_PRIMARY);
        tv.setTextSize(unit, sp);
        tv.setTypeface(null, Typeface.BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setLetterSpacing(0.02f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(14);
        tv.setLayoutParams(lp);
        return tv;
    }

    private View separator() {
        View sep = new View(this);
        sep.setBackgroundColor(0x18FFFFFF);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1));
        lp.bottomMargin = dp(12);
        sep.setLayoutParams(lp);
        return sep;
    }

    private TextView calmHint() {
        TextView hint = new TextView(this);
        hint.setText("Mantené la calma  ·  Seguí las instrucciones");
        hint.setTextColor(C_TEXT_SECONDARY);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hint.setGravity(Gravity.CENTER);
        return hint;
    }

    private TextView chip(boolean isSimulacro, int cMain, int cAccent) {
        TextView chip = new TextView(this);
        chip.setText(isSimulacro ? "⬤  SIMULACRO" : "▲  EMERGENCIA");
        chip.setTextColor(cAccent);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        chip.setTypeface(null, Typeface.BOLD);
        chip.setLetterSpacing(0.14f);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(14), dp(7), dp(14), dp(7));

        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(18));
        d.setColor(Color.argb(45,
                Color.red(cMain), Color.green(cMain), Color.blue(cMain)));
        d.setStroke(dp(1), Color.argb(110,
                Color.red(cAccent), Color.green(cAccent), Color.blue(cAccent)));
        chip.setBackground(d);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.bottomMargin = dp(14);
        chip.setLayoutParams(lp);
        return chip;
    }

    private View colorBar(int cMain) {
        View bar = new View(this);
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{Color.argb(0, Color.red(cMain), Color.green(cMain), Color.blue(cMain)),
                        cMain,
                        Color.argb(0, Color.red(cMain), Color.green(cMain), Color.blue(cMain))});
        d.setCornerRadius(dp(2));
        bar.setBackground(d);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(120), dp(3));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.bottomMargin = dp(14);
        bar.setLayoutParams(lp);
        return bar;
    }

    // ------------------------------------------------------------------
    // Tarjeta de recomendaciones — versión portrait (con card wrapper)
    // ------------------------------------------------------------------

    private LinearLayout recsCard(String[] lines, int cAccent) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(20), dp(20), dp(20), dp(22));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_CARD);
        bg.setCornerRadius(dp(24));
        bg.setStroke(dp(1), 0x25FFFFFF);
        card.setBackground(bg);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        card.setLayoutParams(lp);

        card.addView(recsHeader(cAccent));
        card.addView(recsSeparator());
        addRecRows(card, lines, cAccent);

        return card;
    }

    // ------------------------------------------------------------------
    // Tarjeta de recomendaciones — versión landscape
    // Sin card wrapper: el panel derecho ya tiene fondo del layout raíz.
    // Se muestra más compacta con texto un poco más grande para aprovechar
    // el espacio disponible.
    // ------------------------------------------------------------------

    private LinearLayout recsCardLandscape(String[] lines, int cAccent) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(12), dp(12), dp(12), dp(16));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_CARD);
        bg.setCornerRadius(dp(20));
        bg.setStroke(dp(1), 0x20FFFFFF);
        card.setBackground(bg);
        card.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        card.addView(recsHeader(cAccent));
        card.addView(recsSeparator());
        addRecRowsLandscape(card, lines, cAccent);

        return card;
    }

    // ── Helpers compartidos de recomendaciones ────────────────────────

    private LinearLayout recsHeader(int cAccent) {
        LinearLayout hdr = new LinearLayout(this);
        hdr.setOrientation(LinearLayout.HORIZONTAL);
        hdr.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.bottomMargin = dp(12);
        hdr.setLayoutParams(hlp);

        TextView ico = new TextView(this);
        ico.setText("✓");
        ico.setTextColor(cAccent);
        ico.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        ico.setTypeface(null, Typeface.BOLD);
        ico.setGravity(Gravity.CENTER);
        GradientDrawable icoBg = new GradientDrawable();
        icoBg.setShape(GradientDrawable.OVAL);
        icoBg.setColor(Color.argb(40,
                Color.red(cAccent), Color.green(cAccent), Color.blue(cAccent)));
        ico.setBackground(icoBg);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(dp(24), dp(24));
        ilp.rightMargin = dp(10);
        ico.setLayoutParams(ilp);
        hdr.addView(ico);

        TextView title = new TextView(this);
        title.setText("QUÉ HACER AHORA");
        title.setTextColor(cAccent);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        title.setTypeface(null, Typeface.BOLD);
        title.setLetterSpacing(0.14f);
        hdr.addView(title);

        return hdr;
    }

    private View recsSeparator() {
        View sep = new View(this);
        sep.setBackgroundColor(0x15FFFFFF);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1));
        lp.bottomMargin = dp(12);
        sep.setLayoutParams(lp);
        return sep;
    }

    /** Filas para portrait: texto 14sp */
    private void addRecRows(LinearLayout container, String[] lines, int cAccent) {
        int n = 1;
        for (String line : lines) {
            if (line == null || line.trim().isEmpty()) continue;
            container.addView(recRow(n++, line.trim(), cAccent, 14));
        }
    }

    /** Filas para landscape: texto 15sp (un poco más grande, aprovecha el espacio) */
    private void addRecRowsLandscape(LinearLayout container, String[] lines, int cAccent) {
        int n = 1;
        for (String line : lines) {
            if (line == null || line.trim().isEmpty()) continue;
            container.addView(recRow(n++, line.trim(), cAccent, 15));
        }
    }

    private LinearLayout recRow(int num, String text, int cAccent, float textSp) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.TOP);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = rlp.bottomMargin = dp(5);
        row.setLayoutParams(rlp);

        // Círculo numerado
        TextView badge = new TextView(this);
        badge.setText(String.valueOf(num));
        badge.setTextColor(cAccent);
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        badge.setTypeface(null, Typeface.BOLD);
        badge.setGravity(Gravity.CENTER);
        GradientDrawable bd = new GradientDrawable();
        bd.setShape(GradientDrawable.OVAL);
        bd.setColor(Color.argb(38,
                Color.red(cAccent), Color.green(cAccent), Color.blue(cAccent)));
        bd.setStroke(dp(1), Color.argb(80,
                Color.red(cAccent), Color.green(cAccent), Color.blue(cAccent)));
        badge.setBackground(bd);
        LinearLayout.LayoutParams blp =
                new LinearLayout.LayoutParams(dp(22), dp(22));
        blp.rightMargin = dp(12);
        blp.topMargin   = dp(2);
        badge.setLayoutParams(blp);
        row.addView(badge);

        // Texto de la recomendación
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(0xEEFFFFFF);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, textSp);
        tv.setLineSpacing(dp(2), 1f);
        tv.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(tv);

        return row;
    }

    // ── Botón cerrar ──────────────────────────────────────────────────

    private Button closeButton() {
        Button btn = new Button(this);
        btn.setText("✕");
        btn.setTextColor(C_TEXT_PRIMARY);
        btn.setAllCaps(false);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        btn.setTypeface(null, Typeface.BOLD);
        btn.setPadding(0, 0, 0, 0);

        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0xCC181818);
        bg.setStroke(dp(1), 0x45FFFFFF);
        btn.setBackground(bg);

        FrameLayout.LayoutParams lp =
                new FrameLayout.LayoutParams(dp(50), dp(50));
        lp.gravity     = Gravity.TOP | Gravity.END;
        lp.topMargin   = dp(22);
        lp.rightMargin = dp(22);
        btn.setLayoutParams(lp);

        btn.setAlpha(0f);
        btn.setScaleX(0.4f);
        btn.setScaleY(0.4f);
        handler.postDelayed(() -> btn.animate()
                .alpha(1f).scaleX(1f).scaleY(1f)
                .setDuration(400)
                .setInterpolator(new OvershootInterpolator(1.8f))
                .start(), 1400);

        btn.setOnClickListener(v -> {
            v.animate().alpha(0f).scaleX(0.7f).scaleY(0.7f)
                    .setDuration(140)
                    .withEndAction(this::dismissLocally)
                    .start();
        });
        return btn;
    }

    // ------------------------------------------------------------------
    // Animaciones
    // ------------------------------------------------------------------

    private void startAnimations(int cMain, int cDark) {
        if (bgAnim != null) bgAnim.cancel();
        bgAnim = ValueAnimator.ofObject(new ArgbEvaluator(), cDark, cMain, cDark);
        bgAnim.setDuration(2000);
        bgAnim.setRepeatMode(ValueAnimator.RESTART);
        bgAnim.setRepeatCount(ValueAnimator.INFINITE);
        bgAnim.setInterpolator(new AccelerateDecelerateInterpolator());
        bgAnim.addUpdateListener(a -> {
            if (root != null) root.setBackgroundColor((int) a.getAnimatedValue());
        });
        bgAnim.start();

        if (ringAnim != null) ringAnim.cancel();
        ringAnim = ValueAnimator.ofFloat(0.5f, 1.5f);
        ringAnim.setDuration(1300);
        ringAnim.setRepeatMode(ValueAnimator.RESTART);
        ringAnim.setRepeatCount(ValueAnimator.INFINITE);
        ringAnim.setInterpolator(new DecelerateInterpolator(1.8f));
        ringAnim.addUpdateListener(a -> {
            if (pulseRing == null) return;
            float s = (float) a.getAnimatedValue();
            float alpha = 1f - ((s - 0.5f) / 1f);
            pulseRing.setScaleX(s);
            pulseRing.setScaleY(s);
            pulseRing.setAlpha(alpha * 0.55f);
        });
        ringAnim.start();
    }

    /** Entrada portrait: sube desde abajo */
    private void enterAnimation(View column) {
        column.setAlpha(0f);
        column.setTranslationY(dp(48));
        column.animate()
                .alpha(1f).translationY(0)
                .setDuration(550)
                .setInterpolator(new DecelerateInterpolator(2.2f))
                .start();
    }

    /** Panel izquierdo landscape: entra desde la izquierda */
    private void enterAnimationFromLeft(View panel) {
        panel.setAlpha(0f);
        panel.setTranslationX(-dp(60));
        panel.animate()
                .alpha(1f).translationX(0)
                .setDuration(500)
                .setInterpolator(new DecelerateInterpolator(2.0f))
                .start();
    }

    /** Panel derecho landscape: entra desde la derecha */
    private void enterAnimationFromRight(View panel) {
        panel.setAlpha(0f);
        panel.setTranslationX(dp(60));
        panel.animate()
                .alpha(1f).translationX(0)
                .setDuration(500)
                .setStartDelay(80)
                .setInterpolator(new DecelerateInterpolator(2.0f))
                .start();
    }

    // ------------------------------------------------------------------
    // Receptor de cierre remoto
    // ------------------------------------------------------------------

    private void registerCloseReceiver() {
        closeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) { finish(); }
        };
        IntentFilter f = new IntentFilter(ACTION_CLOSE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(closeReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(closeReceiver, f);
        }
    }

    // ------------------------------------------------------------------
    // Dismiss
    // ------------------------------------------------------------------


    // ═══════════════════════════════════════════════════════════════════
    // COUNTDOWN CIRCULAR — estilo SASSLA
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Layout del countdown:
     *
     *   LinearLayout vertical (centrado horizontalmente)
     *   ├── CountdownRingView  ← anillo cuadrado ringPx × ringPx
     *   │       el número y "SEGUNDOS" se dibujan DENTRO del Canvas
     *   │       del propio View, no son TextViews flotantes.
     *   └── (nada más — todo está dentro del View)
     *
     * De esta forma es imposible que el texto se desborde fuera del círculo:
     * el View mide exactamente ringPx y dibuja todo en su propio Canvas.
     */
    private View buildCountdownBlock(int cMain, int ringPx) {
        countdownRing = new CountdownRingView(this, cMain, ringPx);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ringPx, ringPx);
        lp.gravity      = Gravity.CENTER_HORIZONTAL;
        lp.topMargin    = dp(18);
        lp.bottomMargin = dp(14);
        countdownRing.setLayoutParams(lp);

        countdownRing.playFillEffect(this::startCountdown);
        return countdownRing;
    }

    private void startCountdown() {
        stopCountdown();
        countdownTick = new Runnable() {
            @Override public void run() {
                long remaining = alertEndsAt - System.currentTimeMillis();
                if (remaining < 0) remaining = 0;

                // Número: salto discreto al inicio de cada segundo
                int secs = (int)(remaining / 1000);
                if (countdownRing != null) countdownRing.setSeconds(secs);

                if (remaining == 0) {
                    if (countdownRing != null) countdownRing.jumpToFraction(0f);
                    return;
                }

                // Fracción al inicio de este segundo y al inicio del siguiente.
                // El arco se anima suavemente de fracNow → fracNext en 1 s exacto.
                float fracNow  = alertDurationMs > 0
                        ? Math.max(0f, remaining        / (float) alertDurationMs) : 0f;
                float fracNext = alertDurationMs > 0
                        ? Math.max(0f, (remaining - 1000L) / (float) alertDurationMs) : 0f;

                if (countdownRing != null) countdownRing.animateTo(fracNow, fracNext);

                handler.postDelayed(this, 1000);
            }
        };
        handler.post(countdownTick);
    }

    private void stopCountdown() {
        if (countdownTick != null) { handler.removeCallbacks(countdownTick); countdownTick = null; }
        if (countdownRing != null) countdownRing.cancelAnim();
    }

    /**
     * View que dibuja TODO el bloque del countdown en su propio Canvas:
     *   - Fondo negro circular
     *   - Track gris (círculo completo)
     *   - Arco de color (retrocede cada segundo)
     *   - Número grande centrado
     *   - "SEGUNDOS" debajo del número
     *
     * Al tener todo en un solo View no hay posibilidad de que ningún
     * elemento se desborde o se superponga fuera del círculo.
     */
    private static class CountdownRingView extends android.view.View {
        private final Paint bgPaint    = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint arcPaint   = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint numPaint   = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint lblPaint   = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF oval       = new RectF();

        private float  displayFraction = 1f;
        private int    seconds         = 0;
        private String secondsStr      = "--";
        private ValueAnimator arcAnim;

        CountdownRingView(android.content.Context ctx, int color, int ringPx) {
            super(ctx);

            // Fondo negro
            bgPaint.setColor(0xFF000000);
            bgPaint.setStyle(Paint.Style.FILL);

            // Track y arco: exactamente el mismo stroke
            float stroke = ringPx * 0.07f;

            trackPaint.setStyle(Paint.Style.STROKE);
            trackPaint.setStrokeWidth(stroke);
            trackPaint.setColor(0x55888888);
            trackPaint.setStrokeCap(Paint.Cap.ROUND);

            arcPaint.setStyle(Paint.Style.STROKE);
            arcPaint.setStrokeWidth(stroke);   // idéntico al track
            arcPaint.setColor(color);
            arcPaint.setStrokeCap(Paint.Cap.ROUND);

            // Número grande: ~38% del diámetro
            numPaint.setColor(0xFFFFFFFF);
            numPaint.setTextSize(ringPx * 0.38f);
            numPaint.setTypeface(android.graphics.Typeface.create(
                    android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD));
            numPaint.setTextAlign(Paint.Align.CENTER);
            numPaint.setAntiAlias(true);

            // "SEGUNDOS": ~10% del diámetro
            lblPaint.setColor(0xAAA0A0A0);
            lblPaint.setTextSize(ringPx * 0.085f);
            lblPaint.setTypeface(android.graphics.Typeface.create(
                    android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD));
            lblPaint.setTextAlign(Paint.Align.CENTER);
            lblPaint.setLetterSpacing(0.02f);
            lblPaint.setAntiAlias(true);
        }

        void setSeconds(int s) {
            seconds    = s;
            secondsStr = String.valueOf(s);
            invalidate();
        }

        /** Salta la fracción sin animación (inicio o fin). */
        void jumpToFraction(float f) {
            if (arcAnim != null) { arcAnim.cancel(); arcAnim = null; }
            displayFraction = Math.max(0f, Math.min(1f, f));
            invalidate();
        }

        /**
         * Animación de entrada: el rojo llena el círculo en sentido RELOJ
         * (0→360°) en 700ms, rápido y fluido. Al terminar queda en fraction=1
         * listo para que el countdown lo achique antireloj.
         * Durante esta animación usamos fillMode=true para dibujar el arco
         * en sentido reloj en vez de antireloj.
         */
        boolean fillMode = false;

        void playFillEffect(Runnable onDone) {
            if (arcAnim != null) arcAnim.cancel();
            fillMode = true;
            displayFraction = 0f;
            arcAnim = ValueAnimator.ofFloat(0f, 1f);
            arcAnim.setDuration(700);
            arcAnim.setInterpolator(new DecelerateInterpolator(2f));
            arcAnim.addUpdateListener(a -> {
                displayFraction = (float) a.getAnimatedValue();
                invalidate();
            });
            arcAnim.addListener(new android.animation.AnimatorListenerAdapter() {
                @Override public void onAnimationEnd(android.animation.Animator a) {
                    fillMode = false;
                    displayFraction = 1f;
                    if (onDone != null) onDone.run();
                }
            });
            arcAnim.start();
        }

        /**
         * Anima el arco de fromFraction a toFraction en 1000 ms.
         * DecelerateInterpolator: arranca rápido y frena suavemente
         * al llegar al siguiente segundo — idéntico al comportamiento
         * de SASSLA y análogos.
         */
        void animateTo(float fromFraction, float toFraction) {
            if (arcAnim != null) arcAnim.cancel();
            arcAnim = ValueAnimator.ofFloat(fromFraction, toFraction);
            arcAnim.setDuration(1000);
            arcAnim.setInterpolator(new DecelerateInterpolator(1.5f));
            arcAnim.addUpdateListener(a -> {
                displayFraction = (float) a.getAnimatedValue();
                invalidate();
            });
            arcAnim.start();
        }

        void cancelAnim() {
            if (arcAnim != null) { arcAnim.cancel(); arcAnim = null; }
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float cx = getWidth()  / 2f;
            float cy = getHeight() / 2f;
            float radius = Math.min(cx, cy);

            // 1. Fondo negro circular
            canvas.drawCircle(cx, cy, radius, bgPaint);

            // 2. Radio del anillo: descontamos la mitad del stroke para que
            //    no se recorte en los bordes del View.
            float strokeHalf = arcPaint.getStrokeWidth() / 2f;
            float r = radius - strokeHalf - 1f;
            oval.set(cx - r, cy - r, cx + r, cy + r);

            // ── Lógica de los arcos ───────────────────────────────────
            //
            // El rojo ocupa de 12 (-90°) en sentido antireloj (sweep negativo).
            // Su punta delantera está fija en -90° (12).
            // Su punta trasera retrocede: está en -90° - sweep.
            //
            // El gris es la "cola": ocupa el espacio que el rojo ya dejó libre.
            // Empieza con un gap después de la punta trasera del rojo y se
            // extiende un tramo corto (20°) en sentido reloj (positivo),
            // siguiendo al rojo como una sombra.
            //
            // Ejemplo con sweep=200° (rojo cubre 200° antireloj desde -90°):
            //   Punta trasera rojo = -90° - 200° = -290° (= 70° en reloj)
            //   Gap = 6°
            //   Gris arranca en -290° + 6° = -284°, cubre +20° en reloj.
            //
            // Animación inicial (fillAnim): displayFraction va 0→1 en sentido
            // reloj en 700ms. Durante ese tiempo el rojo "llena" el círculo.
            // Después el countdown lo va achicando antireloj segundo a segundo.

            float sweep    = displayFraction * 360f;  // magnitud del arco rojo
            float gap      = 6f;                       // espacio entre rojo y gris
            float tailLen  = 20f;                      // largo de la cola gris

            // Punta trasera del rojo (en coordenadas de drawArc)
            // El rojo va antireloj desde -90°, entonces su cola está en -90°-sweep
            float redTail = -90f - sweep;

            // Cola gris: empieza gap° después de la cola roja (en sentido reloj)
            // y se extiende tailLen° también en sentido reloj
            float greyStart = redTail + gap;
            float greySweep = tailLen;

            // Dibujar gris primero (debajo), luego rojo encima
            if (!fillMode && sweep < 360f - gap - tailLen)
                canvas.drawArc(oval, greyStart, greySweep, false, trackPaint);

            // Rojo: antireloj normal, o reloj durante la animación inicial
            if (sweep > 0.5f) {
                float s = fillMode ? sweep : -sweep;
                canvas.drawArc(oval, -90f, s, false, arcPaint);
            }

            // Textos: bloque número + "SEGUNDOS" centrado verticalmente
            android.graphics.Paint.FontMetrics fm = numPaint.getFontMetrics();
            android.graphics.Paint.FontMetrics lm = lblPaint.getFontMetrics();
            float numH   = -fm.ascent + fm.descent;
            float lblH   = -lm.ascent + lm.descent;
            float gap2   = radius * 0.04f;
            float blockH = numH + gap2 + lblH;
            float numY   = cy - blockH / 2f + numH - fm.descent;
            float lblY   = numY + fm.descent + gap2 + lblH - lm.descent;
            canvas.drawText(secondsStr,  cx, numY, numPaint);
            canvas.drawText("SEGUNDOS", cx, lblY, lblPaint);
        }
    }

    private void dismissLocally() {
        Intent i = new Intent(this, AlertService.class);
        i.setAction(AlertService.ACTION_DISMISS_ALERT);
        try { startService(i); } catch (Exception ignored) {}
        finish();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}