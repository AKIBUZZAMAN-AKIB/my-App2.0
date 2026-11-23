package com.t6x.plugins.nativeagent

import android.content.Context
import android.system.Os
import org.json.JSONArray
import org.json.JSONObject
import uniffi.native_agent_ffi.MemoryProvider
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.ln

/**
 * Long-term memory for the agent — built in, file-backed, no vector database.
 *
 * ## Why this exists (and why it is not LanceDB any more)
 *
 * The engine's `memory_store` / `memory_recall` / `memory_search` /
 * `memory_forget` / `memory_list` tools do not store anything themselves: they
 * call a host-side `MemoryProvider` (Rust trait `MemoryProvider`, UniFFI callback
 * interface) and the host owns the storage. The previous implementation lived in
 * `src/main/java-memory`, was compiled only when the app also integrated the
 * third-party `capacitor-lancedb` plugin, and relied on vector embeddings — so on
 * every build that did not ship that plugin (`package.json` never had it) the
 * tools answered `{"error":"Memory provider not configured"}` and the feature was
 * dead weight.
 *
 * This class replaces it with something that is always present:
 *
 *  * **Storage** — one JSON document, `native-agent-memory/memory.json` under the
 *    app's private `noBackupFilesDir`, written atomically (exclusive temp file +
 *    rename) and capped by entry count, per-entry bytes, metadata bytes and total
 *    bytes. Existing stores under `filesDir` are migrated once; the active store
 *    is excluded from Android Auto Backup.
 *  * **Search** — a lexical scorer (token overlap with inverse document frequency
 *    weighting, plus a whole-phrase and a key-match bonus), *not* embeddings.
 *    That is an honest trade: it needs no model download, no network, no extra
 *    dependency and no second native runtime, and it matches the way an agent
 *    asks ("what did I note about X?"). It is deliberately not semantic: two
 *    phrasings with no shared word will not match, and the tool output says
 *    "lexical" so the model is not misled about that.
 *
 * ## Contract
 *
 * Every method returns a JSON **string** (never throws across the FFI boundary —
 * UniFFI would turn a thrown exception into a Rust error, and a bad memory write
 * must not fail the model's tool call):
 *   * `store`  → `{"success":true,"key":"…","id":"mem_…"}`
 *   * `recall` / `search` → `[{"key":…,"id":…,"text":…,"score":…,"metadata":…}, …]`
 *
 * Every record carries a fixed `id` (`mem_` + base32(SHA-256(key + "\u0000" +
 * createdAt)) cut to 26 characters). It is deterministic, so the engine's
 * workspace registry can point at `host:memory#<id>`, and a backfill, a
 * downgrade or a restore always produces the same value. Records without an
 * id are backfilled in place, once, the first time the store is read.
 *   * `list`   → `["key", …]`
 *   * `forget` → `{"success":true,"key":"…"}`
 *   * failure  → `{"error":"…"}`
 *
 * Rust bounds `recall`/`search` results and returns a `results` array; query-based
 * `memory_forget` only returns candidates. Deletion happens only for an exact key.
 */
class MemoryProviderImpl(context: Context) : MemoryProvider {

    private val appContext = context.applicationContext
    // noBackupFilesDir is excluded from Android Auto Backup even when a host app
    // has backups enabled. Keep the old filesDir path only for one-time migration.
    private val storeFile = File(File(appContext.noBackupFilesDir, DIR_NAME), FILE_NAME)
    private val legacyStoreFile = File(File(appContext.filesDir, DIR_NAME), FILE_NAME)
    // Shared between foreground and WorkManager provider instances in this
    // process. The adjacent OS file lock also serializes a second app process.
    private val lock = processLock(storeFile.absolutePath)

