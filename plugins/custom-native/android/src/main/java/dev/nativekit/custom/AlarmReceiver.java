package dev.nativekit.custom;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import org.json.JSONObject;

public class AlarmReceiver extends BroadcastReceiver {
    static final String FIRED_BROADCAST = "dev.nativekit.custom.ALARM_FIRED";

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("alarmId");
        if (id == null) return;
        AlarmScheduler scheduler = new AlarmScheduler(context);
        JSONObject alarm = scheduler.get(id);
        if (alarm == null) return;

        Intent service = new Intent(context, AlarmService.class)
            .setAction(AlarmService.ACTION_START)
            .putExtra("alarmId", id)
            .putExtra("title", alarm.optString("title", "Alarm"))
            .putExtra("body", alarm.optString("body", ""))
            .putExtra("fullScreen", alarm.optBoolean("fullScreen", false));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(service);
            else context.startService(service);
        } catch (RuntimeException error) {
            // Android 12+ refuses a foreground-service start from the background
            // when the alarm was not exact (the user has not allowed "Alarms &
            // reminders"): ForegroundServiceStartNotAllowedException. Without this
            // catch the receiver crashed, nothing rang and a repeating alarm was
            // never rescheduled. Post a high-priority alarm notification instead.
            postFallbackNotification(context, id, alarm);
        }

        context.sendBroadcast(new Intent(FIRED_BROADCAST).setPackage(context.getPackageName()).putExtra("alarmId", id));
        scheduler.onFired(id);
    }

    private static void postFallbackNotification(Context context, String id, JSONObject alarm) {
        try {
            AlarmService.ensureChannel(context);
            String title = alarm.optString("title", "Alarm");
            String body = alarm.optString("body", "");
            Intent launch = new Intent(context, AlarmActivity.class).putExtra("alarmId", id).putExtra("title", title).putExtra("body", body)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent launchPending = PendingIntent.getActivity(context, AlarmScheduler.requestCode(id, 31), launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, NativeConfig.alarmChannel(context))
                : new Notification.Builder(context);
            builder.setSmallIcon(context.getApplicationInfo().icon)
                .setContentTitle(title)
                .setContentText(body)
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(launchPending);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                builder.setPriority(Notification.PRIORITY_MAX).setDefaults(Notification.DEFAULT_ALL);
            }
            if (alarm.optBoolean("fullScreen", false)) builder.setFullScreenIntent(launchPending, true);
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(AlarmScheduler.requestCode(id, 41), builder.build());
        } catch (RuntimeException ignored) {
            // Notifications blocked: nothing more a receiver can do.
        }
    }
}
