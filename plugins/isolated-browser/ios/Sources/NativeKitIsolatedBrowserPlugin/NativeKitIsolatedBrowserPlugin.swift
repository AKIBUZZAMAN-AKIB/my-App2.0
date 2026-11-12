import Foundation
import Capacitor
import UIKit
import WebKit

@objc(NativeKitIsolatedBrowserPlugin)
public final class NativeKitIsolatedBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeKitIsolatedBrowserPlugin"
    public let jsName = "NativeKitIsolatedBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "runtimeInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isStaged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginStage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeStageChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitStage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abortStage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeStagedApp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "postMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private var controllers: [String: IsolatedBrowserViewController] = [:]
    private var remoteControllers: [String: RemoteBrowserViewController] = [:]

    private final class PendingPermission {
        let sessionId: String
        let call: CAPPluginCall
        var alert: UIAlertController?
        var timeout: DispatchWorkItem?
        init(sessionId: String, call: CAPPluginCall) {
            self.sessionId = sessionId
            self.call = call
        }
    }
    private var pendingPermissions: [String: PendingPermission] = [:]

    @objc func runtimeInfo(_ call: CAPPluginCall) {
        call.resolve([
            "supported": true,
            "platform": "ios",
            "persistentPartitions": ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 17
        ])
    }

    @objc func isStaged(_ call: CAPPluginCall) {
        do { call.resolve(["staged": try IsolatedAppStore.isStaged(appId: required(call, "appId"), integrity: required(call, "integrity"))]) }
        catch { reject(call, error) }
    }

    @objc func beginStage(_ call: CAPPluginCall) {
        do {
            let stageId = try IsolatedAppStore.begin(
                appId: required(call, "appId"),
                integrity: required(call, "integrity"),
                entry: required(call, "entry"),
                fileCount: requiredInt(call, "fileCount"),
                totalBytes: Int64(requiredInt(call, "totalBytes"))
            )
            call.resolve(["stageId": stageId])
        } catch { reject(call, error) }
    }

    @objc func writeStageChunk(_ call: CAPPluginCall) {
        do {
            let written = try IsolatedAppStore.writeChunk(
                stageId: required(call, "stageId"),
                path: required(call, "path"),
                offset: Int64(requiredInt(call, "offset")),
                encoded: call.getString("data") ?? "",
                final: call.getBool("final") ?? false
            )
            call.resolve(["bytesWritten": written])
        } catch { reject(call, error) }
    }

    @objc func commitStage(_ call: CAPPluginCall) {
        do { call.resolve(["origin": "nativekit-app://\(try IsolatedAppStore.commit(stageId: required(call, "stageId")))"]) }
        catch { reject(call, error) }
    }

    @objc func abortStage(_ call: CAPPluginCall) {
        do { try IsolatedAppStore.abort(stageId: required(call, "stageId")); call.resolve() }
        catch { reject(call, error) }
    }

    @objc func removeStagedApp(_ call: CAPPluginCall) {
        do {
            let appId = try required(call, "appId")
            try IsolatedAppStore.remove(appId: appId)
            if #available(iOS 17.0, *) {
                let identifier = IsolatedAppStore.profileIdentifier(appId)
                Task {
                    do { try await WKWebsiteDataStore.remove(forIdentifier: identifier); call.resolve() }
                    catch { self.reject(call, error) }
                }
            } else { call.resolve() }
        } catch { reject(call, error) }
    }

    @objc func open(_ call: CAPPluginCall) {
        do {
            let sessionId = try required(call, "sessionId")
            guard controllers[sessionId] == nil, controllers.isEmpty, remoteControllers.isEmpty else { throw pluginError("Another isolated browser session is already open") }
            let appId = try required(call, "appId")
            let integrity = try required(call, "integrity")
            let token = try required(call, "token")
            guard try IsolatedAppStore.isStaged(appId: appId, integrity: integrity) else { throw pluginError("App package is not staged") }
            let root = try IsolatedAppStore.committedDirectory(appId: appId, integrity: integrity)
            let controller = IsolatedBrowserViewController(
                sessionId: sessionId,
                appId: appId,
                token: token,
                title: try required(call, "title"),
                packageRoot: root,
                entry: try required(call, "entry"),
                bootstrap: try required(call, "bootstrap"),
                allowedHosts: try validatedAllowedHosts(call.getArray("allowedHosts", String.self) ?? []),
                allowDirectNetwork: call.getBool("allowDirectNetwork") ?? false,
                networkMode: call.getString("networkMode") ?? "",
                mediaAutoplay: call.getBool("mediaAutoplay") ?? false,
                hangTerminationDelayMs: try requiredInt(call, "hangTerminationDelayMs")
            )
            controller.onRequest = { [weak self] request, origin in
                self?.notifyListeners("isolatedBrowserRequest", data: [
                    "sessionId": sessionId,
                    "appId": appId,
                    "token": token,
                    "origin": origin,
                    "request": request
                ], retainUntilConsumed: true)
            }
            controller.onStatus = { [weak self] state, reason in
                self?.notifyListeners("isolatedBrowserStatus", data: [
                    "sessionId": sessionId,
                    "appId": appId,
                    "state": state,
                    "reason": reason
                ], retainUntilConsumed: true)
            }
            controller.onClose = { [weak self] in
                self?.cancelPermissionRequests(sessionId: sessionId, reason: "The isolated app session was closed")
                self?.controllers.removeValue(forKey: sessionId)
            }
            controllers[sessionId] = controller
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else {
                    self.controllers.removeValue(forKey: sessionId)
                    call.reject("Capacitor view controller is unavailable")
                    return
                }
                let navigation = UINavigationController(rootViewController: controller)
                navigation.modalPresentationStyle = .fullScreen
                presenter.present(navigation, animated: true) {
                    call.resolve(["origin": "nativekit-app://\(controller.originHost)"])
                }
            }
        } catch { reject(call, error) }
    }

    @objc func openUrl(_ call: CAPPluginCall) {
        do {
            let sessionId = try required(call, "sessionId")
            guard controllers.isEmpty, remoteControllers.isEmpty else { throw pluginError("Another isolated browser session is already open") }
            let rawURL = try required(call, "url")
            guard let url = URL(string: rawURL), url.scheme?.lowercased() == "https", url.host != nil, url.user == nil, url.password == nil else {
                throw pluginError("Remote URL mode accepts HTTPS URLs without embedded credentials only")
            }
            let title = call.getString("title") ?? url.host ?? "Browser"
            let allowedHosts = try validatedAllowedHosts(call.getArray("allowedHosts", String.self) ?? [])
            let controller = try RemoteBrowserViewController(sessionId: sessionId, title: title, url: url, allowedHosts: allowedHosts)
            controller.onStatus = { [weak self] state, reason in
                self?.notifyListeners("remoteBrowserStatus", data: ["sessionId": sessionId, "state": state, "reason": reason], retainUntilConsumed: true)
            }
            controller.onClose = { [weak self] in self?.remoteControllers.removeValue(forKey: sessionId) }
            remoteControllers[sessionId] = controller
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else {
                    self.remoteControllers.removeValue(forKey: sessionId)
                    call.reject("Capacitor view controller is unavailable")
                    return
                }
                let navigation = UINavigationController(rootViewController: controller)
                navigation.modalPresentationStyle = .fullScreen
                presenter.present(navigation, animated: true) { call.resolve(["sessionId": sessionId]) }
            }
        } catch { reject(call, error) }
    }

    @objc func closeUrl(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId") ?? ""
        guard let controller = remoteControllers[sessionId] else { call.resolve(); return }
        DispatchQueue.main.async { [weak self] in
            controller.close {
                if self?.remoteControllers[sessionId] === controller { self?.remoteControllers.removeValue(forKey: sessionId) }
                call.resolve()
            }
        }
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        do {
            let sessionId = try required(call, "sessionId")
            let requestId = try required(call, "requestId")
            let appName = try required(call, "appName")
            let capability = try required(call, "capability")
            let method = try required(call, "method")
            let summary = call.getString("argumentSummary") ?? ""
            let timeoutMs = max(1_000, min(120_000, try requiredInt(call, "timeoutMs")))
            guard requestId.count <= 100, appName.count <= 120, capability.count <= 80, method.count <= 200, summary.count <= 1_500 else {
                throw pluginError("Permission request metadata is too large")
            }
            DispatchQueue.main.async {
                guard self.pendingPermissions[requestId] == nil else { call.reject("Permission request ID is already active"); return }
                guard let controller = self.controllers[sessionId], controller.viewIfLoaded?.window != nil else {
                    call.reject("Trusted permission UI is unavailable for this isolated session")
                    return
                }
                let pending = PendingPermission(sessionId: sessionId, call: call)
                self.pendingPermissions[requestId] = pending
                let alert = UIAlertController(
                    title: "\(appName) requests native access",
                    message: "Capability: \(capability)\nMethod: \(method)\(summary.isEmpty ? "" : "\nArguments: \(summary)")\n\nOnly approve if you trust this installed app and expect this action.",
                    preferredStyle: .alert
                )
                pending.alert = alert
                for (title, action, style) in [
                    ("Allow once", "allow_once", UIAlertAction.Style.default),
                    ("Always allow this method", "allow_always", UIAlertAction.Style.default),
                    ("Block once", "block_once", UIAlertAction.Style.cancel),
                    ("Always block this method", "block_always", UIAlertAction.Style.destructive)
                ] {
                    alert.addAction(UIAlertAction(title: title, style: style) { [weak self] _ in
                        self?.finishPermissionRequest(requestId: requestId, action: action, error: nil)
                    })
                }
                let timeout = DispatchWorkItem { [weak self] in
                    self?.finishPermissionRequest(requestId: requestId, action: nil, error: "Trusted permission prompt timed out")
                }
                pending.timeout = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeout)
                controller.present(alert, animated: true)
            }
        } catch { reject(call, error) }
    }

    private func finishPermissionRequest(requestId: String, action: String?, error: String?) {
        guard let pending = pendingPermissions.removeValue(forKey: requestId) else { return }
        pending.timeout?.cancel()
        if pending.alert?.presentingViewController != nil { pending.alert?.dismiss(animated: true) }
        if let error { pending.call.reject(error) }
        else { pending.call.resolve(["shown": true, "action": action ?? "block_once"]) }
    }

    private func cancelPermissionRequests(sessionId: String, reason: String) {
        let requestIds = pendingPermissions.compactMap { requestId, pending in pending.sessionId == sessionId ? requestId : nil }
        for requestId in requestIds { finishPermissionRequest(requestId: requestId, action: nil, error: reason) }
    }

    @objc func dismissPermission(_ call: CAPPluginCall) {
        do {
            let sessionId = try required(call, "sessionId")
            let requestId = try required(call, "requestId")
            DispatchQueue.main.async {
                if self.pendingPermissions[requestId]?.sessionId == sessionId {
                    self.finishPermissionRequest(requestId: requestId, action: nil, error: "Permission request was resolved by the trusted host")
                }
                call.resolve()
            }
        } catch { reject(call, error) }
    }

    @objc func postMessage(_ call: CAPPluginCall) {
        do {
            let sessionId = try required(call, "sessionId")
            guard let controller = controllers[sessionId] else { throw pluginError("Isolated renderer response channel is unavailable") }
            let message = try required(call, "message")
            DispatchQueue.main.async {
                controller.postMessage(message) { error in
                    if let error { call.reject(error.localizedDescription, nil, error) }
                    else { call.resolve() }
                }
            }
        } catch { reject(call, error) }
    }

    @objc func close(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId") ?? ""
        cancelPermissionRequests(sessionId: sessionId, reason: "The isolated app session was closed")
        guard let controller = controllers[sessionId] else { call.resolve(); return }
        DispatchQueue.main.async { [weak self] in
            controller.close {
                if self?.controllers[sessionId] === controller { self?.controllers.removeValue(forKey: sessionId) }
                call.resolve()
            }
        }
    }

    private func validatedAllowedHosts(_ values: [String]) throws -> [String] {
        var result: [String] = []
        var seen = Set<String>()
        for raw in values {
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !value.isEmpty, value.count <= 260 else { throw pluginError("Invalid allowed host") }
            let hostAndPort = value.split(separator: ":", omittingEmptySubsequences: false)
            guard hostAndPort.count == 1 || hostAndPort.count == 2 else { throw pluginError("Invalid allowed host") }
            if hostAndPort.count == 2 {
                guard let port = Int(hostAndPort[1]), port >= 1, port <= 65_535 else { throw pluginError("Invalid allowed host port") }
            }
            var hostname = String(hostAndPort[0])
            if hostname.hasPrefix("*.") { hostname.removeFirst(2) }
            let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
            guard !labels.isEmpty, hostname.count <= 253 else { throw pluginError("Invalid allowed host") }
            for label in labels {
                let scalars = Array(label.unicodeScalars)
                let asciiAlphanumeric: (Unicode.Scalar) -> Bool = { scalar in
                    (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 97 && scalar.value <= 122)
                }
                guard !scalars.isEmpty, scalars.count <= 63,
                      asciiAlphanumeric(scalars[0]), asciiAlphanumeric(scalars[scalars.count - 1]),
                      scalars.allSatisfy({ asciiAlphanumeric($0) || $0.value == 45 }) else {
                    throw pluginError("Invalid allowed host")
                }
            }
            if seen.insert(value).inserted { result.append(value) }
        }
        return result
    }

    private func required(_ call: CAPPluginCall, _ key: String) throws -> String {
        guard let value = call.getString(key), !value.isEmpty else { throw pluginError("Missing \(key)") }
        return value
    }

    private func requiredInt(_ call: CAPPluginCall, _ key: String) throws -> Int {
        guard let value = call.getInt(key) else { throw pluginError("Missing \(key)") }
        return value
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        call.reject(error.localizedDescription, nil, error)
    }

    private func pluginError(_ message: String) -> NSError {
        NSError(domain: "NativeKitIsolatedBrowser", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