    init {
        // Move the pre-upgrade file out of the backup-eligible filesDir as soon
        // as the provider is constructed, not only after the first memory tool
        // call. Keep initialization available if migration fails; guarded memory
        // operations will return the storage error and retry safely.
        if (legacyStoreFile.isFile) {
            try {
                withStoreLock { Unit }
            } catch (error: OutOfMemoryError) {
                throw error
            } catch (error: Throwable) {
                android.util.Log.w(TAG, "Legacy memory migration will be retried when memory is accessed", error)
            }
        }
    }

    // ── MemoryProvider ──────────────────────────────────────────────────────

    override fun store(key: String, text: String, metadataJson: String?): String = guard {
        // Phase 4: `{"__merge": true, ...}` merges flags (pinned, trashed_at,
        // main_hidden) into an existing entry; empty text keeps its text.
        val merge = parseMetadata(metadataJson)
        if (merge?.optBoolean("__merge", false) == true) return@guard mergeEntry(key.trim(), text.trim(), merge)
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@guard error("Nothing to store: 'text' is empty.")
        val textBytes = trimmed.toByteArray(Charsets.UTF_8).size
        if (textBytes > MAX_TEXT_LENGTH) {
            return@guard error("Memory entry too large ($textBytes UTF-8 bytes, limit $MAX_TEXT_LENGTH).")
        }

        val resolvedKey = key.trim().ifEmpty { "mem-${System.currentTimeMillis()}-${randomSuffix()}" }
        if (resolvedKey.toByteArray(Charsets.UTF_8).size > MAX_KEY_BYTES) {
            return@guard error("Memory key exceeds the $MAX_KEY_BYTES byte limit.")
        }
        val now = System.currentTimeMillis()
        val metadata = parseMetadata(metadataJson)
        var resolvedId = ""

        withStoreLock {
            val entries = readDocument().entries
            // JSONArray has no indexOfFirst/find: walk it by index. (`entries[i]`
            // does not exist either — get() returns Any, so use optJSONObject.)
            var existing = -1
            for (index in 0 until entries.length()) {
                if (entries.optJSONObject(index)?.optString("key") == resolvedKey) {
                    existing = index
                    break
                }
            }

            val createdAt = if (existing >= 0) {
                entries.optJSONObject(existing)?.optLong("createdAt", now) ?: now
            } else {
                now
            }
            val record = JSONObject()
                .put("key", resolvedKey)
                .put("text", trimmed)
                .put("createdAt", createdAt)
                .put("updatedAt", now)
            // The engine's flags (Phase 4) survive a rewrite by the model.
            val kept = entries.optJSONObject(existing)?.optJSONObject("metadata")
            val merged = metadata ?: JSONObject()
            if (kept != null) for (flag in ENGINE_FLAGS) if (kept.has(flag) && !merged.has(flag)) merged.put(flag, kept.get(flag))
            if (merged.length() > 0) record.put("metadata", merged)
            record.put("id", entryId(resolvedKey, createdAt))

            if (existing >= 0) entries.remove(existing)
            entries.put(record) // update moves this memory to the newest position
            // Oldest first, but never a pinned entry (shared with a sub-agent),
            // and never the entry just stored.
            while (entries.length() > MAX_ENTRIES) {
                val victim = (0 until entries.length() - 1).firstOrNull { !isPinned(entries.optJSONObject(it)) }
                    ?: throw IllegalStateException("memory is full of shared entries")
                entries.remove(victim)
            }
            writeDocument(entries)
            resolvedId = record.optString("id")
        }

        JSONObject().put("success", true).put("key", resolvedKey).put("id", resolvedId).toString()
    }

