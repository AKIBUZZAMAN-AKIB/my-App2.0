package dev.nativekit.custom;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Folders the user shares with the agent through the Storage Access Framework.
 *
 * The user picks a folder with ACTION_OPEN_DOCUMENT_TREE; we keep the grant with
 * takePersistableUriPermission so it survives restarts, and give it back with
 * releasePersistableUriPermission. Nothing here asks for MANAGE_EXTERNAL_STORAGE
 * or media permissions: the app can only reach the trees the user picked.
 *
 * Every path is walked segment by segment through DocumentsContract children of
 * the granted tree, so no input ("..", absolute paths, other URIs) can leave it.
 * Errors carry a code the bridge maps to advice (bridge/folder-access.ts).
 */
final class FolderAccess {
    static final class FolderException extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;
        FolderException(String code, String message) { super(message); this.code = code; }
    }

    static final class Node {
        final String docId;
        final String name;
        final String mime;
        final long size;
        final long modified;
        final int flags;
        Node(String docId, String name, String mime, long size, long modified, int flags) {
            this.docId = docId; this.name = name; this.mime = mime; this.size = size; this.modified = modified; this.flags = flags;
        }
        boolean isDir() { return Document.MIME_TYPE_DIR.equals(mime); }
    }

    private static final String PREFS = "nativekit_shared_folders";
    private static final String KEY = "folders";
    private static final int MAX_FOLDERS = 20;
    private static final int MAX_SEGMENT = 255;
    private static final int MAX_READ = 1024 * 1024;
    private static final int FIND_MAX_SCANNED = 20000;
    private static final String[] PROJECTION = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS,
    };

    private final Context context;

    FolderAccess(Context context) { this.context = context.getApplicationContext(); }

    private ContentResolver resolver() { return context.getContentResolver(); }

    // ── Grants ───────────────────────────────────────────────────────────────────

    private SharedPreferences prefs() { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    synchronized JSONArray stored() {
        try { return new JSONArray(prefs().getString(KEY, "[]")); } catch (JSONException e) { return new JSONArray(); }
    }

    private synchronized void save(JSONArray folders) { prefs().edit().putString(KEY, folders.toString()).apply(); }

    private JSONObject grant(String id) throws FolderException {
        JSONArray all = stored();
        for (int i = 0; i < all.length(); i++) {
            JSONObject f = all.optJSONObject(i);
            if (f != null && id.equals(f.optString("id"))) return f;
        }
        throw new FolderException("REVOKED", "This folder is no longer shared");
    }

    private UriPermission permissionFor(Uri tree) {
        for (UriPermission p : resolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree)) return p;
        }
        return null;
    }

    /** Every grant with live status: available, canWrite and why not. */
    JSONArray list() {
        JSONArray out = new JSONArray();
        JSONArray all = stored();
        for (int i = 0; i < all.length(); i++) {
            JSONObject f = all.optJSONObject(i);
            if (f == null) continue;
            JSONObject row = new JSONObject();
            try {
                row.put("id", f.optString("id"));
                row.put("name", f.optString("name"));
                row.put("mode", f.optString("mode", "read"));
                row.put("location", f.optString("location"));
                row.put("addedAt", f.optLong("addedAt"));
                Uri tree = Uri.parse(f.optString("uri"));
                UriPermission p = permissionFor(tree);
                boolean available = p != null && p.isReadPermission();
                String reason = available ? "" : "Android no longer grants access to it";
                if (available) {
                    try {
                        if (query(tree, DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))) == null) {
                            available = false; reason = "the folder was deleted or its storage was removed";
                        }
                    } catch (FolderException e) {
                        available = false; reason = "the folder was deleted or its storage was removed";
                    }
                }
                row.put("available", available);
                row.put("canWrite", p != null && p.isWritePermission());
                if (!available) row.put("reason", reason);
            } catch (JSONException ignored) { }
            out.put(row);
        }
        return out;
    }

    /** Keeps the grant from a picker result and stores the folder. */
    JSONObject add(Uri tree, int resultFlags, String mode) throws FolderException {
        if (tree == null) throw new FolderException("CANCELLED", "No folder was picked");
        int flags = resultFlags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if ((flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) flags |= Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            resolver().takePersistableUriPermission(tree, flags);
        } catch (SecurityException e) {
            // Some providers grant no write; keep read-only access then.
            try {
                resolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException e2) {
                throw new FolderException("DENIED", "Android did not allow keeping access to that folder");
            }
        }
        String docId = DocumentsContract.getTreeDocumentId(tree);
        Node root = query(tree, DocumentsContract.buildDocumentUriUsingTree(tree, docId));
        String name = root != null && root.name != null && !root.name.isEmpty() ? root.name : lastSegment(docId);
        JSONArray all = stored();
        JSONObject existing = null;
        for (int i = 0; i < all.length(); i++) {
            JSONObject f = all.optJSONObject(i);
            if (f != null && tree.toString().equals(f.optString("uri"))) existing = f;
        }
        try {
            if (existing != null) {
                existing.put("mode", normMode(mode));
                save(all);
                return existing;
            }
            if (all.length() >= MAX_FOLDERS) {
                release(tree);
                throw new FolderException("LIMIT", "You can share up to " + MAX_FOLDERS + " folders; remove one first");
            }
            JSONObject f = new JSONObject();
            f.put("id", "f" + UUID.randomUUID().toString().replace("-", "").substring(0, 10));
            f.put("name", name);
            f.put("uri", tree.toString());
            f.put("mode", normMode(mode));
            f.put("location", describeLocation(tree, docId));
            f.put("addedAt", System.currentTimeMillis());
            all.put(f);
            save(all);
            return f;
        } catch (JSONException e) {
            throw new FolderException("FAILED", "Could not save the folder");
        }
    }

    void setMode(String id, String mode) throws FolderException {
        JSONArray all = stored();
        for (int i = 0; i < all.length(); i++) {
            JSONObject f = all.optJSONObject(i);
            if (f != null && id.equals(f.optString("id"))) {
                try { f.put("mode", normMode(mode)); } catch (JSONException ignored) { }
                save(all);
                return;
            }
        }
        throw new FolderException("REVOKED", "This folder is no longer shared");
    }

    /** Gives the permission back to Android and forgets the folder. */
    boolean remove(String id) {
        JSONArray all = stored();
        JSONArray keep = new JSONArray();
        boolean removed = false;
        for (int i = 0; i < all.length(); i++) {
            JSONObject f = all.optJSONObject(i);
            if (f == null) continue;
            if (id.equals(f.optString("id"))) { removed = true; release(Uri.parse(f.optString("uri"))); } else keep.put(f);
        }
        save(keep);
        return removed;
    }

    private void release(Uri tree) {
        UriPermission p = permissionFor(tree);
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | (p != null && p.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
        try { resolver().releasePersistableUriPermission(tree, flags); } catch (SecurityException ignored) { }
    }

    private static String normMode(String mode) { return "readwrite".equals(mode) ? "readwrite" : "read"; }

    private static String lastSegment(String docId) {
        String s = docId == null ? "" : docId;
        int colon = s.indexOf(':');
        if (colon >= 0) s = s.substring(colon + 1);
        int slash = s.lastIndexOf('/');
        return slash >= 0 ? s.substring(slash + 1) : (s.isEmpty() ? "Folder" : s);
    }

    /** "Internal storage › Documents › Work" for externalstorage trees; the provider name otherwise. */
    static String describeLocation(Uri tree, String docId) {
        String authority = tree.getAuthority() == null ? "" : tree.getAuthority();
        if ("com.android.externalstorage.documents".equals(authority) && docId != null) {
            int colon = docId.indexOf(':');
            String volume = colon >= 0 ? docId.substring(0, colon) : docId;
            String rest = colon >= 0 ? docId.substring(colon + 1) : "";
            String base = "primary".equalsIgnoreCase(volume) ? "Internal storage" : "SD card (" + volume + ")";
            return rest.isEmpty() ? base : base + " › " + rest.replace("/", " › ");
        }
        if (authority.contains("downloads")) return "Downloads";
        if (authority.contains("google.android.apps.docs")) return "Google Drive";
        return authority;
    }

    // ── Walking a tree ─────────────────────────────────────────────────────────────

    final class Folder {
        final Uri tree;
        final String name;
        final boolean writable;
        Folder(Uri tree, String name, boolean writable) { this.tree = tree; this.name = name; this.writable = writable; }
        Uri doc(String docId) { return DocumentsContract.buildDocumentUriUsingTree(tree, docId); }
        Node root() throws FolderException {
            Node n = query(tree, doc(DocumentsContract.getTreeDocumentId(tree)));
            if (n == null) throw new FolderException("REVOKED", "The shared folder was deleted or its storage was removed");
            return n;
        }
    }

    /** Opens a grant for use, checking Android still honours it (and write access when asked). */
    Folder open(String id, boolean write) throws FolderException {
        if (id == null || id.isEmpty()) throw new FolderException("BAD_FOLDER", "No folder id was given");
        JSONObject f = grant(id);
        Uri tree = Uri.parse(f.optString("uri"));
        UriPermission p = permissionFor(tree);
        if (p == null || !p.isReadPermission()) throw new FolderException("REVOKED", "Android no longer grants access to \"" + f.optString("name") + "\"");
        boolean writable = "readwrite".equals(f.optString("mode")) && p.isWritePermission();
        if (write && !writable) throw new FolderException("READ_ONLY", "\"" + f.optString("name") + "\" is read-only");
        return new Folder(tree, f.optString("name"), writable);
    }

    /** Splits a relative path, refusing anything that could leave the folder. */
    static List<String> segments(String path) throws FolderException {
        List<String> out = new ArrayList<>();
        if (path == null) return out;
        if (path.length() > 1024) throw new FolderException("BAD_PATH", "The path is too long");
        if (path.contains("://")) throw new FolderException("BAD_PATH", "Pass a path inside the shared folder, not a URI");
        for (String raw : path.replace('\\', '/').split("/")) {
            if (raw.isEmpty()) continue;
            if (raw.equals(".") || raw.equals("..")) throw new FolderException("BAD_PATH", "'.' and '..' are not allowed in paths");
            if (raw.length() > MAX_SEGMENT) throw new FolderException("BAD_PATH", "A name in the path is too long");
            for (int i = 0; i < raw.length(); i++) {
                if (raw.charAt(i) < 0x20 || raw.charAt(i) == 0x7f) throw new FolderException("BAD_PATH", "The path contains control characters");
            }
            out.add(raw);
        }
        return out;
    }

    Node query(Uri tree, Uri doc) throws FolderException {
        try (Cursor c = resolver().query(doc, PROJECTION, null, null, null)) {
            if (c == null || !c.moveToFirst()) return null;
            return nodeAt(c);
        } catch (SecurityException e) {
            throw new FolderException("REVOKED", "Android no longer grants access to this folder");
        } catch (IllegalArgumentException | UnsupportedOperationException e) {
            return null;
        }
    }

    private static Node nodeAt(Cursor c) {
        return new Node(c.getString(0), c.getString(1), c.getString(2), c.isNull(3) ? -1 : c.getLong(3), c.isNull(4) ? 0 : c.getLong(4), c.isNull(5) ? 0 : c.getInt(5));
    }

    List<Node> children(Folder f, Node dir) throws FolderException {
        List<Node> out = new ArrayList<>();
        Uri uri = DocumentsContract.buildChildDocumentsUriUsingTree(f.tree, dir.docId);
        try (Cursor c = resolver().query(uri, PROJECTION, null, null, null)) {
            if (c == null) return out;
            while (c.moveToNext()) out.add(nodeAt(c));
        } catch (SecurityException e) {
            throw new FolderException("REVOKED", "Android no longer grants access to \"" + f.name + "\"");
        } catch (IllegalArgumentException | UnsupportedOperationException e) {
            throw new FolderException("FAILED", "The storage could not list this folder");
        }
        return out;
    }

    private Node child(Folder f, Node dir, String name) throws FolderException {
        Node folded = null;
        int foldedCount = 0;
        for (Node n : children(f, dir)) {
            if (name.equals(n.name)) return n;
            if (n.name != null && n.name.equalsIgnoreCase(name)) { folded = n; foldedCount++; }
        }
        return foldedCount == 1 ? folded : null;
    }

    /** The node at a relative path, or null when nothing is there. */
    Node resolve(Folder f, String path) throws FolderException {
        Node cur = f.root();
        for (String seg : segments(path)) {
            if (!cur.isDir()) return null;
            cur = child(f, cur, seg);
            if (cur == null) return null;
        }
        return cur;
    }

    Node require(Folder f, String path) throws FolderException {
        Node n = resolve(f, path);
        if (n == null) throw new FolderException("NOT_FOUND", "\"" + displayPath(f, path) + "\" does not exist");
        return n;
    }

    private Node requireDirFor(Folder f, List<String> segs, boolean create) throws FolderException {
        Node cur = f.root();
        for (String seg : segs) {
            Node next = child(f, cur, seg);
            if (next == null) {
                if (!create) throw new FolderException("NOT_FOUND", "The folder \"" + seg + "\" does not exist");
                next = createIn(f, cur, Document.MIME_TYPE_DIR, seg);
            }
            if (!next.isDir()) throw new FolderException("NOT_A_DIRECTORY", "\"" + seg + "\" is a file, not a folder");
            cur = next;
        }
        return cur;
    }

    private Node createIn(Folder f, Node dir, String mime, String name) throws FolderException {
        try {
            Uri created = DocumentsContract.createDocument(resolver(), f.doc(dir.docId), mime, name);
            if (created == null) throw new FolderException("FAILED", "The storage refused to create \"" + name + "\"");
            Node n = query(f.tree, created);
            if (n == null) throw new FolderException("FAILED", "\"" + name + "\" was not created");
            return n;
        } catch (SecurityException e) {
            throw new FolderException("REVOKED", "Android no longer grants write access to \"" + f.name + "\"");
        } catch (FileNotFoundException | IllegalArgumentException | UnsupportedOperationException | IllegalStateException e) {
            throw new FolderException("FAILED", "The storage refused to create \"" + name + "\"");
        }
    }

    static String displayPath(Folder f, String path) {
        String p = path == null ? "" : path.replaceAll("^/+|/+$", "");
        return p.isEmpty() ? f.name : f.name + "/" + p;
    }

    static JSONObject entry(Node n, String relPath) {
        JSONObject o = new JSONObject();
        try {
            o.put("name", n.name);
            if (relPath != null) o.put("path", relPath);
            o.put("type", n.isDir() ? "directory" : "file");
            if (!n.isDir() && n.size >= 0) o.put("size", n.size);
            if (n.modified > 0) o.put("modified", n.modified);
            if (!n.isDir() && n.mime != null) o.put("mime", n.mime);
        } catch (JSONException ignored) { }
        return o;
    }

    // ── Operations ──────────────────────────────────────────────────────────────────────

    JSONObject listDir(String id, String path, int limit) throws FolderException, JSONException {
        Folder f = open(id, false);
        Node dir = require(f, path);
        if (!dir.isDir()) throw new FolderException("NOT_A_DIRECTORY", "\"" + displayPath(f, path) + "\" is a file");
        List<Node> kids = children(f, dir);
        JSONArray entries = new JSONArray();
        int max = Math.max(1, Math.min(limit, 1000));
        for (int i = 0; i < kids.size() && i < max; i++) entries.put(entry(kids.get(i), null));
        JSONObject out = new JSONObject();
        out.put("entries", entries);
        out.put("truncated", kids.size() > max);
        return out;
    }

    JSONObject stat(String id, String path) throws FolderException, JSONException {
        Folder f = open(id, false);
        Node n = resolve(f, path);
        JSONObject out = n == null ? new JSONObject() : entry(n, null);
        out.put("exists", n != null);
        if (n == null) { out.put("name", ""); out.put("type", "file"); }
        return out;
    }

    JSONObject read(String id, String path, long offset, int length) throws FolderException, JSONException {
        Folder f = open(id, false);
        Node n = require(f, path);
        if (n.isDir()) throw new FolderException("NOT_A_FILE", "\"" + displayPath(f, path) + "\" is a folder");
        int want = Math.max(0, Math.min(length, MAX_READ));
        byte[] buf = new byte[want];
        int got = 0;
        boolean eof = false;
        try (InputStream in = resolver().openInputStream(f.doc(n.docId))) {
            if (in == null) throw new FolderException("FAILED", "The file could not be opened");
            long skipped = 0;
            while (skipped < offset) {
                long s = in.skip(offset - skipped);
                if (s <= 0) { if (in.read() < 0) { eof = true; break; } s = 1; }
                skipped += s;
            }
            while (!eof && got < want) {
                int r = in.read(buf, got, want - got);
                if (r < 0) { eof = true; break; }
                got += r;
            }
            if (!eof && got == want) {
                if (n.size >= 0) eof = offset + got >= n.size;
                else eof = in.read() < 0;
            }
        } catch (SecurityException e) {
            throw new FolderException("REVOKED", "Android no longer grants access to \"" + f.name + "\"");
        } catch (IOException e) {
            throw new FolderException("FAILED", "Reading failed: " + e.getMessage());
        }
        JSONObject out = new JSONObject();
        out.put("data", Base64.encodeToString(buf, 0, got, Base64.NO_WRAP));
        out.put("bytesRead", got);
        out.put("size", n.size);
        out.put("eof", eof);
        return out;
    }

    private static String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String mime = ext.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime == null && (ext.equals("md") || ext.equals("txt") || ext.equals("csv") || ext.equals("log"))) mime = "text/plain";
        return mime == null ? "application/octet-stream" : mime;
    }

    /** Opens a file for writing at path, creating it (and parents) or truncating it when overwrite. */
    private OutputStream openForWrite(Folder f, String path, boolean overwrite, boolean[] created) throws FolderException {
        List<String> segs = segments(path);
        if (segs.isEmpty()) throw new FolderException("BAD_PATH", "Name a file inside the shared folder");
        String name = segs.get(segs.size() - 1);
        Node parent = requireDirFor(f, segs.subList(0, segs.size() - 1), true);
        Node existing = child(f, parent, name);
        Node target;
        if (existing != null) {
            if (existing.isDir()) throw new FolderException("NOT_A_FILE", "\"" + displayPath(f, path) + "\" is a folder");
            if (!overwrite) throw new FolderException("EXISTS", "\"" + displayPath(f, path) + "\" already exists");
            target = existing;
            created[0] = false;
        } else {
            target = createIn(f, parent, mimeFor(name), name);
            created[0] = true;
        }
        try {
            OutputStream out = resolver().openOutputStream(f.doc(target.docId), "wt");
            if (out == null) throw new FolderException("FAILED", "The file could not be opened for writing");
            return out;
        } catch (SecurityException e) {
            throw new FolderException("REVOKED", "Android no longer grants write access to \"" + f.name + "\"");
        } catch (FileNotFoundException | IllegalArgumentException e) {
            // Some providers do not support "wt"; plain "w" truncates on most.
            try {
                OutputStream out = resolver().openOutputStream(f.doc(target.docId), "w");
                if (out == null) throw new FolderException("FAILED", "The file could not be opened for writing");
                return out;
            } catch (FileNotFoundException e2) {
                throw new FolderException("FAILED", "The file could not be opened for writing");
            }
        }
    }

    JSONObject write(String id, String path, String base64, boolean overwrite) throws FolderException, JSONException {
        Folder f = open(id, true);
        byte[] bytes;
        try { bytes = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT); } catch (IllegalArgumentException e) { throw new FolderException("BAD_DATA", "The data is not valid base64"); }
        boolean[] created = { false };
        try (OutputStream out = openForWrite(f, path, overwrite, created)) {
            out.write(bytes);
        } catch (IOException e) {
            throw new FolderException("FAILED", "Writing failed: " + e.getMessage());
        }
        JSONObject res = new JSONObject();
        res.put("size", bytes.length);
        res.put("created", created[0]);
        return res;
    }

    JSONObject mkdir(String id, String path) throws FolderException, JSONException {
        Folder f = open(id, true);
        List<String> segs = segments(path);
        if (segs.isEmpty()) throw new FolderException("BAD_PATH", "Name a folder inside the shared folder");
        boolean existed = resolve(f, path) != null;
        requireDirFor(f, segs, true);
        JSONObject res = new JSONObject();
        res.put("created", !existed);
        return res;
    }

    JSONObject delete(String id, String path, boolean recursive) throws FolderException, JSONException {
        Folder f = open(id, true);
        if (segments(path).isEmpty()) throw new FolderException("BAD_PATH", "The shared folder itself cannot be deleted");
        Node n = require(f, path);
        if (n.isDir() && !recursive && !children(f, n).isEmpty()) {
            throw new FolderException("NOT_EMPTY", "\"" + displayPath(f, path) + "\" is a folder with files in it; pass recursive: true to delete it all");
        }
        boolean ok;
        try {
            ok = DocumentsContract.deleteDocument(resolver(), f.doc(n.docId));
        } catch (SecurityException e) {
            throw new FolderException("REVOKED", "Android no longer grants write access to \"" + f.name + "\"");
        } catch (FileNotFoundException | IllegalArgumentException | UnsupportedOperationException e) {
            throw new FolderException("UNSUPPORTED", "The storage refused to delete it");
        }
        JSONObject res = new JSONObject();
        res.put("deleted", ok);
        return res;
    }

    JSONObject move(String id, String path, String to, boolean overwrite) throws FolderException, JSONException {
        Folder f = open(id, true);
        List<String> from = segments(path);
        List<String> dest = segments(to);
        if (from.isEmpty() || dest.isEmpty()) throw new FolderException("BAD_PATH", "The shared folder itself cannot be moved");
        String fromJoined = String.join("/", from);
        String toJoined = String.join("/", dest);
        if (toJoined.equals(fromJoined) || toJoined.startsWith(fromJoined + "/")) throw new FolderException("BAD_PATH", "A folder cannot be moved into itself");
        Node src = require(f, path);
        Node srcParent = requireDirFor(f, from.subList(0, from.size() - 1), false);
        String newName = dest.get(dest.size() - 1);
        Node destParent = requireDirFor(f, dest.subList(0, dest.size() - 1), true);
        Node existing = child(f, destParent, newName);
        if (existing != null && !existing.docId.equals(src.docId)) {
            if (!overwrite) throw new FolderException("EXISTS", "\"" + displayPath(f, to) + "\" already exists");
            if (existing.isDir()) throw new FolderException("EXISTS", "\"" + displayPath(f, to) + "\" is a folder and is not replaced");
            try { DocumentsContract.deleteDocument(resolver(), f.doc(existing.docId)); } catch (Exception e) { throw new FolderException("FAILED", "Could not replace \"" + displayPath(f, to) + "\""); }
        }
        Uri current = f.doc(src.docId);
        try {
            if (!srcParent.docId.equals(destParent.docId)) {
                Uri moved = null;
                if ((src.flags & Document.FLAG_SUPPORTS_MOVE) != 0) {
                    moved = DocumentsContract.moveDocument(resolver(), current, f.doc(srcParent.docId), f.doc(destParent.docId));
                }
                if (moved == null) {
                    if (src.isDir()) throw new FolderException("UNSUPPORTED", "This storage cannot move folders; move the files one by one");
                    // Copy then delete for providers without move support.
                    Node copy = createIn(f, destParent, src.mime == null ? mimeFor(newName) : src.mime, newName);
                    try (InputStream in = resolver().openInputStream(current); OutputStream out = resolver().openOutputStream(f.doc(copy.docId), "w")) {
                        if (in == null || out == null) throw new FolderException("FAILED", "Could not copy the file");
                        pipe(in, out, Long.MAX_VALUE);
                    }
                    DocumentsContract.deleteDocument(resolver(), current);
                    current = f.doc(copy.docId);
                }
                else current = moved;
            }
            Node now = query(f.tree, current);
            if (now != null && !newName.equals(now.name)) {
                Uri renamed = DocumentsContract.renameDocument(resolver(), current, newName);
                if (renamed != null) current = renamed;
            }
        } catch (SecurityException e) {
            throw new FolderException("REVOKED", "Android no longer grants write access to \"" + f.name + "\"");
        } catch (IOException | IllegalArgumentException | UnsupportedOperationException e) {
            throw new FolderException("UNSUPPORTED", "The storage refused the move: " + e.getMessage());
        }
        Node fin = query(f.tree, current);
        List<String> finalPath = new ArrayList<>(dest.subList(0, dest.size() - 1));
        finalPath.add(fin != null && fin.name != null ? fin.name : newName);
        JSONObject res = new JSONObject();
        res.put("path", String.join("/", finalPath));
        return res;
    }

    private static long pipe(InputStream in, OutputStream out, long max) throws IOException, FolderException {
        byte[] buf = new byte[65536];
        long total = 0;
        int r;
        while ((r = in.read(buf)) > 0) {
            total += r;
            if (total > max) throw new FolderException("TOO_LARGE", "The file is larger than " + (max / (1024 * 1024)) + " MB");
            out.write(buf, 0, r);
        }
        out.flush();
        return total;
    }

    /** The workspace file a file:// URI names, refusing anything outside files/agent/workspace. */
    File workspaceFile(String uri) throws FolderException {
        try {
            Uri u = Uri.parse(uri);
            if (!"file".equals(u.getScheme()) || u.getPath() == null) throw new FolderException("BAD_PATH", "Not a workspace file");
            File root = new File(context.getFilesDir(), "agent/workspace").getCanonicalFile();
            File file = new File(u.getPath()).getCanonicalFile();
            if (!file.getPath().startsWith(root.getPath() + File.separator)) throw new FolderException("BAD_PATH", "Workspace paths must stay inside the workspace");
            return file;
        } catch (IOException e) {
            throw new FolderException("BAD_PATH", "Not a workspace file");
        }
    }

    JSONObject copyToWorkspace(String id, String path, String dest, boolean overwrite, long maxBytes) throws FolderException, JSONException {
        Folder f = open(id, false);
        Node n = require(f, path);
        if (n.isDir()) throw new FolderException("NOT_A_FILE", "\"" + displayPath(f, path) + "\" is a folder; copy files one at a time");
        if (maxBytes > 0 && n.size > maxBytes) throw new FolderException("TOO_LARGE", "The file is larger than " + (maxBytes / (1024 * 1024)) + " MB");
        File target = workspaceFile(dest);
        if (target.exists() && !overwrite) throw new FolderException("EXISTS", "The workspace already has that file");
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new FolderException("FAILED", "Could not create the workspace folder");
        File tmp = new File(parent, "." + target.getName() + ".part");
        long bytes;
        try (InputStream in = resolver().openInputStream(f.doc(n.docId)); OutputStream out = new FileOutputStream(tmp)) {
            if (in == null) throw new FolderException("FAILED", "The file could not be opened");
            bytes = pipe(in, out, maxBytes > 0 ? maxBytes : Long.MAX_VALUE);
        } catch (SecurityException e) {
            tmp.delete();
            throw new FolderException("REVOKED", "Android no longer grants access to \"" + f.name + "\"");
        } catch (IOException | FolderException e) {
            tmp.delete();
            if (e instanceof FolderException) throw (FolderException) e;
            throw new FolderException("FAILED", "Copy failed: " + e.getMessage());
        }
        if (target.exists() && !target.delete()) { tmp.delete(); throw new FolderException("FAILED", "Could not replace the workspace file"); }
        if (!tmp.renameTo(target)) { tmp.delete(); throw new FolderException("FAILED", "Could not save the workspace file"); }
        JSONObject res = new JSONObject();
        res.put("bytes", bytes);
        return res;
    }

    JSONObject copyFromWorkspace(String id, String src, String path, boolean overwrite, long maxBytes) throws FolderException, JSONException {
        Folder f = open(id, true);
        File source = workspaceFile(src);
        if (!source.isFile()) throw new FolderException("NOT_FOUND", "The workspace has no such file");
        if (maxBytes > 0 && source.length() > maxBytes) throw new FolderException("TOO_LARGE", "The file is larger than " + (maxBytes / (1024 * 1024)) + " MB");
        boolean[] created = { false };
        long bytes;
        try (InputStream in = new FileInputStream(source); OutputStream out = openForWrite(f, path, overwrite, created)) {
            bytes = pipe(in, out, maxBytes > 0 ? maxBytes : Long.MAX_VALUE);
        } catch (IOException e) {
            throw new FolderException("FAILED", "Copy failed: " + e.getMessage());
        }
        JSONObject res = new JSONObject();
        res.put("bytes", bytes);
        return res;
    }

    /** Breadth-first name search; an empty query lists files. Paths are relative to the folder. */
    JSONObject find(String id, String path, String query, int limit, int maxDepth) throws FolderException, JSONException {
        Folder f = open(id, false);
        Node start = require(f, path);
        if (!start.isDir()) throw new FolderException("NOT_A_DIRECTORY", "\"" + displayPath(f, path) + "\" is a file");
        String needle = query == null ? "" : query.toLowerCase(Locale.ROOT);
        String base = String.join("/", segments(path));
        int max = Math.max(1, Math.min(limit, 5000));
        JSONArray matches = new JSONArray();
        ArrayDeque<Object[]> queue = new ArrayDeque<>();
        queue.add(new Object[] { start, base, 0 });
        int scanned = 0;
        boolean truncated = false;
        while (!queue.isEmpty()) {
            Object[] item = queue.poll();
            Node dir = (Node) item[0];
            String rel = (String) item[1];
            int depth = (Integer) item[2];
            for (Node n : children(f, dir)) {
                if (++scanned > FIND_MAX_SCANNED) { truncated = true; break; }
                String childRel = rel.isEmpty() ? n.name : rel + "/" + n.name;
                boolean hit = needle.isEmpty() ? !n.isDir() : (n.name != null && n.name.toLowerCase(Locale.ROOT).contains(needle));
                if (hit) {
                    if (matches.length() >= max) { truncated = true; break; }
                    matches.put(entry(n, childRel));
                }
                if (n.isDir()) {
                    if (depth + 1 < maxDepth) queue.add(new Object[] { n, childRel, depth + 1 });
                    else truncated = true;
                }
            }
            if (truncated && (scanned > FIND_MAX_SCANNED || matches.length() >= max)) break;
        }
        JSONObject out = new JSONObject();
        out.put("matches", matches);
        out.put("scanned", scanned);
        out.put("truncated", truncated);
        return out;
    }
}
