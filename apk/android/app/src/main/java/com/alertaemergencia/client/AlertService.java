// Archivo: AlertService.java
package com.alertaemergencia.client;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;

import org.json.JSONObject;

import java.net.URI;

public class AlertService extends Service {

    private static final String TAG = "AlertService";

    public static final String ACTION_START = "com.alertaemergencia.client.START";
    public static final String ACTION_STOP = "com.alertaemergencia.client.STOP";
    public static final String ACTION_DISMISS_ALERT = "com.alertaemergencia.client.DISMISS";
    public static final String ACTION_TEST_ALERT = "com.alertaemergencia.client.TEST_ALERT";
    public static final String ACTION_REFRESH_PAUSE = "com.alertaemergencia.client.REFRESH_PAUSE";
    public static final String ACTION_REFRESH_CLIENT_ID = "com.alertaemergencia.client.REFRESH_CLIENT_ID";

    public static final String EXTRA_SERVER_URL = "server_url";

    public static final String CHANNEL_ONGOING = "alertas_ongoing";
    public static final String CHANNEL_ALERT = "alertas_alert";
    private static final String CHANNEL_NETWORK = "alertas_network";

    public static final String PREFS = "alerta_config";
    public static final String KEY_SERVER_URL = "server_url";
    public static final String KEY_SET_VIBRATION = "set_vibration";
    public static final String KEY_SET_STROBE = "set_strobe";
    public static final String KEY_SET_VOICE = "set_voice";
    public static final String KEY_SET_VOLUME = "set_volume";
    public static final String KEY_SET_SIREN_VOLUME = "set_siren_volume";
    public static final String KEY_SET_VOICE_VOLUME = "set_voice_volume";
    public static final String KEY_SET_SIREN_TONE = "set_siren_tone";
    public static final String KEY_PAUSED_UNTIL = "paused_until";
    public static final String KEY_DISMISSED_STARTED_AT = "dismissed_started_at";
    public static final String KEY_SILENT_ENABLED = "silent_enabled";
    public static final String KEY_SILENT_FROM = "silent_from";
    public static final String KEY_SILENT_TO = "silent_to";
    public static final String KEY_SILENT_DAYS = "silent_days";
    public static final String KEY_DEVICE_NAME = "device_name";
    public static final String KEY_CLIENT_ID = "client_id";
    public static final String KEY_BAD_CONNECTION_NOTIFS = "bad_connection_notifs";

    private static final int NOTIF_ONGOING = 101;
    private static final int NOTIF_ALERT = 102;
    private static final int NOTIF_NETWORK = 103;

    private static final long BAD_CONNECTION_RTT_MS = 3500;
    private boolean badConnectionShown = false;
    private long lastBadConnectionNotifAt = 0;

    private Socket socket;
    private String serverOrigin;
    private MediaPlayer sirenPlayer;
    private MediaPlayer voicePlayer;
    private FlashController flash;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Handler vibHandler = new Handler(Looper.getMainLooper());
    private final Handler voiceHandler = new Handler(Looper.getMainLooper());

    private volatile boolean alertActive = false;
    // Timestamps de la alerta activa — usados para el countdown en la UI.
    private long currentAlertEndsAt    = 0;
    private long currentAlertDurationMs = 60000L;
    private long currentHistoryId = 0;