    private fun mergeEntry(key: String, text: String, flags: JSONObject): String {
        if (key.isEmpty()) return error("Provide a key to update.")
        if (text.toByteArray(Charsets.UTF_8).size > MAX_TEXT_LENGTH) return error("Memory entry too large.")
        var id = ""
        val found = withStoreLock {
            val entries = readDocument().entries
            var hit: JSONObject? = null
            for (index in 0 until entries.length()) {
                val record = entries.optJSONObject(index) ?: continue
                if (record.optString("key") == key) { hit = record; break }
            }
            val record = hit ?: return@withStoreLock false
            val metadata = record.optJSONObject("metadata") ?: JSONObject()
            for (name in flags.keys().asSequence().toList()) {
                if (name == "__merge") continue
                if (flags.isNull(name)) metadata.remove(name) else metadata.put(name, flags.get(name))
            }
            if (metadata.toString().toByteArray(Charsets.UTF_8).size > MAX_METADATA_BYTES) {
                throw IllegalArgumentException("memory metadata exceeds the $MAX_METADATA_BYTES byte limit")
            }
            record.put("metadata", metadata)
            if (text.isNotEmpty()) record.put("text", text).put("updatedAt", System.currentTimeMillis())
            id = record.optString("id").ifEmpty { entryId(key, record.optLong("createdAt")) }
            record.put("id", id)
            writeDocument(entries)
            true
        }
        return if (found) JSONObject().put("success", true).put("key", key).put("id", id).toString()
        else error("No memory stored under key '$key'.")
    }

    /** Pinned entries are shared with a sub-agent: eviction skips them. */
    private fun isPinned(record: JSONObject?): Boolean =
        record?.optJSONObject("metadata")?.optBoolean("pinned", false) == true

    /** In Trash, or kept only for the sub-agents it is shared with. */
    private fun isHiddenFromMain(record: JSONObject?): Boolean {
        val metadata = record?.optJSONObject("metadata") ?: return false
        return metadata.optBoolean("main_hidden", false) || (metadata.has("trashed_at") && !metadata.isNull("trashed_at"))
    }

    override fun recall(query: String, limit: UInt): String = search(query, limit)

    override fun search(query: String, maxResults: UInt): String = guard {
        val limit = maxResults.toInt().coerceIn(1, MAX_RESULTS)
        val all = withStoreLock { readDocument().entries }
        val entries = JSONArray()
        for (index in 0 until all.length()) all.optJSONObject(index)?.takeUnless { isHiddenFromMain(it) }?.let { entries.put(it) }
        val scored = score(entries, query).take(limit)

        val results = JSONArray()
        for (hit in scored) {
            val item = JSONObject()
                .put("key", hit.record.optString("key"))
                .put("id", hit.record.optString("id").ifEmpty { entryId(hit.record.optString("key"), hit.record.optLong("createdAt")) })
                .put("text", hit.record.optString("text"))
                .put("score", hit.score)
            hit.record.optJSONObject("metadata")?.let { item.put("metadata", it) }
            results.put(item)
        }
        results.toString()
    }

    override fun forget(key: String): String = guard {
        val wanted = key.trim()
        if (wanted.isEmpty()) return@guard error("Provide a key to forget.")

        val removed = withStoreLock {
            val entries = readDocument().entries
            val kept = JSONArray()
            var found = false
            for (index in 0 until entries.length()) {
                val record = entries.optJSONObject(index) ?: continue
                if (record.optString("key") == wanted) found = true else kept.put(record)
            }
            if (found) writeDocument(kept)
            found
        }

        if (removed) {
            JSONObject().put("success", true).put("key", wanted).toString()
        } else {
            error("No memory stored under key '$wanted'.")
        }
    }

    override fun list(prefix: String?, limit: UInt?): String = guard {
        val wantedPrefix = prefix?.trim().orEmpty()
        val cap = (limit?.toInt() ?: MAX_RESULTS).coerceIn(1, MAX_RESULTS)

        val keys = JSONArray()
        val entries = withStoreLock {
            readDocument().entries.let { array ->
                // newest first, like every other listing this plugin returns
                (0 until array.length()).mapNotNull { array.optJSONObject(it) }.filterNot { isHiddenFromMain(it) }.sortedByDescending { it.optLong("updatedAt") }
            }
        }
        for (record in entries) {
            val candidate = record.optString("key")
            if (wantedPrefix.isEmpty() || candidate.startsWith(wantedPrefix)) {
                if (keys.length() >= cap) break
                keys.put(candidate)
            }
        }
        keys.toString()
    }

