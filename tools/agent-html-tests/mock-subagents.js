// A stateful fake of the engine's sub-agent manager behind NativeKit.agent.subagents(),
// matching subagents.rs: list/get/spawn/stop/message/retry/delete/memory/settings and
// subagent.* events. window.__sa controls it from tests (fail next call, emit events).
(() => {
  const a = window.NativeKit.agent;
  const rec = (name, args) => window.__mock.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
  const cfg = window.__SA_CFG || {};
  if (cfg.feature !== false) {
    const gf = a.getEngineFeatures;
    a.getEngineFeatures = async () => { const r = await gf(); return { ...r, features: [...r.features, 'subagents'] }; };
  }
  if (cfg.method === false) return;
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
      result: spec.result || null, error: spec.error || null, stopReason: null, createdAt: spec.createdAt || now + seq, startedAt: now, finishedAt: null, runs: 1,
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
        const s = get(); if (s.status === 'running') { s.status = 'cancelled'; emit('subagent.cancelled', recFor(s)); } out = { stopped: 1 }; break;
      }
      case 'message': { const s = get(); if (!req.message) throw new Error('message needs text'); transcripts.get(s.id).push({ role: 'user', content: req.message }); out = { queued: s.status === 'running' }; break; }
      case 'retry': { const s = get(); if (s.status === 'running') throw new Error('it is still running'); s.status = 'running'; s.runs += 1; s.steps = 0; emit('subagent.started', recFor(s)); out = { subagent: recFor(s) }; break; }
      case 'delete': { const s = get(); if (s.status === 'running') throw new Error('stop it first'); subs.delete(s.id); out = { deleted: true }; break; }
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
