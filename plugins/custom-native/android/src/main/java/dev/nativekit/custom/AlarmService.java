package dev.nativekit.custom;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import androidx.annotation.Nullable;

public class AlarmService extends Service {
    public static final String ACTION_START = "dev.nativekit.ALARM_START";
    public static final String ACTION_STOP = "dev.nativekit.ALARM_STOP";
    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private String activeId;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopRinging();
            return START_NOT_STICKY;
        }
        activeId = intent.getStringExtra("alarmId");
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        boolean fullScreen = intent.getBooleanExtra("fullScreen", false);
        Notification notification = createNotification(title == null ? "Alarm" : title, body == null ? "" : body, fullScreen);
        if (Build.VERSION.SDK_INT >= 29) startForeground(AlarmScheduler.requestCode(activeId, 41), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(AlarmScheduler.requestCode(activeId, 41), notification);
        beginRinging();
        return START_NOT_STICKY;
    }

    private Notification createNotification(String title, String body, boolean fullScreen) {
        Intent stop = new Intent(this, AlarmActionReceiver.class).setAction(ACTION_STOP).putExtra("alarmId", activeId);
        PendingIntent stopPending = PendingIntent.getBroadcast(this, AlarmScheduler.requestCode(activeId, 23), stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent launch = new Intent(this, AlarmActivity.class).putExtra("alarmId", activeId).putExtra("title", title).putExtra("body", body)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent launchPending = PendingIntent.getActivity(this, AlarmScheduler.requestCode(activeId, 31), launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, NativeConfig.alarmChannel(this))
            : new Notification.Builder(this);
        builder.setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(launchPending)
            .addAction(new Notification.Action.Builder(null, getString(R.string.nativekit_alarm_stop), stopPending).build());
        if (fullScreen && canUseFullScreen()) builder.setFullScreenIntent(launchPending, true);
        return builder.build();
    }

    private boolean canUseFullScreen() {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        return manager.canUseFullScreenIntent();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(NativeConfig.alarmChannel(this), getString(R.string.nativekit_alarm_channel_name), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("User scheduled alarms");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 700, 350, 700});
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setSound(null, null); // MediaPlayer owns looping alarm audio.
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void beginRinging() {
        try {
            PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NativeKit:Alarm");
            wakeLock.acquire(10 * 60_000L);
        } catch (Exception ignored) {}
        try {
            Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            player.setDataSource(this, sound);
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception ignored) {}
        try {
            vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            long[] pattern = {0, 700, 350, 700};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            else vibrator.vibrate(pattern, 0);
        } catch (Exception ignored) {}
    }

    private void stopRinging() {
        if (player != null) { try { player.stop(); } catch (Exception ignored) {} player.release(); player = null; }
        if (vibrator != null) vibrator.cancel();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() { stopRinging(); super.onDestroy(); }
    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
