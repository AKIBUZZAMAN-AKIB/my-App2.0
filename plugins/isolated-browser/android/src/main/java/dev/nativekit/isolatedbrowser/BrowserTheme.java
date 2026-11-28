package dev.nativekit.isolatedbrowser;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;

/**
 * Resolved colours for the browser shell.
 *
 * The shell used to be hard-wired to a near-black navy (#07111F) in every
 * state. Appearance is now the user's choice: Light / Dark / Follow system,
 * an accent colour and a start/loading backdrop, all persisted in
 * {@link BrowserStore}. Every surface reads its colours from one instance of
 * this class so a change re-paints the whole shell at once.
 */
final class BrowserTheme {

    /** name, light-mode accent, dark-mode accent. */
    static final Object[][] ACCENTS = {
        { "Blue",    Color.rgb(37, 99, 235),  Color.rgb(96, 165, 250) },
        { "Violet",  Color.rgb(124, 58, 237), Color.rgb(167, 139, 250) },
        { "Teal",    Color.rgb(13, 148, 136), Color.rgb(45, 212, 191) },
        { "Green",   Color.rgb(22, 163, 74),  Color.rgb(74, 222, 128) },
        { "Orange",  Color.rgb(234, 88, 12),  Color.rgb(251, 146, 60) },
        { "Rose",    Color.rgb(225, 29, 72),  Color.rgb(251, 113, 133) },
        { "Graphite", Color.rgb(71, 85, 105), Color.rgb(148, 163, 184) },
    };

    /** name, top colour, bottom colour (0 = use the theme ground). */
    static final Object[][] BACKDROPS = {
        { "Plain",   0, 0 },
        { "Aurora",  Color.rgb(99, 102, 241), Color.rgb(20, 184, 166) },
        { "Sunset",  Color.rgb(249, 115, 22), Color.rgb(236, 72, 153) },
        { "Ocean",   Color.rgb(14, 165, 233), Color.rgb(37, 99, 235) },
        { "Forest",  Color.rgb(34, 197, 94), Color.rgb(13, 148, 136) },
        { "Dusk",    Color.rgb(139, 92, 246), Color.rgb(30, 41, 59) },
    };

    static final String[] MODES = { "system", "light", "dark" };
    static final String[] MODE_LABELS = { "Follow system", "Light", "Dark" };

    final boolean dark;
    final int accent;
    final int onAccent;
    final int ground;      // window / content ground
    final int chrome;      // toolbar surface
    final int surface;     // cards, address pill
    final int surface2;    // pressed / secondary surface
    final int text;
    final int muted;
    final int border;
    final int backdropTop;
    final int backdropBottom;
    final int incognito;

    private BrowserTheme(boolean dark, int accent, int backdrop) {
        this.dark = dark;
        this.accent = accent;
        this.onAccent = Color.WHITE;
        if (dark) {
            ground = Color.rgb(18, 20, 24);
            chrome = Color.rgb(28, 31, 36);
            surface = Color.rgb(40, 44, 51);
            surface2 = Color.rgb(52, 57, 66);
            text = Color.rgb(236, 239, 244);
            muted = Color.rgb(156, 163, 175);
            border = Color.rgb(58, 63, 72);
            incognito = Color.rgb(91, 33, 182);
        } else {
            ground = Color.rgb(246, 247, 249);
            chrome = Color.rgb(255, 255, 255);
            surface = Color.rgb(239, 241, 245);
            surface2 = Color.rgb(226, 230, 236);
            text = Color.rgb(17, 24, 39);
            muted = Color.rgb(100, 108, 122);
            border = Color.rgb(222, 226, 232);
            incognito = Color.rgb(109, 40, 217);
        }
        Object[] b = BACKDROPS[clamp(backdrop, BACKDROPS.length)];
        int top = (Integer) b[1];
        int bottom = (Integer) b[2];
        backdropTop = top == 0 ? ground : blend(top, ground, dark ? 0.55f : 0.25f);
        backdropBottom = bottom == 0 ? ground : blend(bottom, ground, dark ? 0.75f : 0.55f);
    }

    static BrowserTheme resolve(Context context, BrowserStore store) {
        String mode = store == null ? "system" : store.themeMode();
        boolean dark;
        if ("dark".equals(mode)) dark = true;
        else if ("light".equals(mode)) dark = false;
        else {
            int night = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            dark = night == Configuration.UI_MODE_NIGHT_YES;
        }
        Object[] a = ACCENTS[clamp(store == null ? 0 : store.accentIndex(), ACCENTS.length)];
        int accent = (Integer) (dark ? a[2] : a[1]);
        return new BrowserTheme(dark, accent, store == null ? 0 : store.backdropIndex());
    }

    /** Colour with the given alpha (0..255). */
    static int alpha(int color, int alpha) {
        return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color));
    }

    /** Mixes a toward b by t (0 = a, 1 = b). */
    static int blend(int a, int b, float t) {
        return Color.rgb(
            Math.round(Color.red(a) + (Color.red(b) - Color.red(a)) * t),
            Math.round(Color.green(a) + (Color.green(b) - Color.green(a)) * t),
            Math.round(Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t));
    }

    /** #RRGGBB for handing the accent to the in-page agent panel. */
    static String hex(int color) {
        return String.format("#%06X", 0xFFFFFF & color);
    }

    static int clamp(int index, int length) {
        return index < 0 || index >= length ? 0 : index;
    }
}
