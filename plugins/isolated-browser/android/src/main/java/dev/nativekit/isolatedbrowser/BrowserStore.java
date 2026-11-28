package dev.nativekit.isolatedbrowser;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/**
 * Persistent browser state for the isolated remote browser: bookmarks, history,
 * tab groups, the saved tab session and user settings. Lives in the isolated
 * process's own SharedPreferences — nothing here is shared with the host app.
 */
final class BrowserStore {
    static final class Entry {
        final String url;
        final String title;
        final long time;
        Entry(String url, String title, long time) { this.url = url; this.title = title == null ? "" : title; this.time = time; }
    }

    static final class Group {
        final String id;
        String name;
        int color;
        Group(String id, String name, int color) { this.id = id; this.name = name; this.color = color; }
    }

    static final class SavedTab {
        final String url;
        final String title;
        final String groupId;
        final long lastActive;
        SavedTab(String url, String title, String groupId, long lastActive) {
            this.url = url; this.title = title; this.groupId = groupId; this.lastActive = lastActive;
        }
    }

    static final int[] GROUP_COLORS = {
        0xFF3B82F6, 0xFFEF4444, 0xFF22C55E, 0xFFF59E0B, 0xFFA855F7, 0xFFEC4899, 0xFF14B8A6, 0xFF64748B,
    };

    private static final String PREFS = "nativekit_browser_v1";
    private static final int HISTORY_LIMIT = 600;
    private final SharedPreferences prefs;

    BrowserStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------- settings ----------
    String searchEngine() { return prefs.getString("searchEngine", "google"); }
    void setSearchEngine(String id) { prefs.edit().putString("searchEngine", id).apply(); }
    int autoCloseTabsDays() { return prefs.getInt("autoCloseTabsDays", 7); }
    void setAutoCloseTabsDays(int days) { prefs.edit().putInt("autoCloseTabsDays", days).apply(); }
    int historyDays() { return prefs.getInt("historyDays", 30); }
    void setHistoryDays(int days) { prefs.edit().putInt("historyDays", days).apply(); }
    boolean clearOnExit() { return prefs.getBoolean("clearOnExit", false); }
    void setClearOnExit(boolean on) { prefs.edit().putBoolean("clearOnExit", on).apply(); }
    boolean restoreTabs() { return prefs.getBoolean("restoreTabs", true); }
    void setRestoreTabs(boolean on) { prefs.edit().putBoolean("restoreTabs", on).apply(); }
    boolean askCrossSite() { return prefs.getBoolean("askCrossSite", false); }
    void setAskCrossSite(boolean on) { prefs.edit().putBoolean("askCrossSite", on).apply(); }
    boolean blockPopups() { return prefs.getBoolean("blockPopups", true); }
    void setBlockPopups(boolean on) { prefs.edit().putBoolean("blockPopups", on).apply(); }
    boolean darkPages() { return prefs.getBoolean("darkPages", true); }
    void setDarkPages(boolean on) { prefs.edit().putBoolean("darkPages", on).apply(); }
    /** Home page for new tabs and the home action; empty = ask for an address. */
    String homePage() { return prefs.getString("homePage", ""); }
    void setHomePage(String url) { prefs.edit().putString("homePage", url == null ? "" : url).apply(); }
    int textZoom() { return prefs.getInt("textZoom", 100); }
    void setTextZoom(int percent) { prefs.edit().putInt("textZoom", percent).apply(); }
    String translateLanguage() {
        String fallback = Locale.getDefault().getLanguage();
        return prefs.getString("translateLanguage", fallback == null || fallback.isEmpty() ? "en" : fallback);
    }
    void setTranslateLanguage(String code) { prefs.edit().putString("translateLanguage", code).apply(); }

    // ---------- bookmarks ----------
    List<Entry> bookmarks() { return readEntries("bookmarks"); }
    boolean isBookmarked(String url) {
        if (url == null) return false;
        for (Entry entry : bookmarks()) if (entry.url.equals(url)) return true;
        return false;
    }
    /** Toggles; returns true when the page is now bookmarked. */
    boolean toggleBookmark(String url, String title) {
        List<Entry> list = bookmarks();
        for (Iterator<Entry> it = list.iterator(); it.hasNext();) {
            if (it.next().url.equals(url)) { it.remove(); writeEntries("bookmarks", list); return false; }
        }
        list.add(0, new Entry(url, title, System.currentTimeMillis()));
        writeEntries("bookmarks", list);
        return true;
    }
    void removeBookmark(String url) {
        List<Entry> list = bookmarks();
        for (Iterator<Entry> it = list.iterator(); it.hasNext();) if (it.next().url.equals(url)) it.remove();
        writeEntries("bookmarks", list);
    }

