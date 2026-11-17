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
  const DEFAULT_PATTERNS = {
    tree: ['direct', 'request'], star: ['direct', 'broadcast', 'request'], mesh: ['direct', 'broadcast', 'request', 'topics', 'blackboard'],
    ring: ['direct', 'request'], chain: ['direct', 'request', 'handoff'], bus: ['topics', 'blackboard', 'broadcast'],
    hierarchical: ['direct', 'broadcast', 'topics', 'blackboard', 'request', 'vote'], swarm: PATTERNS.slice(), custom: ['direct', 'request'],
  };
  const RANGES = { maxHops: [1, 50], maxPairMessages: [0, 1000], maxMessages: [0, 100000], maxRounds: [1, 10], maxHandoffs: [0, 20], gossipFanout: [1, 10], quorumPercent: [0, 100], requestTimeoutS: [5, 1800], pheromoneHalfLifeMin: [1, 10080], compactKeep: [2, 45], compactAt: [4, 50], compactContextChars: [2000, 200000] };
  const ENUMS = { topology: TOPOLOGIES, consensusRule: ['majority', 'plurality', 'unanimous', 'supermajority'], auctionPolicy: ['best', 'cheapest', 'confident', 'first', 'manager'], whoCanBroadcast: ['all', 'leads', 'none'], whoCanSpawn: ['all', 'leads', 'none'], blackboardWriters: ['all', 'leads', 'none'], electionMethod: ['rank', 'vote'] };
  const BOOLS = ['wakeIdle', 'paused', 'compact'];
  const BUILTIN = [
    ['solo', 'Solo agents', 'Tree: agents report to whoever started them; no peer talk.', { topology: 'tree' }],
    ['hub', 'Hub and spokes', 'Star: everything goes through one hub.', { topology: 'star' }],
    ['open-team', 'Open team', 'Mesh with topics and a shared blackboard.', { topology: 'mesh' }],
    ['swarm', 'Swarm', 'Every pattern on, peers hand off freely.', { topology: 'swarm', patterns: PATTERNS, maxHops: 10, maxHandoffs: 5 }],
    ['pipeline', 'Pipeline', 'Chain: each agent hands its work to the next.', { topology: 'chain', patterns: ['direct', 'request', 'handoff'] }],
    ['org-chart', 'Org chart', 'Hierarchical: leads coordinate, members report to their lead.', { topology: 'hierarchical', patterns: ['direct', 'topics', 'blackboard', 'request', 'vote'], whoCanBroadcast: 'leads', whoCanSpawn: 'leads' }],
    ['blackboard', 'Blackboard', 'Bus: agents only share through topics and the blackboard.', { topology: 'bus', patterns: ['topics', 'blackboard'] }],
    ['council', 'Council', 'Mesh that debates and votes; unanimous decisions.', { topology: 'mesh', patterns: ['direct', 'request', 'debate', 'vote'], consensusRule: 'unanimous', maxRounds: 3 }],
    ['market', 'Market', 'Contract net: tasks are announced, agents bid, the cheapest bid wins.', { topology: 'mesh', patterns: ['direct', 'request', 'auction'], auctionPolicy: 'cheapest' }],
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
      topology: o.topology || 'tree', patterns: o.patterns || null, edges: o.edges || [],
      maxHops: o.maxHops ?? 4, maxPairMessages: o.maxPairMessages ?? 30, maxMessages: o.maxMessages ?? 500, maxRounds: o.maxRounds ?? 3, maxHandoffs: o.maxHandoffs ?? 3, gossipFanout: o.gossipFanout ?? 3,
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
  const ensureTopic = (name, by) => (S.topics[name] = S.topics[name] || { subscribers: [], total: 0, createdBy: by || null, posts: [], digest: { count: 0, by: {}, gist: [] } });
  function weight(e) { const hl = effective().pheromoneHalfLifeMin * 60000; return Math.min(1, Math.pow(0.5, Math.max(0, Date.now() - e.updatedAt) / hl) * Math.min(1, 0.5 + 0.25 * (e.writes || 1))); }
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
    return ok && ok() ? 'topology' : null;
  }
  function swarmState() {
    const eff = effective();
    const all = subs().filter((s) => !s.chatDeleted);
    const topologyEdges = [];
    if (all.length <= 60) for (const x of all) for (const y of all) if (x !== y) { const r = mayMessage(x, y, eff, all); if (r) topologyEdges.push({ from: x.id, to: y.id, kind: 'topology', rule: r }); }
    const board = Object.entries(S.board).map(([key, e]) => ({ key, value: e.value, version: e.version, authorId: e.authorId || null, authorName: e.authorName || nameOf(e.authorId), updatedAt: e.updatedAt, weight: Math.round(weight(e) * 1000) / 1000, writes: e.writes || 1, tags: e.tags || [] }));
    const topicsFolded = Object.values(S.topics).reduce((n, t) => n + t.digest.count, 0);
    return {
      topology: eff.topology, topologyEdges, topics: Object.entries(S.topics).map(([k, t]) => topicOut(k, t)), blackboard: board,
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
    const mine = ['commsConfig', 'setCommsConfig', 'commsPresets', 'saveCommsPreset', 'deleteCommsPreset', 'applyCommsPreset', 'swarmState', 'blackboard', 'blackboardWrite', 'blackboardDelete', 'topics', 'topicCreate', 'topicDelete', 'topicSubscribe', 'topicPublish', 'setCommsRole', 'commsStopAll', 'swarmGraph'];
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
        out.swarm = { topology: st.topology, topologyEdges: st.topologyEdges, topics: st.topics.map((t) => ({ name: t.name, subscribers: t.subscribers, total: t.total, lastAt: t.lastAt })), coordinator: st.coordinator, coordinatorName: st.coordinatorName, term: st.term, activeAgent: st.activeAgent, paused: st.paused };
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
        if (BUILTIN.some((p) => p.name === req.name)) throw new Error('Built-in presets cannot be deleted.');
        const n = S.presets.length; S.presets = S.presets.filter((x) => x.name !== req.name);
        if (n === S.presets.length) throw new Error(`No preset named "${req.name}".`);
        out = { deleted: true, presets: [...BUILTIN, ...S.presets] }; break;
      }
      case 'applyCommsPreset': {
        const p = [...BUILTIN, ...S.presets].find((x) => x.name === req.name);
        if (!p) throw new Error(`No preset named "${req.name}".`);
        const keepEdges = cfgOf(k).edges;
        S.configs[k] = {}; setConfig(k, p.config); if (keepEdges && !p.config.edges) S.configs[k].edges = keepEdges;
        out = payload(k); break;
      }
      case 'swarmState': case 'swarmGraph': out = swarmState(); break;
      case 'blackboard': out = { entries: swarmState().blackboard, digest: S.boardDigest }; break;
      case 'blackboardWrite': {
        const key = String(req.key || '').trim();
        if (!key) throw new Error('`key` is required.');
        const cur = S.board[key];
        const have = cur ? cur.version : 0;
        if (req.expectedVersion != null && Number(req.expectedVersion) !== have) throw new Error(`Version conflict on "${key}": you read v${req.expectedVersion}, it is now v${have}. Read it again and merge.`);
        S.board[key] = { value: String(req.value ?? ''), version: have + 1, authorId: null, authorName: 'You', updatedAt: Date.now(), writes: (cur ? cur.writes || 1 : 0) + 1, tags: req.tags || (cur ? cur.tags : []) };
        out = { key, version: have + 1 }; break;
      }
      case 'blackboardDelete': {
        const cur = S.board[req.key];
        if (!cur) throw new Error(`No blackboard key "${req.key}".`);
        if (req.expectedVersion != null && Number(req.expectedVersion) !== cur.version) throw new Error(`Version conflict on "${req.key}".`);
        delete S.board[req.key]; out = { deleted: true }; break;
      }
      case 'topics': out = { topics: swarmState().topics }; break;
      case 'topicCreate': {
        const name = String(req.topic || '').trim().toLowerCase().replace(/\s+/g, '-');
        if (!/^[a-z0-9][a-z0-9._/-]{0,59}$/.test(name)) throw new Error('A topic name is 1\u201360 letters, digits, dots, dashes or slashes.');
        if (S.topics[name]) throw new Error(`#${name} already exists.`);
        ensureTopic(name, null); out = { topic: name }; break;
      }
      case 'topicDelete': { if (!S.topics[req.topic]) throw new Error(`No topic #${req.topic}.`); delete S.topics[req.topic]; out = { deleted: true }; break; }
      case 'topicSubscribe': { const t = S.topics[req.topic]; if (!t) throw new Error(`No topic #${req.topic}.`); if (req.id && !t.subscribers.includes(req.id)) t.subscribers.push(req.id); out = { topic: req.topic, subscribers: t.subscribers }; break; }
      case 'topicPublish': {
        const t = S.topics[req.topic]; if (!t) throw new Error(`No topic #${req.topic}.`);
        if (!String(req.message || '').trim()) throw new Error('`message` is required.');
        t.posts.push({ from: null, fromName: 'You', text: String(req.message), at: Date.now(), tags: req.tags || [] }); t.total += 1; S.messageCount += 1;
        compactTopic(t); out = { topic: req.topic, total: t.total, delivered: t.subscribers.length }; break;
      }
      case 'setCommsRole': {
        const s = window.__sa.subs.get(req.id); if (!s) throw new Error(`no sub-agent with id '${req.id}'`);
        if (req.role != null) { if (!['member', 'lead', 'hub'].includes(req.role)) throw new Error('`role` must be member, lead or hub.'); s.commsRole = req.role; }
        if ('topology' in req) { if (req.topology && !TOPOLOGIES.includes(req.topology)) throw new Error(`\`topology\` must be one of ${TOPOLOGIES.join(', ')}.`); s.topology = req.topology || undefined; }
        out = { id: s.id, role: s.commsRole || 'member', topology: s.topology || null }; break;
      }
      case 'commsStopAll': {
        const stopped = subs().filter((s) => ['running', 'queued', 'waiting_approval', 'paused'].includes(s.status)).map((s) => { s.status = 'cancelled'; s.stopReason = 'cancelled'; window.__sa.emit('subagent.cancelled', { ...s }); return s.id; });
        cfgOf(k === '*' ? 'chat' : k).paused = true; out = { stopped, paused: true }; break;
      }
      default: throw new Error(`unknown action '${action}'`);
    }
    return { resultJson: JSON.stringify(out) };
  };
  /** Test helpers: agent-side activity, as the engine would record it. */
  S.agentPost = (topic, fromId, text, at) => { const t = ensureTopic(topic, fromId); if (fromId && !t.subscribers.includes(fromId)) t.subscribers.push(fromId); t.posts.push({ from: fromId, fromName: nameOf(fromId), text, at: at || Date.now(), tags: [] }); t.total += 1; S.messageCount += 1; compactTopic(t); };
  S.agentWrite = (key, fromId, value, opts = {}) => { const cur = S.board[key]; S.board[key] = { value, version: (cur ? cur.version : 0) + 1, authorId: fromId, authorName: nameOf(fromId), updatedAt: opts.at || Date.now(), writes: (cur ? cur.writes : 0) + 1, tags: opts.tags || [] }; };
  S.handoff = (fromId, toId, note, at) => { S.handoffs.push({ id: `ho_${S.handoffs.length + 1}`, fromId, fromName: nameOf(fromId), toId, toName: nameOf(toId), note, at: at || Date.now(), chain: [fromId, toId] }); S.activeAgent = toId; };
  S.fold = () => { const c = effective().compaction; for (const kind of ['auctions', 'votes', 'debates']) fold(S[kind], S.digests[kind] = S.digests[kind] || { count: 0, by: {}, gist: [] }, c.keep, c.at, (x) => !['open', 'running'].includes(x.status), (x) => [x.announcerName || x.callerName || x.moderatorName || 'agent', x.task || x.question || x.topic]); };
})();
