package dev.nativekit.isolatedbrowser;

import android.content.Context;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

final class IsolatedAppStore {
    private static final Pattern APP_ID = Pattern.compile("^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$");
    private static final Pattern INTEGRITY = Pattern.compile("^[a-f0-9]{64}$");
    private static final int MAX_CHUNK_BYTES = 512 * 1024;
    private static final String METADATA = ".nativekit.json";

    private IsolatedAppStore() {}

    static File root(Context context) {
        return new File(context.getNoBackupFilesDir(), "nativekit-isolated-apps-v1");
    }

    static String appKey(String appId) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(appId.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder();
        for (byte value : hash) output.append(String.format(Locale.US, "%02x", value & 0xff));
        return output.toString();
    }

    static String originHost(String appId) throws Exception {
        // Keep each app on a distinct registrable .invalid site so site-scoped deletion cannot affect another app.
        return "nk-" + appKey(appId).substring(0, 32) + ".invalid";
    }

    static String profileName(String appId) throws Exception {
        return "nativekit_" + appKey(appId).substring(0, 32);
    }

    static void validateIdentity(String appId, String integrity) {
        if (appId == null || !APP_ID.matcher(appId).matches()) throw new IllegalArgumentException("Invalid appId");
        if (integrity == null || !INTEGRITY.matcher(integrity).matches()) throw new IllegalArgumentException("Invalid integrity digest");
    }

