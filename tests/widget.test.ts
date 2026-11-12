import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const parse = (relative: string) => JSON.parse(read(relative));

describe('widget plugin', () => {
  it('declares matching Java and Swift bridge names', () => {
    const java = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    const swift = read('plugins/widget/ios/Sources/NativeKitWidgetPlugin/NativeKitWidgetPlugin.swift');
    expect(java).toContain('@CapacitorPlugin(name = "NativeKitWidget")');
    expect(swift).toContain('public let jsName = "NativeKitWidget"');
  });

  it('imports AppWidgetManager from android.appwidget (not android.app) so it compiles', () => {
    // A real javac against android.jar/API 36 failed with "cannot find symbol
    // android.app.AppWidgetManager"; it lives in android.appwidget.
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    expect(plugin).toContain('import android.appwidget.AppWidgetManager;');
    expect(plugin).not.toContain('import android.app.AppWidgetManager;');
  });

  it('handles checked JSONException from org.json put/keys in WidgetStore', () => {
    // org.json.JSONObject.put(String,Object) throws checked JSONException; guard it.
    const store = read('plugins/widget/android/src/main/java/dev/nativekit/widget/WidgetStore.java');
    expect(store).toContain('import org.json.JSONException;');
    expect(store).toContain('catch (JSONException error)');
    // JSObject.put on the real Capacitor swallows JSONException, so the plugin must not
    // declare a throws clause for it (that would not match the Capacitor API).
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    expect(plugin).not.toContain('throws JSONException');
  });

  it('registers the Android package wiring expected by Capacitor', () => {
    const pkg = parse('plugins/widget/package.json');
    expect(pkg.capacitor.android.src).toBe('android');
    expect(pkg.capacitor.ios.src).toBe('ios');
    expect(pkg.peerDependencies['@capacitor/core']).toBeDefined();
  });

  it('is a file dependency of the shell', () => {
    const pkg = parse('package.json');
    expect(pkg.dependencies['@nativekit/widget']).toBe('file:plugins/widget');
  });

  it('ships a config-driven home-screen provider that renders from the widget store', () => {
    const provider = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetProvider.java');
    expect(provider).toContain('extends AppWidgetProvider');
    expect(provider).toContain('public abstract String kind()');
    expect(provider).toContain('RemoteViews(');
    expect(provider).toContain('updateAppWidget');
    expect(provider).toContain('ACTION_WIDGET_TAP');
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    expect(plugin).toContain('nativeWidgetTap'); // plugin maps taps to the event name
    expect(plugin).toContain('notifyListeners("nativeWidgetTap"');
  });

  it('ships a floating overlay service with a web-rendered panel and two-way bridge', () => {
    const service = read('plugins/widget/android/src/main/java/dev/nativekit/widget/FloatingWidgetService.java');
    expect(service).toContain('TYPE_APPLICATION_OVERLAY');
    expect(service).toContain('WebViewAssetLoader');
    expect(service).toContain('addJavascriptInterface(new NativeKitFloatingInterface(), "NativeKitFloating")');
    expect(service).toContain('window.__nativeKitFloatingApply');
    expect(service).toContain('ACTION_FLOATING_COMMAND');
    expect(service).toContain('ACTION_FLOATING_MESSAGE');
  });

  it('exposes the widget bridge and typings on the trusted host API', () => {
    const bridge = read('bridge/nativekit.ts');
    const declarations = read('types/nativekit.d.ts.template');
    expect(bridge).toContain("import { Widget } from '@nativekit/widget'");
    expect(bridge).toContain("widget: {");
    expect(bridge).toContain("Widget.setConfig");
    expect(bridge).toContain("Widget.reload");
    expect(bridge).toContain("nativeWidgetTap");
    expect(bridge).toContain("nativeFloatingMessage");
    expect(declarations).toContain('widget: NativeKitWidgetConfig');
    expect(declarations).toContain('listConfigs(): Promise<Record<string, NativeKitWidgetSpec>>');
    expect(declarations).toContain('onFloatingMessage');
  });

  it('wires widget providers, the floating service and overlay permissions into the generated manifest', () => {
    const configure = read('scripts/configure-native.mjs');
    expect(configure).toContain('android.appwidget.action.APPWIDGET_UPDATE');
    expect(configure).toContain('FloatingWidgetService');
    expect(configure).toContain('android.permission.SYSTEM_ALERT_WINDOW');
    expect(configure).toContain('PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
    expect(configure).toContain('sanitizeKind');
    expect(configure).toContain('_widget_provider.xml');
    expect(configure).toContain('Widget_${name} extends NativeKitWidgetProvider');
  });

  it('enables the widget feature and config in the schemas and app config', () => {
    const config = parse('app.config.json');
    const schema = read('app.config.schema.json');
    expect(config.features.widget).toBe(true);
    expect(config.widget.enabled).toBe(true);
    expect(config.widget.homeScreen.kinds.length).toBeGreaterThan(0);
    expect(config.widget.floating.enabled).toBe(true);
    expect(schema).toContain('"widget"');
    expect(schema).toContain('"features"');
    expect(schema).toContain('"floating"');
    expect(schema).toContain('"homeScreen"');
  });

  it('validates widget cross-field rules in the config library', () => {
    const lib = read('scripts/config-lib.mjs');
    expect(lib).toContain('/widget/enabled: features.widget');
    expect(lib).toContain('/widget/homeScreen/enabled');
    expect(lib).toContain('/widget/floating/enabled');
  });

  it('ships a demo floating page that speaks the overlay bridge', () => {
    const page = read('www/widgets/floating.html');
    expect(page).toContain('window.__nativeKitFloatingApply');
    expect(page).toContain('window.NativeKitFloating.postMessage');
    expect(page).toContain('widget.message');
  });

  it('ships a WidgetKit extension example and its integration README', () => {
    const view = read('plugins/widget/ios/WidgetExtension/NativeKitWidget.swift');
    const readme = read('plugins/widget/ios/WidgetExtension/README.md');
    expect(view).toContain('TimelineProvider');
    expect(view).toContain('StaticConfiguration');
    expect(view).toContain('nativekit.widget.nativekit-widget');
    expect(readme).toContain('App Group');
    expect(readme).toContain('Widget Extension');
  });

  it('keeps the WidgetKit view compilable on the iOS 15 deployment target', () => {
    // .containerBackground(for:.widget) is iOS 17+ only; it must be behind an
    // #available guard (the repo targets iOS 15.0), not used unconditionally.
    const view = read('plugins/widget/ios/WidgetExtension/NativeKitWidget.swift');
    expect(view).toContain('#available(iOS 17.0, *)');
    expect(view).toContain('containerBackground(for: .widget)');
    // The Swift methods must not use a redundant #available(iOS 14.0, *) guard.
    const plugin = read('plugins/widget/ios/Sources/NativeKitWidgetPlugin/NativeKitWidgetPlugin.swift');
    expect(plugin).not.toContain('#available(iOS 14.0, *)');
  });

  it('reads the whole call object for the floating spec (getData) so the bubble config is applied', () => {
    // showFloating(options) passes title/page/width/height at the top level; the plugin
    // must read call.getData() there (not call.getObject("config"), which would drop the
    // layout spec). setConfig, by contrast, legitimately uses getObject("config").
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    expect(plugin).toContain('JSObject config = call.getData();');
    // setConfig must keep reading the nested "config" object.
    expect(plugin).toContain('JSObject config = call.getObject("config");');
  });

  it('never calls the non-existent PluginCall.get(String)', () => {
    // Verified against real Capacitor 8.5.0 sources: PluginCall has getData(), getObject(),
    // getString/getBoolean/getInt/getLong/getFloat/getDouble/getArray — but NO get(String).
    // A call.get("data") would silently compile against a wrong stub (the bug we fixed) and
    // then die at runtime. sendToFloating must read data via getData().opt(...) instead.
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    expect(plugin).not.toMatch(/call\.get\(/);
    expect(plugin).toContain('call.getData().opt("data")');
  });
});
