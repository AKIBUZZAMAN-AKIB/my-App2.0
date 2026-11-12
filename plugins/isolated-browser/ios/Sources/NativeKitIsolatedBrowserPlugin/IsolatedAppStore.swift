import Foundation
import CryptoKit

struct IsolatedStageMetadata: Codable {
    let appId: String
    let integrity: String
    let entry: String
    let fileCount: Int
    let totalBytes: Int64
    var writtenBytes: Int64
    var writtenFiles: [String]
    let createdAt: Date
}

enum IsolatedAppStore {
    private static let lock = NSLock()
    private static let appIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$")
    private static let integrityPattern = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")
    private static let metadataName = ".nativekit.json"
    private static let maxChunkBytes = 512 * 1024

    static func appKey(_ appId: String) -> String {
        SHA256.hash(data: Data(appId.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func originHost(_ appId: String) -> String {
        "nk-\(appKey(appId).prefix(32)).invalid"
    }

    static func profileIdentifier(_ appId: String) -> UUID {
        let value = appKey(appId)
        let formatted = "\(value.prefix(8))-\(value.dropFirst(8).prefix(4))-\(value.dropFirst(12).prefix(4))-\(value.dropFirst(16).prefix(4))-\(value.dropFirst(20).prefix(12))"
        return UUID(uuidString: formatted)!
    }

    /// Stable browser-only profile, intentionally separate from trusted-host and installed-app stores.
    static let remoteProfileIdentifier = UUID(uuidString: "b7801963-9ac9-424d-8cd2-9b03c81496d7")!

    static func root() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let result = base.appendingPathComponent("NativeKitIsolatedApps-v1", isDirectory: true)
        try FileManager.default.createDirectory(at: result, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = result
        try? mutable.setResourceValues(values)
        return result
    }

    static func validateIdentity(appId: String, integrity: String) throws {
        guard matches(appIdPattern, appId), matches(integrityPattern, integrity) else { throw storeError("Invalid isolated app identity") }
    }

    static func validatePath(_ value: String) throws -> String {
        guard !value.isEmpty, value.count <= 240, !value.hasPrefix("."), !value.hasPrefix("/"), !value.hasSuffix("/"), !value.contains("\\"), !value.contains("\0") else {
            throw storeError("Unsafe package path")
        }
        for part in value.split(separator: "/", omittingEmptySubsequences: false) where part.isEmpty || part == "." || part == ".." || part.hasPrefix(".") {
            _ = part
            throw storeError("Unsafe package path")
        }
        return value
    }

    static func begin(appId: String, integrity: String, entry: String, fileCount: Int, totalBytes: Int64) throws -> String {
        lock.lock(); defer { lock.unlock() }
        try validateIdentity(appId: appId, integrity: integrity)
        _ = try validatePath(entry)
        guard fileCount > 0, fileCount <= 5000, totalBytes > 0, totalBytes <= 128 * 1024 * 1024 else { throw storeError("Invalid package bounds") }
        let staging = try root().appendingPathComponent(".staging", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try pruneStale(staging)
        let stageId = UUID().uuidString.lowercased()
        let directory = staging.appendingPathComponent(stageId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try writeMetadata(IsolatedStageMetadata(appId: appId, integrity: integrity, entry: entry, fileCount: fileCount, totalBytes: totalBytes, writtenBytes: 0, writtenFiles: [], createdAt: Date()), directory: directory)
        return stageId
    }

    static func writeChunk(stageId: String, path: String, offset: Int64, encoded: String, final: Bool) throws -> Int64 {
        lock.lock(); defer { lock.unlock() }
        let directory = try stageDirectory(stageId)
        var metadata = try readMetadata(directory)
        let safePath = try validatePath(path)
        guard offset >= 0, encoded.count <= 720_000, let data = Data(base64Encoded: encoded), data.count <= maxChunkBytes else { throw storeError("Invalid stage chunk") }
        let destination = try resolve(directory, safePath)
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: destination.path) { FileManager.default.createFile(atPath: destination.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }
        let length = try handle.seekToEnd()
        guard Int64(length) == offset else { throw storeError("Stage chunk offset mismatch") }
        try handle.write(contentsOf: data)
        metadata.writtenBytes += Int64(data.count)
        guard metadata.writtenBytes <= metadata.totalBytes else { throw storeError("Staged package exceeds declared bytes") }
        if final {
            guard !metadata.writtenFiles.contains(safePath) else { throw storeError("Package file was finalized twice") }
            metadata.writtenFiles.append(safePath)
            guard metadata.writtenFiles.count <= metadata.fileCount else { throw storeError("Staged package exceeds declared file count") }
        }
        try writeMetadata(metadata, directory: directory)
        return metadata.writtenBytes
    }

    static func commit(stageId: String) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let stage = try stageDirectory(stageId)
        let metadata = try readMetadata(stage)
        try validateIdentity(appId: metadata.appId, integrity: metadata.integrity)
        guard metadata.writtenFiles.count == metadata.fileCount, metadata.writtenBytes == metadata.totalBytes else { throw storeError("Staged package is incomplete") }
        let entry = try resolve(stage, metadata.entry)
        guard FileManager.default.fileExists(atPath: entry.path) else { throw storeError("Staged entry file is missing") }
        guard try packageIntegrity(stage, metadata.writtenFiles) == metadata.integrity else { throw storeError("Staged package integrity mismatch") }
        let appDirectory = try root().appendingPathComponent("apps", isDirectory: true).appendingPathComponent(appKey(metadata.appId), isDirectory: true)
        try FileManager.default.createDirectory(at: appDirectory, withIntermediateDirectories: true)
        let target = appDirectory.appendingPathComponent(metadata.integrity, isDirectory: true)
        if FileManager.default.fileExists(atPath: target.path), verifyCommitted(target, appId: metadata.appId, integrity: metadata.integrity) {
            try FileManager.default.removeItem(at: stage)
            return originHost(metadata.appId)
        }
        var replaced: URL?
        if FileManager.default.fileExists(atPath: target.path) {
            let quarantine = appDirectory.appendingPathComponent(".replaced-\(UUID().uuidString.lowercased())", isDirectory: true)
            try FileManager.default.moveItem(at: target, to: quarantine)
            replaced = quarantine
        }
        do { try FileManager.default.moveItem(at: stage, to: target) }
        catch {
            if let replaced {
                do { try FileManager.default.moveItem(at: replaced, to: target) }
                catch let restorationError {
                    throw NSError(
                        domain: "NativeKitIsolatedStore",
                        code: 2,
                        userInfo: [
                            NSLocalizedDescriptionKey: "Atomic package commit failed and the previous package could not be restored",
                            NSUnderlyingErrorKey: error,
                            "restorationError": restorationError
                        ]
                    )
                }
            }
            throw error
        }
        if let replaced { try? FileManager.default.removeItem(at: replaced) }
        for version in try FileManager.default.contentsOfDirectory(at: appDirectory, includingPropertiesForKeys: nil) where version != target {
            try? FileManager.default.removeItem(at: version)
        }
        return originHost(metadata.appId)
    }

    static func abort(stageId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try FileManager.default.removeItem(at: stageDirectory(stageId))
    }

    static func isStaged(appId: String, integrity: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        try validateIdentity(appId: appId, integrity: integrity)
        let directory = try root().appendingPathComponent("apps", isDirectory: true).appendingPathComponent(appKey(appId), isDirectory: true).appendingPathComponent(integrity, isDirectory: true)
        return verifyCommitted(directory, appId: appId, integrity: integrity)
    }

    static func committedDirectory(appId: String, integrity: String) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        try validateIdentity(appId: appId, integrity: integrity)
        let directory = try root().appendingPathComponent("apps", isDirectory: true).appendingPathComponent(appKey(appId), isDirectory: true).appendingPathComponent(integrity, isDirectory: true)
        guard verifyCommitted(directory, appId: appId, integrity: integrity) else { throw storeError("Committed app verification failed") }
        return directory
    }

    static func remove(appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard matches(appIdPattern, appId) else { throw storeError("Invalid appId") }
        let directory = try root().appendingPathComponent("apps", isDirectory: true).appendingPathComponent(appKey(appId), isDirectory: true)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    static func resolve(_ base: URL, _ relativePath: String) throws -> URL {
        let safe = try validatePath(relativePath)
        let result = base.appendingPathComponent(safe).standardizedFileURL
        let prefix = base.standardizedFileURL.path + "/"
        guard result.path.hasPrefix(prefix) else { throw storeError("Package path escaped its root") }
        return result
    }

    private static func verifyCommitted(_ directory: URL, appId: String, integrity: String) -> Bool {
        do {
            let metadataURL = directory.appendingPathComponent(metadataName)
            guard FileManager.default.fileExists(atPath: metadataURL.path) else { return false }
            let metadata = try readMetadata(directory)
            guard metadata.appId == appId, metadata.integrity == integrity, metadata.writtenFiles.count == metadata.fileCount, metadata.writtenBytes == metadata.totalBytes else { return false }
            return try packageIntegrity(directory, metadata.writtenFiles) == integrity
        } catch { return false }
    }

    private static func packageIntegrity(_ directory: URL, _ paths: [String]) throws -> String {
        var digest = SHA256()
        let sorted = try paths.map(validatePath).sorted { Data($0.utf8).lexicographicallyPrecedes(Data($1.utf8)) }
        for path in sorted {
            let file = try resolve(directory, path)
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true, let size = values.fileSize else { throw storeError("Finalized package file is missing") }
            digest.update(data: Data(path.utf8))
            digest.update(data: Data([0]))
            digest.update(data: Data(String(size).utf8))
            digest.update(data: Data([0]))
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty { digest.update(data: chunk) }
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func stageDirectory(_ stageId: String) throws -> URL {
        guard UUID(uuidString: stageId) != nil else { throw storeError("Unknown stageId") }
        let staging = try root().appendingPathComponent(".staging", isDirectory: true)
        let result = staging.appendingPathComponent(stageId, isDirectory: true).standardizedFileURL
        guard result.path.hasPrefix(staging.standardizedFileURL.path + "/"), FileManager.default.fileExists(atPath: result.path) else { throw storeError("Unknown stageId") }
        return result
    }

    private static func readMetadata(_ directory: URL) throws -> IsolatedStageMetadata {
        try JSONDecoder().decode(IsolatedStageMetadata.self, from: Data(contentsOf: directory.appendingPathComponent(metadataName)))
    }

    private static func writeMetadata(_ metadata: IsolatedStageMetadata, directory: URL) throws {
        try JSONEncoder().encode(metadata).write(to: directory.appendingPathComponent(metadataName), options: [.atomic])
    }

    private static func pruneStale(_ staging: URL) throws {
        let urls = try FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: [.contentModificationDateKey])
        let cutoff = Date().addingTimeInterval(-86_400)
        for url in urls where (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast < cutoff {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private static func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
        expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value))?.range == NSRange(location: 0, length: value.utf16.count)
    }

    private static func storeError(_ message: String) -> NSError {
        NSError(domain: "NativeKitIsolatedStore", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
