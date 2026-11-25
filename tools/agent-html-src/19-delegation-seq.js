/* ==========================================================================
   Delegation sequence on a canvas (Agents ▸ Diagram ▸ Delegation).

   The Diagram tab used to draw the delegation as a Mermaid sequenceDiagram:
   one lifeline per agent (Main agent first), every request / report /
   message as an arrow from sender to receiver with its text, oldest at the
   top. This draws the same thing on the pan / pinch / zoom SVG canvas the
   Explorer uses, so it stays readable on a phone and updates live:
   - a sticky participant row (and a sticky time gutter) while panning;
   - every arrow names its text (shortened to fit), tap it for the full text,
     sender → receiver, time and type; Previous / Next steps through them;
   - tap a participant to highlight its messages and see the agent;
   - type chips (Requests, Reports, Messages, Questions, Approvals) filter,
     "Find in messages" highlights matches;
   - activation bars show how long each agent ran, coloured by its status.
   ========================================================================== */
const DelegationSeq = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MAIN = '__main__';
  const PREF_KEY = 'agent.subagents.delegation.v1';
  const MAX_ROWS = 300;
  const GUT = 72; // time gutter
  const COL = 128; // one lane
  const HEAD_H = 54; // participant row
  const ROW = 50; // one message
  const FIRST = HEAD_H + 34; // y of the first arrow
  const MIN_K = 0.15;
  const MAX_K = 2.5;

  const sv = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const num = (v) => Number(v) || 0;
  const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /* ---------- message types: how each log entry is drawn ---------- */
  const TYPES = {
    request: { label: 'Request', group: 'requests', dashed: false, end: 'arrow' },
    queued: { label: 'Queued', group: 'requests', dashed: true, end: 'arrow' },
    followup: { label: 'Follow-up', group: 'requests', dashed: false, end: 'arrow' },
    report: { label: 'Report', group: 'reports', dashed: true, end: 'arrow' },
    failed: { label: 'Failed', group: 'reports', dashed: true, end: 'cross' },
    stopped: { label: 'Stopped', group: 'reports', dashed: true, end: 'cross' },
    message: { label: 'Message', group: 'messages', dashed: false, end: 'arrow' },
    handoff: { label: 'Hand-off', group: 'messages', dashed: false, end: 'arrow' },
    question: { label: 'Question', group: 'questions', dashed: false, end: 'arrow' },
    answer: { label: 'Answer', group: 'questions', dashed: true, end: 'arrow' },
    approval: { label: 'Needs approval', group: 'approvals', dashed: true, end: 'arrow' },
  };
  const GROUPS = [
    { id: 'requests', label: 'Requests', type: 'request' },
    { id: 'reports', label: 'Reports', type: 'report' },
    { id: 'messages', label: 'Messages', type: 'message' },
    { id: 'questions', label: 'Questions', type: 'question' },
    { id: 'approvals', label: 'Approvals', type: 'approval' },
  ];

  const loadPrefs = () => { try { return { hidden: [], ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { hidden: [] }; } };
  const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ } };

  /* ---------- the model: participants + rows, from the delegation log ---------- */
  function buildModel(ctx) {
    const all = (ctx.log() || []).slice().sort((a, b) => num(a.at) - num(b.at));
    const entries = all.slice(-MAX_ROWS);
    const parts = [{ id: MAIN, main: true, name: 'Main agent' }];
    const index = new Map([[MAIN, 0]]);
    const ensure = (id, hint) => {
      if (!id || id === MAIN) return MAIN;
      if (index.has(id)) return id;
      const r = ctx.get(id);
      const par = r ? ctx.parentOf(r) : null;
      if (par && par !== id && !index.has(par) && ctx.get(par)) ensure(par);
      index.set(id, parts.length);
      parts.push({ id, name: r ? (r.title || r.name) : (hint || String(id)) });
      return id;
    };
    const parentKey = (e) => {
      const r = ctx.get(e.id);
      const par = e.parentId != null ? e.parentId : r ? ctx.parentOf(r) : null;
      return par && par !== e.id ? ensure(par) : MAIN;
    };
    const rows = [];
    for (const e of entries) {
      if (!e || e.id == null) continue;
      const rec = ctx.get(e.id);
      const text = oneLine(e.text);
      const P = parentKey(e);
      const a = ensure(e.id, e.name);
      let row = null;
      switch (e.kind) {
        case 'started': row = { type: 'request', from: P, to: a, label: text || oneLine(rec?.task) || 'task', full: e.text || rec?.task || '', open: a }; break;
        case 'queued': row = { type: 'queued', from: P, to: a, label: `queued${text ? `: ${text}` : ''}`, full: e.text || rec?.task || '' }; break;
        case 'message': row = { type: 'followup', from: P, to: a, label: `follow-up${text ? `: ${text}` : ''}`, full: e.text || '' }; break;
        case 'approval_needed': row = { type: 'approval', from: a, to: MAIN, label: 'needs approval', full: e.text || '' }; break;
        case 'ask_parent': row = { type: 'question', from: a, to: P, label: `asks${text ? `: ${text}` : ''}`, full: e.text || '' }; break;
        case 'parent_answer': row = { type: 'answer', from: P, to: a, label: `answers${text ? `: ${text}` : ''}`, full: e.text || '' }; break;
        case 'peer_message': { const to = e.to ? ensure(e.to, e.toName) : P; row = { type: 'message', from: a, to, label: text || 'message', full: e.text || '' }; break; }
        case 'handoff': { const to = e.to ? ensure(e.to, e.toName) : P; row = { type: 'handoff', from: a, to, label: `hands off${text ? `: ${text}` : ''}`, full: e.text || '' }; break; }
        case 'finished': row = { type: 'report', from: a, to: P, label: 'report', full: e.text || rec?.result || '', close: a, end: 'ok' }; break;
        case 'error': row = { type: 'failed', from: a, to: P, label: `failed${text ? `: ${text}` : ''}`, full: e.text || rec?.error || '', close: a, end: 'bad' }; break;
        case 'cancelled': row = { type: 'stopped', from: a, to: P, label: 'stopped', full: e.text || '', close: a, end: 'off' }; break;
        case 'race_lost': row = { type: 'stopped', from: a, to: P, label: 'lost the race', full: e.text || '', close: a, end: 'off' }; break;
        case 'dependency_failed': row = { type: 'stopped', from: a, to: P, label: 'dependency failed', full: e.text || '', close: a, end: 'off' }; break;
        default: break;
      }
      if (row) rows.push({ ...row, at: num(e.at), kind: e.kind, entry: e, key: `${e.kind}:${e.id}:${num(e.at)}:${rows.length}` });
    }
    for (const p of parts) {
      const r = p.main ? null : ctx.get(p.id);
      p.record = r || null;
      p.status = p.main ? 'main' : r ? (r.paused && r.status === 'running' ? 'paused' : r.status) : 'off';
    }
    return { parts, index, rows, total: all.length, shown: entries.length, first: rows.length ? rows[0].at : 0 };
  }

  const STATUS_CLASS = { running: 'run', queued: 'wait', waiting_approval: 'wait', paused: 'pause', finished: 'ok', completed: 'ok', error: 'bad', failed: 'bad', cancelled: 'off', main: 'main', off: 'off' };

  /* ---------- text fitting (canvas measureText, no layout) ---------- */
  let measureCtx = null;
  const measure = (t, font) => { measureCtx = measureCtx || document.createElement('canvas').getContext('2d'); measureCtx.font = font; return measureCtx.measureText(t).width; };
  const fitText = (t, max, font) => {
    const s = String(t || '');
    if (max <= 12) return '';
    if (measure(s, font) <= max) return s;
    let lo = 0; let hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measure(`${s.slice(0, mid)}…`, font) <= max) lo = mid; else hi = mid - 1; }
    return lo ? `${s.slice(0, lo).trimEnd()}…` : '';
  };

  /* ---------- standalone SVG export (shared with the Agent tree canvas) ---------- */
  const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing'];
  /** A self-contained SVG of what a canvas draws: computed styles inlined, the pan/zoom reset. */
  function exportSvg(svg, { stages, skip = '[data-export-skip]', pad = 16, background } = {}) {
    if (!svg) return '';
    const groups = stages && stages.length ? stages : [...svg.querySelectorAll('[data-stage]')];
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    for (const g of groups) {
      for (const c of g.children) {
        if (c.matches?.(skip)) continue;
        try { const b = c.getBBox(); if (!b.width && !b.height) continue; x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height); } catch { /* not rendered */ }
      }
    }
    if (!Number.isFinite(x1)) { x1 = 0; y1 = 0; x2 = 100; y2 = 100; }
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((el, i) => {
      const out = dst[i];
      if (!out || !(el instanceof SVGElement)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') { out.setAttribute('data-drop', '1'); return; }
      const style = STYLE_PROPS.map((p) => { const v = cs.getPropertyValue(p); return v ? `${p}:${v}` : ''; }).filter(Boolean).join(';');
      out.setAttribute('style', style);
      out.removeAttribute('class');
      for (const a of [...out.attributes]) if (/^(data-|aria-|tabindex|role)/.test(a.name)) out.removeAttribute(a.name);
    });
    dst.forEach((el, i) => { if (src[i]?.matches?.(skip)) el.setAttribute('data-drop', '1'); });
    clone.querySelectorAll('[data-drop]').forEach((el) => el.remove());
    const stageIdx = new Set(groups.map((g) => src.indexOf(g)));
    dst.forEach((el, i) => { if (stageIdx.has(i)) el.setAttribute('transform', `translate(${pad - x1} ${pad - y1})`); });
    const W = Math.ceil(x2 - x1 + pad * 2); const H = Math.ceil(y2 - y1 + pad * 2);
    clone.setAttribute('xmlns', SVGNS);
    clone.setAttribute('width', String(W)); clone.setAttribute('height', String(H)); clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
    clone.removeAttribute('style');
    const bg = background || getComputedStyle(svg.parentElement || svg).backgroundColor || '#fff';
    clone.insertBefore(sv('rect', { x: 0, y: 0, width: W, height: H, style: `fill:${bg}` }), clone.firstChild);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  }

  /* ---------- the view ---------- */
  function mount(ctx) {
    const prefs = loadPrefs();
    const id = (typeof uid === 'function' ? uid(6) : Math.random().toString(36).slice(2, 8));
    const view = { x: 12, y: 0, k: 1, auto: true };
    let model = { parts: [], rows: [], index: new Map(), total: 0, shown: 0, first: 0 };
    let visible = []; // rows after the type filter
    let layout = { W: 0, H: 0, lanes: [], rowsY: [], footY: 0 };
    let sig = '';
    let sel = null; // { kind: 'row', key } | { kind: 'part', id }
    let query = '';
    let seenKeys = null;
    let destroyed = false;

    /* DOM */
    const svg = sv('svg', { class: 'sa-seq-svg', role: 'group', 'aria-label': 'Delegation sequence: drag to move, pinch or use the buttons to zoom, tap an arrow to read it' });
    const defs = sv('defs');
    for (const t of Object.keys(TYPES)) {
      defs.append(sv('marker', { id: `sq-${id}-a-${t}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', class: 'sa-seq-mark', 'data-type': t }, sv('path', { d: 'M0 0 L10 5 L0 10 z' })));
      defs.append(sv('marker', { id: `sq-${id}-x-${t}`, viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto', class: 'sa-seq-mark sa-seq-mark-x', 'data-type': t }, sv('path', { d: 'M1 1 L9 9 M9 1 L1 9' })));
    }
    svg.append(defs);
    const gStage = sv('g', { class: 'sa-seq-stage', 'data-stage': '' });
    const gGut = sv('g', { class: 'sa-seq-gutter', 'data-export-skip': '' });
    const gHead = sv('g', { class: 'sa-seq-head', 'data-stage': '' });
    svg.append(gStage, gGut, gHead);

    const summary = h('p', { class: 'sa-seq-summary', 'data-slot': 'delegation-summary', 'aria-live': 'polite' });
    const search = h('input', { type: 'search', class: 'sa-seq-search', placeholder: 'Find in messages', 'aria-label': 'Find in messages', 'data-slot': 'delegation-search', enterkeyhint: 'search' });
    const chips = h('div', { class: 'sa-seq-chips', role: 'group', 'aria-label': 'Message types' }, GROUPS.map((g) => {
      const b = h('button', { type: 'button', class: 'sa-seq-chip', 'data-group': g.id, 'data-type': g.type, 'aria-pressed': String(!prefs.hidden.includes(g.id)) },
        h('i', { class: 'sa-seq-swatch', 'data-type': g.type, 'aria-hidden': 'true' }), h('span', null, g.label), h('b', { class: 'sa-seq-chip-n' }, ''));
      b.addEventListener('click', () => {
        const on = !prefs.hidden.includes(g.id);
        prefs.hidden = on ? [...prefs.hidden, g.id] : prefs.hidden.filter((x) => x !== g.id);
        savePrefs(prefs); b.setAttribute('aria-pressed', String(!on));
        if (sel?.kind === 'row' && !rowVisible(sel.key)) closePeek();
        sig = ''; update();
      });
      return b;
    }));
    const zoomLabel = h('span', { class: 'sa-x-zoomlabel', 'aria-live': 'polite' }, '100%');
    const zoomGroup = h('div', { class: 'sa-x-zoomgroup sa-seq-zoom', role: 'group', 'aria-label': 'Zoom' },
      iconButton('Zoom out', icon('zoom-out'), () => zoomBy(1 / 1.25)),
      zoomLabel,
      iconButton('Zoom in', icon('zoom-in'), () => zoomBy(1.25)),
      iconButton('Show the whole diagram', icon('scan'), () => fitAll(), { 'data-slot': 'delegation-fit' }),
      iconButton('Go to the latest message', icon('arrow-down'), () => toLatest(true), { 'data-slot': 'delegation-latest' }));
    const empty = h('div', { class: 'sa-seq-empty', hidden: true }, icon('workflow'), h('p', null, 'No delegation yet.'), h('p', { class: 'sa-muted' }, 'When an agent starts another one, every request, report and message appears here, oldest at the top.'));
    const peek = h('div', { class: 'sa-seq-peek', hidden: true, role: 'region', 'aria-label': 'Details', 'data-slot': 'delegation-peek' });
    const canvas = h('div', { class: 'sa-seq-canvas', tabindex: '0', 'data-slot': 'delegation-canvas' }, svg, empty, zoomGroup, peek);
    const root = h('div', { class: 'sa-seq', 'data-slot': 'delegation-seq' },
      h('div', { class: 'sa-seq-tools' }, h('label', { class: 'sa-seq-searchwrap' }, icon('search'), search), chips),
      summary, canvas);

    /* ---------- layout + paint ---------- */
    const rowVisible = (key) => visible.some((r) => r.key === key);
    const laneX = (pid) => GUT + COL * (model.index.get(pid) ?? 0) + COL / 2;
    const fontFamily = () => getComputedStyle(root).fontFamily || 'system-ui, sans-serif';
    const nameOf = (pid) => model.parts[model.index.get(pid)]?.name || 'agent';
    const clock = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };
    const since = (t) => { const s = Math.max(0, Math.round((t - model.first) / 1000)); const m = Math.floor(s / 60); return m >= 60 ? `+${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `+${m}:${String(s % 60).padStart(2, '0')}`; };
    const matches = (r) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return `${r.label} ${r.full} ${nameOf(r.from)} ${nameOf(r.to)}`.toLowerCase().includes(q);
    };

    function paint() {
      const fam = fontFamily();
      const FONT = `500 11.5px ${fam}`;
      const parts = model.parts;
      const W = GUT + COL * parts.length + 12;
      const rowsY = visible.map((_, i) => FIRST + i * ROW);
      const lastY = rowsY.length ? rowsY[rowsY.length - 1] : FIRST - ROW / 2;
      const footY = lastY + 30;
      const H = footY + HEAD_H;
      layout = { W, H, rowsY, footY };
      const selPart = sel?.kind === 'part' ? sel.id : null;
      const selRow = sel?.kind === 'row' ? sel.key : null;

      // Lanes: zebra bands, lifelines and activation bars.
      const lanes = sv('g', { class: 'sa-seq-lanes' });
      parts.forEach((p, i) => {
        const x = GUT + COL * i;
        if (i % 2) lanes.append(sv('rect', { class: 'sa-seq-band', x, y: HEAD_H, width: COL, height: footY - HEAD_H }));
        lanes.append(sv('line', { class: 'sa-seq-life', x1: x + COL / 2, x2: x + COL / 2, y1: HEAD_H - 4, y2: footY + 4, 'data-status': STATUS_CLASS[p.status] || 'off', 'data-hot': selPart === p.id ? 'true' : null }));
      });
      // Activations: a request opens a bar on the receiver, its report / failure / stop closes it.
      const open = new Map();
      const bars = [];
      visible.forEach((r, i) => {
        const y = rowsY[i];
        if (r.open) { if (!open.has(r.open)) open.set(r.open, []); open.get(r.open).push(y); }
        if (r.close && open.get(r.close)?.length) bars.push({ id: r.close, y1: open.get(r.close).pop(), y2: y, end: r.end });
      });
      for (const [pid, ys] of open) for (const y1 of ys) {
        const p = parts[model.index.get(pid)];
        bars.push({ id: pid, y1, y2: footY - 6, end: STATUS_CLASS[p?.status] || 'run', live: true });
      }
      for (const b of bars) lanes.append(sv('rect', { class: 'sa-seq-act', x: laneX(b.id) - 5, y: b.y1 - 4, width: 10, height: Math.max(8, b.y2 - b.y1 + 8), rx: 2, 'data-status': b.end, 'data-live': b.live ? 'true' : null, 'data-dim': selPart && selPart !== b.id ? 'true' : null }));

      // Arrows.
      const arrows = sv('g', { class: 'sa-seq-arrows' });
      visible.forEach((r, i) => {
        const y = rowsY[i];
        const t = TYPES[r.type];
        const xa = laneX(r.from); const xb = laneX(r.to);
        const self = r.from === r.to;
        const dir = xb >= xa ? 1 : -1;
        const fromActive = bars.some((b) => b.id === r.from && y > b.y1 - 1 && y < b.y2 + 1);
        const toActive = bars.some((b) => b.id === r.to && y > b.y1 - 1 && y < b.y2 + 1);
        const x1 = xa + (fromActive ? 5 : 0) * dir;
        const x2 = xb - (toActive ? 6 : 1) * dir;
        const dim = (selPart && r.from !== selPart && r.to !== selPart) || (query && !matches(r));
        const g = sv('g', {
          class: 'sa-seq-row', 'data-row': r.key, 'data-type': r.type, tabindex: '0', role: 'button',
          'aria-label': `${clock(r.at)}, ${nameOf(r.from)} to ${nameOf(r.to)}, ${t.label}: ${oneLine(r.full) || r.label}`,
          'data-selected': selRow === r.key ? 'true' : null, 'data-dim': dim ? 'true' : null,
          'data-match': query && matches(r) ? 'true' : null, 'data-new': seenKeys && !seenKeys.has(r.key) ? 'true' : null,
        });
        const marker = `url(#sq-${id}-${t.end === 'cross' ? 'x' : 'a'}-${r.type})`;
        let labelX; let anchor; let maxW;
        if (self) {
          g.append(sv('path', { class: 'sa-seq-line', d: `M${xa + 5} ${y - 6} h28 v14 h-26`, 'data-dashed': t.dashed ? 'true' : null, 'marker-end': marker }));
          labelX = xa + 40; anchor = 'start'; maxW = COL - 50;
        } else {
          g.append(sv('line', { class: 'sa-seq-line', x1, x2, y1: y, y2: y, 'data-dashed': t.dashed ? 'true' : null, 'marker-end': marker }));
          // A long arrow's text starts at its left end (where the view opens, Main agent's side), so it
          // can be read even when the other end is lanes away, off screen on a phone.
          if (Math.abs(xb - xa) <= COL * 1.05) { labelX = (xa + xb) / 2; anchor = 'middle'; maxW = Math.abs(xb - xa) - 18; }
          else { anchor = 'start'; labelX = Math.min(xa, xb) + 12; maxW = Math.abs(xb - xa) - 30; }
        }
        const shown = fitText(r.label, maxW, FONT);
        const tw = measure(shown, FONT);
        const lx = anchor === 'middle' ? labelX - tw / 2 : anchor === 'end' ? labelX - tw : labelX;
        g.append(sv('rect', { class: 'sa-seq-labelbg', x: lx - 4, y: y - 21, width: tw + 8, height: 16, rx: 4 }));
        g.append(sv('text', { class: 'sa-seq-label', x: labelX, y: y - 9, 'text-anchor': anchor }, shown));
        const hx1 = self ? xa - 6 : Math.min(xa, xb) - 4; const hx2 = self ? xa + COL - 8 : Math.max(xa, xb) + 4;
        g.append(sv('rect', { class: 'sa-seq-hit', x: hx1, y: y - 24, width: hx2 - hx1, height: 34 }));
        arrows.append(g);
      });

      // Footer participants (as Mermaid drew them, at the bottom too).
      const foot = sv('g', { class: 'sa-seq-foot' });
      parts.forEach((p) => foot.append(partBox(p, footY + 2, FONT, fam, selPart)));
      gStage.replaceChildren(lanes, arrows, foot);

      // Time gutter (sticky on the left).
      const gut = [sv('rect', { class: 'sa-seq-gutbg', x: 0, y: HEAD_H, width: GUT - 2, height: footY - HEAD_H })];
      visible.forEach((r, i) => {
        const y = rowsY[i];
        gut.push(sv('text', { class: 'sa-seq-time', x: 8, y: y - 6, 'data-dim': (selPart && r.from !== selPart && r.to !== selPart) ? 'true' : null }, clock(r.at)));
        gut.push(sv('text', { class: 'sa-seq-since', x: 8, y: y + 7 }, since(r.at)));
      });
      gGut.replaceChildren(...gut);

      // Header participants (sticky on top).
      const head = [sv('rect', { class: 'sa-seq-headbg', x: -4000, y: -2000, width: W + 8000, height: 2000 + HEAD_H, 'data-export-skip': '' })];
      parts.forEach((p) => head.push(partBox(p, 4, FONT, fam, selPart)));
      gHead.replaceChildren(...head);

      empty.hidden = !!visible.length || model.parts.length > 1;
      if (!model.rows.length) empty.hidden = false;
      svg.dataset.empty = String(!model.rows.length);
      applyView();
    }

    function partBox(p, y, FONT, fam, selPart) {
      const x = GUT + COL * model.index.get(p.id) + 8;
      const w = COL - 16;
      const r = p.record;
      const sub = p.main
        ? `${model.parts.length - 1} agent${model.parts.length === 2 ? '' : 's'}`
        : [ctx.statusLabel ? ctx.statusLabel(p.status === 'paused' ? 'paused' : p.status) : p.status, r && ctx.fmtTokens && num(r.tokens) ? `${ctx.fmtTokens(r.tokens)} tok` : ''].filter(Boolean).join(' · ');
      const g = sv('g', { class: 'sa-seq-part', 'data-part': p.id, 'data-status': STATUS_CLASS[p.status] || 'off', 'data-hot': selPart === p.id ? 'true' : null, tabindex: '0', role: 'button', 'aria-label': `${p.name}${sub ? `, ${sub}` : ''}: show its messages` });
      g.append(sv('rect', { class: 'sa-seq-partbox', x, y, width: w, height: HEAD_H - 10, rx: 10 }));
      g.append(sv('rect', { class: 'sa-seq-partstripe', x, y: y + 8, width: 3, height: HEAD_H - 26, rx: 1.5 }));
      g.append(sv('circle', { class: 'sa-seq-partdot', cx: x + 14, cy: y + 15, r: 4 }));
      g.append(sv('text', { class: 'sa-seq-partname', x: x + 23, y: y + 19 }, fitText(p.name, w - 30, `600 12.5px ${fam}`)));
      g.append(sv('text', { class: 'sa-seq-partsub', x: x + 12, y: y + 34 }, fitText(sub, w - 20, `400 10.5px ${fam}`)));
      return g;
    }

    /* ---------- view: pan / zoom / sticky rows ---------- */
    const size = () => ({ w: canvas.clientWidth || 360, h: canvas.clientHeight || 480 });
    function clampView() {
      const { w, h: hh } = size();
      const cw = layout.W * view.k; const ch = layout.H * view.k;
      view.x = cw + 24 <= w ? Math.max(0, (w - cw) / 2) : Math.min(12, Math.max(w - cw - 12, view.x));
      view.y = ch + 24 <= hh ? 0 : Math.min(0, Math.max(hh - ch - 16, view.y));
    }
    function applyView() {
      clampView();
      const { k } = view;
      gStage.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${k})`);
      const gx = Math.max(view.x, 0);
      gGut.setAttribute('transform', `translate(${gx} ${view.y}) scale(${k})`);
      gGut.dataset.pinned = String(view.x < -1);
      const hy = Math.max(view.y, 0);
      gHead.setAttribute('transform', `translate(${view.x} ${hy}) scale(${k})`);
      gHead.dataset.pinned = String(view.y < -1);
      zoomLabel.textContent = `${Math.round(k * 100)}%`;
    }
    /** The first view: readable lanes (not the whole width at a tiny scale), from the top left. */
    function initialView() {
      const { w } = size();
      view.k = Math.min(1, Math.max(0.8, (w - 8) / layout.W));
      view.x = 0; view.y = 0; view.auto = true;
      applyView();
    }
    function fitAll() {
      const { w, h: hh } = size();
      view.k = Math.max(MIN_K, Math.min(1.2, (w - 16) / layout.W, (hh - 16) / layout.H));
      view.x = (w - layout.W * view.k) / 2; view.y = 8; view.auto = false;
      applyView();
    }
    function zoomAt(f, cx, cy) {
      const k = Math.min(MAX_K, Math.max(MIN_K, view.k * f));
      const r = k / view.k;
      view.x = cx - (cx - view.x) * r; view.y = cy - (cy - view.y) * r; view.k = k; view.auto = false;
      applyView();
    }
    const zoomBy = (f) => { const { w, h: hh } = size(); zoomAt(f, w / 2, hh / 2); };
    function scrollToRowY(y, smooth) {
      const { h: hh } = size();
      const target = -(y * view.k) + hh * 0.6;
      if (!smooth || matchMedia('(prefers-reduced-motion: reduce)').matches) { view.y = target; applyView(); return; }
      const from = view.y; const t0 = performance.now();
      const step = (t) => { const p = Math.min(1, (t - t0) / 260); view.y = from + (target - from) * (1 - (1 - p) ** 3); applyView(); if (p < 1 && !destroyed) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
    function toLatest(smooth) { if (layout.rowsY.length) { view.auto = false; scrollToRowY(layout.rowsY[layout.rowsY.length - 1], smooth); } }
    function latestOnScreen() {
      if (!layout.rowsY.length) return true;
      const { h: hh } = size();
      const y = layout.rowsY[layout.rowsY.length - 1] * view.k + view.y;
      return y <= hh + 4 && y >= 0;
    }
    function revealRow(key) {
      const i = visible.findIndex((r) => r.key === key);
      if (i < 0) return;
      const r = visible[i];
      const { w, h: hh } = size();
      const y = layout.rowsY[i] * view.k + view.y;
      const peekH = peek.hidden ? 0 : peek.offsetHeight + 12;
      if (y < HEAD_H * view.k + 30 || y > hh - peekH - 20) { view.y = -(layout.rowsY[i] * view.k) + Math.max(HEAD_H * view.k + 50, (hh - peekH) * 0.45); }
      const xa = Math.min(laneX(r.from), laneX(r.to)) * view.k + view.x; const xb = Math.max(laneX(r.from), laneX(r.to)) * view.k + view.x;
      if (xa < GUT * view.k || xb > w) view.x = -(Math.min(laneX(r.from), laneX(r.to)) * view.k) + GUT * view.k + 16;
      view.auto = false;
      applyView();
    }

    /* Pointers: drag pans, two fingers pinch, a tap selects. */
    const pts = new Map();
    let drag = null;
    let pinch = null;
    let lastTap = 0;
    const local = (e) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    svg.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      pts.set(e.pointerId, local(e));
      try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x: view.x, y: view.y };
        drag = null;
      } else if (pts.size === 1) {
        const p = local(e);
        drag = { sx: p.x, sy: p.y, x: view.x, y: view.y, moved: false, target: e.target };
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, local(e));
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const k = Math.min(MAX_K, Math.max(MIN_K, pinch.k * (d / pinch.d)));
        const cx = (a.x + b.x) / 2; const cy = (a.y + b.y) / 2;
        view.x = cx - (pinch.cx - pinch.x) * (k / pinch.k); view.y = cy - (pinch.cy - pinch.y) * (k / pinch.k); view.k = k; view.auto = false;
        applyView();
        return;
      }
      if (!drag) return;
      const p = local(e);
      const dx = p.x - drag.sx; const dy = p.y - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true; canvas.dataset.panning = 'true';
      view.x = drag.x + dx; view.y = drag.y + dy; view.auto = false;
      applyView();
    });
    const end = (e) => {
      const had = pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!had || !drag) { if (!pts.size) drag = null; return; }
      const d = drag; drag = null; delete canvas.dataset.panning;
      if (d.moved || e.type === 'pointercancel') return;
      const now = performance.now();
      const dbl = now - lastTap < 300; lastTap = now;
      tapAt(d.target, dbl);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const p = local(e); zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y); return; }
      const dx = e.shiftKey ? e.deltaY : e.deltaX; const dy = e.shiftKey ? 0 : e.deltaY;
      view.x -= dx; view.y -= dy; view.auto = false; applyView();
    }, { passive: false });
    function tapAt(target, dbl) {
      const row = target?.closest?.('[data-row]');
      const part = target?.closest?.('[data-part]');
      if (row) { selectRow(row.dataset.row); return; }
      if (part) {
        const pid = part.dataset.part;
        if (dbl && pid !== MAIN && ctx.open) { ctx.open(pid); return; }
        selectPart(sel?.kind === 'part' && sel.id === pid ? null : pid);
        return;
      }
      if (sel) closePeek();
    }
    canvas.addEventListener('keydown', (e) => {
      const row = e.target.closest?.('[data-row]'); const part = e.target.closest?.('[data-part]');
      if ((e.key === 'Enter' || e.key === ' ') && (row || part)) { e.preventDefault(); tapAt(e.target, false); return; }
      if (e.key === 'Escape' && sel) { e.preventDefault(); e.stopPropagation(); closePeek(); return; }
      if (e.target !== canvas && !row && !part) return;
      const step = 48;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) { e.preventDefault(); view.x += moves[e.key][0]; view.y += moves[e.key][1]; view.auto = false; applyView(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); }
      else if (e.key === '-') { e.preventDefault(); zoomBy(1 / 1.25); }
      else if (e.key === '0') { e.preventDefault(); fitAll(); }
    });
    search.addEventListener('input', () => { query = search.value.trim(); paint(); summarize(); const first = query && visible.find(matches); if (first) revealRow(first.key); });

    /* ---------- details: a tapped arrow or participant ---------- */
    function selectRow(key) {
      sel = key ? { kind: 'row', key } : null;
      paint(); showPeek();
      if (key) revealRow(key);
    }
    function selectPart(pid) {
      sel = pid ? { kind: 'part', id: pid } : null;
      paint(); showPeek();
    }
    function closePeek() { sel = null; peek.hidden = true; canvas.dataset.peek = 'false'; paint(); }
    function who(pid) {
      const p = model.parts[model.index.get(pid)];
      return h('span', { class: 'sa-seq-who', 'data-status': STATUS_CLASS[p?.status] || 'off' }, h('i', { class: 'sa-seq-dot', 'aria-hidden': 'true' }), p?.name || 'agent');
    }
    function showPeek() {
      if (!sel) { peek.hidden = true; canvas.dataset.peek = 'false'; return; }
      const close = iconButton('Close', icon('x'), () => closePeek(), { 'data-slot': 'delegation-peek-close' });
      if (sel.kind === 'row') {
        const i = visible.findIndex((r) => r.key === sel.key);
        const r = visible[i];
        if (!r) { closePeek(); return; }
        const t = TYPES[r.type];
        const full = String(r.full || '').trim();
        const body = full || (r.type === 'report' ? 'Finished. The result is in the agent.' : r.label);
        const actions = [];
        for (const pid of [...new Set([r.to, r.from])]) {
          if (pid === MAIN || !ctx.open) continue;
          actions.push(h('button', { type: 'button', class: `btn ${actions.length ? 'btn-outline' : 'btn-default'} btn-sm sa-seq-open`, 'data-slot': 'delegation-open', onclick: () => ctx.open(pid) }, icon('arrow-right'), `Open ${nameOf(pid)}`));
        }
        actions.push(iconButton('Copy the text', icon('copy'), async () => { const ok = typeof copyText === 'function' && await copyText(body); if (typeof toast === 'function') toast(ok ? 'Copied.' : "Couldn't copy.", { type: ok ? 'success' : 'error' }); }));
        const prev = iconButton('Previous message', icon('chevron-left'), () => selectRow(visible[i - 1]?.key), { 'data-slot': 'delegation-prev' });
        const next = iconButton('Next message', icon('chevron-right'), () => selectRow(visible[i + 1]?.key), { 'data-slot': 'delegation-next' });
        prev.disabled = i <= 0; next.disabled = i >= visible.length - 1;
        peek.replaceChildren(
          h('div', { class: 'sa-seq-peek-head' },
            h('span', { class: 'sa-seq-type', 'data-type': r.type }, h('i', { class: 'sa-seq-swatch', 'data-type': r.type, 'aria-hidden': 'true' }), t.label),
            h('span', { class: 'sa-seq-peek-pos' }, `${i + 1} of ${visible.length}`),
            h('span', { class: 'sa-seq-spacer' }), prev, next, close),
          h('p', { class: 'sa-seq-route' }, who(r.from), h('span', { class: 'sa-seq-arrowtxt', 'aria-label': 'to' }, '→'), who(r.to)),
          h('p', { class: 'sa-seq-when' }, icon('clock'), h('span', null, `${clock(r.at)} · ${since(r.at)} after the first request`)),
          h('div', { class: 'sa-seq-text', 'data-slot': 'delegation-peek-text', tabindex: '0' }, body),
          h('div', { class: 'sa-seq-peek-actions' }, actions));
      } else {
        const p = model.parts[model.index.get(sel.id)];
        if (!p) { closePeek(); return; }
        const sent = visible.filter((r) => r.from === p.id).length; const got = visible.filter((r) => r.to === p.id).length;
        const r = p.record;
        const stats = p.main ? `${model.parts.length - 1} agents in this diagram` : [ctx.statusLabel ? ctx.statusLabel(p.status) : p.status, r && num(r.tokens) && ctx.fmtTokens ? `${ctx.fmtTokens(r.tokens)} tokens` : '', r && num(r.steps) ? `${r.steps} steps` : ''].filter(Boolean).join(' · ');
        const first = visible.find((x) => x.from === p.id || x.to === p.id);
        peek.replaceChildren(
          h('div', { class: 'sa-seq-peek-head' }, who(p.id), h('span', { class: 'sa-seq-spacer' }), close),
          h('p', { class: 'sa-seq-when' }, h('span', null, `${stats}${stats ? ' · ' : ''}${sent} sent, ${got} received`)),
          r?.task ? h('div', { class: 'sa-seq-text', tabindex: '0' }, r.task) : null,
          h('div', { class: 'sa-seq-peek-actions' },
            !p.main && ctx.open ? h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'delegation-open', onclick: () => ctx.open(p.id) }, icon('arrow-right'), 'Open agent') : null,
            first ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => selectRow(first.key) }, 'First message') : null));
      }
      peek.hidden = false; canvas.dataset.peek = 'true';
    }

    function summarize() {
      const n = model.parts.length - 1;
      const counts = {};
      for (const r of model.rows) counts[TYPES[r.type].group] = (counts[TYPES[r.type].group] || 0) + 1;
      chips.querySelectorAll('.sa-seq-chip').forEach((b) => { const c = counts[b.dataset.group] || 0; b.querySelector('.sa-seq-chip-n').textContent = c ? String(c) : ''; b.hidden = !c && !prefs.hidden.includes(b.dataset.group); });
      if (!model.rows.length) { summary.textContent = ''; return; }
      const span = model.rows.length > 1 ? ` · ${clock(model.rows[0].at)} – ${clock(model.rows[model.rows.length - 1].at)}` : '';
      const hits = query ? visible.filter(matches).length : null;
      summary.textContent = `${n} agent${n === 1 ? '' : 's'} · ${visible.length} message${visible.length === 1 ? '' : 's'}${span}${model.total > model.shown ? ` · latest ${model.shown} of ${model.total}` : ''}${hits != null ? ` · ${hits} match${hits === 1 ? '' : 'es'}` : ''}`;
    }

    /* ---------- live updates ---------- */
    function update() {
      if (destroyed) return;
      const next = buildModel(ctx);
      const s = JSON.stringify([next.rows.map((r) => [r.key, r.label, r.full.length]), next.parts.map((p) => [p.id, p.name, p.status, p.record?.tokens || 0]), prefs.hidden]);
      if (s === sig) return;
      const wasLatest = !view.auto && latestOnScreen();
      const firstPaint = !sig;
      const prevKeys = sig ? new Set(model.rows.map((r) => r.key)) : null;
      sig = s; model = next;
      visible = model.rows.filter((r) => !prefs.hidden.includes(TYPES[r.type].group));
      seenKeys = prevKeys;
      paint(); summarize();
      seenKeys = null;
      if (sel) showPeek();
      if (firstPaint || view.auto) { if (root.isConnected) initialView(); }
      else if (wasLatest && prevKeys && model.rows.some((r) => !prevKeys.has(r.key))) toLatest(true);
    }
    let ro = null;
    function ready() {
      if (destroyed) return;
      if (!sig) update();
      if (view.auto) initialView(); else applyView();
      if (!ro && typeof ResizeObserver === 'function') {
        let last = '';
        ro = new ResizeObserver(() => { const { w, h: hh } = size(); const k = `${w}x${hh}`; if (k === last) return; last = k; if (view.auto) initialView(); else applyView(); });
        ro.observe(canvas);
      }
    }
    function destroy() { destroyed = true; ro?.disconnect(); }

    update();
    return {
      root, update, ready, destroy, fitAll, reset: () => initialView(), zoomAt, toLatest, zoomBy,
      selectRow: (key) => selectRow(key), selectPart: (pid) => selectPart(pid), close: closePeek,
      get model() { return model; }, get rows() { return visible; }, get view() { return { ...view }; },
      get svg() { return svg; },
      exportSvg: () => { const was = sel; if (was) { sel = null; paint(); } const out = exportSvg(svg, { stages: [gStage, gHead], background: getComputedStyle(canvas).backgroundColor }); if (was) { sel = was; paint(); } return out; },
    };
  }

  return { mount, buildModel, exportSvg, TYPES, MAIN };
})();
