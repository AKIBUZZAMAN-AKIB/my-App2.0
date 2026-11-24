import XCTest
@testable import NativeAgentPlugin

/// The host side of main memory (plan.md Phase 1 item 7 and Phase 4): fixed
/// ids that match the engine byte for byte, backfill of old stores, the
/// engine's flags (pin, Trash, main_hidden) and what the engine reads back for
/// export (id, text and metadata in search results). Mirrors the Android
/// MemoryProviderImplTest.
final class MemoryProviderImplTests: XCTestCase {
    private var base: URL!
    private var storeURL: URL {
        base.appendingPathComponent(MemoryProviderImpl.directoryName, isDirectory: true)
            .appendingPathComponent(MemoryProviderImpl.fileName)
    }
    /// The value `ws/pinned_id.txt` pins on the Rust side (`entry_id("city", 1700000000000)`).
    private let pinnedCityId = "mem_HDGFC3VFH21H2TXV7XPVGBTJK3"

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("mem-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    private func provider() -> MemoryProviderImpl { MemoryProviderImpl(baseDirectory: base) }
    private func object(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    }
    private func array(_ s: String) -> [Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [Any] ?? []
    }
    private func entries() throws -> [[String: Any]] {
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: storeURL)) as? [String: Any]
        return root?["entries"] as? [[String: Any]] ?? []
    }
    private func writeStore(_ list: [[String: Any]]) throws {
        try FileManager.default.createDirectory(at: storeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["version": 1, "entries": list]).write(to: storeURL)
    }
    private func merge(_ flags: [String: Any]) -> String {
        var all = flags
        all["__merge"] = true
        return String(data: try! JSONSerialization.data(withJSONObject: all), encoding: .utf8)!
    }

    func testEntryIdMatchesTheEngine() {
        XCTAssertEqual(MemoryProviderImpl.entryId(key: "city", createdAt: 1_700_000_000_000), pinnedCityId)
        XCTAssertEqual(MemoryProviderImpl.entryId(key: "x", createdAt: 1).count, 30)
        XCTAssertNotEqual(MemoryProviderImpl.entryId(key: "x", createdAt: 1), MemoryProviderImpl.entryId(key: "x", createdAt: 2))
    }

    func testStoreReturnsAFixedIdThatSurvivesUpdates() throws {
        let p = provider()
        let first = object(p.store(key: "city", text: "Dhaka", metadataJson: nil))
        XCTAssertEqual(first["success"] as? Bool, true)
        let id = try XCTUnwrap(first["id"] as? String)
        XCTAssertTrue(id.hasPrefix("mem_"))
        let createdAt = MemoryProviderImpl.millis(try entries()[0]["createdAt"])
        XCTAssertEqual(MemoryProviderImpl.entryId(key: "city", createdAt: createdAt), id)
        let second = object(p.store(key: "city", text: "Chattogram", metadataJson: nil))
        XCTAssertEqual(second["id"] as? String, id)
        XCTAssertEqual(try entries().count, 1)
        XCTAssertEqual(try entries()[0]["text"] as? String, "Chattogram")
    }

    func testOldStoreWithoutIdsIsBackfilledOnRead() throws {
        try writeStore([["key": "city", "text": "Dhaka", "createdAt": 1_700_000_000_000 as Int64, "updatedAt": 1_700_000_000_000 as Int64]])
        let hits = array(provider().search(query: "Dhaka", maxResults: 5))
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual((hits.first as? [String: Any])?["id"] as? String, pinnedCityId)
        XCTAssertEqual(try entries()[0]["id"] as? String, pinnedCityId)
    }

    func testExportReadsIdTextAndMetadata() throws {
        let p = provider()
        _ = p.store(key: "diet", text: "Vegetarian, no peanuts", metadataJson: "{\"source\":\"chat\"}")
        let hit = try XCTUnwrap(array(p.search(query: "peanuts", maxResults: 5)).first as? [String: Any])
        XCTAssertEqual(hit["key"] as? String, "diet")
        XCTAssertEqual(hit["text"] as? String, "Vegetarian, no peanuts")
        XCTAssertEqual((hit["metadata"] as? [String: Any])?["source"] as? String, "chat")
        XCTAssertTrue((hit["id"] as? String ?? "").hasPrefix("mem_"))
        XCTAssertEqual(array(p.list(prefix: nil, limit: nil)) as? [String], ["diet"])
    }

    func testMergeSetsAndClearsEngineFlagsAndTheyOutliveARewrite() throws {
        let p = provider()
        let id = object(p.store(key: "plan", text: "deploy on friday", metadataJson: nil))["id"] as? String
        let merged = object(p.store(key: "plan", text: "", metadataJson: merge(["pinned": true])))
        XCTAssertEqual(merged["id"] as? String, id)
        XCTAssertEqual(try entries()[0]["text"] as? String, "deploy on friday")
        _ = p.store(key: "plan", text: "deploy on monday", metadataJson: "{\"note\":\"moved\"}")
        let meta = try XCTUnwrap(try entries()[0]["metadata"] as? [String: Any])
        XCTAssertEqual(meta["pinned"] as? Bool, true)
        XCTAssertEqual(meta["note"] as? String, "moved")
        _ = p.store(key: "plan", text: "", metadataJson: merge(["pinned": NSNull()]))
        XCTAssertNil((try entries()[0]["metadata"] as? [String: Any])?["pinned"])
        XCTAssertNotNil(object(p.store(key: "nope", text: "", metadataJson: merge(["pinned": true])))["error"])
        XCTAssertEqual(try entries().count, 1)
    }

    func testTrashedAndMainHiddenEntriesLeaveMainSearchAndList() throws {
        let p = provider()
        _ = p.store(key: "a", text: "alpha note", metadataJson: nil)
        _ = p.store(key: "b", text: "beta note", metadataJson: nil)
        _ = p.store(key: "c", text: "gamma note", metadataJson: nil)
        _ = p.store(key: "a", text: "", metadataJson: merge(["trashed_at": 123]))
        _ = p.store(key: "b", text: "", metadataJson: merge(["main_hidden": true]))
        XCTAssertEqual(array(p.list(prefix: nil, limit: nil)) as? [String], ["c"])
        let hits = array(p.search(query: "note", maxResults: 10))
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual((hits.first as? [String: Any])?["key"] as? String, "c")
        XCTAssertEqual(try entries().count, 3)
        _ = p.store(key: "a", text: "", metadataJson: merge(["trashed_at": NSNull()]))
        XCTAssertEqual(Set(array(p.list(prefix: nil, limit: nil)) as? [String] ?? []), ["a", "c"])
    }

    func testEvictionSkipsPinnedEntries() throws {
        var list: [[String: Any]] = []
        for i in 0..<MemoryProviderImpl.maxEntries {
            var e: [String: Any] = ["key": "k\(i)", "text": "v\(i)", "createdAt": 1000 + i, "updatedAt": 1000 + i]
            if i == 0 { e["metadata"] = ["pinned": true] }
            list.append(e)
        }
        try writeStore(list)
        XCTAssertEqual(object(provider().store(key: "new", text: "fresh", metadataJson: nil))["success"] as? Bool, true)
        let after = try entries()
        let have = Set(after.compactMap { $0["key"] as? String })
        XCTAssertEqual(after.count, MemoryProviderImpl.maxEntries)
        XCTAssertTrue(have.contains("k0"), "pinned oldest entry kept")
        XCTAssertFalse(have.contains("k1"), "oldest unpinned entry removed")
        XCTAssertTrue(have.contains("new"))
    }

    func testPromotedCopiesAreMarked() throws {
        try writeStore([["key": "x", "text": "from agent", "createdAt": 5, "updatedAt": 5, "metadata": ["promotedFrom": "agent:a"]]])
        _ = provider().list(prefix: nil, limit: nil)
        XCTAssertEqual((try entries()[0]["metadata"] as? [String: Any])?["origin"] as? String, MemoryProviderImpl.promotedCopy)
    }

    func testForgetRemovesOnlyTheExactKey() {
        let p = provider()
        _ = p.store(key: "city", text: "Dhaka", metadataJson: nil)
        _ = p.store(key: "city2", text: "Sylhet", metadataJson: nil)
        XCTAssertEqual(object(p.forget(key: "city"))["success"] as? Bool, true)
        XCTAssertEqual(array(p.list(prefix: nil, limit: nil)) as? [String], ["city2"])
        XCTAssertNotNil(object(p.forget(key: "city"))["error"])
    }
}
