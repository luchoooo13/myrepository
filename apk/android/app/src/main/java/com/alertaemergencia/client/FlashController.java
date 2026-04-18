package com.alertaemergencia.client;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

/**
 * Controla el flash (torch) de la cámara trasera para usarlo como "flash
 * parpadeante" durante una alerta. Usa la API {@link CameraManager#setTorchMode}
 * disponible desde Android 6.0 (API 23).
 */
public class FlashController {

    private static final String TAG = "FlashController";
    private static final long BLINK_MS = 250;

    private final CameraManager cm;
    private final String cameraId; // null si no hay cámara con flash
    private HandlerThread thread;
    private Handler handler;
    private volatile boolean blinking = false;
    private boolean currentlyOn = false;

    public FlashController(Context ctx) {
        CameraManager mgr = null;
        String id = null;
        try {
            mgr = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
            if (mgr != null) {
                for (String cid : mgr.getCameraIdList()) {
                    CameraCharacteristics cc = mgr.getCameraCharacteristics(cid);
                    Boolean hasFlash = cc.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                    Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                    if (Boolean.TRUE.equals(hasFlash)
                            && facing != null
                            && facing == CameraCharacteristics.LENS_FACING_BACK) {
                        id = cid;
                        break;
                    }
                }
                if (id == null) {
                    // fallback: cualquier cámara con flash.
                    for (String cid : mgr.getCameraIdList()) {
                        CameraCharacteristics cc = mgr.getCameraCharacteristics(cid);
                        Boolean hasFlash = cc.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                        if (Boolean.TRUE.equals(hasFlash)) {
                            id = cid;
                            break;
                        }
                    }
                }
            }
        } catch (CameraAccessException e) {
            Log.w(TAG, "No se pudo enumerar las cámaras", e);
        } catch (Exception e) {
            Log.w(TAG, "CameraManager no disponible", e);
        }
        this.cm = mgr;
        this.cameraId = id;
    }

    public boolean hasFlash() {
        return cm != null && cameraId != null;
    }

    public synchronized void startBlinking() {
        if (!hasFlash() || blinking) return;
        blinking = true;
        thread = new HandlerThread("flash-blink");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(blinkLoop);
    }

    private final Runnable blinkLoop = new Runnable() {
        @Override
        public void run() {
            if (!blinking) return;
            setTorch(!currentlyOn);
            // Leemos `handler` a un local primero: `stopBlinking()` corre en
            // otro thread y lo puede nullear justo después del check de
            // `blinking`. Sin este snapshot, postDelayed podría NPE'ar.
            Handler h = handler;
            if (h != null) h.postDelayed(this, BLINK_MS);
        }
    };

    public synchronized void stopBlinking() {
        if (!blinking) return;
        blinking = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        setTorch(false);
        if (thread != null) {
            thread.quitSafely();
            thread = null;
        }
        handler = null;
    }

    private void setTorch(boolean on) {
        if (!hasFlash()) return;
        try {
            cm.setTorchMode(cameraId, on);
            currentlyOn = on;
        } catch (CameraAccessException e) {
            Log.w(TAG, "setTorchMode falló", e);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "cameraId inválido", e);
        }
    }
}
