import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// scripts/config-lib.mjs has no bundled .d.ts; declare its surface so `tsc --noEmit` (npm run
// check) stays clean while vitest executes the real module.
// @ts-expect-error module has no type declarations
import * as configLib from '../scripts/config-lib.mjs';

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const parse = (relative: string) => JSON.parse(read(relative));

// Sanitize a JS string for regex-safe matching (not strictly needed, kept for clarity).
const unique = <T,>(arr: T[]) => [...new Set(arr)];

describe('widget API — differential contract tests', () => {
  it('validates the real app.config.json (executes validateConfig)', async () => {
    const { validateConfig } = configLib;
    // Throws when the config is invalid; consider any throw a failure.
    await expect(validateConfig({ throwOnError: true })).resolves.toBeDefined();
  });

  it('blocks path traversal out of the project root (executes resolveInsideRoot)', () => {
    const { resolveInsideRoot } = configLib;
    for (const evil of ['../etc/passwd', '../../x', '/etc/hosts', 'a/../../b']) {
      expect(() => resolveInsideRoot(evil)).toThrow();
    }
    // In-root stays allowed.
    expect(resolveInsideRoot('docs/x.md')).toContain(path.join(root, 'docs'));
  });

  it('exposes every plugin @PluginMethod on the trusted bridge (Widget.<method> call)', () => {
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    const bridge = read('bridge/nativekit.ts');
    const pluginMethods = unique(
      [...plugin.matchAll(/public void (\w+)\(PluginCall call\)/g)].map((m) => m[1]),
    );
    const bridgeCalls = new Set(
      unique([...bridge.matchAll(/Widget\.(\w+)\(/g)].map((m) => m[1])),
    );
    expect(pluginMethods.length).toBeGreaterThan(0);
    // Every plugin method must be wired through the host bridge, or it is dead API surface.
    for (const method of pluginMethods) {
      expect(bridgeCalls.has(method), `plugin method '${method}' is not wired in bridge/nativekit.ts`).toBe(true);
    }
  });

  it('declares every plugin method in plugins/widget/index.d.ts', () => {
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    const dts = read('plugins/widget/index.d.ts');
    const pluginMethods = unique(
      [...plugin.matchAll(/public void (\w+)\(PluginCall call\)/g)].map((m) => m[1]),
    );
    const block = dts.match(/interface NativeKitWidgetPlugin extends Plugin \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const declared = new Set(unique([...block.matchAll(/^  (\w+)\(/gm)].map((m) => m[1])));
    for (const method of pluginMethods) {
      expect(declared.has(method), `d.ts NativeKitWidgetPlugin does not declare '${method}'`).toBe(true);
    }
  });

  it('exposes getConfig consistently across plugin, index.d.ts, template and bridge', () => {
    expect(read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java')).toContain('public void getConfig(PluginCall call)');
    expect(read('plugins/widget/index.d.ts')).toMatch(/getConfig\(options: \{ kind: string \}\)/);
    expect(read('types/nativekit.d.ts.template')).toMatch(/getConfig\(kind: string\): Promise<\{ kind: string; config: NativeKitWidgetSpec \| null \}>/);
    expect(read('bridge/nativekit.ts')).toContain('Widget.getConfig({ kind })');
  });

  it('keeps every page bridge call backed by a native @JavascriptInterface method', () => {
    const page = read('www/widgets/floating.html');
    const service = read('plugins/widget/android/src/main/java/dev/nativekit/widget/FloatingWidgetService.java');
    const pageMethods = unique([...page.matchAll(/window\.NativeKitFloating\.(\w+)\(/g)].map((m) => m[1]));
    const nativeMethods = new Set(
      unique([...service.matchAll(/@android\.webkit\.JavascriptInterface[\s\S]{0,80}?public void (\w+)\(/g)].map((m) => m[1])),
    );
    expect(pageMethods.length).toBeGreaterThan(0);
    for (const method of pageMethods) {
      expect(nativeMethods.has(method), `page calls window.NativeKitFloating.${method}() but native JS-interface missing it`).toBe(true);
    }
  });

  it('declares matching WidgetConfig fields in index.d.ts and the template', () => {
    const dts = read('plugins/widget/index.d.ts');
    const template = read('types/nativekit.d.ts.template');
    const dFields = unique([...dts.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]));
    const tBlock = template.match(/interface NativeKitWidgetSpec \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const tFields = new Set(unique([...tBlock.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1])));
    // Every field the template exposes must also be typed in index.d.ts.
    for (const field of tFields) {
      expect(dFields.includes(field), `WidgetConfig in index.d.ts is missing '${field}'`).toBe(true);
    }
  });

  it('wires the HTML-snapshot mode end-to-end (renderer, provider, layout)', () => {
    const provider = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetProvider.java');
    expect(provider).toContain('HtmlWidgetRenderer.isHtmlMode(cfg)');
    expect(provider).toContain('renderHtmlWidget(');
    expect(provider).toContain('R.layout.widget_html');
    expect(read('plugins/widget/android/src/main/java/dev/nativekit/widget/HtmlWidgetRenderer.java')).toContain('public static boolean isHtmlMode');
    const htmlLayout = read('plugins/widget/android/src/main/res/layout/widget_html.xml');
    expect(htmlLayout).toContain('@+id/widget_html');
  });
});
