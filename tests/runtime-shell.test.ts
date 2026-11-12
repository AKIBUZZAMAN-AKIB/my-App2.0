import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// www/shell/runtime.js is a browser IIFE injected into every page. These tests
// take the named helpers out of the shipped source and run exactly that text
// against small doubles, so the behaviour under test is the shipped behaviour.
const source = readFileSync(path.join(process.cwd(), 'www/shell/runtime.js'), 'utf8');

function extract(names: string[]): string {
  const lines = source.split('\n');
  return names.map((name) => {
    const start = lines.findIndex((line) =>
      new RegExp(`^\\s*(?:const|let|var) ${name}\\b`).test(line) || new RegExp(`^\\s*(?:async )?function ${name}\\(`).test(line),
    );
    if (start < 0) throw new Error(`helper not found: ${name}`);
    const first = lines[start];
    let end = start;
    if (/^\s*(?:async )?function /.test(first)) {
      if (!/\}\s*$/.test(first)) end = lines.findIndex((line, i) => i > start && line === '  }');
    } else if (!/;\s*$/.test(first)) {
      end = lines.findIndex((line, i) => i > start && /^\s{0,4}\S.*;\s*$/.test(line));
    }
    return lines.slice(start, end + 1).join('\n');
  }).join('\n');
}

describe('shell runtime — safe-area rewrite', () => {
  it('turns env(safe-area-inset-*) into the native-published CSS variables', () => {
    const code = extract(['ENV_RE', 'SAFE_AREA_MARKER', 'rewriteStyleElement']);
    const style = { textContent: '.h { padding-top: env(safe-area-inset-top); }', dataset: {} as Record<string, string> };
    new Function('styleEl', `${code}\nrewriteStyleElement(styleEl);`)(style);
    expect(style.textContent).toBe('.h { padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px)); }');
    expect(style.dataset.mnSafeArea).toBe('true');
  });

  it('keeps a fallback that a plain browser can still resolve', () => {
    const code = extract(['ENV_RE', 'SAFE_AREA_MARKER', 'rewriteStyleElement']);
    const style = { textContent: '.n { bottom: calc(1rem + env(safe-area-inset-bottom, 12px)); }', dataset: {} as Record<string, string> };
    new Function('styleEl', `${code}\nrewriteStyleElement(styleEl);`)(style);
    expect(style.textContent).toContain('var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))');
  });

  it('never rewrites the same element twice', () => {
    const code = extract(['ENV_RE', 'SAFE_AREA_MARKER', 'rewriteStyleElement']);
    const style = { textContent: '.h { padding: env(safe-area-inset-top); }', dataset: {} as Record<string, string> };
    const run = new Function('styleEl', `${code}\nrewriteStyleElement(styleEl);`);
    run(style);
    const once = style.textContent;
    run(style);
    expect(style.textContent).toBe(once);
  });
});

describe('shell runtime — links open in the in-app browser', () => {
  const code = extract(['nativeKit', 'isHttpUrl', 'hostOf', 'toastNow', 'openExternalUrl']);

  function harness(kit: any) {
    const opened: Array<{ url: string; options: any }> = [];
    const toasts: string[] = [];
    const documentStub = {
      createElement: () => ({ setAttribute() {}, style: { cssText: '' }, remove() {} }),
      body: { append: (node: any) => { toasts.push(node.textContent); } },
      documentElement: {},
    };
    const windowStub = { NativeKit: kit, setTimeout: () => 0, open: () => ({}) };
    const locationStub = { href: 'https://app.local/agent.html' };
    const run: (url: string) => Promise<any> = new Function(
      'window', 'document', 'location',
      `"use strict";\n${code}\nreturn (url) => openExternalUrl(url);`,
    )(windowStub, documentStub, locationStub);
    return { run, opened, toasts };
  }

  it('routes an https: link into the app browser instead of a dead target="_blank"', async () => {
    const { run, opened } = harness({
      appBrowser: {
        openUrl: async (url: string, options: any) => { opened.push({ url, options }); return { id: 'session' }; },
      },
    });
    const result = await run('https://example.com/page');
    expect(result.opened).toBe('in-app');
    expect(opened).toHaveLength(1);
    expect(opened[0].url).toBe('https://example.com/page');
    expect(opened[0].options.title).toBe('example.com');
  });

  it('passes the page-agent opt-out through to the browser session', async () => {
    const { run, opened } = harness({
      appBrowser: { openUrl: async (url: string, options: any) => { opened.push({ url, options }); return { id: 'session' }; } },
    });
    await run('https://example.com');
    expect(opened[0].options.pageAgent).toBeUndefined();
  });

  it('reports a failure instead of pretending the page opened', async () => {
    const { run, toasts } = harness({
      appBrowser: { openUrl: async () => { throw new Error('Another isolated browser session is already open'); } },
    });
    const result = await run('https://example.com');
    expect(result.opened).toBe('failed');
    expect(result.reason).toContain('already open');
    expect(toasts.join(' ')).toContain('already open');
  });

  it('says so when the app has no native bridge at all', async () => {
    const { run } = harness(null);
    const result = await run('https://example.com');
    // With no NativeKit the runtime falls back to a real browser tab, and the
    // result still says exactly what happened.
    expect(result.opened).toBe('window');
  });
});
