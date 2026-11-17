// Layout audit run inside the page at each screenshot (shots-subagents.js with LAYOUT=1).
// Finds what a reviewer looks for by eye: page-wide horizontal overflow, text cut off without an ellipsis,
// text boxes that overlap other text in the same layer, controls pushed outside the viewport,
// graph nodes that overlap each other, and visible containers left empty.
/* eslint-disable no-undef */
function layoutAudit() {
  const out = [];
  const W = innerWidth, H = innerHeight;
  const vis = (e) => { if (!e.getClientRects().length) return false; if (e.checkVisibility && !e.checkVisibility({ contentVisibilityAuto: true })) return false; const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  const label = (e) => ((e.getAttribute && (e.getAttribute('data-slot') || e.getAttribute('aria-label'))) || (e.className && (e.className.baseVal ?? e.className)) || e.tagName).toString().slice(0, 36) + ' "' + (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28) + '"';
  if (document.documentElement.scrollWidth > W + 1) out.push(`page-overflow-x ${document.documentElement.scrollWidth}>${W}`);
  const layerOf = (e) => e.closest('.dialog, [role=dialog], [role=menu], [role=tooltip], [data-slot=explorer-inspector], .sa-x-minimap, .sa-x-float, [data-slot=subagents-panel], .sa-panel') || document.body;
  const scrollerOf = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) || p.matches('svg, .sa-x-canvaswrap')) return p; } return null; };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (!n.textContent.trim()) continue;
    const e = n.parentElement; if (!e || e.closest('script, style, noscript, template, [aria-hidden=true] .sr-only, .sr-only, .visually-hidden') || !vis(e)) continue;
    const r = document.createRange(); r.selectNodeContents(n); const rects = [...r.getClientRects()].filter((x) => x.width > 1 && x.height > 1);
    if (!rects.length) continue;
    // cut off by an overflow:hidden ancestor without an ellipsis (only horizontally: vertical overflow in a scroller is scrolling)
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX)) break;
      if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') {
        const pr = p.getBoundingClientRect();
        const cut = rects.some((x) => x.right > pr.right + 2 || x.left < pr.left - 2);
        const ell = [p, e].some((q) => getComputedStyle(q).textOverflow === 'ellipsis') || p.matches('svg, .sa-x-canvaswrap, .sa-x-canvas');
        if (cut && !ell && pr.width > 0) out.push(`text-clipped ${label(e)} in ${label(p)}`);
        break;
      }
    }
    // what is actually painted: the text rects cut to every clipping ancestor
    const clipped = rects.map((x) => { let l = x.left, t = x.top, r = x.right, b = x.bottom; for (let p = e; p && p !== document.documentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const pr = p.getBoundingClientRect(); if (cs.overflowX !== 'visible') { l = Math.max(l, pr.left); r = Math.min(r, pr.right); } if (cs.overflowY !== 'visible') { t = Math.max(t, pr.top); b = Math.min(b, pr.bottom); } } } return { left: l, top: t, right: r, bottom: b }; }).filter((x) => x.right - x.left > 1 && x.bottom - x.top > 1);
    if (!clipped.length) continue;
    const sc = scrollerOf(e);
    if (!sc) for (const x of clipped) { if (x.right > W + 1 || x.left < -1) { out.push(`text-off-screen ${label(e)} x=${Math.round(x.left)}..${Math.round(x.right)}`); break; } }
    texts.push({ e, rects: clipped, layer: layerOf(e), sc });
  }
  // overlapping text in the same layer (not nested, not the same element)
  const hit = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 2 && h > 3 ? w * h : 0; };
  const seen = new Set();
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const A = texts[i], B = texts[j];
    if (A.layer !== B.layer || A.e === B.e || A.e.contains(B.e) || B.e.contains(A.e)) continue;
    let ov = 0; for (const a of A.rects) for (const b of B.rects) ov = Math.max(ov, hit(a, b));
    if (!ov) continue;
    // only when both are actually painted there (the top element at the centre belongs to one of them and the other is not covered by an opaque sibling layer)
    const a = A.rects[0], b = B.rects[0];
    const cx = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2, cy = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
    const top = document.elementFromPoint(cx, cy);
    if (!top || !(A.e.contains(top) || B.e.contains(top) || top.contains(A.e) || top.contains(B.e))) continue;
    const k = label(A.e) + '|' + label(B.e); if (seen.has(k)) continue; seen.add(k);
    out.push(`text-overlap ${Math.round(ov)}px2 ${label(A.e)} x ${label(B.e)}`);
  }
  // controls outside the viewport (not inside a scroller)
  for (const e of document.querySelectorAll('button, [role=button], [role=tab], input:not([type=hidden]), select, textarea, a[href]')) {
    if (!vis(e) || scrollerOf(e)) continue; const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
    if (r.right > W + 1 || r.left < -1 || r.bottom > H + 1 && !e.closest('main, .chat, [data-slot=chat]')) out.push(`control-off-screen ${label(e)} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // graph nodes overlapping each other
  const nodes = [...document.querySelectorAll('[data-slot=subagent-explorer] [data-node]')].filter(vis).map((n) => ({ n, r: n.getBoundingClientRect() }));
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (hit(nodes[i].r, nodes[j].r) > 20) out.push(`node-overlap ${nodes[i].n.getAttribute('data-node')} x ${nodes[j].n.getAttribute('data-node')}`);
  // timeline rows overlapping
  const rows = [...document.querySelectorAll('[data-wf-row]')].filter(vis).map((n) => n.getBoundingClientRect());
  for (let i = 1; i < rows.length; i++) if (rows[i].top < rows[i - 1].bottom - 2 && hit(rows[i], rows[i - 1]) > 20) out.push(`timeline-row-overlap ${i}`);
  // visible boxes that should hold content but are empty
  for (const e of document.querySelectorAll('[data-slot=subagent-explorer], [data-slot=explorer-inspector], .dialog-body, [role=tabpanel], [data-slot=batch-dialog], [data-slot=compare-dialog]')) {
    if (!vis(e)) continue; const r = e.getBoundingClientRect(); if (r.height < 40) continue;
    if (!e.textContent.trim() && !e.querySelector('svg, img, canvas, input, textarea')) out.push(`empty ${label(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return [...new Set(out)];
}
module.exports = { layoutAudit };
