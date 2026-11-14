import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/// Folders the user shares with the agent on iPhone and iPad.
///
/// The user picks a folder in UIDocumentPickerViewController; we keep a bookmark
/// to it and open it with startAccessingSecurityScopedResource around each
/// operation. Removing a folder deletes its bookmark, which ends the app's
/// access. Every path is checked to stay inside the picked folder, symlinks
/// included. Errors carry the same codes as Android (bridge/folder-access.ts).
struct FolderError: Error {
    let code: String
    let message: String
}

final class NativeKitFolderStore {
    static let shared = NativeKitFolderStore()
    private let defaultsKey = "nativekit.shared.folders"
    private let maxFolders = 20
    private let findMaxScanned = 20000
    let queue = DispatchQueue(label: "nativekit.folders")

    // MARK: Grants

    private func stored() -> [[String: Any]] {
        UserDefaults.standard.array(forKey: defaultsKey) as? [[String: Any]] ?? []
    }

    private func save(_ folders: [[String: Any]]) {
        UserDefaults.standard.set(folders, forKey: defaultsKey)
    }

    private func resolveBookmark(_ entry: [String: Any]) -> URL? {
        guard let data = entry["bookmark"] as? Data else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        if stale, let id = entry["id"] as? String {
            // Refresh a stale bookmark while we still can reach the folder.
            let started = url.startAccessingSecurityScopedResource()
            defer { if started { url.stopAccessingSecurityScopedResource() } }
            if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                var all = stored()
                if let i = all.firstIndex(where: { ($0["id"] as? String) == id }) {
                    all[i]["bookmark"] = fresh
                    save(all)
                }
            }
        }
        return url
    }

    func list() -> [[String: Any]] {
        return stored().map { (entry: [String: Any]) -> [String: Any] in
            var row: [String: Any] = [
                "id": entry["id"] as? String ?? "",
                "name": entry["name"] as? String ?? "Folder",
                "mode": entry["mode"] as? String ?? "read",
                "location": entry["location"] as? String ?? "",
                "addedAt": entry["addedAt"] as? Double ?? 0,
                "canWrite": true,
            ]
            var available = false
            if let url = resolveBookmark(entry) {
                let started = url.startAccessingSecurityScopedResource()
                var isDir: ObjCBool = false
                available = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
                if started { url.stopAccessingSecurityScopedResource() }
            }
            row["available"] = available
            if !available { row["reason"] = "the folder was moved, deleted or its storage is unavailable" }
            return row
        }
    }

    func add(url: URL, mode: String) throws -> [String: Any] {
        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }
        let bookmark: Data
        do {
            bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        } catch {
            throw FolderError(code: "DENIED", message: "iOS did not allow keeping access to that folder")
        }
        let normMode = mode == "readwrite" ? "readwrite" : "read"
        // Resolve first: resolving can refresh stale bookmarks and save them, so
        // read the list again afterwards instead of writing back an older copy.
        let match = stored().firstIndex(where: { (resolveBookmark($0)?.standardizedFileURL.path) == url.standardizedFileURL.path })
        var all = stored()
        if let i = match, i < all.count {
            all[i]["mode"] = normMode
            all[i]["bookmark"] = bookmark
            save(all)
            return all[i]
        }
        if all.count >= maxFolders {
            throw FolderError(code: "LIMIT", message: "You can share up to \(maxFolders) folders; remove one first")
        }
        let id = "f" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(10))
        let entry: [String: Any] = [
            "id": id,
            "name": url.lastPathComponent.isEmpty ? "Folder" : url.lastPathComponent,
            "bookmark": bookmark,
            "mode": normMode,
            "location": NativeKitFolderStore.describeLocation(url),
            "addedAt": Date().timeIntervalSince1970 * 1000,
        ]
        all.append(entry)
        save(all)
        return entry
    }

    static func describeLocation(_ url: URL) -> String {
        let path = url.path
        if path.contains("/Mobile Documents/") { return "iCloud Drive" }
        if path.contains("/File Provider Storage/") || path.contains("/Containers/Shared/AppGroup/") { return "On My iPhone" }
        return url.deletingLastPathComponent().lastPathComponent
    }

    func setMode(id: String, mode: String) throws {
        var all = stored()
        guard let i = all.firstIndex(where: { ($0["id"] as? String) == id }) else {
            throw FolderError(code: "REVOKED", message: "This folder is no longer shared")
        }
        all[i]["mode"] = mode == "readwrite" ? "readwrite" : "read"
        save(all)
    }

    func remove(id: String) -> Bool {
        let all = stored()
        let keep = all.filter { ($0["id"] as? String) != id }
        save(keep)
        return keep.count != all.count
    }

    // MARK: Opening a folder

    struct Folder {
        let root: URL
        let name: String
        let writable: Bool
    }

    /// Runs body with the folder's security scope open.
    func withFolder<T>(_ id: String, write: Bool, _ body: (Folder) throws -> T) throws -> T {
        guard let entry = stored().first(where: { ($0["id"] as? String) == id }) else {
            throw FolderError(code: "REVOKED", message: "This folder is no longer shared")
        }
        let name = entry["name"] as? String ?? "Folder"
        guard let url = resolveBookmark(entry) else {
            throw FolderError(code: "REVOKED", message: "iOS no longer grants access to \"\(name)\"")
        }
        let writable = (entry["mode"] as? String) == "readwrite"
        if write && !writable { throw FolderError(code: "READ_ONLY", message: "\"\(name)\" is read-only") }
        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            throw FolderError(code: "REVOKED", message: "\"\(name)\" was moved, deleted or its storage is unavailable")
        }
        return try body(Folder(root: url.standardizedFileURL, name: name, writable: writable))
    }

    static func segments(_ path: String) throws -> [String] {
        if path.count > 1024 { throw FolderError(code: "BAD_PATH", message: "The path is too long") }
        if path.contains("://") { throw FolderError(code: "BAD_PATH", message: "Pass a path inside the shared folder, not a URI") }
        var out: [String] = []
        for raw in path.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true) {
            let seg = String(raw)
            if seg == "." || seg == ".." { throw FolderError(code: "BAD_PATH", message: "'.' and '..' are not allowed in paths") }
            if seg.utf16.count > 255 { throw FolderError(code: "BAD_PATH", message: "A name in the path is too long") }
            if seg.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) {
                throw FolderError(code: "BAD_PATH", message: "The path contains control characters")
            }
            out.append(seg)
        }
        return out
    }

    /// The URL for a relative path, refusing anything (symlinks included) that leaves the folder.
    static func url(_ folder: Folder, _ path: String) throws -> URL {
        var url = folder.root
        for seg in try segments(path) { url.appendPathComponent(seg) }
        let rootReal = folder.root.resolvingSymlinksInPath().path
        let real = url.resolvingSymlinksInPath().path
        if real != rootReal && !real.hasPrefix(rootReal.hasSuffix("/") ? rootReal : rootReal + "/") {
            throw FolderError(code: "BAD_PATH", message: "That path leads outside the shared folder")
        }
        return url
    }

    static func display(_ folder: Folder, _ path: String) -> String {
        let p = (try? segments(path).joined(separator: "/")) ?? path
        return p.isEmpty ? folder.name : folder.name + "/" + p
    }

    static func entry(_ url: URL, relPath: String?) -> [String: Any] {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .typeIdentifierKey])
        let isDir = values?.isDirectory ?? false
        var row: [String: Any] = ["name": url.lastPathComponent, "type": isDir ? "directory" : "file"]
        if let rel = relPath { row["path"] = rel }
        if !isDir, let size = values?.fileSize { row["size"] = size }
        if let date = values?.contentModificationDate { row["modified"] = date.timeIntervalSince1970 * 1000 }
        if !isDir, #available(iOS 14.0, *), let uti = values?.typeIdentifier, let type = UTType(uti), let mime = type.preferredMIMEType { row["mime"] = mime }
        return row
    }

    private static func isDirectory(_ url: URL) -> Bool? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return nil }
        return isDir.boolValue
    }

    private static func require(_ folder: Folder, _ path: String) throws -> (URL, Bool) {
        let url = try Self.url(folder, path)
        guard let dir = isDirectory(url) else {
            throw FolderError(code: "NOT_FOUND", message: "\"\(display(folder, path))\" does not exist")
        }
        return (url, dir)
    }

    private static func wrap<T>(_ folder: Folder, _ body: () throws -> T) throws -> T {
        do { return try body() } catch let error as FolderError { throw error } catch {
            let ns = error as NSError
            if ns.domain == NSCocoaErrorDomain && (ns.code == NSFileWriteNoPermissionError || ns.code == NSFileReadNoPermissionError) {
                throw FolderError(code: "REVOKED", message: "iOS no longer grants access to \"\(folder.name)\"")
            }
            throw FolderError(code: "FAILED", message: error.localizedDescription)
        }
    }

    /// Runs body under NSFileCoordinator, as Apple asks for files another process
    /// may own (iCloud Drive, other File Provider apps). A coordinated read also
    /// downloads an iCloud file that is only a placeholder on this device.
    static func coordinated<T>(_ folder: Folder, reading url: URL, _ body: (URL) throws -> T) throws -> T {
        var coordError: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordError) { actual in
            result = Result(catching: { try body(actual) })
        }
        return try finish(folder, coordError, result)
    }

    static func coordinated<T>(_ folder: Folder, writing url: URL, options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> T) throws -> T {
        var coordError: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: options, error: &coordError) { actual in
            result = Result(catching: { try body(actual) })
        }
        return try finish(folder, coordError, result)
    }

    private static func finish<T>(_ folder: Folder, _ coordError: NSError?, _ result: Result<T, Error>?) throws -> T {
        if let error = coordError { return try wrap(folder) { () throws -> T in throw error } }
        guard let result = result else { throw FolderError(code: "FAILED", message: "The file could not be reached") }
        return try wrap(folder) { try result.get() }
    }

    // MARK: Operations

    func listDir(id: String, path: String, limit: Int) throws -> [String: Any] {
        try withFolder(id, write: false) { (f: Folder) throws -> [String: Any] in
            let (url, dir) = try Self.require(f, path)
            if !dir { throw FolderError(code: "NOT_A_DIRECTORY", message: "\"\(Self.display(f, path))\" is a file") }
            return try Self.wrap(f) { () throws -> [String: Any] in
                let kids = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey], options: [])
                let max = Swift.max(1, Swift.min(limit, 1000))
                return ["entries": kids.prefix(max).map { Self.entry($0, relPath: nil) }, "truncated": kids.count > max]
            }
        }
    }

    func stat(id: String, path: String) throws -> [String: Any] {
        try withFolder(id, write: false) { (f: Folder) throws -> [String: Any] in
            let url = try Self.url(f, path)
            guard Self.isDirectory(url) != nil else { return ["exists": false, "name": "", "type": "file"] }
            var row = Self.entry(url, relPath: nil)
            row["exists"] = true
            return row
        }
    }

    func read(id: String, path: String, offset: UInt64, length: Int) throws -> [String: Any] {
        try withFolder(id, write: false) { (f: Folder) throws -> [String: Any] in
            let (url, dir) = try Self.require(f, path)
            if dir { throw FolderError(code: "NOT_A_FILE", message: "\"\(Self.display(f, path))\" is a folder") }
            return try Self.coordinated(f, reading: url) { (url: URL) throws -> [String: Any] in
                let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.uint64Value ?? 0
                let handle = try FileHandle(forReadingFrom: url)
                defer { handle.closeFile() }
                handle.seek(toFileOffset: Swift.min(offset, size))
                let data = handle.readData(ofLength: Swift.max(0, Swift.min(length, 1024 * 1024)))
                return [
                    "data": data.base64EncodedString(),
                    "bytesRead": data.count,
                    "size": size,
                    "eof": offset + UInt64(data.count) >= size,
                ]
            }
        }
    }

    private static func ensureDir(_ folder: Folder, _ url: URL) throws {
        if let dir = isDirectory(url) {
            if !dir { throw FolderError(code: "NOT_A_DIRECTORY", message: "\"\(url.lastPathComponent)\" is a file, not a folder") }
            return
        }
        try wrap(folder) { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil) }
    }

    private static func prepareTarget(_ folder: Folder, _ path: String, overwrite: Bool) throws -> (URL, Bool) {
        let segs = try segments(path)
        if segs.isEmpty { throw FolderError(code: "BAD_PATH", message: "Name a file inside the shared folder") }
        let target = try url(folder, path)
        try ensureDir(folder, target.deletingLastPathComponent())
        if let dir = isDirectory(target) {
            if dir { throw FolderError(code: "NOT_A_FILE", message: "\"\(display(folder, path))\" is a folder") }
            if !overwrite { throw FolderError(code: "EXISTS", message: "\"\(display(folder, path))\" already exists") }
            return (target, false)
        }
        return (target, true)
    }

    func write(id: String, path: String, base64: String, overwrite: Bool) throws -> [String: Any] {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            throw FolderError(code: "BAD_DATA", message: "The data is not valid base64")
        }
        return try withFolder(id, write: true) { (f: Folder) throws -> [String: Any] in
            let (target, created) = try Self.prepareTarget(f, path, overwrite: overwrite)
            try Self.coordinated(f, writing: target, options: created ? [] : .forReplacing) { (url: URL) throws -> Void in
                try data.write(to: url, options: .atomic)
            }
            return ["size": data.count, "created": created]
        }
    }

    func mkdir(id: String, path: String) throws -> [String: Any] {
        try withFolder(id, write: true) { (f: Folder) throws -> [String: Any] in
            if try Self.segments(path).isEmpty { throw FolderError(code: "BAD_PATH", message: "Name a folder inside the shared folder") }
            let url = try Self.url(f, path)
            let existed = Self.isDirectory(url) != nil
            try Self.ensureDir(f, url)
            return ["created": !existed]
        }
    }

    func delete(id: String, path: String, recursive: Bool) throws -> [String: Any] {
        try withFolder(id, write: true) { (f: Folder) throws -> [String: Any] in
            if try Self.segments(path).isEmpty { throw FolderError(code: "BAD_PATH", message: "The shared folder itself cannot be deleted") }
            let (url, dir) = try Self.require(f, path)
            if dir && !recursive, let kids = try? FileManager.default.contentsOfDirectory(atPath: url.path), !kids.isEmpty {
                throw FolderError(code: "NOT_EMPTY", message: "\"\(Self.display(f, path))\" is a folder with files in it; pass recursive: true to delete it all")
            }
            try Self.coordinated(f, writing: url, options: .forDeleting) { (url: URL) throws -> Void in
                try FileManager.default.removeItem(at: url)
            }
            return ["deleted": true]
        }
    }

    func move(id: String, path: String, to: String, overwrite: Bool) throws -> [String: Any] {
        try withFolder(id, write: true) { (f: Folder) throws -> [String: Any] in
            let from = try Self.segments(path).joined(separator: "/")
            let dest = try Self.segments(to).joined(separator: "/")
            if from.isEmpty || dest.isEmpty { throw FolderError(code: "BAD_PATH", message: "The shared folder itself cannot be moved") }
            if dest == from || dest.hasPrefix(from + "/") { throw FolderError(code: "BAD_PATH", message: "A folder cannot be moved into itself") }
            let (src, _) = try Self.require(f, from)
            let target = try Self.url(f, dest)
            try Self.ensureDir(f, target.deletingLastPathComponent())
            let caseOnly = from.lowercased() == dest.lowercased()
            if !caseOnly, let dir = Self.isDirectory(target) {
                if !overwrite { throw FolderError(code: "EXISTS", message: "\"\(Self.display(f, dest))\" already exists") }
                if dir { throw FolderError(code: "EXISTS", message: "\"\(Self.display(f, dest))\" is a folder and is not replaced") }
                try Self.wrap(f) { try FileManager.default.removeItem(at: target) }
            }
            try Self.wrap(f) { try FileManager.default.moveItem(at: src, to: target) }
            return ["path": dest]
        }
    }

    /// A workspace file from its file:// URI, refusing anything outside Library/NoCloud or Documents agent/workspace.
    static func workspaceFile(_ uri: String) throws -> URL {
        guard let url = URL(string: uri), url.isFileURL else { throw FolderError(code: "BAD_PATH", message: "Not a workspace file") }
        let real = url.standardizedFileURL.resolvingSymlinksInPath().path
        guard real.contains("/agent/workspace/"), !real.contains("/../") else {
            throw FolderError(code: "BAD_PATH", message: "Workspace paths must stay inside the workspace")
        }
        let appRoot = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?.deletingLastPathComponent().resolvingSymlinksInPath().path ?? ""
        if !appRoot.isEmpty && !real.hasPrefix(appRoot) {
            throw FolderError(code: "BAD_PATH", message: "Workspace paths must stay inside the workspace")
        }
        return url.standardizedFileURL
    }

    private static func fileSize(_ url: URL) -> UInt64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.uint64Value ?? 0
    }

    // MARK: Copies (chunked, cancellable, with progress)

    /// Progress of a running copy: (copyId, bytes so far, total). Called on the folder queue.
    typealias CopyProgress = (String, UInt64, UInt64) -> Void

    private let copyChunk = 1 << 20
    private let progressInterval: TimeInterval = 0.25
    private let stopsLock = NSLock()
    /// Stop flags of running copies by copy id. A cancel that arrives before its copy
    /// starts is kept (as true), so the copy never begins.
    private var copyStops: [String: Bool] = [:]

    /// Asks a running copy to stop before its next 1 MB chunk. Safe from any thread;
    /// it does not wait for the folder queue the copy runs on.
    @discardableResult
    func cancelCopy(_ copyId: String) -> Bool {
        guard !copyId.isEmpty else { return false }
        stopsLock.lock(); defer { stopsLock.unlock() }
        if copyStops.count > 256 { copyStops = copyStops.filter { !$0.value } }
        let running = copyStops[copyId] != nil
        copyStops[copyId] = true
        return running
    }

    private func startCopy(_ copyId: String) throws {
        guard !copyId.isEmpty else { return }
        stopsLock.lock(); defer { stopsLock.unlock() }
        if copyStops[copyId] == true { copyStops[copyId] = nil; throw Self.cancelled }
        copyStops[copyId] = false
    }

    private func endCopy(_ copyId: String) {
        guard !copyId.isEmpty else { return }
        stopsLock.lock(); copyStops[copyId] = nil; stopsLock.unlock()
    }

    private func isStopped(_ copyId: String) -> Bool {
        guard !copyId.isEmpty else { return false }
        stopsLock.lock(); defer { stopsLock.unlock() }
        return copyStops[copyId] == true
    }

    private static let cancelled = FolderError(code: "CANCELLED", message: "The copy was cancelled")

    /// Streams src into a new file at dst in 1 MB chunks, checking the stop flag and
    /// the size limit before each chunk. On any failure dst is deleted.
    private func streamCopy(from src: URL, to dst: URL, maxBytes: UInt64, total: UInt64, copyId: String, progress: CopyProgress?) throws -> UInt64 {
        let fm = FileManager.default
        guard let input = InputStream(url: src) else { throw FolderError(code: "FAILED", message: "The file could not be opened") }
        guard fm.createFile(atPath: dst.path, contents: nil, attributes: nil), let output = try? FileHandle(forWritingTo: dst) else {
            throw FolderError(code: "FAILED", message: "The copy could not be created")
        }
        input.open()
        var done: UInt64 = 0
        var lastReport = Date.distantPast
        var buffer = [UInt8](repeating: 0, count: copyChunk)
        do {
            defer { input.close(); try? output.close() }
            while true {
                if self.isStopped(copyId) { throw Self.cancelled }
                let n = buffer.withUnsafeMutableBufferPointer { input.read($0.baseAddress!, maxLength: copyChunk) }
                if n < 0 { throw FolderError(code: "FAILED", message: "Copy failed: \(input.streamError?.localizedDescription ?? "read error")") }
                if n == 0 { break }
                done += UInt64(n)
                if maxBytes > 0 && done > maxBytes { throw FolderError(code: "TOO_LARGE", message: "The file is larger than \(maxBytes / 1_048_576) MB") }
                try output.write(contentsOf: Data(buffer[0..<n]))
                let now = Date()
                if let progress = progress, now.timeIntervalSince(lastReport) >= progressInterval { lastReport = now; progress(copyId, done, total) }
            }
            if isStopped(copyId) { throw Self.cancelled }
            try output.synchronize()
        } catch {
            try? fm.removeItem(at: dst)
            throw error
        }
        progress?(copyId, done, total)
        return done
    }

    /// Copies a folder file into the workspace through a hidden temporary file that
    /// replaces the target only when complete: a failed or cancelled copy leaves no
    /// partial file and keeps an existing workspace file.
    func copyToWorkspace(id: String, path: String, dest: String, overwrite: Bool, maxBytes: UInt64, copyId: String = "", progress: CopyProgress? = nil) throws -> [String: Any] {
        let target = try Self.workspaceFile(dest)
        try startCopy(copyId)
        defer { endCopy(copyId) }
        return try withFolder(id, write: false) { (f: Folder) throws -> [String: Any] in
            let (src, dir) = try Self.require(f, path)
            if dir { throw FolderError(code: "NOT_A_FILE", message: "\"\(Self.display(f, path))\" is a folder; copy files one at a time") }
            let size = Self.fileSize(src)
            if maxBytes > 0 && size > maxBytes { throw FolderError(code: "TOO_LARGE", message: "The file is larger than \(maxBytes / 1_048_576) MB") }
            let fm = FileManager.default
            if fm.fileExists(atPath: target.path) && !overwrite { throw FolderError(code: "EXISTS", message: "The workspace already has that file") }
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
            let tmp = target.deletingLastPathComponent().appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString.prefix(8)).part")
            let bytes = try Self.coordinated(f, reading: src) { (src: URL) throws -> UInt64 in
                try Self.wrap(f) { try self.streamCopy(from: src, to: tmp, maxBytes: maxBytes, total: Self.fileSize(src), copyId: copyId, progress: progress) }
            }
            do {
                if self.isStopped(copyId) { throw Self.cancelled }
                if fm.fileExists(atPath: target.path) { _ = try fm.replaceItemAt(target, withItemAt: tmp) } else { try fm.moveItem(at: tmp, to: target) }
            } catch { try? fm.removeItem(at: tmp); throw error }
            return ["bytes": bytes]
        }
    }

    /// Copies a workspace file into the folder. The data goes to a hidden temporary
    /// file beside the target and replaces it only when complete, so a failed or
    /// cancelled copy creates nothing and keeps an existing file whole.
    func copyFromWorkspace(id: String, src: String, path: String, overwrite: Bool, maxBytes: UInt64, copyId: String = "", progress: CopyProgress? = nil) throws -> [String: Any] {
        let source = try Self.workspaceFile(src)
        guard FileManager.default.fileExists(atPath: source.path) else { throw FolderError(code: "NOT_FOUND", message: "The workspace has no such file") }
        let size = Self.fileSize(source)
        if maxBytes > 0 && size > maxBytes { throw FolderError(code: "TOO_LARGE", message: "The file is larger than \(maxBytes / 1_048_576) MB") }
        try startCopy(copyId)
        defer { endCopy(copyId) }
        return try withFolder(id, write: true) { (f: Folder) throws -> [String: Any] in
            let (target, created) = try Self.prepareTarget(f, path, overwrite: overwrite)
            return try Self.coordinated(f, writing: target, options: created ? [] : .forReplacing) { (target: URL) throws -> [String: Any] in
                let fm = FileManager.default
                let tmp = target.deletingLastPathComponent().appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString.prefix(8)).part")
                let bytes = try Self.wrap(f) { try self.streamCopy(from: source, to: tmp, maxBytes: maxBytes, total: size, copyId: copyId, progress: progress) }
                do {
                    if self.isStopped(copyId) { throw Self.cancelled }
                    if fm.fileExists(atPath: target.path) { _ = try fm.replaceItemAt(target, withItemAt: tmp) } else { try fm.moveItem(at: tmp, to: target) }
                } catch { try? fm.removeItem(at: tmp); throw error }
                return ["bytes": bytes]
            }
        }
    }

    func find(id: String, path: String, query: String, limit: Int, maxDepth: Int) throws -> [String: Any] {
        try withFolder(id, write: false) { (f: Folder) throws -> [String: Any] in
            let (start, dir) = try Self.require(f, path)
            if !dir { throw FolderError(code: "NOT_A_DIRECTORY", message: "\"\(Self.display(f, path))\" is a file") }
            let needle = query.lowercased()
            let base = try Self.segments(path).joined(separator: "/")
            let max = Swift.max(1, Swift.min(limit, 5000))
            var matches: [[String: Any]] = []
            var queue: [(URL, String, Int)] = [(start, base, 0)]
            var scanned = 0
            var truncated = false
            var index = 0
            outer: while index < queue.count {
                let (dirURL, rel, depth) = queue[index]
                index += 1
                let kids = (try? FileManager.default.contentsOfDirectory(at: dirURL, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey], options: [])) ?? []
                for kid in kids {
                    scanned += 1
                    if scanned > findMaxScanned { truncated = true; break outer }
                    let values = try? kid.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    let isDir = values?.isDirectory ?? false
                    let childRel = rel.isEmpty ? kid.lastPathComponent : rel + "/" + kid.lastPathComponent
                    let hit = needle.isEmpty ? !isDir : kid.lastPathComponent.lowercased().contains(needle)
                    if hit {
                        if matches.count >= max { truncated = true; break outer }
                        matches.append(Self.entry(kid, relPath: childRel))
                    }
                    if isDir && !(values?.isSymbolicLink ?? false) {
                        if depth + 1 < maxDepth { queue.append((kid, childRel, depth + 1)) } else { truncated = true }
                    }
                }
            }
            return ["matches": matches, "scanned": scanned, "truncated": truncated]
        }
    }
}

