package dev.nativekit.custom;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;

final class NativeConfig {
    static final String ALARM_CHANNEL_KEY = "dev.nativekit.ALARM_CHANNEL_ID";
    static final String LOCATION_CHANNEL_KEY = "dev.nativekit.LOCATION_CHANNEL_ID";

    private NativeConfig() {}

    static String metadata(Context context, String key, String fallback) {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA);
            Bundle data = info.metaData;
            return data == null ? fallback : data.getString(key, fallback);
        } catch (Exception ignored) {
            return fallback;
        }
    }

    static String alarmChannel(Context context) { return metadata(context, ALARM_CHANNEL_KEY, "nativekit_alarms"); }
    static String locationChannel(Context context) { return metadata(context, LOCATION_CHANNEL_KEY, "nativekit_location"); }
}
