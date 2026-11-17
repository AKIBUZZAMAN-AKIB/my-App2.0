/* ==========================================================================
   Sub-agent Explorer (engine feature `subagentAdvanced`).

   The whole delegation graph of the open chat on one zoomable canvas:
   - spawn edges (who started whom), waits-for edges (pipelines and `after`),
     message edges (team messages, with counts) and batch groups (parallel,
     pipeline, race, with the race winner);
   - zoom (wheel, pinch, buttons, + / - / 0 keys), pan (drag, arrow keys) and
     fit; left-to-right or top-to-bottom layout;
   - filter by text and status, toggle each edge kind;
   - timeline replay of the engine's saved event log (scrub, play, speed);
   - click a node for its inspector and every control (open, chat, message,
     stop, stop tree, pause, resume, retry, run again, move to chat, delete);
     bulk control for the whole chat.

   Also here: the batch dialog (`spawnBatch`) and "Fork into sub-agent" from
   a chat message (`spawn` with `context: "fork"`). The module keeps no agent
   state of its own: 10-subagents.js hands it a context with the records,
   the last `graph` answer and the engine calls.
   ========================================================================== */
const SubagentExplorer = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MAIN = '__main__';
  const W = 196, H = 74; // node size
  const GAP_X = 72, GAP_Y = 22; // left-to-right gaps
  const GAP_X_TB = 26, GAP_Y_TB = 70; // top-to-bottom gaps
  const K_MIN = 0.2, K_MAX = 2.5;
  const MAX_BATCH = 12;
  const STATUS_FILTERS = [['all', 'All statuses'], ['active', 'Running or queued'], ['running', 'Running'], ['queued', 'Queued'], ['waiting_approval', 'Needs approval'], ['finished', 'Finished'], ['error', 'Failed'], ['cancelled', 'Stopped'], ['paused', 'Paused']];
  const MODE_TEXT = { parallel: 'Parallel', pipeline: 'Pipeline', race: 'Race', review: 'Review' };
  const MODE_HELP = {
    parallel: 'All start together. You get every report.',
    pipeline: 'One after another. Each step gets the report of the step before it.',
    race: 'All start together. The first to finish wins; the others stop.',
    review: 'A worker and a reviewer. The reviewer checks the work and sends feedback back until it approves, or the rounds run out.',
  };
  const REVIEW_ROLE = ['Worker', 'Reviewer'];
  const EVENT_STATUS = { started: 'running', queued: 'queued', finished: 'finished', error: 'error', cancelled: 'cancelled', race_lost: 'cancelled', dependency_failed: 'cancelled', approval_needed: 'waiting_approval' };
  const EVENT_TEXT = { started: 'started', queued: 'queued', finished: 'finished', error: 'failed', cancelled: 'stopped', race_lost: 'lost the race', review_round: 'reviewed a round', review_approved: 'approved by the reviewer', dependency_failed: 'cancelled (a step it waited for failed)', approval_needed: 'needs approval', message: 'got a message', peer_message: 'messaged', ask_parent: 'asked its parent', parent_answer: 'got an answer', handoff: 'handed off' };

  // Lucide icons the Explorer uses that the page may not have yet.
  const extraIcons = {
    network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
    'mouse-pointer-click': '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
    'maximize-2': '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
    'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'zoom-in': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
    'zoom-out': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    'arrow-right-left': '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
    'git-branch-plus': '<path d="M6 3v12"/><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M15 6a9 9 0 0 0-9 9"/><path d="M18 15v6"/><path d="M21 18h-6"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'list-filter': '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
    'square-stack': '<path d="M4 10c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2"/><path d="M10 16c-1.1 0-2-.9-2-2v-4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2"/><rect width="8" height="8" x="14" y="14" rx="2"/>',
    'move-vertical': '<path d="M12 2v20"/><path d="m8 18 4 4 4-4"/><path d="m8 6 4-4 4 4"/>',
    'move-horizontal': '<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>',
    'minimize-2': '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
    gantt: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 7h7"/><path d="M11 12h8"/><path d="M8 17h5"/>',
    columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
    'git-fork': '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  };
  if (typeof ICONS !== 'undefined') for (const [k, v] of Object.entries(extraIcons)) if (!ICONS[k]) ICONS[k] = v;

  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t; };
  const isActive = (s) => s === 'running' || s === 'queued' || s === 'waiting_approval';
  const dur = (ms) => {
    const n = Math.max(0, Math.round(num(ms) / 1000));
    if (!n) return '';
    if (n < 60) return `${n}s`;
    if (n < 3600) return `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s`;
    return `${Math.floor(n / 3600)}h ${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}m`;
  };
  const clock = (ms) => (num(ms) > 0 ? new Date(num(ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }

  /* ---------- per-chat view state, kept while the app runs ---------- */
  const views = new Map(); // chat -> { k, x, y, fitted }
  const prefs = { view: 'graph', orient: 'lr', q: '', status: 'all', edges: { spawn: true, dependency: true, message: true } };
  try { const p = JSON.parse(localStorage.getItem('agent.subagents.explorer.v1') || 'null'); if (p && typeof p === 'object') { if (p.orient === 'tb') prefs.orient = 'tb'; if (p.view === 'timeline') prefs.view = 'timeline'; if (p.edges) Object.assign(prefs.edges, p.edges); } } catch { /* first run */ }
  const savePrefs = () => { try { localStorage.setItem('agent.subagents.explorer.v1', JSON.stringify({ view: prefs.view, orient: prefs.orient, edges: prefs.edges })); } catch { /* private mode */ } };

  /* ---------- the model: nodes, edges, groups, events ---------- */
  function buildModel(ctx) {
    const recs = ctx.records();
    const g = ctx.graph() || {};
    const gNodes = new Map((Array.isArray(g.nodes) ? g.nodes : []).map((n) => [String(n.id), n]));
    const ids = new Set(recs.map((r) => r.id));
    const nodes = new Map();
    const pick = (r, gn, k) => (r[k] !== undefined && r[k] !== null ? r[k] : gn[k]);
    for (const r of recs) {
      const gn = gNodes.get(r.id) || {};
      const pid = ctx.parentOf(r);
      const started = num(pick(r, gn, 'startedAt')) || num(r.createdAt);
      const finished = num(r.finishedAt);
      nodes.set(r.id, {
        id: r.id, rec: r, parent: pid && ids.has(pid) ? pid : MAIN, name: r.name, title: r.title || gn.title || '', task: r.task || gn.task || '',
        status: r.paused || gn.paused ? (isActive(r.status) ? 'paused' : r.status) : r.status, rawStatus: r.status, paused: !!(r.paused ?? gn.paused),
        depth: num(r.depth, 1), model: r.model || gn.model || '', tokens: num(r.totalTokens), budget: num(r.tokenBudget || gn.tokenBudget), steps: num(r.steps), toolCalls: num(r.toolCalls),
        startedAt: started, createdAt: num(r.createdAt) || started,
        durationMs: gn.durationMs != null ? num(gn.durationMs) : finished && started ? finished - started : isActive(r.status) && started ? Date.now() - started : 0,
        groupId: pick(r, gn, 'groupId') || '', groupMode: pick(r, gn, 'groupMode') || '', groupIndex: num(pick(r, gn, 'groupIndex'), 0), winner: !!pick(r, gn, 'groupWinner'),
        dependsOn: [].concat(pick(r, gn, 'dependsOn') || []).map(String).filter((d) => ids.has(d)),
        contextMode: pick(r, gn, 'contextMode') || '', contextSource: pick(r, gn, 'contextSource') || '', handoff: !!pick(r, gn, 'handoff'), forkedFrom: pick(r, gn, 'forkedFrom') || '',
        error: r.error || gn.error || '', shareable: !!pick(r, gn, 'shareable'), sessionKey: r.sessionKey || '', parentSessionKey: r.parentSessionKey || '',
      });
    }
    const all = [...nodes.values()];
    const main = { id: MAIN, isMain: true, name: 'Main agent', title: 'This chat', status: all.some((n) => isActive(n.rawStatus)) ? 'running' : 'idle', depth: 0, parent: null, dependsOn: [] };
    nodes.set(MAIN, main);
    // Waits-for: the engine's edges, plus any the records know about.
    const dep = new Map();
    for (const e of Array.isArray(g.dependencyEdges) ? g.dependencyEdges : []) if (ids.has(String(e.from)) && ids.has(String(e.to))) dep.set(`${e.from}>${e.to}`, { from: String(e.from), to: String(e.to) });
    for (const n of all) for (const d of n.dependsOn) dep.set(`${d}>${n.id}`, { from: d, to: n.id });
    // Messages between agents: the engine's counts, else counted from the event log.
    const events = ctx.log().filter((e) => e && num(e.at) > 0 && (ids.has(String(e.id)) || e.id === MAIN)).slice().sort((a, b) => num(a.at) - num(b.at));
    const byName = new Map(all.map((n) => [n.name, n.id]));
    const resolve = (x) => (ids.has(String(x)) ? String(x) : byName.get(String(x)) || null);
    const msg = new Map();
    const engineMsgs = Array.isArray(g.messageEdges) ? g.messageEdges : [];
    if (engineMsgs.length) {
      for (const e of engineMsgs) { const f = resolve(e.from), t = resolve(e.to); if (f && t) msg.set(`${f}>${t}`, { from: f, to: t, count: num(e.count, 1) }); }
    } else {
      for (const e of events) {
        if (e.kind !== 'peer_message') continue;
        const f = resolve(e.id), t = resolve(e.to || e.toName);
        if (!f || !t) continue;
        const k = `${f}>${t}`; const m = msg.get(k) || { from: f, to: t, count: 0 }; m.count += 1; msg.set(k, m);
      }
    }
    // Batch groups.
    const groups = new Map();
    for (const gr of Array.isArray(g.groups) ? g.groups : []) if (gr?.groupId) groups.set(String(gr.groupId), { id: String(gr.groupId), mode: String(gr.mode || ''), winner: gr.winner ? String(gr.winner) : '', members: [] });
    for (const n of all) {
      if (!n.groupId) continue;
      const gr = groups.get(n.groupId) || { id: n.groupId, mode: n.groupMode, winner: '', members: [] };
      if (!gr.mode) gr.mode = n.groupMode;
      if (n.winner) gr.winner = n.id;
      gr.members.push(n.id);
      groups.set(n.groupId, gr);
    }
    for (const [k, gr] of groups) if (!gr.members.length) groups.delete(k);
    return { nodes, spawn: all.map((n) => ({ from: n.parent, to: n.id })), dep: [...dep.values()], msg: [...msg.values()], groups: [...groups.values()], events };
  }

  /** Tidy tree: leaves take consecutive slots, a parent sits in the middle of its children. */
  function layout(model, orient) {
    const kids = new Map();
    for (const n of model.nodes.values()) {
      if (n.isMain) continue;
      const p = model.nodes.has(n.parent) ? n.parent : MAIN;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
    for (const list of kids.values()) list.sort((a, b) => (a.groupId === b.groupId && a.groupId ? a.groupIndex - b.groupIndex : 0) || a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
    const slot = new Map();
    const order = [];
    let leaf = 0;
    const seen = new Set();
    const place = (id, d) => {
      if (seen.has(id)) return; seen.add(id); order.push(id);
      const ch = (kids.get(id) || []).filter((c) => !seen.has(c.id));
      if (!ch.length) { slot.set(id, { d, s: leaf++ }); return; }
      for (const c of ch) place(c.id, d + 1);
      const placed = ch.map((c) => slot.get(c.id)).filter(Boolean);
      slot.set(id, { d, s: placed.length ? (placed[0].s + placed[placed.length - 1].s) / 2 : leaf++ });
    };
    place(MAIN, 0);
    const pos = new Map();
    for (const [id, { d, s }] of slot) {
      pos.set(id, orient === 'tb' ? { x: s * (W + GAP_X_TB), y: d * (H + GAP_Y_TB), d } : { x: d * (W + GAP_X), y: s * (H + GAP_Y), d });
    }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of pos.values()) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x + W); y2 = Math.max(y2, p.y + H); }
    return { pos, order, bounds: { x1, y1, x2, y2 } };
  }

  /** Status of every agent at time `t` from the event log (null = not started yet), and message counts so far. */
  function stateAt(model, t) {
    const st = new Map();
    const msgs = new Map();
    for (const e of model.events) {
      if (num(e.at) > t) break;
      const s = EVENT_STATUS[e.kind];
      if (s) st.set(String(e.id), s);
      else if (!st.has(String(e.id))) st.set(String(e.id), 'running');
      if (e.kind === 'peer_message' && e.to) { const k = `${e.id}>${e.to}`; msgs.set(k, (msgs.get(k) || 0) + 1); }
    }
    for (const n of model.nodes.values()) if (!n.isMain && !st.has(n.id) && n.createdAt && n.createdAt <= t && !model.events.some((e) => String(e.id) === n.id)) st.set(n.id, n.rawStatus);
    return { st, msgs };
  }

  /* ---------- edge geometry ---------- */
  function edgePath(a, b, orient, kind) {
    if (orient === 'tb') {
      if (Math.abs(a.y - b.y) < 1) { // same row: arc under (waits-for) or over (messages)
        const down = kind !== 'message';
        const y = down ? a.y + H : a.y; const off = down ? 34 : -34;
        const ax = a.x + W / 2, bx = b.x + W / 2;
        return { d: `M${ax},${y} C${ax},${y + off} ${bx},${y + off} ${bx},${y}`, mx: (ax + bx) / 2, my: y + off * 0.75 };
      }
      const up = b.y < a.y;
      const ax = a.x + W / 2, ay = up ? a.y : a.y + H, bx = b.x + W / 2, by = up ? b.y + H : b.y;
      const my = (ay + by) / 2;
      return { d: `M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}`, mx: (ax + bx) / 2, my };
    }
    if (Math.abs(a.x - b.x) < 1) { // same column: arc on the right (waits-for) or the left (messages)
      const right = kind !== 'message';
      const x = right ? a.x + W : a.x; const off = right ? 38 : -38;
      const ay = a.y + H / 2, by = b.y + H / 2;
      return { d: `M${x},${ay} C${x + off},${ay} ${x + off},${by} ${x},${by}`, mx: x + off * 0.75, my: (ay + by) / 2 };
    }
    const back = b.x < a.x;
    const ax = back ? a.x : a.x + W, ay = a.y + H / 2, bx = back ? b.x + W : b.x, by = b.y + H / 2;
    const mx = (ax + bx) / 2;
    return { d: `M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}`, mx, my: (ay + by) / 2 };
  }

  /* ---------- mount ---------- */
  function mount(ctx) {
    const chat = ctx.chat || '';
    const view = views.get(chat) || { k: 1, x: 24, y: 24, fitted: false };
    views.set(chat, view);
    let selected = null;
    let replayT = null; // null = live
    let playing = 0;
    let speed = 8;
    let model = buildModel(ctx);
    let lay = layout(model, prefs.orient);
    let lastSig = '';
    let graphSig = '';
    let graphTimer = 0;
    let destroyed = false;

    /* toolbar */
    const search = h('input', { type: 'search', class: 'input sa-x-search', placeholder: 'Find an agent', 'aria-label': 'Find an agent by name, title, task or model', 'data-slot': 'explorer-search', value: prefs.q,
      oninput: () => { prefs.q = search.value; paintGraph(); } });
    const statusSel = h('select', { class: 'select sa-x-status', 'aria-label': 'Show status', 'data-slot': 'explorer-status', onchange: () => { prefs.status = statusSel.value; paintGraph(); } },
      ...STATUS_FILTERS.map(([v, l]) => h('option', { value: v, selected: v === prefs.status }, l)));
    const edgeToggle = (kind, label) => h('button', { type: 'button', class: 'sa-x-chip', 'data-edge-toggle': kind, 'aria-pressed': String(!!prefs.edges[kind]),
      onclick: (e) => { prefs.edges[kind] = !prefs.edges[kind]; e.currentTarget.setAttribute('aria-pressed', String(prefs.edges[kind])); savePrefs(); paintGraph(); } },
      h('span', { class: 'sa-x-swatch', 'data-kind': kind, 'aria-hidden': 'true' }), label);
    const orientBtn = iconButton(prefs.orient === 'tb' ? 'Lay out left to right' : 'Lay out top to bottom', icon(prefs.orient === 'tb' ? 'move-horizontal' : 'move-vertical'), () => {
      prefs.orient = prefs.orient === 'tb' ? 'lr' : 'tb'; savePrefs();
      orientBtn.setAttribute('aria-label', prefs.orient === 'tb' ? 'Lay out left to right' : 'Lay out top to bottom');
      setChildren(orientBtn, icon(prefs.orient === 'tb' ? 'move-horizontal' : 'move-vertical'));
      lay = layout(model, prefs.orient); paintGraph(); fit();
    });
    orientBtn.dataset.slot = 'explorer-orient';
    const zoomOut = iconButton('Zoom out', icon('zoom-out'), () => zoomBy(1 / 1.25));
    const zoomIn = iconButton('Zoom in', icon('zoom-in'), () => zoomBy(1.25));
    const fitBtn = iconButton('Fit to screen', icon('scan'), () => fit(true));
    zoomOut.dataset.slot = 'explorer-zoom-out'; zoomIn.dataset.slot = 'explorer-zoom-in'; fitBtn.dataset.slot = 'explorer-fit';
    const zoomLabel = h('span', { class: 'sa-x-zoom', 'aria-live': 'polite', 'data-slot': 'explorer-zoom' });
    const summary = h('p', { class: 'sa-x-summary', 'data-slot': 'explorer-summary' });
    const newBatch = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'explorer-new-batch', onclick: () => batchDialog({ ...ctx, onStarted: (res) => { if (res?.subagents?.[0]) selected = res.subagents[0].id; refreshGraph(true); } }) }, icon('layers'), 'New batch');
    const bulkSel = h('select', { class: 'select sa-x-bulk', 'aria-label': 'Control every agent of this chat', 'data-slot': 'explorer-bulk', onchange: () => { const v = bulkSel.value; bulkSel.value = ''; if (v) runBulk(v); } },
      h('option', { value: '' }, 'All agents\u2026'),
      h('option', { value: 'stop' }, 'Stop all running'),
      h('option', { value: 'stopTree' }, 'Stop all with their trees'),
      h('option', { value: 'pause' }, 'Pause all running'),
      h('option', { value: 'resume' }, 'Resume all paused'),
      h('option', { value: 'retry' }, 'Retry all ended'),
      h('option', { value: 'delete' }, 'Delete all ended'));
    // Graph or waterfall: the waterfall is the trace view (LangSmith, OpenAI traces): who ran when, for how long, and what it cost.
    const viewBtn = (v, label, ic) => h('button', { type: 'button', role: 'radio', class: 'sa-x-viewbtn', 'data-slot': `explorer-view-${v}`, 'aria-checked': String(prefs.view === v),
      onclick: () => setView(v) }, icon(ic), h('span', null, label));
    const viewSwitch = h('div', { class: 'sa-x-viewswitch', role: 'radiogroup', 'aria-label': 'View', 'data-slot': 'explorer-view',
      onkeydown: (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setView(prefs.view === 'graph' ? 'timeline' : 'graph'); viewSwitch.querySelector('[aria-checked=true]')?.focus(); } } },
      viewBtn('graph', 'Graph', 'network'), viewBtn('timeline', 'Timeline', 'gantt'));
    const toolbar = h('div', { class: 'sa-x-toolbar', role: 'toolbar', 'aria-label': 'Explorer' },
      h('div', { class: 'sa-x-row' }, viewSwitch, h('label', { class: 'sa-x-searchwrap' }, icon('search'), search), statusSel),
      h('div', { class: 'sa-x-row' },
        h('div', { class: 'sa-x-chips', role: 'group', 'aria-label': 'Edges to show' }, edgeToggle('spawn', 'Started'), edgeToggle('dependency', 'Waits for'), edgeToggle('message', 'Messages')),
        h('span', { class: 'sa-spacer' })),
      h('div', { class: 'sa-x-row' }, summary, h('span', { class: 'sa-spacer' }), bulkSel, newBatch));

    /* canvas */
    const defs = sv('defs', null,
      ...['spawn', 'dependency', 'message'].map((k) => sv('marker', { id: `sa-x-arrow-${k}-${uid(4)}`, 'data-marker': k, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, sv('path', { d: 'M0,1 L9,5 L0,9 z', class: `sa-x-arrowhead`, 'data-kind': k }))));
    const markerId = (k) => defs.querySelector(`[data-marker="${k}"]`).id;
    const gGroups = sv('g', { class: 'sa-x-groups' });
    const gEdges = sv('g', { class: 'sa-x-edges' });
    const gNodes = sv('g', { class: 'sa-x-nodes' });
    const stage = sv('g', { class: 'sa-x-stage' }, gGroups, gEdges, gNodes);
    const svg = sv('svg', { class: 'sa-x-svg', role: 'presentation', 'aria-hidden': 'false' }, defs, stage);
    const canvas = h('div', { class: 'sa-x-canvas', tabindex: '0', role: 'group', 'aria-roledescription': 'graph', 'aria-label': 'Delegation graph. Drag or use arrow keys to move, plus and minus to zoom, 0 to fit. Tab to an agent and press Enter for its controls.', 'data-slot': 'explorer-canvas' });
    canvas.append(svg);
    const empty = h('div', { class: 'sa-x-empty', hidden: true }, icon('network'), h('p', null, 'No sub-agents in this chat yet.'), h('p', { class: 'field-hint' }, 'Start a batch, or ask the agent to delegate.'));
    const legend = h('div', { class: 'sa-x-legend', 'aria-hidden': 'true' },
      ...[['running', 'Running'], ['queued', 'Queued'], ['waiting_approval', 'Approval'], ['finished', 'Finished'], ['error', 'Failed'], ['cancelled', 'Stopped'], ['paused', 'Paused']].map(([s, l]) => h('span', null, h('i', { 'data-status': s }), l)));
    const wf = h('div', { class: 'sa-x-wf', 'data-slot': 'explorer-waterfall', role: 'group', 'aria-label': 'Timeline of every agent: when it ran and for how long. Arrow keys move between rows; Enter selects.' });
    const miniStage = sv('g', { class: 'sa-x-mini-stage' });
    const miniView = sv('rect', { class: 'sa-x-mini-view', rx: 3 });
    const mini = sv('svg', { class: 'sa-x-mini', 'data-slot': 'explorer-minimap', role: 'img', 'aria-label': 'Overview map. Click to move the view there.' }, miniStage, miniView);
    // Floating canvas controls (the React Flow <Controls/> pattern): zoom stays with the canvas, so the toolbar is one row shorter.
    const zoomGroup = h('div', { class: 'sa-x-zoomgroup', role: 'group', 'aria-label': 'Zoom and layout', 'data-slot': 'explorer-controls' }, zoomOut, zoomLabel, zoomIn, fitBtn, orientBtn);
    const canvasWrap = h('div', { class: 'sa-x-canvaswrap' }, canvas, wf, empty, zoomGroup, mini, legend);

    /* timeline */
    const scrub = h('input', { type: 'range', class: 'sa-x-scrub', min: '0', max: '1000', step: '1', value: '1000', 'aria-label': 'Replay time', 'data-slot': 'explorer-scrub',
      oninput: () => { stopPlay(); setReplay(fracToT(num(scrub.value) / 1000)); } });
    const playBtn = iconButton('Play replay', icon('play'), () => (playing ? stopPlay() : startPlay()));
    playBtn.dataset.slot = 'explorer-play';
    const liveBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-x-live', 'data-slot': 'explorer-live', 'aria-pressed': 'true', onclick: () => { stopPlay(); setReplay(null); } }, icon('radio'), 'Live');
    const speedSel = h('select', { class: 'select sa-x-speed', 'aria-label': 'Replay speed', 'data-slot': 'explorer-speed', onchange: () => { speed = num(speedSel.value, 8); } },
      ...[1, 4, 8, 32, 128].map((s) => h('option', { value: String(s), selected: s === speed }, `${s}\u00d7`)));
    const tLabel = h('span', { class: 'sa-x-tlabel', 'aria-live': 'off', 'data-slot': 'explorer-time' });
    const ticker = h('ol', { class: 'sa-x-ticker', 'aria-label': 'Events up to this point', 'data-slot': 'explorer-ticker' });
    const timeline = h('div', { class: 'sa-x-timeline', 'data-slot': 'explorer-timeline' },
      h('div', { class: 'sa-x-row' }, liveBtn, playBtn, scrub, speedSel), h('div', { class: 'sa-x-row' }, tLabel), ticker);

    /* inspector */
    const inspector = h('section', { class: 'sa-x-inspector', 'aria-label': 'Selected agent', 'data-slot': 'explorer-inspector', 'aria-live': 'polite' });

    // The wrapper is a size container, so the two-column layout follows the panel's width, not the window's.
    const root = h('div', { class: 'sa-explorer', 'data-slot': 'subagent-explorer', 'data-view': prefs.view }, h('div', { class: 'sa-x-grid' }, toolbar, canvasWrap, timeline, inspector));

    /* ----- view transform ----- */
    const applyView = () => {
      stage.setAttribute('transform', `translate(${view.x.toFixed(1)},${view.y.toFixed(1)}) scale(${view.k.toFixed(3)})`);
      zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
      root.dataset.zoom = view.k.toFixed(3);
      paintMiniView();
    };
    const size = () => ({ w: canvas.clientWidth || 360, h: canvas.clientHeight || 360 });
    function zoomAt(px, py, f) {
      const k = clamp(view.k * f, K_MIN, K_MAX);
      const real = k / view.k;
      view.x = px - (px - view.x) * real; view.y = py - (py - view.y) * real; view.k = k;
      view.fitted = false; applyView();
    }
    const zoomBy = (f) => { const { w, h: hh } = size(); zoomAt(w / 2, hh / 2, f); };
    // Auto-fit never shrinks the text below a readable size (like React Flow's fitView minZoom): a big team starts at the main
    // agent, readable, and the minimap shows the rest. The Fit button (or 0) fits everything, however small.
    const READABLE = 0.74;
    function fit(all = false) {
      const { w, h: hh } = size();
      const b = lay.bounds;
      if (!Number.isFinite(b.x1)) return;
      const bw = b.x2 - b.x1 + 48, bh = b.y2 - b.y1 + 48;
      const k = Math.min(w / bw, hh / bh, 1.15);
      view.k = clamp(all ? k : Math.max(k, w < 520 ? 0.62 : READABLE), K_MIN, K_MAX);
      const gw = (b.x2 - b.x1) * view.k, gh = (b.y2 - b.y1) * view.k;
      view.x = gw <= w ? (w - gw) / 2 - b.x1 * view.k : 24 - b.x1 * view.k;
      if (gh <= hh) view.y = (hh - gh) / 2 - b.y1 * view.k;
      else { const mid = [...model.nodes.values()].find((x) => x.isMain)?.id; const m = (mid && lay.pos.get(mid)) || { y: b.y1 }; view.y = clamp(hh / 2 - (m.y + H / 2) * view.k, hh - 24 - b.y2 * view.k, 24 - b.y1 * view.k); }
      view.fitted = true; applyView();
    }
    function centerOn(id) {
      const p = lay.pos.get(id); if (!p) return;
      const { w, h: hh } = size();
      const sx = p.x * view.k + view.x, sy = p.y * view.k + view.y;
      if (sx > 8 && sy > 8 && sx + W * view.k < w - 8 && sy + H * view.k < hh - 8) return;
      view.x = w / 2 - (p.x + W / 2) * view.k; view.y = hh / 2 - (p.y + H / 2) * view.k; view.fitted = false; applyView();
    }

    /* ----- pan / zoom input ----- */
    const pointers = new Map();
    let drag = null, pinch = null, lastTap = { id: null, at: 0 };
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { svg.setPointerCapture(e.pointerId); } catch { /* old engines */ }
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, node: e.target.closest?.('[data-node]')?.dataset.node || null };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const r = svg.getBoundingClientRect();
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.k, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
        drag = null;
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        zoomAt(pinch.cx, pinch.cy, (pinch.k * (d / pinch.d)) / view.k);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true; canvas.dataset.panning = 'true';
      view.x = drag.vx + dx; view.y = drag.vy + dy; view.fitted = false; applyView();
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && pointers.size === 0) {
        if (!drag.moved) {
          const id = drag.node;
          const now = Date.now();
          if (id && lastTap.id === id && now - lastTap.at < 350) { lastTap = { id: null, at: 0 }; if (id !== MAIN) ctx.open(id); }
          else { lastTap = { id, at: now }; select(id); }
        }
        drag = null; delete canvas.dataset.panning;
      }
    };
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
      else { view.x -= e.deltaX; view.fitted = false; applyView(); }
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      const onNode = e.target?.closest?.('[data-node]');
      if ((e.key === 'Enter' || e.key === ' ') && onNode) { e.preventDefault(); select(onNode.dataset.node); inspector.querySelector('button')?.focus(); return; }
      const step = e.shiftKey ? 120 : 40;
      const keys = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (keys[e.key] && !onNode) { e.preventDefault(); view.x += keys[e.key][0]; view.y += keys[e.key][1]; view.fitted = false; applyView(); return; }
      if (keys[e.key] && onNode) { e.preventDefault(); focusNear(onNode.dataset.node, e.key); return; }
      if ((e.key === 'Home' || e.key === 'End') && onNode) { e.preventDefault(); const all = [...gNodes.querySelectorAll('[data-node]')]; (e.key === 'Home' ? all[0] : all[all.length - 1])?.focus(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.25); }
      else if (e.key === '0') { e.preventDefault(); fit(true); }
      else if (e.key === 'Escape' && selected) { e.preventDefault(); e.stopPropagation(); select(null); }
    });

    /* ----- painting ----- */
    const matches = (n) => {
      if (n.isMain) return true;
      const q = prefs.q.trim().toLowerCase();
      if (q && ![n.name, n.title, n.task, n.model, n.id, n.groupMode].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      const s = n.status;
      if (prefs.status === 'all') return true;
      if (prefs.status === 'active') return isActive(n.rawStatus);
      return s === prefs.status || (prefs.status === 'paused' && n.paused);
    };
    function paintGraph() {
      const rs = replayT == null ? null : stateAt(model, replayT);
      const statusOf = (n) => (n.isMain ? n.status : rs ? rs.st.get(n.id) || null : n.status);
      const visible = (id) => { const n = model.nodes.get(id); return !!n && (n.isMain || !rs || rs.st.has(id)); };
      setChildren(gGroups); setChildren(gEdges); setChildren(gNodes);
      // Batch groups behind everything.
      for (const gr of model.groups) {
        const ps = gr.members.filter(visible).map((id) => lay.pos.get(id)).filter(Boolean);
        if (!ps.length) continue;
        const x1 = Math.min(...ps.map((p) => p.x)) - 10, y1 = Math.min(...ps.map((p) => p.y)) - 24, x2 = Math.max(...ps.map((p) => p.x + W)) + 10, y2 = Math.max(...ps.map((p) => p.y + H)) + 10;
        const win = gr.winner && model.nodes.get(gr.winner);
        gGroups.append(sv('g', { class: 'sa-x-group', 'data-group': gr.id, 'data-mode': gr.mode },
          sv('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 14 }),
          sv('text', { x: x1 + 10, y: y1 + 15, class: 'sa-x-group-label' }, `${MODE_TEXT[gr.mode] || 'Batch'} \u00b7 ${gr.members.length}${win ? (gr.mode === 'review' ? ' \u00b7 approved' : ` \u00b7 winner: ${short(win.name, 18)}`) : ''}`)));
      }
      const drawEdge = (kind, e, count) => {
        if (!prefs.edges[kind] || !visible(e.from) || !visible(e.to)) return;
        const a = lay.pos.get(e.from), b = lay.pos.get(e.to);
        if (!a || !b) return;
        const p = edgePath(a, b, prefs.orient, kind);
        const dim = !(matches(model.nodes.get(e.from)) && matches(model.nodes.get(e.to)));
        const hot = selected && (e.from === selected || e.to === selected);
        const g = sv('g', { class: 'sa-x-edge', 'data-edge': kind, 'data-from': e.from, 'data-to': e.to, 'data-dim': dim ? 'true' : null, 'data-hot': hot ? 'true' : null },
          sv('path', { d: p.d, 'marker-end': `url(#${markerId(kind)})` }));
        if (kind === 'message' && count) g.append(sv('g', { class: 'sa-x-count' }, sv('circle', { cx: p.mx, cy: p.my, r: 9 }), sv('text', { x: p.mx, y: p.my + 3.5, 'text-anchor': 'middle' }, String(count))));
        gEdges.append(g);
      };
      for (const e of model.spawn) drawEdge('spawn', e);
      for (const e of model.dep) drawEdge('dependency', e);
      for (const e of model.msg) { const c = rs ? rs.msgs.get(`${e.from}>${e.to}`) || 0 : e.count; if (!rs || c) drawEdge('message', e, c); }
      for (const id of lay.order) {
        const n = model.nodes.get(id);
        if (!n || !visible(id)) continue;
        const p = lay.pos.get(id);
        const st = statusOf(n) || 'queued';
        const sub = n.isMain ? `${model.nodes.size - 1} agent${model.nodes.size === 2 ? '' : 's'} \u00b7 ${[...model.nodes.values()].filter((x) => !x.isMain && isActive(x.rawStatus)).length} active` : short(n.title || n.task || n.model || n.id, 30);
        const meta = n.isMain ? 'Click for chat-wide controls' : [n.tokens ? `${tok(n.tokens)} tok` : '', n.steps ? `${n.steps} step${n.steps === 1 ? '' : 's'}` : '', dur(n.durationMs)].filter(Boolean).join(' \u00b7 ') || (st === 'queued' ? 'Waiting to start' : '');
        const badges = n.isMain ? [] : [n.winner ? 'winner' : '', n.contextMode === 'fork' ? 'fork' : '', n.handoff ? 'handoff' : '', n.dependsOn.length ? `waits ${n.dependsOn.length}` : ''].filter(Boolean);
        const label = n.isMain ? `Main agent. ${sub}.` : `${n.name}, ${(ctx.statusLabel || {})[st] || st}${n.title ? `, ${n.title}` : ''}${n.groupMode ? `, ${MODE_TEXT[n.groupMode] || n.groupMode} batch` : ''}${n.winner ? ', winner' : ''}.`;
        const g = sv('g', { class: 'sa-x-node', 'data-node': id, 'data-status': st, 'data-main': n.isMain ? 'true' : null, 'data-selected': selected === id ? 'true' : null, 'data-dim': matches(n) ? null : 'true', 'data-match': prefs.q.trim() && !n.isMain && matches(n) ? 'true' : null,
          transform: `translate(${p.x},${p.y})`, tabindex: '0', role: 'button', 'aria-label': label, 'aria-pressed': selected === id ? 'true' : 'false' },
          sv('rect', { class: 'sa-x-box', width: W, height: H, rx: 12 }),
          sv('rect', { class: 'sa-x-stripe', width: 4, height: H - 20, x: 0, y: 10, rx: 2 }),
          sv('circle', { class: 'sa-x-dot', cx: 18, cy: 20, r: 4.5 }),
          sv('text', { class: 'sa-x-name', x: 30, y: 24 }, short(n.name, 20)),
          sv('text', { class: 'sa-x-sub', x: 14, y: 43 }, sub),
          sv('text', { class: 'sa-x-meta', x: 14, y: 62 }, short(meta, 34)));
        let bx = W - 8;
        for (const b of badges.slice(0, 2).reverse()) {
          const w = 8 + b.length * 5.6;
          bx -= w;
          g.append(sv('g', { class: 'sa-x-badge', 'data-badge': b.split(' ')[0] }, sv('rect', { x: bx, y: 9, width: w, height: 15, rx: 7.5 }), sv('text', { x: bx + w / 2, y: 20, 'text-anchor': 'middle' }, b)));
          bx -= 4;
        }
        if (n.groupMode === 'pipeline' && n.groupIndex) g.append(sv('text', { class: 'sa-x-step', x: W - 10, y: 62, 'text-anchor': 'end' }, `step ${n.groupIndex + (model.groups.find((x) => x.id === n.groupId)?.members.some((m) => model.nodes.get(m)?.groupIndex === 0) ? 1 : 0)}`));
        gNodes.append(g);
      }
      const agents = [...model.nodes.values()].filter((n) => !n.isMain);
      empty.hidden = agents.length > 0;
      const act = agents.filter((n) => isActive(n.rawStatus)).length;
      const failed = agents.filter((n) => n.rawStatus === 'error').length;
      const shown = agents.filter(matches).length;
      summary.textContent = `${agents.length} agent${agents.length === 1 ? '' : 's'} \u00b7 ${act} active${failed ? ` \u00b7 ${failed} failed` : ''}${model.groups.length ? ` \u00b7 ${model.groups.length} batch${model.groups.length === 1 ? '' : 'es'}` : ''}${shown !== agents.length ? ` \u00b7 ${shown} match` : ''}`;
      root.dataset.replay = rs ? 'true' : 'false';
      paintWaterfall(rs, statusOf, visible);
      paintMini(statusOf, visible);
    }

    /* ----- graph keyboard: arrow keys move to the nearest agent in that direction ----- */
    function focusNear(id, key) {
      const from = lay.pos.get(id); if (!from) return;
      const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
      let best = null, bestScore = Infinity;
      for (const el of gNodes.querySelectorAll('[data-node]')) {
        const q = lay.pos.get(el.dataset.node); if (!q || el.dataset.node === id) continue;
        const vx = q.x - from.x, vy = q.y - from.y;
        const along = vx * dx + vy * dy; if (along <= 1) continue;
        const across = Math.abs(vx * dy - vy * dx);
        const score = along + across * 2.5;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (!best) return;
      best.focus();
      const q = lay.pos.get(best.dataset.node), sz = size();
      const sx = q.x * view.k + view.x, sy = q.y * view.k + view.y;
      if (sx < 8 || sy < 8 || sx + W * view.k > sz.w - 8 || sy + H * view.k > sz.h - 8) { view.x = sz.w / 2 - (q.x + W / 2) * view.k; view.y = sz.h / 2 - (q.y + H / 2) * view.k; view.fitted = false; applyView(); }
    }

    /* ----- view switch ----- */
    function setView(v) {
      prefs.view = v === 'timeline' ? 'timeline' : 'graph'; savePrefs();
      root.dataset.view = prefs.view;
      for (const b of viewSwitch.querySelectorAll('[role=radio]')) { const on = b.dataset.slot === `explorer-view-${prefs.view}`; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
      if (prefs.view === 'graph') requestAnimationFrame(() => { if (view.fitted !== false) fit(); else applyView(); });
      paintGraph();
    }

    /* ----- waterfall (trace view) ----- */
    const treeTotals = (id) => { let tokens = 0, count = 0; const walk = (pid) => { for (const x of model.nodes.values()) if (!x.isMain && x.parent === pid) { tokens += x.tokens; count++; walk(x.id); } }; walk(id); return { tokens, count }; };
    function paintWaterfall(rs, statusOf, visible) {
      if (prefs.view !== 'timeline') { setChildren(wf); return; }
      const rows = lay.order.map((id) => model.nodes.get(id)).filter((n) => n && !n.isMain && visible(n.id));
      if (!rows.length) { setChildren(wf); return; }
      const now = rs ? replayT : Date.now();
      const startOf = (n) => n.startedAt || (statusOf(n) === 'queued' ? now : n.createdAt) || now;
      const endOf = (n) => { const st = statusOf(n); if (st === 'queued' || !n.startedAt && !n.durationMs) return startOf(n); const e = n.durationMs ? startOf(n) + n.durationMs : isActive(n.rawStatus) || st === 'running' ? now : startOf(n); return rs ? Math.min(e, now) : e; };
      const t0 = Math.min(...rows.map((n) => Math.min(n.createdAt || startOf(n), startOf(n))));
      const t1 = Math.max(t0 + 1000, ...rows.map((n) => (statusOf(n) === 'queued' ? now : endOf(n))), rs ? now : 0);
      const pct = (t) => `${(clamp((t - t0) / (t1 - t0), 0, 1) * 100).toFixed(2)}%`;
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => h('span', { class: 'sa-x-wf-tick', style: `left:${f * 100}%` }, f ? `+${dur((t1 - t0) * f) || '0s'}` : clock(t0)));
      const head = h('div', { class: 'sa-x-wf-row sa-x-wf-head', 'aria-hidden': 'true' }, h('span', { class: 'sa-x-wf-name' }, 'Agent'), h('span', { class: 'sa-x-wf-track' }, ...ticks), h('span', { class: 'sa-x-wf-meta' }, 'Time · tokens'));
      const list = h('ol', { class: 'sa-x-wf-list' });
      for (const n of rows) {
        const st = statusOf(n) || 'queued';
        const q = st === 'queued'; const s = q ? now : startOf(n), e = q ? now : endOf(n), c = n.createdAt && n.createdAt < s ? n.createdAt : s;
        const tt = treeTotals(n.id);
        const lvl = Math.max(0, n.depth - 1);
        const label = `${n.name}, ${(ctx.statusLabel || {})[st] || st}${n.durationMs ? `, ran ${dur(n.durationMs)}` : ''}${n.tokens ? `, ${tok(n.tokens)} tokens` : ''}${tt.count ? `, ${tt.count} below it using ${tok(tt.tokens)} tokens` : ''}.`;
        const row = h('button', { type: 'button', class: 'sa-x-wf-row', 'data-wf-row': n.id, 'data-status': st, 'data-selected': selected === n.id ? 'true' : null, 'data-dim': matches(n) ? null : 'true', 'aria-label': label, 'aria-pressed': String(selected === n.id),
          onclick: () => select(selected === n.id ? null : n.id) },
          h('span', { class: 'sa-x-wf-name', style: `padding-inline-start:${lvl * 0.875}rem` }, h('i', { class: 'sa-x-wf-dot', 'data-status': st }), h('span', { class: 'sa-x-wf-label' }, h('b', null, n.name), n.groupMode ? h('small', null, `${MODE_TEXT[n.groupMode] || 'Batch'}${n.winner ? ' · winner' : ''}`) : n.title ? h('small', null, short(n.title, 40)) : null)),
          h('span', { class: 'sa-x-wf-track' },
            c < s ? h('span', { class: 'sa-x-wf-wait', style: `left:${pct(c)};width:calc(${pct(s)} - ${pct(c)})`, title: `Waited ${dur(s - c)}` }) : null,
            q ? null : h('span', { class: 'sa-x-wf-bar', 'data-status': st, style: `left:${pct(s)};width:max(3px, calc(${pct(e)} - ${pct(s)}))` })),
          h('span', { class: 'sa-x-wf-meta' }, h('span', null, q ? 'Queued' : dur(e - s) || '—'), h('span', null, n.tokens ? `${tok(n.tokens)}` : ''), tt.count ? h('small', { title: `${tt.count} agent${tt.count === 1 ? '' : 's'} below it` }, tt.tokens ? `+${tok(tt.tokens)} below` : `+${tt.count} below`) : null));
        list.append(h('li', null, row));
      }
      if (rs) for (const tr of [head, ...list.children].map((x) => x.querySelector('.sa-x-wf-track'))) tr?.append(h('span', { class: 'sa-x-wf-cursor', 'aria-hidden': 'true', style: `left:${pct(now)}` }));
      list.addEventListener('keydown', (ev) => {
        const all = [...list.querySelectorAll('[data-wf-row]')]; const i = all.indexOf(document.activeElement); if (i < 0) return;
        const to = ev.key === 'ArrowDown' ? all[i + 1] : ev.key === 'ArrowUp' ? all[i - 1] : ev.key === 'Home' ? all[0] : ev.key === 'End' ? all[all.length - 1] : null;
        if (to) { ev.preventDefault(); to.focus(); }
        else if (ev.key === 'Escape' && selected) { ev.preventDefault(); ev.stopPropagation(); select(null); }
      });
      const focusedId = document.activeElement?.dataset?.wfRow;
      setChildren(wf, head, list);
      if (focusedId) wf.querySelector(`[data-wf-row="${CSS.escape(focusedId)}"]`)?.focus();
    }

    /* ----- minimap ----- */
    let miniGeom = null;
    function paintMini(statusOf, visible) {
      setChildren(miniStage);
      const b = lay.bounds; const bw = Math.max(1, b.x2 - b.x1), bh = Math.max(1, b.y2 - b.y1);
      const MW = 168, MH = 112, pad = 8;
      const k = Math.min((MW - pad * 2) / bw, (MH - pad * 2) / bh);
      miniGeom = { k, ox: pad + ((MW - pad * 2) - bw * k) / 2 - b.x1 * k, oy: pad + ((MH - pad * 2) - bh * k) / 2 - b.y1 * k };
      mini.setAttribute('viewBox', `0 0 ${MW} ${MH}`);
      for (const id of lay.order) {
        const n = model.nodes.get(id); const p = lay.pos.get(id);
        if (!n || !p || !visible(id)) continue;
        miniStage.append(sv('rect', { class: 'sa-x-mini-node', 'data-status': statusOf(n) || 'queued', 'data-selected': selected === id ? 'true' : null, x: (p.x * k + miniGeom.ox).toFixed(1), y: (p.y * k + miniGeom.oy).toFixed(1), width: Math.max(2, W * k).toFixed(1), height: Math.max(2, H * k).toFixed(1), rx: 1.5 }));
      }
      root.dataset.mini = model.nodes.size > 4 ? 'true' : 'false';
      paintMiniView();
    }
    function paintMiniView() {
      if (!miniGeom) return;
      const sz = size(), g = miniGeom;
      miniView.setAttribute('x', ((-view.x / view.k) * g.k + g.ox).toFixed(1));
      miniView.setAttribute('y', ((-view.y / view.k) * g.k + g.oy).toFixed(1));
      miniView.setAttribute('width', Math.max(4, (sz.w / view.k) * g.k).toFixed(1));
      miniView.setAttribute('height', Math.max(4, (sz.h / view.k) * g.k).toFixed(1));
    }
    const miniJump = (e) => {
      if (!miniGeom) return;
      const r = mini.getBoundingClientRect(); const sc = 168 / r.width;
      const gx = ((e.clientX - r.left) * sc - miniGeom.ox) / miniGeom.k, gy = ((e.clientY - r.top) * sc - miniGeom.oy) / miniGeom.k;
      const sz = size(); view.x = sz.w / 2 - gx * view.k; view.y = sz.h / 2 - gy * view.k; view.fitted = false; applyView();
    };
    mini.addEventListener('pointerdown', (e) => { e.preventDefault(); mini.setPointerCapture?.(e.pointerId); miniJump(e); mini.dataset.dragging = 'true'; });
    mini.addEventListener('pointermove', (e) => { if (mini.dataset.dragging) miniJump(e); });
    mini.addEventListener('pointerup', () => { delete mini.dataset.dragging; });
    mini.addEventListener('pointercancel', () => { delete mini.dataset.dragging; });

    /* ----- timeline ----- */
    const span = () => {
      const ev = model.events;
      if (!ev.length) return null;
      const t0 = num(ev[0].at), t1 = Math.max(num(ev[ev.length - 1].at), t0 + 1);
      return { t0, t1 };
    };
    const fracToT = (f) => { const s = span(); return s ? s.t0 + (s.t1 - s.t0) * clamp(f, 0, 1) : null; };
    function setReplay(t) {
      const s = span();
      replayT = t == null || !s || t >= s.t1 ? null : Math.max(s.t0, t);
      liveBtn.setAttribute('aria-pressed', String(replayT == null));
      if (s) scrub.value = String(replayT == null ? 1000 : Math.round(((replayT - s.t0) / (s.t1 - s.t0)) * 1000));
      paintTimeline(); paintGraph(); paintInspector();
    }
    function paintTimeline() {
      const s = span();
      timeline.hidden = !s;
      if (!s) return;
      const t = replayT == null ? s.t1 : replayT;
      const upto = model.events.filter((e) => num(e.at) <= t);
      tLabel.textContent = replayT == null ? `Live \u00b7 ${model.events.length} event${model.events.length === 1 ? '' : 's'} from ${clock(s.t0)} to ${clock(s.t1)}` : `Replay at ${clock(t)} (+${dur(t - s.t0) || '0s'}) \u00b7 event ${upto.length} of ${model.events.length}`;
      const last = upto.slice(-4).reverse();
      setChildren(ticker, ...last.map((e) => {
        const n = model.nodes.get(String(e.id));
        const to = e.to ? model.nodes.get(String(e.to)) : null;
        return h('li', { 'data-kind': e.kind }, h('time', null, clock(e.at)), h('span', null, `${n?.name || e.name || e.id} ${EVENT_TEXT[e.kind] || e.kind.replace(/_/g, ' ')}${to ? ` ${to.name}` : ''}`));
      }));
    }
    function startPlay() {
      const s = span(); if (!s) return;
      if (replayT == null) setReplay(s.t0);
      setChildren(playBtn, icon('pause')); playBtn.setAttribute('aria-label', 'Pause replay');
      let prev = performance.now();
      const tick = (now) => {
        if (!playing || destroyed) return;
        const dt = now - prev; prev = now;
        const next = (replayT ?? s.t0) + dt * speed;
        if (next >= s.t1) { stopPlay(); setReplay(null); return; }
        setReplay(next);
        playing = requestAnimationFrame(tick);
      };
      playing = requestAnimationFrame(tick);
    }
    function stopPlay() {
      if (playing) cancelAnimationFrame(playing);
      playing = 0;
      setChildren(playBtn, icon('play')); playBtn.setAttribute('aria-label', 'Play replay');
    }

    /* ----- inspector ----- */
    function select(id) {
      selected = id && model.nodes.has(id) ? id : null;
      root.dataset.selected = selected || '';
      paintGraph(); paintInspector();
      if (selected) centerOn(selected);
    }
    const kv = (k, v) => (v === '' || v == null ? null : h('div', { class: 'sa-x-kv' }, h('dt', null, k), h('dd', null, v)));
    const btn = (label, ic, onclick, o = {}) => h('button', { type: 'button', class: `btn ${o.primary ? 'btn-default' : 'btn-outline'} btn-sm${o.danger ? ' sa-danger' : ''}`, 'data-action': o.slot || null, disabled: o.disabled || false, onclick }, icon(ic), label);
    function paintInspector() {
      const n = selected ? model.nodes.get(selected) : null;
      if (!n) {
        setChildren(inspector, h('p', { class: 'field-hint sa-x-hint' }, icon('mouse-pointer-click'), 'Click an agent for its details and controls. Double-click opens it.'));
        return;
      }
      if (n.isMain) { paintMainInspector(); return; }
      const r = ctx.get(n.id) || n.rec;
      const st = n.status;
      const active = isActive(n.rawStatus);
      const deps = n.dependsOn.map((d) => model.nodes.get(d)?.name || d).join(', ');
      const waiters = [...model.nodes.values()].filter((x) => x.dependsOn?.includes(n.id)).map((x) => x.name).join(', ');
      const gr = n.groupId ? model.groups.find((x) => x.id === n.groupId) : null;
      const parent = n.parent && n.parent !== MAIN ? model.nodes.get(n.parent) : null;
      const kids = [...model.nodes.values()].filter((x) => x.parent === n.id).length;
      const msgOut = model.msg.filter((m) => m.from === n.id).reduce((s, m) => s + m.count, 0);
      const msgIn = model.msg.filter((m) => m.to === n.id).reduce((s, m) => s + m.count, 0);
      const head = h('div', { class: 'sa-x-ihead' },
        h('span', { class: 'sa-x-idot', 'data-status': st, 'aria-hidden': 'true' }),
        h('div', { class: 'sa-x-ititle' }, h('h4', null, n.name), n.title ? h('p', null, n.title) : null),
        ctx.statusChip ? ctx.statusChip(n.paused && active ? 'queued' : n.rawStatus) : null);
      if (n.paused) head.append(h('span', { class: 'chip', 'data-slot': 'explorer-paused' }, 'Paused'));
      const facts = h('dl', { class: 'sa-x-facts' },
        kv('Level', ctx.levelText ? ctx.levelText(n.depth, ctx.maxDepth?.()) : `${n.depth}`),
        kv('Started by', parent ? parent.name : 'Main agent'),
        kv('Model', n.model),
        kv('Tokens', n.tokens ? `${tok(n.tokens)}${n.budget ? ` of ${tok(n.budget)}` : ''}` : ''),
        kv('Steps', n.steps ? `${n.steps}${n.toolCalls ? ` \u00b7 ${n.toolCalls} tool call${n.toolCalls === 1 ? '' : 's'}` : ''}` : ''),
        kv('Time', dur(n.durationMs)),
        kv('Batch', gr ? `${MODE_TEXT[gr.mode] || 'Batch'}, ${n.groupMode === 'pipeline' ? `step ${n.groupIndex + 1} of ${gr.members.length}` : `${gr.members.length} agents`}${n.winner ? ' \u00b7 winner' : gr.winner && gr.mode === 'race' ? ' \u00b7 lost' : ''}` : ''),
        kv('Waits for', deps),
        kv('Waited on by', waiters),
        kv('Context', n.contextMode === 'fork' ? `Fork of ${n.contextSource || 'the chat'}` : n.contextMode ? n.contextMode : ''),
        kv('Report', n.handoff ? 'Becomes its parent\u2019s answer (handoff)' : ''),
        kv('Agents below', kids ? (() => { const tt = treeTotals(n.id); return `${kids} direct · ${tt.count} in all · ${tok(tt.tokens + n.tokens)} tok with them`; })() : ''),
        kv('Messages', msgOut || msgIn ? `${msgOut} sent \u00b7 ${msgIn} received` : ''));
      const err = n.error ? h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, short(redactSecrets(n.error, 400), 400))) : null;
      const task = n.task ? h('p', { class: 'sa-x-task' }, short(n.task, 400)) : null;
      // Message box (steer while it runs, continue after).
      const ta = h('textarea', { class: 'textarea', rows: '2', maxlength: '4000', 'aria-label': `Message ${n.name}`, placeholder: active ? 'Steer it: reaches it before its next step' : 'Continue: it picks up where it left off', 'data-slot': 'explorer-message' });
      const send = btn(active ? 'Steer' : 'Send', 'send', async () => {
        const t = ta.value.trim(); if (!t) { ta.setAttribute('aria-invalid', 'true'); ta.focus(); return; }
        send.disabled = true; const ok = await ctx.message(n.id, t); send.disabled = false; if (ok) ta.value = '';
      }, { slot: 'message' });
      const tree = (() => { const out = []; const walk = (id) => { for (const x of model.nodes.values()) if (x.parent === id) { out.push(x); walk(x.id); } }; walk(n.id); return out; })();
      const treeActive = tree.some((x) => isActive(x.rawStatus));
      const can = (f) => (ctx.can ? ctx.can(f) : true);
      const actions = h('div', { class: 'sa-x-actions', role: 'toolbar', 'aria-label': `Control ${n.name}` },
        btn('Open', 'maximize-2', () => ctx.open(n.id), { primary: true, slot: 'open' }),
        ctx.openChat ? btn('Chat', 'message-square', () => ctx.openChat(n.id), { slot: 'chat' }) : null,
        btn('Graph', 'git-fork', () => ctx.open(n.id, 'graph'), { slot: 'graph' }),
        gr && gr.members.length > 1 ? btn('Compare batch', 'columns', () => compareDialog(gr), { slot: 'compare' }) : null,
        active ? btn('Stop', 'square', () => ctx.stop(n.id), { slot: 'stop', danger: true }) : null,
        active || treeActive ? (tree.length ? btn(`Stop tree (${tree.length + 1})`, 'square-stack', () => confirmDialog({ title: `Stop ${n.name} and the ${tree.length} below it?`, description: 'Their work so far is kept.', confirmLabel: 'Stop all', destructive: true, onConfirm: async () => { const res = await ctx.act('stopTree', { id: n.id }); if (res) toast(`${(res.stopped || []).length || tree.length + 1} stopped.`, { type: 'success' }); } }), { slot: 'stop-tree', danger: true }) : null) : null,
        active && !n.paused && can('subagentTeam') ? btn('Pause', 'pause', () => ctx.act('pause', { id: n.id }, 'Paused.'), { slot: 'pause' }) : null,
        n.paused && can('subagentTeam') ? btn('Resume', 'play', () => ctx.act('resume', { id: n.id }, 'Resumed.'), { slot: 'resume' }) : null,
        !active ? btn('Retry', 'rotate-ccw', () => ctx.retry(n.id), { slot: 'retry' }) : null,
        !active && ctx.rerun && can('subagentQueue') ? btn('Run again\u2026', 'refresh-cw', () => ctx.rerun(r), { slot: 'rerun' }) : null,
        !active && n.parent === MAIN ? btn('Move to chat\u2026', 'arrow-right-left', () => moveDialog(ctx, r), { slot: 'move' }) : null,
        !active ? btn('Delete', 'trash-2', () => confirmDialog({ title: `Delete ${n.name}?`, description: 'Its record, chat and log are removed. This cannot be undone.', confirmLabel: 'Delete', destructive: true, onConfirm: async () => { const ok = await ctx.remove(n.id); if (ok) select(null); } }), { slot: 'delete', danger: true }) : null);
      setChildren(inspector, head, task, err, facts,
        replayT != null ? h('p', { class: 'settings-note', 'data-type': 'info' }, icon('history'), h('span', null, `Replaying: at this point it was ${(ctx.statusLabel || {})[stateAt(model, replayT).st.get(n.id)] || 'not started'}. Controls act on it now.`)) : null,
        actions, h('div', { class: 'sa-x-msg' }, ta, h('div', { class: 'row-actions' }, send)));
    }
    function paintMainInspector() {
      const agents = [...model.nodes.values()].filter((n) => !n.isMain);
      const counts = {};
      for (const n of agents) counts[n.rawStatus] = (counts[n.rawStatus] || 0) + 1;
      setChildren(inspector,
        h('div', { class: 'sa-x-ihead' }, h('span', { class: 'sa-x-idot', 'data-status': model.nodes.get(MAIN).status, 'aria-hidden': 'true' }), h('div', { class: 'sa-x-ititle' }, h('h4', null, 'Main agent'), h('p', null, 'Every agent of this chat'))),
        h('dl', { class: 'sa-x-facts' }, kv('Agents', String(agents.length)), ...Object.entries(counts).map(([s, c]) => kv((ctx.statusLabel || {})[s] || s, String(c))), kv('Batches', model.groups.length ? String(model.groups.length) : ''),
          kv('Tokens', agents.length ? tok(agents.reduce((s, n) => s + n.tokens, 0)) : ''),
          kv('Wall time', (() => { const ss = agents.filter((n) => n.startedAt); if (!ss.length) return ''; const a = Math.min(...ss.map((n) => n.startedAt)), b = Math.max(...ss.map((n) => n.startedAt + n.durationMs)); return dur(b - a); })()),
          kv('Agent time', dur(agents.reduce((s, n) => s + n.durationMs, 0)))),
        h('div', { class: 'sa-x-actions', role: 'toolbar', 'aria-label': 'Control every agent' },
          btn('New batch', 'layers', () => newBatch.click(), { primary: true, slot: 'batch' }),
          btn('Stop all', 'square', () => runBulk('stop'), { slot: 'bulk-stop', danger: true, disabled: !agents.some((n) => isActive(n.rawStatus)) }),
          btn('Pause all', 'pause', () => runBulk('pause'), { slot: 'bulk-pause', disabled: !agents.some((n) => isActive(n.rawStatus) && !n.paused) }),
          btn('Resume all', 'play', () => runBulk('resume'), { slot: 'bulk-resume', disabled: !agents.some((n) => n.paused) }),
          btn('Retry ended', 'rotate-ccw', () => runBulk('retry'), { slot: 'bulk-retry', disabled: !agents.some((n) => !isActive(n.rawStatus)) })));
    }
    const BULK_TEXT = { stop: ['Stop every running agent of this chat?', 'Stop all', 'stopped'], stopTree: ['Stop every running agent and the agents below them?', 'Stop all', 'stopped'], pause: ['Pause every running agent?', 'Pause all', 'paused'], resume: ['Resume every paused agent?', 'Resume all', 'resumed'], retry: ['Run every ended agent again?', 'Retry all', 'running again'], delete: ['Delete every ended agent of this chat?', 'Delete all', 'deleted'] };
    // Side-by-side results of one batch (best-of-N, race, review): pick the answer you want without opening each agent.
    function compareDialog(gr) {
      const members = gr.members.map((id) => model.nodes.get(id)).filter(Boolean).sort((a, b) => a.groupIndex - b.groupIndex);
      const col = (n) => {
        const r = ctx.get(n.id) || n.rec || {};
        const text = typeof r.result === 'string' && r.result.trim() ? r.result : n.error ? redactSecrets(n.error, 1200) : isActive(n.rawStatus) ? 'Still working…' : 'No report.';
        const role = gr.mode === 'review' ? REVIEW_ROLE[n.groupIndex] || '' : gr.mode === 'pipeline' ? `Step ${n.groupIndex + 1}` : '';
        return h('article', { class: 'sa-x-cmp-col', 'data-slot': 'compare-col', 'data-status': n.rawStatus, 'data-winner': n.winner ? 'true' : null },
          h('header', null, h('span', { class: 'sa-x-idot', 'data-status': n.status, 'aria-hidden': 'true' }), h('h4', null, n.name), role ? h('span', { class: 'chip' }, role) : null, n.winner ? h('span', { class: 'chip', 'data-tone': 'success' }, gr.mode === 'review' ? 'Approved' : 'Winner') : null),
          h('p', { class: 'sa-x-cmp-stats' }, [ctx.statusLabel?.[n.status] || n.status, dur(n.durationMs), n.tokens ? `${tok(n.tokens)} tok` : '', n.model].filter(Boolean).join(' · ')),
          h('div', { class: 'sa-x-cmp-text', tabindex: '0', 'aria-label': `Report of ${n.name}` }, short(text, 4000)),
          h('div', { class: 'row-actions' }, btn('Open', 'maximize-2', () => { dlg.close(); ctx.open(n.id); }, { slot: 'compare-open' })));
      };
      const dlg = openDialog({ title: `Compare: ${MODE_TEXT[gr.mode] || 'Batch'} of ${members.length}`, description: gr.mode === 'race' ? 'The first to finish won; the others were stopped.' : gr.mode === 'review' ? 'The worker’s draft and the reviewer’s verdict.' : 'Each agent’s report, side by side.', size: 'lg', align: 'top',
        body: h('div', { class: 'sa-x-cmp', 'data-slot': 'compare-dialog', style: `--cols:${Math.min(3, members.length)}` }, ...members.map(col)) });
      dlg.panel.classList.add('sa-x-cmp-dialog');
    }
    function runBulk(op) {
      const [title, label, done] = BULK_TEXT[op];
      const go = async () => {
        const res = await ctx.act('bulk', { op, sessionKey: chat });
        if (!res) return;
        const failed = (res.results || []).filter((x) => !x.ok);
        toast(`${res.ok || 0} of ${res.total || 0} ${done}.${failed.length ? ` ${failed.length} could not: ${short(failed[0].error, 80)}` : ''}`, { type: failed.length && !res.ok ? 'error' : 'success' });
        if (op === 'delete') select(null);
        refreshGraph(true);
      };
      if (op === 'pause' || op === 'resume') { go(); return; }
      confirmDialog({ title, description: op === 'delete' ? 'Their records, chats and logs are removed. This cannot be undone.' : 'You can control each agent on its own afterwards.', confirmLabel: label, destructive: op === 'delete' || op.startsWith('stop'), onConfirm: go });
    }

    /* ----- data refresh ----- */
    function refreshGraph(now) {
      clearTimeout(graphTimer);
      graphTimer = setTimeout(() => { if (!destroyed && root.isConnected) ctx.loadGraph().catch(() => {}); }, now ? 0 : 1200);
    }
    function update() {
      if (destroyed) return;
      const next = buildModel(ctx);
      const sig = JSON.stringify([[...next.nodes.values()].map((n) => [n.id, n.parent, n.status, n.tokens, n.steps, n.title, n.winner, n.dependsOn]), next.dep.length, next.msg.map((m) => m.count), next.groups.map((g) => [g.id, g.winner]), next.events.length]);
      if (sig === lastSig) return;
      // The engine's edges and groups change when an agent starts or ends: read them again.
      const shape = JSON.stringify([...next.nodes.values()].map((n) => [n.id, n.rawStatus]));
      if (graphSig && shape !== graphSig) refreshGraph(false);
      graphSig = shape;
      lastSig = sig;
      const grew = next.nodes.size !== model.nodes.size;
      model = next;
      lay = layout(model, prefs.orient);
      if (selected && !model.nodes.has(selected)) selected = null;
      paintGraph(); paintTimeline(); paintInspector();
      if (grew && view.fitted) fit();
    }
    function ready() {
      lastSig = '';
      graphSig = JSON.stringify([...model.nodes.values()].map((n) => [n.id, n.rawStatus]));
      applyView();
      paintGraph(); paintTimeline(); paintInspector();
      requestAnimationFrame(() => { if (!view.fitted && view.k === 1 && view.x === 24) fit(); else if (view.fitted) fit(); });
      refreshGraph(true);
    }
    function destroy() { destroyed = true; stopPlay(); clearTimeout(graphTimer); }
    const api = { root, update, ready, destroy, select, fit, setReplay, get view() { return { ...view }; }, get selected() { return selected; }, get model() { return model; } };
    if (typeof window !== 'undefined') window.__explorer = api;
    return api;
  }

  /* ---------- Move to another chat ---------- */
  async function moveDialog(ctx, r) {
    let chats = [];
    try { chats = ((await ctx.call('chats', {}))?.chats || []).filter((c) => c && c.sessionKey && c.sessionKey !== (r.rootSessionKey || r.parentSessionKey)); } catch { /* the list is a convenience */ }
    let dialog = null;
    const sel = h('select', { class: 'select', id: `sa-move-${uid(4)}`, 'data-slot': 'move-target' },
      h('option', { value: '' }, chats.length ? 'Choose a chat' : 'No other chats'), ...chats.map((c) => h('option', { value: c.sessionKey }, c.title || c.sessionKey)));
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const go = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'move-confirm', onclick: async () => {
      if (!sel.value) { err.textContent = 'Choose a chat.'; err.hidden = false; sel.focus(); return; }
      go.disabled = true;
      const res = await ctx.act('moveToChat', { id: r.id, targetSessionKey: sel.value }, `Moved ${r.name} to \u201c${sel.selectedOptions[0]?.textContent || 'the chat'}\u201d.`);
      go.disabled = false;
      if (res?.subagent) { ctx.upsert(res.subagent); ctx.notify?.(); dialog?.close(); ctx.onMoved?.(res.subagent); }
    } }, icon('arrow-right-left'), 'Move');
    dialog = openDialog({ title: `Move ${r.name} to another chat`, description: 'It and every agent below it move. Its chat, memory and files stay with it; only where it is listed changes.', size: 'sm',
      body: h('div', { class: 'field' }, h('label', { class: 'label', for: sel.id }, 'Chat'), sel, err),
      footer: h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Cancel'), go) });
    return dialog;
  }

  /* ---------- Batch dialog (spawnBatch) ---------- */
  function batchDialog(ctx, preset = {}) {
    const s = ctx.settings?.() || {};
    const room = num(s.maxParallel, 3) + num(s.maxQueue, 20);
    let mode = preset.mode || 'parallel';
    let dialog = null;
    const rows = [];
    const list = h('ol', { class: 'sa-batch-list', 'data-slot': 'batch-tasks', 'data-mode': mode });
    const modeHelp = h('p', { class: 'field-hint', 'data-slot': 'batch-mode-help' }, MODE_HELP[mode]);
    const seg = h('div', { class: 'segmented sa-batch-modes', role: 'radiogroup', 'aria-label': 'How they run' },
      ...Object.keys(MODE_TEXT).map((m) => h('button', { type: 'button', role: 'radio', class: 'segmented-item', 'data-mode': m, 'aria-checked': String(m === mode), onclick: () => setMode(m) }, icon(m === 'pipeline' ? 'workflow' : m === 'race' ? 'zap' : m === 'review' ? 'shield-check' : 'layers'), MODE_TEXT[m])));
    const rounds = h('select', { class: 'select', id: `sa-batch-rounds-${uid(4)}`, 'data-slot': 'batch-rounds', 'aria-label': 'Review rounds' }, ...[1, 2, 3, 4, 5].map((n) => h('option', { value: String(n), selected: n === 3 || undefined }, `${n} round${n === 1 ? '' : 's'}`)));
    const roundsField = h('div', { class: 'field', 'data-slot': 'batch-rounds-field', hidden: true }, h('label', { class: 'label', for: rounds.id }, 'Review rounds'), rounds, h('p', { class: 'field-hint' }, 'The most times the reviewer sends the work back before you get the last version.'));
    function setMode(m) {
      mode = m; list.dataset.mode = m; modeHelp.textContent = MODE_HELP[m];
      roundsField.hidden = m !== 'review';
      if (m === 'review') { while (rows.length < 2) addRow(''); while (rows.length > 2) { const r = rows.pop(); r.li.remove(); } }
      for (const b of seg.querySelectorAll('[role="radio"]')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
      renumber();
    }
    const addBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'batch-add', onclick: () => { addRow(''); rows[rows.length - 1]?.ta.focus(); } }, icon('plus'), 'Add agent');
    function renumber() {
      rows.forEach((r, i) => {
        r.num.textContent = mode === 'pipeline' ? `Step ${i + 1}` : mode === 'review' ? REVIEW_ROLE[i] || `Agent ${i + 1}` : `Agent ${i + 1}`;
        r.ta.placeholder = mode === 'review' ? (i === 0 ? 'What the worker makes' : 'What the reviewer checks it for') : 'What this agent does';
        r.ta.setAttribute('aria-label', `${r.num.textContent}: brief`);
        r.rm.disabled = rows.length <= 1 || mode === 'review';
        r.up.disabled = i === 0; r.down.disabled = i === rows.length - 1;
        r.up.hidden = r.down.hidden = mode !== 'pipeline';
      });
      addBtn.disabled = rows.length >= Math.min(MAX_BATCH, room) || mode === 'review';
      count.textContent = `${rows.length} of at most ${Math.min(MAX_BATCH, room)}`;
    }
    function move(row, d) {
      const i = rows.indexOf(row), j = i + d;
      if (j < 0 || j >= rows.length) return;
      rows.splice(i, 1); rows.splice(j, 0, row);
      setChildren(list, ...rows.map((r) => r.li)); renumber(); row.ta.focus();
    }
    function addRow(text = '', name = '') {
      if (rows.length >= Math.min(MAX_BATCH, room)) return;
      const row = {};
      row.num = h('span', { class: 'sa-batch-num' });
      row.ta = h('textarea', { class: 'textarea', rows: '2', maxlength: '8000', placeholder: 'What this agent does', 'data-slot': 'batch-task', oninput: () => { row.ta.removeAttribute('aria-invalid'); err.hidden = true; } });
      row.ta.value = text;
      row.name = h('input', { class: 'input sa-batch-name', type: 'text', maxlength: '60', placeholder: 'Name (optional)', 'aria-label': 'Name (optional)', 'data-slot': 'batch-name', value: name });
      row.rm = iconButton('Remove', icon('x'), () => { rows.splice(rows.indexOf(row), 1); row.li.remove(); renumber(); });
      row.up = iconButton('Move up', icon('arrow-up'), () => move(row, -1));
      row.down = iconButton('Move down', icon('arrow-down'), () => move(row, 1));
      row.li = h('li', { class: 'sa-batch-row' }, h('div', { class: 'sa-batch-rowhead' }, row.num, row.name, h('span', { class: 'sa-spacer' }), row.up, row.down, row.rm), row.ta);
      rows.push(row); list.append(row.li); renumber();
    }
    const count = h('span', { class: 'field-hint', 'data-slot': 'batch-count' });
    const shared = h('textarea', { class: 'textarea', id: `sa-batch-shared-${uid(4)}`, rows: '2', maxlength: '8000', placeholder: 'Optional: the goal every agent works toward', 'data-slot': 'batch-shared' });
    shared.value = preset.task || '';
    const baseName = h('input', { class: 'input', id: `sa-batch-base-${uid(4)}`, type: 'text', maxlength: '40', placeholder: 'e.g. research', 'data-slot': 'batch-base-name' });
    const model = h('input', { class: 'input', id: `sa-batch-model-${uid(4)}`, type: 'text', maxlength: '120', placeholder: 'Same as the chat', 'data-slot': 'batch-model' });
    const ctxSel = h('select', { class: 'select', id: `sa-batch-ctx-${uid(4)}`, 'data-slot': 'batch-context' }, h('option', { value: 'fresh' }, 'Fresh: only its brief'), h('option', { value: 'fork' }, 'Fork: this chat so far, then its brief'));
    const budget = h('input', { class: 'input', id: `sa-batch-budget-${uid(4)}`, type: 'number', inputmode: 'numeric', min: '1000', max: '5000000', step: '1000', placeholder: 'Default', 'data-slot': 'batch-budget' });
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true, 'data-slot': 'batch-error' });
    const fld = (label, input, hint) => h('div', { class: 'field' }, h('label', { class: 'label', for: input.id }, label), input, hint ? h('p', { class: 'field-hint' }, hint) : null);
    const start = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'batch-start', onclick: async () => {
      err.hidden = true;
      const tasks = [];
      for (const r of rows) {
        const t = r.ta.value.trim();
        if (!t) { r.ta.setAttribute('aria-invalid', 'true'); r.ta.focus(); err.textContent = 'Every agent needs a brief (or remove the empty one).'; err.hidden = false; return; }
        const nm = r.name.value.trim();
        tasks.push(nm ? { task: t, name: nm } : t);
      }
      if (mode === 'review' && tasks.length !== 2) { err.textContent = 'Review takes a worker and a reviewer.'; err.hidden = false; return; }
      if (mode !== 'pipeline' && tasks.length < 2) { err.textContent = `${MODE_TEXT[mode]} needs at least two agents.`; err.hidden = false; return; }
      if (tasks.length > room) { err.textContent = `${tasks.length} won't fit: ${s.maxParallel} can run and ${s.maxQueue} can wait.`; err.hidden = false; return; }
      const b = budget.value.trim();
      if (b && (!Number.isInteger(Number(b)) || Number(b) < 1000 || Number(b) > 5000000)) { budget.setAttribute('aria-invalid', 'true'); err.textContent = 'Token budget: a whole number from 1,000 to 5,000,000.'; err.hidden = false; budget.focus(); return; }
      const req = { tasks, mode };
      if (mode === 'review') req.rounds = Number(rounds.value) || 3;
      if (ctx.chat) req.parentSessionKey = ctx.chat;
      if (shared.value.trim()) req.task = shared.value.trim();
      if (baseName.value.trim()) req.name = baseName.value.trim();
      if (model.value.trim()) req.model = model.value.trim();
      if (b) req.tokenBudget = Number(b);
      if (ctxSel.value === 'fork' && ctx.chat) { req.context = 'fork'; req.forkSession = ctx.chat; }
      start.disabled = true;
      let res;
      try { res = await ctx.call('spawnBatch', req); } catch (e) { err.textContent = redactSecrets(e?.message || String(e), 300); err.hidden = false; start.disabled = false; return; }
      start.disabled = false;
      for (const r of res?.subagents || []) ctx.upsert(r);
      ctx.notify?.();
      toast(`${MODE_TEXT[res?.mode || mode]} batch started: ${(res?.subagents || []).length} agent${(res?.subagents || []).length === 1 ? '' : 's'}.`, { type: 'success' });
      dialog?.close();
      ctx.onStarted?.(res);
      window.__batchLast = req;
    } }, icon('play'), 'Start');
    for (const t of preset.tasks && preset.tasks.length ? preset.tasks : ['', '']) addRow(typeof t === 'string' ? t : t.task || '', typeof t === 'string' ? '' : t.name || '');
    setMode(mode);
    const body = h('div', { class: 'sa-batch', 'data-slot': 'batch-dialog' },
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'How they run'), seg, modeHelp),
      roundsField,
      fld('Shared goal', shared, 'Given to every agent above its own brief.'),
      h('div', { class: 'field' }, h('div', { class: 'sa-batch-listhead' }, h('span', { class: 'label' }, mode === 'pipeline' ? 'Steps' : 'Agents'), count), list, h('div', { class: 'row-actions' }, addBtn)),
      h('details', { class: 'sa-batch-more' }, h('summary', null, 'More options'),
        h('div', { class: 'sa-batch-grid' }, fld('Name prefix', baseName, 'Agents are named prefix-1, prefix-2\u2026'), fld('Model', model), fld('Context', ctxSel, 'Fork copies this chat so far into each agent.'), fld('Token budget each', budget))),
      err);
    dialog = openDialog({ title: 'New batch of sub-agents', description: 'Start several agents in one go: side by side, as a pipeline, as a race, or as a worker with a reviewer.', size: 'lg', align: 'top', body,
      footer: h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Cancel'), start) });
    queueMicrotask(() => rows[0]?.ta.focus());
    return dialog;
  }

  /* ---------- Fork into sub-agent (from a chat message) ---------- */
  function forkDialog(ctx, { sessionKey, userTurns, label = '' }) {
    let dialog = null;
    const ta = h('textarea', { class: 'textarea', id: `sa-fork-task-${uid(4)}`, rows: '4', maxlength: '8000', placeholder: 'What should it do with this conversation?', 'data-slot': 'fork-task', oninput: () => { ta.removeAttribute('aria-invalid'); err.hidden = true; } });
    const name = h('input', { class: 'input', id: `sa-fork-name-${uid(4)}`, type: 'text', maxlength: '60', placeholder: 'e.g. reviewer', 'data-slot': 'fork-name' });
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true, 'data-slot': 'fork-error' });
    const go = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'fork-start', onclick: async () => {
      const task = ta.value.trim();
      if (!task) { ta.setAttribute('aria-invalid', 'true'); err.textContent = 'Say what it should do.'; err.hidden = false; ta.focus(); return; }
      const req = { task, context: 'fork', forkSession: sessionKey, parentSessionKey: sessionKey };
      if (userTurns > 0) req.forkUserTurns = userTurns;
      if (name.value.trim()) req.name = name.value.trim();
      go.disabled = true;
      let res;
      try { res = await ctx.call('spawn', req); } catch (e) { err.textContent = redactSecrets(e?.message || String(e), 300); err.hidden = false; go.disabled = false; return; }
      go.disabled = false;
      if (res?.subagent) ctx.upsert(res.subagent);
      ctx.notify?.();
      window.__forkLast = req;
      dialog?.close();
      toast(`Forked into ${res?.subagent?.name || 'a sub-agent'}.`, { type: 'success' });
      if (res?.subagent?.id) ctx.openAgent?.(res.subagent.id);
    } }, icon('git-branch-plus'), 'Fork');
    dialog = openDialog({ title: 'Fork into sub-agent', description: `A new sub-agent starts with this chat ${userTurns > 0 ? `up to ${label || 'this message'} (${userTurns} message${userTurns === 1 ? '' : 's'} from you)` : 'so far'} as its context, then works on its own. This chat goes on unchanged.`, size: 'sm',
      body: h('div', { class: 'sa-fork', 'data-slot': 'fork-dialog' }, h('div', { class: 'field' }, h('label', { class: 'label', for: ta.id }, 'Task'), ta), h('div', { class: 'field' }, h('label', { class: 'label', for: name.id }, 'Name'), name, h('p', { class: 'field-hint' }, 'Optional.')), err),
      footer: h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Cancel'), go) });
    queueMicrotask(() => ta.focus());
    return dialog;
  }

  return { mount, batchDialog, forkDialog, moveDialog, _internal: { buildModel, layout, stateAt, edgePath, MAIN } };
})();
if (typeof window !== 'undefined') window.__subagentExplorer = SubagentExplorer;
