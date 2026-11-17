/* ==========================================================================
   Swarm (engine feature `subagentSwarm`, subagents/channels.rs + swarm.rs).

   Lives inside the agent view's one section nav (a "Swarm" group in the side
   nav, the same row + More on a phone): never a second row of tabs.
     swarm      Overview: topology, live / paused, roles, activity, compaction,
                Configure (the settings sheet), Pause, Stop all.
     topics     Pub/sub topics: subscribers, posts, the compacted digest, post
                as you, new / delete topic.
     board      Versioned blackboard with stigmergy weights; write with a
                version check, delete.
     market     Contract-net auctions: bids, policy, winner.
     votes      Votes: options with tallies, rule, quorum, ballots.
     debates    Debates: rounds, stances, the digest of folded turns.
     elections  Leader elections: term, method, candidates, coordinator.
   Also exported: the settings sheet (presets, topology cards, patterns,
   permissions, decisions, limits, compaction, allow/deny edge editor), the
   topology/role picker for the spawn and batch dialogs, and addEdge for the
   Explorer's "Draw rule" mode.

   Reads chat state with `swarmState` and `commsConfig`; every view repaints
   from a short poll while it is on screen and keeps the user's drafts.
   ========================================================================== */
const AgentSwarm = (() => {
  const TABS = ['swarm', 'topics', 'board', 'decisions'];
  const KINDS = [['market', 'Market', 'gavel'], ['votes', 'Votes', 'vote'], ['debates', 'Debates', 'messages-square'], ['elections', 'Elections', 'crown']];
  const TOPO = {
    tree: ['Tree', 'Up and down only: a parent and the agents it started.'],
    star: ['Star', 'Everyone talks through one hub (the main agent or the batch hub).'],
    mesh: ['Mesh', 'Any agent may message any other agent it can see.'],
    ring: ['Ring', 'Each agent passes to the next one at its level.'],
    chain: ['Chain', 'A line: each agent talks to the one before and after it.'],
    bus: ['Bus', 'Agents talk through shared topics and the blackboard, not to each other.'],
    hierarchical: ['Hierarchical', 'Leads talk to each other and to their own team; members talk to their lead.'],
    swarm: ['Swarm', 'Peers hand work off, gossip, bid and vote with no fixed leader.'],
    custom: ['Custom', 'Only the allow rules you draw. Nothing else gets through.'],
  };
  // Node positions (0..24 box) for the small topology diagrams on the cards.
  const GLYPH = {
    tree: { n: [[12, 4], [6, 13], [18, 13], [3, 21], [9, 21]], e: [[0, 1], [0, 2], [1, 3], [1, 4]] },
    star: { n: [[12, 12], [12, 3], [21, 12], [12, 21], [3, 12]], e: [[0, 1], [0, 2], [0, 3], [0, 4]] },
    mesh: { n: [[5, 5], [19, 5], [19, 19], [5, 19]], e: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2], [1, 3]] },
    ring: { n: [[12, 3], [20.5, 9], [17.5, 20], [6.5, 20], [3.5, 9]], e: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] },
    chain: { n: [[3, 12], [9, 12], [15, 12], [21, 12]], e: [[0, 1], [1, 2], [2, 3]] },
    bus: { n: [[5, 5], [12, 5], [19, 5], [8, 19], [16, 19]], e: [], bus: true },
    hierarchical: { n: [[8, 4], [16, 4], [4, 18], [9, 18], [15, 18], [20, 18]], e: [[0, 1], [0, 2], [0, 3], [1, 4], [1, 5]] },
    swarm: { n: [[5, 6], [17, 4], [20, 15], [11, 20], [3, 16], [12, 11]], e: [[0, 5], [5, 2], [1, 5], [3, 4], [5, 3]] },
    custom: { n: [[4, 6], [20, 6], [12, 19]], e: [[0, 1], [1, 2]], dashed: true },
  };
  const PATTERN = {
    direct: ['Direct messages', 'Agent to agent, where the topology allows.'],
    broadcast: ['Broadcast', 'One message to every agent it may reach.'],
    topics: ['Topics', 'Publish and subscribe to named topics.'],
    blackboard: ['Blackboard', 'Shared notes with versions; marks fade unless reinforced.'],
    request: ['Request / reply', 'Ask a peer and wait for the answer, with a timeout.'],
    handoff: ['Handoff', 'Pass the task on; the report goes back to whoever asked.'],
    gossip: ['Gossip', 'Spread a fact to a few peers at a time, hop by hop.'],
    auction: ['Market', 'Announce a task, collect bids, award it.'],
    vote: ['Votes', 'Decide by majority, plurality, unanimity or supermajority.'],
    debate: ['Debate', 'Rounds of positions until they agree or rounds run out.'],
    election: ['Elections', 'Pick a coordinator by rank or by vote.'],
  };
  const WHO = { all: 'Every agent', leads: 'Hubs and leads only', none: 'Nobody' };
  const RULES = { majority: 'Majority', plurality: 'Plurality', unanimous: 'Unanimous', supermajority: 'Supermajority (2/3)' };
  const POLICIES = { best: 'Best proposal', cheapest: 'Lowest cost', confident: 'Most confident', first: 'First bid', manager: 'Announcer picks' };
  const ROLES = { member: 'Member', lead: 'Lead', hub: 'Hub' };
  const LIMITS = [
    ['maxHops', 'Max hops', 1, 50, 'How far one message may travel through relays.'],
    ['maxPairMessages', 'Messages per pair', 0, 1000, 'Between two agents in 10 minutes. 0 = no limit.'],
    ['maxMessages', 'Messages in this chat', 0, 100000, 'All agent-to-agent traffic. 0 = no limit.'],
    ['maxHandoffs', 'Handoffs per task', 0, 20, 'How many times one task may change hands.'],
    ['gossipFanout', 'Gossip fanout', 1, 10, 'Peers each hop tells.'],
    ['requestTimeoutS', 'Reply timeout (s)', 5, 1800, 'How long a request waits for its reply.'],
    ['pheromoneHalfLifeMin', 'Mark half-life (min)', 1, 10080, 'How fast unreinforced blackboard marks fade.'],
  ];
  const COMPACT = [
    ['compactKeep', 'Keep verbatim', 2, 45, 'Newest items left whole after compacting.'],
    ['compactAt', 'Compact past', 4, 50, 'A history compacts when it grows past this.'],
    ['compactContextChars', 'Prompt budget (chars)', 2000, 200000, 'Coordination text one prompt may carry.'],
  ];
  const LIVE_STATUS = new Set(['open', 'running']);
  const STATUS_TEXT = { open: 'Open', running: 'Running', awarded: 'Awarded', no_bids: 'No bids', decided: 'Decided', converged: 'Agreed', split: 'No agreement', passed: 'Passed', tie: 'Tie', no_majority: 'No majority', no_quorum: 'No quorum', cancelled: 'Stopped' };
  const WARN_STATUS = new Set(['no_bids', 'split', 'tie', 'no_majority', 'no_quorum', 'cancelled']);

  if (typeof ICONS !== 'undefined') {
    const more = {
      hexagon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
      hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
      gavel: '<path d="m14.5 12.5-8 8a2.119 2.119 0 1 1-3-3l8-8"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/>',
      vote: '<path d="m9 12 2 2 4-4"/><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z"/><path d="M22 19H2"/>',
      crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
      megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
      'clipboard-list': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
      'messages-square': '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
      ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
      spline: '<circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M5 17A12 12 0 0 1 17 5"/>',
      'arrow-right-left': '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
      'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
      archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
      pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    };
    for (const [k, v] of Object.entries(more)) if (!ICONS[k]) ICONS[k] = v;
  }

  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const chatKeyOf = (ctx) => String(ctx.chatKey || ctx.chat || (ctx.chatOf ? ctx.chatOf(ctx.r) : ctx.r?.rootSessionKey || ctx.r?.parentSessionKey) || '');
  const statusText = (s) => STATUS_TEXT[s] || (s ? String(s).replace(/_/g, ' ') : '');
  const isLive = (s) => LIVE_STATUS.has(String(s || ''));
  function ago(ms) {
    const t = num(ms);
    if (!t) return '';
    const d = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (d < 10) return 'just now';
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }
  /** A small diagram of a topology: dots and lines in a 24-unit box. */
  function glyph(topology, size = 40) {
    const g = GLYPH[topology] || GLYPH.mesh;
    const lines = g.e.map(([a, b]) => sv('line', { x1: g.n[a][0], y1: g.n[a][1], x2: g.n[b][0], y2: g.n[b][1], 'stroke-dasharray': g.dashed ? '2 2' : null }));
    if (g.bus) { lines.push(sv('line', { x1: 2, y1: 12, x2: 22, y2: 12, class: 'sw-glyph-bus' })); for (const [x, y] of g.n) lines.push(sv('line', { x1: x, y1: y, x2: x, y2: 12 })); }
    return sv('svg', { class: 'sw-glyph', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', 'data-topology': topology },
      sv('g', { class: 'sw-glyph-lines' }, lines), sv('g', { class: 'sw-glyph-dots' }, g.n.map(([x, y], i) => sv('circle', { cx: x, cy: y, r: i === 0 && (topology === 'star' || topology === 'tree') ? 2.6 : 2 }))));
  }
  const chip = (text, tone, extra = {}) => h('span', { class: 'sw-chip', 'data-tone': tone || null, ...extra }, text);
  const empty = (ic, title, hint, action) => h('div', { class: 'sw-empty', 'data-slot': 'swarm-empty' }, icon(ic), h('p', { class: 'sw-empty-title' }, title), hint ? h('p', { class: 'field-hint' }, hint) : null, action || null);
  const fieldId = (p) => `sw-${p}-${uid(4)}`;
  function field(label, input, hint) {
    if (!input.id) input.id = fieldId('f');
    return h('div', { class: 'field sw-field' }, h('label', { class: 'label', for: input.id }, label), input, hint ? h('p', { class: 'field-hint' }, hint) : null);
  }
  function select(options, value, attrs = {}) {
    return h('select', { class: 'select', ...attrs }, ...Object.entries(options).map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) || undefined }, l)));
  }

  /* ---------- data ---------- */
  const cache = new Map(); // chat -> { state, config, at }
  async function load(ctx, chat, what = 'both') {
    const c = cache.get(chat) || {};
    const jobs = [];
    if (what !== 'config') jobs.push(ctx.call('swarmState', { sessionKey: chat }).then((s) => { c.state = s || {}; }));
    if (what !== 'state') jobs.push(ctx.call('commsConfig', { sessionKey: chat }).then((s) => { c.config = s || {}; }));
    await Promise.all(jobs);
    c.at = Date.now();
    cache.set(chat, c);
    return c;
  }
  const recordsOf = (ctx) => (ctx.records instanceof Map ? [...ctx.records.values()] : typeof ctx.records === 'function' ? ctx.records() : Array.isArray(ctx.records) ? ctx.records : []);
  const agentsOf = (ctx) => { const chat = chatKeyOf(ctx); return recordsOf(ctx).filter((r) => r && !r.isMain && !r.chatDeleted && (!chat || !ctx.chatOf || String(ctx.chatOf(r) || '') === chat)); };
  function nameOf(ctx, id) {
    if (!id) return 'You';
    const r = (ctx.records instanceof Map ? ctx.records.get(id) : null) || recordsOf(ctx).find((x) => x.id === id);
    return r?.name || String(id);
  }

  /**
   * Paint a view now and again every few seconds while it is on screen. The poll stops by itself once the view
   * leaves the page; a view the user is typing into is not repainted (its draft stays), only refreshed after.
   */
  function liveView(ctx, slot, paint, what = 'state') {
    const chat = chatKeyOf(ctx);
    const root = h('div', { class: 'sa-panel sw-view', 'data-slot': slot, 'aria-busy': 'true' });
    const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    let timer = null, busy = false;
    const draw = (c) => {
      root.removeAttribute('aria-busy');
      const f = root.contains(document.activeElement) ? document.activeElement : null;
      if (f && (f.tagName === 'TEXTAREA' || (f.tagName === 'INPUT' && f.type !== 'checkbox') || f.tagName === 'SELECT')) return;
      const key = f?.dataset?.slot;
      setChildren(root, paint(c, refresh), status);
      if (key) root.querySelector(`[data-slot="${key}"]`)?.focus({ preventScroll: true });
    };
    async function refresh(full = false) {
      if (busy) return; busy = true;
      try { draw(await load(ctx, chat, full ? 'both' : what)); } catch (e) {
        root.removeAttribute('aria-busy');
        setChildren(root, h('div', { class: 'sw-error', role: 'alert', 'data-slot': 'swarm-error' }, icon('circle-exclamation-point'), h('span', null, redactSecrets(e?.message || String(e), 240)), h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => refresh(true) }, 'Try again')));
      } finally { busy = false; }
    }
    const tick = () => { if (!root.isConnected) { clearInterval(timer); return; } if (!document.hidden) refresh(); };
    const c0 = cache.get(chat);
    if (c0 && c0.state && (what === 'state' || c0.config)) draw(c0);
    else setChildren(root, h('div', { class: 'sw-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), status);
    queueMicrotask(() => refresh(true));
    timer = setInterval(tick, 3000);
    root.announce = (t) => { status.textContent = t; };
    return root;
  }
  async function run(ctx, action, req, ok) {
    try { const r = await ctx.call(action, req); if (ok) toast(ok, { type: 'success' }); return r || {}; } catch (e) { toast(redactSecrets(e?.message || String(e), 300), { type: 'error' }); return null; }
  }
  const head = (title, desc, ...actions) => h('div', { class: 'sw-head' }, h('div', { class: 'sw-head-text' }, h('h3', { class: 'sw-title' }, title), desc ? h('p', { class: 'field-hint' }, desc) : null), actions.length ? h('div', { class: 'sw-head-actions' }, ...actions) : null);
  const digestLine = (d, noun) => (d && num(d.count) ? h('p', { class: 'sw-digest', 'data-slot': 'swarm-digest' }, icon('archive'), h('span', null, `${num(d.count)} older ${noun}${num(d.count) === 1 ? '' : 's'} compacted`, d.by && Object.keys(d.by).length ? ` · ${Object.entries(d.by).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')}` : '')) : null);

  /* ---------- Overview ---------- */
  function overview(ctx) {
    const chat = chatKeyOf(ctx);
    const focus = ctx.r && !ctx.r.isMain ? ctx.r : null;
    return liveView(ctx, 'swarm-overview', (c, refresh) => {
      const s = c.state || {}, cfg = c.config || {}, eff = cfg.effective || {};
      const topo = eff.topology || s.topology || 'tree';
      const paused = !!(eff.paused || s.paused);
      const pats = cfg.effectivePatterns || [];
      const agents = agentsOf(ctx);
      const openVotes = (s.votes || []).filter((v) => isLive(v.status)).length;
      const openAuctions = (s.auctions || []).filter((v) => isLive(v.status)).length;
      const liveDebates = (s.debates || []).filter((v) => isLive(v.status)).length;
      const configure = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'swarm-configure', onclick: () => settingsSheet(ctx, { onSaved: () => refresh(true) }) }, icon('sliders-horizontal'), h('span', null, 'Configure'));
      const pause = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'swarm-pause', 'aria-pressed': String(paused), onclick: async () => { pause.disabled = true; await run(ctx, 'setCommsConfig', { sessionKey: chat, patch: { paused: !paused } }, paused ? 'Agent-to-agent messages resumed.' : 'Agent-to-agent messages paused.'); refresh(true); } }, icon(paused ? 'play' : 'pause'), h('span', null, paused ? 'Resume' : 'Pause'));
      const stopAll = h('button', { type: 'button', class: 'btn btn-outline btn-sm sa-danger', 'data-slot': 'swarm-stop-all', onclick: () => confirmDialog({ title: 'Stop all coordination?', description: 'Stops every running agent in this chat and pauses agent-to-agent messages. Finished work and the blackboard stay.', confirmLabel: 'Stop all', destructive: true, onConfirm: async () => { const r = await run(ctx, 'commsStopAll', { sessionKey: chat }); if (r) toast(`Stopped ${(r.stopped || []).length} agent${(r.stopped || []).length === 1 ? '' : 's'}; messages paused.`, { type: 'success' }); refresh(true); } }) }, icon('octagon-x'), h('span', null, 'Stop all'));
      const hero = h('section', { class: 'sw-hero', 'data-slot': 'swarm-topology', 'aria-label': 'Topology' },
        glyph(topo, 56),
        h('div', { class: 'sw-hero-text' },
          h('p', { class: 'sw-eyebrow' }, cfg.config?.topology ? 'This chat' : 'Default'),
          h('p', { class: 'sw-hero-title' }, (TOPO[topo] || [topo])[0], ' ', chip(paused ? 'Paused' : 'Live', paused ? 'warn' : 'ok', { 'data-slot': 'swarm-live' })),
          h('p', { class: 'field-hint' }, (TOPO[topo] || ['', ''])[1])),
        h('div', { class: 'sw-hero-actions' }, configure, pause, stopAll));
      const stat = (label, value, slot, tab) => h(tab ? 'button' : 'div', { class: 'sw-stat', type: tab ? 'button' : null, 'data-slot': slot, onclick: tab && ctx.pick ? () => { if (tab.includes(':')) decisionKind.set(chatKeyOf(ctx), tab.split(':')[1]); ctx.pick(tab.split(':')[0]); } : null }, h('span', { class: 'sw-stat-v' }, String(value)), h('span', { class: 'sw-stat-l' }, label));
      const stats = h('div', { class: 'sw-stats', 'data-slot': 'swarm-stats' },
        stat('Messages', num(s.messageCount), 'stat-messages'),
        stat('Topics', (s.topics || []).length, 'stat-topics', 'topics'),
        stat('Board keys', (s.blackboard || []).length, 'stat-board', 'board'),
        stat('Open decisions', openVotes + openAuctions + liveDebates, 'stat-open', `decisions:${openVotes ? 'votes' : openAuctions ? 'market' : liveDebates ? 'debates' : 'market'}`),
        stat('Handoffs', (s.handoffs || []).length, 'stat-handoffs'));
      const coord = s.coordinator ? h('p', { class: 'sw-coord', 'data-slot': 'swarm-coordinator' }, icon('crown'), h('span', null, 'Coordinator: ', h('strong', null, s.coordinatorName || nameOf(ctx, s.coordinator)), s.term ? ` · term ${s.term}` : '')) : null;
      const patsEl = h('div', { class: 'sw-card', 'data-slot': 'swarm-patterns' }, h('h4', null, 'How they coordinate'),
        h('ul', { class: 'sw-pills' }, ...Object.keys(PATTERN).map((p) => h('li', { class: 'sw-pill', 'data-on': String(pats.includes(p)), title: PATTERN[p][1] }, icon(pats.includes(p) ? 'check' : 'minus'), PATTERN[p][0]))));
      const roles = h('div', { class: 'sw-card', 'data-slot': 'swarm-roles' }, h('h4', null, focus ? 'This agent' : 'Roles'),
        agents.length ? h('ul', { class: 'sw-roles' }, ...(focus ? [focus] : agents).slice(0, 40).map((r) => roleRow(ctx, r, topo, refresh))) : h('p', { class: 'field-hint' }, 'No sub-agents in this chat yet. Roles and per-agent topology appear here once agents start.'));
      const comp = s.compaction;
      const compEl = comp ? h('div', { class: 'sw-card', 'data-slot': 'swarm-compaction' }, h('h4', null, 'Auto-compaction'),
        h('p', { class: 'sw-comp-line' }, chip(comp.policy?.enabled === false ? 'Off' : 'On', comp.policy?.enabled === false ? null : 'ok'), ` Keeps the newest ${num(comp.policy?.keep)} whole once a history passes ${num(comp.policy?.at)}.`),
        h('dl', { class: 'sw-kv' },
          h('dt', null, 'Folded'), h('dd', null, `${num(comp.folded?.topics)} posts · ${num(comp.folded?.blackboard)} marks · ${num(comp.folded?.swarm)} decisions`),
          h('dt', null, 'Runs'), h('dd', null, `${num(comp.runs)}${comp.lastAt ? ` · last ${ago(comp.lastAt)}` : ''}`),
          h('dt', null, 'Prompt budget'), h('dd', null, `${num(comp.policy?.contextChars).toLocaleString()} chars`))) : null;
      return h('div', { class: 'sw-overview' }, hero, coord, stats, h('div', { class: 'sw-grid2' }, h('div', { class: 'sw-col' }, roles, patsEl), h('div', { class: 'sw-col' }, activity(ctx, s), compEl)));
    }, 'both');
  }
  function roleRow(ctx, r, chatTopo, refresh) {
    const role = select(ROLES, r.commsRole || 'member', { 'aria-label': `Role of ${r.name}`, 'data-slot': 'swarm-role', onchange: async () => { await run(ctx, 'setCommsRole', { id: r.id, role: role.value }, `${r.name} is now ${ROLES[role.value].toLowerCase()}.`); refresh(true); } });
    const topo = h('select', { class: 'select', 'aria-label': `Topology of ${r.name}`, 'data-slot': 'swarm-agent-topology', onchange: async () => { await run(ctx, 'setCommsRole', { id: r.id, topology: topo.value || null }, 'Topology changed.'); refresh(true); } },
      h('option', { value: '', selected: !r.topology || undefined }, `Inherit (${(TOPO[chatTopo] || [chatTopo])[0]})`), ...Object.keys(TOPO).map((t) => h('option', { value: t, selected: r.topology === t || undefined }, TOPO[t][0])));
    return h('li', { class: 'sw-role', 'data-id': r.id }, h('span', { class: 'sw-dot', 'data-status': r.status }), h('span', { class: 'sw-role-name truncate', title: r.name }, r.name), role, topo);
  }
  /** Everything the swarm did, newest first, from the state's logs. */
  function activity(ctx, s) {
    const items = [];
    const push = (at, ic, text, kind) => { if (at) items.push({ at: num(at), ic, text, kind }); };
    for (const x of s.handoffs || []) push(x.at, 'arrow-right-left', `${x.fromName || nameOf(ctx, x.fromId)} handed off to ${x.toName || nameOf(ctx, x.toId)}${x.note ? `: ${truncate(x.note, 80)}` : ''}`, 'handoff');
    for (const x of s.auctions || []) { push(x.createdAt, 'gavel', `${x.announcerName || 'An agent'} announced “${truncate(x.task || '', 70)}”`, 'auction'); if (x.closedAt) push(x.closedAt, 'gavel', x.winnerName ? `${x.winnerName} won “${truncate(x.task || '', 60)}”` : `“${truncate(x.task || '', 60)}” closed: ${statusText(x.status)}`, 'auction'); }
    for (const x of s.votes || []) { push(x.createdAt, 'vote', `${x.callerName || 'An agent'} called a vote: ${truncate(x.question || '', 70)}`, 'vote'); if (x.closedAt) push(x.closedAt, 'vote', x.winner ? `Vote decided: ${truncate(x.winner, 60)}` : `Vote closed: ${statusText(x.status)}`, 'vote'); }
    for (const x of s.debates || []) { push(x.createdAt, 'messages-square', `Debate started: ${truncate(x.topic || '', 70)}`, 'debate'); if (x.closedAt) push(x.closedAt, 'messages-square', `Debate ${statusText(x.status).toLowerCase()}: ${truncate(x.topic || '', 60)}`, 'debate'); }
    for (const x of s.elections || []) push(x.at, 'crown', `${x.winnerName || nameOf(ctx, x.winnerId)} elected coordinator (term ${num(x.term)})`, 'election');
    for (const x of s.rumors || []) push(x.createdAt, 'radio', `${x.originName || 'An agent'} spread: ${truncate(x.fact || '', 70)}`, 'gossip');
    for (const t of s.topics || []) for (const p of (t.posts || []).slice(0, 3)) push(p.at, 'hash', `${p.fromName || p.from || 'An agent'} in #${t.name}: ${truncate(p.text || '', 70)}`, 'topic');
    items.sort((a, b) => b.at - a.at);
    return h('div', { class: 'sw-card', 'data-slot': 'swarm-activity' }, h('h4', null, 'Activity'),
      items.length ? h('ol', { class: 'sw-feed', role: 'log', 'aria-label': 'Swarm activity, newest first' }, ...items.slice(0, 14).map((x) => h('li', { class: 'sw-feed-item', 'data-kind': x.kind }, icon(x.ic), h('span', { class: 'sw-feed-text' }, x.text), h('time', { class: 'sw-feed-time', datetime: new Date(x.at).toISOString() }, ago(x.at)))))
        : h('p', { class: 'field-hint' }, 'Nothing yet. Handoffs, posts, bids, votes, debates and elections show up here as they happen.'));
  }

  /* ---------- Topics ---------- */
  const topicSel = new Map(); // chat -> selected topic
  function topics(ctx) {
    const chat = chatKeyOf(ctx);
    const draft = { text: '', name: '' };
    return liveView(ctx, 'swarm-topics', (c, refresh) => {
      const list = (c.state?.topics || []).slice().sort((a, b) => num(b.lastAt) - num(a.lastAt));
      let sel = topicSel.get(chat);
      if (!list.some((t) => t.name === sel)) sel = list[0]?.name;
      const name = h('input', { class: 'input', type: 'text', maxlength: '60', placeholder: 'new-topic', 'aria-label': 'New topic name', 'data-slot': 'topic-new-name', value: draft.name, oninput: () => { draft.name = name.value; } });
      const create = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'topic-create', onclick: async () => { const n = name.value.trim(); if (!n) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; } const r = await run(ctx, 'topicCreate', { sessionKey: chat, topic: n }, `#${n} created.`); if (r) { draft.name = ''; topicSel.set(chat, r.topic || n.toLowerCase()); refresh(); } } }, icon('plus'), h('span', null, 'New topic'));
      const side = h('div', { class: 'sw-master', role: 'listbox', 'aria-label': 'Topics', 'data-slot': 'topic-list' },
        ...list.map((t) => h('button', { type: 'button', role: 'option', class: 'sw-master-item', 'aria-selected': String(t.name === sel), 'data-topic': t.name, onclick: () => { topicSel.set(chat, t.name); refresh(); },
          onkeydown: (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const sib = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling; sib?.focus(); } } },
          h('span', { class: 'sw-master-name' }, icon('hash'), h('span', { class: 'truncate' }, t.name)),
          h('span', { class: 'sw-master-meta' }, `${num(t.total)} post${num(t.total) === 1 ? '' : 's'} · ${(t.subscribers || []).length} subscribed${t.lastAt ? ` · ${ago(t.lastAt)}` : ''}`))));
      const t = list.find((x) => x.name === sel);
      let detail;
      if (!t) detail = empty('hash', 'No topics yet', 'Agents create topics when they publish. You can start one and post to it too.');
      else {
        const ta = h('textarea', { class: 'textarea', rows: '2', maxlength: '4000', placeholder: `Post to #${t.name} as you`, 'aria-label': `Post to #${t.name}`, 'data-slot': 'topic-compose', oninput: () => { draft.text = ta.value; } });
        ta.value = draft.text;
        const send = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'topic-send', onclick: async () => { const m = ta.value.trim(); if (!m) { ta.focus(); return; } const r = await run(ctx, 'topicPublish', { sessionKey: chat, topic: t.name, message: m }, `Posted to #${t.name}.`); if (r) { draft.text = ''; refresh(); } } }, icon('send'), h('span', null, 'Post'));
        const del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm sa-danger', 'data-slot': 'topic-delete', onclick: () => confirmDialog({ title: `Delete #${t.name}?`, description: 'Its posts and subscriptions go. Agents can create it again by publishing.', confirmLabel: 'Delete', destructive: true, onConfirm: async () => { await run(ctx, 'topicDelete', { sessionKey: chat, topic: t.name }, `#${t.name} deleted.`); refresh(); } }) }, icon('trash-2'), h('span', null, 'Delete'));
        const subs = (t.subscribers || []).map((id) => nameOf(ctx, id));
        detail = h('div', { class: 'sw-detail', 'data-slot': 'topic-detail' },
          head(`#${t.name}`, subs.length ? `Subscribed: ${subs.join(', ')}` : 'Nobody subscribed yet.', del),
          digestLine(t.digest, 'post'),
          (t.posts || []).length ? h('ol', { class: 'sw-posts', 'aria-label': `Posts in #${t.name}, newest first` }, ...(t.posts || []).map((p) => h('li', { class: 'sw-post' }, h('div', { class: 'sw-post-head' }, h('strong', null, p.fromName || p.from || 'You'), h('time', { datetime: new Date(num(p.at)).toISOString() }, ago(p.at))), h('p', { class: 'sw-post-text' }, p.text || ''), (p.tags || []).length ? h('div', { class: 'sw-tags' }, ...p.tags.map((x) => chip(x))) : null)))
            : h('p', { class: 'field-hint' }, 'No posts yet.'),
          h('div', { class: 'sw-compose' }, ta, h('div', { class: 'row-actions' }, send)));
      }
      return h('div', null, head('Topics', 'Publish / subscribe channels. Old posts fold into a digest so agents keep the gist without the length.', h('div', { class: 'sw-inline' }, name, create)),
        list.length ? h('div', { class: 'sw-md' }, side, detail) : detail);
    });
  }

  /* ---------- Blackboard ---------- */
  function board(ctx) {
    const chat = chatKeyOf(ctx);
    const q = { v: '' };
    return liveView(ctx, 'swarm-board', (c, refresh) => {
      const s = c.state || {};
      const all = (s.blackboard || []).slice().sort((a, b) => num(b.updatedAt) - num(a.updatedAt));
      const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter keys and values', 'aria-label': 'Filter the blackboard', 'data-slot': 'board-filter', value: q.v, oninput: () => { q.v = search.value; paintRows(); } });
      const add = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'board-add', onclick: () => editEntry(ctx, chat, null, refresh) }, icon('plus'), h('span', null, 'New entry'));
      const rows = h('ul', { class: 'sw-board', 'aria-label': 'Blackboard entries', 'data-slot': 'board-list' });
      function paintRows() {
        const f = q.v.trim().toLowerCase();
        const shown = all.filter((e) => !f || `${e.key} ${e.value}`.toLowerCase().includes(f));
        setChildren(rows, ...shown.map((e) => {
          const w = Math.max(0, Math.min(1, num(e.weight, 1)));
          return h('li', { class: 'sw-entry', 'data-key': e.key, 'data-faded': w < 0.25 ? 'true' : null },
            h('div', { class: 'sw-entry-head' }, h('code', { class: 'sw-entry-key' }, e.key), chip(`v${num(e.version)}`, null, { title: 'Version: a write must name it, so nobody overwrites a newer value by mistake.' }),
              h('span', { class: 'sw-spacer' }),
              iconButton(`Edit ${e.key}`, icon('pencil'), () => editEntry(ctx, chat, e, refresh), { 'data-slot': 'board-edit' }),
              iconButton(`Delete ${e.key}`, icon('trash-2'), () => confirmDialog({ title: `Delete ${e.key}?`, description: 'Agents will no longer see it.', confirmLabel: 'Delete', destructive: true, onConfirm: async () => { await run(ctx, 'blackboardDelete', { sessionKey: chat, key: e.key, expectedVersion: e.version }, `${e.key} deleted.`); refresh(); } }), { 'data-slot': 'board-delete' })),
            h('p', { class: 'sw-entry-value' }, e.value || ''),
            h('div', { class: 'sw-entry-meta' }, h('span', null, `${e.authorName || nameOf(ctx, e.authorId)} · ${ago(e.updatedAt)}${num(e.writes) > 1 ? ` · ${num(e.writes)} writes` : ''}`),
              h('span', { class: 'sw-weight', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(w * 100)), 'aria-label': 'Mark strength' }, h('i', { style: { width: `${Math.round(w * 100)}%` } })), (e.tags || []).length ? h('span', { class: 'sw-tags' }, ...e.tags.map((t) => chip(t))) : null));
        }));
        if (!shown.length) rows.append(h('li', { class: 'sw-entry-none' }, all.length ? 'Nothing matches the filter.' : 'Empty. Agents write findings here; marks fade unless someone reinforces them.'));
      }
      paintRows();
      return h('div', null, head('Blackboard', 'Shared notes every agent can read. Each write names the version it read, so conflicting writes are refused, not lost.', add),
        digestLine(s.boardDigest, 'mark'), h('div', { class: 'sw-toolbar' }, search, h('span', { class: 'field-hint' }, `${all.length} key${all.length === 1 ? '' : 's'}`)), rows);
    });
  }
  function editEntry(ctx, chat, e, refresh) {
    let dlg = null;
    const key = h('input', { class: 'input', type: 'text', maxlength: '120', value: e?.key || '', readOnly: !!e, 'data-slot': 'board-key', placeholder: 'e.g. findings/pricing' });
    const val = h('textarea', { class: 'textarea', rows: '6', maxlength: '8000', 'data-slot': 'board-value' });
    val.value = e?.value || '';
    const tags = h('input', { class: 'input', type: 'text', maxlength: '200', value: (e?.tags || []).join(', '), placeholder: 'comma, separated', 'data-slot': 'board-tags' });
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true, 'data-slot': 'board-error' });
    const save = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'board-save', onclick: async () => {
      err.hidden = true;
      if (!key.value.trim()) { key.setAttribute('aria-invalid', 'true'); key.focus(); return; }
      save.disabled = true;
      try {
        await ctx.call('blackboardWrite', { sessionKey: chat, key: key.value.trim(), value: val.value, tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean), expectedVersion: e ? e.version : 0 });
        toast(e ? `${e.key} updated.` : 'Entry added.', { type: 'success' }); dlg.close(); refresh();
      } catch (x) { err.textContent = redactSecrets(x?.message || String(x), 300); err.hidden = false; save.disabled = false; }
    } }, icon('check'), h('span', null, 'Save'));
    dlg = openDialog({ title: e ? `Edit ${e.key}` : 'New blackboard entry', description: e ? `You are editing version ${num(e.version)}. If an agent writes first, you will be told instead of overwriting it.` : 'Agents see it the next time they read the blackboard.', size: 'md',
      body: h('div', { class: 'sw-form' }, field('Key', key), field('Value', val), field('Tags', tags), err),
      footer: h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dlg.close() }, 'Cancel'), save), initialFocus: e ? val : key });
    return dlg;
  }

  /* ---------- decision views ---------- */
  function listView(ctx, slot, title, desc, pick, card, emptyArgs) {
    const filter = { v: 'all' };
    return liveView(ctx, slot, (c) => {
      const s = c.state || {};
      const all = (pick(s) || []).slice().sort((a, b) => (isLive(b.status) - isLive(a.status)) || num(b.createdAt || b.at) - num(a.createdAt || a.at));
      const liveN = all.filter((x) => isLive(x.status)).length;
      const seg = h('div', { class: 'segmented sw-seg', role: 'radiogroup', 'aria-label': 'Show' },
        ...[['all', `All ${all.length}`], ['open', `Open ${liveN}`], ['closed', `Closed ${all.length - liveN}`]].map(([v, l]) => h('button', { type: 'button', role: 'radio', class: 'segmented-item', 'aria-checked': String(filter.v === v), 'data-filter': v, onclick: () => { filter.v = v; paint(); } }, l)));
      const listEl = h('div', { class: 'sw-cards', 'data-slot': `${slot}-list` });
      function paint() {
        for (const b of seg.querySelectorAll('[role=radio]')) b.setAttribute('aria-checked', String(b.dataset.filter === filter.v));
        const shown = all.filter((x) => filter.v === 'all' || (filter.v === 'open') === isLive(x.status));
        setChildren(listEl, ...(shown.length ? shown.map((x) => card(ctx, x)) : [empty(...emptyArgs)]));
      }
      paint();
      return h('div', null, head(title, desc, all.length ? seg : null), digestLine((s.digests || {})[{ market: 'auctions' }[slot.replace('swarm-', '')] || slot.replace('swarm-', '')], 'item'), listEl);
    });
  }
  const cardHead = (ic, title, status, sub) => h('div', { class: 'sw-dcard-head' }, h('span', { class: 'sw-dcard-icon' }, icon(ic)), h('div', { class: 'sw-dcard-title' }, h('p', { class: 'sw-dcard-name' }, title), sub ? h('p', { class: 'field-hint' }, sub) : null), chip(statusText(status), isLive(status) ? 'live' : WARN_STATUS.has(status) ? 'warn' : 'ok', { 'data-slot': 'decision-status' }));
  function auctionCard(ctx, a) {
    const bids = a.bids || [];
    return h('article', { class: 'sw-dcard', 'data-id': a.id, 'data-status': a.status, 'data-slot': 'auction-card' },
      cardHead('gavel', a.task || 'Task', a.status, `${a.announcerName || 'An agent'} · ${POLICIES[a.policy] || a.policy || ''} · ${ago(a.createdAt)}`),
      a.criteria ? h('p', { class: 'sw-dcard-text' }, h('strong', null, 'Criteria: '), a.criteria) : null,
      bids.length ? h('table', { class: 'sw-table', 'aria-label': 'Bids' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Bidder'), h('th', { scope: 'col' }, 'Cost'), h('th', { scope: 'col' }, 'Confidence'), h('th', { scope: 'col' }, 'Proposal'))),
        h('tbody', null, ...bids.map((b) => h('tr', { 'data-winner': b.bidderId === a.winnerId ? 'true' : null, 'data-declined': b.declined ? 'true' : null },
          h('th', { scope: 'row' }, b.bidderId === a.winnerId ? icon('crown') : null, b.bidderName || nameOf(ctx, b.bidderId)), h('td', null, b.declined ? '—' : b.cost != null ? String(b.cost) : '—'), h('td', null, b.declined ? '—' : b.confidence != null ? `${Math.round(num(b.confidence) * (num(b.confidence) <= 1 ? 100 : 1))}%` : '—'), h('td', null, b.declined ? 'Declined' : b.proposal || '')))))
        : h('p', { class: 'field-hint' }, isLive(a.status) ? `Waiting for bids from ${(a.invited || []).length || 'all'} agent${(a.invited || []).length === 1 ? '' : 's'}.` : 'No bids.'),
      a.winnerName ? h('p', { class: 'sw-outcome' }, icon('crown'), 'Awarded to ', h('strong', null, a.winnerName)) : null);
  }
  function voteCard(ctx, v) {
    const tally = v.tally || {};
    const total = Object.values(tally).reduce((x, y) => x + num(y), 0) || (v.ballots || []).length;
    const voters = (v.voters || []).length;
    return h('article', { class: 'sw-dcard', 'data-id': v.id, 'data-status': v.status, 'data-slot': 'vote-card' },
      cardHead('vote', v.question || 'Vote', v.status, `${v.callerName || 'An agent'} · ${RULES[v.rule] || v.rule || ''}${v.quorum ? ` · quorum ${v.quorum}%` : ''} · ${total}/${voters || '?'} voted`),
      h('ul', { class: 'sw-tally', 'aria-label': 'Options' }, ...(v.options || Object.keys(tally)).map((o) => { const n = num(tally[o]); const pct = total ? Math.round((n / total) * 100) : 0; return h('li', { class: 'sw-tally-row', 'data-winner': v.winner === o ? 'true' : null },
        h('div', { class: 'sw-tally-head' }, h('span', null, v.winner === o ? icon('check') : null, o), h('span', { class: 'sw-tally-n' }, `${n} · ${pct}%`)), h('span', { class: 'sw-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `${o}: ${pct}%` }, h('i', { style: { width: `${pct}%` } }))); })),
      (v.ballots || []).length ? h('details', { class: 'sw-more' }, h('summary', null, `Ballots (${v.ballots.length})`), h('ul', { class: 'sw-ballots' }, ...v.ballots.map((b) => h('li', null, h('strong', null, b.voterName || nameOf(ctx, b.voterId)), ` → ${b.option}`, b.reason ? h('span', { class: 'field-hint' }, ` — ${b.reason}`) : null)))) : null);
  }
  function debateCard(ctx, d) {
    const rounds = Math.max(1, num(d.rounds, 1));
    const byRound = new Map();
    for (const t of d.turns || []) { if (!byRound.has(t.round)) byRound.set(t.round, []); byRound.get(t.round).push(t); }
    return h('article', { class: 'sw-dcard', 'data-id': d.id, 'data-status': d.status, 'data-slot': 'debate-card' },
      cardHead('messages-square', d.topic || 'Debate', d.status, `${d.moderatorName || 'An agent'} moderates · ${(d.participants || []).map((p) => nameOf(ctx, p)).join(', ')}`),
      h('div', { class: 'sw-rounds', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(rounds), 'aria-valuenow': String(num(d.round)), 'aria-label': `Round ${num(d.round)} of ${rounds}` }, ...Array.from({ length: rounds }, (_, i) => h('i', { 'data-done': i < num(d.round) ? 'true' : null }))),
      digestLine(d.digest, 'turn'),
      ...[...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([r, ts]) => h('section', { class: 'sw-round', 'aria-label': `Round ${r}` }, h('h5', null, `Round ${r}`), h('ul', { class: 'sw-turns' }, ...ts.map((t) => h('li', { class: 'sw-turn' }, h('div', { class: 'sw-post-head' }, h('strong', null, t.agentName || nameOf(ctx, t.agentId)), t.stance ? chip(t.stance, t.stance === 'agree' ? 'ok' : t.stance === 'disagree' ? 'warn' : null) : null), h('p', { class: 'sw-post-text' }, t.position || '')))))));
  }
  function electionCard(ctx, e) {
    return h('article', { class: 'sw-dcard', 'data-id': e.id, 'data-status': 'closed', 'data-slot': 'election-card' },
      cardHead('crown', `Term ${num(e.term)}: ${e.winnerName || nameOf(ctx, e.winnerId)}`, e.winnerId ? 'decided' : 'error', `${e.method === 'vote' ? 'By vote' : 'By rank'} · ${ago(e.at)}`),
      h('p', { class: 'sw-dcard-text' }, h('strong', null, 'Candidates: '), (e.candidates || []).map((x) => nameOf(ctx, x)).join(', ') || '—'),
      e.reason ? h('p', { class: 'field-hint' }, e.reason) : null);
  }


  const LISTS = {
    market: ['Market', 'Contract-net: an agent announces a task, others bid, the policy picks the winner.', (s) => s.auctions, auctionCard, ['gavel', 'No auctions yet', 'Agents announce tasks here when the market pattern is on.']],
    votes: ['Votes', 'Group decisions by the chat\u2019s rule and quorum.', (s) => s.votes, voteCard, ['vote', 'No votes yet', 'Agents call votes here when the vote pattern is on.']],
    debates: ['Debates', 'Rounds of positions; a debate stops early once everyone agrees.', (s) => s.debates, debateCard, ['messages-square', 'No debates yet', 'Agents start debates here when the debate pattern is on.']],
    elections: ['Elections', 'Who coordinates. The winner\u2019s name goes into every agent\u2019s prompt; each election starts a new term.', (s) => (s.elections || []).map((x) => ({ ...x, status: x.winnerId ? 'decided' : 'no_majority' })), electionCard, ['crown', 'No elections yet', 'Agents elect a coordinator by rank or by vote when the election pattern is on.']],
  };
  const decisionKind = new Map(); // chat -> market | votes | debates | elections
  /** Market, Votes, Debates and Elections in one section, switched by a segmented control (not another tab row). */
  function decisions(ctx) {
    const chat = chatKeyOf(ctx);
    const host = h('div', { class: 'sw-decisions', 'data-slot': 'swarm-decisions' });
    const counts = (k) => { const s = cache.get(chat)?.state; const l = s ? LISTS[k][2](s) || [] : []; return l.filter((x) => isLive(x.status)).length; };
    const seg = h('div', { class: 'segmented sw-kinds', role: 'radiogroup', 'aria-label': 'Kind of decision', 'data-slot': 'decision-kinds' });
    let slot = h('div');
    function show(k, focus) {
      decisionKind.set(chat, k);
      setChildren(seg, ...KINDS.map(([id, label, ic]) => { const n = counts(id); return h('button', { type: 'button', role: 'radio', class: 'segmented-item', 'aria-checked': String(id === k), tabindex: id === k ? '0' : '-1', 'data-kind': id,
        onclick: () => show(id, true),
        onkeydown: (e) => { const i = KINDS.findIndex((x) => x[0] === id); const L = KINDS.length; const to = { ArrowRight: (i + 1) % L, ArrowDown: (i + 1) % L, ArrowLeft: (i - 1 + L) % L, ArrowUp: (i - 1 + L) % L, Home: 0, End: L - 1 }[e.key]; if (to !== undefined) { e.preventDefault(); show(KINDS[to][0], true); } } },
        icon(ic), h('span', null, label), n ? h('span', { class: 'sw-count', 'aria-label': `${n} open` }, String(n)) : null); }));
      const v = listView(ctx, `swarm-${k}`, ...LISTS[k]);
      slot.replaceWith(v); slot = v;
      if (focus) seg.querySelector(`[data-kind="${k}"]`)?.focus();
    }
    host.append(seg, slot);
    show(decisionKind.get(chat) || 'market');
    return host;
  }

  function render(tab, ctx) {
    if (!ctx.can?.('subagentSwarm')) return null;
    switch (tab) {
      case 'swarm': return overview(ctx);
      case 'topics': return topics(ctx);
      case 'board': return board(ctx);
      case 'decisions': return decisions(ctx);
      default: return null;
    }
  }

  /* ---------- settings sheet ---------- */
  function settingsSheet(ctx, { onSaved, scope: scope0 = 'chat' } = {}) {
    const chat = chatKeyOf(ctx);
    let scope = scope0, data = null, dlg = null, draft = {}, edges = [];
    const body = h('div', { class: 'sw-sheet', 'data-slot': 'swarm-settings', 'aria-busy': 'true' }, h('div', { class: 'sw-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true, 'data-slot': 'swarm-settings-error' });
    const save = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'swarm-settings-save', onclick: () => commit() }, icon('check'), h('span', null, 'Save'));
    const key = () => (scope === 'defaults' ? '*' : chat);
    async function reload() {
      try { data = await ctx.call('commsConfig', { sessionKey: key() }); } catch (e) { err.textContent = redactSecrets(e?.message || String(e), 300); err.hidden = false; return; }
      draft = { ...(data.config || {}) };
      edges = (draft.edges || []).map((e) => ({ ...e }));
      paint();
    }
    const inherited = (k) => (scope === 'defaults' ? undefined : data?.defaults?.[k]) ?? data?.effective?.[k];
    function paint() {
      body.removeAttribute('aria-busy');
      const eff = data.effective || {};
      const curTopo = draft.topology || (scope === 'defaults' ? eff.topology : data.defaults?.topology) || eff.topology || 'tree';
      const scopeSeg = h('div', { class: 'segmented sw-scope', role: 'radiogroup', 'aria-label': 'Applies to' },
        ...[['chat', 'This chat'], ['defaults', 'Defaults for every chat']].map(([v, l]) => h('button', { type: 'button', role: 'radio', class: 'segmented-item', 'aria-checked': String(scope === v), 'data-scope': v, onclick: () => { if (scope !== v) { scope = v; body.setAttribute('aria-busy', 'true'); reload(); } } }, l)));
      // Presets
      const presets = data.presets || [];
      const presetSel = h('select', { class: 'select', 'aria-label': 'Preset', 'data-slot': 'swarm-preset' }, h('option', { value: '' }, 'Choose a preset\u2026'), ...presets.map((p) => h('option', { value: p.name }, `${p.title || p.name}${p.builtin ? '' : ' (yours)'}`)));
      const presetDesc = h('p', { class: 'field-hint', 'data-slot': 'swarm-preset-desc' }, 'Presets set the topology, patterns and rules in one go.');
      presetSel.onchange = () => { const p = presets.find((x) => x.name === presetSel.value); presetDesc.textContent = p ? p.description || '' : 'Presets set the topology, patterns and rules in one go.'; delPreset.disabled = !p || !!p.builtin; };
      const applyPreset = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'swarm-preset-apply', onclick: async () => { if (!presetSel.value) { presetSel.focus(); return; } const r = await run(ctx, 'applyCommsPreset', { sessionKey: key(), name: presetSel.value }, 'Preset applied.'); if (r) { data = r.config ? r : await ctx.call('commsConfig', { sessionKey: key() }); draft = { ...(data.config || {}) }; edges = (draft.edges || []).map((e) => ({ ...e })); paint(); onSaved?.(); } } }, 'Apply');
      const savePreset = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-slot': 'swarm-preset-save', onclick: () => presetDialog() }, icon('plus'), 'Save as preset');
      const delPreset = h('button', { type: 'button', class: 'btn btn-ghost btn-sm sa-danger', disabled: true, 'data-slot': 'swarm-preset-delete', onclick: () => confirmDialog({ title: `Delete preset ${presetSel.value}?`, description: 'Chats that used it keep their settings.', confirmLabel: 'Delete', destructive: true, onConfirm: async () => { const r = await run(ctx, 'deleteCommsPreset', { name: presetSel.value }, 'Preset deleted.'); if (r) reload(); } }) }, icon('trash-2'), 'Delete');
      // Topology cards
      const topoGrid = h('div', { class: 'sw-topos', role: 'radiogroup', 'aria-label': 'Topology', 'data-slot': 'swarm-topologies' },
        ...Object.keys(TOPO).map((t) => h('button', { type: 'button', role: 'radio', class: 'sw-topo', 'data-topology': t, 'aria-checked': String(curTopo === t), tabindex: curTopo === t ? '0' : '-1',
          onclick: () => { draft.topology = t; if (!draft.patterns) delete draft.patterns; paint(); body.querySelector(`[data-topology="${t}"]`)?.focus(); },
          onkeydown: (e) => { const keys = Object.keys(TOPO); const i = keys.indexOf(t); const L = keys.length; const to = { ArrowRight: (i + 1) % L, ArrowDown: (i + 1) % L, ArrowLeft: (i - 1 + L) % L, ArrowUp: (i - 1 + L) % L, Home: 0, End: L - 1 }[e.key]; if (to !== undefined) { e.preventDefault(); const n = keys[to]; draft.topology = n; paint(); body.querySelector(`button[data-topology="${n}"]`)?.focus(); } } },
          glyph(t, 36), h('span', { class: 'sw-topo-name' }, TOPO[t][0]), h('span', { class: 'sw-topo-desc' }, TOPO[t][1]))));
      // Patterns
      const defPats = (data.defaultPatterns || {})[curTopo] || [];
      const pats = draft.patterns || defPats;
      const patList = h('div', { class: 'sw-checks', role: 'group', 'aria-label': 'Patterns', 'data-slot': 'swarm-patterns-edit' },
        ...Object.keys(PATTERN).map((p) => { const cb = h('input', { type: 'checkbox', class: 'checkbox', checked: pats.includes(p), 'data-pattern': p, onchange: () => { const cur = new Set(draft.patterns || defPats); if (cb.checked) cur.add(p); else cur.delete(p); draft.patterns = Object.keys(PATTERN).filter((x) => cur.has(x)); patHint.textContent = patHintText(); } });
          return h('label', { class: 'sw-check' }, cb, h('span', null, h('span', { class: 'sw-check-name' }, PATTERN[p][0]), h('span', { class: 'field-hint' }, PATTERN[p][1]))); }));
      const patHintText = () => (draft.patterns ? 'Your own choice of patterns.' : `The ${TOPO[curTopo][0]} defaults.`);
      const patHint = h('p', { class: 'field-hint', 'data-slot': 'swarm-patterns-hint' }, patHintText());
      const patReset = h('button', { type: 'button', class: 'btn btn-ghost btn-xs', 'data-slot': 'swarm-patterns-reset', onclick: () => { delete draft.patterns; paint(); } }, 'Use topology defaults');
      // Selects and numbers
      const pickField = (k, label, options, hint) => {
        const inh = inherited(k);
        const s = h('select', { class: 'select', 'data-key': k, onchange: () => { if (s.value) draft[k] = s.value; else delete draft[k]; } }, h('option', { value: '' }, `Inherit${inh != null ? ` (${options[inh] || inh})` : ''}`), ...Object.entries(options).map(([v, l]) => h('option', { value: v, selected: draft[k] === v || undefined }, l)));
        return field(label, s, hint);
      };
      const numField = ([k, label, lo, hi, hint]) => {
        const inh = k.startsWith('compact') ? data.effective?.compaction?.[{ compactKeep: 'keep', compactAt: 'at', compactContextChars: 'contextChars' }[k]] : inherited(k);
        const i = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: String(lo), max: String(hi), step: '1', 'data-key': k, placeholder: inh != null ? `${inh} (inherited)` : 'Inherit', value: draft[k] != null ? String(draft[k]) : '',
          oninput: () => { i.removeAttribute('aria-invalid'); const v = i.value.trim(); if (!v) delete draft[k]; else draft[k] = Number(v); } });
        return field(label, i, `${hint} ${lo.toLocaleString()}\u2013${hi.toLocaleString()}.`);
      };
      const boolField = (k, label, hint) => {
        const inh = k === 'compact' ? data.effective?.compaction?.enabled !== false : inherited(k);
        const cur = draft[k] != null ? !!draft[k] : !!inh;
        const cb = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: cur, 'data-key': k, 'aria-describedby': null, onchange: () => { draft[k] = cb.checked; } });
        return h('label', { class: 'sw-switch' }, cb, h('span', null, h('span', { class: 'sw-check-name' }, label), h('span', { class: 'field-hint' }, hint)));
      };
      const section = (title, desc, ...kids) => h('section', { class: 'sw-sec' }, h('h4', null, title), desc ? h('p', { class: 'field-hint' }, desc) : null, ...kids);
      setChildren(body,
        h('div', { class: 'sw-sheet-top' }, scopeSeg, h('p', { class: 'field-hint' }, scope === 'defaults' ? 'Every chat starts from these. A chat\u2019s own settings win.' : 'Only this chat. Empty fields follow the defaults.')),
        section('Preset', null, h('div', { class: 'sw-inline' }, presetSel, applyPreset, delPreset, savePreset), presetDesc),
        section('Topology', 'Who may talk to whom. Batches and single agents can override it when they start.', topoGrid),
        section('Patterns', null, patHint, patList, h('div', { class: 'row-actions' }, patReset)),
        section('Permissions', null, h('div', { class: 'sw-formgrid' }, pickField('whoCanBroadcast', 'Who can broadcast', WHO), pickField('whoCanSpawn', 'Who can start agents', WHO), pickField('blackboardWriters', 'Who can write the blackboard', WHO))),
        section('Decisions', null, h('div', { class: 'sw-formgrid' }, pickField('consensusRule', 'Vote rule', RULES), numField(['quorumPercent', 'Quorum %', 0, 100, 'Share of voters needed.']), pickField('auctionPolicy', 'Market award', POLICIES), pickField('electionMethod', 'Election', { rank: 'By rank', vote: 'By vote' }), numField(['maxRounds', 'Debate rounds', 1, 10, 'Most rounds a debate runs.']))),
        section('Limits', 'Loop and runaway protection. Requests also check for deadlocks before they wait.', h('div', { class: 'sw-formgrid' }, ...LIMITS.map(numField)), boolField('wakeIdle', 'Wake idle agents', 'A message to a finished agent starts it again.')),
        section('Auto-compaction', 'Old posts, faded marks and finished decisions fold into short digests; prompts carry a budgeted head and tail of long reports.', boolField('compact', 'Compact coordination state', 'Recommended. Nothing is dropped without a digest line.'), h('div', { class: 'sw-formgrid' }, ...COMPACT.map(numField))),
        section('Rules', 'Allow or deny messages between two agents. Deny always wins. * means any agent.', edgeEditor()),
        err);
    }
    function edgeEditor() {
      const names = ['*', ...agentsOf(ctx).map((r) => r.name)];
      const wrap = h('div', { class: 'sw-edges', 'data-slot': 'swarm-edges' });
      const paintEdges = () => {
        setChildren(wrap,
          edges.length ? h('ul', { class: 'sw-edge-list' }, ...edges.map((e, i) => {
            const opts = (v) => [...new Set([...names, v])].map((n) => h('option', { value: n, selected: n === v || undefined }, n === '*' ? 'Any agent' : n));
            const from = h('select', { class: 'select', 'aria-label': `Rule ${i + 1}: from`, 'data-slot': 'edge-from', onchange: () => { e.from = from.value; } }, ...opts(e.from));
            const to = h('select', { class: 'select', 'aria-label': `Rule ${i + 1}: to`, 'data-slot': 'edge-to', onchange: () => { e.to = to.value; } }, ...opts(e.to));
            const kind = select({ allow: 'Allow', deny: 'Deny' }, e.allow ? 'allow' : 'deny', { 'aria-label': `Rule ${i + 1}: allow or deny`, 'data-slot': 'edge-kind', onchange: () => { e.allow = kind.value === 'allow'; li.dataset.allow = String(e.allow); } });
            const both = h('input', { type: 'checkbox', class: 'checkbox', checked: !!e.both, 'aria-label': `Rule ${i + 1}: both directions`, onchange: () => { e.both = both.checked; arrow.replaceChildren(icon(e.both ? 'arrow-right-left' : 'arrow-right')); } });
            const arrow = h('span', { class: 'sw-edge-arrow', 'aria-hidden': 'true' }, icon(e.both ? 'arrow-right-left' : 'arrow-right'));
            const li = h('li', { class: 'sw-edge', 'data-allow': String(!!e.allow) }, kind, from, arrow, to, h('label', { class: 'sw-edge-both' }, both, 'Both ways'), iconButton(`Remove rule ${i + 1}`, icon('x'), () => { edges.splice(i, 1); paintEdges(); }, { 'data-slot': 'edge-remove' }));
            return li;
          })) : h('p', { class: 'field-hint' }, 'No rules. The topology alone decides.'),
          h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'edge-add', disabled: edges.length >= 200, onclick: () => { edges.push({ from: names[1] || '*', to: names[2] || '*', allow: true, both: false }); paintEdges(); wrap.querySelector('.sw-edge:last-child select')?.focus(); } }, icon('plus'), 'Add rule'),
            h('span', { class: 'field-hint' }, 'Tip: in the Graph, use Draw rule to connect two agents.')));
      };
      paintEdges();
      return wrap;
    }
    async function commit() {
      err.hidden = true;
      for (const i of body.querySelectorAll('input[type=number]')) if (!i.checkValidity()) { i.setAttribute('aria-invalid', 'true'); i.focus(); err.textContent = `${i.closest('.field')?.querySelector('label')?.textContent || 'A number'} must be ${i.min}\u2013${i.max}.`; err.hidden = false; return; }
      const base = data.config || {};
      const next = { ...draft, edges: edges.length ? edges : undefined };
      const patch = {};
      for (const k of new Set([...Object.keys(base), ...Object.keys(next)])) {
        const a = JSON.stringify(base[k] ?? null), b = JSON.stringify(next[k] ?? null);
        if (a !== b) patch[k] = next[k] ?? null;
      }
      if (!Object.keys(patch).length) { dlg.close(); return; }
      save.disabled = true;
      try {
        const r = await ctx.call('setCommsConfig', { sessionKey: key(), patch });
        save.disabled = false;
        if (r?.rejected?.length) { err.textContent = `Not saved: ${r.rejected.join(', ')}. Check the ranges.`; err.hidden = false; for (const k of r.rejected) body.querySelector(`[data-key="${k}"]`)?.setAttribute('aria-invalid', 'true'); return; }
        toast(scope === 'defaults' ? 'Defaults saved.' : 'Swarm settings saved.', { type: 'success' });
        cache.delete(chat);
        dlg.close();
        onSaved?.(r);
      } catch (e) { save.disabled = false; err.textContent = redactSecrets(e?.message || String(e), 300); err.hidden = false; }
    }
    function presetDialog() {
      let d2 = null;
      const name = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'e.g. research-crew', 'data-slot': 'preset-name' });
      const title = h('input', { class: 'input', type: 'text', maxlength: '80', placeholder: 'Research crew', 'data-slot': 'preset-title' });
      const desc = h('textarea', { class: 'textarea', rows: '2', maxlength: '300', 'data-slot': 'preset-desc' });
      const e2 = h('p', { class: 'field-error', role: 'alert', hidden: true });
      const ok = h('button', { type: 'button', class: 'btn btn-default btn-sm', 'data-slot': 'preset-save', onclick: async () => {
        if (!name.value.trim()) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
        try { await ctx.call('saveCommsPreset', { name: name.value.trim(), title: title.value.trim(), description: desc.value.trim(), config: { ...draft, edges: edges.length ? edges : undefined } }); toast('Preset saved.', { type: 'success' }); d2.close(); reload(); } catch (x) { e2.textContent = redactSecrets(x?.message || String(x), 300); e2.hidden = false; }
      } }, 'Save preset');
      d2 = openDialog({ title: 'Save as preset', description: 'Saves what this sheet shows now, so any chat can apply it.', size: 'sm', body: h('div', { class: 'sw-form' }, field('Name', name, 'Letters, digits and dashes.'), field('Title', title), field('Description', desc), e2), footer: h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => d2.close() }, 'Cancel'), ok), initialFocus: name });
    }
    dlg = openDialog({ title: 'Swarm settings', description: 'How the agents in this chat talk, decide and stay within limits.', size: 'lg', align: 'top', body,
      footer: h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dlg.close() }, 'Cancel'), save) });
    dlg.panel.classList.add('sw-sheet-dialog');
    reload();
    return dlg;
  }

  /** Add (or flip) one allow/deny rule for the chat: the Explorer's Draw rule mode. */
  async function addEdge(ctx, chat, edge) {
    const cfg = await ctx.call('commsConfig', { sessionKey: chat });
    const list = ((cfg.config || {}).edges || []).filter((e) => !(e.from === edge.from && e.to === edge.to));
    list.push({ from: edge.from, to: edge.to, allow: !!edge.allow, both: !!edge.both });
    const r = await ctx.call('setCommsConfig', { sessionKey: chat, patch: { edges: list } });
    if (r?.rejected?.length) throw new Error(`The rule was not saved (${r.rejected.join(', ')}).`);
    cache.delete(chat);
    return r;
  }

  /**
   * "How it talks" for the spawn and batch dialogs: a topology that overrides the chat's, and the role (single
   * agent) or the hub (batch). Returns the field and apply(req), which adds only what the user picked.
   */
  function spawnFields(ctx, { batch = false, hubNames = null } = {}) {
    const chat = chatKeyOf(ctx);
    const cur = cache.get(chat)?.config?.effective?.topology;
    const topo = h('select', { class: 'select', id: fieldId('topo'), 'data-slot': batch ? 'batch-topology' : 'spawn-topology' }, h('option', { value: '' }, `Same as the chat${cur ? ` (${(TOPO[cur] || [cur])[0]})` : ''}`), ...Object.keys(TOPO).map((t) => h('option', { value: t }, TOPO[t][0])));
    const hint = h('p', { class: 'field-hint', 'data-slot': batch ? 'batch-topology-hint' : 'spawn-topology-hint' }, batch ? 'How the agents of this batch talk to each other.' : 'Who this agent may talk to.');
    const role = batch ? null : select(ROLES, 'member', { id: fieldId('role'), 'data-slot': 'spawn-role' });
    const hub = batch ? h('select', { class: 'select', id: fieldId('hub'), 'data-slot': 'batch-hub' }, h('option', { value: '' }, 'None')) : null;
    const hubField = batch ? h('div', { class: 'field', hidden: true, 'data-slot': 'batch-hub-field' }, h('label', { class: 'label', for: hub.id }, 'Hub / lead'), hub, h('p', { class: 'field-hint' }, 'The star\u2019s centre, or the lead of a hierarchy.')) : null;
    const fillHub = () => { if (!hub) return; const v = hub.value; setChildren(hub, h('option', { value: '' }, 'First agent'), ...(hubNames ? hubNames() : []).map((n, i) => h('option', { value: String(i), selected: String(i) === v || undefined }, n))); };
    topo.onchange = () => { hint.textContent = topo.value ? TOPO[topo.value][1] : batch ? 'How the agents of this batch talk to each other.' : 'Who this agent may talk to.'; if (hubField) { hubField.hidden = !['star', 'hierarchical'].includes(topo.value); fillHub(); } };
    if (!cur) load(ctx, chat, 'config').then((c) => { const t = c.config?.effective?.topology; if (t) topo.options[0].textContent = `Same as the chat (${(TOPO[t] || [t])[0]})`; }).catch(() => {});
    const el = h('div', { class: 'sw-spawn', 'data-slot': batch ? 'batch-swarm' : 'spawn-swarm' },
      h('div', { class: 'sw-formgrid' }, h('div', { class: 'field' }, h('label', { class: 'label', for: topo.id }, 'How it talks'), topo, hint), role ? field('Role', role, 'Hubs and leads can broadcast and coordinate.') : hubField));
    function apply(req) {
      if (topo.value) req.topology = topo.value;
      if (role && role.value !== 'member') req.commsRole = role.value;
      if (hub && !hubField.hidden && hub.value !== '') req.hub = Number(hub.value);
      return req;
    }
    return { el, apply, refreshHub: fillHub };
  }

  return { TABS, KINDS, TOPO, PATTERN, render, settingsSheet, spawnFields, addEdge, glyph, _internal: { load, cache, activity } };
})();
