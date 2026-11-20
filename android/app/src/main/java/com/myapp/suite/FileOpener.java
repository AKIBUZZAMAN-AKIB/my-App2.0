package com.myapp.suite;

import android.content.Intent;
import android.net.Uri;
import android.webkit.MimeTypeMap;

import androidx.core.content.FileProvider;

import java.io.File;

/**
 * Open a file in whatever app the user has for it.
 *
 * <p>Two things make this work and both are easy to get wrong: the Uri must come from
 * a FileProvider (a plain file:// Uri is refused by Android 7+ with
 * FileUriExposedException), and the intent needs FLAG_GRANT_READ_URI_PERMISSION or the
 * other app sees an empty document. The MIME type is resolved from the extension and
 * falls back to a wildcard, so an unknown extension still offers the chooser instead of
 * failing silently.
 */
public final class FileOpener {

    private FileOpener() {}

    /** @return true when a chooser was shown; false when the file or the app is missing. */
    public static boolean open(android.content.Context context, File file) {
        if (context == null || file == null || !file.exists() || !file.isFile()) return false;
        try {
            Uri uri = FileProvider.getUriForFile(
                    context, context.getPackageName() + ".fileprovider", file);
            String name = file.getName();
            int dot = name.lastIndexOf('.');
            String mime = dot > 0
                    ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                        name.substring(dot + 1).toLowerCase())
                    : null;
            if (mime == null) mime = "*/*";
            Intent view = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Intent chooser = Intent.createChooser(view, name)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            context.startActivity(chooser);
            return true;
        } catch (Exception e) {
            // A missing handler or a path outside file_paths.xml lands here; the caller
            // shows "no app can open this" instead of crashing the chat.
            return false;
        }
    }
}
