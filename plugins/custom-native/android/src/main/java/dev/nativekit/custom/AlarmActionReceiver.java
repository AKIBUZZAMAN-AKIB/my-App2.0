package dev.nativekit.custom;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class AlarmActionReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        Intent service = new Intent(context, AlarmService.class).setAction(AlarmService.ACTION_STOP).putExtra("alarmId", intent.getStringExtra("alarmId"));
        context.startService(service);
    }
}
