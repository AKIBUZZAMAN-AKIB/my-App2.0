package dev.nativekit.isolatedbrowser;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * On-demand mobile dev console (Eruda, MIT, vendored in assets/browser/eruda.js).
 * Nothing is loaded until the user turns it on for a tab; the bundle is local,
 * so it works offline and is injected through evaluateJavascript (not a
 * &lt;script src&gt;), so a page's script-src CSP cannot block it.
 */
final class DevConsole {
    private static final String ASSET = "browser/eruda.js";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile String source;

    private DevConsole() {}

    /** Injects (once per document) and initialises Eruda; open=true also opens the panel. */
    static void show(final WebView view, Context context, final boolean dark, final boolean open) {
        if (view == null) return;
        final Context app = context.getApplicationContext();
        IO.execute(() -> {
            String src = load(app);
            if (src == null) return;
            final String script = build(src, dark, open);
            MAIN.post(() -> { try { view.evaluateJavascript(script, null); } catch (Throwable ignored) {} });
        });
    }

    static void hide(WebView view) {
        if (view == null) return;
        try {
            view.evaluateJavascript("(function(){try{if(window.eruda){window.eruda.destroy();}window.__nkEruda=0;}catch(e){}})();", null);
        } catch (Throwable ignored) {}
    }

    private static String build(String src, boolean dark, boolean open) {
        StringBuilder js = new StringBuilder(src.length() + 600);
        js.append("(function(){");
        js.append("if(window.eruda&&window.__nkEruda){try{").append(open ? "window.eruda.show();" : "").append("}catch(e){}return;}");
        // Hide AMD/CommonJS from the UMD wrapper so it always sets window.eruda.
        js.append("if(!window.eruda){(function(define,module,exports){\n").append(src).append("\n})();}");
        js.append("try{window.eruda.init({useShadowDom:true,autoScale:true,defaults:{theme:'")
          .append(dark ? "Dark" : "Light")
          .append("',displaySize:55,transparency:0.98}});window.__nkEruda=1;")
          .append(open ? "window.eruda.show();" : "")
          .append("}catch(e){console.error('Dev console failed to start',e);}");
        js.append("})();");
        return js.toString();
    }

    private static String load(Context context) {
        String cached = source;
        if (cached != null) return cached;
        try (InputStream in = context.getAssets().open(ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(512 * 1024);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            cached = new String(out.toByteArray(), StandardCharsets.UTF_8);
            source = cached;
            return cached;
        } catch (Throwable error) {
            return null;
        }
    }
}
