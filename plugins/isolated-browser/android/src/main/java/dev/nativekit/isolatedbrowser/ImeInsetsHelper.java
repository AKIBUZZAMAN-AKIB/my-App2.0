package dev.nativekit.isolatedbrowser;

import android.os.Build;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Applies system-bar and IME (keyboard) insets as padding on the browser shell root.
 * On targetSdk 35+ devices edge-to-edge is mandatory, so the OS no longer pushes
 * content above the software keyboard by itself (adjustResize alone is not enough);
 * consuming the IME inset here keeps focused inputs visible instead of covered.
 */
final class ImeInsetsHelper {

    private ImeInsetsHelper() {
    }

    static void apply(View root) {
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            int bottom = Math.max(systemBars.bottom, ime.bottom);
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
            root.requestApplyInsets();
        }
    }
}
