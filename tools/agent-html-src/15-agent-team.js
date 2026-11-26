/* ==========================================================================
   Team, Graph and the Main-agent view (PARITY_PLAN.md phase 4).

   Team: who an agent may message (the chat's topology, its own canMessage,
   hidden / hiddenFrom, the engine's live allow matrix with the reason for
   every "no"), the live message timeline, a composer that messages the agent
   or broadcasts, pause / resume / stop / stop-with-sub-agents / move under
   another parent, and the chat's team rules (topology, rate limit, pause all).
   Graph: one agent's neighbourhood (parent, its sub-tree, who it messaged and
   the tools it called) and the whole team with every real parent edge.
   The Main agent gets the same tabs for the chat as a whole.

   Renders from the ctx 10-subagents.js hands over; keeps only caches and the
   drafts typed into its composers, so a live repaint never loses text.
   ========================================================================== */
const AgentTeam = (() => {
  const MAIN_ID = '__main__';
  // All 9 engine topologies, same words as the Swarm tab (AgentSwarm.TOPO wins when it is loaded).
  const TOPOLOGY_LOCAL = {
    tree: ['Tree', 'Up and down only: a parent and the agents it started. No agent-to-agent messages.'],
    star: ['Star', 'Agents at one level talk only through the one with the Hub role, and the hub talks to them. With no Hub there, they cannot message each other.'],
    mesh: ['Mesh', 'Any agent may message any other agent it can see.'],
    ring: ['Ring', 'Each agent passes to the next one at its level.'],
    chain: ['Chain', 'A line: each agent talks to the one before and after it.'],
    bus: ['Bus', 'Agents talk through shared topics and the blackboard, not to each other.'],
    hierarchical: ['Hierarchical', 'Agents talk within their own team (same parent) and up or down to their lead; leads also talk to other leads.'],
    swarm: ['Swarm', 'Any agent may message any other, and peers hand work off, gossip, bid and vote with no fixed leader.'],
    custom: ['Custom', 'Only the allow rules you draw. Nothing else gets through.'],
  };
  const TOPOLOGY = new Proxy({}, { get: (_, k) => ((typeof AgentSwarm !== 'undefined' && AgentSwarm.TOPO) || TOPOLOGY_LOCAL)[k], ownKeys: () => Object.keys((typeof AgentSwarm !== 'undefined' && AgentSwarm.TOPO) || TOPOLOGY_LOCAL), getOwnPropertyDescriptor: (_, k) => ({ enumerable: true, configurable: true, value: ((typeof AgentSwarm !== 'undefined' && AgentSwarm.TOPO) || TOPOLOGY_LOCAL)[k] }) });
  const ROLE_NAMES = { member: 'Member', lead: 'Lead', hub: 'Hub' };
  const KIND_LABEL = { peer: 'Agent to agent', ask_parent: 'Asked its parent', parent_answer: 'Parent answered', broadcast: 'Broadcast', blocked: 'Blocked', user: 'From you' };
  // Engine events that change what Team / Graph / Activity show.
  const LIVE = new Set(['peer_message', 'broadcast', 'ask_parent', 'parent_answer', 'comms_blocked', 'message', 'paused', 'resumed', 'reparented', 'started', 'finished', 'error', 'cancelled', 'tool_call', 'queued']);
  if (typeof ICONS !== 'undefined') {
    const more = {
      send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
      play: '<polygon points="6 3 20 12 6 21 6 3"/>',
      gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
      pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    };
    for (const [k, v] of Object.entries(more)) if (!ICONS[k]) ICONS[k] = v;
  }
  const drafts = new Map(); // composer text per agent, kept across repaints
  const watchers = new Set(); // { el, run } live parts of an open tab
  let liveTimer = 0;

  const T = () => AgentTabs._helpers;
  const isMain = (r) => !!r?.isMain;
  const chatKeyOf = (ctx) => String(ctx.chatKey || ctx.r?.rootSessionKey || ctx.r?.parentSessionKey || '');
  const listOf = (ctx) => { const k = chatKeyOf(ctx); return [...ctx.records.values()].filter((x) => !k || !ctx.chatOf(x) || ctx.chatOf(x) === k); };
  const nameOf = (ctx, id) => (id ? (ctx.records.get(String(id))?.title || ctx.records.get(String(id))?.name || String(id)) : 'Main agent');
  const active = (x) => !!x && ['running', 'queued', 'waiting_approval'].includes(x.status);
  const pane = (slot, ...kids) => h('div', { class: 'sa-vpane', 'data-slot': slot }, ...kids);
  const err = (e) => h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, redactSecrets(e?.message || String(e), 300)));

  /** The agent and every agent below it (ids, the agent first). */
  function subtree(list, id, parentOf) {
    const out = [id];
    for (let i = 0; i < out.length; i += 1) for (const x of list) if (parentOf(x) === out[i] && !out.includes(x.id)) out.push(x.id);
    return out;
  }
  /** Why `id` can't move under `target` ('' when it can). `target` null = the main agent. */
  function reparentProblem(list, id, target, parentOf) {
    const tree = subtree(list, id, parentOf);
    if (target && tree.includes(target)) return 'An agent can\u2019t move under itself or an agent below it.';
    if ((parentOf(list.find((x) => x.id === id)) || null) === (target || null)) return 'It is already there.';
    if (tree.some((t) => active(list.find((x) => x.id === t)))) return 'It or an agent below it is still running. Stop them first.';
    return '';
  }

  /* ---- live: comms events refetch only the live parts, never the composers ---- */
  function watch(el, run) { watchers.add({ el, run }); }
  function noteEvent(kind) {
    if (!LIVE.has(kind)) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      for (const w of [...watchers]) { if (!w.el.isConnected) { watchers.delete(w); continue; } try { w.run(); } catch (e) { console.warn('team live', e); } }
    }, 120);
  }

  /* ---- the message timeline ---- */
  function timelineList(ctx, messages, { only = null } = {}) {
    const rows = (messages || []).filter((m) => !only || m.fromId === only || m.toId === only).slice(-200).reverse();
    if (!rows.length) return T().hint(only ? 'No messages to or from this agent yet.' : 'No messages in this chat yet.');
    return h('ol', { class: 'sa-vevents sa-team-timeline', 'aria-live': 'polite' }, ...rows.map((m) => h('li', { class: 'sa-vevent', 'data-kind': m.kind === 'blocked' ? 'errors' : m.kind === 'ask_parent' || m.kind === 'parent_answer' ? 'asks' : 'messages', 'data-comms-kind': m.kind, 'data-from': m.fromId || 'main', 'data-to': m.toId || 'main' },
      h('span', { class: 'sa-vevent-time' }, T().when(m.at)),
      h('div', { class: 'sa-vevent-body' },
        h('p', { class: 'sa-vevent-title' }, h('span', null, `${m.fromName || nameOf(ctx, m.fromId)} \u2192 ${m.toName || nameOf(ctx, m.toId)}`), h('span', { class: 'sa-vevent-what' }, `${KIND_LABEL[m.kind] || m.kind}${m.status && m.status !== 'sent' ? ` \u00b7 ${m.status}` : ''}`)),
        m.text ? h('p', { class: 'sa-vevent-text' }, truncate(String(m.text), 600)) : null))));
  }
  function timelineSection(ctx, data, fetcher, { only = null, slot = 'agent-team-timeline' } = {}) {
    let scope = only ? 'agent' : 'team';
    const body = h('div', { 'data-slot': `${slot}-list` });
    const draw = (d) => setChildren(body, timelineList(ctx, d?.messages, { only: scope === 'agent' ? only : null }));
    const chips = only ? h('div', { class: 'sa-vchips', role: 'group', 'aria-label': 'Which messages' },
      ...[['agent', 'This agent'], ['team', 'Whole team']].map(([k, l]) => h('button', { type: 'button', class: 'sa-vchip', 'data-scope': k, 'aria-pressed': String(scope === k), onclick: (e) => { scope = k; for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b.dataset.scope === k)); draw(data); } }, l))) : null;
    draw(data);
    const sec = T().section('Messages', slot, T().hint('Live: new messages appear as the agents send them.'), chips, body);
    watch(sec, () => fetcher().then((d) => { data = d; draw(d); }).catch(() => {}));
    return sec;
  }

  /* ---- composer: message one agent, or broadcast ---- */
  function composer(ctx, { target = null, subtreeIds = [] } = {}) {
    const key = target ? target.id : MAIN_ID;
    const chat = chatKeyOf(ctx);
    const opts = target ? [['agent', `To ${target.title || target.name}`], ['all', 'Broadcast to every agent of this chat']] : [['all', 'Broadcast to every agent of this chat']];
    if (target && subtreeIds.length > 1) opts.push(['tree', `Broadcast to it and the ${subtreeIds.length - 1} agent${subtreeIds.length === 2 ? '' : 's'} below it`]);
    const d = drafts.get(key) || { text: '', to: opts[0][0], wake: false };
    const ta = h('textarea', { class: 'textarea', rows: '3', placeholder: 'Write a message\u2026', 'aria-label': 'Message', 'data-slot': 'team-message-text', oninput: (e) => { d.text = e.target.value; drafts.set(key, d); sendBtn.disabled = !d.text.trim(); } });
    ta.value = d.text;
    const to = h('select', { class: 'select', 'aria-label': 'Send to', 'data-slot': 'team-message-to', onchange: (e) => { d.to = e.target.value; drafts.set(key, d); wakeRow.hidden = d.to === 'agent'; } }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === d.to }, l)));
    const wake = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: d.wake, 'aria-label': 'Also start idle agents', 'data-slot': 'team-message-wake', onchange: (e) => { d.wake = e.target.checked; drafts.set(key, d); } });
    const wakeRow = h('label', { class: 'sa-team-inline' }, wake, h('span', null, 'Also start agents that are idle (otherwise they read it at their next run)'));
    wakeRow.hidden = d.to === 'agent';
    const send = async () => {
      const text = d.text.trim();
      if (!text) return;
      sendBtn.disabled = true;
      let res;
      if (d.to === 'agent') res = await ctx.act('message', { id: target.id, message: text }, 'Message sent.');
      else res = await ctx.act('broadcast', { sessionKey: chat, message: text, ...(d.to === 'tree' ? { ids: subtreeIds } : {}), wake: !!d.wake }, 'Broadcast sent.');
      if (res !== undefined) { d.text = ''; drafts.set(key, d); ta.value = ''; noteEvent('message'); }
      sendBtn.disabled = !d.text.trim();
    };
    const sendBtn = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'team-message-send', disabled: !d.text.trim(), onclick: send }, icon('send'), 'Send');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
    return T().section(target ? 'Message or broadcast' : 'Broadcast', 'agent-team-message', to, ta, wakeRow, h('div', { class: 'row-actions sa-vrow' }, sendBtn));
  }

  /* ---- controls: pause / resume / stop / stop the sub-tree ---- */
  function controls(ctx, r, list) {
    const paused = !!r.paused || r.status === 'paused';
    const tree = subtree(list, r.id, ctx.parentOf);
    const anyActive = tree.some((t) => active(ctx.records.get(t)));
    const done = async (res) => { if (res?.subagent) ctx.upsert(res.subagent); ctx.rebuild(); };
    const btn = (slot, label, ic, on, cls = 'btn-outline') => h('button', { type: 'button', class: `btn ${cls} btn-sm`, 'data-slot': slot, onclick: on }, icon(ic), label);
    return T().section('Run', 'agent-team-controls',
      T().hint(paused ? 'Paused. Resume goes on from where it stopped.' : active(r) ? 'Running. Pause stops it after the current step and keeps its place.' : 'Not running.'),
      h('div', { class: 'row-actions sa-vrow sa-team-btns' },
        paused ? btn('team-resume', 'Resume', 'play', async () => done(await ctx.act('resume', { id: r.id }, 'Resumed.')), 'btn-default') : null,
        !paused && active(r) ? btn('team-pause', 'Pause', 'pause', async () => done(await ctx.act('pause', { id: r.id }, 'Paused.'))) : null,
        active(r) ? btn('team-stop', 'Stop', 'square', async () => done(await ctx.act('stop', { id: r.id }, 'Stop requested.'))) : null,
        tree.length > 1 && anyActive ? btn('team-stop-tree', `Stop it and ${tree.length - 1} below`, 'square', () => confirmDialog({ title: `Stop ${r.name} and the agents below it?`, description: `${tree.length} agents stop. Their work so far is kept.`, confirmLabel: 'Stop all', destructive: true, onConfirm: async () => { const res = await ctx.act('stopTree', { id: r.id }); if (res) toast(`${(res.stopped || []).length} stopped.`, { type: 'success' }); ctx.rebuild(); } }), 'btn-outline sa-danger') : null));
  }

  /* ---- move under another parent ---- */
  function moveSection(ctx, r, list) {
    const cur = ctx.parentOf(r);
    const tree = new Set(subtree(list, r.id, ctx.parentOf));
    const cands = list.filter((x) => !tree.has(x.id)).sort((a, b) => (a.depth || 1) - (b.depth || 1) || String(a.name).localeCompare(String(b.name)));
    const sel = h('select', { class: 'select', 'aria-label': 'New parent', 'data-slot': 'team-reparent-select' },
      h('option', { value: '', selected: !cur }, 'Main agent'),
      ...cands.map((x) => h('option', { value: x.id, selected: x.id === cur }, `${'\u00a0\u00a0'.repeat(Math.max(0, (x.depth || 1) - 1))}${x.title || x.name} \u00b7 level ${x.depth || 1}`)));
    const note = h('p', { class: 'field-error', 'data-slot': 'team-reparent-error', hidden: true });
    const go = async () => {
      const target = sel.value || null;
      const p = reparentProblem(list, r.id, target, ctx.parentOf);
      if (p) { note.textContent = p; note.hidden = false; return; }
      note.hidden = true;
      const res = await ctx.act('reparent', { id: r.id, parentId: target }, `Moved under ${nameOf(ctx, target)}.`);
      if (res?.subagent) ctx.upsert(res.subagent);
      ctx.rebuild();
    };
    return T().section('Parent', 'agent-team-move',
      T().hint(`Started by ${nameOf(ctx, cur)}. Move it, with the agents below it, under another agent of this chat. Agents below it are not offered.`),
      sel, note, h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'team-reparent', onclick: go }, icon('git-fork'), 'Move')));
  }

  /* ---- Agent rules: everything that decides how this one agent talks, in one place ---- */
  function permsSection(ctx, r, list, data, { onSaved = null } = {}) {
    const others = list.filter((x) => x.id !== r.id);
    const row = (data?.matrix || []).find((m) => m.id === r.id);
    const topo = data?.topology || ctx.settings?.topology || 'tree';
    const swarmOk = !!ctx.can?.('subagentSwarm');
    const cells = row ? row.cells || [] : [];
    const now = cells.length ? h('ul', { class: 'sa-team-cells', 'data-slot': 'agent-team-matrix' }, ...cells.map((c) => h('li', { class: 'sa-team-cell', 'data-to': c.to, 'data-allowed': String(!!c.allowed) },
      icon(c.allowed ? 'check' : 'x'), h('span', { class: 'sa-team-cell-name' }, nameOf(ctx, c.to)), c.allowed ? null : h('span', { class: 'field-hint' }, c.reason || 'Not allowed')))) : T().hint(others.length ? 'The engine has not reported who it may message yet.' : 'It is the only agent in this chat.');
    const listMode = Array.isArray(r.canMessage);
    const picked = new Set((r.canMessage || []).map(String));
    const hiddenFrom = new Set((r.hiddenFrom || []).map(String));
    const pick = (x, set, slot) => { const v = x.name; const on = set.has(v) || set.has(x.id); return h('label', { class: 'sa-team-pick', 'data-id': x.id }, h('input', { type: 'checkbox', 'data-slot': slot, value: v, checked: on }), h('span', null, x.title || x.name)); };
    const mode = h('select', { class: 'select', 'aria-label': 'Who it may message', 'data-slot': 'team-can-mode', onchange: () => { pickBox.hidden = mode.value !== 'list'; } },
      h('option', { value: 'team', selected: !listMode }, `Follow the topology (${(TOPOLOGY[r.topology || topo] || [r.topology || topo])[0]})`),
      h('option', { value: 'list', selected: listMode }, 'Only the agents picked below'));
    const pickBox = h('div', { class: 'sa-team-picks', 'data-slot': 'team-can-picks' }, ...(others.length ? others.map((x) => pick(x, picked, 'team-can-pick')) : [T().hint('No other agents yet.')]));
    pickBox.hidden = !listMode;
    const hidden = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: !!r.hidden, 'data-slot': 'team-hidden', 'aria-label': 'Hidden from every other agent' });
    const hideBox = h('div', { class: 'sa-team-picks', 'data-slot': 'team-hidden-from' }, ...(others.length ? others.map((x) => pick(x, hiddenFrom, 'team-hidden-pick')) : [T().hint('No other agents yet.')]));
    // Role, own topology and broadcast: the engine's setCommsRole.
    const role = h('select', { class: 'select', 'aria-label': 'Role', 'data-slot': 'team-rule-role' }, ...Object.entries(ROLE_NAMES).map(([k, l]) => h('option', { value: k, selected: k === (r.commsRole || 'member') }, l)));
    const topoSel = h('select', { class: 'select', 'aria-label': 'Its topology', 'data-slot': 'team-rule-topology' },
      h('option', { value: '', selected: !r.topology }, `Same as the chat (${(TOPOLOGY[topo] || [topo])[0]})`), ...Object.keys(TOPOLOGY).map((k) => h('option', { value: k, selected: r.topology === k }, TOPOLOGY[k][0])));
    const topoHint = h('p', { class: 'field-hint', 'data-slot': 'team-rule-topology-hint' });
    const starWarn = h('p', { class: 'settings-note sa-team-warn', 'data-type': 'warning', 'data-slot': 'team-star-warning', hidden: true }, icon('triangle-alert'), h('span', null, 'Star needs a Hub: no agent at this level has the Hub role, so these agents cannot message each other. Make one of them a Hub.'));
    const siblings = list.filter((x) => (ctx.parentOf(x) || null) === (ctx.parentOf(r) || null));
    const paintTopo = () => {
      const t = topoSel.value || topo;
      topoHint.textContent = (TOPOLOGY[t] || ['', ''])[1];
      const hub = siblings.some((x) => (x.id === r.id ? role.value : x.commsRole) === 'hub');
      starWarn.hidden = !(t === 'star' && !hub && siblings.length > 1);
    };
    role.onchange = paintTopo; topoSel.onchange = paintTopo; paintTopo();
    const bcastNow = r.canBroadcast === true ? 'yes' : r.canBroadcast === false ? 'no' : '';
    const bcast = h('select', { class: 'select', 'aria-label': 'May it broadcast', 'data-slot': 'team-rule-broadcast' },
      ...[['', 'Follow the chat\u2019s broadcast rule'], ['yes', 'Allowed'], ['no', 'Never']].map(([v, l]) => h('option', { value: v, selected: v === bcastNow }, l)));
    const rate = h('input', { type: 'number', class: 'input', min: '0', max: '600', step: '1', value: r.peerRateLimit != null ? String(r.peerRateLimit) : '', placeholder: `Chat-wide (${data?.peerRateLimitPerMin ?? 20})`, 'data-slot': 'team-rule-rate', 'aria-label': 'Messages to other agents per minute' });
    const errEl = h('p', { class: 'field-error', hidden: true, 'data-slot': 'team-rule-error' });
    const save = async () => {
      const patch = {};
      const nextCan = mode.value === 'list' ? [...pickBox.querySelectorAll('[data-slot="team-can-pick"]:checked')].map((i) => i.value) : null;
      if (JSON.stringify(nextCan) !== JSON.stringify(listMode ? [...picked] : null)) patch.canMessage = nextCan;
      if (hidden.checked !== !!r.hidden) patch.hidden = hidden.checked;
      const nextHide = [...hideBox.querySelectorAll('[data-slot="team-hidden-pick"]:checked')].map((i) => i.value);
      if (JSON.stringify([...nextHide].sort()) !== JSON.stringify([...hiddenFrom].sort())) patch.hiddenFrom = nextHide;
      const rv = rate.value.trim();
      const n = rv === '' ? null : Number(rv);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 600)) { errEl.textContent = 'Use a whole number from 0 to 600 (0 = no limit), or leave it empty for the chat-wide limit.'; errEl.hidden = false; rate.setAttribute('aria-invalid', 'true'); return; }
      errEl.hidden = true; rate.removeAttribute('aria-invalid');
      if (n !== (r.peerRateLimit ?? null)) patch.peerRateLimit = n;
      const sw = {};
      if (swarmOk) {
        if (role.value !== (r.commsRole || 'member')) sw.role = role.value;
        if ((topoSel.value || null) !== (r.topology || null)) sw.topology = topoSel.value || null;
        const cb = bcast.value === '' ? null : bcast.value === 'yes';
        if (cb !== (r.canBroadcast ?? null)) sw.canBroadcast = cb;
      }
      if (!Object.keys(patch).length && !Object.keys(sw).length) { toast('Nothing changed.', { type: 'info' }); return; }
      if (Object.keys(patch).length) {
        const res = await ctx.act('configure', { id: r.id, ...patch }, Object.keys(sw).length ? null : 'Saved.');
        if (res === undefined) return;
        if (res?.subagent) ctx.upsert(res.subagent);
      }
      if (Object.keys(sw).length) {
        const res = await ctx.act('setCommsRole', { id: r.id, ...sw }, 'Saved.');
        if (res === undefined) return;
        if (res?.subagent) ctx.upsert(res.subagent);
      }
      AgentTabs._cache.delete(`team:${chatKeyOf(ctx)}`);
      if (typeof AgentSwarm !== 'undefined') AgentSwarm._internal.cache.delete(chatKeyOf(ctx));
      if (onSaved) onSaved(); else ctx.rebuild();
    };
    const sub = (t) => h('p', { class: 'sa-team-sub' }, t);
    return T().section('Agent rules', 'agent-team-perms',
      T().hint(`Everything that decides how ${r.title || r.name} talks, in one place. The chat\u2019s topology (${(TOPOLOGY[topo] || [topo])[0]}), pause and limits are set in Swarm > Configure.${data?.chatPaused || data?.commsPaused ? ' Agent-to-agent messages are paused right now.' : ''}`),
      swarmOk ? h('div', { class: 'field sa-vfield' }, h('label', { class: 'label' }, 'Role'), role) : null,
      swarmOk ? h('div', { class: 'field sa-vfield' }, h('label', { class: 'label' }, 'Its topology'), topoSel, topoHint) : null,
      swarmOk ? starWarn : null,
      swarmOk ? h('div', { class: 'field sa-vfield' }, h('label', { class: 'label' }, 'Broadcast to the team'), bcast, h('p', { class: 'field-hint' }, 'Only where its topology has broadcast (Mesh, Bus, Hierarchical, Swarm, or the chat\u2019s patterns). Allowed overrides \u201cleads only\u201d or \u201cnobody\u201d; Never always wins.')) : null,
      h('div', { class: 'field sa-vfield' }, h('label', { class: 'label' }, 'Messages to other agents per minute'), rate, h('p', { class: 'field-hint' }, '0 = no limit. Empty = the chat-wide limit.'), errEl),
      sub('Right now it may message'), now,
      sub('Its own rule'), mode, pickBox,
      h('label', { class: 'sa-team-inline' }, hidden, h('span', null, 'Hidden from every other agent')),
      sub('Hidden from'), hideBox,
      h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'team-perms-save', disabled: !ctx.can('subagentTeam'), onclick: save }, 'Save')));
  }

  /* ---- read-only: the agents it leads, and who may message it ---- */
  function reachSection(ctx, r, list, data) {
    const link = (x) => (ctx.linkTo ? ctx.linkTo(x) : h('span', null, x.title || x.name));
    const kids = list.filter((x) => ctx.parentOf(x) === r.id);
    const rows = data?.matrix || [];
    const can = rows.filter((m) => m.id !== r.id && (m.cells || []).some((c) => c.to === r.id && c.allowed));
    const cannot = rows.filter((m) => m.id !== r.id && (m.cells || []).some((c) => c.to === r.id && !c.allowed));
    const lead = kids.length || ['lead', 'hub'].includes(r.commsRole);
    return T().section('Its team and who can reach it', 'agent-team-reach',
      h('p', { class: 'sa-team-sub' }, `Its team (${kids.length})`),
      kids.length ? h('div', { class: 'sa-links', 'data-slot': 'team-its-team' }, ...kids.map(link)) : T().hint('It has not started any agents.'),
      lead ? T().hint('The engine counts it as a lead, so \u201cleads only\u201d rules include it.') : null,
      h('p', { class: 'sa-team-sub' }, 'Who can reach it'),
      !rows.length ? T().hint('The engine has not reported this yet.')
        : can.length ? h('div', { class: 'sa-links', 'data-slot': 'team-who-reach' }, ...can.map((m) => { const x = list.find((y) => y.id === m.id); return x ? link(x) : h('span', null, m.title || m.name); }))
          : T().hint('No other agent may message it right now.'),
      cannot.length ? h('p', { class: 'field-hint', 'data-slot': 'team-who-blocked', title: cannot.map((m) => `${m.title || m.name}: ${(m.cells.find((c) => c.to === r.id) || {}).reason || ''}`).join('\n') }, icon('x'), `${cannot.length} cannot: ${truncate((cannot[0].cells.find((c) => c.to === r.id) || {}).reason || '', 90)}`) : null);
  }

  /* ---- the chat's team rules (Main agent's Team tab): status + one link to Swarm ---- */
  function rulesSection(ctx, data) {
    const s = ctx.settings || {};
    if (ctx.openSwarm) {
      const paused = !!(data?.chatPaused || data?.commsPaused);
      const topo = data?.topology || 'tree';
      return T().section('Team rules', 'team-rules',
        h('p', { class: 'sa-team-status', 'data-slot': 'team-rules-status' },
          h('span', { class: 'sw-chip', 'data-tone': paused ? 'warn' : 'ok', 'data-slot': 'team-live' }, paused ? (data?.commsPaused ? 'All chats paused' : 'Paused') : 'Live'), ' ',
          h('strong', null, (TOPOLOGY[topo] || [topo])[0]), ` \u00b7 ${data?.peerRateLimitPerMin ? `${data.peerRateLimitPerMin} messages per agent per minute` : 'no message limit'}`),
        T().hint((TOPOLOGY[topo] || ['', ''])[1]),
        h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'team-rules-open-swarm', onclick: () => ctx.openSwarm('swarm') }, 'Set in Swarm', icon('chevron-right'))));
    }
    // An older engine with no Swarm tab: pause and rate only. The topology lives in Limits.
    const paused = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: !!(data?.commsPaused ?? s.commsPaused), 'data-slot': 'team-comms-paused', 'aria-label': 'Pause all agent-to-agent messages' });
    const rate = h('input', { type: 'number', class: 'input', min: '0', max: '600', step: '1', value: String(data?.peerRateLimitPerMin ?? s.peerRateLimitPerMin ?? 20), 'data-slot': 'team-rate', 'aria-label': 'Messages per agent per minute' });
    const errEl = h('p', { class: 'field-error', hidden: true, 'data-slot': 'team-rules-error' });
    const save = async () => {
      const n = Number(rate.value);
      if (!Number.isInteger(n) || n < 0 || n > 600) { errEl.textContent = 'Use a whole number from 0 to 600 (0 = no limit).'; errEl.hidden = false; rate.setAttribute('aria-invalid', 'true'); return; }
      errEl.hidden = true; rate.removeAttribute('aria-invalid');
      const patch = {};
      if (paused.checked !== !!(data?.commsPaused ?? s.commsPaused)) patch.commsPaused = paused.checked;
      if (n !== Number(data?.peerRateLimitPerMin ?? s.peerRateLimitPerMin ?? 20)) patch.peerRateLimitPerMin = n;
      if (!Object.keys(patch).length) { toast('Nothing changed.', { type: 'info' }); return; }
      const res = await ctx.act('settings', { settings: patch }, 'Team rules saved.');
      if (res?.settings && ctx.settings) Object.assign(ctx.settings, res.settings);
      AgentTabs._cache.delete(`team:${chatKeyOf(ctx)}`);
      ctx.rebuild();
    };
    return T().section('Team rules', 'team-rules',
      h('label', { class: 'sa-team-inline' }, paused, h('span', null, 'Pause all agent-to-agent messages (they wait until you switch this off)')),
      h('div', { class: 'field sa-vfield' }, h('label', { class: 'label' }, 'Messages per agent per minute'), rate, h('p', { class: 'field-hint' }, '0 = no limit. An agent over the limit is told to wait.'), errEl),
      h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'team-rules-save', onclick: save }, 'Save')));
  }

  function matrixSection(ctx, data) {
    const rows = data?.matrix || [];
    if (!rows.length) return T().section('Who may message whom', 'team-matrix', T().hint('No sub-agents in this chat yet.'));
    const list = listOf(ctx);
    // Each row edits that agent's rules in place (the same Agent rules panel as its own Team tab).
    const edit = (m) => {
      const x = list.find((y) => y.id === m.id);
      if (!x) return;
      let dlg = null;
      dlg = openDialog({ title: `Rules of ${x.title || x.name}`, size: 'md', align: 'top', body: h('div', { class: 'sa-team-rules-dlg' }, permsSection(ctx, x, list, data, { onSaved: () => { dlg?.close(); ctx.rebuild(); } })) });
    };
    return T().section('Who may message whom', 'team-matrix',
      h('ul', { class: 'sa-team-matrix' }, ...rows.map((m) => {
        const yes = (m.cells || []).filter((c) => c.allowed), no = (m.cells || []).filter((c) => !c.allowed);
        const x = list.find((y) => y.id === m.id);
        return h('li', { class: 'sa-team-mrow', 'data-id': m.id },
          h('div', { class: 'sa-team-mhead' },
            h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-team-mname', onclick: () => ctx.go('agents', m.id) }, m.title || m.name),
            x && x.commsRole && x.commsRole !== 'member' ? h('span', { class: 'sw-chip' }, ROLE_NAMES[x.commsRole] || x.commsRole) : null,
            x ? h('button', { type: 'button', class: 'btn btn-outline btn-xs sa-team-medit', 'data-slot': 'team-matrix-edit', 'aria-label': `Edit the rules of ${m.title || m.name}`, onclick: () => edit(m) }, icon('pencil'), 'Rules') : null),
          h('span', { class: 'sa-team-myes' }, icon('check'), yes.length ? yes.map((c) => nameOf(ctx, c.to)).join(', ') : 'nobody'),
          no.length ? h('span', { class: 'field-hint sa-team-mno', title: no.map((c) => `${nameOf(ctx, c.to)}: ${c.reason || ''}`).join('\n') }, icon('x'), `${no.length} not: ${truncate(no[0].reason || '', 90)}`) : null);
      })));
  }

  function teamTab(ctx) {
    const { r } = ctx;
    const chat = chatKeyOf(ctx);
    const box = pane('agent-tab-team');
    // The chat's real topology is its Swarm config (it wins over the app-wide one in comms).
    const fetcher = async () => {
      const [comms, cfg] = await Promise.all([ctx.call('comms', { sessionKey: chat, limit: 500 }),
        ctx.can('subagentSwarm') ? ctx.call('commsConfig', { sessionKey: chat }).catch(() => null) : null]);
      const t = cfg?.effective?.topology;
      return t ? { ...comms, topology: t, chatPaused: !!(comms?.chatPaused || cfg?.effective?.paused) } : comms;
    };
    if (!ctx.can('subagentTeam')) return pane('agent-tab-team', h('p', { class: 'settings-note', 'data-type': 'info' }, icon('info'), h('span', null, 'Team controls need the newer app engine.')));
    return T().loadInto(box, `team:${chat}`, fetcher, (data) => {
      const list = listOf(ctx);
      if (isMain(r)) {
        setChildren(box, rulesSection(ctx, data), composer(ctx), matrixSection(ctx, data), timelineSection(ctx, data, fetcher, { slot: 'team-timeline' }));
        return;
      }
      const tree = subtree(list, r.id, ctx.parentOf);
      // Its part in the swarm (role, topics it follows, votes...) in one line, linking to the panel's Swarm tab.
      const rules = permsSection(ctx, r, list, data);
      const onEdit = () => { rules.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); (rules.querySelector('[data-slot=team-rule-role]') || rules.querySelector('select'))?.focus({ preventScroll: true }); };
      const swarm = ctx.openSwarm && typeof AgentSwarm !== 'undefined' ? AgentSwarm.roleLine(ctx, r, () => ctx.openSwarm('swarm', r.id), onEdit) : null;
      setChildren(box, swarm, controls(ctx, r, list), rules, reachSection(ctx, r, list, data), composer(ctx, { target: r, subtreeIds: tree }), timelineSection(ctx, data, fetcher, { only: r.id }), moveSection(ctx, r, list));
    });
  }

  /* ---- Graph: one agent's neighbourhood, and the whole team ---- */
  const STATUS_CLASS = { running: 'run', queued: 'run', waiting_approval: 'wait', paused: 'wait', finished: 'ok', error: 'bad', cancelled: 'stop' };
  const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.:-]/gu, '').slice(0, 40) || 'agent';
  const CLASSDEFS = ['  classDef main fill:#ede9fe,stroke:#7c3aed,color:#2e1065',
    '  classDef run fill:#dbeafe,stroke:#2563eb,color:#172554',
    '  classDef wait fill:#fef3c7,stroke:#d97706,color:#451a03',
    '  classDef ok fill:#dcfce7,stroke:#16a34a,color:#052e16',
    '  classDef bad fill:#fee2e2,stroke:#dc2626,color:#450a0a',
    '  classDef stop fill:#f1f5f9,stroke:#64748b,color:#0f172a',
    '  classDef tool fill:#f8fafc,stroke:#94a3b8,color:#334155,stroke-dasharray:3 3',
    '  classDef me stroke-width:3px'];
  /** Peer message counts between agents: Map `from>to` -> n (agent-to-agent only). */
  function peerCounts(messages) {
    const m = new Map();
    for (const x of messages || []) if (x.kind === 'peer' && x.fromId && x.toId) m.set(`${x.fromId}>${x.toId}`, (m.get(`${x.fromId}>${x.toId}`) || 0) + 1);
    return m;
  }
  /**
   * One agent's diagram: its real parent (or Main), the agent, every agent
   * below it on its real parent edge, the agents it messaged or heard from
   * (dotted, with counts) and the tools it called (with counts). Nothing else.
   */
  function agentSource(list, r, { messages = [], tools = new Map(), parentOf }) {
    const byId = new Map(list.map((x) => [x.id, x]));
    const ids = new Map();
    const nid = (id) => { if (!ids.has(id)) ids.set(id, `n${ids.size}`); return ids.get(id); };
    const lines = ['flowchart TD'];
    const node = (x, extra = '') => `  ${nid(x.id)}["${clean(x.title || x.name)}<br/>L${x.depth || 1} \u00b7 ${clean(x.status)}"]:::${STATUS_CLASS[x.status] || 'run'}${extra}`;
    const par = parentOf(r);
    let top = 'main';
    if (par && byId.has(par)) { lines.push(node(byId.get(par))); top = nid(par); } else lines.push('  main(["Main agent"]):::main');
    lines.push(node(r), `  class ${nid(r.id)} me`, `  ${top} --> ${nid(r.id)}`);
    const tree = subtree(list, r.id, parentOf);
    for (const id of tree.slice(1)) { const x = byId.get(id); lines.push(node(x)); const p = parentOf(x); lines.push(`  ${nid(p)} --> ${nid(id)}`); }
    const pc = peerCounts(messages);
    for (const [k, n] of pc) {
      const [a, b] = k.split('>');
      if (a !== r.id && b !== r.id) continue;
      const other = a === r.id ? b : a;
      if (!ids.has(other)) { const x = byId.get(other); if (!x) continue; lines.push(node(x)); }
      lines.push(`  ${nid(a)} -.->|${n} msg${n === 1 ? '' : 's'}| ${nid(b)}`);
    }
    [...tools.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).forEach(([t, n], i) => {
      lines.push(`  t${i}[/"${clean(t)} \u00d7${n}"/]:::tool`, `  ${nid(r.id)} -.- t${i}`);
    });
    lines.push(...CLASSDEFS);
    return lines.join('\n');
  }
  /** The whole team: every agent on its real parent edge, plus agent-to-agent messages. */
  function teamSource(list, { messages = [], parentOf, max = 40 }) {
    const sorted = [...list].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || String(a.id).localeCompare(String(b.id))).slice(-max);
    const idx = new Map(sorted.map((x, i) => [x.id, `a${i}`]));
    const lines = ['flowchart TD', '  main(["Main agent"]):::main'];
    for (const x of sorted) {
      lines.push(`  ${idx.get(x.id)}["${clean(x.title || x.name)}<br/>L${x.depth || 1} \u00b7 ${clean(x.status)}"]:::${STATUS_CLASS[x.status] || 'run'}`);
      const p = parentOf(x);
      lines.push(`  ${p && idx.has(p) ? idx.get(p) : 'main'} --> ${idx.get(x.id)}`);
    }
    for (const [k, n] of peerCounts(messages)) { const [a, b] = k.split('>'); if (idx.has(a) && idx.has(b)) lines.push(`  ${idx.get(a)} -.->|${n} msg${n === 1 ? '' : 's'}| ${idx.get(b)}`); }
    if (!sorted.length) lines.push('  none["No sub-agents yet"]:::stop', '  main -.-> none');
    lines.push(...CLASSDEFS);
    return lines.join('\n');
  }
  function toolCounts(log) {
    const m = new Map();
    for (const e of log || []) if ((e.event === 'subagent.tool_call' || e.event === 'subagent.tool_use') && e.tool) m.set(e.tool, (m.get(e.tool) || 0) + 1);
    return m;
  }
  function nodeButtons(ctx, ids, slot) {
    return h('div', { class: 'sa-vchips', 'data-slot': slot, role: 'group', 'aria-label': 'Open an agent' },
      ...ids.map((id) => h('button', { type: 'button', class: 'sa-vchip', 'data-id': id, onclick: () => ctx.go('agents', id) }, id === MAIN_ID ? 'Main agent' : nameOf(ctx, id))));
  }
  function graphTab(ctx) {
    const { r } = ctx;
    const chat = chatKeyOf(ctx);
    const box = pane('agent-tab-graph');
    const fetcher = async () => {
      const [comms, log] = await Promise.all([
        ctx.can('subagentTeam') ? ctx.call('comms', { sessionKey: chat, limit: 500 }).catch(() => null) : null,
        isMain(r) ? null : ctx.call('log', { id: r.id, limit: 500 }).catch(() => null),
      ]);
      return { messages: comms?.messages || [], log: Array.isArray(log?.log) ? log.log : [] };
    };
    return T().loadInto(box, `graph:${isMain(r) ? chat : r.id}`, fetcher, ({ messages, log }) => {
      const list = listOf(ctx);
      const team = teamSource(list, { messages, parentOf: ctx.parentOf });
      const teamSec = T().section('Whole team', 'agent-graph-team', T().hint('Solid lines: who started whom. Dotted: agent-to-agent messages.'), ctx.diagramBox(team, 'Team diagram'), nodeButtons(ctx, [MAIN_ID, ...list.map((x) => x.id)].filter((id) => id !== MAIN_ID), 'agent-graph-team-nodes'));
      teamSec.dataset.source = team;
      if (isMain(r)) {
        const seq = ctx.sequenceSource ? ctx.sequenceSource() : null;
        setChildren(box, teamSec, seq ? T().section('Over time', 'agent-graph-sequence', T().hint('Who started, messaged and reported to whom, in order.'), ctx.diagramBox(seq, 'Sequence diagram')) : null);
        return;
      }
      const tools = toolCounts(log);
      const own = agentSource(list, r, { messages, tools, parentOf: ctx.parentOf });
      const near = new Set([ctx.parentOf(r), ...subtree(list, r.id, ctx.parentOf)].filter(Boolean));
      for (const [k] of peerCounts(messages)) { const [a, b] = k.split('>'); if (a === r.id) near.add(b); if (b === r.id) near.add(a); }
      near.delete(r.id);
      // Only this agent's part of the graph; the whole team is one tap away on the panel's Diagram tab.
      const label = `${r.title || r.name}`;
      const below = subtree(list, r.id, ctx.parentOf).length - 1;
      const about = `Its parent, the ${below} agent${below === 1 ? '' : 's'} below it, who it messaged and the ${tools.size} tool${tools.size === 1 ? '' : 's'} it called. Nothing else.\nSolid lines: who started whom. Dotted: agent-to-agent messages, with counts.`;
      const ownSec = h('section', { class: 'sa-section', 'aria-label': label, 'data-slot': 'agent-graph-own' },
        T().withInfo(h('h4', null, label), about, `${label}'s graph`),
        ctx.diagramBox(own, 'Agent diagram'),
        near.size ? nodeButtons(ctx, [...near], 'agent-graph-nodes') : null,
        ctx.go ? h('button', { type: 'button', class: 'btn btn-link btn-xs sa-link agent-graph-whole', 'data-slot': 'agent-graph-whole', onclick: () => ctx.go('diagram') }, icon('workflow'), h('span', null, 'Whole team on the Diagram tab'), icon('chevron-right')) : null);
      ownSec.dataset.source = own;
      setChildren(box, ownSec);
    });
  }

  /* ---- the Main agent: the same tabs, for the chat as a whole ---- */
  function mainRecord(chat, appRef) {
    const rt = appRef?.chat?.main;
    return { id: MAIN_ID, isMain: true, name: 'Main agent', title: '', status: rt?.isRunning ? 'running' : 'idle', depth: 0, sessionKey: chat, rootSessionKey: chat, parentSessionKey: '', tools: [], totalTokens: 0, steps: 0, toolCalls: 0 };
  }
  function mainOverview(ctx) {
    const list = listOf(ctx);
    const by = (s) => list.filter((x) => (Array.isArray(s) ? s.includes(x.status) : x.status === s)).length;
    const sum = (k) => list.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const kids = list.filter((x) => !ctx.parentOf(x));
    const s = ctx.settings || {};
    return pane('agent-tab-overview-main',
      T().section('This chat\u2019s agents', 'main-overview-counts',
        h('dl', { class: 'sa-kvs sa-vsummary' },
          ctx.kv('Sub-agents', String(list.length)), ctx.kv('Running', String(by(['running', 'queued']))), ctx.kv('Waiting for you', String(by('waiting_approval'))),
          ctx.kv('Finished', String(by('finished'))), ctx.kv('Failed', String(by('error'))), ctx.kv('Stopped', String(by('cancelled'))),
          ctx.kv('Tokens', ctx.fmtTokens(sum('totalTokens'))), ctx.kv('Tool calls', String(sum('toolCalls'))), ctx.kv('Deepest level', String(list.reduce((a, x) => Math.max(a, x.depth || 1), 0))))),
      T().section('Started by the main agent', 'main-overview-children', kids.length ? h('div', { class: 'sa-links' }, ...kids.map(ctx.linkTo)) : T().hint('None yet.')),
      T().section('Limits', 'main-overview-limits', h('dl', { class: 'sa-kvs' },
        ctx.kv('Levels deep', String(s.maxDepth ?? '\u2013')), ctx.kv('At once', String(s.maxParallel ?? '\u2013')), ctx.kv('Topology', (TOPOLOGY[s.topology || 'tree'] || ['tree'])[0]),
        ctx.kv('Auto-compaction', s.autoCompact === false ? 'Off' : `On, at ${s.compactThresholdPercent ?? 100}%`))),
      ctx.close ? h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'main-back-to-chat', onclick: ctx.close }, icon('message-square'), 'Back to the chat')) : null);
  }
  function mainChat(ctx) {
    return pane('agent-tab-chat-main', T().section('Chat', 'main-chat', T().hint('The main agent\u2019s chat is this chat. Sub-agents each have their own chat: open one from Overview or Graph.'),
      ctx.close ? h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'main-back-to-chat', onclick: ctx.close }, icon('message-square'), 'Go to the chat')) : null));
  }
  function mainTools(ctx) {
    const chat = chatKeyOf(ctx);
    const box = pane('agent-tab-tools-main');
    return T().loadInto(box, `tools:${MAIN_ID}:${chat}`, () => ctx.call('chatAllows', { sessionKey: chat }).catch(() => ({})), (allows) => {
      const on = new Set(allows?.tools || []);
      const names = [...new Set([...(ctx.knownToolNames(typeof window !== 'undefined' ? window.__app : null) || []), ...on])].filter(Boolean).sort();
      const set = async (tool, allow) => {
        const res = await ctx.act(allow ? 'allowTool' : 'revokeTool', { sessionKey: chat, toolName: tool, scope: 'chat' }, allow ? `${tool} runs without asking in this chat.` : `${tool} asks first again.`);
        if (res) { AgentTabs._cache.delete(`tools:${MAIN_ID}:${chat}`); ctx.rebuild(); }
      };
      setChildren(box, T().section('Runs without asking', 'main-tools-allows',
        T().hint('\u201cAlways allow\u201d here covers the main agent and every sub-agent of this chat.'),
        names.length ? h('ul', { class: 'sa-vtools' }, ...names.map((t) => h('li', { class: 'sa-vtool', 'data-tool': t, 'data-allow': on.has(t) ? 'chat' : 'ask' },
          h('div', { class: 'sa-vtool-main' }, h('code', { class: 'sa-vtool-name truncate' }, t), h('span', { class: 'sa-vtool-allow field-hint' }, on.has(t) ? 'Always allowed (whole chat)' : 'Asks first')),
          h('div', { class: 'sa-vtool-ctl' }, on.has(t) ? h('button', { type: 'button', class: 'btn btn-ghost btn-xs', 'data-slot': 'main-tool-revoke', onclick: () => set(t, false) }, 'Ask first') : h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-slot': 'main-tool-allow', onclick: () => set(t, true) }, 'Always allow'))))) : T().hint('No tools known yet.')));
    });
  }
  const SETTING_FIELDS = [
    ['maxDepth', 'Levels deep', 1, 3, 'How many levels of sub-agents may start sub-agents.'],
    ['maxParallel', 'Running at once', 1, 8, 'Others wait in the queue.'],
    ['defaultTokenBudget', 'Token budget per agent', 0, 5000000, '0 = no cap, like the main agent (auto-compaction keeps each one within its model\u2019s window). Default for new sub-agents.'],
    ['defaultMaxSteps', 'Steps per run', 1, 200, 'Default for new sub-agents.'],
    ['timeoutSeconds', 'Timeout (seconds)', 5, 3600, 'A run longer than this stops.'],
    ['compactThresholdPercent', 'Compact at (% of the window)', 10, 100, 'For every agent of this chat that has no rule of its own.'],
    ['peerRateLimitPerMin', 'Messages per agent per minute', 0, 600, '0 = no limit.'],
  ];
  function mainSettings(ctx) {
    const s = ctx.settings || {};
    const inputs = new Map();
    const fields = SETTING_FIELDS.map(([k, label, min, max, hintText]) => {
      const inp = h('input', { type: 'number', class: 'input', min: String(min), max: String(max), step: '1', value: s[k] != null ? String(s[k]) : '', 'data-setting': k, 'aria-label': label });
      const e = h('p', { class: 'field-error', hidden: true });
      inputs.set(k, { inp, e, min, max });
      return h('div', { class: 'field sa-vfield' }, h('label', { class: 'label' }, label), inp, h('p', { class: 'field-hint' }, hintText), e);
    });
    const auto = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: s.autoCompact !== false, 'data-setting': 'autoCompact', 'aria-label': 'Auto-compaction' });
    const topo = h('select', { class: 'select', 'data-setting': 'topology', 'aria-label': 'Topology' }, ...Object.entries(TOPOLOGY).map(([k, [l]]) => h('option', { value: k, selected: k === (s.topology || 'tree') }, l)));
    const save = async () => {
      const patch = {};
      let bad = false;
      for (const [k, { inp, e, min, max }] of inputs) {
        if (inp.value === '' && s[k] == null) continue;
        const n = Number(inp.value);
        const ok = Number.isInteger(n) && n >= min && n <= max;
        e.hidden = ok; inp.toggleAttribute('aria-invalid', !ok);
        if (!ok) { e.textContent = `Use a whole number from ${min} to ${max}.`; bad = true; continue; }
        if (n !== s[k]) patch[k] = n;
      }
      if (bad) return;
      if (auto.checked !== (s.autoCompact !== false)) patch.autoCompact = auto.checked;
      if (!ctx.openSwarm && topo.value !== (s.topology || 'tree')) patch.topology = topo.value;
      if (ctx.openSwarm) delete patch.peerRateLimitPerMin;
      if (!Object.keys(patch).length) { toast('Nothing changed.', { type: 'info' }); return; }
      const res = await ctx.act('settings', { settings: patch }, 'Saved.');
      if (res?.settings && ctx.settings) Object.assign(ctx.settings, res.settings);
      ctx.rebuild();
    };
    return pane('agent-tab-settings-main',
      T().section('Context compaction', 'main-settings-compaction', h('label', { class: 'sa-team-inline' }, auto, h('span', null, 'Compact automatically when the context window fills')), fields[5]),
      T().section('Sub-agents', 'main-settings-limits', ...fields.slice(0, 5)),
      ctx.openSwarm
        ? T().section('Team', 'main-settings-team', T().hint('Topology, pause and the message limit are set in one place: Swarm > Configure.'), h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'main-settings-open-swarm', onclick: () => ctx.openSwarm('swarm') }, 'Set in Swarm', icon('chevron-right'))))
        : T().section('Team', 'main-settings-team', h('div', { class: 'field sa-vfield' }, h('label', { class: 'label' }, 'Topology'), topo), fields[6]),
      h('div', { class: 'row-actions sa-vsave' }, h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'main-settings-save', onclick: save }, 'Save')));
  }
  function mainContext(ctx) {
    const list = listOf(ctx);
    const s = ctx.settings || {};
    const rows = list.map((x) => {
      const cs = x.contextStatus && typeof x.contextStatus === 'object' ? x.contextStatus : null;
      const used = Number(cs?.estimatedTokens) || 0, budget = Number(cs?.budgetTokens) || 0;
      const pct = budget ? Math.min(100, Math.round((used / budget) * 100)) : 0;
      return h('li', { class: 'sa-vtool', 'data-id': x.id },
        h('div', { class: 'sa-vtool-main' }, h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-team-mname', onclick: () => ctx.go('agents', x.id) }, x.title || x.name),
          h('span', { class: 'sa-vtool-stats' }, cs ? `${ctx.fmtTokens(used)} / ${ctx.fmtTokens(budget)} \u00b7 ${pct}%` : 'Not measured yet', ` \u00b7 ${x.compactions || 0} compaction${x.compactions === 1 ? '' : 's'}`),
          cs ? h('div', { class: 'sa-vmeter sa-vmeter-sm' }, h('div', { class: 'sa-vmeter-fill', style: `width:${pct}%`, 'data-level': pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low' })) : null));
    });
    const mem = typeof window !== 'undefined' ? window.__chatMemory : null;
    return pane('agent-tab-context-main',
      T().section('Compaction', 'main-context-rule', h('dl', { class: 'sa-kvs' }, ctx.kv('Auto-compaction', s.autoCompact === false ? 'Off' : 'On'), ctx.kv('Compacts at', `${s.compactThresholdPercent ?? 100}% of the window`)), T().hint('The main agent and every sub-agent go through the same compaction: old tool results shortened first, then a summary, then old messages dropped.')),
      mem?.available?.() ? T().section('Main agent\u2019s context', 'main-context-memory', T().hint('What the last model call was given, the summary and the stored results.'), h('div', { class: 'row-actions sa-vrow' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'main-open-memory', onclick: () => mem.open('context', chatKeyOf(ctx)) }, icon('gauge'), 'Open context and memory'))) : null,
      T().section('Every sub-agent', 'main-context-agents', rows.length ? h('ul', { class: 'sa-vtools' }, ...rows) : T().hint('No sub-agents yet.')));
  }
  function mainActivity(ctx) {
    const chat = chatKeyOf(ctx);
    const box = pane('agent-tab-activity-main');
    const fetcher = async () => (ctx.can('subagentGraph') ? ctx.call('graph', { sessionKey: chat }).catch(() => null) : null);
    return T().loadInto(box, `mact:${chat}`, fetcher, (g) => {
      const evs = (Array.isArray(g?.events) ? g.events : []).slice(-300).reverse();
      const draw = () => setChildren(box, T().section('Every agent', 'main-activity', evs.length ? h('ol', { class: 'sa-vevents' }, ...evs.map((e) => {
        const k = String(e.event || '').replace(/^subagent\./, '');
        return h('li', { class: 'sa-vevent', 'data-kind': k === 'error' ? 'errors' : k.includes('message') || k === 'broadcast' ? 'messages' : k.includes('approval') || k.includes('ask') ? 'asks' : k.includes('tool') ? 'tools' : 'runs', 'data-event': k },
          h('span', { class: 'sa-vevent-time' }, T().when(e.at)),
          h('div', { class: 'sa-vevent-body' }, h('p', { class: 'sa-vevent-title' }, h('span', null, nameOf(ctx, e.id)), h('span', { class: 'sa-vevent-what' }, k.replace(/_/g, ' '))),
            e.text || e.report || e.error ? h('p', { class: 'sa-vevent-text' }, truncate(String(e.text || e.report || e.error), 400)) : null));
      })) : T().hint('Nothing yet.')));
      draw();
      watch(box, () => fetcher().then((g2) => { if (g2) { evs.splice(0, evs.length, ...(g2.events || []).slice(-300).reverse()); draw(); } }));
    });
  }
  function renderMain(tab, ctx) {
    if (tab === 'overview') return mainOverview(ctx);
    if (tab === 'chat') return mainChat(ctx);
    if (tab === 'tools') return mainTools(ctx);
    if (tab === 'settings') return mainSettings(ctx);
    if (tab === 'context') return mainContext(ctx);
    if (tab === 'activity') return mainActivity(ctx);
    return null;
  }

  return { MAIN_ID, TOPOLOGY, teamTab, graphTab, renderMain, mainRecord, noteEvent, agentSource, teamSource, reparentProblem, subtree };
})();
if (typeof window !== 'undefined') window.__agentTeam = AgentTeam;
