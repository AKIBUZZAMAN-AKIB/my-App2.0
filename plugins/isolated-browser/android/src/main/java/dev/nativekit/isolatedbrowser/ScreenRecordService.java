package dev.nativekit.isolatedbrowser;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.widget.Toast;

import java.io.File;

/**
 * Screen recording through MediaProjection. Runs as a foreground service of
 * type mediaProjection (required from Android 10, enforced from Android 14),
 * started right after the user grants the system capture dialog; the
 * projection token is used exactly once (Android 14+ rule). Video is written
 * straight into the gallery (Movies/&lt;app&gt;) through MediaStore.
 */
public final class ScreenRecordService extends Service {
    static final String ACTION_START = "dev.nativekit.isolatedbrowser.REC_START";
    static final String ACTION_STOP = "dev.nativekit.isolatedbrowser.REC_STOP";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DATA = "data";
    static final String EXTRA_WIDTH = "w";
    static final String EXTRA_HEIGHT = "h";
    static final String EXTRA_DPI = "dpi";
    private static final String CHANNEL = "nk_screen_record";
    private static final int NOTIFICATION_ID = 4711;

    private static volatile boolean recording;
    private static volatile long startedAt;
    /** Same-process UI hook (the browser shows its REC pill); always run on main. */
    static volatile Runnable listener;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaRecorder recorder;
    private Uri pendingUri;
    private ParcelFileDescriptor pfd;
    private File legacyFile;
    private boolean stopping;

    static boolean isRecording() { return recording; }
    static long startedAt() { return startedAt; }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            finishRecording(true);
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action) || recording) return START_NOT_STICKY;
        Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            else startForeground(NOTIFICATION_ID, notification);
        } catch (Throwable error) {
            fail("Screen recording is not allowed right now");
            return START_NOT_STICKY;
        }
        try {
            int code = intent.getIntExtra(EXTRA_CODE, 0);
            Intent data = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(EXTRA_DATA, Intent.class)
                : intent.getParcelableExtra(EXTRA_DATA);
            int width = even(intent.getIntExtra(EXTRA_WIDTH, 720));
            int height = even(intent.getIntExtra(EXTRA_HEIGHT, 1280));
            int dpi = intent.getIntExtra(EXTRA_DPI, 320);
            // Keep the encoder inside common hardware limits (long side <= 1920).
            int longSide = Math.max(width, height);
            if (longSide > 1920) {
                float s = 1920f / longSide;
                width = even(Math.round(width * s));
                height = even(Math.round(height * s));
            }
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = manager.getMediaProjection(code, data);
            if (projection == null) throw new IllegalStateException("no projection");
            // Android 14+: the callback must be registered before capturing.
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { main.post(() -> finishRecording(true)); }
            }, main);
            recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
            recorder.setVideoSize(width, height);
            recorder.setVideoFrameRate(30);
            recorder.setVideoEncodingBitRate(Math.max(2_000_000, width * height * 5));
            openOutput();
            recorder.prepare();
            display = projection.createVirtualDisplay("nk-screen-record", width, height, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, recorder.getSurface(), null, null);
            recorder.start();
            recording = true;
            startedAt = System.currentTimeMillis();
            notifyUi();
        } catch (Throwable error) {
            discardOutput();
            fail("Could not start screen recording");
        }
        return START_NOT_STICKY;
    }

    private void openOutput() throws Exception {
        String name = "Recording_" + MediaSaver.stamp() + ".mp4";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Video.Media.DISPLAY_NAME, name);
            values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/" + MediaSaver.folder(this));
            values.put(MediaStore.Video.Media.IS_PENDING, 1);
            pendingUri = getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
            if (pendingUri == null) throw new IllegalStateException("no media uri");
            pfd = getContentResolver().openFileDescriptor(pendingUri, "rw");
            if (pfd == null) throw new IllegalStateException("no fd");
            recorder.setOutputFile(pfd.getFileDescriptor());
        } else {
            File dir = new File(getExternalFilesDir(Environment.DIRECTORY_MOVIES), MediaSaver.folder(this));
            if (!dir.exists()) dir.mkdirs();
            legacyFile = new File(dir, name);
            recorder.setOutputFile(legacyFile.getAbsolutePath());
        }
    }

    private void finishRecording(boolean save) {
        if (stopping) return;
        stopping = true;
        boolean ok = false;
        if (recorder != null) {
            try { if (recording) { recorder.stop(); ok = save; } } catch (Throwable ignored) { ok = false; }
            try { recorder.release(); } catch (Throwable ignored) {}
            recorder = null;
        }
        if (display != null) { try { display.release(); } catch (Throwable ignored) {} display = null; }
        if (projection != null) { try { projection.stop(); } catch (Throwable ignored) {} projection = null; }
        if (pfd != null) { try { pfd.close(); } catch (Throwable ignored) {} pfd = null; }
        boolean wasRecording = recording;
        recording = false;
        if (ok && pendingUri != null) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Video.Media.IS_PENDING, 0);
                getContentResolver().update(pendingUri, values, null, null);
            } catch (Throwable ignored) {}
            toast("Recording saved to Movies/" + MediaSaver.folder(this));
        } else if (ok && legacyFile != null) {
            try { android.media.MediaScannerConnection.scanFile(this, new String[] { legacyFile.getAbsolutePath() }, new String[] { "video/mp4" }, null); } catch (Throwable ignored) {}
            toast("Recording saved");
        } else {
            discardOutput();
            if (wasRecording) toast("Recording was too short to save");
        }
        pendingUri = null;
        legacyFile = null;
        notifyUi();
        try { stopForeground(true); } catch (Throwable ignored) {}
        stopSelf();
    }

    private void discardOutput() {
        if (pfd != null) { try { pfd.close(); } catch (Throwable ignored) {} pfd = null; }
        if (pendingUri != null) { try { getContentResolver().delete(pendingUri, null, null); } catch (Throwable ignored) {} pendingUri = null; }
        if (legacyFile != null) { try { legacyFile.delete(); } catch (Throwable ignored) {} legacyFile = null; }
    }

    private void fail(String message) {
        if (recorder != null) { try { recorder.release(); } catch (Throwable ignored) {} recorder = null; }
        if (display != null) { try { display.release(); } catch (Throwable ignored) {} display = null; }
        if (projection != null) { try { projection.stop(); } catch (Throwable ignored) {} projection = null; }
        recording = false;
        toast(message);
        notifyUi();
        try { stopForeground(true); } catch (Throwable ignored) {}
        stopSelf();
    }

    @Override public void onDestroy() {
        if (recording) finishRecording(true);
        super.onDestroy();
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Screen recording", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while the browser records the screen");
            nm.createNotificationChannel(channel);
        }
        Intent stop = new Intent(this, ScreenRecordService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.nk_ic_record_dot)
            .setContentTitle("Recording screen")
            .setContentText("Tap Stop to save the video to your gallery")
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis())
            .setContentIntent(stopPending)
            .addAction(new Notification.Action.Builder(null, "Stop", stopPending).build());
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return builder.build();
    }

    private void notifyUi() {
        final Runnable hook = listener;
        if (hook != null) main.post(hook);
    }

    private void toast(final String text) {
        main.post(() -> { try { Toast.makeText(getApplicationContext(), text, Toast.LENGTH_LONG).show(); } catch (Throwable ignored) {} });
    }

    private static int even(int v) { return Math.max(2, v - (v % 2)); }
}
