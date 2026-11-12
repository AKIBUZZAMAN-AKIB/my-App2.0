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
import android.widget.Toast;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;
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
        initialize(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ACTION_CLOSE.equals(intent.getAction()) && sessionId != null && sessionId.equals(intent.getStringExtra(EXTRA_SESSION_ID))) {
            finish();
            return;
        }
        report("closed", "replaced by another browser-only URL session");
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
            createWebView(start.toString());
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
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(SHELL_GROUND);
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setBackgroundColor(SHELL_CHROME);
        toolbar.setPadding(dp(6), dp(6), dp(6), dp(6));

        backButton = chromeButton("\u2039", "Back", view -> goBack());
        toolbar.addView(backButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        forwardButton = chromeButton("\u203a", "Forward", view -> { if (webView != null && webView.canGoForward()) webView.goForward(); });
        toolbar.addView(forwardButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        Button reload = chromeButton("\u21bb", "Reload", view -> { if (webView != null) webView.reload(); });
        toolbar.addView(reload, new LinearLayout.LayoutParams(dp(40), dp(40)));

        address = new TextView(this);
        address.setText(title);
        address.setTextColor(Color.rgb(226, 232, 240));
        address.setTextSize(13);
        address.setSingleLine(true);
        address.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        address.setGravity(Gravity.CENTER_VERTICAL);
        address.setPadding(dp(12), 0, dp(12), 0);
        address.setBackground(rounded(Color.rgb(17, 30, 49), dp(20), 0));
        address.setOnClickListener(view -> promptForAddress());
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(0, dp(38), 1);
        addressParams.setMargins(dp(2), 0, dp(2), 0);
        toolbar.addView(address, addressParams);

        Button close = chromeButton("\u2715", "Close browser", view -> finish());
        toolbar.addView(close, new LinearLayout.LayoutParams(dp(40), dp(40)));

        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgress(0);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));
        content = new FrameLayout(this);
        content.setBackgroundColor(SHELL_GROUND);
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        shellBuilt = true;
        ImeInsetsHelper.apply(root);
        syncChrome();
    }

    private static final int SHELL_GROUND = Color.rgb(7, 17, 31);
    private static final int SHELL_CHROME = Color.rgb(12, 22, 38);

    private Button chromeButton(String label, String description, View.OnClickListener onClick) {
        Button button = new Button(this);
        button.setText(label);
        button.setContentDescription(description);
        button.setTextColor(Color.rgb(226, 232, 240));
        button.setTextSize(16);
        button.setAllCaps(false);
        button.setPadding(0, 0, 0, 0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setBackground(rounded(Color.rgb(17, 30, 49), dp(20), 0));
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
        else finish();
    }

    /** The address pill is a real address bar: type an https: page and go. */
    private void promptForAddress() {
        final android.widget.EditText input = new android.widget.EditText(this);
        input.setSingleLine(true);
        input.setText(lastUrl == null ? "" : lastUrl);
        input.setSelection(input.getText().length());
        input.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://example.com");
        FrameLayout wrapper = new FrameLayout(this);
        wrapper.setPadding(dp(20), dp(8), dp(20), 0);
        wrapper.addView(input, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        new android.app.AlertDialog.Builder(this)
            .setTitle("Open address")
            .setView(wrapper)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Open", (dialog, which) -> {
                String raw = input.getText() == null ? "" : input.getText().toString().trim();
                if (raw.isEmpty()) return;
                if (!raw.contains("://")) raw = "https://" + raw;
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
                if (webView != null) webView.loadUrl(target.toString());
            })
            .show();
    }

    // Dark branded loading cover layered ON TOP of the WebView until its first
    // committed frame; identical treatment to the mini-app surface.
    private void installCover() {
        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(Color.rgb(7, 17, 31));
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.addView(new ProgressBar(this), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView label = new TextView(this);
        label.setText("Loading page…");
        label.setTextColor(Color.rgb(148, 163, 184));
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
    private void createWebView(String startUrl) {
        revealed = false;
        webView = new WebView(this);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { WebViewCompat.setProfile(webView, "nativekit_remote_url_v1"); }
            catch (Exception error) { report("partitionFallback", "remote URL profile partition is unavailable"); }
        }
        content.removeAllViews();
        content.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Pre-paint surface: INVISIBLE under the cover until the first committed
        // frame; dark ground so no sub-frame white can escape.
        webView.setBackgroundColor(Color.rgb(7, 17, 31));
        webView.setVisibility(View.INVISIBLE);
        webView.setAlpha(0f);
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
            @Override public void onProgressChanged(WebView view, int newProgress) {
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
                    // Cross-site hop (e.g. LinkedIn -> Microsoft sign-in): the user
                    // decides — a silent blank page helps nobody and hides attacks.
                    report("prompted", "cross-site navigation awaiting user approval");
                    showNavigationPrompt(request.getUrl());
                    return true;
                }
                return false;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                lastUrl = url;
                dismissHttpBanner();
                syncChrome();
                armLoadTimeout(url);
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                // Earliest point guaranteed to draw the NEW page — reveal + fade in.
                cancelLoadTimeout();
                reveal();
            }
            @Override public void onPageFinished(WebView view, String url) {
                // Fallback: never leave the user stuck on the loading cover.
                lastUrl = url;
                cancelLoadTimeout();
                syncChrome();
                reveal();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return; // subresource failures are normal
                CharSequence raw = error == null ? null : error.getDescription();
                String description = raw == null ? "network error" : raw.toString();
                if (description.contains("ERR_ABORTED")) return; // user navigated away mid-load
                cancelLoadTimeout();
                String reason = description + " (code " + (error == null ? "?" : error.getErrorCode()) + ")";
                report("netError", reason);
                showLoadError("This page could not load", reason + " — the network, DNS or the site itself refused the connection.");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (!request.isForMainFrame()) return; // assets 404 constantly; ignore
                int code = response == null ? 0 : response.getStatusCode();
                if (code < 400) return;
                String phrase = response != null && response.getReasonPhrase() != null ? " " + response.getReasonPhrase() : "";
                report("httpError", "HTTP " + code);
                showHttpBanner("HTTP " + code + phrase + " — the site may block in-app browsers or this region.");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); report("blocked", "TLS certificate error"); showLoadError("Secure connection failed", "The TLS certificate of this site is not trusted (blocked)."); }
            @Override public void onSafeBrowsingHit(WebView view, WebResourceRequest request, int threatType, SafeBrowsingResponse callback) {
                // Never a silent bounce-back: the user decides, eyes open.
                report("safeBrowsingPrompted", "threat " + threatType);
                showSafeBrowsingPrompt(threatType, callback);
            }
        });
        installCover();
        // In-page agent on every remote page ("url open korlew jeno agent browser
        // thake"): the bundle is injected at document start and its model calls
        // are relayed natively — the page's own CSP cannot break it.
        pageAgent = PageAgentHost.install(
            webView,
            getApplicationContext(),
            agentEnabled,
            getIntent().getStringExtra(PageAgentHost.EXTRA_LANGUAGE));
        webView.loadUrl(startUrl);
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
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(17);
        heading.setGravity(Gravity.CENTER);
        box.addView(heading, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView body = new TextView(this);
        body.setText(detail);
        body.setTextColor(Color.rgb(148, 163, 184));
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
            destroyWebView();
            createWebView(again);
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
        text.setTextColor(Color.rgb(30, 41, 59));
        text.setTextSize(17);
        text.setGravity(Gravity.CENTER);
        text.setPadding(dp(24), dp(24), dp(24), dp(24));
        content.removeAllViews();
        content.addView(text, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void destroyWebView() {
        cancelLoadTimeout();
        exitCustomView();
        WebView current = webView;
        webView = null;
        if (current == null) return;
        try { current.stopLoading(); } catch (Exception ignored) {}
        try { current.loadUrl("about:blank"); } catch (Exception ignored) {}
        if (current.getParent() instanceof ViewGroup) ((ViewGroup) current.getParent()).removeView(current);
        try { current.destroy(); } catch (Exception ignored) {}
    }

    @Override public void onBackPressed() {
        if (customView != null) { exitCustomView(); return; }
        if (webView != null && webView.canGoBack()) { webView.goBack(); syncChrome(); return; }
        super.onBackPressed();
    }

    @Override protected void onDestroy() {
        report("closed", "browser-only URL session closed");
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
