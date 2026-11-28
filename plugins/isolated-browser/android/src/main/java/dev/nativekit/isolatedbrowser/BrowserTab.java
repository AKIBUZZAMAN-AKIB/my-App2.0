package dev.nativekit.isolatedbrowser;

import android.graphics.Bitmap;
import android.webkit.WebView;

import java.util.UUID;

/** One browser tab of the remote browser: its WebView (created lazily) and its state. */
final class BrowserTab {
    final String id = UUID.randomUUID().toString();
    final boolean incognito;
    WebView view;
    PageAgentHost agent;
    String url;
    String title = "";
    String groupId;
    String parentId;
    String mobileUa;
    long lastActive = System.currentTimeMillis();
    boolean desktop;
    boolean devtools;
    boolean loading;
    boolean revealed;
    Bitmap thumb;

    BrowserTab(String url, boolean incognito) {
        this.url = url;
        this.incognito = incognito;
    }

    String label() {
        if (title != null && !title.trim().isEmpty()) return title.trim();
        if (url == null) return incognito ? "Incognito tab" : "New tab";
        return BrowserLogic.prettyUrl(url);
    }
}
