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
    public static final String ACTION_TEST_ALERT =
            "com.alertaemergencia.client.TEST_ALERT";
    // Lo manda MainActivity/AlertBridge cuando el usuario cambia la pausa.
    // Sólo refresca el texto de la notificación persistente (no reconecta
    // sockets, no cancela alertas en curso).
    public static final String ACTION_REFRESH_PAUSE =
            "com.alertaemergencia.client.REFRESH_PAUSE";

    public static final String EXTRA_SERVER_URL = "server_url";

    public static final String CHANNEL_ONGOING = "alertas_ongoing";
    public static final String CHANNEL_ALERT = "alertas_alert";

    // Compartidos con MainActivity para leer la URL del servidor si hay que
    // reiniciar el servicio sin que MainActivity esté viva (ej. el usuario
    // cerró la app del multitarea).
    public static final String PREFS = "alerta_config";
    public static final String KEY_SERVER_URL = "server_url";
    // Ajustes editables desde la pestaña "Ajustes" del webview a través de
    // AlertBridge. Si no están seteados, default = true / 100.
    public static final String KEY_SET_VIBRATION = "set_vibration";
    public static final String KEY_SET_STROBE = "set_strobe";
    public static final String KEY_SET_VOICE = "set_voice";
    public static final String KEY_SET_VOLUME = "set_volume";
    // Timestamp (ms) hasta el que el usuario pausó las notificaciones en
    // este dispositivo. Mientras esté en el futuro, el servicio ignora los
    // alert:start del server (no suena sirena, no vibra, no flash, no voz,
    // no notificación). 0 = no pausado. Number.MAX_SAFE_INTEGER = pausa
    // indefinida (hasta que el usuario la desactive).
    public static final String KEY_PAUSED_UNTIL = "paused_until";
    // Persistimos el startedAt de la última alerta descartada con la X. Si
    // el servicio muere (OOM / Doze / RestartReceiver) pierde el valor en
    // memoria y al reconectar el socket volvía a disparar la alerta. Con esto
    // sobrevive a restarts del proceso.
    public static final String KEY_DISMISSED_STARTED_AT = "dismissed_started_at";
    // Silencio horario por dispositivo (igual que en el cliente web). Si
    // está activo y la hora local cae dentro del rango y el día está en
    // la lista, descartamos el alert:start sin sonar (mismo comportamiento
    // que la pausa pero independiente).
    public static final String KEY_SILENT_ENABLED = "silent_enabled";
    public static final String KEY_SILENT_FROM = "silent_from"; // "HH:MM"
    public static final String KEY_SILENT_TO = "silent_to";     // "HH:MM"
    public static final String KEY_SILENT_DAYS = "silent_days"; // CSV "0,1,2..6"
    // Nombre que el host ve en su panel de Dispositivos. Lo setea el
    // usuario desde la pestaña Inicio del cliente web. Lo guardamos sólo
    // para enviarlo al server cuando el JS no esté disponible (no se usa
    // en el servicio nativo más allá de eso).
    public static final String KEY_DEVICE_NAME = "device_name";
    // Id estable del dispositivo. Lo persiste el cliente web (en
    // localStorage) y nos lo pasa por el bridge AlertBridge.setClientId.
    // Lo usamos al hacer role:client para que el server no nos cree un
    // "Cliente N" nuevo cada reconexión y para que el panel deduplique
    // este socket nativo con el del webview (mismo dispositivo).
    public static final String KEY_CLIENT_ID = "client_id";

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
    // Tipo de la alerta en curso (intruso, simulacro, fuego, etc.). Lo
    // usamos para aplicar multiplicadores de volumen específicos por tipo
    // (intruso suena bajo para no alertar al intruso, voz un toque más
    // alta en otros tipos para que se entienda).
    private String currentAlertType;
    // startedAt (timestamp del server) de la alerta actualmente mostrada.
    private long currentAlertStartedAt = 0;
    // Runnable del timeout del test alert (5s). Lo guardamos para poder
    // cancelarlo si entra una alerta real en esos 5s — si no lo cancelamos
    // el callback del timeout iba a ejecutar stopAlertMedia y matar la
    // alerta real que ya estaba sonando en su lugar.
    private Runnable pendingTestStop;
    // startedAt de la última alerta que el usuario descartó con la X. Sirve
    // para ignorar replays: cuando el servicio reconecta el socket (heartbeat
    // restart, red que vuelve, etc.) el server re-emite `alert:start` de la
    // alerta en curso. Si el usuario ya la descartó en este equipo, no la
    // volvemos a disparar.
    //
    // volatile: se escribe en main (onStartCommand / ACTION_DISMISS) y se lee
    // en el thread de Socket.IO (onAlertStart). Sin volatile, el thread de
    // Socket.IO podía ver un valor viejo (= 0) y re-disparar la alerta que
    // el usuario acababa de descartar.
    private volatile long dismissedStartedAt = 0;

    // ------------------------------------------------------------------
    //  Lifecycle
    // ------------------------------------------------------------------
    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        // Rehidratamos el startedAt descartado desde prefs, por si el proceso
        // fue matado por Android y un replay del server nos reactivaría una
        // alerta que el usuario ya cerró.
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
            // Recordamos la alerta que el usuario descartó para que si el
            // server nos re-envía `alert:start` (replay al reconectar el
            // socket, o tras un restart del servicio), no la volvamos a mostrar.
            if (currentAlertStartedAt > 0) {
                dismissedStartedAt = currentAlertStartedAt;
                try {
                    SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
                    sp.edit()
                            .putLong(KEY_DISMISSED_STARTED_AT, dismissedStartedAt)
                            .apply();
                } catch (Exception ignored) {
                }
            }
            stopAlertMedia("dismiss-from-user");
            return START_STICKY;
        }
        if (ACTION_REFRESH_PAUSE.equals(action)) {
            // Actualiza el texto de la notificación persistente para que el
            // profe vea a simple vista si sus alertas están pausadas.
            //
            // Importante: MainActivity nos llega acá vía startForegroundService(),
            // así que Android 8+ exige que llamemos startForeground() antes de
            // 5s o tira ForegroundServiceDidNotStartInTimeException. Si el
            // servicio ya estaba en foreground simplemente actualiza la notif;
            // si estaba muerto, lo promueve a foreground con el texto correcto.
            startForeground(NOTIF_ONGOING,
                    buildOngoingNotification(
                            decorateWithPause(describeConnectionState())));
            return START_STICKY;
        }
        if (ACTION_TEST_ALERT.equals(action)) {
            // Alerta de prueba de 5 segundos sin pasar por el server.
            // Sirena + voz + flash + vibración en modo simulacro.
            startForeground(NOTIF_ONGOING,
                    buildOngoingNotification("Prueba de alerta (5 seg)"));
            main.post(() -> {
                // Si ya hay una alerta real en curso, no corremos el test
                // (ni programamos el stop de 5s) para no interrumpirla.
                if (!alertActive) {
                    startAlertMedia("simulacro", "Prueba (5 seg)", null, false, 0, null, false);
                    // Guardamos el Runnable para poder cancelarlo si una
                    // alerta real reemplaza al test antes de los 5s. Si el
                    // test sigue corriendo cuando llega el timeout, el check
                    // extra `currentAlertStartedAt == 0` evita apagar una
                    // alerta real que haya tomado su lugar por otra vía.
                    pendingTestStop = () -> {
                        pendingTestStop = null;
                        if (alertActive && currentAlertStartedAt == 0) {
                            stopAlertMedia("test-timeout");
                        }
                    };
                    main.postDelayed(pendingTestStop, 5000);
                }
            });
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

        // Heartbeat: mientras el servicio está vivo, re-programamos un
        // restart para dentro de 60s. Si el sistema lo mata (Doze, OEM
        // agresivo, etc) igual va a volver a la vida gracias a este alarm.
        scheduleRestart(60000);
        return START_STICKY;
    }

    /**
     * Se llama cuando el usuario hace swipe-away de la app en el multitarea.
     * Android suele matar el servicio después; nosotros programamos varios
     * restarts escalonados usando AlarmManager + un BroadcastReceiver, que
     * vuelve a arrancar el servicio en foreground con la última URL guardada.
     * El escalonado es para que si el primero falla (p.ej. Doze justo en ese
     * momento) el siguiente igual lo reviva más adelante.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        scheduleRestart(1500);
    }

    /**
     * Programa UNA cadena de alarms escalonados (1.5s, 10s, 30s, 60s, 120s)
     * apuntando al {@link RestartReceiver}. Usa PendingIntents distintos por
     * cada retardo así coexisten. Cada alarm arranca el servicio otra vez
     * (idempotente: si ya estaba arriba, simplemente reconecta el socket).
     */
    private void scheduleRestart(long firstDelayMs) {
        try {
            AlarmManager am =
                    (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            long[] delays = {firstDelayMs, 10000L, 30000L, 60000L, 120000L};
            int reqCode = 1000;
            for (long delay : delays) {
                Intent restart = new Intent(getApplicationContext(),
                        RestartReceiver.class);
                restart.setAction(RestartReceiver.ACTION_RESTART);
                PendingIntent pi = PendingIntent.getBroadcast(
                        getApplicationContext(),
                        reqCode++,
                        restart,
                        PendingIntent.FLAG_UPDATE_CURRENT
                                | PendingIntent.FLAG_IMMUTABLE);
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
                // Mandamos el clientId que escribió el webview (vía
                // AlertBridge.setClientId) así el server deduplica nuestro
                // socket nativo con el del webview — son el mismo
                // dispositivo.
                try {
                    SharedPreferences sp = getSharedPreferences(
                            PREFS, MODE_PRIVATE);
                    String cid = sp.getString(KEY_CLIENT_ID, "");
                    JSONObject payload = new JSONObject();
                    if (cid != null && !cid.isEmpty()) {
                        payload.put("clientId", cid);
                    }
                    socket.emit("role:client", payload);
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
        final long startedAt = alert.optLong("startedAt", 0);
        // Recomendaciones del tipo: el server nos las manda en el mismo
        // payload (snapshot del momento del disparo). Si no vienen o están
        // vacías, pasamos un array vacío y AlertActivity simplemente no
        // las muestra.
        final String[] recommendations = extractStringArray(alert, "recommendations");
        // Si el usuario ya descartó esta misma alerta en este equipo,
        // ignoramos los replays (ej. reconexión del socket mientras la
        // alerta sigue activa en el server).
        if (startedAt > 0 && startedAt == dismissedStartedAt) {
            return;
        }
        // Pausa manual de notificaciones (toggle en la pestaña Ajustes del
        // cliente web). Se persiste en SharedPreferences desde
        // AlertBridge.setPausedUntil. Si todavía no venció, tiramos la
        // alerta a la basura — el server igual respeta la pausa a nivel
        // push, pero chequeamos acá también por si llega por socket antes
        // (o si este APK no tiene push suscrito).
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            long pausedUntil = sp.getLong(KEY_PAUSED_UNTIL, 0);
            if (pausedUntil > System.currentTimeMillis()) {
                Log.d(TAG, "Alerta ignorada (pausada hasta " + pausedUntil + ")");
                return;
            }
        } catch (Exception ignored) {
        }
        // Silencio horario (independiente de la pausa). Igual mostramos la
        // alerta en pantalla (notificación + AlertActivity) — esto es lo
        // que promete la pestaña Inicio: "este dispositivo no va a sonar
        // (igual recibe la alerta para verla en pantalla, pero sin sirena
        // ni voz)". Pasamos un flag a startAlertMedia para que omita
        // sirena/voz/vibración/flash pero mantenga la UI.
        final boolean silentMode = isInSilentWindowNow();
        if (silentMode) {
            Log.d(TAG, "Silencio horario activo: alerta visual sin sonido");
        }
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
        main.post(() -> startAlertMedia(type, label, sirenUrl, skipVoice, startedAt, recommendations, silentMode));
    };

    /**
     * Lee un array JSON de strings del payload de alert:start. Devuelve
     * un String[] (vacío si no hay o el campo no es array). Trunca cada
     * línea a 400 chars (mismo límite que el server) y tope de 20
     * elementos para defender contra payloads absurdamente grandes.
     */
    private String[] extractStringArray(JSONObject obj, String key) {
        try {
            if (!obj.has(key) || obj.isNull(key)) return new String[0];
            org.json.JSONArray arr = obj.optJSONArray(key);
            if (arr == null) return new String[0];
            int n = Math.min(arr.length(), 20);
            java.util.ArrayList<String> out = new java.util.ArrayList<>(n);
            for (int i = 0; i < n; i++) {
                String s = arr.optString(i, "");
                if (s == null) continue;
                s = s.trim();
                if (s.isEmpty()) continue;
                if (s.length() > 400) s = s.substring(0, 400);
                out.add(s);
            }
            return out.toArray(new String[0]);
        } catch (Exception e) {
            return new String[0];
        }
    }

    /**
     * Devuelve true si la hora local actual cae dentro del silencio horario
     * configurado por el usuario. Soporta rangos que cruzan medianoche
     * (ej. 22:00 → 07:00) y la lista de días (0=Dom, 1=Lun, …, 6=Sáb).
     * Si no está habilitado, devuelve false.
     */
    private boolean isInSilentWindowNow() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (!sp.getBoolean(KEY_SILENT_ENABLED, false)) return false;
            String from = sp.getString(KEY_SILENT_FROM, "");
            String to = sp.getString(KEY_SILENT_TO, "");
            String daysCsv = sp.getString(KEY_SILENT_DAYS, "");
            int fromMin = parseHHMM(from);
            int toMin = parseHHMM(to);
            if (fromMin < 0 || toMin < 0) return false;
            if (fromMin == toMin) return false;
            if (daysCsv == null || daysCsv.isEmpty()) return false;
            java.util.Calendar c = java.util.Calendar.getInstance();
            int dow = c.get(java.util.Calendar.DAY_OF_WEEK) - 1; // 0..6
            int nowMin = c.get(java.util.Calendar.HOUR_OF_DAY) * 60
                    + c.get(java.util.Calendar.MINUTE);
            // Determinamos qué día "cuenta" para el match. Si la ventana cruza
            // medianoche (ej. 22:00 → 07:00) y estamos del lado post-medianoche
            // (cur < to), el día relevante es el ANTERIOR (la noche que arrancó
            // el silencio). Mismo razonamiento que el JS en client.js.
            int dayToCheck;
            if (fromMin < toMin) {
                if (!(nowMin >= fromMin && nowMin < toMin)) return false;
                dayToCheck = dow;
            } else if (nowMin >= fromMin) {
                dayToCheck = dow;
            } else if (nowMin < toMin) {
                dayToCheck = (dow + 6) % 7;
            } else {
                return false;
            }
            for (String tok : daysCsv.split(",")) {
                try {
                    if (Integer.parseInt(tok.trim()) == dayToCheck) {
                        return true;
                    }
                } catch (NumberFormatException ignored) {
                }
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private int parseHHMM(String s) {
        if (s == null) return -1;
        int idx = s.indexOf(':');
        if (idx <= 0 || idx >= s.length() - 1) return -1;
        try {
            int h = Integer.parseInt(s.substring(0, idx));
            int m = Integer.parseInt(s.substring(idx + 1));
            if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
            return h * 60 + m;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * Multiplicadores de volumen por tipo de alerta. Replican lo mismo
     * que el cliente web (sirenVolumeMultiplier / voiceVolumeMultiplier).
     *  - intruso: sirena MUDA (no queremos avisarle al intruso). Queda
     *    sólo flash + vibración + voz baja para los que están cerca.
     *  - simulacro: 1.0 / 1.0 (es prueba, queremos que suene como una
     *    alerta real).
     *  - resto: bajamos la sirena a 0.65 para que la voz domine y la
     *    gente entienda qué está pasando (incendio, sismo, etc).
     */
    private float sirenVolumeMultiplier(String type) {
        if ("intruso".equalsIgnoreCase(type)) return 0f;
        if ("simulacro".equalsIgnoreCase(type)) return 1.0f;
        return 0.65f;
    }

    private float voiceVolumeMultiplier(String type) {
        if ("intruso".equalsIgnoreCase(type)) return 0.45f;
        return 1.0f;
    }

    /** Asegura que el valor entre a MediaPlayer.setVolume() en el rango [0,1]. */
    private float clampVol(float v) {
        if (v < 0f) return 0f;
        if (v > 1f) return 1f;
        return v;
    }

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
                                 String sirenUrl, boolean skipVoice,
                                 long startedAt, String[] recommendations,
                                 boolean silentMode) {
        // Si había un test alert con timeout programado a 5s y ahora entra
        // una alerta (sea real o otro test), cancelamos el timeout para que
        // no mate la nueva alerta cuando expire.
        if (pendingTestStop != null) {
            main.removeCallbacks(pendingTestStop);
            pendingTestStop = null;
        }
        if (alertActive) {
            // Si nos reenvían la MISMA alerta que ya estamos mostrando
            // (replay del server al reconectar socket), no hacemos nada
            // para evitar el parpadeo "se va / vuelve".
            if (startedAt > 0 && startedAt == currentAlertStartedAt) {
                return;
            }
            // Reemplazo de alerta en curso (ej. del host llegó un nuevo
            // `alert:start` sin que se haya emitido `alert:stop` antes). Hay
            // que parar sirena/voz/flash/vibración/activity actuales para que
            // los nuevos params (sirena custom, voz del nuevo tipo, label)
            // tomen efecto. Si no, el servicio queda con la alerta vieja.
            stopAlertMedia("replaced-by-new-alert");
        }
        alertActive = true;
        currentAlertStartedAt = startedAt;
        currentAlertType = type;
        acquireWakeLock();
        // En silencio horario salteamos sirena/voz/vibración/flash, pero
        // mostramos igual la notificación y la AlertActivity (la pantalla
        // de alerta full-screen que despierta el celu). Eso es lo que el
        // cliente web hace también — el usuario igual tiene que poder ver
        // que hubo una alerta cuando el celu estaba bloqueado.
        if (!silentMode) {
            // Leemos los toggles del usuario (pestaña Ajustes del cliente
            // web). Sólo aplican si NO estamos en silencio horario.
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            boolean wantVibration = sp.getBoolean(KEY_SET_VIBRATION, true);
            boolean wantStrobe = sp.getBoolean(KEY_SET_STROBE, true);
            boolean wantVoice = sp.getBoolean(KEY_SET_VOICE, true);
            startSiren(sirenUrl);
            if (!skipVoice && wantVoice) {
                startVoiceLoop(type, label);
            }
            if (wantVibration) startVibrationLoop();
            if (wantStrobe && flash != null) flash.startBlinking();
        }
        showAlertNotification(type, label, recommendations);
        launchAlertActivity(type, label, recommendations);
    }

    private void stopAlertMedia(String reason) {
        Log.d(TAG, "stopAlertMedia: " + reason);
        alertActive = false;
        currentAlertStartedAt = 0;
        currentAlertType = null;
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
                // Aplicamos el porcentaje que el usuario eligió en Ajustes
                // (slider de volumen). Si no hay nada guardado, por defecto 100%.
                SharedPreferences volSp = getSharedPreferences(PREFS, MODE_PRIVATE);
                int pct = volSp.getInt(KEY_SET_VOLUME, 100);
                if (pct < 0) pct = 0;
                if (pct > 100) pct = 100;
                int target = Math.round((pct / 100f) * max);
                if (target < 1 && pct > 0) target = 1;
                am.setStreamVolume(AudioManager.STREAM_ALARM, target, 0);
            }
            // Multiplicador por tipo de alerta (intruso suena bajo, resto
            // a 1.0). Se aplica sobre el stream ya configurado. Lo clampeamos
            // a [0,1] porque MediaPlayer.setVolume() es estricto con el rango.
            try {
                float mul = clampVol(sirenVolumeMultiplier(currentAlertType));
                sirenPlayer.setVolume(mul, mul);
            } catch (Exception ignored) {
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
                    // Multiplicador por tipo (intruso bajo, resto leve
                    // boost para que se entienda mejor que la sirena). Se
                    // clampea a [0,1] porque MediaPlayer.setVolume() exige
                    // ese rango (1.15 sería contrato roto, aunque algunos
                    // dispositivos lo aceptan silenciosamente).
                    float mul = clampVol(voiceVolumeMultiplier(currentAlertType));
                    try {
                        mp.setVolume(mul, mul);
                    } catch (Exception ignored) {
                    }
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
            nm.notify(NOTIF_ONGOING, buildOngoingNotification(decorateWithPause(text)));
        }
    }

    /**
     * Si hay una pausa activa en SharedPreferences, antepone "⏸ Pausado" al
     * texto de la notificación persistente. Sirve como indicador visible
     * para el profe (sin tener que abrir la app) de que efectivamente
     * no va a recibir alertas.
     */
    private String decorateWithPause(String baseText) {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            long pausedUntil = sp.getLong(KEY_PAUSED_UNTIL, 0);
            long now = System.currentTimeMillis();
            if (pausedUntil > now) {
                if (pausedUntil >= Long.MAX_VALUE / 2) {
                    return "⏸ Pausado (indefinido) · " + baseText;
                }
                long mins = Math.max(1, (pausedUntil - now) / 60000);
                if (mins >= 60) {
                    long hours = mins / 60;
                    return "⏸ Pausado ~" + hours + "h · " + baseText;
                }
                return "⏸ Pausado ~" + mins + "min · " + baseText;
            }
        } catch (Exception ignored) {
        }
        return baseText;
    }

    /**
     * Describe el estado actual del socket para usar como texto base de la
     * notificación persistente. No sabemos el estado exacto desde acá sin
     * exponerlo — asumimos "Conectado" porque si el servicio está vivo y
     * no hubo error reciente, lo más probable es que esté escuchando.
     */
    private String describeConnectionState() {
        if (socket != null && socket.connected()) {
            return "Conectado · esperando alertas";
        }
        return "Esperando conexión…";
    }

    private void showAlertNotification(String type, String label, String[] recommendations) {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent open = new Intent(this, AlertActivity.class);
        open.putExtra(AlertActivity.EXTRA_TYPE, type);
        open.putExtra(AlertActivity.EXTRA_LABEL, label);
        // Incluimos las recomendaciones acá también para que, si el
        // usuario abre la alerta tocando la notif (o si Android usa el
        // fullScreenIntent en vez de nuestro startActivity), AlertActivity
        // reciba el array y muestre la tarjeta "QUÉ HACER".
        if (recommendations != null && recommendations.length > 0) {
            open.putExtra(AlertActivity.EXTRA_RECOMMENDATIONS, recommendations);
        }
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
    private void launchAlertActivity(String type, String label, String[] recommendations) {
        Intent i = new Intent(this, AlertActivity.class);
        i.putExtra(AlertActivity.EXTRA_TYPE, type);
        i.putExtra(AlertActivity.EXTRA_LABEL, label);
        if (recommendations != null && recommendations.length > 0) {
            i.putExtra(AlertActivity.EXTRA_RECOMMENDATIONS, recommendations);
        }
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