    // ── TTS nativo del dispositivo ────────────────────────────────────────
    // Usamos el motor de síntesis instalado en el dispositivo (Google TTS,
    // Samsung TTS, etc.) con locale es-419 (español latinoamericano) para
    // evitar la pronunciación castellana (c→z). Si el motor no soporta
    // es-419, probamos es-MX, es-US y finalmente es genérico.
    // El TTS se inicializa al conectar (prewarm) para que al llegar la alerta
    // esté listo y no haya delay de inicialización.
    private TextToSpeech tts = null;
    private volatile boolean ttsReady = false;
    private String pendingTtsText = null;   // texto a decir si TTS todavía no estaba listo
    private String currentVoiceUrl;
    private MediaPlayer prewarmPlayer = null;
    private volatile boolean prewarmReady = false;
    private String currentAlertType;
    private long currentAlertStartedAt = 0;
    private Runnable pendingTestStop;
    private volatile long dismissedStartedAt = 0;
    private String lastReportedState = "idle";
    private long serverTimeOffsetMs = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            dismissedStartedAt = sp.getLong(KEY_DISMISSED_STARTED_AT, 0);
        } catch (Exception ignored) {
        }
        flash = new FlashController(getApplicationContext());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            vibrator = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AlertaCliente:AlertService");
            wakeLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_DISMISS_ALERT.equals(action)) {
            if (currentAlertStartedAt > 0) {
                dismissedStartedAt = currentAlertStartedAt;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putLong(KEY_DISMISSED_STARTED_AT, dismissedStartedAt).apply();
            }
            stopAlertMedia("dismiss-from-user");
            return START_STICKY;
        }
        if (ACTION_REFRESH_PAUSE.equals(action) || ACTION_REFRESH_CLIENT_ID.equals(action)) {
            startForeground(NOTIF_ONGOING, buildOngoingNotification(decorateWithPause(describeConnectionState())));
            if (ACTION_REFRESH_CLIENT_ID.equals(action)) identifyToServer();
            return START_STICKY;
        }
        if (ACTION_TEST_ALERT.equals(action)) {
            startForeground(NOTIF_ONGOING, buildOngoingNotification("Prueba de alerta (5 seg)"));
            main.post(() -> {
                if (!alertActive) {
                    startAlertMedia("simulacro", "Prueba (5 seg)", null, false, 0, null);
                    pendingTestStop = () -> {
                        pendingTestStop = null;
                        if (alertActive && currentAlertStartedAt == 0) stopAlertMedia("test-timeout");
                    };
                    main.postDelayed(pendingTestStop, 5000);
                }
            });
            return START_STICKY;
        }

        String url = intent != null ? intent.getStringExtra(EXTRA_SERVER_URL) : null;
        if (url == null || url.isEmpty()) url = getSavedServerUrl();
        if (url != null && !url.isEmpty()) {
            serverOrigin = extractOrigin(url);
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SERVER_URL, url).apply();
        }

        startForeground(NOTIF_ONGOING, buildOngoingNotification("Conectando…"));
        connectSocket();
        scheduleRestart(60000);
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        scheduleRestart(1500);
    }

    private void scheduleRestart(long firstDelayMs) {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            long[] delays = {firstDelayMs, 10000L, 30000L, 60000L, 120000L};
            int reqCode = 1000;
            for (long delay : delays) {
                Intent restart = new Intent(getApplicationContext(), RestartReceiver.class);
                restart.setAction(RestartReceiver.ACTION_RESTART);
                PendingIntent pi = PendingIntent.getBroadcast(getApplicationContext(), reqCode++, restart,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                long when = System.currentTimeMillis() + delay;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
                } else {
                    am.set(AlarmManager.RTC_WAKEUP, when, pi);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "scheduleRestart falló", e);
        }
    }

    private String getSavedServerUrl() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SERVER_URL, "");
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopAlertMedia("service-destroy");
        disconnectSocket();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (tts != null) { try { tts.stop(); tts.shutdown(); } catch (Exception ignored) {} tts = null; ttsReady = false; }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void connectSocket() {
        disconnectSocket();
        if (serverOrigin == null) return;
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.reconnectionDelay = 200; // Más agresivo
            opts.reconnectionDelayMax = 1000;
            opts.timeout = 5000;
            // Forzamos WebSocket para evitar el delay del polling de Socket.io
            opts.transports = new String[]{"websocket"};
            socket = IO.socket(URI.create(serverOrigin), opts);

            socket.on(Socket.EVENT_CONNECT, args -> {
                main.post(() -> {
                    updateOngoing("Conectado · esperando alertas");
                    prewarmSiren();
                    // Pre-calentamos el TTS para que al llegar la primera alerta
                    // ya esté inicializado y no haya delay de 300-800ms de init.
                    if (tts == null) {
                        tts = new TextToSpeech(AlertService.this, status -> {
                            if (status == TextToSpeech.SUCCESS) {
                                configureTtsLocale();
                                ttsReady = true;
                                Log.d(TAG, "TTS pre-calentado y listo");
                            }
                        });
                    }
                });
                identifyToServer();
                syncServerTime();
                lastReportedState = "idle";
                if (alertActive) reportClientState("alerting");
                cancelBadConnectionNotification(); // Restablece notificacion al conectar
            });

            socket.on(Socket.EVENT_DISCONNECT, args -> main.post(() -> {
                updateOngoing("Reconectando…");
                // Esperamos 4.5 segundos antes de mostrar la notificación de
                // mala conexión, para no molestar si la reconexión es rápida.
                main.postDelayed(() -> {
                    if (socket == null || !socket.connected()) {
                        handleBadConnectionState(BAD_CONNECTION_RTT_MS);
                    }
                }, 4500);
            }));

            socket.on(Socket.EVENT_CONNECT_ERROR, args -> main.post(() -> {
                updateOngoing("Sin conexión");
                main.postDelayed(() -> {
                    if (socket == null || !socket.connected()) {
                        handleBadConnectionState(BAD_CONNECTION_RTT_MS);
                    }
                }, 4500);
            }));

            socket.on("alert:start", onAlertStart);
            socket.on("alert:update", args -> {
                // Actualización silenciosa de datos secundarios (recs, voiceText)
                if (args.length > 0 && args[0] instanceof JSONObject) {
                    JSONObject alert = (JSONObject) args[0];
                    // Si ya estamos alertando y es la misma alerta, actualizamos datos
                    if (alertActive && alert.optLong("historyId") == currentHistoryId) {
                        // Podríamos actualizar recs aquí si fuera necesario
                    }
                }
            });
            socket.on("alert:stop", args -> main.post(() -> stopAlertMedia("server-stop")));

            scheduleNetPingLoop();

            socket.on("client:pong", args -> {
                if (args.length == 0 || !(args[0] instanceof JSONObject)) return;
                try {
                    JSONObject p = (JSONObject) args[0];
                    long t0 = p.optLong("t0", 0);
                    long t1 = p.optLong("t1", 0);
                    if (t0 <= 0) return;
                    long now = System.currentTimeMillis();
                    long rtt = now - t0;
                    if (rtt < 0 || rtt > 60000) return;

                    // Si el servidor mandó su tiempo t1, podemos ajustar el offset
                    if (t1 > 0 && rtt < 1000) {
                        long latency = rtt / 2;
                        serverTimeOffsetMs = t1 - (t0 + latency);
                    }

                    JSONObject out = new JSONObject();
                    out.put("rttMs", rtt);
                    socket.emit("client:netinfo", out);
                    main.post(() -> handleBadConnectionState(rtt));
                } catch (Exception ignored) {}
            });

            socket.connect();
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "URL inválida: " + serverOrigin, e);
        }
    }

    private void disconnectSocket() {
        cancelNetPingLoop();
        cancelTimeSyncLoop();
        if (socket != null) {
            try { socket.off(); socket.disconnect(); } catch (Exception ignored) {}
            socket = null;
        }
    }

    private final Runnable timeSyncTick = new Runnable() {
        @Override public void run() { syncServerTime(); }
    };
    private void scheduleTimeSyncLoop(long delayMs) {
        main.removeCallbacks(timeSyncTick);
        main.postDelayed(timeSyncTick, delayMs);
    }
    private void cancelTimeSyncLoop() { main.removeCallbacks(timeSyncTick); }

    private void syncServerTime() {
        if (serverOrigin == null) return;
        new Thread(() -> {
            boolean success = false;
            try {
                long t0 = System.currentTimeMillis();
                java.net.URL url = new java.net.URL(serverOrigin + "/time");
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                if (conn.getResponseCode() == 200) {
                    java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(conn.getInputStream()));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = in.readLine()) != null) sb.append(line);
                    in.close();
                    JSONObject res = new JSONObject(sb.toString());
                    long serverNow = res.getLong("now");
                    long t1 = System.currentTimeMillis();
                    long latency = (t1 - t0) / 2;
                    serverTimeOffsetMs = serverNow - (t0 + latency);
                    Log.d(TAG, "[time-sync] offset=" + serverTimeOffsetMs + "ms");
                    success = true;
                }
            } catch (Exception e) { Log.w(TAG, "[time-sync] fallo: " + e.getMessage()); }

            // Si falló, reintentar pronto (15s). Si tuvo éxito, esperar 5 min.
            scheduleTimeSyncLoop(success ? 5 * 60 * 1000 : 15 * 1000);
        }).start();
    }

    private static final long NET_PING_INTERVAL_MS = 15_000L;
    private final Runnable netPingTick = new Runnable() {
        @Override
        public void run() {
            try {
                if (socket != null && socket.connected()) {
                    JSONObject payload = new JSONObject();
                    payload.put("t0", System.currentTimeMillis());
                    socket.emit("client:ping", payload);
                }
            } catch (Exception ignored) {}
            main.postDelayed(this, NET_PING_INTERVAL_MS);
        }
    };

    private void scheduleNetPingLoop() {
        main.removeCallbacks(netPingTick);
        main.post(netPingTick);
    }

    private void cancelNetPingLoop() {
        main.removeCallbacks(netPingTick);
    }

    private void handleBadConnectionState(long rtt) {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean enabled = sp.getBoolean(KEY_BAD_CONNECTION_NOTIFS, true);

        if (!enabled) {
            cancelBadConnectionNotification();
            return;
        }

        boolean bad = rtt >= BAD_CONNECTION_RTT_MS || (socket != null && !socket.connected());
        if (bad) {
            long now = System.currentTimeMillis();
            if (!badConnectionShown || (now - lastBadConnectionNotifAt) > 120000L) {
                showBadConnectionNotification(rtt);
                badConnectionShown = true;
                lastBadConnectionNotifAt = now;
            }
        } else {
            badConnectionShown = false;
            cancelBadConnectionNotification();
        }
    }

    private void cancelBadConnectionNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIF_NETWORK);
    }

    private void showBadConnectionNotification(long rtt) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_NETWORK)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("Conexión inestable")
                .setContentText("La conexión con el servidor es débil.")
                .setStyle(new NotificationCompat.BigTextStyle()
                        .bigText("La conexión con el servidor es inestable. Podrían demorarse las alertas.\n\nLatencia actual: " + (rtt >= BAD_CONNECTION_RTT_MS ? "> 3500" : rtt) + " ms"))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true);

        nm.notify(NOTIF_NETWORK, b.build());
    }

    private final Emitter.Listener onAlertStart = args -> {
        if (args.length == 0 || !(args[0] instanceof JSONObject)) return;
        JSONObject alert = (JSONObject) args[0];
        String type = alert.optString("type", "alerta");
        String label = alert.optString("label", type);
        final long startedAt = alert.optLong("startedAt", 0);
        final String[] recommendations = extractStringArray(alert, "recommendations");
        // voiceText: texto personalizado que tiene que leer el TTS.
        // Si viene vacío o null, buildVoiceText() usa el default hardcodeado.
        final String voiceText = alert.optString("voiceText", "");
        // Duración elegida por el host (en ms). Si no viene, default 60s.
        final long durationMs = alert.optLong("durationMs", 60000L);
        final long endsAt     = alert.optLong("endsAt", 0L);

        if (startedAt > 0 && startedAt == dismissedStartedAt) return;

        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (sp.getLong(KEY_PAUSED_UNTIL, 0) > (System.currentTimeMillis() + serverTimeOffsetMs)) return;
        } catch (Exception ignored) {}

        if (isInSilentWindowNow()) return;

        String sirenUrlRaw = alert.isNull("sirenUrl") ? "" : alert.optString("sirenUrl", "");
        boolean skipVoice = alert.optBoolean("skipVoice", false);
        final String sirenUrl = (sirenUrlRaw == null || sirenUrlRaw.isEmpty() || "null".equals(sirenUrlRaw))
                ? null : absolutizeUrl(sirenUrlRaw);

        final long historyId = alert.optLong("historyId", 0);
        main.post(() -> startAlertMedia(type, label, sirenUrl, skipVoice, startedAt, durationMs, endsAt, recommendations, voiceText, historyId));
    };

    private String[] extractStringArray(JSONObject obj, String key) {
        try {
            if (!obj.has(key) || obj.isNull(key)) return new String[0];
            org.json.JSONArray arr = obj.optJSONArray(key);
            if (arr == null) return new String[0];
            int n = Math.min(arr.length(), 20);
            java.util.ArrayList<String> out = new java.util.ArrayList<>(n);
            for (int i = 0; i < n; i++) {
                String s = arr.optString(i, "");
                if (s != null && !s.trim().isEmpty()) out.add(s.trim().substring(0, Math.min(s.trim().length(), 400)));
            }
            return out.toArray(new String[0]);
        } catch (Exception e) { return new String[0]; }
    }

    private boolean isInSilentWindowNow() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (!sp.getBoolean(KEY_SILENT_ENABLED, false)) return false;
            int fromMin = parseHHMM(sp.getString(KEY_SILENT_FROM, ""));
            int toMin = parseHHMM(sp.getString(KEY_SILENT_TO, ""));
            String daysCsv = sp.getString(KEY_SILENT_DAYS, "");
            if (fromMin < 0 || toMin < 0 || fromMin == toMin || daysCsv == null || daysCsv.isEmpty()) return false;

            java.util.Calendar c = java.util.Calendar.getInstance();
            int dow = c.get(java.util.Calendar.DAY_OF_WEEK) - 1;
            int nowMin = c.get(java.util.Calendar.HOUR_OF_DAY) * 60 + c.get(java.util.Calendar.MINUTE);

            int dayToCheck;
            if (fromMin < toMin) {
                if (!(nowMin >= fromMin && nowMin < toMin)) return false;
                dayToCheck = dow;
            } else if (nowMin >= fromMin) dayToCheck = dow;
            else if (nowMin < toMin) dayToCheck = (dow + 6) % 7;
            else return false;

            for (String tok : daysCsv.split(",")) {
                try { if (Integer.parseInt(tok.trim()) == dayToCheck) return true; } catch (NumberFormatException ignored) {}
            }
            return false;
        } catch (Exception e) { return false; }
    }

    private int parseHHMM(String s) {
        if (s == null) return -1;
        int idx = s.indexOf(':');
        if (idx <= 0 || idx >= s.length() - 1) return -1;
        try {
            int h = Integer.parseInt(s.substring(0, idx)), m = Integer.parseInt(s.substring(idx + 1));
            return (h >= 0 && h <= 23 && m >= 0 && m <= 59) ? h * 60 + m : -1;
        } catch (NumberFormatException e) { return -1; }
    }

    private float sirenVolumeMultiplier(String type) {
        if ("intruso".equalsIgnoreCase(type)) return 0f;
        if ("simulacro".equalsIgnoreCase(type)) return 1.0f;
        return 0.4f;
    }

    private float voiceVolumeMultiplier(String type) {
        return "intruso".equalsIgnoreCase(type) ? 0.45f : 1.0f;
    }

    private float clampVol(float v) { return Math.max(0f, Math.min(1f, v)); }

    private void reportClientState(String state) {
        if (state == null) state = "idle";
        if (state.equals(lastReportedState)) return;
        lastReportedState = state;
        try {
            if (socket != null && socket.connected()) socket.emit("client:state", new JSONObject().put("state", state));
        } catch (Exception ignored) {}
    }

    private String absolutizeUrl(String s) {
        if (s == null || s.isEmpty()) return null;
        if (s.startsWith("http://") || s.startsWith("https://")) return s;
        if (serverOrigin == null) return null;
        return s.startsWith("/") ? serverOrigin + s : serverOrigin + "/" + s;
    }

    private void startAlertMedia(String type, String label, String sirenUrl, boolean skipVoice, long startedAt, String[] recommendations) {
        startAlertMedia(type, label, sirenUrl, skipVoice, startedAt, recommendations, "");
    }

    private void startAlertMedia(String type, String label, String sirenUrl, boolean skipVoice, long startedAt, String[] recommendations, String voiceText) {
        startAlertMedia(type, label, sirenUrl, skipVoice, startedAt, 60000L, 0L, recommendations, voiceText);
    }
    private void startAlertMedia(String type, String label, String sirenUrl, boolean skipVoice, long startedAt, long durationMs, long endsAt, String[] recommendations, String voiceText) {
        startAlertMedia(type, label, sirenUrl, skipVoice, startedAt, durationMs, endsAt, recommendations, voiceText, 0);
    }

    private void startAlertMedia(String type, String label, String sirenUrl, boolean skipVoice, long startedAt, long durationMs, long endsAt, String[] recommendations, String voiceText, long historyId) {
        if (pendingTestStop != null) { main.removeCallbacks(pendingTestStop); pendingTestStop = null; }
        if (alertActive) {
            if (startedAt > 0 && startedAt == currentAlertStartedAt) return;
            stopAlertMedia("replaced-by-new-alert");
        }
        alertActive = true; currentAlertStartedAt = startedAt; currentAlertType = type; currentHistoryId = historyId;
        currentAlertDurationMs = durationMs > 0 ? durationMs : 60000L;
        currentAlertEndsAt = endsAt > 0 ? endsAt : (System.currentTimeMillis() + serverTimeOffsetMs + currentAlertDurationMs);
        acquireWakeLock();

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        startSiren(sirenUrl);
        if (!skipVoice && sp.getBoolean(KEY_SET_VOICE, true)) {
            startVoiceLoop(type, label, voiceText);
        }
        if (sp.getBoolean(KEY_SET_VIBRATION, true)) startVibrationLoop();
        if (sp.getBoolean(KEY_SET_STROBE, true) && flash != null) flash.startBlinking();

        showAlertNotification(type, label, recommendations);
        launchAlertActivity(type, label, recommendations);
        reportClientState("alerting");
    }

    private void stopAlertMedia(String reason) {
        alertActive = false; currentAlertStartedAt = 0; currentAlertType = null; currentAlertEndsAt = 0; currentAlertDurationMs = 60000L;
        stopSiren(); stopVoiceLoop(); stopVibrationLoop();
        if (flash != null) flash.stopBlinking();
        dismissAlertNotification();

        Intent close = new Intent(AlertActivity.ACTION_CLOSE);
        close.setPackage(getPackageName());
        sendBroadcast(close);
        releaseWakeLock();
        reportClientState("idle");
    }

    private void prewarmSiren() {
        try {
            if (prewarmReady || prewarmPlayer != null) return;
            prewarmPlayer = new MediaPlayer();
            String assetName = "eas".equals(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SET_SIREN_TONE, "default")) ? "eas.mp3" : "siren.mp3";
            AssetFileDescriptor afd = getAssets().openFd(assetName);
            prewarmPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            prewarmPlayer.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            prewarmPlayer.setLooping(true);
            prewarmPlayer.setOnPreparedListener(mp -> prewarmReady = true);
            prewarmPlayer.prepareAsync();
        } catch (Exception e) {
            if (prewarmPlayer != null) { try { prewarmPlayer.release(); } catch (Exception ignored) {} }
            prewarmPlayer = null; prewarmReady = false;
        }
    }

    private void startSiren(String customUrl) {
        stopSiren();
        try {
            sirenPlayer = new MediaPlayer();
            boolean usedRemote = false;
            if (customUrl != null && !customUrl.isEmpty()) {
                try { sirenPlayer.setDataSource(customUrl); usedRemote = true; }
                catch (Exception ex) { try { sirenPlayer.reset(); } catch (Exception ignored) {} }
            }
            if (!usedRemote) {
                String assetName = (!"simulacro".equalsIgnoreCase(currentAlertType) && "eas".equals(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SET_SIREN_TONE, "default"))) ? "eas.mp3" : "siren.mp3";
                AssetFileDescriptor afd = getAssets().openFd(assetName);
                sirenPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
                afd.close();
            }
            sirenPlayer.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            sirenPlayer.setLooping(true);

            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            SharedPreferences volSp = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (am != null) {
                int pctG = Math.max(volSp.getInt(KEY_SET_SIREN_VOLUME, volSp.getInt(KEY_SET_VOLUME, 100)), volSp.getInt(KEY_SET_VOICE_VOLUME, volSp.getInt(KEY_SET_VOLUME, 100)));
                int target = Math.round((Math.max(0, Math.min(100, pctG)) / 100f) * am.getStreamMaxVolume(AudioManager.STREAM_ALARM));
                am.setStreamVolume(AudioManager.STREAM_ALARM, target < 1 && pctG > 0 ? 1 : target, 0);
            }

            float mul = clampVol(sirenVolumeMultiplier(currentAlertType) * (Math.max(0, Math.min(100, volSp.getInt(KEY_SET_SIREN_VOLUME, volSp.getInt(KEY_SET_VOLUME, 100)))) / 100f));
            sirenPlayer.setVolume(mul, mul);

            if (usedRemote) {
                sirenPlayer.setOnPreparedListener(mp -> { if (alertActive) mp.start(); });
                sirenPlayer.setOnErrorListener((mp, what, extra) -> { main.post(() -> { if (alertActive) startSiren(null); }); return true; });
                sirenPlayer.prepareAsync();
            } else {
                sirenPlayer.prepare(); sirenPlayer.start();
            }
        } catch (Exception e) { stopSiren(); }
    }

    private void stopSiren() {
        if (sirenPlayer != null) {
            try { if (sirenPlayer.isPlaying()) sirenPlayer.stop(); sirenPlayer.release(); } catch (Exception ignored) {}
            sirenPlayer = null;
        }
    }

    private void startVoiceLoop(String type, String label) {
        startVoiceLoop(type, label, "");
    }

    private void startVoiceLoop(String type, String label, String serverVoiceText) {
        stopVoiceLoop();
        // Si el servidor manda un texto de voz personalizado, lo usamos directamente.
        // Si no, construimos el texto default según el tipo de alerta.
        String text = (serverVoiceText != null && !serverVoiceText.trim().isEmpty())
                ? serverVoiceText.trim()
                : buildVoiceText(type, label);
        initTtsIfNeeded(text);
    }

    // Frases de voz naturales para cada tipo de alerta.
    private String buildVoiceText(String type, String label) {
        if (type == null) return "Atención. Alerta de emergencia.";
        switch (type.toLowerCase()) {
            case "incendio":   return "Atención. Alerta de incendio. Por favor evacúen el edificio de inmediato.";
            case "sismo":      return "Atención. Alerta de sismo. Aléjense de ventanas y objetos que puedan caer.";
            case "evacuacion": return "Atención. Alerta de evacuación. Diríganse a las salidas de emergencia.";
            case "intruso":    return "Atención. Intruso detectado. Permanezcan en sus aulas y aseguren las puertas.";
            case "medica":     return "Atención. Emergencia médica. Soliciten asistencia de inmediato.";
            case "gas":        return "Atención. Fuga de gas detectada. Evacúen el edificio sin encender luces ni llamas.";
            case "bomba":      return "Atención. Amenaza de bomba. Evacúen el edificio de inmediato.";
            case "tormenta":   return "Atención. Tormenta severa. Permanezcan en interiores alejados de ventanas.";
            case "simulacro":  return "Atención. Simulacro de evacuación. Procedan a las salidas de emergencia.";
            case "custom":     return label != null && !label.isEmpty() ? label : "Atención. Alerta de emergencia.";
            default:           return "Atención. " + (label != null && !label.isEmpty() ? label : "Alerta de emergencia.") + ".";
        }
    }

    // Inicializa el TTS si no está listo y encola el texto para decirlo.
    private void initTtsIfNeeded(String text) {
        pendingTtsText = text;
        if (ttsReady && tts != null) {
            speakTts(text);
            return;
        }
        // Si ya hay una inicialización en curso (tts != null pero ttsReady == false),
        // solo actualizamos pendingTtsText y esperamos el callback.
        if (tts != null) return;
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                configureTtsLocale();
                ttsReady = true;
                if (pendingTtsText != null && alertActive) {
                    speakTts(pendingTtsText);
                }
            } else {
                Log.w(TAG, "TTS init falló, status=" + status);
                ttsReady = false;
            }
        });
    }

    // Configura el locale del TTS priorizando español latinoamericano.
    private void configureTtsLocale() {
        if (tts == null) return;
        // Intentamos en orden: es-419 (latinoamericano), es-MX, es-US, es-AR, es genérico.
        java.util.Locale[] candidates = {
                new java.util.Locale("es", "419"),
                new java.util.Locale("es", "MX"),
                new java.util.Locale("es", "US"),
                new java.util.Locale("es", "AR"),
                new java.util.Locale("es"),
        };
        for (java.util.Locale loc : candidates) {
            int result = tts.isLanguageAvailable(loc);
            if (result == TextToSpeech.LANG_AVAILABLE
                    || result == TextToSpeech.LANG_COUNTRY_AVAILABLE
                    || result == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE) {
                tts.setLanguage(loc);
                Log.d(TAG, "TTS locale: " + loc);
                break;
            }
        }
        // Velocidad y tono: ligeramente más lento y tono natural para mayor claridad.
        tts.setSpeechRate(0.92f);
        tts.setPitch(1.0f);
    }

    // Habla el texto y programa otra repetición al terminar (cada 6s).
    private void speakTts(final String text) {
        if (tts == null || !ttsReady || !alertActive) return;

        // 1. Leer el porcentaje guardado por el slider web (0 a 100)
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        int volPct = sp.getInt(KEY_SET_VOICE_VOLUME, 100);
        float volumeFloat = Math.max(0f, Math.min(100f, volPct)) / 100f; // Convierte de 0-100 a 0.0-1.0

        // 2. Configurar los parámetros del motor TTS
        android.os.Bundle params = new android.os.Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volumeFloat);

        // 3. Forzar al TTS a usar el canal de ALARMA en vez del multimedia
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_ALARM);

        // 4. Ejecutar la voz aplicando los parámetros
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "alert-voice");

        // Repetimos el mensaje cada 6 segundos mientras la alerta esté activa.
        voiceHandler.removeCallbacksAndMessages(null);
        voiceHandler.postDelayed(() -> {
            if (alertActive && pendingTtsText != null) speakTts(pendingTtsText);
        }, 6000);
    }

    private void playVoiceOnce() {
        // Método heredado — ya no se usa directamente (reemplazado por TTS nativo).
        // Se deja por compatibilidad con código que pueda llamarlo.
        if (pendingTtsText != null) speakTts(pendingTtsText);
    }

    private void stopVoicePlayer() {
        if (voicePlayer != null) {
            try { if (voicePlayer.isPlaying()) voicePlayer.stop(); voicePlayer.reset(); voicePlayer.release(); } catch (Exception ignored) {}
            voicePlayer = null;
        }
    }

    private void stopVoiceLoop() {
        voiceHandler.removeCallbacksAndMessages(null);
        stopVoicePlayer();
        currentVoiceUrl = null;
        pendingTtsText = null;
        // Detenemos el TTS si está hablando, pero NO lo destruimos
        // (lo reutilizamos en la próxima alerta para evitar el delay de reinit).
        if (tts != null && ttsReady) {
            try { tts.stop(); } catch (Exception ignored) {}
        }
    }

    private void startVibrationLoop() {
        if (vibrator == null || !vibrator.hasVibrator()) return;
        vibHandler.removeCallbacksAndMessages(null);
        vibHandler.post(new Runnable() {
            @Override public void run() {
                if (!alertActive) return;
                try {
                    long[] pattern = {0, 600, 300};
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1));
                    else vibrator.vibrate(pattern, -1);
                } catch (Exception ignored) {}
                vibHandler.postDelayed(this, 900);
            }
        });
    }

    private void stopVibrationLoop() {
        vibHandler.removeCallbacksAndMessages(null);
        if (vibrator != null) { try { vibrator.cancel(); } catch (Exception ignored) {} }
    }

    private void acquireWakeLock() { if (wakeLock != null && !wakeLock.isHeld()) { try { wakeLock.acquire(2 * 60 * 1000L); } catch (Exception ignored) {} } }
    private void releaseWakeLock() { if (wakeLock != null && wakeLock.isHeld()) { try { wakeLock.release(); } catch (Exception ignored) {} } }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel ongoing = new NotificationChannel(CHANNEL_ONGOING, "📲 Notificación de estado (apagala si querés)", NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription("Notificación fija que tiene como objetivo mostrar el estado de la conexión con SchoolAlerts.");
        ongoing.setShowBadge(false); ongoing.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ongoing);

        NotificationChannel alert = new NotificationChannel(CHANNEL_ALERT, "⚠️ Alertas importantes", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("Señal recibida del administrador para hacer sonar la alarma. Esta notificación es la encargada de mostrar la alerta en el dispositivo.");
        alert.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC); alert.enableLights(true); alert.setLightColor(0xFFDC2626); alert.setBypassDnd(true); alert.setSound(null, null);
        nm.createNotificationChannel(alert);

        NotificationChannel network = new NotificationChannel(CHANNEL_NETWORK, "🛜 Alertas de conexión", NotificationManager.IMPORTANCE_DEFAULT);
        network.setDescription("Notificaciones que te avisan cuando tu conexión a internet es inestable o estas desconectado del servicio de alertas."); network.enableVibration(false);
        nm.createNotificationChannel(network);
    }

    private Notification buildOngoingNotification(String text) {
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ONGOING)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("SchoolAlerts")
                .setContentText(text)
                .setOngoing(true).setShowWhen(false)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private void updateOngoing(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ONGOING, buildOngoingNotification(decorateWithPause(text)));
    }

    private String decorateWithPause(String baseText) {
        try {
            long pausedUntil = getSharedPreferences(PREFS, MODE_PRIVATE).getLong(KEY_PAUSED_UNTIL, 0);
            long now = System.currentTimeMillis();
            if (pausedUntil > now) {
                if (pausedUntil >= Long.MAX_VALUE / 2) return "⏸ Pausado (indefinido) · " + baseText;
                long mins = Math.max(1, (pausedUntil - now) / 60000);
                return mins >= 60 ? "⏸ Pausado ~" + (mins / 60) + "h · " + baseText : "⏸ Pausado |" + mins + "min · " + baseText;
            }
        } catch (Exception ignored) {}
        return baseText;
    }

    private String describeConnectionState() { return (socket != null && socket.connected()) ? "Conectado · esperando alertas" : "Esperando conexión…"; }

    private void showAlertNotification(String type, String label, String[] recommendations) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Intent open = new Intent(this, AlertActivity.class);
        open.putExtra(AlertActivity.EXTRA_TYPE, type);
        open.putExtra(AlertActivity.EXTRA_LABEL, label);
        open.putExtra(AlertActivity.EXTRA_ENDS_AT, currentAlertEndsAt);
        open.putExtra(AlertActivity.EXTRA_DURATION_MS, currentAlertDurationMs);
        open.putExtra("server_time_offset", serverTimeOffsetMs);
        if (recommendations != null && recommendations.length > 0) open.putExtra(AlertActivity.EXTRA_RECOMMENDATIONS, recommendations);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent dismiss = new Intent(this, AlertService.class); dismiss.setAction(ACTION_DISMISS_ALERT);
        PendingIntent dismissPI = PendingIntent.getService(this, 2, dismiss, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // Countdown en la notificación: muestra cuánto falta para que
        // termine la alerta usando el Chronometer nativo de Android.
        // setWhen() + setUsesChronometer(true) + setChronometerCountDown(true)
        // dibuja un reloj regresivo en la barra de estado sin ningún trabajo extra.
        long endsAtForNotif = currentAlertEndsAt > 0
                ? (currentAlertEndsAt - serverTimeOffsetMs)
                : (System.currentTimeMillis() + currentAlertDurationMs);

        NotificationCompat.Builder nb = new NotificationCompat.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("⚠ ALERTA · " + label.toUpperCase())
                .setContentText("Tocá para ver la alerta en pantalla completa")
                .setOngoing(true).setAutoCancel(false)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setColor(0xFFDC2626)
                .setWhen(endsAtForNotif)
                .setUsesChronometer(true)
                .setContentIntent(content).setFullScreenIntent(content, true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cerrar en este equipo", dismissPI);

        // setChronometerCountDown solo existe en API 24+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            nb.setChronometerCountDown(true);
        }
        nm.notify(NOTIF_ALERT, nb.build());
    }

    private void dismissAlertNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIF_ALERT);
    }

    private void launchAlertActivity(String type, String label, String[] recommendations) {
        Intent i = new Intent(this, AlertActivity.class);
        i.putExtra(AlertActivity.EXTRA_TYPE, type);
        i.putExtra(AlertActivity.EXTRA_LABEL, label);
        i.putExtra(AlertActivity.EXTRA_ENDS_AT, currentAlertEndsAt);
        i.putExtra(AlertActivity.EXTRA_DURATION_MS, currentAlertDurationMs);
        i.putExtra("server_time_offset", serverTimeOffsetMs);
        if (recommendations != null && recommendations.length > 0) i.putExtra(AlertActivity.EXTRA_RECOMMENDATIONS, recommendations);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try { startActivity(i); } catch (Exception e) { Log.w(TAG, "startActivity falló: " + e.getMessage()); }
    }

    private static String extractOrigin(String url) {
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme(), host = u.getHost();
            if (scheme == null || host == null) return null;
            return scheme + "://" + host + (u.getPort() != -1 ? ":" + u.getPort() : "");
        } catch (Exception e) { return null; }
    }

    private void identifyToServer() {
        if (socket == null || !socket.connected()) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String cid = sp.getString(KEY_CLIENT_ID, "");

            JSONObject rolePayload = new JSONObject();
            if (cid != null && !cid.isEmpty()) rolePayload.put("clientId", cid);
            socket.emit("role:client", rolePayload);

            JSONObject identifyPayload = new JSONObject();
            if (cid != null && !cid.isEmpty()) identifyPayload.put("clientId", cid);
            identifyPayload.put("name", sp.getString(KEY_DEVICE_NAME, ""));

            JSONObject silentWindow = new JSONObject();
            silentWindow.put("enabled", sp.getBoolean(KEY_SILENT_ENABLED, false));
            silentWindow.put("from", sp.getString(KEY_SILENT_FROM, ""));
            silentWindow.put("to", sp.getString(KEY_SILENT_TO, ""));

            org.json.JSONArray daysArray = new org.json.JSONArray();
            String daysCsv = sp.getString(KEY_SILENT_DAYS, "");
            if (daysCsv != null && !daysCsv.isEmpty()) {
                for (String d : daysCsv.split(",")) {
                    try { daysArray.put(Integer.parseInt(d.trim())); } catch (NumberFormatException ignored) {}
                }
            }
            silentWindow.put("days", daysArray);

            identifyPayload.put("silentWindow", silentWindow);
            identifyPayload.put("isApk", true);
            socket.emit("client:identify", identifyPayload);
        } catch (Exception e) { Log.e(TAG, "Error identificando al server", e); }
    }
}