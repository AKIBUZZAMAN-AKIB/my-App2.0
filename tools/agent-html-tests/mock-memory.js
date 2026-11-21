// A stateful fake of the engine's chat memory behind NativeKit.agent.subagents({action: 'memory.*'}),
// matching memory_action in lib.rs: get/settings/reset/turns/versions/version/revert/results/result
// and the memory.* events. window.__mem controls it from tests.
(() => {
  const cfg = window.__MEM_CFG || {};
  const rec = (name, args) => window.__mock.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
  const a = window.NativeKit?.agent || window.Capacitor?.Plugins?.NativeAgent;
  const wrap = (agent) => {
    if (!agent || agent.__memWrapped) return;
    agent.__memWrapped = true;
    const gf = agent.getEngineFeatures;
    agent.getEngineFeatures = async () => { const r = await gf(); return { ...r, features: [...r.features, ...(cfg.feature === false ? [] : ['turnMemory']), ...(cfg.contextTree ? ['contextTree'] : [])] }; };
    const base = agent.subagents;
    agent.subagents = async (req) => {
      // cfg.contextTree: a minimal context tree (empty checklist, switch on) so the context card can open.
      if (cfg.contextTree && String(req?.action || '').startsWith('ctx.')) {
        rec('agent.ctx', req);
        if (req.action === 'ctx.settings') return { settings: { enabled: true, thresholdPercent: 80 } };
        if (req.action === 'ctx.tree') return { counts: { in: 0, out: 0 }, tokens: { selected: 0, window: 128000 }, items: [] };
        return {};
      }
      if (!String(req?.action || '').startsWith('memory.')) { if (base) return base(req); throw new Error('unknown action'); }
      rec('agent.memory', req);
      if (window.__mem.delay) await new Promise((r) => setTimeout(r, window.__mem.delay));
      if (window.__mem.failNext) { const m = window.__mem.failNext; window.__mem.failNext = null; throw new Error(m); }
      return window.__mem.handle(req);
    };
  };
  // Sub-agents have their own sessions: their memory lives in `sessions` (sessionKey -> state); the main chat uses `state`.
  let curKey = null;
  const S = () => (curKey && window.__mem.sessions?.[curKey] ? window.__mem.sessions[curKey] : window.__mem.state);
  const now = Date.now();
  function sample() {
    return {
      settings: { enabled: true, keepRecent: 7, batch: 7 },
      version: 3,
      status: { status: 'ok' },
      summarizing: null,
      memory: {
        version: 1, throughTurn: 14, updatedAt: now - 120000,
        goal: 'Build the offline notes app with sync',
        decisions: {
          current: [
            { id: 'D2', text: 'Use SQLite for local storage', turn: 9 },
            { id: 'D3', text: 'Sync over WebSocket', turn: 12 },
          ],
          superseded: [{ id: 'D1', text: 'Use PostgreSQL for storage', turn: 2, supersededBy: 'D2', supersededAt: 9 }],
        },
        facts: [{ text: 'The user is in Rajshahi (UTC+6)', turn: 1 }, { text: 'Big log is at /tmp/app.log, see #R1', turn: 5 }],
        preferences: [{ text: 'Answers in Bengali', turn: 1 }],
        files: ['src/db.rs', 'src/sync/ws.rs', 'R1'],
        openItems: ['Pick a conflict strategy'],
        segments: [
          { fromTurn: 1, toTurn: 7, topic: 'database', title: 'Storage choice', summary: 'Started with PostgreSQL, compared options.' },
          { fromTurn: 8, toTurn: 14, topic: 'sync', title: 'Sync design', summary: 'Moved to SQLite (D2) and chose WebSocket sync.' },
        ],
      },
      topics: [{ topic: 'database', ranges: [[1, 7]] }, { topic: 'sync', ranges: [[8, 14]] }],
      versions: [
        { version: 3, kind: 'repair', throughTurn: 14, createdAt: now - 60000, detail: { kind: 'fact', added: { text: 'Big log is at /tmp/app.log, see #R1', turn: 5 }, reason: 'The summary missed the log path.', evidence: [{ turn: 5, quote: 'the log is at /tmp/app.log' }] } },
        { version: 2, kind: 'summary', throughTurn: 14, createdAt: now - 120000, detail: { fromTurn: 8, toTurn: 14, calls: 1, portions: 1, superseded: [{ id: 'D1', by: 'D2' }] } },
        { version: 1, kind: 'summary', throughTurn: 7, createdAt: now - 600000, detail: { fromTurn: 1, toTurn: 7, calls: 1, portions: 1 } },
      ],
      turns: Array.from({ length: 21 }, (_, i) => ({ turn: i + 1, messages: 2, bytes: 900 + i * 37, preview: `Turn ${i + 1}: user asked about step ${i + 1}` })),
      results: {
        results: [
          { id: 'R1', toolUseId: 't1', tool: 'read_file', source: '/tmp/app.log', isError: false, bytes: 2_100_000, turn: 5, createdAt: now - 500000, preview: 'INFO start\nINFO ready' },
          { id: 'R3', toolUseId: 't3', tool: 'web_fetch', source: 'https://example.com/docs', isError: false, bytes: 48_000, turn: 11, createdAt: now - 300000, preview: '<html>docs' },
        ],
        unavailable: [{ id: 'R2', referencedIn: ['turn 8'] }],
      },
      contents: { R1: 'INFO start\n' + 'x'.repeat(20000) + '\nNEEDLE\n' + 'y'.repeat(9000), R3: 'docs body' },
    };
  }
  // Phase 6/7 fields (items with status/history, background jobs, coverage,
  // storage, legacy context), only with __MEM_CFG.p7 so the older checks keep
  // their exact data.
  function p7(st) {
    st.settings = { ...st.settings, backgroundSummaries: true, resultBudgetBytes: 64 * 1048576, keepUnreferencedResultDays: 7 };
    st.memory.decisions.superseded[0].reason = 'PostgreSQL needs a server; the app must work offline';
    st.memory.items = [
      { id: 'F1', kind: 'fact', text: 'The user is in Rajshahi (UTC+6)', status: 'current', sourceTurns: [1], updatedTurn: 1 },
      { id: 'F2', kind: 'fact', text: 'Server port is 8443', status: 'superseded', sourceTurns: [3], updatedTurn: 10, supersededBy: 'F3', reason: 'user moved the server', history: [{ turn: 10, change: 'superseded', text: 'Server port is 8443', reason: 'user moved the server' }] },
      { id: 'F3', kind: 'fact', text: 'Server port is 9443', status: 'current', sourceTurns: [10], updatedTurn: 10, history: [{ turn: 12, change: 'updated', text: 'Server port is 9000', reason: 'typo fixed' }] },
      { id: 'P1', kind: 'preference', text: 'Answers in Bengali', status: 'current', sourceTurns: [1], updatedTurn: 1 },
      { id: 'L1', kind: 'file', text: 'src/db.rs', status: 'current', sourceTurns: [9], updatedTurn: 9 },
      { id: 'O1', kind: 'openItem', text: 'Pick a conflict strategy', status: 'current', sourceTurns: [13], updatedTurn: 13 },
      { id: 'O2', kind: 'openItem', text: 'Benchmark SQLite writes', status: 'done', sourceTurns: [11], updatedTurn: 14, reason: 'benchmark finished: 4k writes/s', history: [{ turn: 14, change: 'done', text: 'Benchmark SQLite writes', reason: 'benchmark finished: 4k writes/s' }] },
    ];
    st.jobs = { active: null, recent: [{ jobKey: 'j1', fromTurn: 15, toTurn: 21, status: 'failed', attempts: 5, maxAttempts: 5, nextAttemptAt: 0, lastError: 'provider returned 503', createdAt: now - 90000, updatedAt: now - 30000 }], workerRunning: false };
    st.coverage = { ok: false, throughTurn: 14, transcriptTurns: 21, unsummarized: [15, 21], gaps: [[4, 4]], overlaps: [], beyondSummary: [], decisionsWithoutSource: [], itemsWithoutSource: ['F9'], legacyItems: 0, originalsMissing: [[2, 2]], archiveOnly: [[20, 21]], archiveDiffers: [20], problems: ['turn 4 is not in any segment'] };
    st.storage = { resultCount: 2, resultBytes: 2_148_000, prunedCount: 1, prunedBytes: 3000, archiveBytes: 5000, versionBytes: 9000, budgetBytes: 64 * 1048576, keepUnreferencedDays: 7, overBudget: false, lastCleanup: { at: now - 3_600_000, pruned: 1, prunedBytes: 3000, error: null } };
    st.legacyContext = { messages: 1, chars: 1800, preview: 'Session summary: the user is building an offline notes app and asked for SQLite.', truncated: true };
    st.results.unavailable.push({ id: 'R4', tool: 'execute_command', prunedAt: now - 3_600_000, reason: 'nothing in this chat referred to it any more', bytes: 3000, turn: 19, referencedIn: [] });
    st.prunable = ['R3'];
    st.turns = Array.from({ length: 60 }, (_, i) => ({ turn: i + 1, messages: 2, bytes: 900 + i * 37, preview: `Turn ${i + 1}: user asked about step ${i + 1}` }));
    return st;
  }
  // Schema v6 fields (goals with statuses, goal links on decisions and
  // items, stored assembly audits), only with __MEM_CFG.goals.
  function v6(st) {
    st.goals = {
      currentGoalId: 'G003',
      goals: [
        { goalId: 'G001', title: 'Build the offline notes app with sync', description: 'Build the offline notes app with sync', status: 'completed', createdAt: now - 9e6, updatedAt: now - 5e6, sourceTurn: 0, completedAt: now - 5e6 },
        { goalId: 'G002', title: 'Fix the login bug', description: '', status: 'paused', createdAt: now - 8e6, updatedAt: now - 7e6, sourceTurn: 6 },
        { goalId: 'G003', title: 'Write the release notes', description: '', status: 'active', createdAt: now - 4e6, updatedAt: now - 4e6, sourceTurn: 15 },
        { goalId: 'G004', title: 'Migrate to Postgres', description: '', status: 'cancelled', createdAt: now - 6e6, updatedAt: now - 6e6, sourceTurn: 13 },
      ],
      events: [
        { seq: 5, goalId: 'G003', op: 'create', turn: 15, atMs: now - 4e6, origin: 'user', evidence: 'New goal: write the release notes' },
        { seq: 4, goalId: 'G004', op: 'cancel', turn: 14, atMs: now - 6e6, origin: 'user', evidence: 'Cancel the goal' },
        { seq: 1, goalId: 'G001', op: 'create', turn: 0, atMs: now - 9e6, origin: 'migration', evidence: '' },
      ],
    };
    st.memory.decisions.current[0].goalId = 'G001';
    st.memory.decisions.superseded[0].goalId = 'G001';
    st.memory.items = [
      { id: 'O1', kind: 'openItem', text: 'Reproduce the login timeout', status: 'current', sourceTurns: [7], updatedTurn: 7, goalId: 'G002' },
      { id: 'O2', kind: 'openItem', text: 'List the release notes sections', status: 'current', sourceTurns: [12], updatedTurn: 12 },
    ];
    st.audit = [{ assemblyId: 'asm-7', conversationId: 'main', createdAt: now - 60000, provider: 'openrouter', model: 'qwen/qwen3', iteration: 0, attempt: 0, memoryVersion: 2, summaryThroughTurn: 14, inputTokenBudget: 50000, estimatedInputTokens: 6100, reservedOutputTokens: 8192, includedRecentTurns: [15, 16, 17, 18, 19, 20, 21, 22], includedGoalIds: ['G003'], includedDecisionIds: ['D2'], includedTaskIds: ['O2'], includedMemoryIds: ['P1'], includedSummarySegmentIds: ['S13-14'], retrievalSources: ['current_goal', 'newest_segment'], compactionActions: ['memory_fold:turns_1-14'], truncationActions: [] }];
    return st;
  }
  window.__mem = {
    state: cfg.empty ? null : (cfg.goals ? v6(sample()) : cfg.p7 ? p7(sample()) : sample()),
    delay: 0,
    failNext: null,
    emit(type, payload) { window.__mock.emit(type, { sessionKey: window.__app?.chat?.mainId, ...payload }); },
    sessions: {},
    /** Adds a blank memory for a sub-agent session; `goals` seeds its goals. */
    addSession(key, { goals = [], events = [], current = null } = {}) {
      window.__mem.sessions[key] = { settings: { enabled: true, keepRecent: 7, batch: 7 }, version: 0, status: { status: 'ok' }, summarizing: null,
        memory: { throughTurn: 0, decisions: { current: [], superseded: [] }, facts: [], preferences: [], openItems: [], items: [] }, turns: [], versions: [], topics: [], jobs: [],
        goals: { currentGoalId: current, goals, events } };
      return window.__mem.sessions[key];
    },
    handle(req) {
      curKey = req.sessionKey && window.__mem.sessions[req.sessionKey] ? req.sessionKey : null;
      if (req.action === 'memory.goal') return window.__mem.goal(req);
      return window.__mem.handle2(req);
    },
    /** `memory.goal` as lib.rs + goals.rs: create (an open goal with the same title resumes it; a new one pauses the active one), resume, complete, cancel. */
    goal(req) {
      const st = S();
      if (!st.goals) st.goals = { currentGoalId: null, goals: [], events: [] };
      const G = st.goals;
      const op = req.op;
      if (!['create', 'resume', 'complete', 'cancel'].includes(op)) throw new Error(`unknown goal op "${op}"`);
      const open = (g) => g.status === 'active' || g.status === 'paused';
      const find = (id) => G.goals.find((g) => g.goalId === String(id || '').trim().toUpperCase());
      const seq = (G.events[0]?.seq || 0) + 1;
      const ev = (goalId, o, extra = {}) => G.events.unshift({ seq, goalId, op: o, turn: 1, atMs: Date.now(), origin: 'app', evidence: 'changed on the Goals tab', ...extra });
      const activate = (g) => { for (const x of G.goals) if (x !== g && x.status === 'active') x.status = 'paused'; g.status = 'active'; G.currentGoalId = g.goalId; };
      let outcome;
      if (op === 'create') {
        const title = String(req.title || '').trim();
        if (!title) throw new Error('a new goal needs a title');
        const same = G.goals.find((g) => open(g) && g.title.trim().toLowerCase() === title.toLowerCase());
        if (same) { if (G.currentGoalId === same.goalId) throw new Error(`${same.goalId} is already the active goal`); activate(same); ev(same.goalId, 'resume'); outcome = { applied: true, goalId: same.goalId, op: 'resume' }; }
        else {
          const n = Math.max(0, ...G.goals.map((g) => Number(String(g.goalId).slice(1)) || 0)) + 1;
          const g = { goalId: `G${String(n).padStart(3, '0')}`, title, description: String(req.description || '').trim(), status: 'active', createdAt: Date.now(), updatedAt: Date.now(), sourceTurn: 1 };
          G.goals.push(g); activate(g); ev(g.goalId, 'create'); outcome = { applied: true, goalId: g.goalId, op: 'create' };
        }
      } else {
        const g = find(req.goalId) || (op !== 'resume' && !req.goalId ? find(G.currentGoalId) : null);
        if (!g) throw new Error(op === 'resume' ? 'resume names no known goal' : 'the goal named is not known');
        if (op === 'resume') { if (G.currentGoalId === g.goalId && g.status === 'active') throw new Error(`${g.goalId} is already the active goal`); activate(g); }
        else { g.status = op === 'complete' ? 'completed' : 'cancelled'; if (op === 'complete') g.completedAt = Date.now(); if (G.currentGoalId === g.goalId) G.currentGoalId = null; }
        ev(g.goalId, op); outcome = { applied: true, goalId: g.goalId, op };
      }
      window.__mem.goalCalls = (window.__mem.goalCalls || []).concat([{ ...req }]);
      return JSON.parse(JSON.stringify({ outcome, goals: G }));
    },
    handle2(req) {
      const st = S() || (window.__mem.state = { settings: { enabled: true, keepRecent: 7, batch: 7 }, version: 0, status: { status: 'ok' }, summarizing: null, memory: { throughTurn: 0, decisions: { current: [], superseded: [] }, facts: [], preferences: [], files: [], openItems: [], segments: [] }, topics: [], versions: [], turns: [], results: { results: [], unavailable: [] }, contents: {} });
      switch (req.action) {
        case 'memory.get': return JSON.parse(JSON.stringify({ settings: st.settings, version: st.version, status: st.status, summarizing: st.summarizing, memory: st.memory, topics: st.topics, versions: st.versions, turns: st.turns, jobs: st.jobs, coverage: st.coverage, storage: st.storage, legacyContext: st.legacyContext, goals: st.goals, audit: st.audit, unreadable: st.unreadable, recoveredFrom: st.recoveredFrom, fromNewerBuild: st.fromNewerBuild }));
        case 'memory.retry': {
          const last = st.jobs?.recent?.[0];
          if (!last || last.status !== 'failed') return { retried: false };
          last.status = 'queued'; last.attempts = 0; last.lastError = null;
          st.jobs.active = { ...last };
          return { retried: true, jobs: st.jobs };
        }
        case 'memory.storage': return { report: { dryRun: true, pruned: [...(st.prunable || [])] }, storage: st.storage };
        case 'memory.prune': {
          const ids = st.prunable || [];
          let bytes = 0;
          for (const id of ids) {
            const r = st.results.results.find((x) => x.id === id);
            if (!r) continue;
            bytes += r.bytes;
            st.results.results = st.results.results.filter((x) => x.id !== id);
            st.results.unavailable.push({ id, tool: r.tool, prunedAt: Date.now(), reason: 'nothing in this chat referred to it any more', bytes: r.bytes, turn: r.turn, referencedIn: [] });
          }
          st.prunable = [];
          if (st.storage) { st.storage.resultCount -= ids.length; st.storage.resultBytes -= bytes; st.storage.prunedCount += ids.length; st.storage.prunedBytes += bytes; st.storage.lastCleanup = { at: Date.now(), pruned: ids.length, prunedBytes: bytes, error: null }; }
          return { report: { dryRun: false, pruned: ids, prunedBytes: bytes }, storage: st.storage };
        }
        case 'memory.settings': {
          const s = req.settings || {};
          for (const k of ['keepRecent', 'batch']) if (s[k] != null) { if (!Number.isInteger(s[k]) || s[k] < 1 || s[k] > 50) throw new Error(`${k} must be 1-50`); st.settings[k] = s[k]; }
          if (typeof s.enabled === 'boolean') st.settings.enabled = s.enabled;
          if (typeof s.backgroundSummaries === 'boolean') st.settings.backgroundSummaries = s.backgroundSummaries;
          if (s.resultBudgetBytes != null) st.settings.resultBudgetBytes = Math.min(4096 * 1048576, Math.max(1048576, s.resultBudgetBytes));
          if (s.keepUnreferencedResultDays != null) st.settings.keepUnreferencedResultDays = Math.min(365, Math.max(0, s.keepUnreferencedResultDays));
          return { settings: st.settings };
        }
        case 'memory.reset': {
          const prev = st.memory.throughTurn; st.version += 1;
          st.memory = { throughTurn: 0, decisions: { current: [], superseded: [] }, facts: [], preferences: [], files: [], openItems: [], segments: [] };
          st.turns = []; st.topics = [];
          st.versions.unshift({ version: st.version, kind: 'reset', throughTurn: 0, createdAt: Date.now(), detail: { previousThroughTurn: prev } });
          return { reset: true };
        }
        case 'memory.turns': {
          if (!st.coverage) return { turns: st.turns.filter((t) => t.turn >= req.fromTurn && t.turn <= req.toTurn).map((t) => ({ turn: t.turn, text: `[user]\nOriginal text of turn ${t.turn}\n[assistant]\nReply ${t.turn}` })) };
          // Like lib.rs: at most 51 turns, the rest reported; source per turn.
          const end = Math.min(req.toTurn, req.fromTurn + 50);
          const arch = new Set(); for (const [a, b] of st.coverage.archiveOnly || []) for (let n = a; n <= b; n++) arch.add(n);
          const gone = new Set(); for (const [a, b] of st.coverage.originalsMissing || []) for (let n = a; n <= b; n++) gone.add(n);
          const turns = st.turns.filter((t) => t.turn >= req.fromTurn && t.turn <= end && !gone.has(t.turn)).map((t) => ({ turn: t.turn, text: `[user]\nOriginal text of turn ${t.turn}`, source: arch.has(t.turn) ? 'archive' : 'transcript', archiveDiffers: (st.coverage.archiveDiffers || []).includes(t.turn) }));
          const missing = [...gone].filter((n) => n >= req.fromTurn && n <= end).map((n) => [n, n]);
          return { turns, missing, unread: end < req.toTurn ? [end + 1, req.toTurn] : null };
        }
        case 'memory.versions': return { versions: st.versions };
        case 'memory.version': { const v = st.versions.find((x) => x.version === req.version); return v ? { version: v.version, kind: v.kind, rendered: `native-agent-turn-memory-v1\nVersion ${v.version}\nGOAL: ${st.memory.goal || ''}` } : { missing: true, version: req.version }; }
        case 'memory.revert': {
          const v = st.versions.find((x) => x.version === req.version);
          if (!v || v.kind !== 'repair') return { reverted: false, error: 'only repairs can be reverted' };
          if (st.versions.some((x) => x.kind === 'revert' && x.detail.revertedVersion === v.version)) return { reverted: false, error: 'that repair was already reverted' };
          st.version += 1;
          if (v.detail.kind === 'fact') st.memory.facts = st.memory.facts.filter((f) => f.text !== v.detail.added.text);
          st.versions.unshift({ version: st.version, kind: 'revert', throughTurn: st.memory.throughTurn, createdAt: Date.now(), detail: { revertedVersion: v.version } });
          st.versions = st.versions.slice(0, 10);
          return { reverted: true, version: st.version };
        }
        case 'memory.results': return JSON.parse(JSON.stringify(st.results));
        case 'memory.result': {
          const r = st.results.results.find((x) => x.id === String(req.resultId).replace(/^#/, ''));
          if (!r) return { unavailable: true, id: req.resultId };
          const full = st.contents[r.id] || '';
          const off = Math.min(Number(req.offset) || 0, full.length); const end = Math.min(off + 16000, full.length);
          return { id: r.id, tool: r.tool, source: r.source, bytes: full.length, turn: r.turn, isError: r.isError, offset: off, text: full.slice(off, end), nextOffset: end < full.length ? end : null, preview: full.slice(0, 4000) };
        }
        default: throw new Error(`unknown memory action: ${req.action}`);
      }
    },
  };
  const tryWrap = () => wrap(window.NativeKit?.agent || window.Capacitor?.Plugins?.NativeAgent);
  tryWrap();
  document.addEventListener('DOMContentLoaded', tryWrap);
  void a;
})();
