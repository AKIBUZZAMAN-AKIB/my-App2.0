package dev.nativekit.custom;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                // The user just allowed "Alarms & reminders": alarms scheduled
                // while it was off were inexact; re-arm them as exact now.
                || AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            new AlarmScheduler(context).restoreAll();
        }
    }
}