    // ---------- history ----------
    List<Entry> history() { return readEntries("history"); }
    void addHistory(String url, String title) {
        if (url == null || !url.startsWith("https://")) return;
        List<Entry> list = history();
        long now = System.currentTimeMillis();
        if (!list.isEmpty() && list.get(0).url.equals(url)) {
            list.set(0, new Entry(url, title == null || title.isEmpty() ? list.get(0).title : title, now));
        } else {
            list.add(0, new Entry(url, title, now));
        }
        while (list.size() > HISTORY_LIMIT) list.remove(list.size() - 1);
        writeEntries("history", list);
    }
    void updateHistoryTitle(String url, String title) {
        if (url == null || title == null || title.isEmpty()) return;
        List<Entry> list = history();
        if (!list.isEmpty() && list.get(0).url.equals(url) && !title.equals(list.get(0).title)) {
            list.set(0, new Entry(url, title, list.get(0).time));
            writeEntries("history", list);
        }
    }
    void removeHistory(String url) {
        List<Entry> list = history();
        for (Iterator<Entry> it = list.iterator(); it.hasNext();) if (it.next().url.equals(url)) it.remove();
        writeEntries("history", list);
    }
    void clearHistory() { prefs.edit().remove("history").apply(); }
    /** Auto-delete: drops history older than the retention window. Returns how many were removed. */
    int pruneHistory(long now) {
        int days = historyDays();
        if (days <= 0) return 0;
        List<Entry> list = history();
        int before = list.size();
        for (Iterator<Entry> it = list.iterator(); it.hasNext();) if (BrowserLogic.isExpired(it.next().time, now, days)) it.remove();
        if (list.size() != before) writeEntries("history", list);
        return before - list.size();
    }

    // ---------- tab groups ----------
    List<Group> groups() {
        List<Group> out = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString("groups", "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject o = array.getJSONObject(i);
                out.add(new Group(o.getString("id"), o.optString("name", "Group"), o.optInt("color", GROUP_COLORS[0])));
            }
        } catch (Exception ignored) { }
        return out;
    }
    void saveGroups(List<Group> groups) {
        JSONArray array = new JSONArray();
        try {
            for (Group g : groups) array.put(new JSONObject().put("id", g.id).put("name", g.name).put("color", g.color));
        } catch (Exception ignored) { }
        prefs.edit().putString("groups", array.toString()).apply();
    }

    // ---------- tab session ----------
    List<SavedTab> savedTabs() {
        List<SavedTab> out = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString("session", "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject o = array.getJSONObject(i);
                String url = o.optString("url", "");
                out.add(new SavedTab(url.isEmpty() ? null : url, o.optString("title", ""),
                    o.optString("group", "").isEmpty() ? null : o.optString("group"), o.optLong("lastActive", 0)));
            }
        } catch (Exception ignored) { }
        return out;
    }
    void saveTabs(List<SavedTab> tabs) {
        JSONArray array = new JSONArray();
        try {
            for (SavedTab t : tabs) {
                array.put(new JSONObject().put("url", t.url == null ? "" : t.url).put("title", t.title == null ? "" : t.title)
                    .put("group", t.groupId == null ? "" : t.groupId).put("lastActive", t.lastActive));
            }
        } catch (Exception ignored) { }
        prefs.edit().putString("session", array.toString()).apply();
    }

    // ---------- helpers ----------
    private List<Entry> readEntries(String key) {
        List<Entry> out = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString(key, "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject o = array.getJSONObject(i);
                out.add(new Entry(o.getString("url"), o.optString("title", ""), o.optLong("time", 0)));
            }
        } catch (Exception ignored) { }
        return out;
    }

    private void writeEntries(String key, List<Entry> entries) {
        JSONArray array = new JSONArray();
        try {
            for (Entry e : entries) array.put(new JSONObject().put("url", e.url).put("title", e.title).put("time", e.time));
        } catch (Exception ignored) { }
        prefs.edit().putString(key, array.toString()).apply();
    }
}
