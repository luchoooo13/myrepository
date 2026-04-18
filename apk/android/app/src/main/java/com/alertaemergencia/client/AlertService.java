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
import java.net.URISyntaxException;

/**
 * Servicio en foreground que mantiene la conexión Socket.IO al server de alertas
 * incluso con la app minimizada o la pantalla bloqueada. Al llegar una alerta:
 *   1) reproduce la sirena bundleada en assets/siren.mp3 (loop);
 *   2) vibra con un patrón repetitivo;
 *   3) prende / apaga el flash de la cámara a ~4Hz;
 *   4) lanza {@link AlertActivity} vía fullScreenIntent para tapar la pantalla.
 */
public class AlertService extends Service {

    private static final String TAG = "AlertService";

    public static final String ACTION_START = "com.alertaemergencia.client.START";
    public static final String ACTION_STOP = "com.alertaemergencia.client.STOP";
    public static final String ACTION_DISMISS_ALERT =
            "com.alertaemergencia.client.DISMISS";

    public static final String EXTRA_SERVER_URL = "server_url";

    public static final String CHANNEL_ONGOING = "alertas_ongoing";
    public static final String CHANNEL_ALERT = "alertas_alert";

    // Compartidos con MainActivity para leer la URL del servidor si hay que
    // reiniciar el servicio sin que MainActivity esté viva (ej. el usuario
    // cerró la app del multitarea).
    public static final String PREFS = "alerta_config";
    public static final String KEY_SERVER_URL = "server_url";

    private static final int NOTIF_ONGOING = 101;
    private static final int NOTIF_ALERT = 102;

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
    private String currentVoiceUrl;