    // ── scoring (lexical, deterministic, no embeddings) ──────────────────────

    private data class Hit(val record: JSONObject, val score: Double)

    private class Document(val root: JSONObject) {
        val entries: JSONArray = root.optJSONArray("entries") ?: JSONArray()
    }

    private data class TokenStats(
        val frequencies: Map<String, Int>,
        val partialMatches: Set<String>,
    )

    private fun score(entries: JSONArray, query: String): List<Hit> {
        val queryTokens = tokenize(query, MAX_QUERY_TOKENS).distinct()
        val phrase = query.trim().lowercase()
        if (queryTokens.isEmpty() && phrase.length < MIN_PHRASE_LENGTH) return emptyList()

        val records = (0 until entries.length()).mapNotNull { entries.optJSONObject(it) }
        if (records.isEmpty()) return emptyList()
        val querySet = queryTokens.toHashSet()

        // Scan every token for exact matches so a relevant word near the end of
        // a maximum-sized memory is not silently ignored. Retain only counts for
        // this bounded query (at most 32 terms). Partial-prefix bonuses remain
        // intentionally limited to the first 512 document tokens to keep worst-
        // case scoring cheap on a phone.
        val stats = records.map { record ->
            scanTokenStats("${record.optString("text")} ${record.optString("key")}", querySet)
        }
        val documentFrequency = HashMap<String, Int>()
        for (tokenStats in stats) {
            for (token in tokenStats.frequencies.keys) {
                documentFrequency[token] = (documentFrequency[token] ?: 0) + 1
            }
        }

        val total = records.size
        val hits = ArrayList<Hit>()
        for ((index, record) in records.withIndex()) {
            val key = record.optString("key")
            val text = record.optString("text")
            val tokenStats = stats[index]
            var score = 0.0
            for (token in queryTokens) {
                val occurrences = tokenStats.frequencies[token] ?: 0
                if (occurrences == 0) continue
                val df = documentFrequency[token] ?: 1
                val inverseFrequency = ln(1.0 + total.toDouble() / df)
                val termFrequency = occurrences.toDouble() / (occurrences + 0.5)
                score += inverseFrequency * (1.0 + termFrequency)
            }

            if (phrase.length >= MIN_PHRASE_LENGTH && text.lowercase().contains(phrase)) score += PHRASE_BONUS
            for (token in queryTokens) if (key.lowercase().contains(token)) score += KEY_BONUS
            for (token in queryTokens) if (tokenStats.partialMatches.contains(token)) score += PARTIAL_BONUS

            if (score > 0.0) hits.add(Hit(record, round(score)))
        }

        return hits.sortedWith(compareByDescending<Hit> { it.score }.thenByDescending { it.record.optLong("updatedAt") })
    }

    private fun scanTokenStats(text: String, queryTokens: Set<String>): TokenStats {
        val frequencies = HashMap<String, Int>()
        val partialMatches = HashSet<String>()
        val current = StringBuilder()
        var documentTokenIndex = 0

        fun flush() {
            if (current.length >= MIN_TOKEN_LENGTH) {
                val token = current.toString()
                if (queryTokens.contains(token)) frequencies[token] = (frequencies[token] ?: 0) + 1
                if (documentTokenIndex < MAX_PARTIAL_SCAN_TOKENS) {
                    for (queryToken in queryTokens) {
                        if (queryToken.length >= MIN_PARTIAL_LENGTH && token.contains(queryToken)) {
                            partialMatches.add(queryToken)
                        }
                    }
                }
                documentTokenIndex++
            }
            current.setLength(0)
        }

        for (character in text.lowercase()) {
            if (character.isLetterOrDigit()) current.append(character) else flush()
        }
        flush()
        return TokenStats(frequencies, partialMatches)
    }

