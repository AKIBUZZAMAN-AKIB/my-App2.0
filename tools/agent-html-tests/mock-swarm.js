// A stateful fake of the engine's swarm layer (subagents/channels.rs + swarm.rs + compact.rs) behind
// NativeKit.agent.subagents(), feature `subagentSwarm`. Load after mock-subagents.js. Shapes follow
// the engine: commsConfig/setCommsConfig/presets, swarmState, topics, blackboard with versions,
// setCommsRole, commsStopAll, and the graph's `swarm` + `handoffEdges`. window.__swarm seeds it.
(() => {
  const a = window.NativeKit && window.NativeKit.agent;
  if (!a || typeof a.subagents !== 'function' || !window.__sa) return;
  const rec = (name, args) => window.__mock.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
  const TOPOLOGIES = ['tree', 'star', 'mesh', 'ring', 'chain', 'bus', 'hierarchical', 'swarm', 'custom'];
  const PATTERNS = ['direct', 'broadcast', 'topics', 'blackboard', 'request', 'handoff', 'gossip', 'auction', 'vote', 'debate', 'election'];
  // Copied from the engine (channels::default_patterns); mock-swarm-contract.js checks they match.
  const DEFAULT_PATTERNS = {
    bus: ['broadcast', 'topics', 'blackboard'],
    chain: ['direct', 'request'],
    custom: ['direct', 'request'],
    hierarchical: ['direct', 'broadcast', 'topics', 'blackboard', 'request', 'vote'],
    mesh: ['direct', 'broadcast', 'topics', 'blackboard', 'request'],
    ring: ['direct', 'request'],
    star: ['direct', 'request'],
    tree: [],
    swarm: PATTERNS.slice(),
  };
  const RANGES = { maxHops: [1, 50], maxPairMessages: [0, 1000], maxMessages: [0, 100000], maxRounds: [1, 10], maxHandoffs: [0, 20], gossipFanout: [1, 10], quorumPercent: [0, 100], requestTimeoutS: [5, 1800], pheromoneHalfLifeMin: [1, 10080], compactKeep: [2, 45], compactAt: [4, 50], compactContextChars: [2000, 200000] };
  const ENUMS = { topology: TOPOLOGIES, consensusRule: ['majority', 'plurality', 'unanimous', 'supermajority'], auctionPolicy: ['best', 'cheapest', 'confident', 'first', 'manager'], whoCanBroadcast: ['all', 'leads', 'none'], whoCanSpawn: ['all', 'leads', 'none'], blackboardWriters: ['all', 'leads', 'none'], electionMethod: ['rank', 'vote'] };
  const BOOLS = ['wakeIdle', 'paused', 'compact'];
  // Copied from the engine (channels::builtin_presets); mock-swarm-contract.js checks they match.
  const BUILTIN = [
    ["strict-tree", "Strict tree", "Agents only report up; no talk between peers.", {"patterns": [], "topology": "tree"}],
    ["supervisor", "Supervisor", "A hub coordinates; spokes talk only to the hub.", {"patterns": ["direct", "request"], "topology": "star"}],
    ["open-swarm", "Open swarm", "Agents decide whom to talk to, hand off, bid, vote and elect a coordinator.", {"maxHandoffs": 5, "maxHops": 10, "patterns": ["direct", "broadcast", "topics", "blackboard", "request", "handoff", "gossip", "auction", "vote", "debate", "election"], "topology": "swarm"}],
    ["research-team", "Research team", "Sub-teams with leads; leads coordinate, findings go to topics and the blackboard.", {"patterns": ["direct", "topics", "blackboard", "request", "vote"], "topology": "hierarchical", "whoCanBroadcast": "leads", "whoCanSpawn": "leads"}],
    ["debate-panel", "Debate panel", "Agents argue in rounds, read each other and converge; unanimous decisions.", {"consensusRule": "unanimous", "maxRounds": 3, "patterns": ["direct", "request", "debate", "vote"], "topology": "mesh"}],
    ["market", "Market", "Contract net: tasks are announced, agents bid, the cheapest bid wins.", {"auctionPolicy": "cheapest", "patterns": ["direct", "request", "auction"], "topology": "mesh"}],
    ["blackboard", "Blackboard", "No direct talk: agents coordinate through topics and shared marks.", {"patterns": ["topics", "blackboard", "broadcast"], "topology": "bus"}],
    ["pipeline", "Pipeline", "Each agent talks to its neighbours only.", {"patterns": ["direct", "request"], "topology": "chain"}],
    ["gossip", "Gossip network", "News spreads peer to peer, a few at a time.", {"gossipFanout": 2, "patterns": ["gossip", "blackboard"], "topology": "mesh"}],
  ].map(([name, title, description, config]) => ({ name, title, description, config, builtin: true }));

  const seed = window.__swarm || {};
  const S = window.__swarm = Object.assign({
    configs: { '*': {} }, presets: [], topics: {}, board: {}, boardDigest: { count: 0, by: {}, gist: [] },
    auctions: [], votes: [], debates: [], elections: [], rumors: [], handoffs: [], digests: {},
    coordinator: null, coordinatorName: null, term: 0, messageCount: 0, comp: { runs: 0, items: 0, lastAt: null }, failNext: new Map(),
  }, seed);
  const chatKey = (req) => (req && req.sessionKey === '*' ? '*' : 'chat');
  const cfgOf = (k) => (S.configs[k] = S.configs[k] || {});
  function effective() {
    const o = { ...cfgOf('*'), ...cfgOf('chat') };
    return {
      topology: o.topology || 'tree', patterns: o.patterns || null, edges: o.edges || [], groups: o.groups || [],
      maxHops: o.maxHops ?? 8, maxPairMessages: o.maxPairMessages ?? 30, maxMessages: o.maxMessages ?? 500, maxRounds: o.maxRounds ?? 3, maxHandoffs: o.maxHandoffs ?? 5, gossipFanout: o.gossipFanout ?? 2,
      consensusRule: o.consensusRule || 'majority', quorumPercent: o.quorumPercent ?? 50, auctionPolicy: o.auctionPolicy || 'best', whoCanBroadcast: o.whoCanBroadcast || 'all', whoCanSpawn: o.whoCanSpawn || 'all', blackboardWriters: o.blackboardWriters || 'all',
      wakeIdle: o.wakeIdle ?? true, requestTimeoutS: o.requestTimeoutS ?? 120, pheromoneHalfLifeMin: o.pheromoneHalfLifeMin ?? 30, electionMethod: o.electionMethod || 'rank', paused: !!o.paused,
      compaction: { enabled: o.compact ?? true, keep: o.compactKeep ?? 12, at: o.compactAt ?? 30, contextChars: o.compactContextChars ?? 24000 },
    };
  }
  function payload(k) {
    const eff = effective();
    return { sessionKey: k === '*' ? '*' : 'chat', config: k === '*' ? cfgOf('*') : cfgOf('chat'), defaults: cfgOf('*'), effective: eff, effectivePatterns: eff.patterns || DEFAULT_PATTERNS[eff.topology], presets: [...BUILTIN, ...S.presets], topologies: TOPOLOGIES, patterns: PATTERNS, defaultPatterns: DEFAULT_PATTERNS };
  }
  function setConfig(k, patch) {
    const c = { ...cfgOf(k) };
    const rejected = [];
    for (const [key, v] of Object.entries(patch)) {
      if (v === null) { delete c[key]; continue; }
      if (RANGES[key]) { const [lo, hi] = RANGES[key]; if (!Number.isInteger(v) || v < lo || v > hi) { rejected.push(key); continue; } }
      else if (ENUMS[key]) { if (!ENUMS[key].includes(v)) { rejected.push(key); continue; } }
      else if (BOOLS.includes(key)) { if (typeof v !== 'boolean') { rejected.push(key); continue; } }
      else if (key === 'patterns') { if (!Array.isArray(v) || v.some((p) => !PATTERNS.includes(p))) { rejected.push(key); continue; } }
      else if (key === 'edges') { if (!Array.isArray(v) || v.length > 200 || v.some((e) => !e || !e.from || !e.to)) { rejected.push(key); continue; } }
      else if (key === 'groups') {
        // Like groups::validate_groups and normalize_groups.
        const names = new Set();
        const bad = !Array.isArray(v) || v.length > 50 || v.some((g) => { const n = String(g?.name || '').trim().toLowerCase(); if (!n || names.has(n) || !TOPOLOGIES.includes(String(g.topology || '').toLowerCase())) return true; names.add(n); return false; });
        if (bad) { rejected.push(key); continue; }
        c[key] = v.map((g) => ({ ...g, id: g.id || `tg_${Math.random().toString(16).slice(2, 10)}`, name: String(g.name).trim(), topology: String(g.topology).toLowerCase(), members: [...new Set((g.members || []).map((m) => String(m).trim()).filter(Boolean))] }));
        continue;
      }
      else { rejected.push(key); continue; }
      c[key] = v;
    }
    const keep = c.compactKeep ?? effective().compaction.keep, at = c.compactAt ?? effective().compaction.at;
    if (at <= keep && ('compactAt' in patch || 'compactKeep' in patch)) { for (const x of ['compactAt', 'compactKeep']) if (x in patch && !rejected.includes(x)) { rejected.push(x); delete c[x]; if (cfgOf(k)[x] != null) c[x] = cfgOf(k)[x]; } }
    rejected.sort();
    S.configs[k] = c;
    return rejected;
  }
  const subs = () => [...window.__sa.subs.values()];
  const nameOf = (id) => (id ? (window.__sa.subs.get(id) || {}).name || id : 'You');
  function fold(list, digest, keepN, at, canFold, gist) {
    const eff = effective();
    if (!eff.compaction.enabled || list.length <= at) return 0;
    const zone = list.length - keepN; let n = 0;
    const kept = [];
    list.forEach((x, i) => { if (i < zone && canFold(x)) { const [who, text] = gist(x); digest.count += 1; digest.by[who] = (digest.by[who] || 0) + 1; digest.gist.push(`${who}: ${text}`); if (digest.gist.length > 24) digest.gist.shift(); n++; } else kept.push(x); });
    list.splice(0, list.length, ...kept);
    if (n) { S.comp.runs += 1; S.comp.items += n; S.comp.lastAt = Date.now(); }
    return n;
  }
  function compactTopic(t) { const c = effective().compaction; fold(t.posts, t.digest, c.keep, c.at, () => true, (p) => [p.fromName || 'You', p.text.slice(0, 80)]); }
  function topicOut(name, t) { return { name, subscribers: t.subscribers, total: t.total, createdBy: t.createdBy || null, lastAt: t.posts.length ? t.posts[t.posts.length - 1].at : null, posts: t.posts.slice(-20).reverse(), digest: t.digest }; }
  // The engine's norm_topic: lower case, # dropped, anything but letters, digits, - _ . / becomes -.
  const normTopic = (t) => String(t || '').trim().replace(/^#+/, '').toLowerCase().replace(/[^\p{L}\p{N}\-_./]/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const ensureTopic = (name, by) => (S.topics[name] = S.topics[name] || { subscribers: [], total: 0, createdBy: by || null, posts: [], digest: { count: 0, by: {}, gist: [] } });
  // Like the engine's weight_now: each write adds 1 to what is left; it halves every half-life.
  function weight(e, at = Date.now()) { const hl = effective().pheromoneHalfLifeMin * 60000; return (e.weight ?? 1) * Math.pow(0.5, Math.max(0, at - (e.reinforcedAt ?? e.updatedAt)) / hl); }
  function mayMessage(x, y, eff, all) {
    const rule = (eff.edges || []).filter((e) => (e.from === '*' || e.from === x.name || e.from === x.id) && (e.to === '*' || e.to === y.name || e.to === y.id) || (e.both && (e.from === '*' || e.from === y.name || e.from === y.id) && (e.to === '*' || e.to === x.name || e.to === x.id)));
    if (rule.some((e) => !e.allow)) return null;
    if (rule.some((e) => e.allow)) return 'allow';
    const topo = x.topology || eff.topology;
    const sib = all.filter((s) => (s.parentId || '') === (x.parentId || ''));
    const i = sib.indexOf(x), j = sib.indexOf(y);
    const ok = {
      tree: () => x.parentId === y.id || y.parentId === x.id,
      star: () => x.commsRole === 'hub' || y.commsRole === 'hub',
      mesh: () => true, swarm: () => true,
      ring: () => j >= 0 && i >= 0 && j === (i + 1) % sib.length,
      chain: () => j >= 0 && i >= 0 && Math.abs(i - j) === 1,
      bus: () => false, custom: () => false,
      hierarchical: () => (x.commsRole === 'lead' && y.commsRole === 'lead') || (x.commsRole === 'lead' && y.parentId === x.id) || (y.commsRole === 'lead' && x.parentId === y.id),
    }[topo];
    if (ok && ok()) return 'topology';
    // Any topology group both agents are in can let it through (groups.rs ResolvedGroup::allows).
    for (const g of resolveGroups(eff, all)) if (groupAllows(g, x, y)) return 'group';
    return null;
  }
  const refOf = (all, r) => all.find((s) => s.id === r) || all.find((s) => String(s.name).toLowerCase() === String(r || '').toLowerCase()) || null;
  function resolveGroups(eff, all) {
    return (eff.groups || []).map((g) => {
      const members = []; const missing = [];
      for (const m of g.members || []) { const r = refOf(all, m); if (r) { if (!members.includes(r)) members.push(r); } else missing.push(m); }
      const inG = (r) => { const x = refOf(all, r); return x && members.includes(x) ? x.id : null; };
      return { g, members, missing, hub: g.hub ? inG(g.hub) : null, leads: (g.leads || []).map(inG).filter(Boolean), links: (g.links || []).map((l) => [inG(l.from), inG(l.to)]).filter(([a, b]) => a && b) };
    });
  }
  function groupAllows(r, x, y) {
    const i = r.members.indexOf(x), j = r.members.indexOf(y), n = r.members.length;
    if (i < 0 || j < 0 || i === j) return false;
    switch (r.g.topology) {
      case 'mesh': case 'swarm': return true;
      case 'ring': return j === (i + 1) % n;
      case 'chain': return Math.abs(i - j) === 1;
      case 'star': return !!r.hub && (r.hub === x.id || r.hub === y.id);
      case 'tree': return x.parentId === y.id || y.parentId === x.id;
      case 'hierarchical': return r.leads.includes(x.id) || r.leads.includes(y.id) || (x.parentId || '') === (y.parentId || '') || x.parentId === y.id || y.parentId === x.id;
      case 'custom': return r.links.some(([a, b]) => (a === x.id && b === y.id) || (a === y.id && b === x.id));
      default: return false;
    }
  }
  const groupsOut = (eff, all) => resolveGroups(eff, all).map((r) => ({ id: r.g.id, name: r.g.name, topology: r.g.topology, members: r.g.members, memberIds: r.members.map((m) => m.id), hubId: r.hub, leadIds: r.leads, links: r.links.map(([from, to]) => ({ from, to })), patterns: r.g.patterns || [], missing: r.missing }));
  function swarmState() {
    const eff = effective();
    const all = subs().filter((s) => !s.chatDeleted);
    const topologyEdges = [];
    if (all.length <= 60) for (const x of all) for (const y of all) if (x !== y) { const r = mayMessage(x, y, eff, all); if (r) topologyEdges.push({ from: x.id, to: y.id, kind: 'topology', rule: r }); }
    const board = Object.entries(S.board).map(([key, e]) => ({ key, value: e.value, version: e.version, authorId: e.authorId || null, authorName: e.authorName || nameOf(e.authorId), updatedAt: e.updatedAt, weight: Math.round(weight(e) * 1000) / 1000, writes: e.writes || 1, tags: e.tags || [] }));
    const topicsFolded = Object.values(S.topics).reduce((n, t) => n + t.digest.count, 0);
    return {
      topology: eff.topology, topologyEdges, groups: groupsOut(eff, all), topics: Object.entries(S.topics).map(([k, t]) => topicOut(k, t)), blackboard: board,
      auctions: S.auctions, votes: S.votes, debates: S.debates, elections: S.elections, rumors: S.rumors, handoffs: S.handoffs,
      coordinator: S.coordinator, coordinatorName: S.coordinatorName, term: S.term, activeAgent: S.activeAgent || null, messageCount: S.messageCount, paused: eff.paused,
      boardDigest: S.boardDigest, digests: S.digests,
      compaction: { policy: eff.compaction, runs: S.comp.runs, items: S.comp.items, lastAt: S.comp.lastAt, folded: { topics: topicsFolded, blackboard: S.boardDigest.count, swarm: Object.values(S.digests).reduce((n, d) => n + d.count, 0) } },
    };
  }
  const inner = a.subagents;
  a.subagents = async (req) => {
    const action = req && req.action;
    const k = chatKey(req);
    const swarmOn = ((window.__SA_CFG || {}).s1features || []).includes('subagentSwarm');
    const mine = ['commsConfig', 'setCommsConfig', 'commsPresets', 'saveCommsPreset', 'deleteCommsPreset', 'applyCommsPreset', 'swarmState', 'blackboardWrite', 'blackboardDelete', 'topicCreate', 'topicDelete', 'topicSubscribe', 'topicPublish', 'setCommsRole', 'commsStopAll'];
    if (!mine.includes(action)) {
      if (swarmOn && action === 'spawn') {
        if (req.topology && !TOPOLOGIES.includes(req.topology)) throw new Error(`\`topology\` must be one of ${TOPOLOGIES.join(', ')}.`);
        if (req.commsRole && !['member', 'lead', 'hub'].includes(req.commsRole)) throw new Error('`commsRole` must be member, lead or hub.');
      }
      if (swarmOn && action === 'spawnBatch') {
        if (req.topology && !TOPOLOGIES.includes(req.topology)) throw new Error(`\`topology\` must be one of ${TOPOLOGIES.join(', ')}.`);
      }
      const r = await inner(req);
      if (!swarmOn) return r;
      const out = JSON.parse(r.resultJson);
      if (action === 'spawn' && out.subagent) { const s = window.__sa.subs.get(out.subagent.id); if (req.topology) s.topology = req.topology; if (req.commsRole) s.commsRole = req.commsRole; Object.assign(out.subagent, { topology: s.topology, commsRole: s.commsRole }); }
      if (action === 'spawnBatch' && out.subagents) {
        out.subagents.forEach((m, i) => { const s = window.__sa.subs.get(m.id); if (req.topology) s.topology = req.topology; if (req.hub != null && Number(req.hub) === i) s.commsRole = ['star'].includes(req.topology) ? 'hub' : 'lead'; m.topology = s.topology; m.commsRole = s.commsRole; });
      }
      const aug = (m) => { const s = m && window.__sa.subs.get(m.id); if (s) { m.topology = s.topology || null; m.commsRole = s.commsRole || 'member'; } };
      if (Array.isArray(out.subagents) && action !== 'spawnBatch') out.subagents.forEach(aug);
      if (out.subagent && action !== 'spawn') aug(out.subagent);
      if (action === 'graph') {
        const st = swarmState();
        out.swarm = { topology: st.topology, topologyEdges: st.topologyEdges, groups: st.groups, topics: st.topics.map((t) => ({ name: t.name, subscribers: t.subscribers, total: t.total, lastAt: t.lastAt })), coordinator: st.coordinator, coordinatorName: st.coordinatorName, term: st.term, activeAgent: st.activeAgent, paused: st.paused, rules: (effective().edges || []).map((e) => ({ from: e.from, to: e.to, allow: !!e.allow, both: !!e.both })), handoffs: S.handoffs.map((x) => ({ fromId: x.fromId, fromName: x.fromName, toId: x.toId, toName: x.toName, note: x.note, at: x.at })) };
        out.handoffEdges = S.handoffs.map((x) => ({ from: x.fromId, to: x.toId, kind: 'handoff', note: x.note, at: x.at }));
        if (out.nodes) out.nodes.forEach((n) => { const s = window.__sa.subs.get(n.id); if (s) { n.topology = s.topology || null; n.commsRole = s.commsRole || 'member'; } });
      }
      return { resultJson: JSON.stringify(out) };
    }
    rec('agent.subagents', req);
    if (!swarmOn) throw new Error(`unknown action '${action}'`);
    if (S.failNext.has(action)) { const m = S.failNext.get(action); S.failNext.delete(action); throw new Error(m); }
    let out;
    switch (action) {
      case 'commsConfig': out = payload(k); break;
      case 'setCommsConfig': {
        if (!req.patch || typeof req.patch !== 'object') throw new Error('`patch` must be an object.');
        const rejected = setConfig(k, req.patch);
        if (rejected.length && rejected.length === Object.keys(req.patch).length) throw new Error(`Invalid value for ${rejected.join(', ')}.`);
        out = { ...payload(k), rejected }; break;
      }
      case 'commsPresets': out = { presets: [...BUILTIN, ...S.presets] }; break;
      case 'saveCommsPreset': {
        const name = String(req.name || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new Error('A preset name is 1\u201340 letters, digits or dashes.');
        if (BUILTIN.some((p) => p.name === name)) throw new Error(`"${name}" is a built-in preset.`);
        const p = { name, title: req.title || name, description: req.description || '', config: req.config || {} };
        S.presets = S.presets.filter((x) => x.name !== name).concat(p);
        out = { preset: p, presets: [...BUILTIN, ...S.presets] }; break;
      }
      case 'deleteCommsPreset': {
        const n = S.presets.length; S.presets = S.presets.filter((x) => x.name !== req.name);
        if (n === S.presets.length) throw new Error(`No saved preset named ${req.name}.`);
        out = { presets: [...BUILTIN, ...S.presets] }; break;
      }
      case 'applyCommsPreset': {
        const p = [...BUILTIN, ...S.presets].find((x) => x.name === req.name);
        if (!p) throw new Error(`No preset named "${req.name}".`);
        const keepEdges = cfgOf(k).edges;
        S.configs[k] = {}; setConfig(k, p.config); if (keepEdges && !p.config.edges) S.configs[k].edges = keepEdges;
        out = payload(k); break;
      }
      case 'swarmState': out = swarmState(); break;
      case 'blackboardWrite': case 'blackboardDelete': {
        // Same rules and answers as the engine's board_write.
        const key = String(req.key || '').trim().slice(0, 120);
        if (!key) throw new Error('`key` is empty.');
        const del = action === 'blackboardDelete';
        if (!del && typeof req.value !== 'string') throw new Error('`value` is required.');
        const cur = S.board[key]; const exp = req.expectedVersion;
        if (exp != null && cur && cur.version !== Number(exp)) throw new Error(`Conflict: ${key} is at version ${cur.version} (by ${cur.authorName}), not ${exp}. Read it again, merge, and write with expected_version=${cur.version}. Current value:\n${cur.value}`);
        if (exp != null && Number(exp) > 0 && !cur) throw new Error(`Conflict: ${key} no longer exists.`);
        if (del) { if (!cur) throw new Error(`No blackboard key ${key}.`); delete S.board[key]; out = { op: 'deleted', version: cur.version, key }; break; }
        S.agentWrite(key, null, req.value, { tags: Array.isArray(req.tags) ? req.tags : undefined });
        out = { op: 'written', version: S.board[key].version, key }; break;
      }
      case 'topicCreate': {
        const name = normTopic(req.topic);
        if (!name) throw new Error('`topic` is empty.');
        const created = !S.topics[name]; ensureTopic(name, null); out = { topic: name, created }; break;
      }
      case 'topicDelete': { const name = normTopic(req.topic); if (!S.topics[name]) throw new Error(`No topic #${name}.`); delete S.topics[name]; out = { topic: name }; break; }
      case 'topicSubscribe': {
        const name = normTopic(req.topic);
        if (!name || !window.__sa.subs.get(req.id)) throw new Error('Need a `topic` and an agent `id`.');
        const t = ensureTopic(name, null); t.subscribers = t.subscribers.filter((x) => x !== req.id); if (req.subscribed !== false) t.subscribers.push(req.id);
        out = { topic: name, subscribers: t.subscribers }; break;
      }
      case 'topicPublish': {
        const name = normTopic(req.topic); const text = String(req.message || '').trim();
        if (!name || !text) throw new Error('`topic` and `message` are required.');
        S.agentPost(name, null, text);
        out = { topic: name, delivered: S.topics[name].subscribers.filter((id) => window.__sa.subs.get(id)).length }; break;
      }
      case 'setCommsRole': {
        const s = window.__sa.subs.get(req.id); if (!s) throw new Error(`no sub-agent with id '${req.id}'`);
        if (req.role != null && req.role !== '') { if (!['member', 'lead', 'hub'].includes(req.role)) throw new Error('`role` must be one of member, lead, hub.'); s.commsRole = req.role === 'member' ? undefined : req.role; } else if ('role' in req) s.commsRole = undefined;
        if ('topology' in req) { if (req.topology && !TOPOLOGIES.includes(req.topology)) throw new Error(`\`topology\` must be one of ${TOPOLOGIES.join(', ')}.`); s.topology = req.topology || undefined; }
        if ('canBroadcast' in req) s.canBroadcast = req.canBroadcast == null ? undefined : !!req.canBroadcast;
        out = { subagent: { ...s } }; break;
      }
      case 'commsStopAll': {
        const stopped = subs().filter((s) => ['running', 'queued', 'waiting_approval', 'paused'].includes(s.status)).map((s) => { s.status = 'cancelled'; s.stopReason = 'cancelled'; window.__sa.emit('subagent.cancelled', { ...s }); return s.id; });
        cfgOf(k === '*' ? 'chat' : k).paused = true;
        // Like the engine: nobody is left to bid, vote or award, so open ones close.
        for (const x of [...S.auctions, ...S.votes]) if (x.status === 'open') { x.status = 'cancelled'; x.waiting = false; x.closedAt = Date.now(); }
        out = { stopped }; break;
      }
      default: throw new Error(`unknown action '${action}'`);
    }
    return { resultJson: JSON.stringify(out) };
  };
  /** Test helpers: agent-side activity, as the engine would record it. */
  S.agentPost = (topic, fromId, text, at) => { const t = ensureTopic(topic, fromId); if (fromId && !t.subscribers.includes(fromId)) t.subscribers.push(fromId); t.total += 1; t.posts.push({ seq: t.total, fromId: fromId || null, fromName: fromId ? nameOf(fromId) : 'You', text, at: at || Date.now() }); S.messageCount += 1; compactTopic(t); };
  S.agentWrite = (key, fromId, value, opts = {}) => { const cur = S.board[key]; const at = opts.at || Date.now(); S.board[key] = { value, version: (cur ? cur.version : 0) + 1, authorId: fromId || null, authorName: fromId ? nameOf(fromId) : 'You', updatedAt: at, reinforcedAt: at, weight: (cur ? weight(cur, at) : 0) + 1, writes: (cur ? cur.writes : 0) + 1, tags: opts.tags || (cur ? cur.tags : []) }; };
  S.handoff = (fromId, toId, note, at) => { S.handoffs.push({ fromId, fromName: nameOf(fromId), toId, toName: nameOf(toId), note, at: at || Date.now() }); S.activeAgent = toId; };
  S.fold = () => { const c = effective().compaction; for (const kind of ['auctions', 'votes', 'debates']) fold(S[kind], S.digests[kind] = S.digests[kind] || { count: 0, by: {}, gist: [] }, c.keep, c.at, (x) => !['open', 'running'].includes(x.status), (x) => [x.announcerName || x.callerName || x.moderatorName || 'agent', x.task || x.question || x.topic]); };
})();
