/* Pin whatever header a panel actually grew (problem 5 and 8, take two).

   The CSS pass pinned the class names we could see (.gu-tabs, .sa-tabs). A screenshot
   of the running app showed the real shape is different: each panel is an overlay with
   its own header (back, title, close) and a chip row under it, built at runtime. Pinning
   names we cannot see is guesswork, so this measures instead:

   * the scroll container is the nearest ancestor that actually scrolls;
   * inside it, the first element that looks like a header — a row containing a heading,
     a tablist, or two or more buttons on one line — is pinned to its top;
   * it is pinned with a background, so rows scrolling underneath do not show through;
   * a header taller than a third of the viewport is left alone: pinning it would eat
     the screen.

   Idempotent, reversible (window.__stickyRuntime = false), and it never touches the
   page's own scroll position. */
(() => {
  const MARK = 'data-sticky-runtime';
  const MAX_RATIO = 0.34;

  // A scroll container, measured once per sweep (one getComputedStyle per
  // element, never a walk up the ancestors of every div: that walk ran on every
  // DOM change, every keystroke and every streamed token included, and is what
  // made typing in the composer stutter on long chats).
  function isScroller(n, cache) {
    if (cache.has(n)) return cache.get(n);
    const oy = getComputedStyle(n).overflowY;
    const yes = (oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 8;
    cache.set(n, yes);
    return yes;
  }

  function scrollerOf(el, cache = new Map()) {
    let n = el && el.parentElement;
    while (n && n !== document.body) {
      if (isScroller(n, cache)) return n;
      n = n.parentElement;
    }
    return null;
  }

  const looksLikeHeader = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'H1' || tag === 'H2' || tag === 'H3') return true;
    if (el.getAttribute('role') === 'tablist') return true;
    if (el.querySelector('h1, h2, h3, [role="tablist"]')) return true;
    const buttons = el.querySelectorAll('button, [role="button"]').length;
    return buttons >= 2 && el.children.length <= 4;
  };

  function sweep() {
    if (typeof window !== 'undefined' && window.__stickyRuntime === false) return 0;
    let n = 0;
    const cache = new Map();
    const seen = new Set();
    for (const sc of document.querySelectorAll('[data-panel], .panel, section, div')) {
      // Only scroll containers matter: test each element itself, once.
      if (!sc.firstElementChild || !isScroller(sc, cache) || seen.has(sc)) continue;
      seen.add(sc);
      const first = sc.firstElementChild;
      if (!first || first.hasAttribute(MARK)) continue;
      if (!looksLikeHeader(first)) continue;
      const h = first.getBoundingClientRect().height;
      if (!h || h > window.innerHeight * MAX_RATIO) continue;
      first.setAttribute(MARK, '1');
      first.style.position = 'sticky';
      first.style.top = '0';
      first.style.zIndex = '12';
      first.style.background = getComputedStyle(document.body).backgroundColor || '#fff';
      n += 1;
    }
    return n;
  }

  function start() {
    const first = sweep();
    if (typeof MutationObserver !== 'undefined' && document.body) {
      // Coalesced: one sweep after the DOM settles, not one per mutation batch.
      // Changes that only touch the composer (typing, the token chip) or a
      // reply that is streaming cannot grow a panel header, so they are ignored.
      let timer = 0;
      const quiet = (r) => r.target && r.target.closest && r.target.closest('.aui-composer-root, .aui-assistant-message-content, .aui-md, .tk-meter');
      const mo = new MutationObserver((records) => {
        if (records.every(quiet)) return;
        clearTimeout(timer);
        timer = setTimeout(() => { try { sweep(); } catch (e) { console.warn('sticky-runtime', e); } }, 120);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    return first;
  }

  const out = { sweep, start };
  if (typeof window !== 'undefined') {
    window.__stickyRuntime = window.__stickyRuntime !== false;
    window.__stickyRuntimeApi = out;
    const boot = () => { try { start(); } catch (e) { console.warn('sticky-runtime boot', e); } };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
  return out;
})();
