package com.alertaemergencia.client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

/**
 * Recibe el broadcast programado por AlarmManager cuando el usuario cierra la
 * app del multitarea (onTaskRemoved en AlertService). Vuelve a arrancar el
 * AlertService en foreground leyendo la URL del servidor desde SharedPreferences.
 * También se usa para restart en boot (BOOT_COMPLETED) si se agrega ese receiver.
 */
public class RestartReceiver extends BroadcastReceiver {

    public static final String ACTION_RESTART =
            "com.alertaemergencia.client.RESTART";

    private static final String TAG = "RestartReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;

        SharedPreferences prefs = context.getSharedPreferences(
                AlertService.PREFS, Context.MODE_PRIVATE);
        String url = prefs.getString(AlertService.KEY_SERVER_URL, "");
        if (url == null || url.isEmpty()) {
            Log.w(TAG, "No hay URL guardada, no se reinicia el servicio.");
            return;
        }

        Intent svc = new Intent(context, AlertService.class);
        svc.setAction(AlertService.ACTION_START);
        svc.putExtra(AlertService.EXTRA_SERVER_URL, url);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
            Log.d(TAG, "AlertService re-iniciado.");
        } catch (Exception e) {
            Log.w(TAG, "No se pudo reiniciar AlertService", e);
        }
    }
}
