/* ==========================================================================
   My App — shared runtime, injected at build time into every main app page.

   The uploaded apps stay byte-identical, so every cross-cutting native fix has
   to live here. Three jobs:

   1. SAFE AREA. The pages read env(safe-area-inset-*), but this build runs
      edge-to-edge with the SystemBars plugin in 'disable' mode, so env() is 0
      on every phone without a display cutout — that is why headers slid under
      the status bar. MainActivity publishes the REAL insets as
      --safe-area-inset-* CSS variables on <html>; this script rewrites the
      pages' own inline styles so those variables are used (with env() kept as
      the fallback for the plain web target).
   2. KEYBOARD. MainActivity publishes --keyboard-height and resizes the
      WebView, and this script makes sure the field being typed into is always
      scrolled into the visible part of that (now smaller) viewport.
   3. NATIVE GLUE. Deep links (myapp://…), the hardware back button, and one
      consistent way to open an https: page in the in-app browser instead of
      the dead target="_blank" that the Android WebView silently drops.
   ========================================================================== */

(() => {
  'use strict';
  if (window.__MYAPP_RUNTIME__) return;
  window.__MYAPP_RUNTIME__ = true;

  const nativeKit = () => window.NativeKit;

  /* ------------------------------------------------------------------ *
   * 1. Safe area: make env(safe-area-inset-*) resolve to the real insets
   * ------------------------------------------------------------------ */

  const ENV_RE = /env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,\s*[^()]*)?\)/g;
  const SAFE_AREA_MARKER = 'mnSafeArea';

  function rewriteStyleElement(styleEl) {
    if (!styleEl || styleEl.dataset[SAFE_AREA_MARKER] === 'true') return;
    const text = styleEl.textContent || '';
    styleEl.dataset[SAFE_AREA_MARKER] = 'true';
    if (!text.includes('safe-area-inset')) return;
    // var() resolves from the <html> inline style MainActivity writes; env() is
    // still the fallback, so the same file behaves on Android and in a browser.
    const rewritten = text.replace(
      ENV_RE,
      (_match, side) => (side === 'bottom'
        // The bottom inset has to clear the permanent bottom bar as well, so a
        // page that pads with env(safe-area-inset-bottom) ends up above it
        // instead of under it.
        ? 'var(--mn-safe-bottom, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))'
        : `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`),
    );
    if (rewritten !== text) styleEl.textContent = rewritten;
  }

  function rewriteAllStyleElements(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('style').forEach(rewriteStyleElement);
    if (root && root.tagName === 'STYLE') rewriteStyleElement(root);
  }

  rewriteAllStyleElements(document);

  // Apps that inject a <style> later (dialogs, editors) get the same treatment.
  try {
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'STYLE') rewriteStyleElement(node);
          else if (node.querySelectorAll) rewriteAllStyleElements(node);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* observation is a nicety, never a hard dependency */ }

  /* ------------------------------------------------------------------ *
   * 2. Keyboard: keep the focused field inside the visible viewport
   * ------------------------------------------------------------------ */

  const isTextField = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

  function scrollFieldIntoView(field) {
    if (!isTextField(field)) return;
    try {
      // block:'center' is deliberate: with the keyboard up the visible height is
      // roughly halved, so centring leaves room for the suggestion strip too.
      field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch {
      try { field.scrollIntoView(); } catch { /* nothing else to do */ }
    }
  }

  document.addEventListener('focusin', (event) => {
    const field = event.target;
    if (!isTextField(field)) return;
    // Once immediately (the keyboard animation already started) and once after
    // it settles, because the first attempt runs against the old viewport.
    window.setTimeout(() => scrollFieldIntoView(field), 60);
    window.setTimeout(() => scrollFieldIntoView(field), 380);
  }, true);

  // The native side flips this class whenever the IME inset changes.
  try {
    new MutationObserver(() => {
      if (!document.documentElement.classList.contains('nk-keyboard')) return;
      const field = document.activeElement;
      if (isTextField(field)) window.setTimeout(() => scrollFieldIntoView(field), 120);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch { /* optional */ }

  /* ------------------------------------------------------------------ *
   * 3. Native glue
   * ------------------------------------------------------------------ */

  const PAGES = Object.freeze({
    home: 'home.html',
    academic: 'academic.html',
    agent: 'agent.html',
    calendar: 'calendar.html',
    more: 'more.html',
    browser: 'browser.html',
    store: 'store.html',
    notes: 'my-note.html',
    reminder: 'reminder.html',
    habits: 'habit-tracker.html',
    shelf: 'openshelf.html',
    bluetooth: 'Bluetooth.html',
  });

  const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || ''));

  /**
   * One honest path for every "open a web page" request:
   * in-app browser (agent side panel included) → share sheet → nothing, with a
   * visible message. window.open / target="_blank" are dropped by the Android
   * WebView, which is exactly the "I tapped a link and nothing happened" bug.
   */
  async function openExternalUrl(url, options = {}) {
    const kit = nativeKit();
    const browser = kit?.appBrowser;
    if (browser?.openUrl) {
      try {
        await browser.openUrl(String(url), {
          title: String(options.title || hostOf(url)),
          ...(options.pageAgent === false ? { pageAgent: false } : {}),
        });
        return { opened: 'in-app', url: String(url) };
      } catch (error) {
        const message = String(error?.message || error || '');
        // The isolated renderer refuses non-https addresses; the system browser
        // is the correct honest fallback for those.
        if (!isHttpUrl(url) && kit?.extras?.openUrl) { try { await kit.extras.openUrl(url); return { opened: 'external', url: String(url) }; } catch { /* ignore */ } }
        toastNow(`Could not open the link: ${message || 'unknown error'}`);
        return { opened: 'failed', url: String(url), reason: message };
      }
    }
    if (!kit) {
      try { window.open(String(url), '_blank', 'noopener,noreferrer'); return { opened: 'window', url: String(url) }; }
      catch { return { opened: 'failed', url: String(url) }; }
    }
    toastNow('This app version cannot open web pages.');
    return { opened: 'failed', url: String(url) };
  }

  function hostOf(url) {
    try { return new URL(String(url), location.href).hostname.replace(/^www\./, ''); } catch { return String(url).slice(0, 60); }
  }

  function toastNow(message) {
    try {
      const node = document.createElement('div');
      node.setAttribute('role', 'status');
      node.textContent = String(message);
      node.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:calc(5.5rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))',
        'transform:translateX(-50%)', 'max-width:min(24rem,calc(100% - 2rem))', 'padding:0.6rem 0.9rem',
        'border-radius:0.75rem', 'background:rgba(15,23,42,0.94)', 'color:#fff', 'font:600 0.8125rem/1.35 system-ui,sans-serif',
        'z-index:2147483647', 'pointer-events:none', 'text-align:center',
      ].join(';');
      document.body.append(node);
      window.setTimeout(() => node.remove(), 3200);
    } catch { /* a missing toast must never throw inside a click handler */ }
  }

  // Links: every https: anchor in every app opens in the in-app browser. App
  // pages of this shell keep their normal navigation.
  document.addEventListener('click', (event) => {
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!isHttpUrl(href)) return;
    try {
      const target = new URL(href, location.href);
      if (target.origin === location.origin) return;
    } catch { return; }
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(href, { title: link.textContent?.trim().slice(0, 80) || undefined });
  }, true);

  // Deep links: myapp://agent, myapp://store … resolve to the real page.
  (async () => {
    const app = nativeKit()?.app;
    if (!app?.onUrlOpen) return;
    try {
      await app.onUrlOpen((event) => {
        const raw = String(event?.url || '');
        const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(raw);
        if (!match) return;
        const page = PAGES[match[1].toLowerCase()];
        if (!page) return;
        const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
        location.href = `./${page}${query}`;
      });
    } catch { /* the listener is optional on older hosts */ }
  })();

  // Hardware back: apps may cancel it with a `myapp:back` listener; otherwise
  // the shell goes home first and only then lets the app close.
  (async () => {
    const app = nativeKit()?.app;
    if (!app?.onBackButton) return;
    try {
      await app.onBackButton(() => {
        const cancelled = !document.dispatchEvent(new CustomEvent('myapp:back', { cancelable: true }));
        if (cancelled) return;
        const file = (location.pathname.split('/').pop() || 'index.html');
        if (file !== 'home.html' && file !== 'index.html' && file !== '') {
          location.href = './home.html';
          return;
        }
        try { app.exit?.(); } catch { /* ignore */ }
      });
    } catch { /* optional */ }
  })();

  /* ------------------------------------------------------------------ *
   * 4. Native adapters for the plain web APIs the apps already use
   * ------------------------------------------------------------------ */

  function safeFileName(name, fallback = 'export.txt') {
    const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    return cleaned || fallback;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  /**
   * navigator.share → the system share sheet.
   *
   * A WebView has no navigator.share, so every app that used it silently did
   * nothing. Defining it natively (only when the browser did not provide one)
   * gives all of them the real sheet with no code change on their side.
   */
  try {
    const kit = nativeKit();
    if (!('share' in navigator) && kit?.share?.show) {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data = {}) => kit.share.show({
          title: data.title ? String(data.title) : undefined,
          text: data.text ? String(data.text) : undefined,
          url: data.url ? String(data.url) : undefined,
          dialogTitle: data.title ? String(data.title) : 'Share',
        }),
      });
    }
    if (!('canShare' in navigator) && kit?.share) {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    }
  } catch { /* not fatal: the page keeps its own fallback */ }

  /**
   * <a download="…" href="blob:…"> → a real file the user can keep.
   *
   * WebView downloads without a DownloadListener are dropped on the floor, so
   * every export button in the bundled apps looked broken. The blob is written
   * through the native filesystem and handed to our own share sheet.
   */
  document.addEventListener('click', async (event) => {
    const link = event.target?.closest?.('a[download]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!/^(blob:|data:)/i.test(href)) return;
    const kit = nativeKit();
    if (!kit?.filesystem?.writeFile || !kit?.share?.show) return; // web target: the browser does it
    event.preventDefault();
    event.stopPropagation();
    const name = safeFileName(link.getAttribute('download') || `export-${Date.now()}.txt`);
    try {
      const response = await fetch(href);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await kit.filesystem.writeFile({ path: `exports/${name}`, directory: 'Documents', recursive: true, data: bytesToBase64(bytes) });
      const saved = await kit.filesystem.getUri({ path: `exports/${name}`, directory: 'Documents' });
      try {
        await kit.share.show({ title: name, files: saved?.uri ? [saved.uri] : undefined, dialogTitle: 'Save or share' });
      } catch {
        toastNow(`Saved to Documents/exports/${name}`);
      }
    } catch (error) {
      toastNow(`Could not save the file: ${String(error?.message || error)}`);
    }
  }, true);

  /**
   * Small, honest native surface for every page: notify / share / save a file.
   * Each helper resolves with a result object and never throws, so a page can
   * show its own empty state when a capability is unavailable.
   */
  const MyApp = {
    openUrl: openExternalUrl,
    async notify({ title, body, at } = {}) {
      const kit = nativeKit();
      if (!kit?.notifications?.schedule || !title) return { scheduled: false, reason: 'notifications-unavailable' };
      try {
        const when = at ? new Date(at) : new Date(Date.now() + 1000);
        const permission = await (kit.notifications.check?.() ?? Promise.resolve({ display: 'granted' }));
        if (permission?.display === 'prompt' || permission?.display === 'prompt-with-rationale') {
          const asked = await kit.notifications.request();
          if (asked?.display !== 'granted') return { scheduled: false, reason: 'permission-denied' };
        }
        await kit.notifications.schedule([{
          id: Math.floor(Date.now() % 2_000_000_000),
          title: String(title).slice(0, 120),
          body: String(body || '').slice(0, 400),
          schedule: { at: when },
        }]);
        return { scheduled: true, at: when.toISOString() };
      } catch (error) { return { scheduled: false, reason: String(error?.message || error) }; }
    },
    async share({ title, text, url } = {}) {
      const kit = nativeKit();
      if (!kit?.share?.show) return { shared: false, reason: 'sharing-unavailable' };
      try {
        await kit.share.show({
          title: title || undefined,
          text: text || undefined,
          url: url || undefined,
          dialogTitle: title || 'Share',
        });
        return { shared: true };
      } catch (error) { return { shared: false, reason: String(error?.message || error) }; }
    },
    /**
     * Writes text into the app's own Documents/exports folder and opens the
     * share sheet. Returns the file URI so the caller can show it.
     */
    async saveTextFile({ name, text, folder = 'exports' } = {}) {
      const kit = nativeKit();
      if (!kit?.filesystem?.writeFile || !name) return { saved: false, reason: 'filesystem-unavailable' };
      const fileName = safeFileName(name);
      const path = `${folder}/${fileName}`;
      try {
        await kit.filesystem.writeFile({ path, directory: 'Documents', recursive: true, data: String(text ?? ''), encoding: 'utf8' });
        const saved = await kit.filesystem.getUri({ path, directory: 'Documents' });
        return { saved: true, uri: saved?.uri ?? null, path: `Documents/${path}` };
      } catch (error) { return { saved: false, reason: String(error?.message || error) }; }
    },
  };
  try { window.MyApp = Object.freeze(MyApp); } catch { /* ignore */ }
})();
