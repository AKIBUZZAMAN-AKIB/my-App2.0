/* ==========================================================================
   Sub-agents (stage B) and live delegation diagrams (stage C).
   Feature-detected: everything here stays hidden unless getEngineFeatures()
   lists "subagents" and NativeKit.agent.subagents() exists.
   ========================================================================== */
const Subagents = (() => {
  const PRESETS_KEY = 'agent.subagents.presets.v1';
  const LOG_MAX = 120;
  const STATUS_LABEL = { running: 'Running', queued: 'Queued', finished: 'Finished', error: 'Failed', cancelled: 'Stopped', waiting_approval: 'Needs approval' };
  const MEMORY_MODES = [['private', 'Private (own memory only)', 'Private'], ['read_parent', 'Can read main memory', 'Read main'], ['shared', 'Shares main memory', 'Shared']];
  const DEFAULT_SETTINGS = { enabled: true, maxDepth: 1, maxParallel: 3, defaultTokenBudget: 200000, defaultMaxSteps: 25, timeoutSeconds: 600, defaultMemory: 'private', maxKept: 50 };

  const extraIcons = {
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
    square: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  };
  for (const [k, v] of Object.entries(extraIcons)) if (!ICONS[k]) ICONS[k] = v;

  const SUBAGENT_TOOLS = ['spawn_subagent', 'list_subagents', 'message_subagent', 'stop_subagent'];
  /** Every tool name the page knows of: the engine's built-ins plus the connected MCP servers' tools. */
  function knownToolNames(app) {
    const mcp = app?.chat?.native?.mcp?.connection?.tools;
    return [...new Set([...DEFAULT_TOOL_PERMISSIONS.map((p) => p.toolName), ...(Array.isArray(mcp) ? mcp.map((t) => String(t?.name || '')) : [])].filter(Boolean))].sort();
  }

  /* ---------- state ---------- */
  const records = new Map(); // id -> record (camelCase, as the engine sends it)
  const live = new Map(); // id -> { preview, lastTool, toolLog: [] }
  const log = []; // delegation events for the sequence diagram
  const listeners = new Set();
  let settings = { ...DEFAULT_SETTINGS };
  let installed = false;
  let appRef = null;
  let notifyTimer = 0;

  const available = () => engine.has('subagents') && typeof nativeKit()?.agent?.subagents === 'function';
  const notify = () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = 0; for (const fn of [...listeners]) { try { fn(); } catch (e) { console.warn('subagents listener', e); } } }, 60);
  };
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  function parseResult(r) {
    if (r == null) return {};
    if (typeof r === 'string') return parseMaybeJSON(r, {}) || {};
    if (typeof r.resultJson === 'string') return parseMaybeJSON(r.resultJson, {}) || {};
    if (typeof r.json === 'string') return parseMaybeJSON(r.json, {}) || {};
    return r;
  }
  async function call(action, extra = {}) {
    if (!available()) throw new Error('Sub-agents need a newer app engine.');
    eventLog.add('call', `subagents(${action})`);
    return parseResult(await nativeKit().agent.subagents({ action, ...extra }));
  }

  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  function normalize(r) {
    if (!r || typeof r !== 'object' || !r.id) return null;
    const totalTokens = r.totalTokens !== undefined ? num(r.totalTokens) : num(r.inputTokens) + num(r.outputTokens);
    return {
      ...r, id: String(r.id), name: String(r.name || r.id), status: String(r.status || 'running'),
      steps: num(r.steps), toolCalls: num(r.toolCalls), inputTokens: num(r.inputTokens), outputTokens: num(r.outputTokens), totalTokens,
      tokenBudget: num(r.tokenBudget), maxSteps: num(r.maxSteps), depth: num(r.depth, 1),
      tools: Array.isArray(r.tools) ? r.tools.map(String) : [], memoryMode: String(r.memoryMode || 'private'),
    };
  }
  const isRunning = (r) => r && (r.status === 'running' || r.status === 'queued' || r.status === 'waiting_approval');
  function upsert(r) {
    const n = normalize(r);
    if (!n) return null;
    const old = records.get(n.id);
    // Events can arrive out of order: never let an older "running" overwrite a final status.
    if (old && !isRunning(old) && isRunning(n) && num(n.run || n.runs) <= num(old.run || old.runs) && n.steps <= old.steps) {
      records.set(n.id, { ...n, ...old, totalTokens: Math.max(old.totalTokens, n.totalTokens) });
      return records.get(n.id);
    }
    const merged = { ...(old || {}), ...n };
    if (old) {
      // Counters only grow within a run.
      for (const k of ['steps', 'toolCalls', 'inputTokens', 'outputTokens', 'totalTokens']) if (isRunning(n) && num(old[k]) > num(n[k]) && num(n.run || n.runs) <= num(old.run || old.runs)) merged[k] = old[k];
    }
    records.set(n.id, merged);
    return merged;
  }
  function pushLog(entry) {
    log.push({ at: Date.now(), ...entry });
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  }

  /** One `subagent.*` event from the engine. */
  function onEvent(type, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!p.id) return;
    const kind = String(type).replace(/^subagent\./, '');
    const statusFor = { started: 'running', finished: 'finished', error: 'error', cancelled: 'cancelled', approval_needed: 'waiting_approval' };
    const patch = { ...p };
    if (statusFor[kind]) patch.status = statusFor[kind];
    else if (kind === 'tool_result' || kind === 'step' || kind === 'usage' || kind === 'tool_call') {
      const old = records.get(String(p.id));
      if (old && !isRunning(old)) patch.status = old.status; // a late progress event after the end
      else if (old?.status === 'waiting_approval' && kind !== 'usage') patch.status = 'running';
    }
    const rec = upsert(patch);
    if (!rec) return;
    const l = live.get(rec.id) || { preview: '', toolLog: [] };
    if (kind === 'started') { l.toolLog = []; l.preview = ''; if (p.task) rec.task = String(p.task); }
    if (kind === 'step' && typeof p.preview === 'string') l.preview = p.preview;
    if (kind === 'tool_call' && p.tool) { l.toolLog.push({ tool: String(p.tool), id: p.toolCallId || '', state: 'running' }); if (l.toolLog.length > 40) l.toolLog.shift(); }
    if (kind === 'tool_result') { const t = [...l.toolLog].reverse().find((x) => x.id === p.toolCallId || (!p.toolCallId && x.state === 'running')); if (t) t.state = p.isError ? 'error' : 'done'; }
    if ((kind === 'finished' || kind === 'error') && typeof p.result === 'string') rec.result = p.result;
    if (kind === 'error' && typeof p.error === 'string') rec.error = p.error;
    live.set(rec.id, l);
    if (['started', 'finished', 'error', 'cancelled', 'approval_needed', 'message'].includes(kind)) pushLog({ kind, id: rec.id, name: rec.name, parent: rec.parentSessionKey || '', depth: rec.depth, text: kind === 'started' ? (rec.task || '') : kind === 'error' ? (rec.error || '') : '' });
    notify();
  }

  async function refresh() {
    if (!available()) return [];
    const r = await call('list');
    const list = Array.isArray(r.subagents) ? r.subagents : [];
    const seen = new Set();
    for (const item of list) { const n = upsert(item); if (n) seen.add(n.id); }
    for (const id of [...records.keys()]) if (!seen.has(id) && !isRunning(records.get(id))) { records.delete(id); live.delete(id); }
    if (r.settings && typeof r.settings === 'object') settings = { ...DEFAULT_SETTINGS, ...r.settings };
    notify();
    return [...records.values()];
  }

  /* ---------- presets (local; no secrets in them) ---------- */
  function loadPresets() {
    try { const v = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); return Array.isArray(v) ? v.filter((p) => p && p.id && p.name).slice(0, 50) : []; } catch { return []; }
  }
  function savePresets(list) { try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list.slice(0, 50))); return true; } catch { return false; } }
  function presetToSpec(p, task) {
    const spec = { task: String(task || '').trim(), name: p.name };
    if (p.role) spec.role = p.role;
    if (p.prompt) spec.systemPrompt = p.prompt;
    if (p.model) spec.model = p.model;
    if (Array.isArray(p.tools) && p.tools.length) spec.tools = p.tools;
    if (num(p.tokenBudget) > 0) spec.tokenBudget = num(p.tokenBudget);
    if (num(p.maxSteps) > 0) spec.maxSteps = num(p.maxSteps);
    if (p.memory) spec.memory = p.memory;
    return spec;
  }

  /* ---------- formatting ---------- */
  const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
  const statusChip = (status) => h('span', { class: 'sa-status', 'data-status': status }, STATUS_LABEL[status] || status);
  function meter(used, total, label) {
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    return h('div', { class: 'sa-meter', role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(total || 0), 'aria-valuenow': String(used), 'data-level': pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low' },
      h('span', { class: 'sa-meter-bar', style: `width:${pct}%` }));
  }
  const safeName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.:-]/gu, '').slice(0, 40) || 'agent';

  /* ---------- Mermaid sources (stage C) ---------- */
  const STATUS_CLASS = { running: 'run', queued: 'run', waiting_approval: 'wait', finished: 'ok', error: 'bad', cancelled: 'stop' };
  function treeSource(list = [...records.values()]) {
    const lines = ['flowchart TD', '  main(["Main agent"]):::main'];
    const sorted = [...list].sort((a, b) => num(a.createdAt) - num(b.createdAt) || a.id.localeCompare(b.id)).slice(-40);
    const idx = new Map(sorted.map((r, i) => [r.id, `a${i}`]));
    const bySession = new Map(sorted.map((r) => [r.sessionKey, r.id]));
    for (const r of sorted) {
      const node = idx.get(r.id);
      const label = `${safeName(r.name)}<br/>${STATUS_LABEL[r.status] || r.status} · ${fmtTokens(r.totalTokens)} tok`;
      lines.push(`  ${node}["${label}"]:::${STATUS_CLASS[r.status] || 'run'}`);
      const parentId = bySession.get(r.parentSessionKey);
      lines.push(`  ${parentId && idx.has(parentId) ? idx.get(parentId) : 'main'} --> ${node}`);
    }
    if (!sorted.length) lines.push('  none["No sub-agents yet"]:::stop', '  main -.-> none');
    lines.push('  classDef main fill:#ede9fe,stroke:#7c3aed,color:#2e1065',
      '  classDef run fill:#dbeafe,stroke:#2563eb,color:#172554',
      '  classDef wait fill:#fef3c7,stroke:#d97706,color:#451a03',
      '  classDef ok fill:#dcfce7,stroke:#16a34a,color:#052e16',
      '  classDef bad fill:#fee2e2,stroke:#dc2626,color:#450a0a',
      '  classDef stop fill:#f1f5f9,stroke:#64748b,color:#0f172a');
    return lines.join('\n');
  }
  function sequenceSource(entries = log) {
    const recent = entries.slice(-30);
    const lines = ['sequenceDiagram', '  participant M as Main agent'];
    const alias = new Map();
    for (const e of recent) if (!alias.has(e.id)) { alias.set(e.id, `S${alias.size}`); lines.push(`  participant S${alias.size - 1} as ${safeName(e.name)}`); }
    const msg = (t) => String(t || '').replace(/[;#:\n\r<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
    // Mermaid throws on an activation it can't pair, so track each participant's open activations
    // (a start can be missing from the log, or arrive twice) and only mark the pairs that match.
    const active = new Map();
    const close = (a) => { const n = active.get(a) || 0; if (n > 0) { active.set(a, n - 1); return '-'; } return ''; };
    for (const e of recent) {
      const a = alias.get(e.id);
      if (e.kind === 'started') { active.set(a, (active.get(a) || 0) + 1); lines.push(`  M->>+${a}: ${msg(e.text) || 'task'}`); }
      else if (e.kind === 'message') lines.push(`  M->>${a}: follow-up`);
      else if (e.kind === 'approval_needed') lines.push(`  ${a}-->>M: needs approval`);
      else if (e.kind === 'finished') lines.push(`  ${a}-->>${close(a)}M: report`);
      else if (e.kind === 'error') lines.push(`  ${a}--x${close(a)}M: failed ${msg(e.text)}`);
      else if (e.kind === 'cancelled') lines.push(`  ${a}--x${close(a)}M: stopped`);
    }
    if (!recent.length) lines.push('  Note over M: No delegation yet');
    return lines.join('\n');
  }
  /** A Mermaid box drawn by the chat's own renderer (zoom, full screen, SVG download, code view). */
  function diagramBox(src, label) {
    const el = h('div', { class: 'aui-md sa-diagram', 'aria-label': label });
    el._src = src;
    Markdown.render(el, `\`\`\`mermaid\n${src}\n\`\`\``, {});
    return el;
  }

  /* ---------- inline card for spawn_subagent tool calls ---------- */
  function matchRecord(part) {
    const res = parseMaybeJSON(part.result, null);
    const rid = res && typeof res === 'object' ? (res.id || res.subagent?.id) : null;
    if (rid && records.has(String(rid))) return records.get(String(rid));
    const a = part.args || {};
    const mainKey = appRef?.chat?.mainId;
    const cands = [...records.values()].filter((r) => !mainKey || !r.parentSessionKey || r.parentSessionKey === mainKey);
    if (a.name) { const byName = cands.filter((r) => r.name === a.name).sort((x, y) => num(y.createdAt) - num(x.createdAt))[0]; if (byName) return byName; }
    if (a.task) { const t = String(a.task).slice(0, 200); const byTask = cands.find((r) => String(r.task || '').slice(0, 200) === t); if (byTask) return byTask; }
    return null;
  }
  function renderCard(part) {
    const root = h('div', { class: 'sa-card', 'data-slot': 'subagent-card', role: 'group', 'aria-label': 'Sub-agent' });
    let unsub = null;
    let lastSig = '';
    const paint = () => {
      if (!root.isConnected && unsub && lastSig) { unsub(); unsub = null; return; }
      const r = matchRecord(part);
      const a = part.args || {};
      const name = r?.name || a.name || 'Sub-agent';
      const status = r?.status || (part.result !== undefined ? (part.isError ? 'error' : 'finished') : 'running');
      const l = r ? live.get(r.id) : null;
      const sig = JSON.stringify([name, status, r?.steps, r?.toolCalls, r?.totalTokens, l?.preview, l?.toolLog?.length, l?.toolLog?.map((t) => t.state).join(), r?.result, r?.error]);
      if (sig === lastSig) return;
      lastSig = sig;
      const busy = isRunning({ status });
      const budget = r?.tokenBudget || settings.defaultTokenBudget;
      const tools = (l?.toolLog || []).slice(-4);
      const stopBtn = h('button', { type: 'button', class: 'btn btn-outline btn-xs sa-stop', disabled: !r || !busy, 'aria-label': `Stop ${name}`, onclick: async () => { stopBtn.disabled = true; await stop(r.id); } }, icon('square'), 'Stop');
      const openBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-open', disabled: !r, 'aria-label': `Open ${name}`, onclick: () => open(appRef, { id: r.id }) }, icon('arrow-up-right'), 'Open');
      const treeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-tree', 'aria-label': 'Show agent diagram', onclick: () => open(appRef, { tab: 'diagram' }) }, icon('workflow'), 'Diagram');
      root.dataset.status = status;
      root.replaceChildren(
        h('div', { class: 'sa-card-head' },
          h('span', { class: 'sa-card-icon', 'aria-hidden': 'true' }, icon(busy ? 'loader-circle' : 'bot', busy ? 'spin' : '')),
          h('div', { class: 'sa-card-title' }, h('p', { class: 'truncate' }, name), h('p', { class: 'sa-card-sub truncate' }, a.task ? truncate(String(a.task), 120) : (r?.task || ''))),
          statusChip(status)),
        h('div', { class: 'sa-card-stats', 'aria-live': 'polite' },
          h('span', null, `${r?.steps ?? 0}${r?.maxSteps ? `/${r.maxSteps}` : ''} steps`),
          h('span', null, `${r?.toolCalls ?? 0} tool calls`),
          h('span', null, `${fmtTokens(r?.totalTokens || 0)} / ${fmtTokens(budget)} tokens`)),
        meter(r?.totalTokens || 0, budget, `${name} token use`),
        tools.length ? h('ul', { class: 'sa-card-tools' }, ...tools.map((t) => h('li', { 'data-state': t.state }, icon(t.state === 'running' ? 'loader-circle' : t.state === 'error' ? 'circle-exclamation-point' : 'check', t.state === 'running' ? 'spin' : ''), h('code', { class: 'truncate' }, t.tool)))) : null,
        busy && l?.preview ? h('p', { class: 'sa-card-preview' }, truncate(l.preview, 240)) : null,
        !busy && (r?.error || r?.result) ? h('p', { class: 'sa-card-preview', 'data-type': r?.error ? 'error' : 'ok' }, truncate(r?.error || r?.result || '', 400)) : null,
        h('div', { class: 'sa-card-actions' }, treeBtn, h('span', { class: 'sa-spacer' }), openBtn, stopBtn));
    };
    paint();
    unsub = subscribe(paint);
    if (!records.size && available()) refresh().catch(() => {});
    return root;
  }

  /* ---------- actions ---------- */
  async function act(action, extra, okText) {
    try { const r = await call(action, extra); if (okText) toast(okText, { type: 'success' }); await refresh().catch(() => {}); return r; } catch (e) { toast(redactSecrets(e?.message || String(e), 300), { type: 'error' }); return undefined; }
  }
  const stop = (id) => act('stop', { id }, 'Stop requested.');
  const retry = (id) => act('retry', { id }, 'Running again.');
  const message = async (id, text) => { const r = await act('message', { id, message: text }, 'Message sent.'); if (r) { const rec = records.get(id); if (rec) pushLog({ kind: 'message', id, name: rec.name }); notify(); } return r; };
  const remove = (id) => act('delete', { id }, 'Sub-agent deleted.').then((r) => { if (r) { records.delete(id); live.delete(id); notify(); } return r; });

  /* ---------- transcript ---------- */
  function transcriptView(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return h('p', { class: 'field-hint' }, 'No messages saved for this sub-agent yet.');
    const textOf = (c) => {
      if (typeof c === 'string') return c;
      if (!Array.isArray(c)) return c && typeof c === 'object' ? (c.text || '') : '';
      return c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'tool_use' ? `\u2192 ${b.name}(${truncate(JSON.stringify(b.input || {}), 160)})` : b?.type === 'tool_result' ? `\u2190 ${truncate(typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''), 240)}` : '')).filter(Boolean).join('\n');
    };
    return h('ol', { class: 'sa-transcript' }, ...list.slice(-200).map((m) => {
      const role = String(m?.role || 'assistant');
      const text = textOf(m?.content ?? m?.text ?? '');
      const body = h('div', { class: 'sa-msg-body aui-md' });
      if (role === 'assistant') Markdown.render(body, truncate(text, 20000), {}); else body.textContent = truncate(text, 20000);
      return h('li', { class: 'sa-msg', 'data-role': role }, h('p', { class: 'sa-msg-role' }, role === 'user' ? 'Task / input' : role === 'assistant' ? 'Sub-agent' : role), body);
    }));
  }

  /* ---------- the Agents screen ---------- */
  const select = (label, value, options, onChange, extra = {}) => {
    const sel = h('select', { class: 'select select-sm', 'aria-label': label, onchange: () => onChange(sel.value), ...extra },
      ...options.map(([v, text, short]) => h('option', { value: v, selected: v === value, dataset: short ? { short } : null }, text)));
    sel.value = value;
    return sel;
  };
  const labelled = (label, control, hint) => {
    const id = control.id || (control.id = `sa-${uid(6)}`);
    return h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), control, hint ? h('p', { class: 'field-hint' }, hint) : null);
  };
  const intInput = (value, min, max, label) => h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: String(min), max: String(max), step: '1', value: String(value ?? ''), 'data-label': label });
  function readInt(input) {
    const n = Number(input.value);
    const ok = input.value !== '' && Number.isInteger(n) && n >= Number(input.min) && n <= Number(input.max);
    input.setAttribute('aria-invalid', String(!ok));
    if (!ok) throw new Error(`${input.dataset.label} must be a whole number from ${input.min} to ${input.max}.`);
    return n;
  }

  let openDialogRef = null;
  function open(app, { id = null, tab = 'agents' } = {}) {
    appRef = app || appRef;
    if (openDialogRef?.panel?.isConnected) { openDialogRef.go(tab, id); return openDialogRef; }
    let current = id ? 'detail' : tab;
    let detailId = id;
    let filter = 'all';
    let alive = true;
    const body = h('div', { class: 'sa-screen' });
    const tabs = [['agents', 'Agents'], ['diagram', 'Diagram'], ['presets', 'Presets'], ['settings', 'Limits']];
    const tablist = h('div', { class: 'segmented sa-tabs', role: 'tablist', 'aria-label': 'Agents sections' });
    const panel = h('div', { class: 'sa-panel', role: 'tabpanel', id: `sa-panel-${uid(5)}` });
    const go = (t, d) => { current = d ? 'detail' : t; detailId = d || null; paintTabs(); paint(true); };
    function paintTabs() {
      const active = current === 'detail' ? 'agents' : current;
      tablist.replaceChildren(...tabs.map(([t, label]) => h('button', {
        type: 'button', role: 'tab', class: 'segmented-item', 'aria-selected': String(t === active), tabindex: t === active ? '0' : '-1', 'aria-controls': panel.id, 'data-tab': t,
        onclick: () => go(t), onkeydown: (e) => {
          const i = tabs.findIndex((x) => x[0] === t);
          const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
          if (n < 0) return;
          e.preventDefault(); go(tabs[n][0]); tablist.querySelector(`[data-tab="${tabs[n][0]}"]`)?.focus();
        },
      }, label)));
    }

    let lastListSig = '';
    let diagramTimer = 0;
    function paint(force = false) {
      if (!alive) return;
      if (!available()) {
        panel.replaceChildren(h('p', { class: 'settings-note', 'data-type': 'info' }, icon('info'), h('span', null, 'Sub-agents need the newer app engine. Update the app, then open this screen again.')));
        return;
      }
      if (current === 'agents') paintList(force);
      else if (current === 'detail') { if (force) paintDetail(); else paintDetailLive(); }
      else if (current === 'diagram') { clearTimeout(diagramTimer); diagramTimer = setTimeout(() => paintDiagram(force), force ? 0 : 700); }
      else if (force) { if (current === 'presets') paintPresets(); else paintSettings(); }
    }

    function paintList(force) {
      const all = [...records.values()].sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || num(b.createdAt) - num(a.createdAt));
      const shown = all.filter((r) => filter === 'all' || (filter === 'running' ? isRunning(r) : !isRunning(r)));
      const sig = JSON.stringify([filter, shown.map((r) => [r.id, r.status, r.steps, r.totalTokens, r.toolCalls])]);
      if (!force && sig === lastListSig) return;
      lastListSig = sig;
      const running = all.filter(isRunning).length;
      const hadFocus = panel.contains(doc.activeElement) ? doc.activeElement?.dataset?.focusKey : null;
      const filterSel = select('Show', filter, [['all', `All (${all.length})`, 'All'], ['running', `Running (${running})`, 'Running'], ['finished', `Finished (${all.length - running})`, 'Finished']], (v) => { filter = v; paintList(true); });
      const stopAll = h('button', { type: 'button', class: 'btn btn-outline btn-sm', disabled: !running, onclick: () => confirmDialog({ title: 'Stop every running sub-agent?', description: `${running} running now. Each one stops before its next step and keeps what it has done so far.`, confirmLabel: 'Stop all', destructive: true, onConfirm: () => act('stop', { all: true }, 'Stop requested for all.') }) }, icon('square'), 'Stop all');
      const refreshBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Refresh', onclick: async () => { refreshBtn.disabled = true; try { await refresh(); } catch (e) { toast(redactSecrets(e?.message || String(e), 300), { type: 'error' }); } refreshBtn.disabled = false; paintList(true); } }, icon('refresh-cw'));
      const rows = shown.map((r) => h('li', { class: 'sa-row', 'data-status': r.status },
        h('button', { type: 'button', class: 'sa-row-main', 'data-focus-key': `row-${r.id}`, onclick: () => go('agents', r.id), 'aria-label': `${r.name}, ${STATUS_LABEL[r.status] || r.status}` },
          h('span', { class: 'sa-card-icon', 'aria-hidden': 'true' }, icon(isRunning(r) ? 'loader-circle' : 'bot', isRunning(r) ? 'spin' : '')),
          h('span', { class: 'sa-row-text' }, h('span', { class: 'sa-row-name truncate' }, r.name), h('span', { class: 'sa-row-sub truncate' }, r.task || r.role || '')),
          h('span', { class: 'sa-row-meta' }, statusChip(r.status), h('span', { class: 'sa-row-tokens' }, `${fmtTokens(r.totalTokens)} tok · ${r.steps} steps`))),
        meter(r.totalTokens, r.tokenBudget || settings.defaultTokenBudget, `${r.name} token use`)));
      panel.replaceChildren(
        h('div', { class: 'sa-toolbar' }, filterSel, h('span', { class: 'sa-spacer' }), refreshBtn, stopAll),
        h('p', { class: 'field-hint' }, `${running} of ${settings.maxParallel} parallel slots in use · depth limit ${settings.maxDepth}`),
        rows.length ? h('ul', { class: 'sa-list' }, ...rows) : h('div', { class: 'sa-empty' }, icon('bot'), h('p', null, all.length ? 'Nothing matches this filter.' : 'No sub-agents yet. The agent starts them for big jobs, or you can start one from a preset.')));
      if (hadFocus) panel.querySelector(`[data-focus-key="${hadFocus}"]`)?.focus({ preventScroll: true });
    }

    let detailData = null;
    async function paintDetail() {
      const r = records.get(detailId);
      if (!r) { panel.replaceChildren(h('p', { class: 'field-hint' }, 'This sub-agent is gone.'), h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => go('agents') }, icon('chevron-left'), 'Back')); return; }
      panel.replaceChildren(h('p', { class: 'field-hint settings-loading' }, icon('loader-circle', 'spin'), 'Loading…'));
      const want = detailId;
      try { detailData = await call('get', { id: want }); } catch (e) { detailData = { error: e?.message || String(e) }; }
      if (!alive || detailId !== want || current !== 'detail') return;
      buildDetail();
    }
    let detailSig = '';
    function paintDetailLive() {
      const r = records.get(detailId);
      const sig = JSON.stringify([r?.status, r?.steps, r?.totalTokens, r?.toolCalls]);
      if (sig === detailSig) return;
      // Re-fetch the transcript when the run ends; otherwise just repaint the header numbers.
      const ended = r && !isRunning(r) && detailSig && JSON.parse(detailSig)[0] !== r.status;
      detailSig = sig;
      if (ended) paintDetail(); else if (detailData) buildDetail();
    }
    function buildDetail() {
      const r = records.get(detailId) || normalize(detailData?.subagent);
      if (!r) return;
      detailSig = JSON.stringify([r.status, r.steps, r.totalTokens, r.toolCalls]);
      const busy = isRunning(r);
      const back = h('button', { type: 'button', class: 'btn btn-ghost btn-sm sa-back', onclick: () => go('agents') }, icon('chevron-left'), 'All agents');
      const msgInput = h('textarea', { class: 'textarea sa-msg-input', rows: '2', maxlength: '4000', placeholder: busy ? 'Message reaches it before its next step' : 'Follow-up: it picks up where it left off', 'aria-label': `Message ${r.name}` });
      const sendBtn = h('button', { type: 'button', class: 'btn btn-default btn-sm', onclick: async () => {
        const text = msgInput.value.trim();
        if (!text) { msgInput.setAttribute('aria-invalid', 'true'); msgInput.focus(); return; }
        if (sendBtn.disabled) return;
        sendBtn.disabled = true;
        const ok = await message(r.id, text);
        sendBtn.disabled = false;
        if (ok) msgInput.value = '';
      } }, icon('send'), 'Send');
      const actions = h('div', { class: 'sa-detail-actions' },
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', disabled: !busy, onclick: (e) => { e.currentTarget.disabled = true; stop(r.id); } }, icon('square'), 'Stop'),
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', disabled: busy, onclick: (e) => { e.currentTarget.disabled = true; retry(r.id); } }, icon('rotate-ccw'), 'Retry'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm sa-danger', disabled: busy, onclick: () => confirmDialog({ title: `Delete ${r.name}?`, description: 'Its saved chat and record are removed. Its memory stays until you clear it below.', confirmLabel: 'Delete', destructive: true, onConfirm: async () => { if (await remove(r.id)) go('agents'); } }) }, icon('trash'), 'Delete'));
      const memory = Array.isArray(detailData?.memory) ? detailData.memory : [];
      const memList = memory.length ? h('ul', { class: 'sa-mem' }, ...memory.slice(0, 200).map((m) => h('li', { class: 'sa-mem-row' },
        h('div', { class: 'sa-mem-text' }, h('code', { class: 'truncate' }, String(m.key || '')), h('p', null, truncate(String(m.text || ''), 300))),
        h('div', { class: 'sa-mem-actions' },
          iconButton('Copy to main memory', icon('arrow-up-right'), () => memOp(r, 'promote', m.key, 'Copied to main memory.')),
          iconButton('Delete entry', icon('trash'), () => memOp(r, 'delete', m.key, 'Entry deleted.')))))) : h('p', { class: 'field-hint' }, 'No memory entries.');
      const kv = (k, v) => h('div', { class: 'sa-kv' }, h('dt', null, k), h('dd', null, v));
      panel.replaceChildren(
        h('div', { class: 'sa-toolbar' }, back, h('span', { class: 'sa-spacer' }), statusChip(r.status)),
        h('h3', { class: 'sa-detail-name' }, r.name),
        r.task ? h('p', { class: 'sa-detail-task' }, truncate(r.task, 1000)) : null,
        detailData?.error ? h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, redactSecrets(detailData.error, 300))) : null,
        h('section', { class: 'sa-section', 'aria-label': 'Usage' },
          h('h4', null, 'Tokens'),
          h('dl', { class: 'sa-kvs' }, kv('Input', fmtTokens(r.inputTokens)), kv('Output', fmtTokens(r.outputTokens)), kv('Total', `${fmtTokens(r.totalTokens)} of ${fmtTokens(r.tokenBudget || settings.defaultTokenBudget)}`), kv('Steps', `${r.steps} of ${r.maxSteps || settings.defaultMaxSteps}`), kv('Tool calls', String(r.toolCalls)), kv('Model', r.model || 'Same as main')),
          meter(r.totalTokens, r.tokenBudget || settings.defaultTokenBudget, 'Token use')),
        actions,
        h('section', { class: 'sa-section', 'aria-label': 'Message' }, h('h4', null, 'Message'), msgInput, h('div', { class: 'row-actions' }, sendBtn)),
        h('section', { class: 'sa-section', 'aria-label': 'Tools' }, h('h4', null, `Tools (${r.tools.length})`), r.tools.length ? h('div', { class: 'sa-tool-chips' }, ...r.tools.map((t) => h('code', { class: 'sa-chip' }, t))) : h('p', { class: 'field-hint' }, 'Same tools as the main agent, minus the app\u2019s UI tools.')),
        h('section', { class: 'sa-section', 'aria-label': 'Memory' },
          h('div', { class: 'sa-toolbar' }, h('h4', null, `Memory \u00b7 ${(MEMORY_MODES.find((m) => m[0] === r.memoryMode) || [0, r.memoryMode])[1]}`), h('span', { class: 'sa-spacer' }),
            h('button', { type: 'button', class: 'btn btn-ghost btn-xs', disabled: !memory.length, onclick: () => memOp(r, 'promote', null, 'All entries copied to main memory.') }, 'Copy all'),
            h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-danger', disabled: !memory.length, onclick: () => confirmDialog({ title: `Clear ${r.name}\u2019s memory?`, description: `${memory.length} entries are deleted. Your main memory is not touched.`, confirmLabel: 'Clear', destructive: true, onConfirm: () => memOp(r, 'clear', null, 'Memory cleared.') }) }, 'Clear')),
          memList),
        h('section', { class: 'sa-section', 'aria-label': 'Transcript' }, h('h4', null, 'Transcript'), transcriptView(detailData?.transcript)),
        !busy && (r.result || r.error) ? h('section', { class: 'sa-section', 'aria-label': 'Report' }, h('h4', null, r.error ? 'Error' : 'Report'), h('p', { class: 'sa-detail-task' }, truncate(r.error || r.result, 4000))) : null);
    }
    async function memOp(r, op, key, okText) {
      const extra = { op, name: r.name };
      if (key) extra.key = key;
      try { await call('memory', extra); toast(okText, { type: 'success' }); } catch (e) { toast(redactSecrets(e?.message || String(e), 300), { type: 'error' }); }
      paintDetail();
    }

    let diagSig = '';
    function paintDiagram(force) {
      if (!alive || current !== 'diagram') return;
      const tree = treeSource();
      const seq = sequenceSource();
      if (!force && tree + seq === diagSig) return;
      diagSig = tree + seq;
      panel.replaceChildren(
        h('p', { class: 'field-hint' }, 'Updates live while sub-agents run. Blue running, amber needs approval, green finished, red failed, grey stopped.'),
        h('section', { class: 'sa-section', 'aria-label': 'Agent tree' }, h('h4', null, 'Agent tree'), diagramBox(tree, 'Agent tree diagram')),
        h('section', { class: 'sa-section', 'aria-label': 'Delegation' }, h('h4', null, 'Delegation'), diagramBox(seq, 'Delegation sequence diagram')));
    }

    function paintPresets() {
      const presets = loadPresets();
      let editing = null;
      const listEl = h('ul', { class: 'sa-list' });
      const formHost = h('div');
      const toolNames = () => knownToolNames(appRef).filter((n) => !n.startsWith('ui__') && !SUBAGENT_TOOLS.includes(n));
      const renderList = () => listEl.replaceChildren(...(presets.length ? presets.map((p) => h('li', { class: 'sa-row' },
        h('div', { class: 'sa-row-main sa-row-static' }, h('span', { class: 'sa-card-icon', 'aria-hidden': 'true' }, icon('bot')),
          h('span', { class: 'sa-row-text' }, h('span', { class: 'sa-row-name truncate' }, p.name), h('span', { class: 'sa-row-sub truncate' }, [p.role, p.model, (MEMORY_MODES.find((m) => m[0] === p.memory) || [])[2]].filter(Boolean).join(' \u00b7 ') || 'Default settings'))),
        h('div', { class: 'sa-preset-actions' },
          h('button', { type: 'button', class: 'btn btn-default btn-xs', onclick: () => runPreset(p) }, icon('play'), 'Run'),
          iconButton(`Edit ${p.name}`, icon('pencil'), () => { editing = p; renderForm(); }),
          iconButton(`Delete ${p.name}`, icon('trash'), () => confirmDialog({ title: `Delete preset ${p.name}?`, confirmLabel: 'Delete', destructive: true, onConfirm: () => { presets.splice(presets.indexOf(p), 1); savePresets(presets); renderList(); } }))))) : [h('li', { class: 'sa-empty' }, h('p', null, 'No presets yet. A preset saves a role, a prompt and limits you reuse.'))]));
      function renderForm() {
        const p = editing || {};
        const name = h('input', { class: 'input', type: 'text', maxlength: '40', value: p.name || '', placeholder: 'researcher', autocomplete: 'off', spellcheck: false });
        const role = h('input', { class: 'input', type: 'text', maxlength: '80', value: p.role || '', placeholder: 'Researcher' });
        const prompt = h('textarea', { class: 'textarea', rows: '3', maxlength: '4000', placeholder: 'Extra instructions for this sub-agent' });
        prompt.value = p.prompt || '';
        const models = (appRef?.chat?.settings?.modelsFor?.(appRef?.chat?.settings?.provider) || []).slice(0, 200);
        const model = select('Model', p.model || '', [['', 'Same as main agent', 'Main model'], ...models.map((m) => [m.id, m.name || m.id])].concat(p.model && !models.some((m) => m.id === p.model) ? [[p.model, p.model]] : []), () => {});
        const memory = select('Memory', p.memory || settings.defaultMemory, MEMORY_MODES, () => {});
        const budget = intInput(p.tokenBudget || settings.defaultTokenBudget, 1000, 10000000, 'Token budget');
        const steps = intInput(p.maxSteps || settings.defaultMaxSteps, 1, 200, 'Max steps');
        const chosen = new Set(Array.isArray(p.tools) ? p.tools : []);
        const names = toolNames();
        const toolBox = h('div', { class: 'sa-tool-pick', role: 'group', 'aria-label': 'Allowed tools' }, ...(names.length ? names : [...chosen]).map((t) => {
          const cb = h('input', { type: 'checkbox', checked: chosen.has(t), onchange: () => (cb.checked ? chosen.add(t) : chosen.delete(t)) });
          return h('label', { class: 'sa-tool-opt' }, cb, h('code', { class: 'truncate' }, t));
        }));
        const save = h('button', { type: 'button', class: 'btn btn-default btn-sm', onclick: () => {
          const n = name.value.trim();
          if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u.test(n)) { name.setAttribute('aria-invalid', 'true'); toast('Give the preset a name: letters, numbers, space, _ . or -.', { type: 'error' }); name.focus(); return; }
          if (presets.some((x) => x !== editing && x.name.toLowerCase() === n.toLowerCase())) { name.setAttribute('aria-invalid', 'true'); toast('A preset with that name already exists.', { type: 'error' }); return; }
          let tb, ms;
          try { tb = readInt(budget); ms = readInt(steps); } catch (e) { toast(e.message, { type: 'error' }); return; }
          const next = { id: editing?.id || uid(10), name: n, role: role.value.trim(), prompt: prompt.value.trim(), model: model.value, memory: memory.value, tokenBudget: tb, maxSteps: ms, tools: [...chosen] };
          if (editing) presets.splice(presets.indexOf(editing), 1, next); else presets.push(next);
          if (!savePresets(presets)) toast('Couldn\u2019t save: storage is blocked.', { type: 'error' });
          editing = null; renderList(); renderForm(); toast('Preset saved.', { type: 'success' });
        } }, icon('check'), editing ? 'Save preset' : 'Add preset');
        formHost.replaceChildren(h('section', { class: 'sa-section sa-form', 'aria-label': editing ? 'Edit preset' : 'New preset' },
          h('h4', null, editing ? `Edit ${p.name}` : 'New preset'),
          h('div', { class: 'sa-grid' }, labelled('Name', name), labelled('Role', role), labelled('Model', model), labelled('Memory', memory), labelled('Token budget', budget), labelled('Max steps', steps)),
          labelled('Instructions', prompt),
          h('div', { class: 'field' }, h('p', { class: 'field-label' }, `Allowed tools (${names.length ? 'none picked = same as main' : 'load the agent first'})`), toolBox),
          h('div', { class: 'row-actions' }, editing ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { editing = null; renderForm(); } }, 'Cancel') : null, save)));
      }
      renderList(); renderForm();
      panel.replaceChildren(listEl, formHost);
    }
    function runPreset(p) {
      const task = h('textarea', { class: 'textarea', rows: '4', maxlength: '8000', placeholder: 'What should it do?', 'aria-label': 'Task' });
      let dlg = null;
      const go2 = h('button', { type: 'button', class: 'btn btn-default', onclick: async () => {
        if (!task.value.trim()) { task.setAttribute('aria-invalid', 'true'); task.focus(); return; }
        if (go2.disabled) return;
        go2.disabled = true;
        const r = await act('spawn', presetToSpec(p, task.value), `${p.name} started.`);
        go2.disabled = false;
        if (r) { dlg.close(); const id = r.subagent?.id; if (id) { upsert(r.subagent); go('agents', String(id)); } else go('agents'); }
      } }, icon('play'), 'Start');
      dlg = openDialog({ title: `Run ${p.name}`, description: 'It works on its own with only this task, then sends back one short report.', body: task, size: 'sm', footer: [h('button', { type: 'button', class: 'btn btn-outline', onclick: () => dlg.close() }, 'Cancel'), go2], initialFocus: task });
    }

    function paintSettings() {
      const s = settings;
      const enabled = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: s.enabled !== false, 'aria-label': 'Let the agent start sub-agents' });
      const depth = intInput(s.maxDepth, 0, 3, 'Max depth');
      const parallel = intInput(s.maxParallel, 1, 8, 'Max parallel');
      const budget = intInput(s.defaultTokenBudget, 1000, 10000000, 'Default token budget');
      const steps = intInput(s.defaultMaxSteps, 1, 200, 'Default steps');
      const timeout = intInput(s.timeoutSeconds, 10, 3600, 'Timeout');
      const memory = select('Default memory', s.defaultMemory || 'private', MEMORY_MODES, () => {});
      const save = h('button', { type: 'button', class: 'btn btn-default btn-sm', onclick: async () => {
        let next;
        try { next = { enabled: enabled.checked, maxDepth: readInt(depth), maxParallel: readInt(parallel), defaultTokenBudget: readInt(budget), defaultMaxSteps: readInt(steps), timeoutSeconds: readInt(timeout), defaultMemory: memory.value }; } catch (e) { toast(e.message, { type: 'error' }); return; }
        if (save.disabled) return;
        save.disabled = true;
        const r = await act('settings', { settings: next }, 'Limits saved.');
        save.disabled = false;
        if (r?.settings) settings = { ...DEFAULT_SETTINGS, ...r.settings };
        paintSettings();
      } }, icon('check'), 'Save');
      panel.replaceChildren(h('section', { class: 'sa-section' },
        h('div', { class: 'switch-row' }, h('div', null, h('p', { class: 'field-label' }, 'Let the agent start sub-agents'), h('p', { class: 'field-hint' }, 'Off hides the four sub-agent tools from the agent.')), enabled),
        h('div', { class: 'sa-grid' },
          labelled('Max depth', depth, '1 = sub-agents can\u2019t start their own'), labelled('Max parallel', parallel, '1 to 8 at once'),
          labelled('Default token budget', budget, 'Input + output, all steps'), labelled('Default steps', steps, 'Model calls per run'),
          labelled('Timeout (seconds)', timeout, '10 to 3600'), labelled('Default memory', memory)),
        h('p', { class: 'field-hint' }, 'Your tool rules and approval settings apply to sub-agents too.'),
        h('div', { class: 'row-actions' }, save)));
    }

    const unsub = subscribe(() => paint(false));
    paintTabs();
    body.append(tablist, panel);
    const dialog = openDialog({ title: 'Agents', description: 'Sub-agents the agent started, their work and limits.', body, size: 'lg', align: 'top', onClose: () => { alive = false; unsub(); openDialogRef = null; clearTimeout(diagramTimer); } });
    dialog.panel.classList.add('sa-dialog');
    openDialogRef = { ...dialog, go };
    paint(true);
    refresh().then(() => paint(current !== 'detail')).catch((e) => { if (alive && current === 'agents') panel.prepend(h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, redactSecrets(e?.message || String(e), 300)))); });
    return openDialogRef;
  }

  /* ---------- install ---------- */
  function install(app) {
    appRef = app;
    if (installed) return;
    installed = true;
    TOOLKIT.spawn_subagent = { ...(TOOLKIT.spawn_subagent || {}), ui: renderCard };
    for (const footer of doc.querySelectorAll('.sidebar-footer')) {
      const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm sa-open-screen', hidden: true, onclick: () => { app.setMobileSidebar?.(false); open(app); } }, icon('bot'), 'Agents');
      const files = footer.querySelector('.fm-open');
      if (files) files.before(btn); else footer.prepend(btn);
    }
    const sync = () => { for (const b of doc.querySelectorAll('.sa-open-screen')) b.hidden = !available(); };
    engine.load().then(sync, sync);
    const runtime = app.chat;
    if (runtime && typeof runtime._onEvent === 'function' && !runtime._saWrapped) {
      const base = runtime._onEvent.bind(runtime);
      runtime._saWrapped = true;
      runtime._onEvent = (event) => {
        const type = event?.eventType ?? event?.type ?? '';
        if (typeof type === 'string' && type.startsWith('subagent.')) {
          const n = parseMaybeJSON(event?.payloadJson ?? event?.payload, {}) || {};
          eventLog.add(type, { id: n.id, name: n.name, status: n.status });
          try { onEvent(type, n); } catch (e) { console.warn('subagent event', e); }
          return;
        }
        return base(event);
      };
    }
    // The engine may start sub-agents before this page loaded: pick them up once the agent is ready.
    runtime?.on?.('native', () => { sync(); if (available() && !records.size) refresh().catch(() => {}); });
  }

  const api = { knownToolNames, SUBAGENT_TOOLS, install, open, refresh, onEvent, records, log, treeSource, sequenceSource, available, subscribe, presetToSpec, loadPresets, get settings() { return settings; } };
  if (typeof window !== 'undefined') window.__subagents = api;
  return api;
})();
