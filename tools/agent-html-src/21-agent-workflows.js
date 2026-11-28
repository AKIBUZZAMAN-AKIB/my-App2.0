/* ==========================================================================
   Workflows (Agents ▸ Workflows): a visual graph of sub-agents whose results
   flow to each other on their own.

   The engine (subagents/workflows.rs) stores workflows as nodes + edges and
   runs them as a dataflow graph; the agent builds them with its `workflow`
   tool. This screen shows the same graph and lets the user edit and run it:
   - a list of workflows with their last run;
   - a pan / pinch / wheel-zoom SVG canvas (React Flow style): nodes you drag,
     a handle on each node's right side you drag onto another node to connect
     them, curved edges with their condition as a label, loop edges dashed;
   - an inspector for the selected node (kind, label, task or template,
     routes, join, max runs, retries, tools, model) or edge (condition, value,
     loop);
   - Run with an input, Stop, and live status per node and edge while it runs
     (`workflow.run` events), with each step's output a tap away; earlier runs
     can be replayed on the graph from the run picker.
   ========================================================================== */
const AgentWorkflows = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const NODE_W = 196;
  const NODE_H = 64;
  const MIN_K = 0.25;
  const MAX_K = 2.2;
  const KINDS = [
    ['agent', 'Agent', 'A sub-agent with a task. Upstream results are attached automatically.'],
    ['router', 'Router', 'An agent that picks the next branch: it ends with ROUTE: <label>.'],
    ['merge', 'Merge', 'Joins every incoming result into one text. No model call.'],
    ['transform', 'Transform', 'Fills a text template from the inputs. No model call.'],
    ['output', 'Output', 'The workflow\'s final result (a template, or the input as is).'],
  ];
  const CONDS = [
    ['success', 'On success'], ['always', 'Always'], ['failed', 'On failure'], ['contains', 'Contains'],
    ['not_contains', 'Does not contain'], ['equals', 'Equals'], ['regex', 'Matches regex'], ['route', 'Router picks'], ['default', 'Otherwise'],
  ];
  const NEEDS_VALUE = new Set(['contains', 'not_contains', 'equals', 'regex', 'route']);
  const STATUS = { pending: 'Waiting', running: 'Running', finished: 'Done', error: 'Failed', skipped: 'Skipped', cancelled: 'Stopped', interrupted: 'Interrupted' };

  const EXTRA_ICONS = {
    'wf-play': '<path d="M6 3l14 9-14 9V3z"/>',
    'wf-flow': '<rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><path d="M6.5 9v3a3 3 0 0 0 3 3h4.5"/>',
    'wf-zoom-in': '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>',
    'wf-zoom-out': '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/>',
    'wf-fit': '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/>',
    'wf-layout': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    'wf-save': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  };
  if (typeof ICONS !== 'undefined') for (const [k, v] of Object.entries(EXTRA_ICONS)) if (!ICONS[k]) ICONS[k] = v;

  const sv = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const short = (s, n) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const kit = () => (typeof nativeKit === 'function' ? nativeKit() : (typeof window !== 'undefined' ? window.NativeKit : undefined));
  const parse = (r) => {
    if (r == null) return {};
    if (typeof r === 'string') { try { return JSON.parse(r); } catch { return {}; } }
    if (typeof r.resultJson === 'string') { try { return JSON.parse(r.resultJson); } catch { return {}; } }
    return r;
  };
  async function call(action, extra = {}) {
    const k = kit();
    if (!k?.agent?.subagents) throw new Error('Workflows need a newer app engine.');
    const out = parse(await k.agent.subagents({ action, ...extra }));
    if (out && out.error && Object.keys(out).length === 1) throw new Error(out.error);
    return out;
  }
  const say = (msg, type) => { try { if (typeof toast === 'function') toast(msg, { type }); } catch { /* no toast */ } };

  /* ---------- graph helpers ---------- */
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  function uniqueId(wf, base) {
    let id = slug(base) || 'step';
    const ids = new Set(wf.nodes.map((n) => n.id));
    if (!ids.has(id)) return id;
    for (let i = 2; ; i += 1) if (!ids.has(`${id}_${i}`)) return `${id}_${i}`;
  }
  const condOf = (e) => (e.when && e.when.type) || 'success';
  function edgeLabel(e) {
    const c = condOf(e);
    const v = e.when && e.when.value;
    let t = e.label || '';
    if (!t) {
      if (c === 'route') t = v || 'route';
      else if (c === 'success') t = '';
      else if (c === 'failed') t = 'on failure';
      else if (c === 'default') t = 'otherwise';
      else if (c === 'always') t = 'always';
      else if (c === 'not_contains') t = `no "${short(v, 14)}"`;
      else t = `${c === 'regex' ? '~' : c === 'equals' ? '=' : 'has'} "${short(v, 14)}"`;
    }
    return e.loop ? `↺ ${t}`.trim() : t;
  }
  /** Layered layout: longest path over the forward edges, then rows in order. */
  // Narrow screens (phones) stack the layers top to bottom, so the graph stays readable without zooming out to a strip.
  const narrow = () => typeof window !== 'undefined' && (window.innerWidth || 1024) < 560;
  function autoLayout(wf, vertical = narrow()) {
    const fwd = wf.edges.filter((e) => !e.loop);
    const layer = new Map();
    const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
    for (const e of fwd) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    const q = wf.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
    for (const id of q) layer.set(id, 0);
    while (q.length) {
      const id = q.shift();
      for (const e of fwd.filter((x) => x.from === id)) {
        layer.set(e.to, Math.max(layer.get(e.to) || 0, (layer.get(id) || 0) + 1));
        indeg.set(e.to, indeg.get(e.to) - 1);
        if (!indeg.get(e.to)) q.push(e.to);
      }
    }
    const rows = new Map();
    for (const n of wf.nodes) {
      const l = layer.has(n.id) ? layer.get(n.id) : 0;
      const r = rows.get(l) || 0;
      rows.set(l, r + 1);
      n.position = vertical ? { x: 40 + r * (NODE_W + 28), y: 40 + l * (NODE_H + 70) } : { x: 40 + l * 260, y: 40 + r * 120 };
    }
    // Centre each column (or row) on the biggest one.
    const tallest = Math.max(1, ...rows.values());
    for (const n of wf.nodes) {
      const l = layer.has(n.id) ? layer.get(n.id) : 0;
      if (vertical) n.position.x += ((tallest - rows.get(l)) * (NODE_W + 28)) / 2;
      else n.position.y += ((tallest - rows.get(l)) * 120) / 2;
    }
  }

  const TEMPLATES = [
    {
      key: 'pipeline', label: 'Research → Write → Review',
      make: () => ({
        name: 'Research and write', description: 'A researcher hands its findings to a writer; a reviewer sends the draft back until it is approved.',
        nodes: [
          { id: 'research', kind: 'agent', label: 'Research', task: 'Research this topic thoroughly and report the key facts with sources: {{input}}' },
          { id: 'write', kind: 'agent', label: 'Write', task: 'Write a clear, well-structured piece from the research below. If reviewer feedback is included, apply it.\n\n{{inputs}}', maxRuns: 3 },
          { id: 'review', kind: 'agent', label: 'Review', task: 'Review the draft below for accuracy and clarity. If it is ready, reply with APPROVED on the first line followed by the final text; otherwise list concrete fixes.\n\n{{last}}' },
          { id: 'final', kind: 'output', label: 'Final' },
        ],
        edges: [
          { from: 'research', to: 'write' }, { from: 'write', to: 'review' },
          { from: 'review', to: 'write', loop: true, when: { type: 'not_contains', value: 'APPROVED' } },
          { from: 'review', to: 'final', when: { type: 'contains', value: 'APPROVED' } },
        ],
      }),
    },
    {
      key: 'parallel', label: 'Parallel analysts → Merge',
      make: () => ({
        name: 'Parallel analysis', description: 'Three analysts work at once; a synthesizer merges their reports.',
        nodes: [
          { id: 'tech', kind: 'agent', label: 'Technical analyst', task: 'Analyse the technical side of: {{input}}' },
          { id: 'market', kind: 'agent', label: 'Market analyst', task: 'Analyse the market side of: {{input}}' },
          { id: 'risk', kind: 'agent', label: 'Risk analyst', task: 'List the main risks of: {{input}}' },
          { id: 'merge', kind: 'merge', label: 'Merge' },
          { id: 'synth', kind: 'agent', label: 'Synthesize', task: 'Combine these analyses into one recommendation:\n\n{{inputs}}' },
        ],
        edges: [
          { from: 'tech', to: 'merge' }, { from: 'market', to: 'merge' }, { from: 'risk', to: 'merge' }, { from: 'merge', to: 'synth' },
        ],
      }),
    },
    {
      key: 'router', label: 'Triage router',
      make: () => ({
        name: 'Support triage', description: 'A router sends each request to the right specialist.',
        nodes: [
          { id: 'triage', kind: 'router', label: 'Triage', routes: ['billing', 'technical', 'other'], task: 'Classify this request: {{input}}' },
          { id: 'billing', kind: 'agent', label: 'Billing', task: 'Answer this billing request: {{input}}' },
          { id: 'technical', kind: 'agent', label: 'Technical', task: 'Solve this technical problem step by step: {{input}}' },
          { id: 'other', kind: 'agent', label: 'General', task: 'Answer this request: {{input}}' },
          { id: 'answer', kind: 'output', label: 'Answer', join: 'any' },
        ],
        edges: [
          { from: 'triage', to: 'billing', when: { type: 'route', value: 'billing' } },
          { from: 'triage', to: 'technical', when: { type: 'route', value: 'technical' } },
          { from: 'triage', to: 'other', when: { type: 'route', value: 'other' } },
          { from: 'billing', to: 'answer' }, { from: 'technical', to: 'answer' }, { from: 'other', to: 'answer' },
        ],
      }),
    },
  ];

  /* ---------- the screen ---------- */
  function mount(opts = {}) {
    const root = h('div', { class: 'wf', 'data-slot': 'workflows' });
    let alive = true;
    let list = [];
    let wf = null; // the workflow being edited (a copy)
    let dirty = false;
    let selected = null; // { type: 'node' | 'edge', id }
    let run = null; // the run shown on the graph
    let runs = [];
    let view = { x: 20, y: 20, k: 1 };
    let runInput = '';

    const onRunEvent = (ev) => {
      const d = ev.detail || {};
      if (d.type === 'workflow.changed') { if (!wf) loadList(); return; }
      if (d.type !== 'workflow.run') return;
      const r = d.payload;
      if (!r || !r.id) return;
      const i = runs.findIndex((x) => x.id === r.id);
      if (i >= 0) runs[i] = r; else if (wf && r.workflowId === wf.id) runs.unshift(r);
      if (wf && r.workflowId === wf.id && (!run || run.id === r.id || r.status === 'running')) { run = r; paintRun(); }
      if (!wf) { const w = list.find((x) => x.id === r.workflowId); if (w) { w.lastRun = { id: r.id, status: r.status, startedAt: r.startedAt }; paintList(); } }
    };
    window.addEventListener('agent:workflow', onRunEvent);

    async function loadList() {
      try { list = (await call('workflows')).workflows || []; } catch (e) { list = []; setChildren(root, h('p', { class: 'field-hint' }, String(e.message || e))); return; }
      if (!wf) paintList();
    }

    /* ---- list ---- */
    function paintList() {
      if (!alive) return;
      const head = h('div', { class: 'wf-head' },
        h('div', { class: 'wf-head-text' },
          h('strong', null, 'Workflows'),
          h('p', { class: 'field-hint' }, 'Sub-agents connected in a graph: each step\'s result goes to the next on its own. Ask the agent to build one, or start here.')),
        h('div', { class: 'wf-head-actions' },
          h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'wf-new', onclick: () => openEditor(blank()) }, icon('plus'), 'New'),
          h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Refresh', onclick: () => loadList() }, icon('refresh-cw'))));
      const rows = list.map((w) => {
        const st = w.lastRun?.status;
        return h('button', { type: 'button', class: 'wf-row', 'data-id': w.id, onclick: () => openEditor(clone(w)) },
          h('span', { class: 'wf-row-icon' }, icon('wf-flow')),
          h('span', { class: 'wf-row-main' },
            h('span', { class: 'wf-row-name truncate' }, w.name),
            h('span', { class: 'wf-row-sub truncate' }, `${w.nodes.length} steps · ${w.edges.length} links${w.description ? ` · ${short(w.description, 60)}` : ''}`)),
          st ? h('span', { class: 'wf-badge', 'data-status': st }, STATUS[st] || st) : null,
          icon('chevron-right'));
      });
      const empty = h('div', { class: 'wf-empty' },
        h('p', null, 'No workflows yet. Start from a template:'),
        h('div', { class: 'wf-templates' }, ...TEMPLATES.map((t) => h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-template': t.key, onclick: () => { const w = t.make(); autoLayout(w); openEditor(w, true); } }, t.label))));
      setChildren(root, head, list.length ? h('div', { class: 'wf-list' }, ...rows) : null,
        list.length ? h('details', { class: 'wf-more' }, h('summary', null, 'Templates'), h('div', { class: 'wf-templates' }, ...TEMPLATES.map((t) => h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { const w = t.make(); autoLayout(w); openEditor(w, true); } }, t.label)))) : empty);
    }
    const blank = () => ({ name: 'New workflow', description: '', nodes: [{ id: 'step_1', kind: 'agent', label: 'Step 1', task: '{{input}}', position: { x: 40, y: 60 } }], edges: [] });

    /* ---- editor ---- */
    const canvas = h('div', { class: 'wf-canvas', tabindex: '0', 'data-slot': 'wf-canvas' });
    const svg = sv('svg', { class: 'wf-svg' });
    const defs = sv('defs', null,
      ...['idle', 'live', 'dead', 'sel'].map((s) => sv('marker', { id: `wf-arrow-${s}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        sv('path', { d: 'M0,0 L10,5 L0,10 z', class: `wf-arrowhead wf-arrowhead-${s}` }))));
    const world = sv('g', { class: 'wf-world' });
    const edgeLayer = sv('g', { class: 'wf-edges' });
    const nodeLayer = sv('g', { class: 'wf-nodes' });
    const ghost = sv('path', { class: 'wf-ghost', d: '' });
    world.append(edgeLayer, ghost, nodeLayer);
    svg.append(defs, world);
    const zoomLabel = h('span', { class: 'wf-zoomlabel' }, '100%');
    const zoomBar = h('div', { class: 'wf-zoom' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.2) }, icon('wf-zoom-out')),
      zoomLabel,
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.2) }, icon('wf-zoom-in')),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Fit to screen', onclick: () => fit() }, icon('wf-fit')));
    canvas.append(svg, zoomBar);
    const inspector = h('div', { class: 'wf-inspector', 'data-slot': 'wf-inspector' });
    const runBar = h('div', { class: 'wf-runbar' });
    const header = h('div', { class: 'wf-edhead' });
    const issues = h('p', { class: 'wf-issues', role: 'status' });

    function openEditor(w, isNew = false) {
      wf = w;
      wf.nodes = wf.nodes || [];
      wf.edges = wf.edges || [];
      if (wf.nodes.some((n) => !n.position)) autoLayout(wf);
      dirty = isNew || !wf.id;
      selected = null;
      run = null;
      runs = [];
      setChildren(root, header, runBar, canvas, issues, inspector);
      paintHeader();
      paintGraph();
      paintInspector();
      paintRunBar();
      requestAnimationFrame(() => fit());
      if (wf.id) loadRuns();
    }
    async function loadRuns() {
      try {
        runs = (await call('workflowRuns', { workflowId: wf.id, limit: 15 })).runs || [];
        run = runs[0] || null;
        paintRun();
      } catch { /* older engine */ }
    }
    function closeEditor() {
      if (dirty && !window.confirm('Leave without saving your changes?')) return;
      wf = null; run = null; selected = null;
      loadList();
    }
    function touch() { dirty = true; paintHeader(); validate(); }

    function paintHeader() {
      const name = h('input', { class: 'input wf-name', value: wf.name || '', 'aria-label': 'Workflow name', oninput: (e) => { wf.name = e.target.value; touch(); } });
      const addMenu = h('div', { class: 'wf-add' }, ...KINDS.map(([k, label, hint]) => h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-kind': k, title: hint, onclick: () => addNode(k) }, icon('plus'), label)));
      setChildren(header,
        h('div', { class: 'wf-edrow' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Back to workflows', onclick: closeEditor }, icon('chevron-left')),
          name,
          h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Arrange', title: 'Arrange automatically', onclick: () => { autoLayout(wf); touch(); paintGraph(); fit(); } }, icon('wf-layout')),
          h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'wf-save', disabled: !dirty, onclick: save }, icon('wf-save'), dirty ? 'Save' : 'Saved'),
          wf.id ? h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Delete workflow', onclick: remove }, icon('trash')) : null),
        addMenu);
    }

    function paintRunBar() {
      const input = h('input', { class: 'input wf-input', placeholder: 'Input for this run ({{input}})', value: runInput, 'aria-label': 'Run input', oninput: (e) => { runInput = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') start(); } });
      const running = run && run.status === 'running';
      const picker = runs.length ? h('select', { class: 'select wf-runpick', 'aria-label': 'Show a run', onchange: (e) => { run = runs.find((r) => r.id === e.target.value) || null; paintRun(); } },
        h('option', { value: '' }, 'No run shown'),
        ...runs.map((r) => h('option', { value: r.id, selected: run && run.id === r.id }, `${new Date(r.startedAt).toLocaleString()} · ${STATUS[r.status] || r.status}`))) : null;
      setChildren(runBar,
        input,
        running
          ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'wf-stop', onclick: stop }, icon('square'), 'Stop')
          : h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'wf-run', onclick: start }, icon('wf-play'), 'Run'),
        picker,
        run ? h('span', { class: 'wf-badge', 'data-status': run.status }, running ? icon('loader-circle', 'spin') : null, STATUS[run.status] || run.status) : null);
    }

    async function save() {
      const err = validate();
      if (err) { say(err, 'error'); return false; }
      try {
        const out = await call('workflowSave', { workflow: wf });
        const saved = out.workflow;
        if (!saved) throw new Error(out.error || 'Not saved.');
        // Keep the user's positions; take the ids and defaults the engine filled in.
        wf = saved; dirty = false;
        (out.warnings || []).forEach((w) => say(w));
        paintHeader(); paintGraph(); paintInspector(); validate();
        say('Workflow saved.');
        return true;
      } catch (e) { say(String(e.message || e), 'error'); return false; }
    }
    async function remove() {
      if (!window.confirm(`Delete "${wf.name}"?`)) return;
      try { await call('workflowDelete', { id: wf.id }); dirty = false; closeEditor(); } catch (e) { say(String(e.message || e), 'error'); }
    }
    async function start() {
      if (dirty && !(await save())) return;
      try {
        const out = await call('workflowRun', { id: wf.id, input: runInput });
        if (out.run) { run = out.run; runs.unshift(out.run); paintRun(); }
      } catch (e) { say(String(e.message || e), 'error'); }
    }
    async function stop() {
      if (!run) return;
      try { await call('workflowStop', { runId: run.id }); } catch (e) { say(String(e.message || e), 'error'); }
    }

    /* ---- editing ---- */
    function addNode(kind) {
      const label = KINDS.find((k) => k[0] === kind)[1];
      const id = uniqueId(wf, `${label} ${wf.nodes.length + 1}`);
      const b = canvas.getBoundingClientRect();
      const cx = (b.width / 2 - view.x) / view.k - NODE_W / 2;
      const cy = (b.height / 2 - view.y) / view.k - NODE_H / 2;
      const n = { id, kind, label: `${label} ${wf.nodes.length + 1}`, position: { x: Math.round(cx + (wf.nodes.length % 4) * 16), y: Math.round(cy + (wf.nodes.length % 4) * 16) } };
      if (kind === 'agent') n.task = 'Do this step using the input: {{inputs}}';
      if (kind === 'router') { n.task = 'Decide which way this goes: {{inputs}}'; n.routes = ['yes', 'no']; }
      // Connect it after the selected node.
      if (selected?.type === 'node') wf.edges.push({ from: selected.id, to: id });
      wf.nodes.push(n);
      selected = { type: 'node', id };
      touch(); paintGraph(); paintInspector();
    }
    function connect(from, to) {
      if (from === to) return;
      if (wf.edges.some((e) => e.from === from && e.to === to)) return;
      const e = { from, to };
      // A link back to an earlier step is a loop.
      if (reaches(to, from)) e.loop = true;
      const src = wf.nodes.find((n) => n.id === from);
      if (src && src.kind === 'router') {
        const used = new Set(wf.edges.filter((x) => x.from === from && x.when?.type === 'route').map((x) => x.when.value));
        const free = (src.routes || []).find((r) => !used.has(r));
        if (free) e.when = { type: 'route', value: free };
      }
      wf.edges.push(e);
      selected = { type: 'edge', id: edgeKey(e) };
      touch(); paintGraph(); paintInspector();
    }
    const reaches = (a, b) => {
      const seen = new Set([a]);
      const stack = [a];
      while (stack.length) {
        const id = stack.pop();
        if (id === b) return true;
        for (const e of wf.edges) if (!e.loop && e.from === id && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
      }
      return false;
    };
    const edgeKey = (e) => e.id || `${e.from}->${e.to}`;
    function deleteSelected() {
      if (!selected) return;
      if (selected.type === 'node') {
        wf.nodes = wf.nodes.filter((n) => n.id !== selected.id);
        wf.edges = wf.edges.filter((e) => e.from !== selected.id && e.to !== selected.id);
      } else wf.edges = wf.edges.filter((e) => edgeKey(e) !== selected.id);
      selected = null;
      touch(); paintGraph(); paintInspector();
    }
    function renameNode(n, id) {
      id = slug(id);
      if (!id || id === n.id || wf.nodes.some((x) => x.id === id)) return false;
      for (const e of wf.edges) { if (e.from === n.id) e.from = id; if (e.to === n.id) e.to = id; }
      n.id = id;
      selected = { type: 'node', id };
      return true;
    }

    /** Client-side checks so mistakes show while editing (the engine checks again on save). */
    function validate() {
      let err = '';
      if (!oneLine(wf.name)) err = 'Give the workflow a name.';
      else if (!wf.nodes.length) err = 'Add at least one step.';
      else {
        for (const n of wf.nodes) {
          if ((n.kind === 'agent' || n.kind === 'router') && !oneLine(n.task)) { err = `"${n.label || n.id}" needs a task.`; break; }
          if (n.kind === 'router' && (n.routes || []).filter(Boolean).length < 2) { err = `Router "${n.label || n.id}" needs two or more routes.`; break; }
        }
        if (!err) for (const e of wf.edges) if (NEEDS_VALUE.has(condOf(e)) && !oneLine(e.when.value)) { err = `The link ${e.from} → ${e.to} needs a value for its condition.`; break; }
        if (!err) {
          const fwd = wf.edges.filter((e) => !e.loop);
          const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
          for (const e of fwd) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
          const q = wf.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
          let seen = 0;
          while (q.length) { const id = q.shift(); seen += 1; for (const e of fwd.filter((x) => x.from === id)) { indeg.set(e.to, indeg.get(e.to) - 1); if (!indeg.get(e.to)) q.push(e.to); } }
          if (seen !== wf.nodes.length) err = 'The links form a cycle: mark the link that goes back as a loop.';
        }
      }
      issues.textContent = err;
      issues.hidden = !err;
      return err;
    }

    /* ---- drawing ---- */
    const nodeById = (id) => wf.nodes.find((n) => n.id === id);
    function edgePath(e) {
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      if (!a || !b) return { d: '', mx: 0, my: 0 };
      // Stacked (top-to-bottom layout): the target sits below or above the source, overlapping it sideways.
      if (Math.abs(b.position.x - a.position.x) < NODE_W + 10 && Math.abs(b.position.y - a.position.y) >= NODE_H) {
        if (!e.loop && b.position.y > a.position.y) {
          const sx = a.position.x + NODE_W / 2, sy = a.position.y + NODE_H, tx = b.position.x + NODE_W / 2, ty = b.position.y;
          const dy = Math.max(30, (ty - sy) / 2);
          return { d: `M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`, mx: (sx + tx) / 2, my: (sy + ty) / 2 };
        }
        // Back edge in a stack: out of the right side, round the right, into the target's right side.
        const sx = a.position.x + NODE_W, sy = a.position.y + NODE_H / 2, tx = b.position.x + NODE_W, ty = b.position.y + NODE_H / 2;
        const side = Math.max(sx, tx) + 56;
        return { d: `M${sx},${sy} C${side},${sy} ${side},${ty} ${tx},${ty}`, mx: side - 14, my: (sy + ty) / 2 };
      }
      const ax = a.position.x + NODE_W;
      const ay = a.position.y + NODE_H / 2;
      const bx = b.position.x;
      const by = b.position.y + NODE_H / 2;
      if (e.loop || bx < ax - 10) {
        // Back edge: go under both nodes.
        const low = Math.max(a.position.y, b.position.y) + NODE_H + 46;
        const d = `M${ax},${ay} C${ax + 70},${ay} ${ax + 70},${low} ${(ax + bx) / 2},${low} S${bx - 70},${by} ${bx},${by}`;
        return { d, mx: (ax + bx) / 2, my: low };
      }
      const dx = Math.max(40, (bx - ax) / 2);
      const d = `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
      return { d, mx: (ax + bx) / 2, my: (ay + by) / 2 };
    }
    function paintGraph() {
      if (!wf) return;
      edgeLayer.replaceChildren();
      nodeLayer.replaceChildren();
      for (const e of wf.edges) {
        const { d, mx, my } = edgePath(e);
        const key = edgeKey(e);
        const st = (run && e.id && run.edges?.[e.id]?.status) || 'idle';
        const sel = selected?.type === 'edge' && selected.id === key;
        const g = sv('g', { class: 'wf-edge', 'data-id': key, 'data-status': st, 'data-loop': String(!!e.loop), 'data-cond': condOf(e), 'data-selected': String(sel) });
        g.append(
          sv('path', { class: 'wf-edge-hit', d }),
          sv('path', { class: 'wf-edge-line', d, 'marker-end': `url(#wf-arrow-${sel ? 'sel' : st})` }));
        const label = edgeLabel(e);
        if (label) {
          const w = Math.min(150, 14 + label.length * 6.3);
          g.append(sv('g', { class: 'wf-edge-label', transform: `translate(${mx - w / 2},${my - 11})` },
            sv('rect', { width: w, height: 22, rx: 11 }), sv('text', { x: w / 2, y: 15, 'text-anchor': 'middle' }, short(label, 22))));
        }
        const count = run && e.id && run.edges?.[e.id]?.count;
        if (count > 1) g.append(sv('text', { class: 'wf-edge-count', x: mx, y: my + 26, 'text-anchor': 'middle' }, `×${count}`));
        g.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); selected = { type: 'edge', id: key }; paintGraph(); paintInspector(); });
        edgeLayer.append(g);
      }
      for (const n of wf.nodes) {
        const st = run?.nodes?.[n.id];
        const status = st?.status || 'none';
        const sel = selected?.type === 'node' && selected.id === n.id;
        const kindLabel = (KINDS.find((k) => k[0] === n.kind) || KINDS[0])[1];
        const sub = st && st.status !== 'pending'
          ? `${STATUS[st.status] || st.status}${st.runs > 1 ? ` · run ${st.runs}` : ''}${st.route ? ` · → ${st.route}` : ''}`
          : (n.kind === 'agent' || n.kind === 'router' ? short(n.task, 28) : kindLabel);
        const g = sv('g', { class: 'wf-node', 'data-id': n.id, 'data-kind': n.kind || 'agent', 'data-status': status, 'data-selected': String(sel), transform: `translate(${n.position.x},${n.position.y})` },
          sv('rect', { class: 'wf-node-box', width: NODE_W, height: NODE_H, rx: 14 }),
          sv('rect', { class: 'wf-node-stripe', width: 6, height: NODE_H - 16, x: 8, y: 8, rx: 3 }),
          sv('text', { class: 'wf-node-kind', x: 22, y: 20 }, kindLabel.toUpperCase()),
          sv('text', { class: 'wf-node-title', x: 22, y: 38 }, short(n.label || n.id, 22)),
          sv('text', { class: 'wf-node-sub', x: 22, y: 54 }, short(sub, 30)),
          status === 'running' ? sv('circle', { class: 'wf-node-pulse', cx: NODE_W - 16, cy: 16, r: 5 }) : null,
          sv('circle', { class: 'wf-port-in', cx: 0, cy: NODE_H / 2, r: 5 }),
          sv('circle', { class: 'wf-port-out', cx: NODE_W, cy: NODE_H / 2, r: 7, 'data-port': 'out' }));
        nodeLayer.append(g);
      }
      applyView();
    }
    function paintRun() {
      paintGraph();
      paintRunBar();
      if (selected) paintInspector();
      else paintInspector();
    }

    /* ---- inspector ---- */
    const field = (label, control, hint) => h('label', { class: 'wf-field' }, h('span', { class: 'wf-field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
    function paintInspector() {
      if (!wf) return;
      if (!selected) {
        const out = run && (run.output || run.error);
        setChildren(inspector,
          field('Description', h('textarea', { class: 'textarea input', rows: 2, oninput: (e) => { wf.description = e.target.value; touch(); } }, wf.description || '')),
          h('p', { class: 'field-hint' }, 'Tap a step or a link to edit it. Drag a step to move it; drag from the dot on its right onto another step to connect them. A link back to an earlier step becomes a loop.'),
          out ? h('div', { class: 'wf-output' }, h('strong', null, run.output ? 'Final output' : 'Error'), h('pre', null, out)) : null);
        return;
      }
      if (selected.type === 'node') {
        const n = nodeById(selected.id);
        if (!n) { selected = null; paintInspector(); return; }
        const st = run?.nodes?.[n.id];
        const set = (k, v, repaint = true) => { if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete n[k]; else n[k] = v; touch(); if (repaint) paintGraph(); };
        const isAgent = n.kind === 'agent' || n.kind === 'router';
        const idInput = h('input', { class: 'input', value: n.id, onchange: (e) => { if (renameNode(n, e.target.value)) { touch(); paintGraph(); } else e.target.value = n.id; } });
        const kinds = h('select', { class: 'select', onchange: (e) => { n.kind = e.target.value; if ((n.kind === 'agent' || n.kind === 'router') && !n.task) n.task = '{{inputs}}'; if (n.kind === 'router' && !(n.routes || []).length) n.routes = ['yes', 'no']; touch(); paintGraph(); paintInspector(); } },
          ...KINDS.map(([k, label]) => h('option', { value: k, selected: (n.kind || 'agent') === k }, label)));
        const body = [
          h('div', { class: 'wf-insp-head' }, h('strong', null, n.label || n.id),
            h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Delete step', onclick: deleteSelected }, icon('trash')),
            h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Close', onclick: () => { selected = null; paintGraph(); paintInspector(); } }, icon('x'))),
          st && st.status !== 'pending' ? h('div', { class: 'wf-output' },
            h('span', { class: 'wf-badge', 'data-status': st.status }, STATUS[st.status] || st.status),
            st.attempts > 1 ? h('span', { class: 'field-hint' }, ` ${st.attempts} attempts`) : null,
            st.subagentId && typeof opts.openAgent === 'function' ? h('button', { type: 'button', class: 'btn btn-ghost btn-xs', onclick: () => opts.openAgent(st.subagentId) }, 'Open sub-agent') : null,
            st.output || st.error ? h('pre', null, st.error || st.output) : null) : null,
          field('Label', h('input', { class: 'input', value: n.label || '', oninput: (e) => set('label', e.target.value) })),
          field('Kind', kinds, (KINDS.find((k) => k[0] === (n.kind || 'agent')) || KINDS[0])[2]),
          field('Id', idInput, 'Used in templates as {{node.' + n.id + '}}.'),
        ];
        if (isAgent) {
          body.push(field('Task', h('textarea', { class: 'textarea input', rows: 5, oninput: (e) => set('task', e.target.value, false), onchange: () => paintGraph() }, n.task || ''),
            '{{input}} is the run input, {{inputs}} every upstream result, {{last}} the newest one, {{node.<id>}} one step\'s result. Without them, upstream results are attached at the end.'));
          if (n.kind === 'router') body.push(field('Routes', h('input', { class: 'input', value: (n.routes || []).join(', '), oninput: (e) => set('routes', e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) }), 'Comma-separated. Give each outgoing link the condition "Router picks" with one of these.'));
          body.push(
            field('Role', h('input', { class: 'input', value: n.role || '', placeholder: 'e.g. researcher', oninput: (e) => set('role', e.target.value, false) })),
            field('Tools', h('input', { class: 'input', value: (n.tools || []).join(', '), placeholder: 'Default: the main agent\'s tools', oninput: (e) => set('tools', e.target.value.split(',').map((s) => s.trim()).filter(Boolean), false) })),
            field('Model', h('input', { class: 'input', value: n.model || '', placeholder: 'Default', oninput: (e) => set('model', e.target.value, false) })),
            h('div', { class: 'wf-grid' },
              field('Retries', h('input', { class: 'input', type: 'number', min: 0, max: 3, value: n.retries ?? '', oninput: (e) => set('retries', e.target.value === '' ? '' : Number(e.target.value), false) })),
              field('Max steps', h('input', { class: 'input', type: 'number', min: 1, value: n.maxSteps ?? '', oninput: (e) => set('maxSteps', e.target.value === '' ? '' : Number(e.target.value), false) }))));
        } else {
          body.push(field('Template', h('textarea', { class: 'textarea input', rows: 4, placeholder: n.kind === 'merge' ? 'Merge joins every input; no template needed.' : 'Empty: pass the input on as is.', disabled: n.kind === 'merge', oninput: (e) => set('template', e.target.value, false) }, n.template || '')));
        }
        body.push(h('div', { class: 'wf-grid' },
          field('Wait for', h('select', { class: 'select', onchange: (e) => set('join', e.target.value) },
            h('option', { value: 'all', selected: n.join !== 'any' }, 'All inputs'), h('option', { value: 'any', selected: n.join === 'any' }, 'First input'))),
          field('Max runs', h('input', { class: 'input', type: 'number', min: 1, max: 10, value: n.maxRuns ?? '', placeholder: '1', oninput: (e) => set('maxRuns', e.target.value === '' ? '' : Number(e.target.value), false) }))));
        setChildren(inspector, ...body);
        return;
      }
      const e = wf.edges.find((x) => edgeKey(x) === selected.id);
      if (!e) { selected = null; paintInspector(); return; }
      const cond = condOf(e);
      const src = nodeById(e.from);
      const setCond = (type, value) => {
        if (type === 'success' && !value) delete e.when; else e.when = { type, value: value || '' };
        touch(); paintGraph(); paintInspector();
      };
      const valueCtl = cond === 'route' && src?.routes?.length
        ? h('select', { class: 'select', onchange: (ev) => setCond('route', ev.target.value) }, ...src.routes.map((r) => h('option', { value: r, selected: e.when?.value === r }, r)))
        : h('input', { class: 'input', value: e.when?.value || '', onchange: (ev) => setCond(cond, ev.target.value) });
      setChildren(inspector,
        h('div', { class: 'wf-insp-head' }, h('strong', null, `${nodeById(e.from)?.label || e.from} → ${nodeById(e.to)?.label || e.to}`),
          h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Delete link', onclick: deleteSelected }, icon('trash')),
          h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Close', onclick: () => { selected = null; paintGraph(); paintInspector(); } }, icon('x'))),
        field('Passes the result on', h('select', { class: 'select', onchange: (ev) => setCond(ev.target.value, ev.target.value === 'route' ? (src?.routes || [])[0] : e.when?.value) },
          ...CONDS.map(([k, label]) => h('option', { value: k, selected: cond === k }, label))),
          'Several links out of one step run in parallel. "Otherwise" is taken when no other link matched; "On failure" carries the error.'),
        NEEDS_VALUE.has(cond) ? field('Value', valueCtl) : null,
        field('Label', h('input', { class: 'input', value: e.label || '', placeholder: 'Shown on the graph', oninput: (ev) => { e.label = ev.target.value || undefined; touch(); paintGraph(); } })),
        h('label', { class: 'wf-check' }, h('input', { type: 'checkbox', checked: !!e.loop, onchange: (ev) => { e.loop = ev.target.checked; touch(); paintGraph(); } }),
          h('span', null, 'Loop back (re-runs the target, up to its max runs)')));
    }

    /* ---- pan, zoom, drag, connect ---- */
    function applyView() {
      world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
      zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
    }
    function zoomBy(f, cx, cy) {
      const b = canvas.getBoundingClientRect();
      if (cx == null) { cx = b.width / 2; cy = b.height / 2; }
      const k = clamp(view.k * f, MIN_K, MAX_K);
      view.x = cx - ((cx - view.x) * k) / view.k;
      view.y = cy - ((cy - view.y) * k) / view.k;
      view.k = k;
      applyView();
    }
    function fit() {
      if (!wf || !wf.nodes.length) return;
      const b = canvas.getBoundingClientRect();
      if (!b.width) return;
      const xs = wf.nodes.map((n) => n.position.x);
      const ys = wf.nodes.map((n) => n.position.y);
      const x0 = Math.min(...xs) - 30;
      const y0 = Math.min(...ys) - 30;
      const x1 = Math.max(...xs) + NODE_W + 30;
      const y1 = Math.max(...ys) + NODE_H + 80;
      // Never shrink below a readable size (a phone got a 35% strip): what does not fit starts at its top-left, and you pan to the rest.
      const minK = b.width < 560 ? 0.62 : 0.5;
      const k = clamp(Math.min(b.width / (x1 - x0), b.height / (y1 - y0), 1.2), minK, 1.2);
      const gw = (x1 - x0) * k, gh = (y1 - y0) * k;
      view = { k, x: gw <= b.width ? (b.width - gw) / 2 - x0 * k : 8 - x0 * k, y: gh <= b.height ? (b.height - gh) / 2 - y0 * k : 8 - y0 * k };
      applyView();
    }
    const local = (ev) => { const b = canvas.getBoundingClientRect(); return { x: ev.clientX - b.left, y: ev.clientY - b.top }; };
    const toWorld = (p) => ({ x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k });
    const pointers = new Map();
    let gesture = null;
    svg.addEventListener('pointerdown', (ev) => {
      if (!wf) return;
      canvas.focus({ preventScroll: true });
      pointers.set(ev.pointerId, local(ev));
      svg.setPointerCapture?.(ev.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
        return;
      }
      const nodeEl = ev.target.closest?.('.wf-node');
      const p = local(ev);
      if (nodeEl) {
        const n = nodeById(nodeEl.dataset.id);
        if (ev.target.dataset?.port === 'out') {
          gesture = { type: 'connect', from: n.id };
          return;
        }
        const w = toWorld(p);
        gesture = { type: 'drag', id: n.id, dx: w.x - n.position.x, dy: w.y - n.position.y, moved: false, start: p };
        return;
      }
      if (ev.target.closest?.('.wf-edge')) return;
      gesture = { type: 'pan', sx: p.x, sy: p.y, vx: view.x, vy: view.y, moved: false };
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      const p = local(ev);
      pointers.set(ev.pointerId, p);
      if (!gesture) return;
      if (gesture.type === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomBy((gesture.k * d) / gesture.d / view.k, (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (gesture.type === 'pan') {
        view.x = gesture.vx + p.x - gesture.sx;
        view.y = gesture.vy + p.y - gesture.sy;
        gesture.moved = gesture.moved || Math.abs(p.x - gesture.sx) + Math.abs(p.y - gesture.sy) > 4;
        applyView();
      } else if (gesture.type === 'drag') {
        const n = nodeById(gesture.id);
        if (!gesture.moved && Math.abs(p.x - gesture.start.x) + Math.abs(p.y - gesture.start.y) < 4) return;
        gesture.moved = true;
        const w = toWorld(p);
        n.position = { x: Math.round(w.x - gesture.dx), y: Math.round(w.y - gesture.dy) };
        paintGraph();
      } else if (gesture.type === 'connect') {
        const a = nodeById(gesture.from);
        const w = toWorld(p);
        const ax = a.position.x + NODE_W;
        const ay = a.position.y + NODE_H / 2;
        ghost.setAttribute('d', `M${ax},${ay} C${ax + 60},${ay} ${w.x - 60},${w.y} ${w.x},${w.y}`);
      }
    });
    const end = (ev) => {
      pointers.delete(ev.pointerId);
      const g = gesture;
      if (pointers.size === 0) gesture = null; else if (g?.type === 'pinch') { gesture = null; return; }
      if (!g) return;
      if (g.type === 'connect') {
        ghost.setAttribute('d', '');
        const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.wf-node');
        if (hit && hit.dataset.id !== g.from) connect(g.from, hit.dataset.id);
      } else if (g.type === 'drag') {
        if (g.moved) touch();
        selected = { type: 'node', id: g.id };
        paintGraph(); paintInspector();
      } else if (g.type === 'pan' && !g.moved && selected) {
        selected = null; paintGraph(); paintInspector();
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', (ev) => {
      if (!wf) return;
      ev.preventDefault();
      const p = local(ev);
      if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) zoomBy(Math.exp(-ev.deltaY * 0.0015), p.x, p.y);
      else { view.x -= ev.deltaX; view.y -= ev.deltaY; applyView(); }
    }, { passive: false });
    canvas.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && ev.target === canvas) { ev.preventDefault(); deleteSelected(); }
      else if (ev.key === 'Escape' && selected) { selected = null; paintGraph(); paintInspector(); }
      else if (ev.key === '+' || ev.key === '=') zoomBy(1.2);
      else if (ev.key === '-') zoomBy(1 / 1.2);
      else if (ev.key === '0') fit();
    });

    loadList();
    return {
      root,
      refresh: () => (wf ? (wf.id ? loadRuns() : null) : loadList()),
      open: async (id) => { const w = list.find((x) => x.id === id || x.name === id) || (await call('workflowGet', { id }).catch(() => ({}))).workflow; if (w) openEditor(clone(w)); },
      destroy: () => { alive = false; window.removeEventListener('agent:workflow', onRunEvent); },
      get workflow() { return wf; }, get run() { return run; },
    };
  }

  return { mount, autoLayout, edgeLabel, TEMPLATES };
})();
