package dev.nativekit.isolatedbrowser;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Pure (Android-free) browser logic: omnibox resolution, search engines, translate, auto-delete. */
final class BrowserLogic {
    private BrowserLogic() {}

    /** id, display name, query template (%s = encoded query). */
    static final String[][] SEARCH_ENGINES = {
        {"google", "Google", "https://www.google.com/search?q=%s"},
        {"duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q=%s"},
        {"bing", "Bing", "https://www.bing.com/search?q=%s"},
        {"brave", "Brave Search", "https://search.brave.com/search?q=%s"},
        {"startpage", "Startpage", "https://www.startpage.com/do/search?q=%s"},
        {"yandex", "Yandex", "https://yandex.com/search/?text=%s"},
    };

    /** code, label — languages offered by "Translate page". */
    static final String[][] TRANSLATE_LANGUAGES = {
        {"bn", "Bangla (বাংলা)"}, {"en", "English"}, {"hi", "Hindi"}, {"ar", "Arabic"},
        {"ur", "Urdu"}, {"es", "Spanish"}, {"fr", "French"}, {"de", "German"},
        {"zh-CN", "Chinese (Simplified)"}, {"ja", "Japanese"}, {"ko", "Korean"},
        {"ru", "Russian"}, {"pt", "Portuguese"}, {"tr", "Turkish"}, {"id", "Indonesian"},
    };

    static final long DAY_MS = 24L * 60L * 60L * 1000L;

    static String[] engine(String id) {
        for (String[] engine : SEARCH_ENGINES) if (engine[0].equals(id)) return engine;
        return SEARCH_ENGINES[0];
    }

    static String searchUrl(String query, String engineId) {
        return String.format(Locale.ROOT, engine(engineId)[2], encode(query.trim()));
    }

    /** True when the text reads as an address rather than a search query. */
    static boolean looksLikeAddress(String raw) {
        if (raw == null) return false;
        String value = raw.trim();
        if (value.isEmpty() || value.contains(" ")) return false;
        String lower = value.toLowerCase(Locale.ROOT);
        if (lower.startsWith("https://") || lower.startsWith("http://")) return true;
        String host = value;
        int cut = indexOfAny(host, "/?#");
        if (cut >= 0) host = host.substring(0, cut);
        int colon = host.lastIndexOf(':');
        if (colon > 0) host = host.substring(0, colon);
        if (!host.contains(".") || host.startsWith(".") || host.endsWith(".")) return false;
        String tld = host.substring(host.lastIndexOf('.') + 1);
        if (tld.matches("[0-9]+")) return host.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}");
        return tld.length() >= 2 && tld.matches("[A-Za-z][A-Za-z0-9-]*");
    }

    /** Omnibox: an https URL for an address (http is upgraded), otherwise a search URL. */
    static String resolveInput(String raw, String engineId) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        if (looksLikeAddress(value)) {
            String lower = value.toLowerCase(Locale.ROOT);
            if (lower.startsWith("http://")) return "https://" + value.substring(7);
            if (lower.startsWith("https://")) return value;
            return "https://" + value;
        }
        return searchUrl(value, engineId);
    }

    static String translateUrl(String pageUrl, String lang) {
        return "https://translate.google.com/translate?sl=auto&tl=" + encode(lang) + "&hl=" + encode(lang) + "&u=" + encode(pageUrl);
    }

    static boolean isTranslatedHost(String host) {
        return host != null && (host.endsWith(".translate.goog") || host.equals("translate.google.com"));
    }

    /** Auto-delete: true when something last used at lastActive is older than the retention window. */
    static boolean isExpired(long lastActive, long now, int days) {
        return days > 0 && lastActive > 0 && now - lastActive > days * DAY_MS;
    }

    static String host(String url) {
        try {
            String host = new URI(url).getHost();
            return host == null ? "" : host.toLowerCase(Locale.ROOT);
        } catch (Exception ignored) { return ""; }
    }

    static String displayHost(String url) {
        String host = host(url);
        return host.startsWith("www.") ? host.substring(4) : host;
    }

    /** If url is a results page of a known engine, the query it searched for, else null. */
    static String searchQueryOf(String url) {
        try {
            URI uri = new URI(url);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            String key = host.contains("yandex.") ? "text" : "q";
            boolean engine = host.contains("google.") || host.contains("duckduckgo.") || host.contains("bing.")
                || host.contains("search.brave.") || host.contains("startpage.") || host.contains("yandex.");
            if (!engine || uri.getRawQuery() == null) return null;
            for (String part : uri.getRawQuery().split("&")) {
                int eq = part.indexOf('=');
                if (eq > 0 && part.substring(0, eq).equals(key)) {
                    String q = URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8.name());
                    return q.isEmpty() ? null : q;
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    static String prettyUrl(String url) {
        if (url == null) return "";
        String query = searchQueryOf(url);
        if (query != null) return query;
        try {
            URI uri = new URI(url);
            String host = uri.getHost() == null ? url : uri.getHost();
            host = host.startsWith("www.") ? host.substring(4) : host;
            String path = uri.getRawPath();
            if (path == null || path.isEmpty() || "/".equals(path)) return host;
            String shown = host + path;
            return shown.length() > 64 ? shown.substring(0, 63) + "\u2026" : shown;
        } catch (Exception ignored) { return url; }
    }

    private static final Set<String> SECOND_LEVEL_SUFFIXES = new HashSet<>(Arrays.asList(
        "com", "net", "org", "gov", "edu", "co", "ac", "or", "ne", "gv", "info", "biz", "name", "web"));

    /** Common second-level suffixes where the registrable domain is 3 labels (com.bd, co.uk, ...). */
    static String registrableSite(String host) {
        if (host == null) return null;
        String[] labels = host.toLowerCase(Locale.ROOT).split("\\.");
        if (labels.length <= 2) return host;
        String middle = labels[labels.length - 2];
        if (SECOND_LEVEL_SUFFIXES.contains(middle)) {
            return labels[labels.length - 3] + "." + middle + "." + labels[labels.length - 1];
        }
        return middle + "." + labels[labels.length - 1];
    }

    /** Desktop-site UA built from the device's Chrome version. */
    static String desktopUserAgent(String mobileUa) {
        String version = "131.0.0.0";
        if (mobileUa != null) {
            int at = mobileUa.indexOf("Chrome/");
            if (at >= 0) {
                int end = mobileUa.indexOf(' ', at);
                version = mobileUa.substring(at + 7, end < 0 ? mobileUa.length() : end);
            }
        }
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + version + " Safari/537.36";
    }

    static String encode(String value) {
        try { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
        catch (Exception error) { return value; }
    }

    private static int indexOfAny(String value, String chars) {
        int best = -1;
        for (char c : chars.toCharArray()) {
            int at = value.indexOf(c);
            if (at >= 0 && (best < 0 || at < best)) best = at;
        }
        return best;
    }
}
