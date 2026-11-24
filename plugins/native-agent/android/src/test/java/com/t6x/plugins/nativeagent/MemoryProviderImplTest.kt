package com.t6x.plugins.nativeagent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardCopyOption

/**
 * Robolectric's `android.system.Os.rename` does nothing, so the provider's
 * atomic write (temp file + rename) would never land. Do the same atomic
 * rename the device does.
 */
@Implements(android.system.Os::class)
class ShadowAtomicRenameOs {
    companion object {
        @JvmStatic
        @Implementation
        fun rename(oldPath: String, newPath: String) {
            Files.move(Paths.get(oldPath), Paths.get(newPath), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

/**
 * The host side of main memory (plan.md Phase 1 item 7 and Phase 4): fixed
 * ids that match the engine byte for byte, backfill of old stores, the
 * engine's flags (pin, Trash, main_hidden) and what the engine reads back
 * for export (id, text and metadata in search results).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [ShadowAtomicRenameOs::class])
class MemoryProviderImplTest {
    private lateinit var context: Context
    private lateinit var store: File

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        store = File(File(context.noBackupFilesDir, MemoryProviderImpl.DIR_NAME), MemoryProviderImpl.FILE_NAME)
        store.parentFile?.deleteRecursively()
        File(context.filesDir, MemoryProviderImpl.DIR_NAME).deleteRecursively()
    }

    private fun provider() = MemoryProviderImpl(context)
    private fun obj(s: String) = JSONObject(s)
    private fun entries(): JSONArray = JSONObject(store.readText()).getJSONArray("entries")
    private fun keys(json: String): List<String> = JSONArray(json).let { a -> (0 until a.length()).map { a.getString(it) } }

    /** The value `ws/pinned_id.txt` pins on the Rust side (`entry_id("city", 1700000000000)`). */
    private val pinnedCityId = "mem_HDGFC3VFH21H2TXV7XPVGBTJK3"

    @Test
    fun entryIdMatchesTheEngine() {
        assertEquals(pinnedCityId, MemoryProviderImpl.entryId("city", 1_700_000_000_000L))
        assertEquals(30, MemoryProviderImpl.entryId("x", 1L).length)
        assertTrue(MemoryProviderImpl.entryId("x", 1L) != MemoryProviderImpl.entryId("x", 2L))
    }

    @Test
    fun storeReturnsAFixedIdThatSurvivesUpdates() {
        val p = provider()
        val raw = p.store("city", "Dhaka", null)
        val first = obj(raw)
        assertTrue(first.getBoolean("success"))
        val id = first.getString("id")
        assertTrue(id.startsWith("mem_"))
        val createdAt = entries().getJSONObject(0).getLong("createdAt")
        assertEquals(MemoryProviderImpl.entryId("city", createdAt), id)
        // Same key again: createdAt and so the id stay.
        val second = obj(p.store("city", "Chattogram", null))
        assertEquals(id, second.getString("id"))
        assertEquals(1, entries().length())
        assertEquals("Chattogram", entries().getJSONObject(0).getString("text"))
    }

    @Test
    fun oldStoreWithoutIdsIsBackfilledOnRead() {
        store.parentFile!!.mkdirs()
        store.writeText(
            JSONObject().put("version", 1).put(
                "entries",
                JSONArray().put(JSONObject().put("key", "city").put("text", "Dhaka").put("createdAt", 1_700_000_000_000L).put("updatedAt", 1_700_000_000_000L)),
            ).toString(),
        )
        val hits = JSONArray(provider().search("Dhaka", 5u))
        assertEquals(1, hits.length())
        assertEquals(pinnedCityId, hits.getJSONObject(0).getString("id"))
        assertEquals(pinnedCityId, entries().getJSONObject(0).getString("id"))
    }

    @Test
    fun exportReadsIdTextAndMetadata() {
        val p = provider()
        p.store("diet", "Vegetarian, no peanuts", JSONObject().put("source", "chat").toString())
        val hit = JSONArray(p.search("peanuts", 5u)).getJSONObject(0)
        assertEquals("diet", hit.getString("key"))
        assertEquals("Vegetarian, no peanuts", hit.getString("text"))
        assertEquals("chat", hit.getJSONObject("metadata").getString("source"))
        assertTrue(hit.getString("id").startsWith("mem_"))
        assertEquals(listOf("diet"), keys(p.list(null, null)))
    }

    @Test
    fun mergeSetsAndClearsEngineFlagsAndTheyOutliveARewrite() {
        val p = provider()
        val id = obj(p.store("plan", "deploy on friday", null)).getString("id")
        val merged = obj(p.store("plan", "", JSONObject().put("__merge", true).put("pinned", true).toString()))
        assertEquals(id, merged.getString("id"))
        assertEquals("deploy on friday", entries().getJSONObject(0).getString("text"))
        // The model rewrites the entry: the pin stays.
        p.store("plan", "deploy on monday", JSONObject().put("note", "moved").toString())
        val meta = entries().getJSONObject(0).getJSONObject("metadata")
        assertTrue(meta.getBoolean("pinned"))
        assertEquals("moved", meta.getString("note"))
        // null clears a flag.
        p.store("plan", "", JSONObject().put("__merge", true).put("pinned", JSONObject.NULL).toString())
        assertFalse(entries().getJSONObject(0).getJSONObject("metadata").has("pinned"))
        // Merge into a missing key is an error, not a new entry.
        assertTrue(obj(p.store("nope", "", JSONObject().put("__merge", true).put("pinned", true).toString())).has("error"))
        assertEquals(1, entries().length())
    }

    @Test
    fun trashedAndMainHiddenEntriesLeaveMainSearchAndList() {
        val p = provider()
        p.store("a", "alpha note", null)
        p.store("b", "beta note", null)
        p.store("c", "gamma note", null)
        p.store("a", "", JSONObject().put("__merge", true).put("trashed_at", 123L).toString())
        p.store("b", "", JSONObject().put("__merge", true).put("main_hidden", true).toString())
        assertEquals(listOf("c"), keys(p.list(null, null)))
        val hits = JSONArray(p.search("note", 10u))
        assertEquals(1, hits.length())
        assertEquals("c", hits.getJSONObject(0).getString("key"))
        // Kept on disk for restore and for the sub-agents it is shared with.
        assertEquals(3, entries().length())
        p.store("a", "", JSONObject().put("__merge", true).put("trashed_at", JSONObject.NULL).toString())
        assertEquals(setOf("a", "c"), keys(p.list(null, null)).toSet())
    }

    @Test
    fun evictionSkipsPinnedEntries() {
        store.parentFile!!.mkdirs()
        val list = JSONArray()
        for (i in 0 until MemoryProviderImpl.MAX_ENTRIES) {
            val e = JSONObject().put("key", "k$i").put("text", "v$i").put("createdAt", 1000L + i).put("updatedAt", 1000L + i)
            if (i == 0) e.put("metadata", JSONObject().put("pinned", true))
            list.put(e)
        }
        store.writeText(JSONObject().put("version", 1).put("entries", list).toString())
        assertTrue(obj(provider().store("new", "fresh", null)).getBoolean("success"))
        val after = entries()
        val have = (0 until after.length()).map { after.getJSONObject(it).getString("key") }.toSet()
        assertEquals(MemoryProviderImpl.MAX_ENTRIES, after.length())
        assertTrue("pinned oldest entry kept", "k0" in have)
        assertFalse("oldest unpinned entry removed", "k1" in have)
        assertTrue("new" in have)
    }

    @Test
    fun promotedCopiesAreMarked() {
        store.parentFile!!.mkdirs()
        store.writeText(
            JSONObject().put("version", 1).put(
                "entries",
                JSONArray().put(JSONObject().put("key", "x").put("text", "from agent").put("createdAt", 5L).put("updatedAt", 5L).put("metadata", JSONObject().put("promotedFrom", "agent:a"))),
            ).toString(),
        )
        provider().list(null, null)
        assertEquals(MemoryProviderImpl.PROMOTED_COPY, entries().getJSONObject(0).getJSONObject("metadata").getString("origin"))
    }

    @Test
    fun forgetRemovesOnlyTheExactKey() {
        val p = provider()
        p.store("city", "Dhaka", null)
        p.store("city2", "Sylhet", null)
        assertTrue(obj(p.forget("city")).getBoolean("success"))
        assertEquals(listOf("city2"), keys(p.list(null, null)))
        assertTrue(obj(p.forget("city")).has("error"))
    }
}
