/* ==========================================================================
   Per-agent view (PARITY_PLAN.md phase 2+): one page with tabs for any agent at
   any depth, opened from the Agents panel. Overview is the full detail page
   (10-subagents.js buildDetail); every other tab is rendered here from a context
   object buildDetail hands over (record, engine call, helpers), so this module
   holds no state of its own beyond small caches of what the engine returned.
   ========================================================================== */
const AgentTabs = (() => {
  // [id, label, icon]. Only finished tabs are listed; later phases add theirs.
  const TABS = [
    ['overview', 'Overview', 'layout-dashboard'],
    ['chat', 'Chat', 'message-square'],
    ['tools', 'Tools', 'wrench'],
    ['settings', 'Settings', 'sliders-horizontal'],
    ['context', 'Context', 'gauge'],
    ['activity', 'Activity', 'activity'],
  ];
  // Lucide icons this view uses that the page may not have yet.
  const extraIcons = {
    'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    'message-square': '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
    activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    'maximize-2': '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
    'sliders-horizontal': '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
    'git-fork': '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  };
  if (typeof ICONS !== 'undefined') for (const [k, v] of Object.entries(extraIcons)) if (!ICONS[k]) ICONS[k] = v;
  const has = (t) => TABS.some(([id]) => id === t);
  const cache = new Map(); // `${kind}:${id}` -> engine answer, so a live repaint does not blank a tab

  /** The scrollable tab bar: role=tablist, arrow keys, Home/End. */
  function bar(active, onPick) {
    const el = h('div', { class: 'sa-vtabs scroll-thin', role: 'tablist', 'aria-label': 'Agent sections', 'data-slot': 'agent-view-tabs' });
    const pick = (t) => { onPick(t); requestAnimationFrame(() => doc.querySelector(`[data-slot="agent-view-tabs"] [data-tab="${t}"]`)?.focus()); };
    for (const [id, label, ic] of TABS) {
      el.append(h('button', {
        type: 'button', role: 'tab', class: 'sa-vtab', 'data-tab': id, 'aria-selected': String(id === active), tabindex: id === active ? '0' : '-1',
        onclick: () => onPick(id),
        onkeydown: (e) => {
          const i = TABS.findIndex((x) => x[0] === id);
          const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
          if (n < 0) return;
          e.preventDefault(); pick(TABS[n][0]);
        },
      }, icon(ic), h('span', null, label)));
    }
    // Keep the active tab in view on a narrow screen.
    requestAnimationFrame(() => el.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
    return el;
  }

  const section = (label, slot, ...kids) => h('section', { class: 'sa-section', 'aria-label': label, 'data-slot': slot }, h('h4', null, label), ...kids);
  const hint = (text) => h('p', { class: 'field-hint' }, text);
  const when = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };

  /** Fetch once per paint; show the cached answer at once, then refresh in place. */
  function loadInto(box, key, fetcher, paint) {
    if (cache.has(key)) paint(cache.get(key)); else setChildren(box, h('p', { class: 'field-hint settings-loading' }, icon('loader-circle', 'spin'), 'Loading…'));
    fetcher().then((v) => {
      const same = JSON.stringify(v) === JSON.stringify(cache.get(key));
      cache.set(key, v);
      if (!same || !box.childElementCount || box.querySelector('.settings-loading')) paint(v);
    }).catch((e) => setChildren(box, h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, redactSecrets(e?.message || String(e), 300)))));
    return box;
  }

  /* ---- Chat: the same thread and composer as Overview's, plus the full-screen chat ---- */
  function chatTab(ctx) {
    return h('div', { class: 'sa-vpane', 'data-slot': 'agent-tab-chat' },
      ctx.openChat ? h('div', { class: 'row-actions sa-vrow' },
        h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'agent-tab-open-chat', onclick: ctx.openChat }, icon('maximize-2'), 'Open full-screen chat')) : null,
      ctx.chat());
  }

  /* ---- Tools: what it may use, what runs without asking, and how often each ran ---- */
  function toolStats(log) {
    const m = new Map();
    for (const e of log || []) {
      const t = e.tool || e.approvalTool;
      if (!t) continue;
      const s = m.get(t) || { calls: 0, errors: 0, asks: 0 };
      if (e.event === 'subagent.tool_call' || e.event === 'subagent.tool_use') s.calls += 1;
      if (e.event === 'subagent.tool_result' && e.isError) s.errors += 1;
      if (e.event === 'subagent.approval_needed') s.asks += 1;
      m.set(t, s);
    }
    return m;
  }
  function toolsTab(ctx) {
    const { r } = ctx;
    const box = h('div', { class: 'sa-vpane', 'data-slot': 'agent-tab-tools' });
    const fetcher = async () => {
      const [allows, log] = await Promise.all([
        ctx.call('chatAllows', { sessionKey: r.sessionKey || `subagent:${r.id}` }).catch(() => null),
        ctx.call('log', { id: r.id, limit: 500 }).catch(() => null),
      ]);
      return { allows: allows || {}, log: Array.isArray(log?.log) ? log.log : [] };
    };
    return loadInto(box, `tools:${r.id}`, fetcher, ({ allows, log }) => {
      const own = new Set(allows.agentTools || []);
      const chatWide = new Set(allows.tools || []);
      const inherited = new Map((allows.inherited || []).map((x) => [x.tool, x.from]));
      const stats = toolStats(log);
      const restricted = (r.tools || []).length > 0;
      const known = ctx.knownToolNames(appRefOf()) || [];
      const names = [...new Set([...(restricted ? r.tools : known), ...r.tools, ...stats.keys(), ...own])].filter(Boolean).sort();
      const teamOk = ctx.can('subagentTeam');
      const setUse = async (tool, on) => {
        const base = restricted ? r.tools : names;
        const next = on ? [...new Set([...base, tool])] : base.filter((t) => t !== tool);
        if (!next.length) { toast('An agent needs at least one tool.', { type: 'error' }); return; }
        const res = await ctx.act('configure', { id: r.id, tools: next }, on ? `${tool} can be used.` : `${tool} removed.`);
        if (res?.subagent) ctx.upsert(res.subagent);
        ctx.rebuild();
      };
      const setAllow = async (tool, on) => {
        const res = await ctx.act(on ? 'allowTool' : 'revokeTool', { sessionKey: r.sessionKey || `subagent:${r.id}`, toolName: tool, scope: 'agent' }, on ? `${tool} runs without asking for ${r.name}.` : `${tool} asks first again.`);
        if (res) { cache.delete(`tools:${r.id}`); ctx.rebuild(); }
      };
      const rows = names.map((t) => {
        const s = stats.get(t) || { calls: 0, errors: 0, asks: 0 };
        const usable = !restricted || r.tools.includes(t);
        const allowState = own.has(t) ? 'agent' : chatWide.has(t) ? 'chat' : inherited.has(t) ? 'inherited' : 'ask';
        const allowLabel = { agent: 'Always allowed (this agent)', chat: 'Always allowed (whole chat)', inherited: 'Always allowed (from a parent)', ask: 'Asks first' }[allowState];
        const use = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: usable, disabled: !teamOk, 'aria-label': `${t}: can use`, onchange: (e) => setUse(t, e.target.checked) });
        return h('li', { class: 'sa-vtool', 'data-tool': t, 'data-allow': allowState },
          h('div', { class: 'sa-vtool-main' },
            h('code', { class: 'sa-vtool-name truncate' }, t),
            h('span', { class: 'sa-vtool-stats' }, `${s.calls} call${s.calls === 1 ? '' : 's'}`, s.errors ? h('span', { class: 'sa-danger' }, ` · ${s.errors} failed`) : null, s.asks ? ` · ${s.asks} asked` : null),
            h('span', { class: 'sa-vtool-allow field-hint' }, allowLabel)),
          h('div', { class: 'sa-vtool-ctl' },
            allowState === 'agent'
              ? h('button', { type: 'button', class: 'btn btn-ghost btn-xs', 'data-slot': 'agent-tool-revoke', onclick: () => setAllow(t, false) }, 'Ask first')
              : allowState === 'ask' ? h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-slot': 'agent-tool-allow', disabled: !usable, onclick: () => setAllow(t, true) }, 'Always allow') : null,
            use));
      });
      setChildren(box,
        section('What it can use', 'agent-tools-use',
          hint(restricted ? `Limited to ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}. Never more than its parent has.` : 'Every tool the main agent has. Switch one off to limit this agent.'),
          teamOk ? null : h('p', { class: 'settings-note', 'data-type': 'info' }, icon('info'), h('span', null, 'Changing tools needs the newer app engine.')),
          names.length ? h('ul', { class: 'sa-vtools' }, ...rows) : hint('No tools known yet.')),
        section('Runs without asking', 'agent-tools-allows',
          hint('“Always allow” here covers this agent and the agents it starts, nothing above it.'),
          h('dl', { class: 'sa-kvs' },
            ctx.kv('This agent', own.size ? [...own].join(', ') : 'none'),
            ctx.kv('Whole chat', chatWide.size ? [...chatWide].join(', ') : 'none'),
            ctx.kv('From parents', inherited.size ? [...inherited.keys()].join(', ') : 'none'))));
    });
  }

  /* ---- Activity: everything it did, newest first, with a filter ---- */
  const KINDS = [
    ['all', 'All'], ['tools', 'Tools'], ['asks', 'Permissions'], ['messages', 'Messages'], ['errors', 'Errors'], ['context', 'Context'],
  ];
  const kindOf = (e) => {
    const ev = String(e.event || '');
    if (e.isError || ev === 'subagent.error' || ev === 'subagent.comms_blocked') return ['errors', ev.includes('tool') ? 'tools' : null];
    if (ev.includes('tool')) return ['tools'];
    if (ev.includes('approval') || ev.includes('ask_parent') || ev.includes('parent_answer')) return ['asks'];
    if (ev.includes('message') || ev.includes('broadcast')) return ['messages'];
    if (ev.includes('compaction')) return ['context'];
    return ['run'];
  };
  const EVENT_LABEL = {
    'subagent.queued': 'Queued', 'subagent.started': 'Started', 'subagent.step': 'Step', 'subagent.progress': 'Progress', 'subagent.tool_call': 'Tool call', 'subagent.tool_use': 'Tool call',
    'subagent.tool_result': 'Tool result', 'subagent.approval_needed': 'Asked permission', 'subagent.ask_parent': 'Asked its parent', 'subagent.parent_answer': 'Parent answered',
    'subagent.peer_message': 'Message to a peer', 'subagent.message': 'Message', 'subagent.broadcast': 'Broadcast', 'subagent.comms_blocked': 'Message blocked', 'subagent.compaction': 'Compaction',
    'subagent.finished': 'Finished', 'subagent.error': 'Error', 'subagent.cancelled': 'Stopped', 'subagent.paused': 'Paused', 'subagent.resumed': 'Resumed', 'subagent.reparented': 'Moved', 'subagent.branch_restored': 'Version restored',
  };
  function detailOf(e) {
    const bits = [];
    if (e.tool) bits.push(e.tool);
    if (e.approvalTool) bits.push(e.approvalTool);
    if (e.toName) bits.push(`to ${e.toName}`);
    if (e.compaction?.kind) bits.push(`${e.compaction.kind}${e.compaction.tokensBefore != null && e.compaction.tokensAfter != null ? ` · ${e.compaction.tokensBefore} → ${e.compaction.tokensAfter} tokens` : ''}`);
    const text = e.text || e.question || e.answer || e.report;
    return [bits.join(' · '), text ? String(text) : ''];
  }
  const activityFilter = new Map(); // agent id -> kind
  function activityTab(ctx) {
    const { r } = ctx;
    const box = h('div', { class: 'sa-vpane', 'data-slot': 'agent-tab-activity' });
    const fetcher = async () => { const v = await ctx.call('log', { id: r.id, limit: 500 }); return Array.isArray(v?.log) ? v.log : []; };
    return loadInto(box, `log:${r.id}`, fetcher, (log) => {
      const want = activityFilter.get(r.id) || 'all';
      const counts = Object.fromEntries(KINDS.map(([k]) => [k, 0]));
      for (const e of log) { counts.all += 1; for (const k of kindOf(e)) if (k && k in counts) counts[k] += 1; }
      const shown = log.filter((e) => want === 'all' || kindOf(e).includes(want)).slice().reverse();
      const chips = h('div', { class: 'sa-vchips', role: 'group', 'aria-label': 'Filter activity' }, ...KINDS.map(([k, label]) => h('button', {
        type: 'button', class: 'sa-vchip', 'data-kind': k, 'aria-pressed': String(k === want),
        onclick: () => { activityFilter.set(r.id, k); ctx.rebuild(); },
      }, label, h('span', { class: 'sa-vchip-n' }, String(counts[k] || 0)))));
      const summary = h('dl', { class: 'sa-kvs sa-vsummary' },
        ctx.kv('Tool calls', String(r.toolCalls ?? counts.tools)),
        ctx.kv('Steps', String(r.steps ?? 0)),
        ctx.kv('Tokens', ctx.fmtTokens(ctx.num(r.totalTokens))),
        ctx.kv('Errors', String(counts.errors)),
        r.costUsd != null ? ctx.kv('Cost', `$${Number(r.costUsd).toFixed(4)}`) : null);
      const rows = shown.slice(0, 300).map((e) => {
        const [what, text] = detailOf(e);
        const k = kindOf(e)[0];
        return h('li', { class: 'sa-vevent', 'data-kind': k },
          h('span', { class: 'sa-vevent-time' }, when(e.at)),
          h('div', { class: 'sa-vevent-body' },
            h('p', { class: 'sa-vevent-title' }, EVENT_LABEL[e.event] || String(e.event || 'event').replace(/^subagent\./, ''), what ? h('code', { class: 'sa-vevent-what' }, what) : null),
            text ? h('p', { class: 'sa-vevent-text' }, truncate(text, 280)) : null));
      });
      setChildren(box, summary, chips,
        rows.length ? h('ol', { class: 'sa-vevents', 'aria-label': 'Activity, newest first' }, ...rows) : hint(want === 'all' ? 'Nothing recorded yet.' : 'Nothing of this kind yet.'));
    });
  }

  /* ---- Settings: every per-agent control, each with \u201cuse the default\u201d ---- */
  // [key on the record, label, kind, {min,max,step,hint,nullable}]
  const FIELDS = [
    ['model', 'Model', 'text', { hint: 'Empty = the main agent\u2019s model.' }],
    ['provider', 'Provider', 'text', { hint: 'Empty = the main agent\u2019s provider.' }],
    ['temperature', 'Temperature', 'number', { min: 0, max: 2, step: 0.1, nullable: true, hint: '0\u20132. Empty = the app\u2019s setting.' }],
    ['systemPrompt', 'System prompt', 'textarea', { hint: 'Added to its instructions. Empty = none.' }],
    ['maxChildDepth', 'Levels it may start below itself', 'int', { min: 0, max: 3, nullable: true, hint: '0 = it cannot start agents. Empty = the chat limit.' }],
    ['memoryMode', 'Memory', 'select', {}],
    ['timeoutSeconds', 'Time limit (seconds)', 'int', { min: 10, max: 86400, hint: 'It stops after this long.' }],
    ['tokenBudget', 'Token budget', 'int', { min: 1000, max: 5000000 }],
    ['maxSteps', 'Max steps', 'int', { min: 1, max: 200 }],
    ['peerRateLimit', 'Messages to other agents per minute', 'int', { min: 0, max: 600, nullable: true, hint: '0 = no limit. Empty = the chat-wide limit.' }],
  ];
  const compactionOf = (r) => (r.compaction && typeof r.compaction === 'object' ? r.compaction : null);
  function validate(kind, raw, o) {
    const v = String(raw ?? '').trim();
    if (kind === 'text' || kind === 'textarea' || kind === 'select') return { ok: true, value: v };
    if (!v) return o.nullable ? { ok: true, value: null } : { ok: false, msg: 'Needs a value.' };
    const n = Number(v);
    if (!Number.isFinite(n) || (kind === 'int' && !Number.isInteger(n))) return { ok: false, msg: kind === 'int' ? 'Whole number.' : 'A number.' };
    if (o.min != null && n < o.min) return { ok: false, msg: `At least ${o.min}.` };
    if (o.max != null && n > o.max) return { ok: false, msg: `At most ${o.max}.` };
    return { ok: true, value: n };
  }
  function settingsTab(ctx) {
    const { r } = ctx;
    const teamOk = ctx.can('subagentTeam');
    const inputs = new Map();
    const rows = FIELDS.map(([key, label, kind, o]) => {
      const id = `sa-set-${key}`;
      const cur = r[key];
      let input;
      if (kind === 'select') {
        input = h('select', { id, class: 'select', 'data-key': key }, ...ctx.MEMORY_MODES.map(([v, l]) => h('option', { value: v, selected: v === (cur || 'private') }, l)));
      } else if (kind === 'textarea') {
        input = h('textarea', { id, class: 'textarea', rows: 3, 'data-key': key, placeholder: 'None' });
        input.value = cur || '';
      } else {
        input = h('input', { id, class: 'input', 'data-key': key, type: kind === 'text' ? 'text' : 'number', inputmode: kind === 'int' ? 'numeric' : kind === 'number' ? 'decimal' : undefined, min: o.min, max: o.max, step: o.step || (kind === 'int' ? 1 : undefined), placeholder: o.nullable || kind === 'text' ? 'Default' : '' });
        input.value = cur == null || (kind !== 'text' && cur === 0 && o.nullable && r[key] == null) ? '' : String(cur);
      }
      const err = h('p', { class: 'field-error', role: 'alert', 'data-error-for': key, hidden: true });
      input.addEventListener('input', () => { err.hidden = true; input.removeAttribute('aria-invalid'); });
      inputs.set(key, { input, err, kind, o });
      return h('div', { class: 'field sa-vfield', 'data-field': key }, h('label', { class: 'label', for: id }, label), input, o.hint ? hint(o.hint) : null, err);
    });
    // Compaction: chat default / on / off, plus the threshold.
    const own = compactionOf(r);
    const mode = h('select', { id: 'sa-set-compaction', class: 'select', 'data-key': 'compaction' },
      h('option', { value: 'default', selected: !own }, 'Use the chat setting'),
      h('option', { value: 'on', selected: !!own && own.enabled }, 'On for this agent'),
      h('option', { value: 'off', selected: !!own && !own.enabled }, 'Off for this agent'));
    const thr = h('input', { id: 'sa-set-threshold', class: 'input', type: 'number', inputmode: 'numeric', min: 10, max: 100, step: 5, 'data-key': 'thresholdPercent', value: String(own?.thresholdPercent ?? ctx.settings?.compactThresholdPercent ?? 100) });
    const thrErr = h('p', { class: 'field-error', role: 'alert', 'data-error-for': 'thresholdPercent', hidden: true });
    const syncThr = () => { thr.disabled = mode.value !== 'on'; };
    mode.addEventListener('change', syncThr); syncThr();
    const status = h('p', { class: 'field-hint', 'aria-live': 'polite', 'data-slot': 'agent-settings-status' });
    const save = h('button', { type: 'submit', class: 'btn btn-default btn-sm', 'data-slot': 'agent-settings-save', disabled: !teamOk }, icon('check'), 'Save');
    const form = h('form', { class: 'sa-vpane', 'data-slot': 'agent-tab-settings', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const patch = {}; let bad = false;
      for (const [key, { input, err, kind, o }] of inputs) {
        const res = validate(kind, input.value, o);
        if (!res.ok) { err.textContent = res.msg; err.hidden = false; input.setAttribute('aria-invalid', 'true'); if (!bad) input.focus(); bad = true; continue; }
        const before = r[key] ?? (kind === 'text' || kind === 'textarea' ? '' : null);
        if (JSON.stringify(res.value) !== JSON.stringify(before)) patch[key] = res.value;
      }
      if (mode.value === 'default') { if (own) patch.compaction = null; } else {
        const t = validate('int', thr.value, { min: 10, max: 100 });
        if (!t.ok) { thrErr.textContent = t.msg; thrErr.hidden = false; thr.setAttribute('aria-invalid', 'true'); bad = true; }
        else {
          const next = { enabled: mode.value === 'on', thresholdPercent: t.value };
          if (!own || own.enabled !== next.enabled || (next.enabled && own.thresholdPercent !== next.thresholdPercent)) patch.compaction = next;
        }
      }
      if (bad) { status.textContent = 'Fix the marked fields.'; return; }
      if (!Object.keys(patch).length) { status.textContent = 'Nothing changed.'; return; }
      save.disabled = true;
      const res = await ctx.act('configure', { id: r.id, ...patch }, `Saved ${Object.keys(patch).length} setting${Object.keys(patch).length === 1 ? '' : 's'}.`);
      save.disabled = false;
      if (res?.subagent) { ctx.upsert(res.subagent); status.textContent = 'Saved.'; ctx.rebuild(); }
    } },
      teamOk ? null : h('p', { class: 'settings-note', 'data-type': 'info' }, icon('info'), h('span', null, 'These settings need the newer app engine.')),
      section('Model', 'agent-settings-model', ...rows.slice(0, 4)),
      section('Limits', 'agent-settings-limits', ...rows.slice(4)),
      section('Context compaction', 'agent-settings-compaction',
        h('div', { class: 'field sa-vfield' }, h('label', { class: 'label', for: 'sa-set-compaction' }, 'Auto compaction'), mode,
          hint(`Chat setting: ${ctx.settings?.autoCompact === false ? 'off' : 'on'}, at ${ctx.settings?.compactThresholdPercent ?? 100}%.`)),
        h('div', { class: 'field sa-vfield' }, h('label', { class: 'label', for: 'sa-set-threshold' }, 'Start at (% of its context)'), thr, hint('10\u2013100. Lower = compacts earlier.'), thrErr)),
      h('div', { class: 'row-actions sa-vrow sa-vsave' }, save, status));
    return form;
  }

  /* ---- Context: how full its window is, and every compaction ---- */
  function contextTab(ctx) {
    const { r } = ctx;
    const cs = r.contextStatus && typeof r.contextStatus === 'object' ? r.contextStatus : null;
    const used = ctx.num(cs?.estimatedTokens), budget = ctx.num(cs?.budgetTokens), at = ctx.num(cs?.compactAtTokens);
    const pct = budget ? Math.min(100, Math.round((used / budget) * 100)) : 0;
    const atPct = budget && at ? Math.min(100, Math.round((at / budget) * 100)) : null;
    const meterEl = h('div', { class: 'sa-vmeter', role: 'meter', 'aria-label': 'Context used', 'aria-valuemin': '0', 'aria-valuemax': String(budget || 100), 'aria-valuenow': String(used), 'data-slot': 'agent-context-meter' },
      h('div', { class: 'sa-vmeter-fill', style: `width:${pct}%`, 'data-level': pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low' }),
      atPct != null ? h('div', { class: 'sa-vmeter-at', style: `left:${atPct}%`, title: `Compacts at ${atPct}%` }) : null);
    const own = compactionOf(r);
    const auto = own ? own.enabled : cs?.autoCompact ?? ctx.settings?.autoCompact ?? true;
    const thrPct = own?.thresholdPercent ?? cs?.thresholdPercent ?? ctx.settings?.compactThresholdPercent ?? 100;
    const box = h('div', { class: 'sa-vpane', 'data-slot': 'agent-tab-context' },
      section('Window', 'agent-context-window',
        cs ? h('p', { class: 'sa-vbig', 'data-slot': 'agent-context-used' }, `${ctx.fmtTokens(used)} / ${ctx.fmtTokens(budget)}`, h('span', { class: 'field-hint' }, ` tokens \u00b7 ${pct}%`)) : hint('No model call yet, so nothing measured.'),
        cs ? meterEl : null,
        h('dl', { class: 'sa-kvs' },
          ctx.kv('Auto compaction', `${auto ? 'On' : 'Off'}${own ? ' (this agent)' : ' (chat setting)'}`),
          ctx.kv('Starts at', `${thrPct}%${at ? ` \u00b7 ${ctx.fmtTokens(at)} tokens` : ''}`),
          ctx.kv('Compactions', String(ctx.num(r.compactions))),
          ctx.kv('Tokens used in total', ctx.fmtTokens(ctx.num(r.totalTokens)))),
        h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'agent-context-settings', onclick: () => ctx.pick('settings') }, icon('sliders-horizontal'), 'Change compaction'))),
    );
    const hist = h('div', { 'data-slot': 'agent-context-history' });
    box.append(section('Compaction history', 'agent-context-history-section', hist));
    const fetcher = async () => { const v = await ctx.call('log', { id: r.id, limit: 500 }); return Array.isArray(v?.log) ? v.log : []; };
    loadInto(hist, `log:${r.id}`, fetcher, (log) => {
      const steps = log.filter((e) => e.event === 'subagent.compaction' && e.compaction && e.compaction.phase !== 'started').reverse();
      if (!steps.length && r.lastCompaction) steps.push({ at: r.lastCompaction.at, compaction: r.lastCompaction });
      setChildren(hist, steps.length ? h('ol', { class: 'sa-vevents' }, ...steps.map((e) => {
        const c = e.compaction;
        const saved = c.tokensBefore != null && c.tokensAfter != null ? ctx.num(c.tokensBefore) - ctx.num(c.tokensAfter) : null;
        return h('li', { class: 'sa-vevent', 'data-kind': 'context' }, h('span', { class: 'sa-vevent-time' }, when(e.at || c.at)),
          h('div', { class: 'sa-vevent-body' },
            h('p', { class: 'sa-vevent-title' }, COMPACTION_LABEL[c.kind] || String(c.kind || 'compaction'), c.phase === 'deferred' ? h('span', { class: 'field-hint' }, ' (deferred)') : null),
            h('p', { class: 'sa-vevent-text' }, c.tokensBefore != null && c.tokensAfter != null ? `${c.tokensBefore} \u2192 ${c.tokensAfter} tokens${saved > 0 ? ` (\u2212${saved})` : ''}` : 'No token numbers', c.trigger ? ` \u00b7 ${c.trigger}` : '')));
      })) : hint('No compaction yet.'));
    });
    return box;
  }
  const COMPACTION_LABEL = { tool_results_compacted: 'Old tool results shortened', trim_tool_results: 'Old tool results shortened', explanations_shortened: 'Explanations shortened', compacted: 'Older part summarised', trimmed: 'Oldest messages left out', compaction_deferred: 'Compaction deferred' };

  let appRefOf = () => (typeof window !== 'undefined' ? window.__app : null);
  function render(tab, ctx) {
    try {
      if (tab === 'chat') return chatTab(ctx);
      if (tab === 'tools') return toolsTab(ctx);
      if (tab === 'settings') return settingsTab(ctx);
      if (tab === 'context') return contextTab(ctx);
      if (tab === 'activity') return activityTab(ctx);
    } catch (e) {
      return h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, `This tab failed: ${redactSecrets(e?.message || String(e), 200)}`));
    }
    return hint('Not available.');
  }
  return { TABS, has, bar, render, _cache: cache };
})();
if (typeof window !== 'undefined') window.__agentTabs = AgentTabs;