    /** Lowercase word/number runs of at least two characters. */
    private fun tokenize(text: String, maxTokens: Int): List<String> {
        val tokens = ArrayList<String>(minOf(maxTokens, 64))
        val current = StringBuilder()
        fun flush() {
            if (current.length >= MIN_TOKEN_LENGTH && tokens.size < maxTokens) tokens.add(current.toString())
            current.setLength(0)
        }
        for (character in text.lowercase()) {
            if (character.isLetterOrDigit()) {
                current.append(character)
            } else {
                flush()
                if (tokens.size >= maxTokens) return tokens
            }
        }
        flush()
        return tokens
    }

    private fun round(value: Double): Double = Math.round(value * 10_000.0) / 10_000.0

    // ── storage ─────────────────────────────────────────────────────────────

    private fun <T> withStoreLock(block: () -> T): T = lock.withLock {
        val directory = storeFile.parentFile
            ?: throw java.io.IOException("memory store has no parent directory")
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory) {
            throw java.io.IOException("could not create memory directory")
        }
        val lockFile = File(directory, "memory.lock")
        java.io.RandomAccessFile(lockFile, "rw").use { randomAccessFile ->
            val fileLock = randomAccessFile.channel.lock()
            try {
                migrateLegacyStore(directory)
                block()
            } finally {
                fileLock.release()
            }
        }
    }

    /**
     * Move the pre-upgrade filesDir store into noBackupFilesDir while holding
     * the store lock. A rename on the app's internal volume is atomic, so an
     * interrupted upgrade leaves either the old file or the new one intact.
     * If both exist, validate the new copy first and preserve the old snapshot
     * under noBackupFilesDir rather than overwriting either version.
     */
    private fun migrateLegacyStore(directory: File) {
        if (!legacyStoreFile.isFile) return

        if (storeFile.exists()) {
            if (!storeFile.isFile) {
                archiveLegacyStore(directory)
                throw java.io.IOException("memory store path exists but is not a file; legacy data was preserved in noBackupFilesDir")
            }
            // This also quarantines a corrupt current-format file. In that case,
            // move the intact legacy source into the primary location below.
            try {
                readDocument()
            } catch (error: java.io.IOException) {
                // Preserve both unknown-format files without replacing the
                // current one; the provider will keep reporting the read error.
                archiveLegacyStore(directory)
                throw error
            }
            if (storeFile.exists()) {
                archiveLegacyStore(directory)
                return
            }
        }

        // Rename is O(1) and keeps even an oversized/corrupt legacy document out
        // of backup. readDocument() will quarantine unsupported data afterward.
        renameFileOrThrow(legacyStoreFile, storeFile, "migrate the legacy memory store")
    }

    private fun archiveLegacyStore(directory: File) {
        val archive = File(directory, "${FILE_NAME}.legacy-${System.currentTimeMillis()}-${randomSuffix()}")
        renameFileOrThrow(legacyStoreFile, archive, "preserve the legacy memory snapshot")
    }

    private fun renameFileOrThrow(source: File, destination: File, action: String) {
        try {
            Os.rename(source.absolutePath, destination.absolutePath)
        } catch (error: Exception) {
            throw java.io.IOException("could not $action; the original file was left in place", error)
        }
    }

    private fun readDocument(): Document {
        if (!storeFile.isFile) return Document(JSONObject().put("version", FORMAT_VERSION))
        if (storeFile.length() > MAX_STORE_BYTES.toLong()) {
            quarantineStore("oversized")
            return Document(JSONObject().put("version", FORMAT_VERSION))
        }

        val parsed = try {
            JSONObject(storeFile.readText())
        } catch (_: Exception) {
            // A corrupt file must not break future tool calls, but it must be
            // moved successfully before a later write is allowed to replace it.
            quarantineStore("corrupt")
            return Document(JSONObject().put("version", FORMAT_VERSION))
        }
        val version = parsed.optInt("version", FORMAT_VERSION)
        if (version != FORMAT_VERSION) {
            // Another app version may have written a format this build cannot
            // safely migrate. Never downgrade or overwrite it with an empty document.
            throw java.io.IOException("memory store format $version is not supported (expected $FORMAT_VERSION)")
        }
        val entries = parsed.optJSONArray("entries")
        if (entries == null) {
            quarantineStore("corrupt")
            return Document(JSONObject().put("version", FORMAT_VERSION))
        }
        for (index in 0 until entries.length()) {
            val record = entries.optJSONObject(index)
            val key = record?.opt("key") as? String ?: ""
            val text = record?.opt("text") as? String ?: ""
            val metadataIsValid = record == null || !record.has("metadata") || record.isNull("metadata") || record.optJSONObject("metadata") != null
            if (record == null || key.trim().isEmpty() || key.toByteArray(Charsets.UTF_8).size > MAX_KEY_BYTES ||
                text.trim().isEmpty() || text.toByteArray(Charsets.UTF_8).size > MAX_TEXT_LENGTH || !metadataIsValid) {
                quarantineStore("corrupt")
                return Document(JSONObject().put("version", FORMAT_VERSION))
            }
        }
        parsed.put("version", FORMAT_VERSION)
        // Backfill fixed ids in place: add the field to records that lack it
        // and write the same document back once (we hold the store lock). No
        // record is copied, reordered or dropped, and FORMAT_VERSION stays 1.
        if (backfillIds(entries)) writeDocument(entries)
        return Document(parsed)
    }

    /** Add `id` to every record without one. True when anything changed. */
    internal fun backfillIds(entries: JSONArray): Boolean {
        var changed = false
        for (index in 0 until entries.length()) {
            val record = entries.optJSONObject(index) ?: continue
            if (record.optString("id").isEmpty()) {
                record.put("id", entryId(record.optString("key"), record.optLong("createdAt")))
                changed = true
            }
        }
        return changed
    }

    private fun quarantineStore(reason: String) {
        val parent = storeFile.parentFile ?: throw java.io.IOException("memory store has no parent directory")
        val backup = File(parent, "${storeFile.name}.$reason-${System.currentTimeMillis()}-${randomSuffix()}")
        if (!storeFile.renameTo(backup)) {
            throw java.io.IOException("could not preserve $reason memory store; refusing to overwrite the original")
        }
    }

    private fun writeDocument(entries: JSONArray) {
        val directory = storeFile.parentFile
            ?: throw java.io.IOException("memory store has no parent directory")
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory) {
            throw java.io.IOException("could not create memory directory")
        }

        // Keep the newest records while enforcing both count and total-size
        // limits. The old code bounded only entry count, allowing a valid-looking
        // 2,000 x 20,000-byte store to consume hundreds of MB.
        // Pinned records are kept first, then the newest of the rest.
        val retainedNewestFirst = ArrayList<JSONObject>()
        var bytesUsed = 128 // root/version/array framing headroom
        val order = (entries.length() - 1 downTo 0).sortedBy { if (isPinned(entries.optJSONObject(it))) 0 else 1 }
        val keep = HashSet<Int>()
        for (index in order) {
            if (keep.size >= MAX_ENTRIES) break
            val record = entries.optJSONObject(index) ?: continue
            val recordBytes = record.toString().toByteArray(Charsets.UTF_8).size
            if (recordBytes + 128 > MAX_STORE_BYTES) {
                throw java.io.IOException("one memory record exceeds the total store size limit")
            }
            if (bytesUsed + recordBytes + 2 > MAX_STORE_BYTES) break
            bytesUsed += recordBytes + 2
            keep.add(index)
        }
        for (index in entries.length() - 1 downTo 0) if (index in keep) entries.optJSONObject(index)?.let { retainedNewestFirst.add(it) }
        val boundedEntries = JSONArray()
        retainedNewestFirst.asReversed().forEach { boundedEntries.put(it) }
        val root = JSONObject().put("version", FORMAT_VERSION).put("entries", boundedEntries)
        val bytes = root.toString().toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_STORE_BYTES) {
            throw java.io.IOException("memory store exceeds the total size limit")
        }

        // createTempFile uses exclusive creation and an unpredictable name.
        // Rename within the same directory is atomic and replaces the old file;
        // never fall back to a truncating write on failure.
        val temporary = File.createTempFile("${storeFile.name}.", ".tmp", directory)
        try {
            java.io.FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            Os.rename(temporary.absolutePath, storeFile.absolutePath)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun parseMetadata(metadataJson: String?): JSONObject? {
        val raw = metadataJson?.trim().orEmpty()
        if (raw.isEmpty()) return null
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_METADATA_BYTES) {
            throw IllegalArgumentException("memory metadata exceeds the $MAX_METADATA_BYTES byte limit")
        }
        return JSONObject(raw)
    }

    private fun randomSuffix(): String = java.util.UUID.randomUUID().toString().take(8)

    /** Never throw across the FFI boundary; report failure as data. */
    private inline fun guard(block: () -> String): String = try {
        block()
    } catch (t: OutOfMemoryError) {
        throw t
    } catch (t: Throwable) {
        error("memory store failed: ${t.message ?: t::class.java.simpleName}")
    }

    private fun error(message: String): String = JSONObject().put("error", message).toString()

    companion object {
        /** Metadata flags the engine owns (Phase 4): kept across rewrites. */
        private val ENGINE_FLAGS = listOf("pinned", "trashed_at", "main_hidden")

        private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

        /**
         * The fixed id of one record. Must match the engine's
         * `ws::longterm::entry_id` byte for byte.
         */
        @JvmStatic
        fun entryId(key: String, createdAt: Long): String {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            digest.update(key.toByteArray(Charsets.UTF_8))
            digest.update(byteArrayOf(0))
            digest.update(createdAt.toString().toByteArray(Charsets.UTF_8))
            val out = StringBuilder()
            var buffer = 0
            var bits = 0
            for (b in digest.digest()) {
                buffer = (buffer shl 8) or (b.toInt() and 0xff)
                bits += 8
                while (bits >= 5) {
                    bits -= 5
                    out.append(CROCKFORD[(buffer shr bits) and 31])
                }
                buffer = buffer and ((1 shl bits) - 1)
            }
            if (bits > 0) out.append(CROCKFORD[(buffer shl (5 - bits)) and 31])
            return "mem_" + out.substring(0, 26)
        }

        private val PROCESS_LOCKS = java.util.concurrent.ConcurrentHashMap<String, ReentrantLock>()

        fun processLock(path: String): ReentrantLock =
            PROCESS_LOCKS.getOrPut(path) { ReentrantLock() }

        const val TAG = "NativeAgentMemory"
        const val DIR_NAME = "native-agent-memory"
        const val FILE_NAME = "memory.json"
        const val FORMAT_VERSION = 1
        const val MAX_ENTRIES = 2_000
        const val MAX_TEXT_LENGTH = 20_000
        const val MAX_KEY_BYTES = 512
        const val MAX_METADATA_BYTES = 16_384
        const val MAX_STORE_BYTES = 64_000_000
        const val MAX_RESULTS = 200
        const val MAX_QUERY_TOKENS = 32
        const val MAX_PARTIAL_SCAN_TOKENS = 512
        const val MIN_TOKEN_LENGTH = 2
        const val MIN_PHRASE_LENGTH = 3
        const val MIN_PARTIAL_LENGTH = 4
        const val PHRASE_BONUS = 2.0
        const val KEY_BONUS = 0.75
        const val PARTIAL_BONUS = 0.25
    }
}
