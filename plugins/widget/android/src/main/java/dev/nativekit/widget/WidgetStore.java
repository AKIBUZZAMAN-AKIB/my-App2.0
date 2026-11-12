package dev.nativekit.widget;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Iterator;

/**
 * SharedPreferences-backed JSON store for widget specs. Each home-screen widget kind
 * (and the floating widget) keeps a single JSON config that the AppWidgetProvider, the
 * floating overlay and the web bridge all read/write. SharedPreferences is the storage
 * Android's RemoteViews/widget process can read synchronously, unlike Filesystem.
 */
final class WidgetStore {
    private static final String PREFS = "nativekit_widget_store";
    private static final String KEY = "kinds";
    private final Context context;

    WidgetStore(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized void setConfig(String kind, JSONObject config) {
        JSONObject root = readRoot();
        try {
            root.put(kind, config);
        } catch (JSONException error) {
            throw new IllegalStateException("Could not persist widget config for '" + kind + "'", error);
        }
        writeRoot(root);
    }

    JSONObject getConfig(String kind) {
        return readRoot().optJSONObject(kind);
    }

    /** Returns every configured kind -> config as a JSON object. */
    JSONObject listConfigs() {
        return readRoot();
    }

    synchronized void removeConfig(String kind) {
        JSONObject root = readRoot();
        root.remove(kind);
        writeRoot(root);
    }

    private JSONObject readRoot() {
        String raw = prefs().getString(KEY, "{}");
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private void writeRoot(JSONObject root) {
        prefs().edit().putString(KEY, root.toString()).apply();
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String string(JSONObject object, String key, String fallback) {
        String value = object.optString(key, null);
        return value == null ? fallback : value;
    }

    /**
     * Shorthand accessors so the renderer doesn't need to know about the store:
     * returns the stored config for kind, or an empty object when missing.
     */
    static JSONObject readConfig(Context context, String kind) {
        JSONObject config = new WidgetStore(context).getConfig(kind);
        return config == null ? new JSONObject() : config;
    }

    /** Parse a hex "#RRGGBB"/"#AARRGGBB" color without throwing; falls back on bad input. */
    static int color(JSONObject object, String key, int fallback) {
        String raw = string(object, key, null);
        if (raw == null) return fallback;
        try {
            return android.graphics.Color.parseColor(raw);
        } catch (Exception ignored) {
            return fallback;
        }
    }

    /** Best-effort extra JSON (used by the floating HTML renderer / native bubble). */
    static JSONObject extra(JSONObject config) {
        return config.optJSONObject("extra") == null ? new JSONObject() : config.optJSONObject("extra");
    }

    static Iterator<String> keys(JSONObject object) {
        return object.keys();
    }
}
