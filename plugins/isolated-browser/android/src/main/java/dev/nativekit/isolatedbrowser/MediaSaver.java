package dev.nativekit.isolatedbrowser;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Saves screenshots / recordings to the shared gallery (Pictures/&lt;app&gt;, Movies/&lt;app&gt;). */
final class MediaSaver {
    private MediaSaver() {}

    /** Folder name inside Pictures / Movies: the app's label, file-name safe. */
    static String folder(Context context) {
        String label;
        try { label = String.valueOf(context.getApplicationInfo().loadLabel(context.getPackageManager())); }
        catch (Throwable ignored) { label = "Browser"; }
        label = label.replaceAll("[\\\\/:*?\"<>|]", "").trim();
        return label.isEmpty() ? "Browser" : label;
    }

    static String stamp() {
        return new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
    }

    /** Writes a PNG to the gallery; returns its content Uri or null. */
    static Uri saveImage(Context context, Bitmap bitmap) {
        String name = "Screenshot_" + stamp() + ".png";
        ContentResolver resolver = context.getContentResolver();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + folder(context));
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return null;
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null || !bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                        resolver.delete(uri, null, null);
                        return null;
                    }
                }
                values.clear();
                values.put(MediaStore.Images.Media.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                return uri;
            }
            // Android 9: legacy gallery insert (needs storage permission on some devices).
            String saved = MediaStore.Images.Media.insertImage(resolver, bitmap, name, null);
            return saved == null ? null : Uri.parse(saved);
        } catch (Throwable error) {
            return null;
        }
    }
}
