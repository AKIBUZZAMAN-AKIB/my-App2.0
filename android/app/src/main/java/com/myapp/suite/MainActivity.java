package com.myapp.suite;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    private int lastInsetTop = 0;
    private int lastInsetRight = 0;
    private int lastInsetBottom = 0;
    private int lastInsetLeft = 0;
    // IME (on-screen keyboard) inset in px. 0 while the keyboard is closed.
    private int lastImeBottom = 0;
    private int lastKeyboardHeight = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        installCrashLogger();
        super.onCreate(savedInstanceState);

        // BLEND MODE (owner-tested): transparent system bars must carry the PAGE
        // colors, so the window is full edge-to-edge here. Without this the decor's
        // dark windowBackground showed through the transparent bars — users saw a
        // permanent dark strip instead of the page.
        applyBlendWindow();
        installFullscreenImmersiveWatcher();
        installImmersiveJsBridge();

        // Deterministic safe-area bridge: we ONLY read insets here and publish them as
        // --safe-area-inset-* CSS variables. Nothing pads or resizes for the IME
        // (SystemBars insetsHandling=disable), so the keyboard can never shrink the
        // viewport twice — that double-shrink used to leave a keyboard-sized gap.
        View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            lastInsetTop = bars.top;
            lastInsetRight = bars.right;
            lastInsetBottom = bars.bottom;
            lastInsetLeft = bars.left;
            // KEYBOARD: edge-to-edge means adjustResize no longer shrinks the
            // window, so nothing moved the page out from under the IME — the
            // caret stayed hidden behind the keyboard. The IME inset is the
            // only reliable source, so read it here, pad the WebView by it (a
            // real resize: fixed composers and 100vh layouts follow it) and
            // publish the height as --keyboard-height for the shell.
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            lastImeBottom = imeVisible ? Math.max(0, ime.bottom) : 0;
            lastKeyboardHeight = imeVisible ? Math.max(0, ime.bottom - bars.bottom) : 0;
            applyImeInset();
            injectSafeAreaCss();
            return insets;
        });
        ViewCompat.requestApplyInsets(decor);

        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                applyImeInset();
                injectSafeAreaCss();
            }
        });
    }

    // Capture any uncaught exception in the app process to a durable file + Logcat so a
    // background/foreground crash (e.g. a widget provider render or the floating service)
    // can be inspected on-device even though the app "just closes". We write first, then
    // delegate to the previous handler so normal crash reporting still runs.
    private void installCrashLogger() {
        try {
            final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
                try {
                    String nl = System.lineSeparator();
                    StringBuilder sb = new StringBuilder();
                    sb.append("=== NativeKit crash ").append(new java.util.Date()).append(" ===").append(nl);
                    sb.append("thread: ").append(thread == null ? "?" : thread.getName()).append(nl);
                    String stack = android.util.Log.getStackTraceString(throwable);
                    sb.append(stack).append(nl).append(nl);
                    java.io.File dir = getExternalFilesDir(null);
                    if (dir == null) dir = getFilesDir();
                    if (dir != null) {
                        java.io.File f = new java.io.File(dir, "nk_crash.log");
                        java.io.FileWriter writer = null;
                        try {
                            writer = new java.io.FileWriter(f, true);
                            writer.write(sb.toString());
                        } finally {
                            if (writer != null) writer.close();
                        }
                    }
                    android.util.Log.e("NativeKit", "Uncaught exception captured:" + nl + stack);
                } catch (Throwable ignored) {}
                if (previous != null) previous.uncaughtException(thread, throwable);
                else android.os.Process.killProcess(android.os.Process.myPid());
            });
        } catch (Throwable ignored) {}
    }

    private void applyBlendWindow() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            getWindow().getAttributes().layoutInDisplayCutoutMode = 1; // SHORT_EDGES
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        applyBlendWindow(); // re-apply if the theme/system reset bar colors
    }

    // FULLSCREEN IMMERSIVE: when HTML content (e.g. a video) calls the HTML5
    // fullscreen API, Android's WebChromeClient.onShowCustomView adds a NEW top-level
    // view onto the decor. With our transparent bars that overlay would let the
    // phone's nav buttons float ON TOP of the page's own bottom buttons. So while
    // fullscreen is active we hide the system bars (immersive sticky: a swipe
    // reveals them translucently and they auto-hide again).
    private boolean decorWatcherArmed = false;
    private android.view.View fullscreenView = null;

    private void installFullscreenImmersiveWatcher() {
        final ViewGroup decorView = (ViewGroup) getWindow().getDecorView();
        decorView.setOnHierarchyChangeListener(new ViewGroup.OnHierarchyChangeListener() {
            @Override public void onChildViewAdded(View parent, View child) {
                if (!decorWatcherArmed || child == decorView) return;
                if (!isTrueFullscreenOverlay(child)) return;
                fullscreenView = child;
                applyImmersive(true);
            }
            @Override public void onChildViewRemoved(View parent, View child) {
                if (!decorWatcherArmed) return;
                if (child == fullscreenView) {
                    fullscreenView = null;
                    applyImmersive(false);
                    applyBlendWindow();
                }
            }
        });
        decorView.post(() -> decorWatcherArmed = true); // ignore the initial layout children
    }

    private boolean isTrueFullscreenOverlay(android.view.View child) {
        if (child.getVisibility() != android.view.View.VISIBLE) return false;
        int h = getWindow().getDecorView().getHeight();
        int w = getWindow().getDecorView().getWidth();
        if (h <= 0 || w <= 0) {
            h = getResources().getDisplayMetrics().heightPixels;
            w = getResources().getDisplayMetrics().widthPixels;
        }
        ViewGroup.LayoutParams lp = child.getLayoutParams();
        if (lp == null) return false;
        boolean matchH = lp.height == ViewGroup.LayoutParams.MATCH_PARENT || lp.height >= (int) (h * 0.7f);
        boolean matchW = lp.width == ViewGroup.LayoutParams.MATCH_PARENT || lp.width >= (int) (w * 0.7f);
        return matchH && matchW;
    }

    // ELEMENT-FULLSCREEN bridge: Chromium WebView handles requestFullscreen() on a
    // plain element INTERNALLY (no onShowCustomView ever fires), so the page tells
    // us via fullscreenchange → this JS interface. Immersive only on TRUE fullscreen.
    private void installImmersiveJsBridge() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) return;
        wv.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setFullscreen(final boolean on) {
                runOnUiThread(() -> applyImmersive(on));
            }
        }, "NativeKitImmersive");
    }

    private void applyImmersive(boolean active) {
        WindowInsetsControllerCompat ic = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        if (active) {
            ic.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            ic.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            ic.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    /**
     * Pads the WebView's container by the IME inset. Because the WebView is
     * match_parent inside that container, its layout viewport really shrinks —
     * exactly what adjustResize used to do before edge-to-edge was enforced.
     * Doing it by hand is what keeps a focused field visible while typing.
     */
    private void applyImeInset() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        android.view.ViewParent rawParent = webView.getParent();
        if (!(rawParent instanceof View)) return;
        View parent = (View) rawParent;
        if (parent == getWindow().getDecorView()) return;
        int padding = lastImeBottom;
        if (parent.getPaddingBottom() == padding) return;
        parent.setPadding(parent.getPaddingLeft(), parent.getPaddingTop(), parent.getPaddingRight(), padding);
        parent.requestLayout();
    }

    private void injectSafeAreaCss() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        float density = getResources().getDisplayMetrics().density;
        int top = Math.round(lastInsetTop / density);
        int right = Math.round(lastInsetRight / density);
        int bottom = Math.round(lastInsetBottom / density);
        int left = Math.round(lastInsetLeft / density);
        int keyboard = Math.round(lastKeyboardHeight / density);
        String script = String.format(Locale.US,
                "(function(){try{var s=document.documentElement.style;"
                        + "s.setProperty('--safe-area-inset-top','%dpx');"
                        + "s.setProperty('--safe-area-inset-right','%dpx');"
                        + "s.setProperty('--safe-area-inset-bottom','%dpx');"
                        + "s.setProperty('--safe-area-inset-left','%dpx');"
                        + "s.setProperty('--keyboard-height','%dpx');"
                        + "s.setProperty('--keyboard-visible','%d');"
                        + "var h=document.documentElement;"
                        + "if(h){h.classList.toggle('nk-keyboard',%d===1);}"
                        + "}catch(e){}})();",
                top, right, bottom, left, keyboard, keyboard > 0 ? 1 : 0, keyboard > 0 ? 1 : 0);
        getBridge().executeOnMainThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }
}
