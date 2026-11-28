package dev.nativekit.isolatedbrowser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.os.Bundle;
import android.os.ResultReceiver;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.text.Editable;
import android.text.TextWatcher;
import android.widget.Toast;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Browser-only HTTPS surface. It intentionally has no NativeKit script, message listener, or broker binding. */
public final class RemoteBrowserActivity extends Activity {
    static final String EXTRA_SESSION_ID = "sessionId";
    static final String EXTRA_URL = "url";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_ALLOWED_HOSTS = "allowedHosts";
    static final String EXTRA_RESULT = "result";
    static final String ACTION_CLOSE = "dev.nativekit.isolatedbrowser.CLOSE_REMOTE";

    private static final Pattern HOST_RULE = Pattern.compile("^(?:\\*\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::(?:[1-9][0-9]{0,4}))?$");
    private String sessionId;
    private ResultReceiver resultReceiver;
    private WebView webView;
    private FrameLayout content;
    // Browser chrome (address, history buttons, agent toggle).
    private TextView address;
    private Button backButton;
    private Button forwardButton;
    private boolean agentEnabled = true;
    private Button agentButton;
    private Button menuButton;
    // Browser features: bookmarks / history / settings (isolated-process prefs).
    private BrowserStore store;
    private String mobileUa;
    // Tabs: every tab owns its WebView (created lazily for restored tabs);
    // `webView` / `pageAgent` always point at the current tab's.
    private final List<BrowserTab> tabs = new ArrayList<>();
    private BrowserTab current;
    private Button tabsButton;
    private static final String PROFILE_NORMAL = "nativekit_remote_url_v1";
    private static final String PROFILE_INCOGNITO = "nativekit_remote_incognito_v1";
    private static final int MAX_RESTORED_TABS = 40;
    // Find-in-page bar (shown under the toolbar while searching).
    private LinearLayout findBar;
    private EditText findInput;
    private TextView findCount;
    // PageAgent host (null when disabled/unsupported): injects the vendored
    // in-page agent and relays its LLM calls through the free route.
    private PageAgentHost pageAgent;
    // Loading cover until the first committed frame + a slim network progress bar
    // (remote pages load over the network — the user must see it is progressing).
    private FrameLayout cover;
    private ProgressBar progress;
    private TextView shellTitle;
    private boolean shellBuilt;
    private boolean revealed;
    // Mutable: user-approved cross-site navigations extend it at runtime.
    private final Set<String> allowedHosts = new HashSet<>();
    private boolean reported;
    // Error visibility: a browsing surface must never dead-end on a silent
    // blank page. Every failure mode below ends in something the user can SEE
    // (and act on) instead of the old eternal loading cover.
    private String lastUrl;
    private Runnable loadTimeout;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private static final long LOAD_TIMEOUT_MS = 25_000L;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT < 28) { finish(); return; }
        try { WebView.setDataDirectorySuffix("nativekit-isolated-v1"); }
        catch (IllegalStateException ignored) { /* Shared only with this app's isolated-process browser surfaces. */ }
        // A real session is taking over this process: hand the warm-up WebView's
        // memory back immediately (the expensive provider init already happened).
        IsolatedBrowserWarmupService.releaseForSession();
        store = new BrowserStore(this);
        theme = BrowserTheme.resolve(this, store);
        initialize(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ACTION_CLOSE.equals(intent.getAction()) && sessionId != null && sessionId.equals(intent.getStringExtra(EXTRA_SESSION_ID))) {
            finish();
            return;
        }
        report("closed", "replaced by another browser-only URL session");
        saveSession();
        destroyWebView();
        initialize(intent);
    }

    private void initialize(Intent intent) {
        try {
            sessionId = required(intent, EXTRA_SESSION_ID);
            agentEnabled = intent.getBooleanExtra(PageAgentHost.EXTRA_ENABLED, true);
            resultReceiver = intent.getParcelableExtra(EXTRA_RESULT);
            Uri start = validatedHttps(required(intent, EXTRA_URL));
            String[] configured = intent.getStringArrayExtra(EXTRA_ALLOWED_HOSTS);
            Set<String> rules = new HashSet<>();
            if (configured != null) for (String value : configured) rules.add(validateRule(value));
            if (rules.isEmpty()) {
                // No configured global allowlist: the initial URL's site is the
                // boundary — but a REAL site's first hop is almost always a
                // sibling host (www./m./consent./accounts.), which the old
                // exact-host rule blanked out. Allow the whole registrable
                // site so youtube.com -> consent.youtube.com and
                // linkedin.com -> www.linkedin.com actually load.
                rules.add(hostAndPort(start));
                String site = registrableSite(start.getHost());
                if (site != null) {
                    rules.add(site + ":443");
                    rules.add("*." + site + ":443");
                }
            }
            allowedHosts.addAll(rules);
            if (!isAllowed(start)) throw new IllegalArgumentException("Initial URL host is not allowed");
            buildShell(intent.getStringExtra(EXTRA_TITLE), start.getHost());
            startTabs(start.toString());
            report("opened", "");
        } catch (Exception error) {
            buildShell("Browser", "Browser");
            showFailure(error.getMessage() == null ? "Invalid HTTPS URL" : error.getMessage());
            report("failed", error.getMessage());
        }
    }

    /**
     * Browser chrome.
     *
     * The previous shell was two oversized Buttons called "Back" and "Close"
     * plus a title: no address, no forward, no reload — a remote WebView with no
     * visible browser around it. This is a real toolbar (back / forward / reload
     * / address pill / close) on a dark surface that matches the rest of the app.
     *
     * The page agent is deliberately NOT controlled from here: this surface must
     * never expose a page-to-native channel to untrusted sites, so the agent
     * panel owns its own edge handle and collapse button inside the page.
     */
    private void buildShell(String configuredTitle, String fallbackTitle) {
        String title = configuredTitle == null || configuredTitle.trim().isEmpty() ? fallbackTitle : configuredTitle.trim();
        if (shellBuilt) {
            // Session swap (onNewIntent): reuse the shell — no setContentView flash.
            if (shellTitle != null) shellTitle.setText(title);
            syncChrome();
            return;
        }
        shellTitleText = title;
        theme = BrowserTheme.resolve(this, store);
        applySystemBars();
        boolean bottom = store != null && "bottom".equals(store.toolbarPosition());
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(theme.ground);
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setBackgroundColor(theme.chrome);
        toolbar.setPadding(dp(6), dp(6), dp(6), dp(6));
        toolbar.setElevation(dp(2));

        backButton = chromeButton("\u2190", "Back", view -> goBack());
        toolbar.addView(backButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        forwardButton = chromeButton("\u2192", "Forward", view -> { if (webView != null && webView.canGoForward()) webView.goForward(); });
        toolbar.addView(forwardButton, new LinearLayout.LayoutParams(dp(40), dp(40)));

        address = new TextView(this);
        address.setText(title);
        address.setTextColor(theme.text);
        address.setTextSize(14);
        address.setSingleLine(true);
        address.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        address.setGravity(Gravity.CENTER_VERTICAL);
        address.setPadding(dp(14), 0, dp(14), 0);
        address.setBackground(rounded(theme.surface, dp(20), 0));
        address.setCompoundDrawablePadding(dp(6));
        address.setOnClickListener(view -> promptForAddress(false, false));
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(0, dp(40), 1);
        addressParams.setMargins(dp(4), 0, dp(4), 0);
        toolbar.addView(address, addressParams);

        // AI agent: one-way native -> page toggle of the docked agent panel.
        agentButton = chromeButton("\u2726", "AI page agent", view -> toggleAgent());
        agentButton.setTextColor(theme.accent);
        agentButton.setTextSize(18);
        toolbar.addView(agentButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        tabsButton = chromeButton("1", "Tabs", view -> showTabSwitcher());
        tabsButton.setTextSize(12);
        tabsButton.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        tabsButton.setBackground(rounded(0, dp(7), theme.text));
        tabsButton.setOnLongClickListener(view -> { openNewTab(false); return true; });
        LinearLayout.LayoutParams tabsParams = new LinearLayout.LayoutParams(dp(26), dp(26));
        tabsParams.setMargins(dp(8), 0, dp(6), 0);
        toolbar.addView(tabsButton, tabsParams);
        menuButton = chromeButton("\u22ee", "More options", view -> showOverflowMenu());
        menuButton.setTextSize(20);
        toolbar.addView(menuButton, new LinearLayout.LayoutParams(dp(36), dp(40)));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgress(0);
        try {
            progress.setProgressTintList(android.content.res.ColorStateList.valueOf(theme.accent));
            progress.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(theme.chrome));
        } catch (Throwable ignored) {}
        findBar = buildFindBar();
        findBar.setVisibility(View.GONE);
        content = new FrameLayout(this);
        content.setBackgroundColor(theme.ground);
        LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        if (bottom) {
            // Bottom toolbar: thumb reach on tall phones (Safari / Samsung Internet style).
            root.addView(findBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
            root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));
            root.addView(toolbar, barParams);
        } else {
            root.addView(toolbar, barParams);
            root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));
            root.addView(findBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        }
        setContentView(root);
        shellBuilt = true;
        ImeInsetsHelper.apply(root);
        syncChrome();
        updateTabBadge();
    }

    /** Resolved appearance (Light / Dark / System + accent + backdrop). */
    private BrowserTheme theme;
    private String shellTitleText = "Browser";

    /**
     * Re-paints the whole shell after an appearance change without losing a
     * single tab: the tab WebViews are detached, the shell is rebuilt with the
     * new colours / toolbar position, and the current tab is re-attached.
     */
    private void rebuildShell() {
        if (content != null) content.removeAllViews();
        for (BrowserTab tab : tabs) {
            if (tab.view != null && tab.view.getParent() instanceof ViewGroup) ((ViewGroup) tab.view.getParent()).removeView(tab.view);
        }
        shellBuilt = false;
        buildShell(shellTitleText, shellTitleText);
        for (BrowserTab tab : tabs) {
            if (tab.view != null) tab.view.setBackgroundColor(theme.ground);
            if (tab.agent != null) tab.agent.setTheme(theme.dark, BrowserTheme.hex(theme.accent));
            if (tab.view != null) PageAgentHost.applyTheme(tab.view, theme.dark, BrowserTheme.hex(theme.accent));
        }
        if (current != null) { BrowserTab tab = current; current = null; showTab(tab, false); }
    }

    private void applySystemBars() {
        try {
            android.view.Window window = getWindow();
            window.setStatusBarColor(theme.chrome);
            window.setNavigationBarColor(theme.chrome);
            View decor = window.getDecorView();
            int flags = decor.getSystemUiVisibility();
            int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(theme.dark ? (flags & ~light) : (flags | light));
        } catch (Throwable ignored) {}
    }

    /** Themed AlertDialog builder: dialogs follow the browser's Light / Dark choice. */
    private android.app.AlertDialog.Builder dialogBuilder() {
        int style = theme != null && !theme.dark
            ? android.R.style.Theme_DeviceDefault_Light_Dialog_Alert
            : android.R.style.Theme_DeviceDefault_Dialog_Alert;
        return new android.app.AlertDialog.Builder(this, style);
    }

    /** Start-page / loading backdrop the user picked (plain ground or a soft gradient). */
    private android.graphics.drawable.Drawable backdrop() {
        if (theme.backdropTop == theme.ground && theme.backdropBottom == theme.ground) {
            return new android.graphics.drawable.ColorDrawable(theme.ground);
        }
        return new android.graphics.drawable.GradientDrawable(
            android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { theme.backdropTop, theme.backdropBottom });
    }

    /** Transparent button ground with a themed ripple. */
    private android.graphics.drawable.Drawable pressable(int radius) {
        android.graphics.drawable.GradientDrawable mask = rounded(Color.WHITE, radius, 0);
        return new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(BrowserTheme.alpha(theme.text, 40)), null, mask);
    }

    private Button chromeButton(String label, String description, View.OnClickListener onClick) {
        Button button = new Button(this);
        button.setText(label);
        button.setContentDescription(description);
        button.setTextColor(theme.text);
        button.setTextSize(16);
        button.setAllCaps(false);
        button.setPadding(0, 0, 0, 0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setBackground(pressable(dp(20)));
        button.setStateListAnimator(null);
        button.setOnClickListener(onClick);
        return button;
    }

    private android.graphics.drawable.GradientDrawable rounded(int color, int radius, int strokeColor) {
        android.graphics.drawable.GradientDrawable drawable = new android.graphics.drawable.GradientDrawable();
        drawable.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        if (strokeColor != 0) drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    /** Keeps the toolbar buttons honest: disabled when the action is impossible. */
    private void syncChrome() {
        updateRecIndicator();
        WebView view = webView;
        if (backButton != null) backButton.setEnabled(view != null && view.canGoBack());
        if (forwardButton != null) forwardButton.setEnabled(view != null && view.canGoForward());
        if (backButton != null) backButton.setAlpha(view != null && view.canGoBack() ? 1f : 0.4f);
        if (forwardButton != null) forwardButton.setAlpha(view != null && view.canGoForward() ? 1f : 0.4f);
        if (address != null) {
            String current = lastUrl;
            if (current != null && !current.isEmpty()) address.setText(prettyUrl(current));
        }
    }

    private static String prettyUrl(String url) {
        try {
            Uri uri = Uri.parse(url);
            String host = uri.getHost() == null ? url : uri.getHost();
            host = host.startsWith("www.") ? host.substring(4) : host;
            String path = uri.getEncodedPath();
            if (path == null || path.isEmpty() || "/".equals(path)) return host;
            String shown = host + path;
            return shown.length() > 64 ? shown.substring(0, 63) + "\u2026" : shown;
        } catch (Throwable ignored) { return url; }
    }

    private void goBack() {
        if (webView != null && webView.canGoBack()) { webView.goBack(); syncChrome(); }
        else if (tabs.size() > 1 && current != null) closeTab(current);
        else finish();
    }

    /** The address pill is a real address bar: type an https: page and go. */
    private void promptForAddress(final boolean newTab, final boolean incognito) {
        final android.widget.EditText input = new android.widget.EditText(this);
        input.setSingleLine(true);
        input.setText(newTab || lastUrl == null ? "" : lastUrl);
        input.setSelection(input.getText().length());
        input.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("Search or type a web address");
        FrameLayout wrapper = new FrameLayout(this);
        wrapper.setPadding(dp(20), dp(8), dp(20), 0);
        wrapper.addView(input, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialogBuilder()
            .setTitle(newTab ? (incognito ? "New incognito tab" : "New tab") : "Open address")
            .setView(wrapper)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Open", (dialog, which) -> {
                String typed = input.getText() == null ? "" : input.getText().toString().trim();
                if (typed.isEmpty()) return;
                // Omnibox: an address opens directly, anything else is a search.
                String raw = BrowserLogic.resolveInput(typed, store.searchEngine());
                if (raw == null) return;
                Uri target;
                try { target = validatedHttps(raw); }
                catch (Exception error) { Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); return; }
                // A typed address is an explicit user decision, so the host is
                // added to the boundary exactly like an approved cross-site hop.
                String host = target.getHost().toLowerCase(Locale.ROOT);
                allowedHosts.add(host + ":" + (target.getPort() < 0 ? 443 : target.getPort()));
                String site = registrableSite(host);
                if (site != null) { allowedHosts.add(site + ":443"); allowedHosts.add("*." + site + ":443"); }
                report("addressTyped", host);
                if (newTab || webView == null) openTab(target.toString(), incognito);
                else webView.loadUrl(target.toString());
            })
            .show();
    }

    // ======================= browser features (overflow menu) =======================

    private static final int MENU_FIND = 1;
    private static final int MENU_TRANSLATE = 2;
    private static final int MENU_SHARE = 3;
    private static final int MENU_RELOAD = 4;
    private static final int MENU_DESKTOP = 5;
    private static final int MENU_READER = 6;
    private static final int MENU_BOOKMARK = 7;
    private static final int MENU_BOOKMARKS = 8;
    private static final int MENU_HISTORY = 9;

    /** Handles the shared menu ids; true when handled. */
    private boolean onExtraMenuItem(int id) {
        switch (id) {
            case MENU_NEW_TAB: openNewTab(false); return true;
            case MENU_INCOGNITO: openNewTab(true); return true;
            case MENU_HOME: goHome(); return true;
            case MENU_ZOOM: showZoomDialog(); return true;
            case MENU_TABS: showTabSwitcher(); return true;
            case MENU_GROUPS: showGroupsDialog(); return true;
            case MENU_SETTINGS: showSettings(); return true;
            default: return false;
        }
    }

    // ======================= ⋮ menu: themed bottom sheet =======================
    // Replaces PopupMenu, which took the activity's DayNight theme (phone mode)
    // instead of the browser's Appearance choice and stayed white in Dark.

    private android.app.Dialog menuSheet;

    private android.graphics.drawable.Drawable icon(int res, int tint) {
        android.graphics.drawable.Drawable d = getDrawable(res);
        if (d == null) return null;
        d = d.mutate();
        d.setTint(tint);
        return d;
    }

    /** Bottom sheet frame: rounded top, grab handle, themed, scrolls when tall. */
    private android.app.Dialog sheet(View body) {
        final android.app.Dialog dialog = new android.app.Dialog(this, theme.dark
            ? android.R.style.Theme_DeviceDefault_Dialog_NoActionBar
            : android.R.style.Theme_DeviceDefault_Light_Dialog_NoActionBar);
        LinearLayout frame = new LinearLayout(this);
        frame.setOrientation(LinearLayout.VERTICAL);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(theme.chrome);
        float r = dp(24);
        bg.setCornerRadii(new float[] { r, r, r, r, 0, 0, 0, 0 });
        frame.setBackground(bg);
        frame.setPadding(dp(14), dp(8), dp(14), dp(14));
        View handle = new View(this);
        handle.setBackground(rounded(BrowserTheme.alpha(theme.muted, 90), dp(3), 0));
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(dp(36), dp(4));
        hp.gravity = Gravity.CENTER_HORIZONTAL;
        hp.setMargins(0, 0, 0, dp(10));
        frame.addView(handle, hp);
        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        scroll.addView(body, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        frame.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialog.setContentView(frame);
        dialog.setCanceledOnTouchOutside(true);
        android.view.Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
            int screen = getResources().getDisplayMetrics().widthPixels;
            window.setLayout(Math.min(screen, dp(560)), ViewGroup.LayoutParams.WRAP_CONTENT);
            window.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            window.setDimAmount(theme.dark ? 0.5f : 0.32f);
            window.setWindowAnimations(android.R.style.Animation_InputMethod);
            try { window.setNavigationBarColor(theme.chrome); } catch (Throwable ignored) {}
        }
        // Cap the height so a long menu scrolls instead of covering the status bar.
        final int max = Math.round(getResources().getDisplayMetrics().heightPixels * 0.86f);
        scroll.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            if (scroll.getHeight() > max) {
                ViewGroup.LayoutParams lp = scroll.getLayoutParams();
                lp.height = max - dp(40);
                scroll.setLayoutParams(lp);
            }
        });
        return dialog;
    }

    /** Rounded group of rows. */
    private LinearLayout sheetSection(LinearLayout body) {
        LinearLayout section = new LinearLayout(this);
        section.setOrientation(LinearLayout.VERTICAL);
        section.setBackground(rounded(theme.surface, dp(18), 0));
        section.setClipToOutline(true);
        section.setPadding(0, dp(4), 0, dp(4));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(10), 0, 0);
        body.addView(section, lp);
        return section;
    }

    /** One row: icon, label, then a trailing value or a switch. */
    private View sheetRow(LinearLayout section, final android.app.Dialog[] owner, int iconRes, String label,
                          String trailing, Boolean toggle, int tint, final Runnable action) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), 0, dp(14), 0);
        row.setBackground(pressable(0));
        row.setMinimumHeight(dp(50));
        android.widget.ImageView glyph = new android.widget.ImageView(this);
        glyph.setImageDrawable(icon(iconRes, tint == 0 ? theme.muted : tint));
        row.addView(glyph, new LinearLayout.LayoutParams(dp(21), dp(21)));
        TextView text = new TextView(this);
        text.setText(label);
        text.setTextSize(15);
        text.setTextColor(tint == 0 ? theme.text : tint);
        text.setSingleLine(true);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        tp.setMargins(dp(16), 0, dp(8), 0);
        row.addView(text, tp);
        if (toggle != null) {
            android.widget.Switch sw = new android.widget.Switch(this);
            sw.setChecked(toggle);
            sw.setClickable(false);
            sw.setFocusable(false);
            int[][] states = { { android.R.attr.state_checked }, {} };
            sw.setThumbTintList(new android.content.res.ColorStateList(states, new int[] { theme.accent, theme.dark ? theme.muted : Color.WHITE }));
            sw.setTrackTintList(new android.content.res.ColorStateList(states, new int[] { BrowserTheme.alpha(theme.accent, 110), BrowserTheme.alpha(theme.muted, 90) }));
            row.addView(sw);
        } else if (trailing != null) {
            TextView value = new TextView(this);
            value.setText(trailing);
            value.setTextSize(13);
            value.setTextColor(theme.muted);
            row.addView(value);
        }
        row.setContentDescription(label);
        row.setOnClickListener(v -> {
            if (owner[0] != null) owner[0].dismiss();
            if (action != null) handler.postDelayed(action, 120);
        });
        section.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)));
        return row;
    }

    /** Icon-only quick action (circle + tiny caption). */
    private void quickAction(LinearLayout bar, final android.app.Dialog[] owner, int iconRes, int tint, String label,
                             boolean enabled, boolean keepOpen, final Runnable action) {
        LinearLayout cell = new LinearLayout(this);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout circle = new FrameLayout(this);
        circle.setBackground(rounded(theme.surface, dp(24), 0));
        circle.setForeground(pressable(dp(24)));
        android.widget.ImageView glyph = new android.widget.ImageView(this);
        glyph.setImageDrawable(icon(iconRes, tint == 0 ? theme.text : tint));
        circle.addView(glyph, new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        cell.addView(circle, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView caption = new TextView(this);
        caption.setText(label);
        caption.setTextSize(11);
        caption.setTextColor(theme.muted);
        caption.setGravity(Gravity.CENTER);
        caption.setSingleLine(true);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cp.setMargins(0, dp(5), 0, 0);
        cell.addView(caption, cp);
        cell.setAlpha(enabled ? 1f : 0.35f);
        cell.setEnabled(enabled);
        circle.setContentDescription(label);
        circle.setOnClickListener(v -> {
            if (!enabled) return;
            if (!keepOpen && owner[0] != null) owner[0].dismiss();
            if (action != null) action.run();
        });
        bar.addView(cell, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
    }

    private void showOverflowMenu() {
        if (menuSheet != null && menuSheet.isShowing()) menuSheet.dismiss();
        final android.app.Dialog[] owner = new android.app.Dialog[1];
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);

        // Header: the page this menu acts on.
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(dp(6), 0, dp(6), dp(12));
        TextView pageTitle = new TextView(this);
        String t = current == null ? "" : current.label();
        pageTitle.setText(t.isEmpty() ? "New tab" : t);
        pageTitle.setTextSize(16);
        pageTitle.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        pageTitle.setTextColor(theme.text);
        pageTitle.setSingleLine(true);
        pageTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        header.addView(pageTitle);
        TextView pageHost = new TextView(this);
        pageHost.setText((current != null && current.incognito ? "Incognito \u00b7 " : "") + (lastUrl == null ? "" : prettyUrl(lastUrl)));
        pageHost.setTextSize(12);
        pageHost.setTextColor(theme.muted);
        pageHost.setSingleLine(true);
        pageHost.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        header.addView(pageHost);
        body.addView(header);

        // Quick actions — a button is enough for these.
        LinearLayout quick = new LinearLayout(this);
        quick.setPadding(0, 0, 0, dp(4));
        boolean canBack = webView != null && webView.canGoBack();
        boolean canForward = webView != null && webView.canGoForward();
        boolean marked = store != null && store.isBookmarked(lastUrl);
        quickAction(quick, owner, R.drawable.nk_ic_arrow_back, 0, "Back", canBack, false, () -> { if (webView != null && webView.canGoBack()) { webView.goBack(); syncChrome(); } });
        quickAction(quick, owner, R.drawable.nk_ic_arrow_forward, 0, "Forward", canForward, false, () -> { if (webView != null && webView.canGoForward()) webView.goForward(); });
        quickAction(quick, owner, R.drawable.nk_ic_refresh, 0, "Reload", webView != null, false, () -> { if (webView != null) webView.reload(); });
        quickAction(quick, owner, marked ? R.drawable.nk_ic_star_filled : R.drawable.nk_ic_star, marked ? theme.accent : 0,
            marked ? "Saved" : "Bookmark", lastUrl != null, false, this::toggleBookmark);
        quickAction(quick, owner, R.drawable.nk_ic_share, 0, "Share", lastUrl != null, false, this::sharePage);
        body.addView(quick);

        // Tabs
        LinearLayout tabsSection = sheetSection(body);
        sheetRow(tabsSection, owner, R.drawable.nk_ic_add_box, "New tab", null, null, 0, () -> openNewTab(false));
        sheetRow(tabsSection, owner, R.drawable.nk_ic_incognito, "New incognito tab", null, null, 0, () -> openNewTab(true));
        sheetRow(tabsSection, owner, R.drawable.nk_ic_tab, "Tabs", String.valueOf(tabs.size()), null, 0, this::showTabSwitcher);
        sheetRow(tabsSection, owner, R.drawable.nk_ic_group_work, "Tab groups", null, null, 0, this::showGroupsDialog);

        // Page tools
        LinearLayout tools = sheetSection(body);
        sheetRow(tools, owner, R.drawable.nk_ic_search, "Find in page", null, null, 0, this::showFindBar);
        sheetRow(tools, owner, R.drawable.nk_ic_screenshot_monitor, "Take screenshot", null, null, 0, this::takeScreenshot);
        boolean rec = ScreenRecordService.isRecording();
        sheetRow(tools, owner, rec ? R.drawable.nk_ic_stop_circle : R.drawable.nk_ic_screen_record,
            rec ? "Stop recording" : "Screen recording", rec ? recElapsed() : null, null, rec ? REC_RED : 0, this::toggleScreenRecording);
        sheetRow(tools, owner, R.drawable.nk_ic_desktop_windows, "Desktop site", null, current != null && current.desktop, 0, this::toggleDesktopMode);
        sheetRow(tools, owner, R.drawable.nk_ic_chrome_reader_mode, "Reader mode", null, null, 0, this::toggleReaderMode);
        sheetRow(tools, owner, R.drawable.nk_ic_translate, "Translate page", null, null, 0, this::chooseTranslateLanguage);
        sheetRow(tools, owner, R.drawable.nk_ic_zoom_in, "Zoom", (webView == null ? store.textZoom() : webView.getSettings().getTextZoom()) + "%", null, 0, this::showZoomDialog);
        sheetRow(tools, owner, R.drawable.nk_ic_terminal, "Dev console", null, current != null && current.devtools, 0, this::toggleDevConsole);

        // Library
        LinearLayout library = sheetSection(body);
        sheetRow(library, owner, R.drawable.nk_ic_bookmarks, "Bookmarks", null, null, 0, () -> showEntries("Bookmarks", true));
        sheetRow(library, owner, R.drawable.nk_ic_history, "History", null, null, 0, () -> showEntries("History", false));
        sheetRow(library, owner, R.drawable.nk_ic_home, "Home page", null, null, 0, this::goHome);

        // Settings
        LinearLayout prefs = sheetSection(body);
        sheetRow(prefs, owner, R.drawable.nk_ic_palette, "Appearance", null, null, 0, this::showAppearance);
        sheetRow(prefs, owner, R.drawable.nk_ic_settings, "Browser settings", null, null, 0, this::showSettings);

        LinearLayout exit = sheetSection(body);
        sheetRow(exit, owner, R.drawable.nk_ic_close, "Close browser", null, null, REC_RED, this::finish);

        owner[0] = sheet(body);
        menuSheet = owner[0];
        owner[0].show();
    }

    private static final int REC_RED = Color.rgb(229, 57, 53);

    private void toast(String text) {

        try { Toast.makeText(this, text, Toast.LENGTH_SHORT).show(); } catch (Throwable ignored) {}
    }

    private String currentUrl() {
        if (webView != null && webView.getUrl() != null && webView.getUrl().startsWith("https://")) return webView.getUrl();
        return lastUrl;
    }

    private void toggleAgent() {
        if (webView == null) return;
        if (pageAgent == null) { toast("The page agent is turned off for this page"); return; }
        PageAgentHost.togglePanel(webView);
    }

    /** Explicit user navigation (address bar, bookmark, history, translate): the
     *  target site joins the boundary exactly like an approved cross-site hop. */
    private void allowAndLoad(String url) {
        Uri target;
        try { target = validatedHttps(url); }
        catch (Exception error) { toast(error.getMessage()); return; }
        allowSite(target.getHost(), target.getPort());
        if (webView != null) webView.loadUrl(target.toString());
    }

    private void allowSite(String rawHost, int port) {
        if (rawHost == null) return;
        String host = rawHost.toLowerCase(Locale.ROOT);
        allowedHosts.add(host + ":" + (port < 0 ? 443 : port));
        String site = registrableSite(host);
        if (site != null) { allowedHosts.add(site + ":443"); allowedHosts.add("*." + site + ":443"); }
    }

    // ======================= dev console (Eruda) =======================

    private void toggleDevConsole() {
        if (current == null || webView == null) { toast("Open a page first"); return; }
        current.devtools = !current.devtools;
        if (current.devtools) {
            DevConsole.show(webView, this, theme.dark, true);
            toast("Dev console on");
        } else {
            DevConsole.hide(webView);
            toast("Dev console off");
        }
    }

    // ======================= screenshot =======================

    private void takeScreenshot() {
        final WebView view = webView;
        if (view == null || view.getWidth() <= 0 || view.getHeight() <= 0) { toast("Open a page first"); return; }
        // Let the menu sheet finish closing so it is not in the shot.
        handler.postDelayed(() -> captureVisible(view), 220);
    }

    private void captureVisible(final WebView view) {
        if (view.getWidth() <= 0 || view.getHeight() <= 0) return;
        final Bitmap bitmap = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
        int[] at = new int[2];
        view.getLocationInWindow(at);
        android.graphics.Rect area = new android.graphics.Rect(at[0], at[1], at[0] + view.getWidth(), at[1] + view.getHeight());
        try {
            // PixelCopy reads the composited frame (GPU WebView content included).
            android.view.PixelCopy.request(getWindow(), area, bitmap, result -> {
                if (result == android.view.PixelCopy.SUCCESS) saveScreenshot(bitmap);
                else saveScreenshot(drawFallback(view, bitmap));
            }, handler);
        } catch (Throwable error) {
            saveScreenshot(drawFallback(view, bitmap));
        }
    }

    private Bitmap drawFallback(WebView view, Bitmap bitmap) {
        try {
            android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
            canvas.drawColor(theme.ground);
            canvas.translate(-view.getScrollX(), -view.getScrollY());
            view.draw(canvas);
        } catch (Throwable ignored) {}
        return bitmap;
    }

    private void saveScreenshot(final Bitmap bitmap) {
        final android.content.Context app = getApplicationContext();
        THUMB_IO.execute(() -> {
            final Uri uri = MediaSaver.saveImage(app, bitmap);
            handler.post(() -> {
                if (isFinishing()) return;
                if (uri == null) toast("Could not save the screenshot");
                else showShotPreview(bitmap, uri);
            });
        });
    }

    private View shotCard;

    /** Small floating preview: thumbnail · "Screenshot saved" · Share · Edit. */
    private void showShotPreview(Bitmap bitmap, final Uri uri) {
        if (content == null) return;
        if (shotCard != null && shotCard.getParent() instanceof ViewGroup) ((ViewGroup) shotCard.getParent()).removeView(shotCard);
        LinearLayout card = new LinearLayout(this);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(10), dp(10), dp(8), dp(10));
        card.setBackground(rounded(theme.chrome, dp(18), theme.border));
        card.setElevation(dp(10));
        android.widget.ImageView thumb = new android.widget.ImageView(this);
        thumb.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
        thumb.setImageBitmap(bitmap);
        thumb.setBackground(rounded(theme.surface, dp(8), 0));
        thumb.setClipToOutline(true);
        card.addView(thumb, new LinearLayout.LayoutParams(dp(40), dp(64)));
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView t1 = new TextView(this);
        t1.setText("Screenshot saved");
        t1.setTextSize(14);
        t1.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        t1.setTextColor(theme.text);
        TextView t2 = new TextView(this);
        t2.setText("Pictures/" + MediaSaver.folder(this));
        t2.setTextSize(12);
        t2.setTextColor(theme.muted);
        t2.setSingleLine(true);
        texts.addView(t1);
        texts.addView(t2);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        tp.setMargins(dp(12), 0, dp(4), 0);
        card.addView(texts, tp);
        card.addView(cardAction("Share", () -> {
            Intent send = new Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { startActivity(Intent.createChooser(send, "Share screenshot")); } catch (Throwable e) { toast("No app can share this"); }
        }));
        card.addView(cardAction("Edit", () -> {
            Intent edit = new Intent(Intent.ACTION_EDIT).setDataAndType(uri, "image/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            try { startActivity(Intent.createChooser(edit, "Edit screenshot")); } catch (Throwable e) { toast("No editor app found"); }
        }));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        lp.setMargins(dp(12), 0, dp(12), dp(14));
        content.addView(card, lp);
        card.setAlpha(0f);
        card.setTranslationY(dp(24));
        card.animate().alpha(1f).translationY(0).setDuration(180).start();
        shotCard = card;
        final View shown = card;
        handler.postDelayed(() -> {
            if (shown.getParent() == null) return;
            shown.animate().alpha(0f).translationY(dp(24)).setDuration(180).withEndAction(() -> {
                if (shown.getParent() instanceof ViewGroup) ((ViewGroup) shown.getParent()).removeView(shown);
            }).start();
        }, 6000);
    }

    private TextView cardAction(String label, final Runnable action) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setTextSize(14);
        button.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        button.setTextColor(theme.accent);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(12), dp(8), dp(12), dp(8));
        button.setBackground(pressable(dp(16)));
        button.setOnClickListener(v -> action.run());
        return button;
    }

    // ======================= screen recording =======================

    private static final int REQ_PROJECTION = 7301;
    private static final int REQ_NOTIFICATIONS = 7302;
    private TextView recPill;
    private final Runnable recTick = new Runnable() {
        @Override public void run() {
            if (recPill != null && ScreenRecordService.isRecording()) {
                recPill.setText("\u25cf  REC " + recElapsed() + "   Stop");
                handler.postDelayed(this, 1000);
            }
        }
    };

    private String recElapsed() {
        long s = Math.max(0, (System.currentTimeMillis() - ScreenRecordService.startedAt()) / 1000);
        return String.format(Locale.US, "%d:%02d", s / 60, s % 60);
    }

    private void toggleScreenRecording() {
        if (ScreenRecordService.isRecording()) {
            startService(new Intent(this, ScreenRecordService.class).setAction(ScreenRecordService.ACTION_STOP));
            return;
        }
        // Android 13+: the Stop notification needs the notification permission.
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATIONS);
            return;
        }
        requestProjection();
    }

    private void requestProjection() {
        try {
            android.media.projection.MediaProjectionManager manager =
                (android.media.projection.MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            // A fresh consent every time (Android 14+ tokens are single-use).
            startActivityForResult(manager.createScreenCaptureIntent(), REQ_PROJECTION);
        } catch (Throwable error) {
            toast("Screen recording is not supported on this device");
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        // Recording still works without the notification; only the shade Stop is missing.
        if (requestCode == REQ_NOTIFICATIONS) requestProjection();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PROJECTION) return;
        if (resultCode != RESULT_OK || data == null) { toast("Screen recording cancelled"); return; }
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(metrics);
        Intent start = new Intent(this, ScreenRecordService.class)
            .setAction(ScreenRecordService.ACTION_START)
            .putExtra(ScreenRecordService.EXTRA_CODE, resultCode)
            .putExtra(ScreenRecordService.EXTRA_DATA, data)
            .putExtra(ScreenRecordService.EXTRA_WIDTH, metrics.widthPixels)
            .putExtra(ScreenRecordService.EXTRA_HEIGHT, metrics.heightPixels)
            .putExtra(ScreenRecordService.EXTRA_DPI, metrics.densityDpi);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(start); else startService(start);
        } catch (Throwable error) {
            toast("Could not start screen recording");
        }
    }

    /** Red REC pill over the page while recording; tap to stop. */
    private void updateRecIndicator() {
        if (content == null) return;
        boolean on = ScreenRecordService.isRecording();
        if (!on) {
            if (recPill != null && recPill.getParent() instanceof ViewGroup) ((ViewGroup) recPill.getParent()).removeView(recPill);
            recPill = null;
            handler.removeCallbacks(recTick);
            return;
        }
        if (recPill != null && recPill.getParent() == content) { recPill.bringToFront(); return; }
        if (recPill != null && recPill.getParent() instanceof ViewGroup) ((ViewGroup) recPill.getParent()).removeView(recPill);
        recPill = new TextView(this);
        recPill.setTextColor(Color.WHITE);
        recPill.setTextSize(12);
        recPill.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        recPill.setPadding(dp(14), dp(7), dp(14), dp(7));
        recPill.setBackground(rounded(REC_RED, dp(18), 0));
        recPill.setElevation(dp(8));
        recPill.setContentDescription("Recording. Tap to stop");
        recPill.setOnClickListener(v -> toggleScreenRecording());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        lp.setMargins(0, dp(10), 0, 0);
        content.addView(recPill, lp);
        handler.removeCallbacks(recTick);
        recTick.run();
    }

    // ======================= tabs =======================

    private static final int MENU_NEW_TAB = 10;
    private static final int MENU_TABS = 11;

    /** First tab of a session: the requested URL, plus the saved tabs (lazy). */
    private void startTabs(String startUrl) {
        tabs.clear();
        current = null;
        store.pruneHistory(System.currentTimeMillis());
        if (store.restoreTabs()) restoreSavedTabs(startUrl);
        BrowserTab first = new BrowserTab(startUrl, false);
        tabs.add(first);
        showTab(first, true);
        runAutoDelete();
    }

    private void restoreSavedTabs(String startUrl) {
        long now = System.currentTimeMillis();
        for (BrowserStore.SavedTab saved : store.savedTabs()) {
            if (tabs.size() >= MAX_RESTORED_TABS) break;
            if (saved.url == null || saved.url.equals(startUrl) || !saved.url.startsWith("https://")) continue;
            int days = store.autoCloseTabsDays();
            if (days > 0 && saved.lastActive > 0 && BrowserLogic.isExpired(saved.lastActive, now, days)) continue;
            BrowserTab tab = new BrowserTab(saved.url, false);
            tab.title = saved.title == null ? "" : saved.title;
            tab.groupId = saved.groupId;
            tab.lastActive = saved.lastActive > 0 ? saved.lastActive : now;
            tabs.add(tab);
        }
    }

    private void saveSession() {
        if (store == null) return;
        List<BrowserStore.SavedTab> out = new ArrayList<>();
        for (BrowserTab tab : tabs) {
            if (tab.incognito || tab.url == null || !tab.url.startsWith("https://")) continue;
            out.add(new BrowserStore.SavedTab(tab.url, tab.title, tab.groupId, tab.lastActive));
        }
        store.saveTabs(out);
    }

    /** Opens url in a new tab right after the current one and switches to it. */
    private BrowserTab openTab(String url, boolean incognito) {
        BrowserTab tab = new BrowserTab(url, incognito);
        if (current != null) tab.groupId = incognito ? null : current.groupId;
        int at = current == null ? tabs.size() : tabs.indexOf(current) + 1;
        if (at <= 0 || at > tabs.size()) at = tabs.size();
        tabs.add(at, tab);
        showTab(tab, false);
        return tab;
    }

    private void showTab(BrowserTab tab, boolean withCover) {
        if (tab == null || content == null) return;
        hideFindBar();
        exitCustomView();
        cancelLoadTimeout();
        if (current != null && current != tab && current.view != null) {
            captureThumb(current);
            try { current.view.onPause(); } catch (Throwable ignored) {}
        }
        tab.lastActive = System.currentTimeMillis();
        lastUrl = tab.url;
        if (tab.view == null) {
            if (tab.url != null) {
                Uri target = Uri.parse(tab.url);
                allowSite(target.getHost(), target.getPort());
            }
            createWebView(tab, tab.url, withCover);
        } else {
            current = tab;
            webView = tab.view;
            pageAgent = tab.agent;
            content.removeAllViews();
            cover = null;
            revealed = true;
            tab.view.setVisibility(View.VISIBLE);
            tab.view.setAlpha(1f);
            content.addView(tab.view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            try { tab.view.onResume(); } catch (Throwable ignored) {}
            if (progress != null) progress.setVisibility(tab.loading ? View.VISIBLE : View.INVISIBLE);
        }
        syncChrome();
        updateTabBadge();
    }

    private void closeTab(BrowserTab tab) {
        int index = tabs.indexOf(tab);
        if (index < 0) return;
        boolean wasCurrent = tab == current;
        if (wasCurrent) { hideFindBar(); exitCustomView(); cancelLoadTimeout(); }
        tabs.remove(index);
        destroyTabView(tab);
        PageAgentHost.forgetSession(tab.id);
        if (tabs.isEmpty()) { current = null; finish(); return; }
        if (wasCurrent) {
            current = null;
            showTab(tabs.get(Math.min(index, tabs.size() - 1)), false);
        }
        updateTabBadge();
    }

    private boolean hasOtherIncognito(BrowserTab except) {
        for (BrowserTab tab : tabs) if (tab != except && tab.incognito && tab.view != null) return true;
        return false;
    }

    /** Clears cookies and site storage of the incognito profile. */
    private void wipeIncognitoProfile(WebView view) {
        if (view == null || !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        try {
            androidx.webkit.Profile profile = WebViewCompat.getProfile(view);
            if (profile == null || !PROFILE_INCOGNITO.equals(profile.getName())) return;
            profile.getCookieManager().removeAllCookies(null);
            profile.getWebStorage().deleteAllData();
        } catch (Throwable ignored) {}
    }

    private void updateTabBadge() {
        if (tabsButton == null) return;
        int count = tabs.size();
        tabsButton.setText(count > 99 ? "99+" : String.valueOf(Math.max(1, count)));
        boolean incognito = current != null && current.incognito;
        tabsButton.setBackground(rounded(incognito ? theme.incognito : 0, dp(9), incognito ? theme.incognito : theme.text));
        tabsButton.setTextColor(incognito ? Color.WHITE : theme.text);
        tabsButton.setContentDescription(count + (count == 1 ? " tab" : " tabs"));
    }

    /** Hook for later stages: which tabs the switcher lists. */
    private List<BrowserTab> visibleTabs() {
        if (groupFilter == null || findGroup(groupFilter) == null) { groupFilter = null; return new ArrayList<>(tabs); }
        List<BrowserTab> out = new ArrayList<>();
        for (BrowserTab tab : tabs) if (groupFilter.equals(tab.groupId)) out.add(tab);
        return out;
    }

    /** Hook for later stages: extra line under a tab's title in the switcher. */
    private String tabExtraInfo(BrowserTab tab) {
        if (tab.incognito) return "Incognito";
        BrowserStore.Group group = findGroup(tab.groupId);
        return group == null ? null : group.name;
    }

    // ======================= tab switcher (page previews) =======================
    //
    // Tabs used to be a plain text list inside an AlertDialog. The switcher is
    // now a full-screen surface that shows every tab as a preview of the page
    // as it last looked (a scaled snapshot taken when the tab was left), the
    // way Chrome / Firefox / Samsung Internet do it. The user picks the layout:
    //   Grid — two preview cards per row (default, visual recognition)
    //   List — compact rows with a small preview (more tabs on screen)
    // The choice is persisted (BrowserStore.tabLayout) and can be flipped from
    // the switcher header or from Appearance settings.

    private android.app.Dialog switcher;

    private void showTabSwitcher() {
        captureThumb(current);
        if (switcher != null && switcher.isShowing()) switcher.dismiss();
        int style = theme.dark ? android.R.style.Theme_DeviceDefault_NoActionBar : android.R.style.Theme_DeviceDefault_Light_NoActionBar;
        final android.app.Dialog dialog = new android.app.Dialog(this, style);
        switcher = dialog;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(theme.ground);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(10), dp(8), dp(6));
        final TextView title = new TextView(this);
        title.setTextColor(theme.text);
        title.setTextSize(20);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        final LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(dp(12), dp(4), dp(12), dp(12));

        // Grid / List segmented control.
        LinearLayout segment = new LinearLayout(this);
        segment.setBackground(rounded(theme.surface, dp(18), 0));
        segment.setPadding(dp(3), dp(3), dp(3), dp(3));
        final TextView gridChip = segmentChip("\u25a6  Grid");
        final TextView listChip = segmentChip("\u2630  List");
        segment.addView(gridChip, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(30)));
        segment.addView(listChip, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(30)));
        final Runnable paintSegment = () -> {
            boolean grid = !"list".equals(store.tabLayout());
            styleChip(gridChip, grid);
            styleChip(listChip, !grid);
        };
        gridChip.setOnClickListener(v -> { store.setTabLayout("grid"); paintSegment.run(); fillTabRows(list, dialog, title); });
        listChip.setOnClickListener(v -> { store.setTabLayout("list"); paintSegment.run(); fillTabRows(list, dialog, title); });
        paintSegment.run();
        header.addView(segment, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Button more = chromeButton("\u22ee", "Tab options", v -> {
            final android.app.Dialog[] owner = new android.app.Dialog[1];
            LinearLayout body = new LinearLayout(this);
            body.setOrientation(LinearLayout.VERTICAL);
            LinearLayout section = sheetSection(body);
            ((LinearLayout.LayoutParams) section.getLayoutParams()).setMargins(0, 0, 0, 0);
            sheetRow(section, owner, R.drawable.nk_ic_add_box, "New tab", null, null, 0, () -> { dialog.dismiss(); openNewTab(false); });
            sheetRow(section, owner, R.drawable.nk_ic_incognito, "New incognito tab", null, null, 0, () -> { dialog.dismiss(); openNewTab(true); });
            sheetRow(section, owner, R.drawable.nk_ic_group_work, "Tab groups", null, null, 0, () -> { dialog.dismiss(); showGroupsDialog(); });
            if (groupFilter != null) sheetRow(section, owner, R.drawable.nk_ic_select_all, "Show all tabs", null, null, 0, () -> { groupFilter = null; fillTabRows(list, dialog, title); });
            LinearLayout danger = sheetSection(body);
            sheetRow(danger, owner, R.drawable.nk_ic_delete, "Close all tabs", null, null, REC_RED, () -> { dialog.dismiss(); confirmCloseAll(); });
            owner[0] = sheet(body);
            owner[0].show();
        });
        more.setTextSize(20);
        LinearLayout.LayoutParams moreParams = new LinearLayout.LayoutParams(dp(40), dp(40));
        moreParams.setMargins(dp(4), 0, 0, 0);
        header.addView(more, moreParams);
        root.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(list, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        // Bottom action bar: Done · New tab.
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(dp(16), dp(8), dp(16), dp(12));
        actions.setBackgroundColor(theme.chrome);
        actions.setElevation(dp(4));
        TextView done = new TextView(this);
        done.setText("Done");
        done.setTextColor(theme.text);
        done.setTextSize(15);
        done.setGravity(Gravity.CENTER);
        done.setPadding(dp(18), 0, dp(18), 0);
        done.setBackground(pressable(dp(22)));
        done.setOnClickListener(v -> dialog.dismiss());
        actions.addView(done, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        actions.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
        TextView newTab = new TextView(this);
        newTab.setText("+  New tab");
        newTab.setTextColor(theme.onAccent);
        newTab.setTextSize(15);
        newTab.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        newTab.setGravity(Gravity.CENTER);
        newTab.setPadding(dp(22), 0, dp(22), 0);
        newTab.setBackground(rounded(theme.accent, dp(22), 0));
        newTab.setOnClickListener(v -> { dialog.dismiss(); openNewTab(false); });
        actions.addView(newTab, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        root.addView(actions, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        dialog.setContentView(root);
        try {
            android.view.Window window = dialog.getWindow();
            if (window != null) {
                window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                window.setStatusBarColor(theme.ground);
                window.setNavigationBarColor(theme.chrome);
                window.setWindowAnimations(android.R.style.Animation_Dialog);
            }
        } catch (Throwable ignored) {}
        ImeInsetsHelper.apply(root);
        fillTabRows(list, dialog, title);
        dialog.show();
    }

    private TextView segmentChip(String label) {
        TextView chip = new TextView(this);
        chip.setText(label);
        chip.setTextSize(13);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(12), 0, dp(12), 0);
        return chip;
    }

    private void styleChip(TextView chip, boolean selected) {
        chip.setBackground(selected ? rounded(theme.chrome, dp(15), theme.border) : null);
        chip.setTextColor(selected ? theme.text : theme.muted);
        chip.setTypeface(selected ? android.graphics.Typeface.DEFAULT_BOLD : android.graphics.Typeface.DEFAULT);
    }

    private void confirmCloseAll() {
        dialogBuilder()
            .setTitle("Close all tabs?")
            .setMessage(tabs.size() + " tabs will be closed.")
            .setPositiveButton("Close all", (d, w) -> {
                for (BrowserTab tab : new ArrayList<>(tabs)) { deleteThumb(tab); destroyTabView(tab); }
                tabs.clear();
                current = null;
                saveSession();
                finish();
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    private String tabsTitle() {
        String count = tabs.size() == 1 ? "1 tab" : tabs.size() + " tabs";
        BrowserStore.Group group = findGroup(groupFilter);
        return group == null ? count : group.name + " · " + visibleTabs().size() + " of " + count;
    }

    private void fillTabRows(LinearLayout list, android.app.Dialog dialog, TextView title) {
        list.removeAllViews();
        boolean grid = !"list".equals(store.tabLayout());
        List<BrowserTab> shown = visibleTabs();
        if (groupFilter != null) {
            addTabViews(list, shown, grid, dialog, title);
        } else {
            // Ungrouped tabs first, then each group under a collapsible header.
            List<BrowserTab> loose = new ArrayList<>();
            for (BrowserTab tab : shown) if (findGroup(tab.groupId) == null) loose.add(tab);
            addTabViews(list, loose, grid, dialog, title);
            for (BrowserStore.Group group : store.groups()) {
                List<BrowserTab> members = new ArrayList<>();
                for (BrowserTab tab : shown) if (group.id.equals(tab.groupId)) members.add(tab);
                if (members.isEmpty()) continue;
                list.addView(groupHeader(group, members.size(), list, dialog, title));
                if (collapsedGroups.contains(group.id)) continue;
                addTabViews(list, members, grid, dialog, title);
            }
        }
        title.setText(tabsTitle());
    }

    private void addTabViews(LinearLayout list, List<BrowserTab> items, boolean grid, android.app.Dialog dialog, TextView title) {
        if (!grid) {
            for (BrowserTab tab : items) list.addView(tabRow(tab, list, dialog, title));
            return;
        }
        for (int i = 0; i < items.size(); i += 2) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int k = 0; k < 2; k++) {
                LinearLayout.LayoutParams cell = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
                cell.setMargins(dp(5), dp(5), dp(5), dp(5));
                if (i + k < items.size()) row.addView(tabCard(items.get(i + k), list, dialog, title), cell);
                else row.addView(new View(this), cell);
            }
            list.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }
    }

    /** Grid card: favicon letter + title + close, then the page preview. */
    private View tabCard(final BrowserTab tab, final LinearLayout list, final android.app.Dialog dialog, final TextView title) {
        boolean active = tab == current;
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(3), dp(3), dp(3), dp(3));
        card.setBackground(rounded(tab.incognito ? BrowserTheme.blend(theme.surface, theme.incognito, 0.25f) : theme.surface, dp(16),
            active ? theme.accent : theme.border));
        if (active) ((android.graphics.drawable.GradientDrawable) card.getBackground()).setStroke(dp(2), theme.accent);
        card.setElevation(active ? dp(3) : dp(1));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(8), dp(2), 0, dp(2));
        top.addView(faviconBadge(tab, dp(18)), new LinearLayout.LayoutParams(dp(18), dp(18)));
        TextView name = new TextView(this);
        name.setText(tab.label());
        name.setTextColor(theme.text);
        name.setTextSize(12.5f);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        name.setPadding(dp(6), 0, dp(2), 0);
        top.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = chromeButton("\u2715", "Close tab", v -> closeFromSwitcher(tab, list, dialog, title));
        close.setTextSize(12);
        close.setTextColor(theme.muted);
        top.addView(close, new LinearLayout.LayoutParams(dp(30), dp(30)));
        card.addView(top, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        card.addView(previewView(tab, 1.25f), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(196)));
        String info = tabExtraInfo(tab);
        if (info != null) {
            TextView meta = new TextView(this);
            meta.setText(info);
            meta.setTextColor(theme.muted);
            meta.setTextSize(11);
            meta.setPadding(dp(8), dp(4), dp(8), dp(3));
            card.addView(meta);
        }
        card.setContentDescription(tab.label() + (active ? ", current tab" : ""));
        card.setOnClickListener(v -> { dialog.dismiss(); if (tab != current) showTab(tab, false); });
        card.setOnLongClickListener(v -> { onTabLongPress(tab, list, dialog, title); return true; });
        return card;
    }

    /** List row: small preview, title, host, close. */
    private View tabRow(final BrowserTab tab, final LinearLayout list, final android.app.Dialog dialog, final TextView title) {
        boolean active = tab == current;
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(8), dp(4), dp(8));
        row.setBackground(rounded(active ? BrowserTheme.alpha(theme.accent, 36) : theme.surface, dp(14), active ? theme.accent : 0));
        View preview = previewView(tab, 1.4f);
        LinearLayout.LayoutParams previewParams = new LinearLayout.LayoutParams(dp(54), dp(72));
        previewParams.setMargins(0, 0, dp(12), 0);
        row.addView(preview, previewParams);
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView name = new TextView(this);
        name.setText(tab.label());
        name.setTextColor(theme.text);
        name.setTextSize(14.5f);
        name.setMaxLines(2);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(name);
        TextView host = new TextView(this);
        String info = tabExtraInfo(tab);
        String h = tab.url == null ? "" : BrowserLogic.displayHost(tab.url);
        host.setText(h + (info == null ? "" : " \u00b7 " + info));
        host.setTextColor(theme.muted);
        host.setTextSize(12);
        host.setSingleLine(true);
        host.setPadding(0, dp(2), 0, 0);
        texts.addView(host);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = chromeButton("\u2715", "Close tab", v -> closeFromSwitcher(tab, list, dialog, title));
        close.setTextSize(13);
        close.setTextColor(theme.muted);
        row.addView(close, new LinearLayout.LayoutParams(dp(40), dp(40)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(dp(4), dp(4), dp(4), dp(4));
        row.setLayoutParams(params);
        row.setContentDescription(tab.label() + (active ? ", current tab" : ""));
        row.setOnClickListener(v -> { dialog.dismiss(); if (tab != current) showTab(tab, false); });
        row.setOnLongClickListener(v -> { onTabLongPress(tab, list, dialog, title); return true; });
        return row;
    }

    private void closeFromSwitcher(BrowserTab tab, LinearLayout list, android.app.Dialog dialog, TextView title) {
        deleteThumb(tab);
        closeTab(tab);
        if (tabs.isEmpty() || isFinishing()) { dialog.dismiss(); return; }
        fillTabRows(list, dialog, title);
    }

    /**
     * The page's last view: the snapshot taken when the tab was left (or the
     * one persisted for a restored tab), top-cropped to the slot's aspect. A
     * tab that never painted shows its site initial instead of a blank box.
     */
    private View previewView(BrowserTab tab, float aspect) {
        Bitmap thumb = thumbFor(tab);
        if (thumb != null) {
            android.widget.ImageView image = new android.widget.ImageView(this);
            int w = thumb.getWidth();
            int h = Math.min(thumb.getHeight(), Math.max(1, Math.round(w * aspect)));
            try { image.setImageBitmap(h < thumb.getHeight() ? Bitmap.createBitmap(thumb, 0, 0, w, h) : thumb); }
            catch (Throwable error) { image.setImageBitmap(thumb); }
            image.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
            image.setBackground(rounded(theme.chrome, dp(13), 0));
            image.setClipToOutline(true);
            return image;
        }
        FrameLayout empty = new FrameLayout(this);
        empty.setBackground(rounded(theme.surface2, dp(13), 0));
        View badge = faviconBadge(tab, dp(40));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER);
        empty.addView(badge, lp);
        return empty;
    }

    /** Round site-initial badge tinted from the host name (no network favicon fetch). */
    private View faviconBadge(BrowserTab tab, int size) {
        TextView badge = new TextView(this);
        String host = tab.url == null ? "" : BrowserLogic.displayHost(tab.url);
        String letter = host.isEmpty() ? (tab.incognito ? "\u25d0" : "+") : host.substring(0, 1).toUpperCase(Locale.ROOT);
        Object[] accent = BrowserTheme.ACCENTS[Math.abs(host.hashCode()) % BrowserTheme.ACCENTS.length];
        int color = tab.incognito ? theme.incognito : (Integer) accent[1];
        badge.setText(letter);
        badge.setTextColor(Color.WHITE);
        badge.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        badge.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, size * 0.5f);
        badge.setGravity(Gravity.CENTER);
        badge.setIncludeFontPadding(false);
        badge.setBackground(rounded(color, size / 2, 0));
        return badge;
    }

    // ---- page snapshots for previews ----

    /** Scaled snapshot of what the tab shows right now (visible viewport). */
    private void captureThumb(BrowserTab tab) {
        if (tab == null || tab.view == null) return;
        WebView view = tab.view;
        if (view.getWidth() <= 0 || view.getHeight() <= 0 || view.getParent() == null || view.getVisibility() != View.VISIBLE) return;
        try {
            float scale = Math.min(1f, dp(240) / (float) view.getWidth());
            int w = Math.max(1, Math.round(view.getWidth() * scale));
            int h = Math.max(1, Math.round(view.getHeight() * scale));
            Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565);
            android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
            canvas.drawColor(theme.ground);
            canvas.scale(scale, scale);
            canvas.translate(-view.getScrollX(), -view.getScrollY());
            view.draw(canvas);
            tab.thumb = bitmap;
            if (!tab.incognito && tab.url != null) persistThumb(tab.url, bitmap);
        } catch (Throwable ignored) { /* preview is best effort */ }
    }

    private java.io.File thumbFile(String url) {
        java.io.File dir = new java.io.File(getCacheDir(), "tab-previews");
        return new java.io.File(dir, Integer.toHexString(url.hashCode()) + ".jpg");
    }

    private static final java.util.concurrent.ExecutorService THUMB_IO = java.util.concurrent.Executors.newSingleThreadExecutor();

    private void persistThumb(final String url, final Bitmap bitmap) {
        final java.io.File file = thumbFile(url);
        THUMB_IO.execute(() -> {
            try {
                java.io.File dir = file.getParentFile();
                if (dir != null && !dir.exists()) dir.mkdirs();
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 78, out);
                }
            } catch (Throwable ignored) {}
        });
    }

    private Bitmap thumbFor(BrowserTab tab) {
        if (tab.thumb != null || tab.incognito || tab.url == null) return tab.thumb;
        try {
            java.io.File file = thumbFile(tab.url);
            if (file.exists()) tab.thumb = android.graphics.BitmapFactory.decodeFile(file.getAbsolutePath());
        } catch (Throwable ignored) {}
        return tab.thumb;
    }

    private void deleteThumb(BrowserTab tab) {
        if (tab == null) return;
        tab.thumb = null;
        if (tab.url == null) return;
        final java.io.File file = thumbFile(tab.url);
        THUMB_IO.execute(() -> { try { file.delete(); } catch (Throwable ignored) {} });
    }

    /** Hook for later stages: long-press on a tab in the switcher. */
    private void onTabLongPress(BrowserTab tab, LinearLayout list, android.app.Dialog dialog, TextView title) {
        chooseGroupForTab(tab, () -> { if (dialog.isShowing()) fillTabRows(list, dialog, title); });
    }

    private View groupHeader(final BrowserStore.Group group, int count, final LinearLayout list, final android.app.Dialog dialog, final TextView title) {
        TextView header = new TextView(this);
        boolean collapsed = collapsedGroups.contains(group.id);
        header.setText((collapsed ? "\u25b8  " : "\u25be  ") + group.name + "  \u00b7  " + count);
        header.setTextColor(Color.WHITE);
        header.setTextSize(14);
        header.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        header.setPadding(dp(14), dp(9), dp(14), dp(9));
        header.setBackground(rounded(group.color, dp(14), 0));
        header.setOnClickListener(view -> {
            if (!collapsedGroups.remove(group.id)) collapsedGroups.add(group.id);
            fillTabRows(list, dialog, title);
        });
        header.setOnLongClickListener(view -> { groupFilter = group.id; fillTabRows(list, dialog, title); return true; });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(dp(5), dp(12), dp(5), dp(4));
        header.setLayoutParams(params);
        return header;
    }

    // ======================= tab groups =======================

    private static final int MENU_GROUPS = 12;
    private static final int MENU_SETTINGS = 13;
    private static final int MENU_INCOGNITO = 14;
    private static final int MENU_ZOOM = 15;
    private static final int MENU_HOME = 16;
    private static final int MENU_APPEARANCE = 17;
    private static final int MENU_CLOSE = 18;
    /** Switcher filter: null shows every tab, else only that group's tabs. */
    private String groupFilter;
    private final Set<String> collapsedGroups = new HashSet<>();

    private BrowserStore.Group findGroup(String id) {
        if (id == null) return null;
        for (BrowserStore.Group group : store.groups()) if (group.id.equals(id)) return group;
        return null;
    }

    private int groupCount(String id) {
        int count = 0;
        for (BrowserTab tab : tabs) if (id.equals(tab.groupId)) count++;
        return count;
    }

    private void showGroupsDialog() {
        final List<BrowserStore.Group> groups = store.groups();
        List<String> rows = new ArrayList<>();
        rows.add((groupFilter == null ? "\u2713 " : "") + "All tabs (" + tabs.size() + ")");
        for (BrowserStore.Group group : groups) {
            rows.add((group.id.equals(groupFilter) ? "\u2713 " : "\u25cf ") + group.name + " (" + groupCount(group.id) + ")");
        }
        rows.add("+ New group");
        android.app.AlertDialog dialog = dialogBuilder()
            .setTitle("Tab groups")
            .setItems(rows.toArray(new String[0]), (d, which) -> {
                if (which == 0) { groupFilter = null; showTabSwitcher(); }
                else if (which <= groups.size()) { groupFilter = groups.get(which - 1).id; showTabSwitcher(); }
                else promptGroupName(null, created -> {
                    if (current != null && !current.incognito) current.groupId = created.id;
                    groupFilter = created.id;
                    showTabSwitcher();
                });
            })
            .setNegativeButton("Close", null)
            .create();
        dialog.setOnShowListener(shown -> {
            android.widget.ListView list = dialog.getListView();
            if (list == null) return;
            list.setOnItemLongClickListener((parent, view, position, id) -> {
                if (position < 1 || position > groups.size()) return false;
                dialog.dismiss();
                editGroup(groups.get(position - 1));
                return true;
            });
        });
        dialog.show();
    }

    private interface GroupCallback { void done(BrowserStore.Group group); }

    /** Creates a group (existing == null) or renames one. */
    private void promptGroupName(final BrowserStore.Group existing, final GroupCallback callback) {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("Group name");
        if (existing != null) { input.setText(existing.name); input.setSelection(input.getText().length()); }
        FrameLayout wrapper = new FrameLayout(this);
        wrapper.setPadding(dp(20), dp(8), dp(20), 0);
        wrapper.addView(input, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialogBuilder()
            .setTitle(existing == null ? "New tab group" : "Rename group")
            .setView(wrapper)
            .setNegativeButton("Cancel", null)
            .setPositiveButton(existing == null ? "Create" : "Save", (d, w) -> {
                String name = input.getText() == null ? "" : input.getText().toString().trim();
                if (name.isEmpty()) name = "Group";
                List<BrowserStore.Group> groups = store.groups();
                BrowserStore.Group result = null;
                if (existing == null) {
                    int color = BrowserStore.GROUP_COLORS[groups.size() % BrowserStore.GROUP_COLORS.length];
                    result = new BrowserStore.Group(java.util.UUID.randomUUID().toString(), name, color);
                    groups.add(result);
                } else {
                    for (BrowserStore.Group group : groups) if (group.id.equals(existing.id)) { group.name = name; result = group; }
                }
                store.saveGroups(groups);
                if (result != null && callback != null) callback.done(result);
            })
            .show();
    }

    private void editGroup(final BrowserStore.Group group) {
        String[] actions = { "Rename", "Close all tabs in group", "Ungroup tabs", "Delete group" };
        dialogBuilder()
            .setTitle(group.name)
            .setItems(actions, (d, which) -> {
                if (which == 0) { promptGroupName(group, renamed -> showGroupsDialog()); return; }
                if (which == 1) {
                    for (BrowserTab tab : new ArrayList<>(tabs)) if (group.id.equals(tab.groupId)) closeTab(tab);
                    if (isFinishing()) return;
                }
                if (which >= 2) {
                    for (BrowserTab tab : tabs) if (group.id.equals(tab.groupId)) tab.groupId = null;
                }
                if (which == 3) {
                    List<BrowserStore.Group> groups = store.groups();
                    for (java.util.Iterator<BrowserStore.Group> it = groups.iterator(); it.hasNext();) if (it.next().id.equals(group.id)) it.remove();
                    store.saveGroups(groups);
                    if (group.id.equals(groupFilter)) groupFilter = null;
                }
                saveSession();
                showGroupsDialog();
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /** Long-press on a tab in the switcher: move it into a group. */
    private void chooseGroupForTab(final BrowserTab tab, final Runnable after) {
        if (tab.incognito) { toast("Incognito tabs can't join a group"); return; }
        final List<BrowserStore.Group> groups = store.groups();
        List<String> rows = new ArrayList<>();
        for (BrowserStore.Group group : groups) rows.add((group.id.equals(tab.groupId) ? "\u2713 " : "\u25cf ") + group.name);
        rows.add("+ New group");
        if (tab.groupId != null) rows.add("Remove from group");
        dialogBuilder()
            .setTitle("Add \"" + tab.label() + "\" to group")
            .setItems(rows.toArray(new String[0]), (d, which) -> {
                if (which < groups.size()) { tab.groupId = groups.get(which).id; saveSession(); after.run(); }
                else if (which == groups.size()) promptGroupName(null, created -> { tab.groupId = created.id; saveSession(); after.run(); });
                else { tab.groupId = null; saveSession(); after.run(); }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    // ======================= auto-delete & settings =======================

    /** Auto-delete, run on start and on resume: closes tabs unused for the
     *  chosen window and prunes history older than its retention window. */
    private void runAutoDelete() {
        if (store == null) return;
        long now = System.currentTimeMillis();
        store.pruneHistory(now);
        int days = store.autoCloseTabsDays();
        if (days <= 0) return;
        int closed = 0;
        for (BrowserTab tab : new ArrayList<>(tabs)) {
            if (tab == current || tabs.size() <= 1) continue;
            if (BrowserLogic.isExpired(tab.lastActive, now, days)) { closeTab(tab); closed++; }
        }
        if (closed > 0) { saveSession(); toast(closed == 1 ? "Closed 1 unused tab" : "Closed " + closed + " unused tabs"); }
    }

    private static String daysLabel(int days, String never) {
        if (days <= 0) return never;
        if (days == 1) return "1 day";
        if (days == 7) return "1 week";
        if (days == 30) return "30 days";
        return days + " days";
    }

    private void showSettings() {
        String engineName = BrowserLogic.engine(store.searchEngine())[1];
        String[] rows = {
            "Auto-close unused tabs: " + daysLabel(store.autoCloseTabsDays(), "Never"),
            "Keep history: " + daysLabel(store.historyDays(), "Forever"),
            "Clear history on exit: " + (store.clearOnExit() ? "On" : "Off"),
            "Restore tabs on start: " + (store.restoreTabs() ? "On" : "Off"),
            "Search engine: " + engineName,
            "Home page: " + (store.homePage().isEmpty() ? "Not set" : BrowserLogic.displayHost(store.homePage())),
            "Default text size: " + store.textZoom() + "%",
        };
        android.app.AlertDialog.Builder builder = dialogBuilder()
            .setTitle("Browser settings")
            .setItems(rows, (d, which) -> onSettingPicked(which))
            .setNegativeButton("Close", null);
        moreSettings(builder);
        builder.show();
    }

    /** Hook for later stages: extra settings buttons. */
    private void moreSettings(android.app.AlertDialog.Builder builder) {
        builder.setNeutralButton("Appearance", (d, w) -> showAppearance());
    }

    // ======================= appearance (user customisation) =======================

    /**
     * One sheet for everything visual: theme mode, accent colour, start-page
     * backdrop, tab switcher layout and toolbar position. Every pick is saved
     * immediately and the shell re-paints live behind the sheet.
     */
    private void showAppearance() {
        final android.app.AlertDialog[] holder = new android.app.AlertDialog[1];
        ScrollView scroll = new ScrollView(this);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(20), dp(4), dp(20), dp(8));
        scroll.addView(body);

        body.addView(sectionLabel("Theme"));
        String mode = store.themeMode();
        String[] modeValues = BrowserTheme.MODES;
        LinearLayout modes = optionRow();
        for (int i = 0; i < modeValues.length; i++) {
            final String value = modeValues[i];
            modes.addView(optionChip(BrowserTheme.MODE_LABELS[i], value.equals(mode), v -> {
                store.setThemeMode(value); appearanceChanged(holder[0]);
            }), weighted());
        }
        body.addView(modes);

        body.addView(sectionLabel("Accent colour"));
        LinearLayout accents = optionRow();
        for (int i = 0; i < BrowserTheme.ACCENTS.length; i++) {
            final int index = i;
            Object[] a = BrowserTheme.ACCENTS[i];
            int color = (Integer) (theme.dark ? a[2] : a[1]);
            accents.addView(swatch(color, color, (String) a[0], i == store.accentIndex(), v -> {
                store.setAccentIndex(index); appearanceChanged(holder[0]);
            }), swatchParams());
        }
        body.addView(accents);

        body.addView(sectionLabel("Start page background"));
        LinearLayout backdrops = optionRow();
        for (int i = 0; i < BrowserTheme.BACKDROPS.length; i++) {
            final int index = i;
            Object[] b = BrowserTheme.BACKDROPS[i];
            int top = (Integer) b[1] == 0 ? theme.surface : (Integer) b[1];
            int bottom = (Integer) b[2] == 0 ? theme.surface2 : (Integer) b[2];
            backdrops.addView(swatch(top, bottom, (String) b[0], i == store.backdropIndex(), v -> {
                store.setBackdropIndex(index); appearanceChanged(holder[0]);
            }), swatchParams());
        }
        body.addView(backdrops);

        body.addView(sectionLabel("Tab switcher"));
        LinearLayout layouts = optionRow();
        boolean grid = !"list".equals(store.tabLayout());
        layouts.addView(optionChip("\u25a6  Preview grid", grid, v -> { store.setTabLayout("grid"); appearanceChanged(holder[0]); }), weighted());
        layouts.addView(optionChip("\u2630  Compact list", !grid, v -> { store.setTabLayout("list"); appearanceChanged(holder[0]); }), weighted());
        body.addView(layouts);

        body.addView(sectionLabel("Toolbar position"));
        LinearLayout positions = optionRow();
        boolean bottomBar = "bottom".equals(store.toolbarPosition());
        positions.addView(optionChip("Top", !bottomBar, v -> { store.setToolbarPosition("top"); appearanceChanged(holder[0]); }), weighted());
        positions.addView(optionChip("Bottom", bottomBar, v -> { store.setToolbarPosition("bottom"); appearanceChanged(holder[0]); }), weighted());
        body.addView(positions);

        holder[0] = dialogBuilder()
            .setTitle("Appearance")
            .setView(scroll)
            .setPositiveButton("Done", null)
            .show();
    }

    private void appearanceChanged(android.app.AlertDialog sheet) {
        if (sheet != null) sheet.dismiss();
        rebuildShell();
        showAppearance();
    }

    private TextView sectionLabel(String text) {
        TextView label = new TextView(this);
        label.setText(text);
        label.setTextColor(theme.muted);
        label.setTextSize(12.5f);
        label.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        label.setPadding(0, dp(16), 0, dp(8));
        return label;
    }

    private LinearLayout optionRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private LinearLayout.LayoutParams weighted() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(40), 1);
        params.setMargins(dp(3), 0, dp(3), 0);
        return params;
    }

    private LinearLayout.LayoutParams swatchParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(32), dp(32));
        params.setMargins(dp(3), 0, dp(3), 0);
        return params;
    }

    private TextView optionChip(String label, boolean selected, View.OnClickListener onClick) {
        TextView chip = new TextView(this);
        chip.setText(label);
        chip.setGravity(Gravity.CENTER);
        chip.setTextSize(13);
        chip.setSingleLine(true);
        chip.setTextColor(selected ? theme.onAccent : theme.text);
        chip.setBackground(rounded(selected ? theme.accent : theme.surface, dp(20), selected ? 0 : theme.border));
        chip.setOnClickListener(onClick);
        return chip;
    }

    private View swatch(int top, int bottom, String name, boolean selected, View.OnClickListener onClick) {
        TextView dot = new TextView(this);
        android.graphics.drawable.GradientDrawable fill = new android.graphics.drawable.GradientDrawable(
            android.graphics.drawable.GradientDrawable.Orientation.TL_BR, new int[] { top, bottom });
        fill.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        if (selected) fill.setStroke(dp(3), theme.text);
        dot.setBackground(fill);
        dot.setGravity(Gravity.CENTER);
        dot.setText(selected ? "\u2713" : "");
        dot.setTextColor(Color.WHITE);
        dot.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        dot.setContentDescription(name + (selected ? ", selected" : ""));
        dot.setOnClickListener(onClick);
        return dot;
    }

    private void onSettingPicked(int which) {
        switch (which) {
            case 0: pickDays("Auto-close tabs not used for", new int[] { 1, 7, 30, 0 }, new String[] { "1 day", "1 week", "30 days", "Never" },
                store.autoCloseTabsDays(), days -> { store.setAutoCloseTabsDays(days); runAutoDelete(); }); break;
            case 1: pickDays("Delete history older than", new int[] { 1, 7, 30, 0 }, new String[] { "1 day", "1 week", "30 days", "Never (keep forever)" },
                store.historyDays(), days -> { store.setHistoryDays(days); store.pruneHistory(System.currentTimeMillis()); }); break;
            case 2: store.setClearOnExit(!store.clearOnExit()); showSettings(); break;
            case 3: store.setRestoreTabs(!store.restoreTabs()); showSettings(); break;
            case 4: pickSearchEngine(); break;
            case 5: promptHomePage(); break;
            case 6: showZoomDialog(); break;
            default: break;
        }
    }

    private interface DaysCallback { void done(int days); }

    private void pickDays(String title, final int[] values, String[] labels, int selected, final DaysCallback callback) {
        int checked = values.length - 1;
        for (int i = 0; i < values.length; i++) if (values[i] == selected) checked = i;
        dialogBuilder()
            .setTitle(title)
            .setSingleChoiceItems(labels, checked, (d, which) -> { d.dismiss(); callback.done(values[which]); showSettings(); })
            .setNegativeButton("Cancel", null)
            .show();
    }

    private void pickSearchEngine() {
        final String[][] engines = BrowserLogic.SEARCH_ENGINES;
        String[] labels = new String[engines.length];
        int checked = 0;
        for (int i = 0; i < engines.length; i++) {
            labels[i] = engines[i][1];
            if (engines[i][0].equals(store.searchEngine())) checked = i;
        }
        dialogBuilder()
            .setTitle("Search engine")
            .setSingleChoiceItems(labels, checked, (d, which) -> { d.dismiss(); store.setSearchEngine(engines[which][0]); showSettings(); })
            .setNegativeButton("Cancel", null)
            .show();
    }


    // ======================= extras: incognito, home page, zoom =======================

    /** New tab: opens the home page when one is set, else asks for an address. */
    private void openNewTab(boolean incognito) {
        String home = store.homePage();
        if (home.isEmpty()) { promptForAddress(true, incognito); return; }
        Uri target;
        try { target = validatedHttps(home); }
        catch (Exception error) { promptForAddress(true, incognito); return; }
        allowSite(target.getHost(), target.getPort());
        openTab(target.toString(), incognito);
        if (incognito) toast("Incognito tab: no history, cookies cleared when closed");
    }

    private void goHome() {
        String home = store.homePage();
        if (home.isEmpty()) { promptHomePage(); return; }
        allowAndLoad(home);
    }

    private void promptHomePage() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("https://example.com");
        String home = store.homePage();
        input.setText(home.isEmpty() ? (lastUrl == null ? "" : lastUrl) : home);
        FrameLayout wrapper = new FrameLayout(this);
        wrapper.setPadding(dp(20), dp(8), dp(20), 0);
        wrapper.addView(input, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialogBuilder()
            .setTitle("Home page")
            .setView(wrapper)
            .setNeutralButton("Clear", (d, w) -> { store.setHomePage(""); toast("Home page cleared"); })
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save", (d, w) -> {
                String typed = input.getText() == null ? "" : input.getText().toString().trim();
                String url = BrowserLogic.resolveInput(typed, store.searchEngine());
                if (url == null) { toast("Enter a web address"); return; }
                try { store.setHomePage(validatedHttps(url).toString()); toast("Home page saved"); }
                catch (Exception error) { toast(error.getMessage()); }
            })
            .show();
    }

    private static final int[] ZOOM_STEPS = { 75, 90, 100, 110, 125, 150, 175, 200 };

    private void showZoomDialog() {
        final String[] labels = new String[ZOOM_STEPS.length];
        int now = webView == null ? store.textZoom() : webView.getSettings().getTextZoom();
        int checked = 2;
        for (int i = 0; i < ZOOM_STEPS.length; i++) {
            labels[i] = ZOOM_STEPS[i] + "%";
            if (ZOOM_STEPS[i] == now) checked = i;
        }
        dialogBuilder()
            .setTitle("Zoom (text size)")
            .setSingleChoiceItems(labels, checked, (d, which) -> {
                d.dismiss();
                int zoom = ZOOM_STEPS[which];
                store.setTextZoom(zoom);
                for (BrowserTab tab : tabs) if (tab.view != null) tab.view.getSettings().setTextZoom(zoom);
                toast("Zoom " + zoom + "%");
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    // ---------- find in page ----------
    private LinearLayout buildFindBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(theme.chrome);
        bar.setPadding(dp(8), dp(4), dp(6), dp(6));
        findInput = new EditText(this);
        findInput.setSingleLine(true);
        findInput.setHint("Find in page");
        findInput.setTextColor(theme.text);
        findInput.setHintTextColor(theme.muted);
        findInput.setTextSize(14);
        findInput.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        findInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        findInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                if (webView == null) return;
                String query = s == null ? "" : s.toString();
                if (query.isEmpty()) { webView.clearMatches(); if (findCount != null) findCount.setText(""); }
                else webView.findAllAsync(query);
            }
        });
        findInput.setOnEditorActionListener((view, actionId, event) -> {
            if (webView != null) webView.findNext(true);
            return true;
        });
        bar.addView(findInput, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        findCount = new TextView(this);
        findCount.setTextColor(theme.muted);
        findCount.setTextSize(12);
        findCount.setPadding(dp(6), 0, dp(6), 0);
        bar.addView(findCount, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        bar.addView(chromeButton("\u25b2", "Previous match", view -> { if (webView != null) webView.findNext(false); }),
            new LinearLayout.LayoutParams(dp(36), dp(36)));
        LinearLayout.LayoutParams next = new LinearLayout.LayoutParams(dp(36), dp(36));
        next.setMargins(dp(4), 0, dp(4), 0);
        bar.addView(chromeButton("\u25bc", "Next match", view -> { if (webView != null) webView.findNext(true); }), next);
        bar.addView(chromeButton("\u2715", "Close find bar", view -> hideFindBar()), new LinearLayout.LayoutParams(dp(36), dp(36)));
        return bar;
    }

    private void showFindBar() {
        if (findBar == null || findInput == null) return;
        findBar.setVisibility(View.VISIBLE);
        findInput.requestFocus();
        try {
            android.view.inputmethod.InputMethodManager imm =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(findInput, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        } catch (Throwable ignored) {}
        String query = findInput.getText() == null ? "" : findInput.getText().toString();
        if (!query.isEmpty() && webView != null) webView.findAllAsync(query);
    }

    private void hideFindBar() {
        if (findBar == null) return;
        findBar.setVisibility(View.GONE);
        if (webView != null) webView.clearMatches();
        if (findCount != null) findCount.setText("");
        try {
            android.view.inputmethod.InputMethodManager imm =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null && findInput != null) imm.hideSoftInputFromWindow(findInput.getWindowToken(), 0);
        } catch (Throwable ignored) {}
    }

    // ---------- translate ----------
    private void chooseTranslateLanguage() {
        final String page = currentUrl();
        if (page == null) { toast("Open a page first"); return; }
        if (BrowserLogic.isTranslatedHost(BrowserLogic.host(page))) { toast("This page is already translated"); return; }
        final String[][] languages = BrowserLogic.TRANSLATE_LANGUAGES;
        String[] labels = new String[languages.length];
        int checked = 0;
        String saved = store.translateLanguage();
        for (int i = 0; i < languages.length; i++) {
            labels[i] = languages[i][1];
            if (languages[i][0].equalsIgnoreCase(saved)) checked = i;
        }
        dialogBuilder()
            .setTitle("Translate page to")
            .setSingleChoiceItems(labels, checked, (dialog, which) -> {
                dialog.dismiss();
                String lang = languages[which][0];
                store.setTranslateLanguage(lang);
                translatePage(page, lang);
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    private void translatePage(String page, String lang) {
        // Google's translate proxy serves the page from <site>.translate.goog —
        // an explicit user choice, so those hosts join the boundary.
        allowedHosts.add("translate.google.com:443");
        allowedHosts.add("*.translate.goog:443");
        allowedHosts.add("translate.goog:443");
        allowedHosts.add("*.google.com:443");
        allowedHosts.add("google.com:443");
        if (webView != null) webView.loadUrl(BrowserLogic.translateUrl(page, lang));
    }

    // ---------- share ----------
    private void sharePage() {
        String page = currentUrl();
        if (page == null) { toast("Nothing to share yet"); return; }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        String title = webView == null ? null : webView.getTitle();
        if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.putExtra(Intent.EXTRA_TEXT, page);
        try { startActivity(Intent.createChooser(send, "Share page")); }
        catch (Throwable error) { toast("No app can share this page"); }
    }

    // ---------- desktop site ----------
    private void applyDesktopMode(WebView view, boolean desktop) {
        if (view == null) return;
        WebSettings settings = view.getSettings();
        settings.setUserAgentString(desktop ? BrowserLogic.desktopUserAgent(mobileUa) : mobileUa);
        settings.setUseWideViewPort(desktop);
        settings.setLoadWithOverviewMode(desktop);
    }

    private void toggleDesktopMode() {
        if (current == null) return;
        current.desktop = !current.desktop;
        applyDesktopMode(webView, current.desktop);
        if (webView != null) webView.reload();
        toast(current.desktop ? "Desktop site on" : "Desktop site off");
    }

    // ---------- reader mode ----------
    private void toggleReaderMode() {
        if (webView == null) return;
        if (!ReaderMode.toggle(webView, this)) toast("Reader mode is unavailable");
    }

    // ---------- bookmarks & history ----------
    private void toggleBookmark() {
        String page = currentUrl();
        if (page == null) { toast("Open a page first"); return; }
        String title = webView == null ? "" : webView.getTitle();
        boolean added = store.toggleBookmark(page, title);
        toast(added ? "Bookmark added" : "Bookmark removed");
    }

    private void showEntries(String title, boolean bookmarks) {
        final List<BrowserStore.Entry> entries = bookmarks ? store.bookmarks() : store.history();
        if (entries.isEmpty()) { toast(bookmarks ? "No bookmarks yet" : "History is empty"); return; }
        String[] rows = new String[entries.size()];
        java.text.DateFormat format = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT);
        for (int i = 0; i < entries.size(); i++) {
            BrowserStore.Entry entry = entries.get(i);
            String name = entry.title.isEmpty() ? BrowserLogic.prettyUrl(entry.url) : entry.title;
            String sub = BrowserLogic.displayHost(entry.url) + (bookmarks ? "" : " \u00b7 " + format.format(new java.util.Date(entry.time)));
            rows[i] = name + "\n" + sub;
        }
        android.app.AlertDialog.Builder builder = dialogBuilder()
            .setTitle(title)
            .setItems(rows, (dialog, which) -> allowAndLoad(entries.get(which).url))
            .setNegativeButton("Close", null);
        if (!bookmarks) builder.setNeutralButton("Clear history", (dialog, which) -> { store.clearHistory(); toast("History cleared"); });
        android.app.AlertDialog dialog = builder.create();
        dialog.setOnShowListener(shown -> {
            android.widget.ListView list = dialog.getListView();
            if (list == null) return;
            list.setOnItemLongClickListener((parent, view, position, id) -> {
                BrowserStore.Entry entry = entries.get(position);
                if (bookmarks) store.removeBookmark(entry.url); else store.removeHistory(entry.url);
                toast(bookmarks ? "Bookmark removed" : "Removed from history");
                dialog.dismiss();
                return true;
            });
        });
        dialog.show();
    }

    // Dark branded loading cover layered ON TOP of the WebView until its first
    // committed frame; identical treatment to the mini-app surface.
    private void installCover() {
        FrameLayout layout = new FrameLayout(this);
        layout.setBackground(backdrop());
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.addView(new ProgressBar(this), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView label = new TextView(this);
        label.setText("Loading page…");
        label.setTextColor(theme.muted);
        label.setTextSize(14);
        label.setPadding(0, dp(14), 0, 0);
        box.addView(label, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        layout.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        cover = layout;
        if (content != null) {
            content.addView(layout, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
    }

    private void reveal() {
        if (revealed || isFinishing()) return;
        revealed = true;
        WebView view = webView;
        FrameLayout loadingCover = cover;
        if (view == null) { removeCover(loadingCover); return; }
        try {
            view.setAlpha(0f);
            view.setVisibility(View.VISIBLE);
            view.animate().alpha(1f).setDuration(150).start();
        } catch (Throwable ignored) {}
        removeCover(loadingCover);
    }

    private void removeCover(FrameLayout loadingCover) {
        if (loadingCover == null) return;
        if (cover == loadingCover) cover = null;
        if (loadingCover.getParent() != content) return;
        try {
            loadingCover.animate().alpha(0f).setDuration(150).withEndAction(() -> {
                if (loadingCover.getParent() == content) content.removeView(loadingCover);
            }).start();
        } catch (Throwable ignored) {}
    }

    @SuppressLint("SetJavaScriptEnabled")
    /** Creates the tab's WebView, makes it the visible current tab and loads startUrl. */
    private void createWebView(final BrowserTab tab, String startUrl, boolean withCover) {
        final WebView webView = new WebView(this);
        tab.view = webView;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { WebViewCompat.setProfile(webView, tab.incognito ? PROFILE_INCOGNITO : PROFILE_NORMAL); }
            catch (Exception error) { report("partitionFallback", "remote URL profile partition is unavailable"); }
        }
        // Fresh incognito session: wipe anything an earlier one left behind.
        if (tab.incognito && !hasOtherIncognito(tab)) wipeIncognitoProfile(webView);
        current = tab;
        this.webView = webView;
        content.removeAllViews();
        cover = null;
        content.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Pre-paint surface: INVISIBLE under the cover until the first committed
        // frame; dark ground so no sub-frame white can escape.
        webView.setBackgroundColor(theme.ground);
        if (withCover) {
            revealed = false;
            webView.setVisibility(View.INVISIBLE);
            webView.setAlpha(0f);
        } else {
            revealed = true;
            webView.setVisibility(View.VISIBLE);
            webView.setAlpha(1f);
        }
        if (Build.VERSION.SDK_INT >= 26) {
            try { webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true); }
            catch (Throwable ignored) {}
        }
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // Sites like LinkedIn/Google refuse sign-in from embedded WebViews (the
        // "; wv" token in the default UA). Present as plain Chrome Mobile.
        String defaultUa = settings.getUserAgentString();
        if (defaultUa != null && defaultUa.contains("; wv")) {
            settings.setUserAgentString(defaultUa.replace("; wv", ""));
        }
        mobileUa = settings.getUserAgentString();
        tab.mobileUa = mobileUa;
        applyDesktopMode(webView, tab.desktop);
        settings.setTextZoom(store.textZoom());
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        webView.setFindListener((activeMatch, matches, done) -> {
            if (tab != current) return;
            if (findCount != null) findCount.setText(matches == 0 ? "0/0" : (activeMatch + 1) + "/" + matches);
        });
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        // Many OAuth flows (Google/Apple sign-in buttons) use window.open();
        // with multi-window off this navigates the SAME controlled WebView.
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.setDownloadListener((url, userAgent, disposition, type, length) -> {
            report("blocked", "browser download blocked");
            try { Toast.makeText(this, "Downloads are blocked by NativeKit policy", Toast.LENGTH_SHORT).show(); } catch (Throwable ignored) {}
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
            @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) { callback.onReceiveValue(null); return true; }
            @Override public void onReceivedTitle(WebView view, String title) {
                if (title != null) tab.title = title;
                if (store != null && !tab.incognito) store.updateHistoryTitle(view.getUrl(), title);
            }
            @Override public void onProgressChanged(WebView view, int newProgress) {
                if (tab != current) return;
                ProgressBar bar = progress;
                if (bar == null) return;
                bar.setProgress(Math.max(0, Math.min(100, newProgress)));
                bar.setVisibility(newProgress >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
            // Fullscreen <video> on video sites (YouTube etc.): without these the
            // fullscreen button does nothing at all in the remote browser.
            @Override public void onShowCustomView(View view, WebChromeClient.CustomViewCallback callback) {
                if (customView != null) { try { callback.onCustomViewHidden(); } catch (Throwable ignored) {} return; }
                customView = view;
                customViewCallback = callback;
                try {
                    content.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    view.bringToFront();
                } catch (Throwable error) {
                    exitCustomView();
                }
            }
            @Override public void onHideCustomView() {
                View view = customView;
                customView = null;
                WebChromeClient.CustomViewCallback callback = customViewCallback;
                customViewCallback = null;
                if (view != null && view.getParent() instanceof ViewGroup) {
                    try { ((ViewGroup) view.getParent()).removeView(view); } catch (Throwable ignored) {}
                }
                if (callback != null) { try { callback.onCustomViewHidden(); } catch (Throwable ignored) {} }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !isAllowed(request.getUrl());
                if (!isAllowed(request.getUrl())) {
                    if (tab != current) return true;
                    // Cross-site hop (e.g. LinkedIn -> Microsoft sign-in): the user
                    // decides — a silent blank page helps nobody and hides attacks.
                    report("prompted", "cross-site navigation awaiting user approval");
                    showNavigationPrompt(request.getUrl());
                    return true;
                }
                return false;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                tab.url = url;
                tab.loading = true;
                if (tab != current) return;
                lastUrl = url;
                dismissHttpBanner();
                syncChrome();
                armLoadTimeout(url);
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                // Earliest point guaranteed to draw the NEW page — reveal + fade in.
                if (tab != current) return;
                cancelLoadTimeout();
                reveal();
            }
            @Override public void onPageFinished(WebView view, String url) {
                // Fallback: never leave the user stuck on the loading cover.
                tab.url = url;
                tab.loading = false;
                String pageTitle = view.getTitle();
                if (pageTitle != null) tab.title = pageTitle;
                if (store != null && !tab.incognito) store.addHistory(url, pageTitle);
                if (tab.devtools) DevConsole.show(view, RemoteBrowserActivity.this, theme.dark, false);
                if (tab != current) return;
                lastUrl = url;
                cancelLoadTimeout();
                syncChrome();
                reveal();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame() || tab != current) return; // subresource failures are normal
                CharSequence raw = error == null ? null : error.getDescription();
                String description = raw == null ? "network error" : raw.toString();
                if (description.contains("ERR_ABORTED")) return; // user navigated away mid-load
                cancelLoadTimeout();
                String reason = description + " (code " + (error == null ? "?" : error.getErrorCode()) + ")";
                report("netError", reason);
                showLoadError("This page could not load", reason + " — the network, DNS or the site itself refused the connection.");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (!request.isForMainFrame() || tab != current) return; // assets 404 constantly; ignore
                int code = response == null ? 0 : response.getStatusCode();
                if (code < 400) return;
                String phrase = response != null && response.getReasonPhrase() != null ? " " + response.getReasonPhrase() : "";
                report("httpError", "HTTP " + code);
                showHttpBanner("HTTP " + code + phrase + " — the site may block in-app browsers or this region.");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); if (tab != current) return; report("blocked", "TLS certificate error"); showLoadError("Secure connection failed", "The TLS certificate of this site is not trusted (blocked)."); }
            @Override public void onSafeBrowsingHit(WebView view, WebResourceRequest request, int threatType, SafeBrowsingResponse callback) {
                // Never a silent bounce-back: the user decides, eyes open.
                if (tab != current) { try { callback.backToSafety(true); } catch (Throwable ignored) {} return; }
                report("safeBrowsingPrompted", "threat " + threatType);
                showSafeBrowsingPrompt(threatType, callback);
            }
        });
        if (withCover) installCover();
        // In-page agent on every remote page ("url open korlew jeno agent browser
        // thake"): the bundle is injected at document start and its model calls
        // are relayed natively — the page's own CSP cannot break it.
        tab.agent = PageAgentHost.install(
            webView,
            getApplicationContext(),
            agentEnabled,
            getIntent().getStringExtra(PageAgentHost.EXTRA_LANGUAGE),
            theme.dark,
            BrowserTheme.hex(theme.accent),
            tab.id);
        pageAgent = tab.agent;
        if (startUrl != null) webView.loadUrl(startUrl);
    }

    private boolean isAllowed(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort() < 0 ? 443 : uri.getPort();
        for (String rule : allowedHosts) {
            int separator = rule.lastIndexOf(':');
            String pattern = separator < 0 ? rule : rule.substring(0, separator);
            int expectedPort = separator < 0 ? 443 : Integer.parseInt(rule.substring(separator + 1));
            boolean matches = pattern.startsWith("*.")
                ? host.endsWith(pattern.substring(1)) && !host.equals(pattern.substring(2))
                : host.equals(pattern);
            if (matches && port == expectedPort) return true;
        }
        return false;
    }

    /** Common second-level suffixes where the registrable domain is 3 labels
     *  (com.bd, co.uk, com.br, ...); everywhere else it is the last 2 labels. */
    private static final Set<String> SECOND_LEVEL_SUFFIXES = new HashSet<>(Arrays.asList(
        "com", "net", "org", "gov", "edu", "co", "ac", "or", "ne", "gv", "info", "biz", "name", "web"));

    private static String registrableSite(String host) {
        if (host == null) return null;
        String[] labels = host.toLowerCase(Locale.ROOT).split("\\.");
        if (labels.length <= 2) return host;
        String middle = labels[labels.length - 2];
        if (SECOND_LEVEL_SUFFIXES.contains(middle) && labels.length >= 3) {
            return labels[labels.length - 3] + "." + middle + "." + labels[labels.length - 1];
        }
        return middle + "." + labels[labels.length - 1];
    }

    /** Inline approval bar for cross-site navigations (never a silent blank). */
    private void showNavigationPrompt(Uri target) {
        if (content == null || target == null || target.getHost() == null) return;
        FrameLayout prompt = new FrameLayout(this);
        prompt.setBackgroundColor(Color.rgb(124, 45, 18));
        prompt.setTag("navPrompt");
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(6), dp(8), dp(6));
        TextView label = new TextView(this);
        String host = target.getHost().toLowerCase(Locale.ROOT);
        label.setText("This site wants to continue on " + host + ".");
        label.setTextColor(Color.WHITE);
        label.setTextSize(13);
        label.setSingleLine(true);
        row.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button allow = new Button(this);
        allow.setText("Allow");
        allow.setOnClickListener(view -> {
            dismissNavigationPrompt();
            allowedHosts.add(host + ":443");
            String site = registrableSite(host);
            if (site != null) { allowedHosts.add(site + ":443"); allowedHosts.add("*." + site + ":443"); }
            report("allowed", "user approved navigation to " + host);
            if (webView != null) webView.loadUrl(target.toString());
        });
        row.addView(allow, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        Button deny = new Button(this);
        deny.setText("Keep out");
        deny.setOnClickListener(view -> {
            dismissNavigationPrompt();
            report("blocked", "user declined navigation to " + host);
        });
        row.addView(deny, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        prompt.addView(row, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dismissNavigationPrompt();
        content.addView(prompt, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
    }

    private void dismissNavigationPrompt() {
        if (content == null) return;
        for (int index = content.getChildCount() - 1; index >= 0; index -= 1) {
            if ("navPrompt".equals(content.getChildAt(index).getTag())) content.removeViewAt(index);
        }
    }

    // ---------- load timeout (silent ISP drops / blackholed networks) --------
    private void armLoadTimeout(String url) {
        cancelLoadTimeout();
        final String host = Uri.parse(url).getHost() == null ? url : Uri.parse(url).getHost();
        loadTimeout = () -> {
            loadTimeout = null;
            if (isFinishing() || webView == null) return;
            report("timeout", "no data within " + (LOAD_TIMEOUT_MS / 1000) + "s");
            showLoadError("This site did not respond",
                host + " sent nothing for 25 seconds. The network may be blocking or filtering this site (common for ISP-filtered content), or the site is down.");
        };
        handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
    }

    private void cancelLoadTimeout() {
        if (loadTimeout != null) {
            handler.removeCallbacks(loadTimeout);
            loadTimeout = null;
        }
    }

    /** Slim top banner for HTTP-level main-document failures (403 bot walls,
     *  451 legal blocks, 404s that still render content) — the page stays. */
    private void showHttpBanner(String text) {
        if (content == null) return;
        dismissHttpBanner();
        FrameLayout banner = new FrameLayout(this);
        banner.setBackgroundColor(Color.rgb(124, 45, 18));
        banner.setTag("httpBanner");
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(6), dp(8), dp(6));
        TextView label = new TextView(this);
        label.setText(text);
        label.setTextColor(Color.WHITE);
        label.setTextSize(13);
        label.setSingleLine(true);
        row.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button dismiss = new Button(this);
        dismiss.setText("Dismiss");
        dismiss.setOnClickListener(view -> dismissHttpBanner());
        row.addView(dismiss, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        banner.addView(row, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(banner, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
    }

    private void dismissHttpBanner() {
        if (content == null) return;
        for (int index = content.getChildCount() - 1; index >= 0; index -= 1) {
            if ("httpBanner".equals(content.getChildAt(index).getTag())) content.removeViewAt(index);
        }
    }

    /** Full-page dark error screen with the REAL reason + Retry/Close. */
    private void showLoadError(String title, String detail) {
        if (content == null || isFinishing()) return;
        dismissNavigationPrompt();
        dismissHttpBanner();
        cancelLoadTimeout();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(24), dp(24), dp(24), dp(24));
        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextColor(theme.text);
        heading.setTextSize(17);
        heading.setGravity(Gravity.CENTER);
        box.addView(heading, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView body = new TextView(this);
        body.setText(detail);
        body.setTextColor(theme.muted);
        body.setTextSize(13);
        body.setGravity(Gravity.CENTER);
        body.setPadding(0, dp(8), 0, dp(16));
        box.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Button retry = new Button(this);
        retry.setText("Retry");
        retry.setEnabled(lastUrl != null);
        retry.setOnClickListener(view -> {
            String again = lastUrl;
            if (again == null) return;
            BrowserTab tab = current;
            if (tab == null) return;
            destroyTabView(tab);
            tab.url = again;
            showTab(tab, true);
        });
        box.addView(retry, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Button close = new Button(this);
        close.setText("Close");
        close.setOnClickListener(view -> finish());
        box.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.removeAllViews();
        content.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** Safe Browsing: an explicit, visible Continue / Go back choice. */
    private void showSafeBrowsingPrompt(int threatType, SafeBrowsingResponse decision) {
        if (content == null || decision == null) { try { decision.backToSafety(true); } catch (Throwable ignored) {} return; }
        FrameLayout prompt = new FrameLayout(this);
        prompt.setBackgroundColor(Color.rgb(124, 45, 18));
        prompt.setTag("safePrompt");
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(6), dp(8), dp(6));
        TextView label = new TextView(this);
        label.setText("Safe Browsing flagged this site (threat " + threatType + ").");
        label.setTextColor(Color.WHITE);
        label.setTextSize(13);
        label.setSingleLine(true);
        row.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button proceed = new Button(this);
        proceed.setText("Continue");
        proceed.setOnClickListener(view -> {
            removeView(prompt);
            report("safeBrowsingContinued", "user continued past threat " + threatType);
            try { decision.proceed(true); } catch (Throwable ignored) {}
        });
        row.addView(proceed, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        Button back = new Button(this);
        back.setText("Go back");
        back.setOnClickListener(view -> {
            removeView(prompt);
            report("safeBrowsingBlocked", "user went back from threat " + threatType);
            try { decision.backToSafety(true); } catch (Throwable ignored) {}
        });
        row.addView(back, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        prompt.addView(row, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(prompt, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
    }

    private void removeView(View view) {
        if (view != null && view.getParent() instanceof ViewGroup) {
            try { ((ViewGroup) view.getParent()).removeView(view); } catch (Throwable ignored) {}
        }
    }

    private void exitCustomView() {
        View view = customView;
        customView = null;
        WebChromeClient.CustomViewCallback callback = customViewCallback;
        customViewCallback = null;
        removeView(view);
        if (callback != null) { try { callback.onCustomViewHidden(); } catch (Throwable ignored) {} }
    }

    private static Uri validatedHttps(String value) {
        Uri uri = Uri.parse(value);
        if (!uri.isHierarchical() || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) throw new IllegalArgumentException("Remote URL mode accepts HTTPS URLs without embedded credentials only");
        return uri;
    }

    private static String validateRule(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        if (value.length() > 260 || !HOST_RULE.matcher(value).matches()) throw new IllegalArgumentException("Invalid remote URL host rule");
        int separator = value.lastIndexOf(':');
        if (separator >= 0) {
            int port = Integer.parseInt(value.substring(separator + 1));
            if (port < 1 || port > 65_535) throw new IllegalArgumentException("Invalid remote URL host port");
        }
        return value;
    }

    private static String hostAndPort(Uri uri) {
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return uri.getPort() < 0 || uri.getPort() == 443 ? host : host + ":" + uri.getPort();
    }

    private void report(String state, String reason) {
        if (resultReceiver == null || (reported && "closed".equals(state))) return;
        Bundle data = new Bundle();
        data.putString("sessionId", sessionId);
        data.putString("state", state);
        data.putString("reason", reason == null ? "" : reason);
        resultReceiver.send(0, data);
        if ("closed".equals(state)) reported = true;
    }

    private void showFailure(String message) {
        if (content == null) return;
        TextView text = new TextView(this);
        text.setText(message);
        text.setTextColor(theme.text);
        text.setTextSize(17);
        text.setGravity(Gravity.CENTER);
        text.setPadding(dp(24), dp(24), dp(24), dp(24));
        content.removeAllViews();
        content.addView(text, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** Destroys every tab's WebView (session end / replacement). */
    private void destroyWebView() {
        cancelLoadTimeout();
        exitCustomView();
        for (BrowserTab tab : new ArrayList<>(tabs)) { destroyTabView(tab); PageAgentHost.forgetSession(tab.id); }
        tabs.clear();
        current = null;
        webView = null;
        pageAgent = null;
    }

    private void destroyTabView(BrowserTab tab) {
        WebView view = tab == null ? null : tab.view;
        if (view == null) return;
        tab.view = null;
        tab.agent = null;
        if (view == webView) { webView = null; pageAgent = null; }
        if (tab.incognito) {
            try { view.clearHistory(); view.clearCache(true); view.clearFormData(); } catch (Exception ignored) {}
        }
        try { view.stopLoading(); } catch (Exception ignored) {}
        try { view.loadUrl("about:blank"); } catch (Exception ignored) {}
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        if (tab.incognito && !hasOtherIncognito(tab)) wipeIncognitoProfile(view);
        try { view.destroy(); } catch (Exception ignored) {}
    }

    @Override public void onBackPressed() {
        if (customView != null) { exitCustomView(); return; }
        if (webView != null && webView.canGoBack()) { webView.goBack(); syncChrome(); return; }
        if (tabs.size() > 1 && current != null) { closeTab(current); return; }
        super.onBackPressed();
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // "Follow system" re-paints live when the device switches light/dark.
        if (shellBuilt && theme != null && store != null && "system".equals(store.themeMode())) {
            if (BrowserTheme.resolve(this, store).dark != theme.dark) rebuildShell();
        }
    }

    @Override protected void onResume() {
        super.onResume();
        ScreenRecordService.listener = this::updateRecIndicator;
        updateRecIndicator();
        if (!tabs.isEmpty()) runAutoDelete();
    }

    @Override protected void onPause() {
        captureThumb(current);
        super.onPause();
        saveSession();
    }

    @Override protected void onDestroy() {
        ScreenRecordService.listener = null;
        handler.removeCallbacks(recTick);
        report("closed", "browser-only URL session closed");
        saveSession();
        if (isFinishing() && store != null && store.clearOnExit()) {
            store.clearHistory();
            for (BrowserTab tab : tabs) if (tab.view != null) { try { tab.view.clearHistory(); } catch (Throwable ignored) {} }
        }
        destroyWebView();
        super.onDestroy();
    }

    private static String required(Intent intent, String key) {
        String value = intent.getStringExtra(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing " + key);
        return value;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
