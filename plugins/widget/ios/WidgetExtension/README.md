# iOS WidgetKit extension (example)

This folder contains a complete WidgetKit extension the developer can drop into the
`ios/App` Xcode project. The Capacitor plugin (`NativeKitWidgetPlugin`) already exposes
`NativeKit.widget.setConfig()` / `reload()`, so the only things you ever do in Xcode are:

## Steps (one-time)

1. Open `ios/App/App.xcodeproj` in Xcode.
2. **File → New → Target → Widget Extension.** Name it e.g. `NativeKitWidget`.
   Turn OFF "Include Configuration App Intent".
3. Replace the generated Swift files with the ones in this folder
   (`NativeKitWidgetBundle.swift`, `NativeKitWidget.swift`) and copy `Info.plist`.
4. **App Group:** Enable the App Group capability **on both** the app target and the
   widget extension target, and give them the *same* group, e.g. `group.com.example.app`.
   - Widget: set it in `NativeKitWidget.entitlements` (replace `YOUR_BUNDLE_IDENTIFIER`).
   - App: add the group to your app entitlements too.
5. In `NativeKitWidget.swift`, make sure the suite name matches the app. It defaults to
   `group.<bundle-id>`; if you used a custom group, change `load()` accordingly.
6. Add the widget extension to the app's "Embed App Extensions" build phase.
7. `npx cap sync ios` again (so the plugin is linked), then build.

## How data flows

- Web: `await NativeKit.widget.setConfig({ kind: 'nativekit-widget', config: { value: '42', title: 'Ping', ... } })`.
- The app writes the JSON into the shared App Group `UserDefaults(suiteName: "group.<bundle-id>")`
  under the key `nativekit.widget.<kind>` and calls `WidgetCenter.reloadAllTimelines()`.
- The widget's `TimelineProvider.load()` reads that suite/key and renders the SwiftUI view.

> The `kind` you pass to `setConfig` must equal the `kind` constant in
> `NativeKitWidget.swift` (`nativekit-widget`). Change both together to add more widget types.
