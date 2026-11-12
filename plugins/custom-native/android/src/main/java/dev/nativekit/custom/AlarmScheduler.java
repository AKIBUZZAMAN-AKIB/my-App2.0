package dev.nativekit.custom;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

final class AlarmScheduler {
    private static final String PREFS = "nativekit_alarm_store";
    private static final String KEY = "alarms";
    private final Context context;
    private final AlarmManager alarmManager;

    AlarmScheduler(Context context) {
        this.context = context.getApplicationContext();
        this.alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    }

    boolean canScheduleExact() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms();
    }

    JSONObject schedule(JSONObject alarm, boolean persist) throws Exception {
        String id = alarm.getString("id");
        long at = alarm.getLong("scheduledAt");
        if (at <= System.currentTimeMillis()) throw new IllegalArgumentException("Alarm time must be in the future");
        boolean exact = canScheduleExact();
        PendingIntent fire = fireIntent(id);
        if (exact) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
            else alarmManager.setExact(AlarmManager.RTC_WAKEUP, at, fire);
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
            else alarmManager.set(AlarmManager.RTC_WAKEUP, at, fire);
        }
        alarm.put("exact", exact);
        alarm.put("platformMode", exact ? "exact-and-allow-while-idle" : "inexact-fallback");
        if (persist) put(alarm);
        return alarm;
    }

    void cancel(String id) {
        alarmManager.cancel(fireIntent(id));
        remove(id);
    }

    void onFired(String id) {
        JSONObject alarm = get(id);
        if (alarm == null) return;
        long interval = alarm.optLong("repeatIntervalMinutes", 0L);
        if (interval > 0) {
            try {
                long next = Math.max(System.currentTimeMillis() + 1000L, alarm.getLong("scheduledAt") + interval * 60_000L);
                while (next <= System.currentTimeMillis()) next += interval * 60_000L;
                alarm.put("scheduledAt", next);
                schedule(alarm, true);
            } catch (Exception ignored) {}
        } else {
            remove(id);
        }
    }

    void restoreAll() {
        long now = System.currentTimeMillis();
        for (JSONObject alarm : list()) {
            try {
                long at = alarm.getLong("scheduledAt");
                long repeat = alarm.optLong("repeatIntervalMinutes", 0L);
                if (at <= now && repeat > 0) {
                    while (at <= now) at += repeat * 60_000L;
                    alarm.put("scheduledAt", at);
                }
                if (at > now) schedule(alarm, true); else remove(alarm.getString("id"));
            } catch (Exception ignored) {}
        }
    }

    List<JSONObject> list() {
        List<JSONObject> result = new ArrayList<>();
        JSONObject root = readRoot();
        Iterator<String> keys = root.keys();
        while (keys.hasNext()) {
            JSONObject value = root.optJSONObject(keys.next());
            if (value != null) result.add(value);
        }
        return result;
    }

    JSONArray listJson() {
        JSONArray result = new JSONArray();
        for (JSONObject alarm : list()) result.put(alarm);
        return result;
    }

    JSONObject get(String id) {
        return readRoot().optJSONObject(id);
    }

    private void put(JSONObject alarm) throws Exception {
        JSONObject root = readRoot();
        root.put(alarm.getString("id"), alarm);
        writeRoot(root);
    }

    private void remove(String id) {
        JSONObject root = readRoot();
        root.remove(id);
        writeRoot(root);
    }

    private JSONObject readRoot() {
        String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "{}");
        try { return new JSONObject(raw); } catch (Exception ignored) { return new JSONObject(); }
    }

    private void writeRoot(JSONObject root) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, root.toString()).apply();
    }

    private PendingIntent fireIntent(String id) {
        Intent intent = new Intent(context, AlarmReceiver.class).setAction("dev.nativekit.ALARM_FIRE").putExtra("alarmId", id);
        return PendingIntent.getBroadcast(context, requestCode(id, 17), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static int requestCode(String id, int salt) {
        return (id + ":" + salt).hashCode() & 0x7fffffff;
    }
}
