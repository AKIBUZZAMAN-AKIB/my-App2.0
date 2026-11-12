package dev.nativekit.custom;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class LocationActionReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        context.startService(new Intent(context, LocationTrackingService.class).setAction(LocationTrackingService.ACTION_STOP));
    }
}
