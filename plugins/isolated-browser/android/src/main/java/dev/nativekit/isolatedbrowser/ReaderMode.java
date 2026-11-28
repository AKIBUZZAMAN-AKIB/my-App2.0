package dev.nativekit.isolatedbrowser;

import android.content.Context;
import android.webkit.WebView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Reader mode for the remote browser.
 *
 * RemoteBrowserActivity itself stays free of any JavaScript/native bridge (no
 * addJavascriptInterface, addWebMessageListener or evaluateJavascript), which
 * tests/native-plugin.test.ts guards. Reader mode is the one user-initiated,
 * one-way script the remote browser runs, so it lives here: the bundled
 * assets/browser/reader.js only rearranges the page's own DOM into an overlay,
 * gets no channel back into native code, and its result is ignored.
 */
final class ReaderMode {
    private static final String ASSET = "browser/reader.js";
    private static String script;

    private ReaderMode() {}

    /** Toggles the reader overlay on the current page. Returns false when the script is unavailable. */
    static boolean toggle(WebView webView, Context context) {
        if (webView == null || context == null) return false;
        if (script == null) script = readAsset(context, ASSET);
        if (script == null) return false;
        webView.evaluateJavascript(script, null);
        return true;
    }

    private static String readAsset(Context context, String name) {
        try (InputStream in = context.getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception error) {
            return null;
        }
    }
}
