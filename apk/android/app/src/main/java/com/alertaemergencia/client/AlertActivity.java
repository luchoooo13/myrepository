package com.alertaemergencia.client;

import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.LinearInterpolator;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Activity de alerta a pantalla completa. Se dispara desde {@link AlertService}
 * vía fullScreenIntent o startActivity. Muestra:
 *  - fondo parpadeando rojo / blanco;
 *  - etiqueta "ALERTA";
 *  - tipo de alerta en letra enorme;
 *  - botón X para cerrar solo en este dispositivo.
 *
 * La sirena, el flash de cámara y la vibración los maneja el servicio.
 */
public class AlertActivity extends Activity {

    public static final String EXTRA_TYPE = "alert_type";
    public static final String EXTRA_LABEL = "alert_label";
    public static final String EXTRA_RECOMMENDATIONS = "alert_recommendations";
    public static final String ACTION_CLOSE =
            "com.alertaemergencia.client.ALERT_CLOSE";

    private ValueAnimator bgAnim;
    private View root;
    private BroadcastReceiver closeReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setupShowOverLockscreen();
        setupImmersive();
        buildUi();
        registerCloseReceiver();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Refresca etiquetas si llega otra alerta mientras seguimos abiertos.
        buildUi();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (bgAnim != null) bgAnim.cancel();
        if (closeReceiver != null) {
            try {
                unregisterReceiver(closeReceiver);
            } catch (Exception ignored) {
            }
            closeReceiver = null;
        }
    }

    @Override
    public void onBackPressed() {
        // No cerramos con Back: el usuario tiene que usar la X explícita.
    }

    // ------------------------------------------------------------------
    private void setupShowOverLockscreen() {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        w.addFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                        | WindowManager.LayoutParams.FLAG_FULLSCREEN);
    }

    private void setupImmersive() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private void buildUi() {
        String type = getIntent().getStringExtra(EXTRA_TYPE);
        String label = getIntent().getStringExtra(EXTRA_LABEL);
        String[] recommendations = getIntent().getStringArrayExtra(EXTRA_RECOMMENDATIONS);
        if (label == null || label.isEmpty()) {
            label = (type == null || type.isEmpty()) ? "ALERTA" : type;
        }
        final boolean isSimulacro = "simulacro".equalsIgnoreCase(type);

        FrameLayout layout = new FrameLayout(this);
        layout.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        layout.setBackgroundColor(isSimulacro ? 0xFF1D4ED8 : 0xFFDC2626);
        this.root = layout;

        // Contenedor vertical centrado: tarjeta + recomendaciones abajo.
        // Lo envolvemos en un ScrollView por si las recs son muchas o la
        // pantalla es chica (celu en landscape, tablet con tamaño medio).
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        FrameLayout.LayoutParams scrollLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT);
        scroll.setLayoutParams(scrollLp);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(dp(22), dp(60), dp(22), dp(60));

        // Tarjeta central con el contenido legible sobre el flash.
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        card.setPadding(dp(28), dp(28), dp(28), dp(32));
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(0xE0000000);
        cardBg.setCornerRadius(dp(22));
        cardBg.setStroke(dp(2), 0x44FFFFFF);
        card.setBackground(cardBg);

        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        cardLp.gravity = Gravity.CENTER_HORIZONTAL;
        card.setLayoutParams(cardLp);

        TextView tag = new TextView(this);
        tag.setText("ALERTA");
        tag.setTextColor(isSimulacro ? 0xFFBFDBFE : 0xFFFECACA);
        tag.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        tag.setLetterSpacing(0.45f);
        tag.setTypeface(tag.getTypeface(), android.graphics.Typeface.BOLD);
        tag.setGravity(Gravity.CENTER);
        card.addView(tag);

        TextView typeView = new TextView(this);
        typeView.setText(label.toUpperCase());
        typeView.setTextColor(0xFFFFFFFF);
        typeView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 56);
        typeView.setTypeface(typeView.getTypeface(), android.graphics.Typeface.BOLD);
        typeView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = dp(10);
        tlp.bottomMargin = dp(6);
        typeView.setLayoutParams(tlp);
        card.addView(typeView);

        TextView hint = new TextView(this);
        hint.setText("Mantené la calma y seguí las instrucciones");
        hint.setTextColor(0xCCFFFFFF);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.topMargin = dp(8);
        hint.setLayoutParams(hlp);
        card.addView(hint);

        column.addView(card);

        // Tarjeta de recomendaciones (debajo de la principal). Sólo
        // aparece si el server mandó algo; si no, queda oculta.
        if (recommendations != null && recommendations.length > 0) {
            column.addView(buildRecommendationsCard(recommendations));
        }

        scroll.addView(column);
        layout.addView(scroll);

        // Botón X arriba a la derecha.
        Button close = new Button(this);
        close.setText("×");
        close.setTextColor(0xFFFFFFFF);
        close.setAllCaps(false);
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        close.setPadding(0, 0, 0, dp(4));
        GradientDrawable closeBg = new GradientDrawable();
        closeBg.setShape(GradientDrawable.OVAL);
        closeBg.setColor(0x99000000);
        closeBg.setStroke(dp(2), 0xFFFFFFFF);
        close.setBackground(closeBg);
        FrameLayout.LayoutParams clp =
                new FrameLayout.LayoutParams(dp(54), dp(54));
        clp.gravity = Gravity.TOP | Gravity.END;
        clp.topMargin = dp(18);
        clp.rightMargin = dp(18);
        close.setLayoutParams(clp);
        close.setOnClickListener(v -> dismissLocally());
        layout.addView(close);

        setContentView(layout);

        // Animación rojo/blanco (o azul/blanco en simulacro).
        startFlashAnimation(isSimulacro);
    }

    /**
     * Tarjeta con la lista de recomendaciones del tipo de alerta.
     * Mismo estilo que la tarjeta principal (fondo negro translúcido,
     * borde blanco) pero con texto más chico y lista con bullets.
     */
    private LinearLayout buildRecommendationsCard(String[] lines) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(20), dp(18), dp(20), dp(20));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xCC000000);
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(2), 0x44FFFFFF);
        card.setBackground(bg);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(18);
        card.setLayoutParams(lp);

        TextView title = new TextView(this);
        title.setText("QUÉ HACER");
        title.setTextColor(0xFFFDE68A);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        title.setLetterSpacing(0.18f);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.bottomMargin = dp(10);
        title.setLayoutParams(tlp);
        card.addView(title);

        for (String line : lines) {
            if (line == null || line.trim().isEmpty()) continue;
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            rlp.topMargin = dp(4);
            rlp.bottomMargin = dp(4);
            row.setLayoutParams(rlp);

            TextView bullet = new TextView(this);
            bullet.setText("•");
            bullet.setTextColor(0xFFFDE68A);
            bullet.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            bullet.setTypeface(bullet.getTypeface(), android.graphics.Typeface.BOLD);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    dp(18),
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            bullet.setLayoutParams(blp);
            row.addView(bullet);

            TextView txt = new TextView(this);
            txt.setText(line.trim());
            txt.setTextColor(0xFFF9FAFB);
            txt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            txt.setLineSpacing(dp(2), 1f);
            LinearLayout.LayoutParams xlp = new LinearLayout.LayoutParams(
                    0,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    1f);
            txt.setLayoutParams(xlp);
            row.addView(txt);

            card.addView(row);
        }
        return card;
    }

    private void startFlashAnimation(boolean isSimulacro) {
        if (bgAnim != null) bgAnim.cancel();
        int red = isSimulacro ? 0xFF1D4ED8 : 0xFFDC2626;
        int white = 0xFFFFFFFF;
        bgAnim = ValueAnimator.ofObject(new ArgbEvaluator(), red, white, red);
        bgAnim.setDuration(500);
        bgAnim.setRepeatMode(ValueAnimator.RESTART);
        bgAnim.setRepeatCount(ValueAnimator.INFINITE);
        bgAnim.setInterpolator(new LinearInterpolator());
        bgAnim.addUpdateListener(a -> {
            int c = (int) a.getAnimatedValue();
            if (root != null) root.setBackgroundColor(c);
        });
        bgAnim.start();
    }

    private void registerCloseReceiver() {
        closeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                finish();
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_CLOSE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(closeReceiver, filter);
        }
    }

    private void dismissLocally() {
        Intent i = new Intent(this, AlertService.class);
        i.setAction(AlertService.ACTION_DISMISS_ALERT);
        try {
            startService(i);
        } catch (Exception ignored) {
        }
        finish();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
