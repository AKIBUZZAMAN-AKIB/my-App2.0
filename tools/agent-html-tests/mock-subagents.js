// A stateful fake of the engine's sub-agent manager behind NativeKit.agent.subagents(),
// matching subagents.rs: list/get/spawn/stop/message/retry/delete/memory/settings and
// subagent.* events. window.__sa controls it from tests (fail next call, emit events).
(() => {
  const a = window.NativeKit.agent;
  const rec = (name, args) => window.__mock.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
  const cfg = window.__SA_CFG || {};
  if (cfg.feature !== false) {
    const gf = a.getEngineFeatures;
    a.getEngineFeatures = async () => { const r = await gf(); return { ...r, features: [...r.features, 'subagents', ...(cfg.s1 === false ? [] : (cfg.s1features || ['subagentQueue', 'subagentData', 'subagentReuse', 'crossSession'])), ...(cfg.tokens === false ? [] : ['tokenBudget', 'countTokens']), ...(cfg.toolRules === false ? [] : ['toolRules'])] }; };
  }
  if (cfg.method === false) return;
  if (typeof a.countTokens !== 'function') {
    a.countTokens = async (provider, model, input, opts) => { rec('agent.countTokens', [provider, model, input, opts]); if (window.__countFail) throw new Error('count failed'); const t = typeof input === 'string' ? input : ''; return { tokens: Math.ceil(t.length / 3), texts: [Math.ceil(t.length / 3)], system: 0, messages: 0, tools: 0, method: 'exact', tokenizer: { encoding: 'o200k_base', exact: true, factor: 1, calibrated: false, method: 'exact' } }; };
  }
  {
    const g = a.getRuntimeConfig;
    a.getRuntimeConfig = async () => ({ ...(await g()), contextTokenBudget: window.__tokenBudget || 0 });
  }
  if (typeof a.listToolRules !== 'function') {
    window.__rules = window.__rules || {};
    a.listToolRules = async () => { rec('agent.listToolRules', null); if (window.__rulesFail) throw new Error('rules unavailable'); return { rules: JSON.parse(JSON.stringify(window.__rules)), subjects: { ask_session: 'session_key', execute_command: 'command', read_file: 'path', write_file: 'path', web_fetch: 'url' } }; };
    a.setToolRules = async (toolName, rule) => { rec('agent.setToolRules', [toolName, rule]); if (typeof toolName !== 'string') throw new Error('toolName must be a string'); window.__rules[toolName] = { allow: rule?.allow || [], deny: rule?.deny || [] }; return { rules: window.__rules }; };
  }
  const now = Date.now();
  const settings = { enabled: true, maxDepth: 1, maxParallel: 3, defaultTokenBudget: 200000, defaultMaxSteps: 25, timeoutSeconds: 600, defaultMemory: 'private', maxKept: 50 };
  const subs = new Map();
  const memory = new Map(); // name -> [{key,text,updatedAt}]
  const transcripts = new Map();
  const branches = new Map();
  let seq = 0;
  const failNext = new Map(); // action -> error message
  const emit = (type, payload) => window.__mock.emit(type, payload);
  const recFor = (s) => ({ ...s });
  function make(spec) {
    seq += 1;
    const id = spec.id || `sa_${String(seq).padStart(4, '0')}`;
    const s = {
      id, name: spec.name || `agent-${seq}`, role: spec.role || null, task: spec.task || '', status: spec.status || 'running',
      sessionKey: `sub:${id}`, parentSessionKey: spec.parentSessionKey ?? (window.__sa.mainKey || ''), depth: spec.depth || 1,
      model: spec.model || null, provider: null, tools: spec.tools || [], memoryMode: spec.memory || 'private',
      tokenBudget: spec.tokenBudget || settings.defaultTokenBudget, maxSteps: spec.maxSteps || settings.defaultMaxSteps, timeoutSeconds: 600,
      steps: spec.steps || 0, toolCalls: spec.toolCalls || 0, inputTokens: spec.inputTokens || 0, outputTokens: spec.outputTokens || 0,
      result: spec.result || null, queuePosition: spec.queuePosition || null, priority: spec.priority || 0, files: spec.files || [], error: spec.error || null, stopReason: null, createdAt: spec.createdAt || now + seq, startedAt: now, finishedAt: null, runs: 1,
    };
    for (const k of ['title', 'description', 'parentId', 'groupId', 'groupMode', 'groupIndex', 'groupWinner', 'dependsOn', 'contextMode', 'contextSource', 'handoff', 'shareable', 'paused', 'totalTokens', 'finishedAt', 'rootSessionKey']) if (spec[k] !== undefined) s[k] = spec[k];
    subs.set(id, s);
    transcripts.set(id, [{ role: 'user', content: s.task }, ...(s.result ? [{ role: 'assistant', content: s.result }] : [])]);
    return s;
  }
  a.subagents = async (req) => {
    rec('agent.subagents', req);
    const delay = window.__sa.delay || 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const action = req?.action;
    if (failNext.has(action)) { const m = failNext.get(action); failNext.delete(action); throw new Error(m); }
    const get = () => { const s = subs.get(req.id); if (!s) throw new Error(`no sub-agent with id '${req.id}'`); return s; };
    let out;
    switch (action) {
      case 'list': out = { subagents: [...subs.values()].map(recFor), settings }; break;
      case 'get': { const s = get(); out = { subagent: recFor(s), transcript: transcripts.get(s.id) || [], memory: memory.get(s.name) || [] }; break; }
      case 'spawn': {
        if (!req.task || !String(req.task).trim()) throw new Error('spawn needs a task');
        const running = [...subs.values()].filter((x) => x.status === 'running').length;
        if (running >= settings.maxParallel) throw new Error(`at most ${settings.maxParallel} sub-agents can run at once`);
        const s = make({ ...req, tokenBudget: req.tokenBudget, maxSteps: req.maxSteps });
        emit('subagent.started', { ...recFor(s), task: s.task });
        out = { subagent: recFor(s) }; break;
      }
      case 'stop': {
        if (req.all) { let n = 0; for (const s of subs.values()) if (s.status === 'running') { s.status = 'cancelled'; n++; emit('subagent.cancelled', recFor(s)); } out = { stopped: n }; break; }
        const s = get(); if (s.status === 'running' || s.status === 'queued') { s.status = 'cancelled'; s.queuePosition = null; emit('subagent.cancelled', recFor(s)); } out = { stopped: 1 }; break;
      }
      case 'message': {
        const s = get();
        // Like the engine: text, images (attachmentsJson), or both.
        const imgs = req.attachmentsJson ? JSON.parse(req.attachmentsJson) : [];
        if (!req.message && !imgs.length) throw new Error('message needs text');
        transcripts.get(s.id).push(imgs.length ? { role: 'user', content: [...(req.message ? [{ type: 'text', text: req.message }] : []), ...imgs.map((i) => ({ type: 'image', source: { media_type: i.mediaType, data: i.data } }))] } : { role: 'user', content: req.message });
        out = { queued: s.status === 'running' };
        break;
      }
      // Kept versions of its chat (engine: subagents/branches.rs), oldest first.
      case 'branches': { const s = get(); out = { id: s.id, branches: branches.get(s.id) || [] }; break; }
      case 'restoreBranch': {
        const s = get();
        if (['running', 'queued', 'waiting'].includes(s.status)) throw new Error('It is still running. Stop it first.');
        const list = branches.get(s.id) || [];
        const i = list.findIndex((b) => b.id === req.branchId);
        if (i < 0) throw new Error(`There is no kept version ${req.branchId}.`);
        const [chosen] = list.splice(i, 1);
        list.push({ id: `v${Date.now()}-r`, turn: chosen.turn, reason: 'restore', createdAt: Date.now(), messages: transcripts.get(s.id).slice() });
        transcripts.set(s.id, chosen.messages.slice());
        out = { subagent: { ...s } };
        break;
      }
      case 'retry': { const s = get(); if (s.status === 'running') throw new Error('it is still running'); s.status = 'running'; s.runs += 1; s.steps = 0; emit('subagent.started', recFor(s)); out = { subagent: recFor(s) }; break; }
      case 'delete': { const s = get(); if (s.status === 'running') throw new Error('stop it first'); subs.delete(s.id); out = { deleted: true }; break; }
      // S0/S1 actions (features subagentQueue, subagentData, subagentReuse, crossSession)
      case 'priority': { const s = get(); s.priority = Math.max(-10, Math.min(10, Number(req.priority) || 0)); out = { subagent: recFor(s) }; break; }
      case 'regenerate': { const s = get(); if (s.status === 'running') throw new Error('it is still running'); const t = transcripts.get(s.id); while (t.length && t[t.length - 1].role === 'assistant') t.pop(); t.push({ role: 'assistant', content: [{ type: 'text', text: 'Regenerated answer.' }] }); out = { subagent: recFor(s), resumed: true }; break; }
      case 'edit': { const s = get(); if (!req.message) throw new Error('edit needs text'); const t = transcripts.get(s.id); let n = -1, at = -1; t.forEach((m, i) => { if (m.role === 'user' && typeof m.content === 'string') { n++; if (n === Number(req.turn)) at = i; } }); if (at < 0) throw new Error('No user message ' + req.turn); t.splice(at); t.push({ role: 'user', content: req.message }, { role: 'assistant', content: [{ type: 'text', text: 'Edited answer.' }] }); out = { subagent: recFor(s), resumed: true }; break; }
      case 'fork': { const s0 = get(); const s = make({ name: s0.name + '-copy', task: req.task || s0.task, tools: s0.tools }); emit('subagent.started', { ...recFor(s), task: s.task }); out = { subagent: recFor(s) }; break; }
      case 'find': { const k = String(req.key || req.name || ''); out = { subagent: recFor(subs.get(k) || [...subs.values()].reverse().find((x) => x.name === k)) || null }; break; }
      case 'log': { const s = get(); const seeded = (window.__sa.logs || {})[s.id]; out = { id: s.id, log: seeded ? seeded.slice(-(req.limit || 200)) : [{ at: Date.now(), event: 'subagent.finished', status: s.status }] }; break; }
      // Per-agent view (PARITY_PLAN phase 2): tool allows and per-agent configure.
      case 'chatAllows': {
        const A = window.__sa.allows || (window.__sa.allows = { chat: [], agent: {} });
        const own = A.agent[req.sessionKey] || [];
        const r0 = [...subs.values()].find((x) => x.sessionKey === req.sessionKey);
        const inherited = [];
        for (let cur = r0; cur; cur = [...subs.values()].find((x) => x.sessionKey === cur.parentSessionKey)) for (const t of A.agent[cur.parentSessionKey] || []) inherited.push({ tool: t, from: cur.parentSessionKey });
        out = { sessionKey: window.__sa.mainKey || 'main', tools: A.chat, agentTools: own, inherited }; break;
      }
      case 'allowTool': case 'revokeTool': {
        if (!req.sessionKey || (action === 'allowTool' && !req.toolName)) throw new Error('allowTool needs sessionKey and toolName.');
        const A = window.__sa.allows || (window.__sa.allows = { chat: [], agent: {} });
        const key = req.scope === 'agent' ? req.sessionKey : 'chat';
        const list = key === 'chat' ? A.chat : (A.agent[key] || (A.agent[key] = []));
        const next = action === 'allowTool' ? [...new Set([...list, req.toolName])] : list.filter((t) => req.toolName && t !== req.toolName);
        if (key === 'chat') A.chat = next; else A.agent[key] = next;
        out = { sessionKey: key, scope: req.scope || 'chat', tools: next }; break;
      }
      case 'configure': {
        const s = get();
        for (const k of ['model', 'provider', 'tools', 'hidden', 'hiddenFrom', 'canMessage', 'temperature', 'systemPrompt', 'maxChildDepth', 'compaction', 'memoryMode', 'timeoutSeconds', 'tokenBudget', 'maxSteps', 'peerRateLimit', 'autoCompaction', 'compactionThreshold', 'title', 'description', 'shareable']) if (k in req) s[k] = req[k];
        if (Array.isArray(req.tools) && !req.tools.length && 'tools' in req) s.tools = [];
        out = { subagent: recFor(s) }; break;
      }
      case 'deleteData': {
        window.__mockDeleteCalls = (window.__mockDeleteCalls || 0) + (req.dryRun ? 0 : 1);
        const parts0 = [].concat(req.parts || []); if (!parts0.length) throw new Error('Choose what to delete');
        const everything = parts0.includes('all'); const parts = everything ? ['chat', 'memory', 'files', 'logs'] : parts0;
        let ids = [].concat(req.id ? [req.id] : [], req.ids || []);
        if (req.scope === 'finished') ids = ids.concat([...subs.values()].filter((x) => !['running', 'queued'].includes(x.status)).map((x) => x.id));
        if (req.scope === 'all') ids = ids.concat([...subs.keys()]);
        ids = [...new Set(ids)]; if (!ids.length) throw new Error('Nothing selected to delete.');
        for (const id of ids) if (!subs.has(id)) throw new Error('No sub-agent with id ' + id);
        const plan = ids.map((id) => { const x = subs.get(id); return { id, name: x.name, status: x.status, items: parts.map((p) => ({ part: p, label: p === 'files' ? 'Files it created: 1' : p[0].toUpperCase() + p.slice(1) + ': ' + (p === 'chat' ? (transcripts.get(id) || []).length + ' messages' : '1 entry'), ...(p === 'files' ? { files: ['notes/<b>x</b>.md'] } : {}) })).concat(everything ? [{ part: 'record', label: 'The sub-agent itself' }] : []), warnings: x.status === 'running' ? ['It is running: it will be stopped first, then its data is deleted.'] : [] }; });
        if (req.dryRun) { out = { dryRun: true, parts, everything, plan }; break; }
        if (window.__mockDeleteFail) throw new Error('disk full: token=sk-ABCDEFGHIJKLMNOPQRSTUVWX');
        const deleted = [], stopping = [];
        for (const id of ids) { const x = subs.get(id); if (x.status === 'running') { x.status = 'cancelled'; stopping.push(id); emit('subagent.cancelled', recFor(x)); setTimeout(() => { subs.delete(id); emit('subagent.deleted', { id }); }, 50); continue; }
          if (parts.includes('chat')) { transcripts.set(id, []); x.chatDeleted = true; x.result = ''; }
          if (parts.includes('memory')) memory.set(x.name, []);
          if (everything) subs.delete(id);
          deleted.push({ id, name: x.name, ...(everything ? { record: true } : {}) }); }
        out = { deleted, stopping, parts, everything, plan }; break;
      }
      case 'chats': out = { chats: [{ sessionKey: 'chat-other', title: 'Physics notes' }, { sessionKey: 'chat-main', title: 'Main' }] }; break;
      case 'ask': { if (!req.message) throw new Error('message needed'); if (window.__mockAskFail) throw new Error('The other chat is busy.'); await new Promise((r) => setTimeout(r, 30)); out = { reply: '**Answer** from ' + req.targetSessionKey + ': 42', sessionKey: req.targetSessionKey }; break; }
      case 'cancelAsk': out = { cancelled: true }; break;
      case 'memory': {
        // Like the engine: the store is named after the agent; `id` resolves to its name.
        if (!req.name && req.id && subs.get(req.id)) req.name = subs.get(req.id).name;
        const list = memory.get(req.name) || [];
        if (req.op === 'list') out = { entries: list };
        else if (req.op === 'delete') { memory.set(req.name, list.filter((e) => e.key !== req.key)); out = { name: req.name, deleted: 1 }; }
        else if (req.op === 'clear') { memory.set(req.name, []); out = { cleared: list.length }; }
        else if (req.op === 'promote') { out = { promoted: req.key ? 1 : list.length }; }
        else throw new Error(`unknown memory op '${req.op}'`);
        break;
      }
      case 'settings': {
        if (req.settings) {
          const n = req.settings;
          if (n.maxParallel < 1 || n.maxParallel > 8) throw new Error('maxParallel must be 1-8');
          Object.assign(settings, n);
        }
        out = { settings }; break;
      }
      // Phase 4 team actions (feature subagentTeam), shaped like the engine's comms.rs.
      case 'comms': {
        const st = window.__sa.comms;
        const all = [...subs.values()];
        const topo = settings.topology || 'tree';
        const parentOfS = (x) => x.parentId || null;
        const why = (f, t) => {
          if (settings.commsPaused) return 'Agent-to-agent messages are paused.';
          if (t.hidden) return `${t.name} is hidden from other agents.`;
          if ((t.hiddenFrom || []).includes(f.name) || (t.hiddenFrom || []).includes(f.id)) return `${t.name} is hidden from ${f.name}.`;
          if (Array.isArray(f.canMessage)) return f.canMessage.includes(t.name) || f.canMessage.includes(t.id) ? '' : `${f.name} may message only: ${f.canMessage.join(', ') || 'nobody'}.`;
          if (topo === 'mesh') return '';
          if (topo === 'tree' && (parentOfS(t) === f.id || parentOfS(f) === t.id)) return '';
          return `The ${topo} topology does not allow ${f.name} to message ${t.name}.`;
        };
        out = { sessionKey: req.sessionKey || '', topology: topo, commsPaused: !!settings.commsPaused, peerRateLimitPerMin: settings.peerRateLimitPerMin ?? 20,
          messages: st.messages.slice(-(req.limit || 200)),
          matrix: all.map((f) => ({ id: f.id, name: f.name, title: f.title || '', cells: all.filter((t) => t.id !== f.id).map((t) => { const r = why(f, t); return r ? { to: t.id, allowed: false, reason: r } : { to: t.id, allowed: true }; }), teamTools: [] })) };
        break;
      }
      case 'pause': { const s = get(); if (!['running', 'queued', 'waiting_approval'].includes(s.status)) throw new Error(`${s.name} is not running.`); s.status = 'paused'; s.paused = true; emit('subagent.paused', recFor(s)); out = { subagent: recFor(s) }; break; }
      case 'resume': { const s = get(); if (!s.paused) throw new Error(`${s.name} is not paused.`); s.status = 'running'; s.paused = false; emit('subagent.resumed', recFor(s)); out = { subagent: recFor(s) }; break; }
      case 'stopTree': {
        const root = get(); const ids = [root.id];
        for (let i = 0; i < ids.length; i += 1) for (const x of subs.values()) if (x.parentId === ids[i] && !ids.includes(x.id)) ids.push(x.id);
        const stopped = [];
        for (const id of ids) { const x = subs.get(id); if (['running', 'queued', 'waiting_approval', 'paused'].includes(x.status)) { x.status = 'cancelled'; x.paused = false; stopped.push(id); emit('subagent.cancelled', recFor(x)); } }
        out = { stopped }; break;
      }
      case 'reparent': {
        const s = get(); const to = req.parentId || null;
        const ids = [s.id]; for (let i = 0; i < ids.length; i += 1) for (const x of subs.values()) if (x.parentId === ids[i] && !ids.includes(x.id)) ids.push(x.id);
        if (to && ids.includes(to)) throw new Error('An agent can\u2019t move under itself or an agent below it.');
        if (to && !subs.has(to)) throw new Error(`no sub-agent with id '${to}'`);
        const nd = to ? (subs.get(to).depth || 1) + 1 : 1; const delta = nd - (s.depth || 1);
        if (Math.max(...ids.map((id) => (subs.get(id).depth || 1) + delta)) > Math.max(settings.maxDepth, 3)) throw new Error('That would go deeper than the depth limit.');
        for (const id of ids) subs.get(id).depth = (subs.get(id).depth || 1) + delta;
        s.parentId = to; s.parentSessionKey = to ? subs.get(to).sessionKey : (window.__sa.mainKey || '');
        emit('subagent.reparented', recFor(s)); out = { subagent: recFor(s) }; break;
      }
      case 'broadcast': {
        if (!req.message || !String(req.message).trim()) throw new Error('broadcast needs a message');
        const targets = Array.isArray(req.ids) ? req.ids.map((id) => subs.get(id)).filter(Boolean) : [...subs.values()];
        const delivered = targets.map((t) => { const how = ['running', 'waiting_approval'].includes(t.status) ? 'queued' : req.wake ? 'started' : 'kept'; window.__sa.comms.messages.push({ at: Date.now(), kind: 'broadcast', fromId: null, fromName: 'You', toId: t.id, toName: t.name, text: req.message, status: how }); return { id: t.id, delivery: how }; });
        emit('subagent.broadcast', { id: targets[0]?.id });
        out = { delivered }; break;
      }
      // Advanced actions (feature subagentAdvanced), shaped like the engine's advanced.rs.
      case 'spawnBatch': {
        const tasks = Array.isArray(req.tasks) ? req.tasks : [];
        if (tasks.length < 1) throw new Error('spawnBatch needs `tasks`.');
        if (tasks.length > 12) throw new Error('At most 12 tasks in one batch.');
        const mode = req.mode || 'parallel';
        if (!['parallel', 'pipeline', 'race', 'review', 'gather'].includes(mode)) throw new Error(`\`mode\` must be parallel, pipeline, race, review or gather, not "${mode}".`);
        if (mode === 'gather' && tasks.length < 2) throw new Error('A gather batch takes at least two briefs: one or more parts, then the agent that combines their reports.');
        if (mode === 'review' && tasks.length !== 2) throw new Error(`A review batch takes exactly two briefs: the worker's, then the reviewer's (got ${tasks.length}).`);
        if ('rounds' in req && !(Number.isInteger(req.rounds) && req.rounds >= 1 && req.rounds <= 5)) throw new Error('`rounds` must be a whole number from 1 to 5.');
        const groupId = `grp_${String(++seq).padStart(4, '0')}`;
        const made = [];
        tasks.forEach((t, i) => {
          const own = typeof t === 'string' ? { task: t } : { ...t };
          const role = ['worker', 'reviewer'][i];
          const gatherer = mode === 'gather' && i === tasks.length - 1;
          const base = mode === 'review' ? (req.name ? `${req.name}-${role}` : role) : gatherer ? (req.name ? `${req.name}-gatherer` : 'gatherer') : req.name ? `${req.name}-${i + 1}` : undefined;
          const x = make({ ...req, ...own, name: own.name || base, task: [req.task, own.task].filter(Boolean).join('\n\n'), groupId, groupMode: mode, groupIndex: i,
            dependsOn: gatherer ? made.map((m) => m.id) : (mode === 'pipeline' || mode === 'review') && i ? [made[i - 1].id] : [], status: gatherer || ((mode === 'pipeline' || mode === 'review') && i) ? 'queued' : 'running', contextMode: req.context === 'fork' ? 'fork' : undefined, contextSource: req.context === 'fork' ? req.forkSession : undefined });
          made.push(x);
          emit(x.status === 'queued' ? 'subagent.queued' : 'subagent.started', { ...recFor(x), task: x.task });
        });
        out = { groupId, mode, subagents: made.map(recFor) }; break;
      }
      case 'groups': {
        const by = new Map();
        for (const x of subs.values()) if (x.groupId) { if (!by.has(x.groupId)) by.set(x.groupId, []); by.get(x.groupId).push(x); }
        out = { groups: [...by.entries()].map(([g, m]) => ({ groupId: g, mode: m[0].groupMode, size: m.length, active: m.filter((x) => ['running', 'queued'].includes(x.status)).length, finished: m.filter((x) => x.status === 'finished').length, winner: m.find((x) => x.groupWinner)?.id || null,
          members: m.sort((a2, b2) => (a2.groupIndex || 0) - (b2.groupIndex || 0)).map((x) => ({ id: x.id, name: x.name, title: x.title, status: x.status, index: x.groupIndex, winner: !!x.groupWinner, dependsOn: x.dependsOn || [] })) })) };
        break;
      }
      case 'moveToChat': {
        const s0 = get(); const target = String(req.targetSessionKey || '').trim();
        if (!target) throw new Error('moveToChat needs `targetSessionKey`.');
        if (['running', 'queued', 'waiting_approval'].includes(s0.status)) throw new Error(`${s0.name} is still running. Stop it or wait until it ends.`);
        if (s0.parentId) throw new Error('Only a top-level agent can move to another chat.');
        const from = s0.parentSessionKey; s0.parentSessionKey = target; s0.rootSessionKey = target;
        emit('subagent.moved', { ...recFor(s0), from, to: target });
        out = { subagent: recFor(s0) }; break;
      }
      case 'bulk': {
        const op = req.op;
        const applies = (x) => (op === 'stop' || op === 'stopTree' ? ['running', 'queued', 'waiting_approval'].includes(x.status) : op === 'pause' ? ['running', 'queued', 'waiting_approval'].includes(x.status) && !x.paused : op === 'resume' ? !!x.paused : ['retry', 'delete'].includes(op) ? !['running', 'queued', 'waiting_approval'].includes(x.status) : false);
        if (!['stop', 'stopTree', 'pause', 'resume', 'retry', 'delete'].includes(op)) throw new Error(`Unknown bulk op "${op}" (stop, stopTree, pause, resume, retry or delete).`);
        const ids = Array.isArray(req.ids) ? req.ids : [...subs.values()].filter((x) => applies(x)).map((x) => x.id);
        const results = [];
        for (const id of ids) {
          const x = subs.get(id); if (!x) { results.push({ id, ok: false, error: `No sub-agent with id ${id}.` }); continue; }
          if (op === 'stop' || op === 'stopTree') { x.status = 'cancelled'; x.paused = false; emit('subagent.cancelled', recFor(x)); }
          else if (op === 'pause') { x.status = 'paused'; x.paused = true; emit('subagent.paused', recFor(x)); }
          else if (op === 'resume') { x.status = 'running'; x.paused = false; emit('subagent.resumed', recFor(x)); }
          else if (op === 'retry') { x.status = 'running'; x.runs += 1; emit('subagent.started', recFor(x)); }
          else if (op === 'delete') { subs.delete(id); emit('subagent.deleted', { id }); }
          results.push({ id, ok: true });
        }
        out = { op, ok: results.filter((r) => r.ok).length, total: ids.length, results }; break;
      }
      case 'graph': {
        const all = [...subs.values()];
        out = { sessionKey: req.sessionKey || '', nodes: all.map((x) => ({ id: x.id, name: x.name, title: x.title, status: x.status, depth: x.depth, parentId: x.parentId || null })), edges: all.map((x) => ({ from: x.parentId || null, to: x.id })), events: window.__sa.comms.events.slice() };
        if ((cfg.s1features || []).includes('subagentAdvanced')) {
          out.nodes = all.map((x) => ({ id: x.id, name: x.name, title: x.title, status: x.status, depth: x.depth, parentId: x.parentId || null, model: x.model, groupId: x.groupId, groupMode: x.groupMode, groupIndex: x.groupIndex, groupWinner: !!x.groupWinner, dependsOn: x.dependsOn || [], contextMode: x.contextMode, handoff: !!x.handoff, durationMs: x.durationMs }));
          out.dependencyEdges = all.flatMap((x) => (x.dependsOn || []).map((d) => ({ from: d, to: x.id, kind: 'dependency' })));
          const counts = new Map();
          for (const e of window.__sa.comms.events) if (e.event === 'subagent.peer_message' && e.to) counts.set(`${e.id}>${e.to}`, (counts.get(`${e.id}>${e.to}`) || 0) + 1);
          out.messageEdges = [...counts.entries()].map(([k, n]) => { const [f, t] = k.split('>'); return { from: f, to: t, kind: 'message', count: n }; });
          const by = new Map(); for (const x of all) if (x.groupId) { if (!by.has(x.groupId)) by.set(x.groupId, []); by.get(x.groupId).push(x); }
          out.groups = [...by.entries()].map(([g, m]) => ({ groupId: g, mode: m[0].groupMode, size: m.length, winner: m.find((x) => x.groupWinner)?.id || null, members: m.map((x) => ({ id: x.id })) }));
        }
        break;
      }
      default: throw new Error(`unknown action '${action}'`);
    }
    return { resultJson: JSON.stringify(out) };
  };
  window.__sa = {
    subs, memory, transcripts, branches, settings, failNext, make, mainKey: '', comms: { messages: [], events: [] },
    progress(id, patch, kind = 'usage') { const s = subs.get(id); Object.assign(s, patch); emit(`subagent.${kind}`, { ...recFor(s), ...patch }); },
    finish(id, result) { const s = subs.get(id); s.status = 'finished'; s.result = result; transcripts.get(id).push({ role: 'assistant', content: result }); emit('subagent.finished', { ...recFor(s), result }); },
    fail(id, error) { const s = subs.get(id); s.status = 'error'; s.error = error; emit('subagent.error', { ...recFor(s), error }); },
    emit,
  };
})();
