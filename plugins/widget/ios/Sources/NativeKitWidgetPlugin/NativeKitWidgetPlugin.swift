import Foundation
import Capacitor
import WidgetKit
import UIKit

@objc(NativeKitWidgetPlugin)
public class NativeKitWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeKitWidgetPlugin"
    public let jsName = "NativeKitWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listConfigs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWidgetIds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkOverlayPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestOverlayPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showFloating", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hideFloating", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isFloatingVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendToFloating", returnType: CAPPluginReturnPromise),
    ]

    private let keyPrefix = "nativekit.widget."

    private func appGroupSuite(_ call: CAPPluginCall?) -> UserDefaults? {
        if let suite = call?.getString("appGroup"), !suite.isEmpty {
            return UserDefaults(suiteName: suite)
        }
        // Default App Group for the containing app bundle; the widget extension must share it.
        guard let identifier = Bundle.main.bundleIdentifier else { return nil }
        return UserDefaults(suiteName: "group." + identifier)
    }

    @objc func setConfig(_ call: CAPPluginCall) {
        guard let kind = call.getString("kind"), !kind.isEmpty else {
            call.reject("kind is required"); return
        }
        guard let config = call.getObject("config") else {
            call.reject("config is required"); return
        }
        let suite = appGroupSuite(call)
        if let suite {
            let data = try? JSONSerialization.data(withJSONObject: config)
            suite.set(data, forKey: keyPrefix + kind)
            suite.synchronize()
        }
        // Refresh widgets that already exist on the home screen.
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve(["kind": kind, "saved": true])
    }

    @objc func getConfig(_ call: CAPPluginCall) {
        guard let kind = call.getString("kind"), !kind.isEmpty else {
            call.reject("kind is required"); return
        }
        var result: [String: Any] = ["kind": kind]
        if let suite = appGroupSuite(call), let data = suite.data(forKey: keyPrefix + kind),
           let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            result["config"] = config
        } else {
            result["config"] = NSNull()
        }
        call.resolve(result)
    }

    @objc func listConfigs(_ call: CAPPluginCall) {
        var result: [String: Any] = [:]
        if let suite = appGroupSuite(call) {
            guard let all = suite.dictionaryRepresentation() as? [String: Any] else {
                call.resolve(result); return
            }
            for (key, value) in all where key.hasPrefix(keyPrefix) {
                let kind = String(key.dropFirst(keyPrefix.count))
                if let data = value as? Data, let object = try? JSONSerialization.jsonObject(with: data) {
                    result[kind] = object
                } else if let dict = value as? [String: Any] {
                    result[kind] = dict
                }
            }
        }
        call.resolve(result)
    }

    @objc func getWidgetIds(_ call: CAPPluginCall) {
        // iOS has no stable, queryable widget ids from the app process.
        call.resolve(["ids": []])
    }

    @objc func reload(_ call: CAPPluginCall) {
        // WidgetKit is available on the iOS 15.0 deployment target, so no @available guard needed.
        if let kind = call.getString("kind"), !kind.isEmpty {
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        } else {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve(["updated": 1])
    }

    @objc func requestPin(_ call: CAPPluginCall) {
        // iOS has no programmatic "pin this widget" API; the user adds widgets from the gallery.
        call.resolve(["requested": false])
    }

    @objc func checkOverlayPermission(_ call: CAPPluginCall) {
        // Focused floating overlays are an Android-only concept on iOS.
        call.resolve(["granted": false, "supported": false])
    }

    @objc func requestOverlayPermission(_ call: CAPPluginCall) { call.resolve() }

    @objc func showFloating(_ call: CAPPluginCall) {
        call.reject("Floating overlay widgets are not supported on iOS")
    }

    @objc func hideFloating(_ call: CAPPluginCall) { call.resolve(["visible": false]) }

    @objc func isFloatingVisible(_ call: CAPPluginCall) { call.resolve(["visible": false]) }

    @objc func sendToFloating(_ call: CAPPluginCall) { call.resolve() }
}
