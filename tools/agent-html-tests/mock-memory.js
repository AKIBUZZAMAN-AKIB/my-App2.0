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
    agent.getEngineFeatures = async () => { const r = await gf(); return { ...r, features: [...r.features, ...(cfg.feature === false ? [] : ['turnMemory'])] }; };
    const base = agent.subagents;
    agent.subagents = async (req) => {
      if (!String(req?.action || '').startsWith('memory.')) { if (base) return base(req); throw new Error('unknown action'); }
      rec('agent.memory', req);
      if (window.__mem.delay) await new Promise((r) => setTimeout(r, window.__mem.delay));
      if (window.__mem.failNext) { const m = window.__mem.failNext; window.__mem.failNext = null; throw new Error(m); }
      return window.__mem.handle(req);
    };
  };
  const S = () => window.__mem.state;
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
  window.__mem = {
    state: cfg.empty ? null : sample(),
    delay: 0,
    failNext: null,
    emit(type, payload) { window.__mock.emit(type, { sessionKey: window.__app?.chat?.mainId, ...payload }); },
    handle(req) {
      const st = S() || (window.__mem.state = { settings: { enabled: true, keepRecent: 7, batch: 7 }, version: 0, status: { status: 'ok' }, summarizing: null, memory: { throughTurn: 0, decisions: { current: [], superseded: [] }, facts: [], preferences: [], files: [], openItems: [], segments: [] }, topics: [], versions: [], turns: [], results: { results: [], unavailable: [] }, contents: {} });
      switch (req.action) {
        case 'memory.get': return JSON.parse(JSON.stringify({ settings: st.settings, version: st.version, status: st.status, summarizing: st.summarizing, memory: st.memory, topics: st.topics, versions: st.versions, turns: st.turns }));
        case 'memory.settings': {
          const s = req.settings || {};
          for (const k of ['keepRecent', 'batch']) if (s[k] != null) { if (!Number.isInteger(s[k]) || s[k] < 1 || s[k] > 50) throw new Error(`${k} must be 1-50`); st.settings[k] = s[k]; }
          if (typeof s.enabled === 'boolean') st.settings.enabled = s.enabled;
          return { settings: st.settings };
        }
        case 'memory.reset': {
          const prev = st.memory.throughTurn; st.version += 1;
          st.memory = { throughTurn: 0, decisions: { current: [], superseded: [] }, facts: [], preferences: [], files: [], openItems: [], segments: [] };
          st.turns = []; st.topics = [];
          st.versions.unshift({ version: st.version, kind: 'reset', throughTurn: 0, createdAt: Date.now(), detail: { previousThroughTurn: prev } });
          return { reset: true };
        }
        case 'memory.turns': return { turns: st.turns.filter((t) => t.turn >= req.fromTurn && t.turn <= req.toTurn).map((t) => ({ turn: t.turn, text: `[user]\nOriginal text of turn ${t.turn}\n[assistant]\nReply ${t.turn}` })) };
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
