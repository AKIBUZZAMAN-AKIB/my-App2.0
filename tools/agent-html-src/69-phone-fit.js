/* Phone fit, the page's half (see 69-phone-fit.css).

   1. Inside an agent, its header row and its section tabs are both pinned; the tabs sit
      right under the header, whose height changes (wrapped name, badges), so the header's
      real height is published as --pf-dhead-h.
   2. Long lines: a bare URL, a path or any word longer than the line is wrapped in a
      .pf-long-line span that scrolls sideways on its own, so it never pushes a card or the
      page wider and is never cut in pieces. Ordinary prose still wraps. Inline code, code
      blocks and tables already scroll by CSS; here they only get the edge fade that says
      "there is more this way". */
(() => {
  if (typeof document === 'undefined') return;
  const LONG = 26; // characters without a space before a token is treated as a line of its own
  const SKIP = 'pre, code, kbd, samp, textarea, input, button, svg, .pf-long-line, .katex, .aui-md-math-display, [contenteditable]';
  const ROOTS = '.aui-md, .sa-report-md, .sa-msg-body, .sa-last-body, .sa-detail-task, .sa-bubble, .aui-user-message-content';
  const tokenRe = new RegExp(`\\S{${LONG},}`, 'g');

  /** Wrap long space-free tokens of one root's text in scrolling spans. */
  function markLongTokens(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.length >= LONG && !n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (tokenRe.test(n.nodeValue)) nodes.push(n);
    tokenRe.lastIndex = 0;
    for (const n of nodes) {
      const a = n.parentElement?.closest('a');
      if (a) { // a link whose text is one long URL: the whole link is the scrolling line
        if (!/\s/.test(a.textContent.trim())) { a.classList.add('pf-long-line'); continue; }
      }
      const text = n.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      text.replace(tokenRe, (m, i) => {
        if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
        const s = document.createElement('span');
        s.className = 'pf-long-line';
        s.textContent = m;
        frag.appendChild(s);
        last = i + m.length;
        return m;
      });
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    }
  }

  /** data-more = start | end | both on a sideways scroller that has hidden text. */
  function edge(el) {
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) { if (el.dataset.more) delete el.dataset.more; return; }
    const x = Math.abs(el.scrollLeft);
    const v = x <= 1 ? 'end' : x >= max - 1 ? 'start' : 'both';
    if (el.dataset.more !== v) el.dataset.more = v;
  }
  const EDGE_SEL = '.pf-long-line, .aui-md :not(pre) > code, .sa-report-md :not(pre) > code';

  let queued = false;
  const pending = new Set();
  function flush() {
    queued = false;
    const roots = new Set();
    for (const n of pending) {
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (!el || !el.isConnected) continue;
      const r = el.closest(ROOTS);
      if (r) roots.add(r);
      else if (el.querySelectorAll) for (const x of el.querySelectorAll(ROOTS)) roots.add(x);
    }
    pending.clear();
    for (const r of roots) {
      // While a reply streams, its last text node keeps changing: mark it once it settles.
      if (r.closest('[data-streaming="true"], .aui-streaming')) continue;
      try { markLongTokens(r); } catch (e) { console.warn('phone-fit', e); }
      for (const c of r.querySelectorAll('table td:not(.pf-nowrap), table th:not(.pf-nowrap)')) if (c.textContent.trim().length <= 40) c.classList.add('pf-nowrap');
      for (const el of r.querySelectorAll(EDGE_SEL)) edge(el);
    }
    syncHeads();
  }
  const schedule = (n) => { pending.add(n); if (!queued) { queued = true; requestAnimationFrame(flush); } };

  // Pinned agent header: publish its height for the tabs pinned under it.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const e of entries) {
      const dlg = e.target.closest('.dialog');
      if (dlg) dlg.style.setProperty('--pf-dhead-h', `${Math.round(e.target.getBoundingClientRect().height)}px`);
    }
  }) : null;
  const watched = new WeakSet();
  function syncHeads() {
    if (!ro) return;
    for (const hd of document.querySelectorAll('.dialog.sa-dialog .sa-detail > .sa-dhead')) if (!watched.has(hd)) { watched.add(hd); ro.observe(hd); }
  }

  // Going from the list into an agent (or back) starts at the top of that screen, not at the
  // scroll position of the screen before it (which opened an agent half-way down its report).
  const lastView = new WeakMap();
  function viewChanged(el) {
    if (!el.classList?.contains('sa-screen')) return;
    const v = `${el.dataset.view || ''}|${el.dataset.agentId || ''}`;
    const was = lastView.get(el);
    lastView.set(el, v);
    if (was === undefined || was === v) return;
    const body = el.closest('.dialog-body');
    if (body) body.scrollTop = 0;
  }

  function start() {
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') { schedule(m.target); continue; }
        for (const n of m.addedNodes) if (!(n.nodeType === 1 && n.classList?.contains('pf-long-line'))) schedule(n);
        if (m.type === 'attributes' && (m.attributeName === 'data-view' || m.attributeName === 'data-agent-id')) { viewChanged(m.target); continue; }
        if (m.type === 'attributes') schedule(m.target);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-streaming', 'data-view', 'data-agent-id'] });
    document.addEventListener('scroll', (e) => { const t = e.target; if (t && t.nodeType === 1 && t.matches?.(EDGE_SEL)) edge(t); }, { capture: true, passive: true });
    schedule(document.body);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  if (typeof window !== 'undefined') window.__phoneFit = { markLongTokens, edge };
})();
