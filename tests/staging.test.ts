import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const staged = path.join(root, '.nativekit/staged-www');

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/prepare-web.mjs', '--target', 'native'], {
    cwd: root,
    stdio: 'pipe'
  });
});

describe('native web staging', () => {
  it('injects the generated bridge before application scripts on every native page', () => {
    const pages = readdirSync(staged).filter((file) => file.endsWith('.html'));
    expect(pages).toContain('index.html');
    expect(pages).toContain('agent.html');
    expect(pages.length).toBeGreaterThanOrEqual(4);

    for (const page of pages) {
      const html = readFileSync(path.join(staged, page), 'utf8');
      const bridgeIndex = html.indexOf('nativekit.js');
      expect(bridgeIndex, `${page} must load the generated bridge`).toBeGreaterThan(-1);

      // The bridge must come before every other script the page loads or inlines.
      const otherScripts = [...html.matchAll(/<script\b(?![^>]*nativekit\.js)[^>]*>/gi)].map((match) => match.index ?? -1);
      for (const scriptIndex of otherScripts) {
        expect(scriptIndex, `${page}: bridge must precede every other script`).toBeGreaterThan(bridgeIndex);
      }

      expect(html, `${page} must carry the CSP`).toContain('Content-Security-Policy');
    }

    expect(existsSync(path.join(staged, 'nativekit.js'))).toBe(true);
  });

  it('gives every main app page the shared bottom bar, and never a frame', () => {
    const pages = readdirSync(staged).filter((file) => file.endsWith('.html'));
    const mainPages = pages.filter((page) => page !== 'index.html');
    expect(mainPages.length).toBeGreaterThanOrEqual(10);

    for (const page of mainPages) {
      const html = readFileSync(path.join(staged, page), 'utf8');
      expect(html, `${page} must load the shared bar stylesheet`).toContain('./shell/nav.css');
      expect(html, `${page} must load the shared bar script`).toContain('./shell/nav.js');
      // Each app is its own top-level page: no page may host another app in a frame.
      expect(html, `${page} must not embed another app in an iframe`).not.toMatch(/<iframe[^>]+src=["']\.?\/?(home|academic|agent|calendar|more)\.html/i);
    }

    // index.html is the launcher redirect, nothing else.
    const launcher = readFileSync(path.join(staged, 'index.html'), 'utf8');
    expect(launcher).toContain("location.replace('./home.html')");
    expect(launcher).not.toContain('./shell/nav.js');

    // The bar ships every destination the app promises.
    const nav = readFileSync(path.join(staged, 'shell/nav.js'), 'utf8');
    for (const href of ['./home.html', './academic.html', './agent.html', './calendar.html', './more.html']) {
      expect(nav, `bottom bar must link ${href}`).toContain(href);
    }
    for (const extra of ['Bluetooth.html', 'my-note.html', 'openshelf.html', 'reminder.html', 'store.html', 'habit-tracker.html']) {
      expect(nav, `bottom bar must know the ${extra} app`).toContain(extra);
    }
  });

  it('keeps native output local and removes service-worker registration', () => {
    const html = readFileSync(path.join(staged, 'index.html'), 'utf8');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toMatch(/serviceWorker\.register/i);
    expect(existsSync(path.join(staged, 'service-worker.js'))).toBe(false);
  });

  it('contains no staged symbolic links', () => {
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        expect(lstatSync(target).isSymbolicLink()).toBe(false);
        if (entry.isDirectory()) visit(target);
      }
    };
    visit(staged);
  });
});