    static String validatePath(String value) {
        if (value == null || value.length() < 1 || value.length() > 240 || value.startsWith(".") || value.startsWith("/") || value.endsWith("/") || value.contains("\\") || value.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Unsafe package path");
        }
        for (String part : value.split("/")) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.startsWith(".")) throw new IllegalArgumentException("Unsafe package path");
        }
        return value;
    }

    static synchronized String begin(Context context, String appId, String integrity, String entry, int fileCount, long totalBytes) throws Exception {
        validateIdentity(appId, integrity);
        validatePath(entry);
        if (fileCount < 1 || fileCount > 5000 || totalBytes < 1 || totalBytes > 128L * 1024L * 1024L) throw new IllegalArgumentException("Invalid package bounds");
        File staging = new File(root(context), ".staging");
        if (!staging.exists() && !staging.mkdirs()) throw new IllegalStateException("Could not create staging root");
        pruneStale(staging);
        String stageId = UUID.randomUUID().toString();
        File directory = new File(staging, stageId);
        if (!directory.mkdir()) throw new IllegalStateException("Could not create staging directory");
        JSONObject metadata = new JSONObject()
            .put("appId", appId)
            .put("integrity", integrity)
            .put("entry", entry)
            .put("fileCount", fileCount)
            .put("totalBytes", totalBytes)
            .put("writtenBytes", 0L)
            .put("writtenFiles", new JSONArray())
            .put("createdAt", System.currentTimeMillis());
        writeMetadata(directory, metadata);
        return stageId;
    }

    static synchronized long writeChunk(Context context, String stageId, String path, long offset, String encoded, boolean isFinal) throws Exception {
        File directory = stageDirectory(context, stageId);
        JSONObject metadata = readMetadata(directory);
        path = validatePath(path);
        if (offset < 0 || encoded == null || encoded.length() > 720_000) throw new IllegalArgumentException("Invalid stage chunk");
        byte[] data;
        try { data = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("Invalid base64 stage chunk", error); }
        if (data.length > MAX_CHUNK_BYTES) throw new IllegalArgumentException("Stage chunk is too large");

        File target = resolveInside(directory, path);
        File parent = target.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) throw new IllegalStateException("Could not create package directory");
        try (RandomAccessFile output = new RandomAccessFile(target, "rw")) {
            if (output.length() != offset) throw new IllegalStateException("Stage chunk offset mismatch");
            output.seek(offset);
            output.write(data);
        }

        long writtenBytes = metadata.getLong("writtenBytes") + data.length;
        if (writtenBytes > metadata.getLong("totalBytes")) throw new IllegalArgumentException("Staged package exceeds declared bytes");
        metadata.put("writtenBytes", writtenBytes);
        if (isFinal) {
            JSONArray files = metadata.getJSONArray("writtenFiles");
            Set<String> unique = jsonSet(files);
            if (!unique.add(path)) throw new IllegalStateException("Package file was finalized twice");
            if (unique.size() > metadata.getInt("fileCount")) throw new IllegalArgumentException("Staged package exceeds declared file count");
            JSONArray updated = new JSONArray();
            for (String item : unique) updated.put(item);
            metadata.put("writtenFiles", updated);
        }
        writeMetadata(directory, metadata);
        return writtenBytes;
    }

    static synchronized String commit(Context context, String stageId) throws Exception {
        File stage = stageDirectory(context, stageId);
        JSONObject metadata = readMetadata(stage);
        String appId = metadata.getString("appId");
        String integrity = metadata.getString("integrity");
        validateIdentity(appId, integrity);
        String entry = validatePath(metadata.getString("entry"));
        if (metadata.getJSONArray("writtenFiles").length() != metadata.getInt("fileCount") || metadata.getLong("writtenBytes") != metadata.getLong("totalBytes")) {
            throw new IllegalStateException("Staged package is incomplete");
        }
        File entryFile = resolveInside(stage, entry);
        if (!entryFile.isFile()) throw new IllegalStateException("Staged entry file is missing");
        String actualIntegrity = packageIntegrity(stage, metadata.getJSONArray("writtenFiles"));
        if (!MessageDigest.isEqual(actualIntegrity.getBytes(StandardCharsets.US_ASCII), integrity.getBytes(StandardCharsets.US_ASCII))) {
            throw new SecurityException("Staged package integrity mismatch");
        }

        File apps = new File(root(context), "apps");
        File appDirectory = new File(apps, appKey(appId));
        File target = new File(appDirectory, integrity);
        if (!appDirectory.exists() && !appDirectory.mkdirs()) throw new IllegalStateException("Could not create app store");
        if (target.exists() && verifyCommitted(target, appId, integrity)) {
            deleteRecursively(stage);
            return originHost(appId);
        }
        metadata.put("committedAt", System.currentTimeMillis());
        writeMetadata(stage, metadata);
        File replaced = null;
        if (target.exists()) {
            replaced = new File(appDirectory, ".replaced-" + UUID.randomUUID());
            if (!target.renameTo(replaced)) throw new IllegalStateException("Could not quarantine an invalid committed package");
        }
        if (!stage.renameTo(target)) {
            IllegalStateException failure = new IllegalStateException("Atomic package commit failed");
            if (replaced != null && !replaced.renameTo(target)) failure.addSuppressed(new IllegalStateException("Could not restore the previously committed package"));
            throw failure;
        }
        if (replaced != null) deleteRecursively(replaced);
        File[] versions = appDirectory.listFiles();
        if (versions != null) for (File version : versions) if (!version.equals(target)) deleteRecursively(version);
        return originHost(appId);
    }

    static synchronized void abort(Context context, String stageId) throws Exception {
        deleteRecursively(stageDirectory(context, stageId));
    }

    static synchronized boolean isStaged(Context context, String appId, String integrity) throws Exception {
        validateIdentity(appId, integrity);
        File directory = new File(new File(new File(root(context), "apps"), appKey(appId)), integrity);
        return verifyCommitted(directory, appId, integrity);
    }

    static synchronized File committedDirectory(Context context, String appId, String integrity) throws Exception {
        validateIdentity(appId, integrity);
        File result = new File(new File(new File(root(context), "apps"), appKey(appId)), integrity);
        if (!verifyCommitted(result, appId, integrity)) throw new SecurityException("Committed app verification failed");
        return result;
    }

    static synchronized void removeApp(Context context, String appId) throws Exception {
        if (appId == null || !APP_ID.matcher(appId).matches()) throw new IllegalArgumentException("Invalid appId");
        deleteRecursively(new File(new File(root(context), "apps"), appKey(appId)));
    }

    static File resolveInside(File base, String relativePath) throws Exception {
        File result = new File(base, validatePath(relativePath));
        String basePath = base.getCanonicalPath() + File.separator;
        if (!result.getCanonicalPath().startsWith(basePath)) throw new SecurityException("Package path escaped its root");
        return result;
    }

    static String mimeType(String path) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(path);
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension == null ? "" : extension.toLowerCase(Locale.US));
        if (type != null) return type;
        if (path.endsWith(".mjs") || path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    private static File stageDirectory(Context context, String stageId) throws Exception {
        UUID.fromString(stageId);
        File staging = new File(root(context), ".staging");
        File result = new File(staging, stageId);
        String expected = staging.getCanonicalPath() + File.separator;
        if (!result.getCanonicalPath().startsWith(expected) || !result.isDirectory()) throw new IllegalArgumentException("Unknown stageId");
        return result;
    }

    private static boolean verifyCommitted(File directory, String appId, String integrity) {
        try {
            if (!directory.isDirectory()) return false;
            JSONObject stored = readMetadata(directory);
            if (!appId.equals(stored.optString("appId")) || !integrity.equals(stored.optString("integrity"))) return false;
            JSONArray paths = stored.getJSONArray("writtenFiles");
            if (paths.length() != stored.getInt("fileCount") || stored.getLong("writtenBytes") != stored.getLong("totalBytes")) return false;
            String actual = packageIntegrity(directory, paths);
            return MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII), integrity.getBytes(StandardCharsets.US_ASCII));
        } catch (Exception ignored) { return false; }
    }

    private static String packageIntegrity(File directory, JSONArray pathsJson) throws Exception {
        List<String> paths = new ArrayList<>();
        for (int index = 0; index < pathsJson.length(); index++) paths.add(validatePath(pathsJson.getString(index)));
        paths.sort(IsolatedAppStore::compareUtf8);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        for (String path : paths) {
            File file = resolveInside(directory, path);
            if (!file.isFile()) throw new IllegalStateException("Finalized package file is missing");
            digest.update(path.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(Long.toString(file.length()).getBytes(StandardCharsets.US_ASCII));
            digest.update((byte) 0);
            try (FileInputStream input = new FileInputStream(file)) {
                int count;
                while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            }
        }
        StringBuilder output = new StringBuilder();
        for (byte value : digest.digest()) output.append(String.format(Locale.US, "%02x", value & 0xff));
        return output.toString();
    }

    private static int compareUtf8(String left, String right) {
        byte[] a = left.getBytes(StandardCharsets.UTF_8);
        byte[] b = right.getBytes(StandardCharsets.UTF_8);
        int length = Math.min(a.length, b.length);
        for (int index = 0; index < length; index++) {
            int difference = (a[index] & 0xff) - (b[index] & 0xff);
            if (difference != 0) return difference;
        }
        return a.length - b.length;
    }

    private static JSONObject readMetadata(File directory) throws Exception {
        return new JSONObject(readUtf8(new File(directory, METADATA)));
    }

    private static String readUtf8(File file) throws Exception {
        return new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private static void writeMetadata(File directory, JSONObject metadata) throws Exception {
        File temporary = new File(directory, METADATA + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary, false)) {
            output.write(metadata.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        File destination = new File(directory, METADATA);
        try {
            java.nio.file.Files.move(temporary.toPath(), destination.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception error) {
            temporary.delete();
            throw new IllegalStateException("Could not atomically commit stage metadata", error);
        }
    }

    private static Set<String> jsonSet(JSONArray input) {
        Set<String> result = new HashSet<>();
        for (int index = 0; index < input.length(); index++) result.add(input.optString(index));
        return result;
    }

    private static void pruneStale(File staging) {
        long cutoff = System.currentTimeMillis() - 24L * 60L * 60L * 1000L;
        File[] files = staging.listFiles();
        if (files != null) for (File file : files) if (file.lastModified() < cutoff) deleteRecursively(file);
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        // Best-effort cleanup is intentionally idempotent.
        file.delete();
    }
}
