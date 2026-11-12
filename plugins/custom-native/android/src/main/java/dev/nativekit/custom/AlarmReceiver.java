package dev.nativekit.custom;

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(service);
        else context.startService(service);

        context.sendBroadcast(new Intent(FIRED_BROADCAST).setPackage(context.getPackageName()).putExtra("alarmId", id));
        scheduler.onFired(id);
    }
}
