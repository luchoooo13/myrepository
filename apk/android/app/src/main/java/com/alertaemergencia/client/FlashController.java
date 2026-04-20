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
    // Efecto estrobo: prende muy poquito tiempo y queda apagado un rato más
    // largo. Se percibe como un flash de emergencia (policial / ambulancia),
    // mucho más llamativo que un 50/50. El ciclo total (ON+OFF) es parecido
    // al anterior (~250ms), sólo que ahora el ON es muy corto.
    private static final long ON_MS = 40;
    private static final long OFF_MS = 210;

    private final CameraManager cm;
    private final String cameraId; // null si no hay cámara con flash
    private HandlerThread thread;
    private Handler handler;
    private volatile boolean blinking = false;
    // volatile: lo escribe `setTorch()` (thread del HandlerThread durante el
    // loop, o thread principal cuando `stopBlinking()` apaga la linterna) y
    // lo lee `blinkLoop` antes de decidir el próximo toggle. Sin volatile un
    // stale read podía mandar setTorch(true) justo después del stopBlinking
    // y dejar la linterna prendida para siempre.
    private volatile boolean currentlyOn = false;

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
            boolean nextOn = !currentlyOn;
            setTorch(nextOn);
            // Race fix: si stopBlinking() corrió MIENTRAS estábamos haciendo
            // setTorch(nextOn) (pasó el check de `blinking` pero todavía no
            // llamó setTorch), el main thread ya hizo setTorch(false) y
            // después nosotros lo sobre-escribimos con setTorch(true) →
            // linterna prendida para siempre. Re-chequeamos `blinking` después
            // del toggle y si pasó a false, forzamos apagado y cortamos.
            if (!blinking) {
                setTorch(false);
                return;
            }
            // Leemos `handler` a un local primero: `stopBlinking()` corre en
            // otro thread y lo puede nullear justo después del check de
            // `blinking`. Sin este snapshot, postDelayed podría NPE'ar.
            Handler h = handler;
            // Estrobo asimétrico: poco tiempo prendido (ON_MS), mucho más
            // apagado (OFF_MS). El delay hasta el próximo toggle depende
            // del estado al que acabamos de cambiar.
            long delay = nextOn ? ON_MS : OFF_MS;
            if (h != null) h.postDelayed(this, delay);
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