    // ------------------------------------------------------------------
    //  Lifecycle
    // ------------------------------------------------------------------
    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        flash = new FlashController(getApplicationContext());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            vibrator = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            //noinspection deprecation
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "AlertaCliente:AlertService");
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
            stopAlertMedia("dismiss-from-user");
            return START_STICKY;
        }

        String url = intent != null ? intent.getStringExtra(EXTRA_SERVER_URL) : null;
        if (url == null || url.isEmpty()) {
            // Si no vino URL (ej. al ser resucitado por AlarmManager después
            // de que el usuario cerró la app), la leemos de SharedPreferences.
            url = getSavedServerUrl();
        }
        if (url != null && !url.isEmpty()) {
            serverOrigin = extractOrigin(url);
            // Guardamos la URL para futuros restarts silenciosos.
            SharedPreferences prefs =
                    getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_SERVER_URL, url).apply();
        }

        startForeground(NOTIF_ONGOING, buildOngoingNotification("Conectando…"));
        connectSocket();
        return START_STICKY;
    }

    /**
     * Se llama cuando el usuario hace swipe-away de la app en el multitarea.
     * Android suele matar el servicio después; nosotros programamos un
     * restart casi inmediato usando AlarmManager + un BroadcastReceiver, que
     * vuelve a arrancar el servicio en foreground con la última URL guardada.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        scheduleRestart(1500);
    }

    private void scheduleRestart(long delayMs) {
        try {
            Intent restart = new Intent(getApplicationContext(),
                    RestartReceiver.class);
            restart.setAction(RestartReceiver.ACTION_RESTART);
            PendingIntent pi = PendingIntent.getBroadcast(
                    getApplicationContext(),
                    1,
                    restart,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            AlarmManager am =
                    (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            long when = System.currentTimeMillis() + delayMs;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, when, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "scheduleRestart falló", e);
        }
    }

    private String getSavedServerUrl() {
        SharedPreferences prefs =
                getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.getString(KEY_SERVER_URL, "");
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopAlertMedia("service-destroy");
        disconnectSocket();
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------------
    //  Socket.IO
    // ------------------------------------------------------------------
    private void connectSocket() {
        disconnectSocket();
        if (serverOrigin == null) {
            Log.w(TAG, "No hay serverOrigin para conectar");
            return;
        }
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.reconnectionDelay = 1000;
            opts.reconnectionDelayMax = 5000;
            opts.timeout = 5000;
            socket = IO.socket(URI.create(serverOrigin), opts);

            socket.on(Socket.EVENT_CONNECT, args -> {
                Log.d(TAG, "Socket conectado");
                main.post(() -> updateOngoing("Conectado · esperando alertas"));
                // Avisamos al server que somos un cliente (para el contador).
                try {
                    socket.emit("role:client");
                } catch (Exception ignored) {
                }
            });
            socket.on(Socket.EVENT_DISCONNECT, args -> {
                Log.d(TAG, "Socket desconectado");
                main.post(() -> updateOngoing("Reconectando…"));
            });
            socket.on(Socket.EVENT_CONNECT_ERROR, args -> {
                Log.w(TAG, "Socket error: " + (args.length > 0 ? args[0] : ""));
                main.post(() -> updateOngoing("Sin conexión"));
            });
            socket.on("alert:start", onAlertStart);
            socket.on("alert:stop", args -> main.post(() -> stopAlertMedia("server-stop")));

            socket.connect();
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "URL inválida: " + serverOrigin, e);
        }
    }

    private void disconnectSocket() {
        if (socket != null) {
            try {
                socket.off();
                socket.disconnect();
            } catch (Exception ignored) {
            }
            socket = null;
        }
    }

    private final Emitter.Listener onAlertStart = args -> {
        if (args.length == 0 || !(args[0] instanceof JSONObject)) return;
        JSONObject alert = (JSONObject) args[0];
        String type = alert.optString("type", "alerta");
        String label = alert.optString("label", type);
        // Overrides opcionales: el server puede pedir una sirena custom
        // (ej. simulacro) y/o que no reproduzcamos la voz aparte porque el
        // mp3 de la sirena ya incluye la locución.
        // OJO: `optString` en org.json devuelve la cadena literal "null" si
        // el valor JSON es null, por eso chequeamos `isNull` primero.
        String sirenUrlRaw = alert.isNull("sirenUrl")
                ? ""
                : alert.optString("sirenUrl", "");
        boolean skipVoice = alert.optBoolean("skipVoice", false);
        final String sirenUrl =
                (sirenUrlRaw == null || sirenUrlRaw.isEmpty()
                        || "null".equals(sirenUrlRaw))
                        ? null
                        : absolutizeUrl(sirenUrlRaw);
        main.post(() -> startAlertMedia(type, label, sirenUrl, skipVoice));
    };

    /**
     * Convierte una URL relativa recibida del server (ej. "/sounds/x.mp3") a
     * absoluta usando serverOrigin. Si ya viene con http(s) la devuelve tal cual.
     */
    private String absolutizeUrl(String s) {
        if (s == null || s.isEmpty()) return null;
        if (s.startsWith("http://") || s.startsWith("https://")) return s;
        if (serverOrigin == null) return null;
        if (s.startsWith("/")) return serverOrigin + s;
        return serverOrigin + "/" + s;
    }

    // ------------------------------------------------------------------
    //  Alerta
    // ------------------------------------------------------------------
    private void startAlertMedia(String type, String label,
                                 String sirenUrl, boolean skipVoice) {
        if (alertActive) {
            // Ya estábamos con una alerta; sólo refrescamos la notif.
            showAlertNotification(type, label);
            return;
        }
        alertActive = true;
        acquireWakeLock();
        startSiren(sirenUrl);
        if (!skipVoice) {
            startVoiceLoop(type, label);
        }
        startVibrationLoop();
        if (flash != null) flash.startBlinking();
        showAlertNotification(type, label);
        launchAlertActivity(type, label);
    }

    private void stopAlertMedia(String reason) {
        Log.d(TAG, "stopAlertMedia: " + reason);
        alertActive = false;
        stopSiren();
        stopVoiceLoop();
        stopVibrationLoop();
        if (flash != null) flash.stopBlinking();
        dismissAlertNotification();
        // Avisamos a cualquier AlertActivity viva que cierre.
        Intent close = new Intent(AlertActivity.ACTION_CLOSE);
        close.setPackage(getPackageName());
        sendBroadcast(close);
        releaseWakeLock();
    }

    private void startSiren(String customUrl) {
        stopSiren();
        try {
            sirenPlayer = new MediaPlayer();
            boolean usedRemote = false;
            if (customUrl != null && !customUrl.isEmpty()) {
                // Sirena remota (ej. /sounds/siren-simulacro.mp3). Si falla
                // el prepareAsync, caemos al asset bundleado como fallback.
                try {
                    sirenPlayer.setDataSource(customUrl);
                    usedRemote = true;
                } catch (Exception ex) {
                    Log.w(TAG, "setDataSource custom falló: " + ex.getMessage());
                    try {
                        sirenPlayer.reset();
                    } catch (Exception ignored) {
                    }
                    usedRemote = false;
                }
            }
            if (!usedRemote) {
                AssetFileDescriptor afd = getAssets().openFd("siren.mp3");
                sirenPlayer.setDataSource(afd.getFileDescriptor(),
                        afd.getStartOffset(), afd.getLength());
                afd.close();
            }
            sirenPlayer.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            sirenPlayer.setLooping(true);
            // Subimos el volumen de alarma al máximo (el usuario lo puede bajar
            // desde el volumen físico del dispositivo).
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, max, 0);
            }
            if (usedRemote) {
                // Para URLs remotas usamos prepareAsync para no bloquear el hilo.
                sirenPlayer.setOnPreparedListener(mp -> {
                    try {
                        if (alertActive) mp.start();
                    } catch (IllegalStateException ignored) {
                    }
                });
                sirenPlayer.setOnErrorListener((mp, what, extra) -> {
                    Log.w(TAG, "sirenPlayer remoto error " + what + "/" + extra
                            + ", cayendo a sirena local");
                    // En error, intentamos arrancar la sirena local bundleada.
                    main.post(() -> {
                        if (alertActive) startSiren(null);
                    });
                    return true;
                });
                sirenPlayer.prepareAsync();
            } else {
                sirenPlayer.prepare();
                sirenPlayer.start();
            }
        } catch (Exception e) {
            Log.e(TAG, "No se pudo iniciar la sirena", e);
            stopSiren();
        }
    }

    private void stopSiren() {
        if (sirenPlayer != null) {
            try {
                if (sirenPlayer.isPlaying()) sirenPlayer.stop();
            } catch (IllegalStateException ignored) {
            }
            try {
                sirenPlayer.release();
            } catch (Exception ignored) {
            }
            sirenPlayer = null;
        }
    }

    private void startVoiceLoop(String type, String label) {
        stopVoiceLoop();
        if (serverOrigin == null) return;
        try {
            String url;
            if ("custom".equalsIgnoreCase(type)) {
                String q = java.net.URLEncoder.encode(
                        label == null ? "" : label, "UTF-8");
                url = serverOrigin + "/tts?text=" + q;
            } else {
                url = serverOrigin + "/sounds/voice/" + type + ".mp3";
            }
            currentVoiceUrl = url;
            playVoiceOnce();
        } catch (Exception e) {
            Log.w(TAG, "startVoiceLoop falló", e);
        }
    }

    private void playVoiceOnce() {
        if (!alertActive || currentVoiceUrl == null) return;
        // Liberamos el player anterior si quedó vivo.
        stopVoicePlayer();
        try {
            voicePlayer = new MediaPlayer();
            voicePlayer.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            voicePlayer.setDataSource(currentVoiceUrl);
            voicePlayer.setLooping(false);
            voicePlayer.setOnPreparedListener(mp -> {
                try {
                    if (alertActive) mp.start();
                } catch (IllegalStateException ignored) {
                }
            });
            voicePlayer.setOnCompletionListener(mp -> {
                // Repetimos cada 5s aprox mientras dure la alerta.
                voiceHandler.removeCallbacksAndMessages(null);
                voiceHandler.postDelayed(() -> {
                    if (alertActive) playVoiceOnce();
                }, 5000);
            });
            voicePlayer.setOnErrorListener((mp, what, extra) -> {
                Log.w(TAG, "voicePlayer error " + what + "/" + extra);
                // En error, reintentamos en 5s (red puede volver).
                voiceHandler.postDelayed(() -> {
                    if (alertActive) playVoiceOnce();
                }, 5000);
                return true;
            });
            voicePlayer.prepareAsync();
        } catch (Exception e) {
            Log.w(TAG, "playVoiceOnce falló", e);
        }
    }

    private void stopVoicePlayer() {
        if (voicePlayer != null) {
            try {
                if (voicePlayer.isPlaying()) voicePlayer.stop();
            } catch (IllegalStateException ignored) {
            }
            try {
                voicePlayer.reset();
                voicePlayer.release();
            } catch (Exception ignored) {
            }
            voicePlayer = null;
        }
    }

    private void stopVoiceLoop() {
        voiceHandler.removeCallbacksAndMessages(null);
        stopVoicePlayer();
        currentVoiceUrl = null;
    }

    private void startVibrationLoop() {
        if (vibrator == null || !vibrator.hasVibrator()) return;
        vibHandler.removeCallbacksAndMessages(null);
        final Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (!alertActive) return;
                try {
                    long[] pattern = {0, 600, 300};
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1));
                    } else {
                        //noinspection deprecation
                        vibrator.vibrate(pattern, -1);
                    }
                } catch (Exception ignored) {
                }
                vibHandler.postDelayed(this, 900);
            }
        };
        vibHandler.post(tick);
    }

    private void stopVibrationLoop() {
        vibHandler.removeCallbacksAndMessages(null);
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (Exception ignored) {
            }
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && !wakeLock.isHeld()) {
            try {
                wakeLock.acquire(2 * 60 * 1000L);
            } catch (Exception ignored) {
            }
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {
            }
        }
    }

    // ------------------------------------------------------------------
    //  Notificaciones
    // ------------------------------------------------------------------
    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_ONGOING,
                "Servicio de alertas",
                NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription("Notificación persistente mientras el cliente está escuchando alertas.");
        ongoing.setShowBadge(false);
        ongoing.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ongoing);

        NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT,
                "SchoolAlerts",
                NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("Alertas en vivo: sirena, flash y pantalla completa.");
        alert.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        alert.enableLights(true);
        alert.setLightColor(0xFFDC2626);
        alert.setBypassDnd(true);
        // El audio lo controla el servicio (MediaPlayer), no la notif.
        alert.setSound(null, null);
        nm.createNotificationChannel(alert);
    }

    private Notification buildOngoingNotification(String text) {
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ONGOING)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("SchoolAlerts")
                .setContentText(text)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private void updateOngoing(String text) {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIF_ONGOING, buildOngoingNotification(text));
        }
    }

    private void showAlertNotification(String type, String label) {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent open = new Intent(this, AlertActivity.class);
        open.putExtra(AlertActivity.EXTRA_TYPE, type);
        open.putExtra(AlertActivity.EXTRA_LABEL, label);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        PendingIntent content = PendingIntent.getActivity(
                this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent dismiss = new Intent(this, AlertService.class);
        dismiss.setAction(ACTION_DISMISS_ALERT);
        PendingIntent dismissPI = PendingIntent.getService(
                this, 2, dismiss,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("⚠ ALERTA · " + label.toUpperCase())
                .setContentText("Tocá para ver la alerta")
                .setOngoing(true)
                .setAutoCancel(false)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setColor(0xFFDC2626)
                .setContentIntent(content)
                .setFullScreenIntent(content, true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel,
                        "Cerrar en este equipo", dismissPI)
                .build();
        nm.notify(NOTIF_ALERT, notif);
    }

    private void dismissAlertNotification() {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIF_ALERT);
    }

    // ------------------------------------------------------------------
    //  Launch AlertActivity
    // ------------------------------------------------------------------
    private void launchAlertActivity(String type, String label) {
        Intent i = new Intent(this, AlertActivity.class);
        i.putExtra(AlertActivity.EXTRA_TYPE, type);
        i.putExtra(AlertActivity.EXTRA_LABEL, label);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            startActivity(i);
        } catch (Exception e) {
            // En Android 10+ no se puede launch activity desde background
            // sin fullScreenIntent — por eso también publicamos la notif arriba.
            Log.w(TAG, "startActivity (fullscreen) falló: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------
    //  Helpers
    // ------------------------------------------------------------------
    private static String extractOrigin(String url) {
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            String host = u.getHost();
            int port = u.getPort();
            if (scheme == null || host == null) return null;
            String origin = scheme + "://" + host;
            if (port != -1) origin += ":" + port;
            return origin;
        } catch (Exception e) {
            return null;
        }
    }
}
