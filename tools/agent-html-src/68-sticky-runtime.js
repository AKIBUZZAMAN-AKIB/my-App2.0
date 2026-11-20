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

  function scrollerOf(el) {
    let n = el && el.parentElement;
    while (n && n !== document.body) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 8) return n;
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
    for (const panel of document.querySelectorAll('[data-panel], .panel, section, div')) {
      const sc = scrollerOf(panel);
      if (!sc) continue;
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
      const mo = new MutationObserver(() => { try { sweep(); } catch (e) { console.warn('sticky-runtime', e); } });
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
