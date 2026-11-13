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
      case 'message': { const s = get(); if (!req.message) throw new Error('message needs text'); transcripts.get(s.id).push({ role: 'user', content: req.message }); out = { queued: s.status === 'running' }; break; }
      case 'retry': { const s = get(); if (s.status === 'running') throw new Error('it is still running'); s.status = 'running'; s.runs += 1; s.steps = 0; emit('subagent.started', recFor(s)); out = { subagent: recFor(s) }; break; }
      case 'delete': { const s = get(); if (s.status === 'running') throw new Error('stop it first'); subs.delete(s.id); out = { deleted: true }; break; }
      // S0/S1 actions (features subagentQueue, subagentData, subagentReuse, crossSession)
      case 'priority': { const s = get(); s.priority = Math.max(-10, Math.min(10, Number(req.priority) || 0)); out = { subagent: recFor(s) }; break; }
      case 'regenerate': { const s = get(); if (s.status === 'running') throw new Error('it is still running'); const t = transcripts.get(s.id); while (t.length && t[t.length - 1].role === 'assistant') t.pop(); t.push({ role: 'assistant', content: [{ type: 'text', text: 'Regenerated answer.' }] }); out = { subagent: recFor(s), resumed: true }; break; }
      case 'edit': { const s = get(); if (!req.message) throw new Error('edit needs text'); const t = transcripts.get(s.id); let n = -1, at = -1; t.forEach((m, i) => { if (m.role === 'user' && typeof m.content === 'string') { n++; if (n === Number(req.turn)) at = i; } }); if (at < 0) throw new Error('No user message ' + req.turn); t.splice(at); t.push({ role: 'user', content: req.message }, { role: 'assistant', content: [{ type: 'text', text: 'Edited answer.' }] }); out = { subagent: recFor(s), resumed: true }; break; }
      case 'fork': { const s0 = get(); const s = make({ name: s0.name + '-copy', task: req.task || s0.task, tools: s0.tools }); emit('subagent.started', { ...recFor(s), task: s.task }); out = { subagent: recFor(s) }; break; }
      case 'find': { const k = String(req.key || req.name || ''); out = { subagent: recFor(subs.get(k) || [...subs.values()].reverse().find((x) => x.name === k)) || null }; break; }
      case 'log': { const s = get(); out = { id: s.id, log: [{ at: Date.now(), event: 'subagent.finished', status: s.status }] }; break; }
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
        const list = memory.get(req.name) || [];
        if (req.op === 'list') out = { entries: list };
        else if (req.op === 'delete') { memory.set(req.name, list.filter((e) => e.key !== req.key)); out = { deleted: 1 }; }
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
      default: throw new Error(`unknown action '${action}'`);
    }
    return { resultJson: JSON.stringify(out) };
  };
  window.__sa = {
    subs, memory, transcripts, settings, failNext, make, mainKey: '',
    progress(id, patch, kind = 'usage') { const s = subs.get(id); Object.assign(s, patch); emit(`subagent.${kind}`, { ...recFor(s), ...patch }); },
    finish(id, result) { const s = subs.get(id); s.status = 'finished'; s.result = result; transcripts.get(id).push({ role: 'assistant', content: result }); emit('subagent.finished', { ...recFor(s), result }); },
    fail(id, error) { const s = subs.get(id); s.status = 'error'; s.error = error; emit('subagent.error', { ...recFor(s), error }); },
    emit,
  };
})();