/// Holds the pending call while the folder picker is open.
final class NativeKitFolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
    static var current: NativeKitFolderPickerDelegate?
    let call: CAPPluginCall
    let mode: String

    init(call: CAPPluginCall, mode: String) {
        self.call = call
        self.mode = mode
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        defer { NativeKitFolderPickerDelegate.current = nil }
        guard let url = urls.first else { call.reject("No folder was picked", "CANCELLED"); return }
        let call = self.call
        let mode = self.mode
        NativeKitFolderStore.shared.queue.async {
            do {
                let entry = try NativeKitFolderStore.shared.add(url: url, mode: mode)
                let id = entry["id"] as? String ?? ""
                let row = NativeKitFolderStore.shared.list().first(where: { ($0["id"] as? String) == id }) ?? [:]
                call.resolve(["folder": row])
            } catch let error as FolderError {
                call.reject(error.message, error.code)
            } catch {
                call.reject(error.localizedDescription, "FAILED")
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        call.reject("No folder was picked", "CANCELLED")
        NativeKitFolderPickerDelegate.current = nil
    }
}

extension NativeKitCustomPlugin {
    private func folderRun(_ call: CAPPluginCall, _ job: @escaping () throws -> [String: Any]) {
        NativeKitFolderStore.shared.queue.async {
            do {
                call.resolve(try job())
            } catch let error as FolderError {
                call.reject(error.message, error.code)
            } catch {
                call.reject("Folder operation failed: \(error.localizedDescription)", "FAILED")
            }
        }
    }

    @objc func folderAdd(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? "read"
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("The folder picker could not be opened", "FAILED")
                return
            }
            let picker: UIDocumentPickerViewController
            if #available(iOS 14.0, *) {
                picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
            } else {
                picker = UIDocumentPickerViewController(documentTypes: ["public.folder"], in: .open)
            }
            picker.allowsMultipleSelection = false
            let delegate = NativeKitFolderPickerDelegate(call: call, mode: mode)
            NativeKitFolderPickerDelegate.current = delegate
            picker.delegate = delegate
            presenter.present(picker, animated: true)
        }
    }

    @objc func folderList(_ call: CAPPluginCall) {
        folderRun(call) { ["folders": NativeKitFolderStore.shared.list()] }
    }

    @objc func folderSetMode(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let mode = call.getString("mode") ?? "read"
        folderRun(call) {
            try NativeKitFolderStore.shared.setMode(id: id, mode: mode)
            return ["mode": mode == "readwrite" ? "readwrite" : "read"]
        }
    }

    @objc func folderRemove(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        folderRun(call) { ["removed": NativeKitFolderStore.shared.remove(id: id)] }
    }

    @objc func folderListDir(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let limit = call.getInt("limit") ?? 200
        folderRun(call) { try NativeKitFolderStore.shared.listDir(id: id, path: path, limit: limit) }
    }

    @objc func folderStat(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        folderRun(call) { try NativeKitFolderStore.shared.stat(id: id, path: path) }
    }

    @objc func folderRead(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let offset = UInt64(Swift.max(0, call.getDouble("offset") ?? 0))
        let length = call.getInt("length") ?? 262144
        folderRun(call) { try NativeKitFolderStore.shared.read(id: id, path: path, offset: offset, length: length) }
    }

    @objc func folderWrite(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let data = call.getString("data") ?? ""
        let overwrite = call.getBool("overwrite") ?? false
        folderRun(call) { try NativeKitFolderStore.shared.write(id: id, path: path, base64: data, overwrite: overwrite) }
    }

    @objc func folderMkdir(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        folderRun(call) { try NativeKitFolderStore.shared.mkdir(id: id, path: path) }
    }

    @objc func folderDelete(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let recursive = call.getBool("recursive") ?? false
        folderRun(call) { try NativeKitFolderStore.shared.delete(id: id, path: path, recursive: recursive) }
    }

    @objc func folderMove(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let to = call.getString("to") ?? ""
        let overwrite = call.getBool("overwrite") ?? false
        folderRun(call) { try NativeKitFolderStore.shared.move(id: id, path: path, to: to, overwrite: overwrite) }
    }

    @objc func folderCopyToWorkspace(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let dest = call.getString("dest") ?? ""
        let overwrite = call.getBool("overwrite") ?? false
        let maxBytes = UInt64(Swift.max(0, call.getDouble("maxBytes") ?? 268_435_456))
        let copyId = call.getString("copyId") ?? ""
        let progress = copyProgress(copyId)
        folderRun(call) { try NativeKitFolderStore.shared.copyToWorkspace(id: id, path: path, dest: dest, overwrite: overwrite, maxBytes: maxBytes, copyId: copyId, progress: progress) }
    }

    @objc func folderCopyFromWorkspace(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let src = call.getString("src") ?? ""
        let overwrite = call.getBool("overwrite") ?? false
        let maxBytes = UInt64(Swift.max(0, call.getDouble("maxBytes") ?? 268_435_456))
        let copyId = call.getString("copyId") ?? ""
        let progress = copyProgress(copyId)
        folderRun(call) { try NativeKitFolderStore.shared.copyFromWorkspace(id: id, src: src, path: path, overwrite: overwrite, maxBytes: maxBytes, copyId: copyId, progress: progress) }
    }

    /// Stops a running copy. Runs right here, not on the folder queue: the copy holds
    /// that queue until it ends, so a queued cancel would wait for it.
    @objc func folderCancelCopy(_ call: CAPPluginCall) {
        call.resolve(["cancelled": NativeKitFolderStore.shared.cancelCopy(call.getString("copyId") ?? "")])
    }

    private func copyProgress(_ copyId: String) -> NativeKitFolderStore.CopyProgress? {
        if copyId.isEmpty { return nil }
        return { [weak self] id, bytes, total in
            self?.notifyListeners("folderCopyProgress", data: ["copyId": id, "bytes": Double(bytes), "total": Double(total)])
        }
    }

    @objc func folderFind(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", path = call.getString("path") ?? ""
        let query = call.getString("query") ?? ""
        let limit = call.getInt("limit") ?? 50
        let maxDepth = Swift.max(1, Swift.min(32, call.getInt("maxDepth") ?? 16))
        folderRun(call) { try NativeKitFolderStore.shared.find(id: id, path: path, query: query, limit: limit, maxDepth: maxDepth) }
    }
}
