/* ==========================================================================
   Context card: the window the model is actually given, in one place.

   The engine gives the model a checklist of everything in and around its
   context window (in / out / note / temp / locked, with what each item costs)
   and a `ctx` tool to change it. This card shows the *same* truth to the
   person using the app. It is the one home for what used to be spread over
   three screens (the context sheet, the Chat memory screen and the Sections
   sheet): a small tabbed card above the composer.

   * Checklist: token use by kind (one coloured bar), then a tree. Rules and
     memory are groups; the conversation is listed turn by turn, each turn with
     its tool calls and their results under it, and each range summary right
     after the turns it covers. Every row with a box can be taken out or
     brought back on its own, by the person here or by the model with `ctx`.
   * Summary: the running summary, which is always sent, and when it was made.
   * Log: why things left the window.  * Settings: the switch and memory settings.

   Nothing here is invented (every row comes from the engine or from the chat's
   own messages) and it never throws: a missing field leaves an empty row.
   ========================================================================== */
const ContextTree = (() => {
  const SYMBOL = { in: '●', out: '○', note: '◐', temp: '✦', locked: '⚿' };
  const STATE_LABEL = { in: 'In the window', out: 'Out (stored)', note: 'Note only', temp: 'Replaced by a summary', locked: 'Locked' };
  const REASON_LABEL = {
    model: 'you or the model asked',
    budget: 'the window was over its budget',
    category_cap: 'its category was over its cap',
    forced: 'the window overflowed (pinned items give way last)',
    gc: 'trimmed to keep the session small',
  };
  const ACTOR_LABEL = { model: 'Model', policy: 'Engine policy', user: 'You', engine: 'Engine' };

  let state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: '', memory: null, requests: null, checklists: { user: [], ai: [] } };
  /** Memory rows waiting for the engine's answer: rid -> action. */
  const pendingMem = new Map();
  // null = the engine has not told us yet, so the panel shows the tree (the
  // engine only mounts it when the feature is advertised). `false` means the user
  // turned it off and the panel says so instead of pretending to have data.
  let settings = null;
  // The last "Reset tree" answer, shown for a minute so the person sees it worked.
  let lastReset = null;
  // The last thing that went wrong talking to the engine ({ what, message, at }),
  // shown in the panel with a retry instead of only in the console: a switch that
  // silently flips back is what made "it can't be turned on" impossible to diagnose.
  let lastError = null;
  // The action in flight ('on' | 'off' | 'reset'), so the buttons say what is
  // happening and cannot be pressed twice.
  let busy = null;
  const subs = new Set();
  const panel = { root: null, body: null, tabs: null, open: false, anchor: null, tab: 'items', expanded: new Set(['grp/turns', 'conv/current']), tips: new Set(), detailsOpen: {} };
  let pendingSet = new Map(); // `${chat}|${id}` -> state asked for, until the engine confirms
  // The other stored conversations, read on demand when their row is opened:
  // key -> { items, tokens, counts, msgs, loading, error, at }. The open chat lives in `state`.
  const convs = new Map();
  const CONV_PAGE = 8; // conversations shown before "Show all"
  let NS = '', RK = ''; // while painting one conversation: expand-id prefix and its chat key

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
  const short = (n) => {
    if (typeof n !== 'number') return '—';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
    return (n / 1e6).toFixed(1) + 'M';
  };
  function parseMaybeJSON(v, fallback) {
    if (v && typeof v === 'object') return v;
    if (typeof v !== 'string') return fallback;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }
  function available() {
    // Shown unless the app explicitly hides it. It used to require the shell to
    // advertise a "contextTree" feature, and a shell that never advertised it hid the
    // panel *and* its only switch — so the tree could not be turned on from the app at
    // all, which is exactly the state the user reported ("there is no option").
    if (typeof window !== 'undefined' && window.__ctxTreeHidden === true) return false;
    // The native engine now advertises "contextTree" in its feature list, so the
    // panel follows that list once it has loaded. Before it loads, the panel is
    // shown whenever a native engine is there to answer it, so the switch is never
    // hidden by a race; with no engine at all (a plain web page) it is not shown.
    const listed = Array.isArray(window.__features) ? window.__features : null;
    if (listed && listed.includes('contextTree')) return true;
    try {
      if (typeof engine !== 'undefined' && engine && engine.info && Array.isArray(engine.info.features) && engine.info.features.length) {
        return engine.has('contextTree');
      }
    } catch (e) { /* no engine object in this build */ }
    if (listed) return false;
    try {
      const kit = typeof nativeKit === 'function' ? nativeKit() : null;
      return !!(kit && kit.agent && typeof kit.agent.subagents === 'function');
    } catch (e) { return false; }
  }

  /** Fold one engine event into the panel's state. */
  function onEvent(type, payload) {
    const p = parseMaybeJSON(payload, null);
    if (!p) return;
    if (type === 'context.policy') { const cp = policyApi(); if (cp) { try { cp.onEvent(type, p); } catch (e) { console.warn('context policy event', e); } } }
    // Every chat (the main one and each sub-agent) sends its own tree on the
    // same event bus: only the open chat's may land here, or a sub-agent's
    // checklist and memory would show another chat's rows.
    if ((type === 'context.tree' || type === 'context.checklist' || type === 'context.tree_action' || type === 'context.tree_changed')
      && p.sessionKey && activeKey() && p.sessionKey !== activeKey()) return;
    if (type === 'context.tree' || type === 'context.checklist') {
      state = {
        rev: p.rev ?? state.rev,
        counts: p.counts ?? state.counts,
        tokens: p.tokens ?? state.tokens,
        items: Array.isArray(p.items) ? p.items : state.items,
        log: Array.isArray(p.log) ? p.log : state.log,
        stage: p.stage ?? state.stage,
        model: p.model || state.model,
        // The chat memory as checklist groups (memory_checklist.rs).
        memory: p.memory && typeof p.memory === 'object' && Array.isArray(p.memory.groups) ? p.memory : (p.sessionKey && p.sessionKey !== state.sessionKey ? null : state.memory),
        sessionKey: p.sessionKey || state.sessionKey || null,
        // Every model request per turn (request_log.rs): one turn is many requests.
        requests: p.requests && typeof p.requests === 'object' && Array.isArray(p.requests.turns) ? p.requests : state.requests,
        // The person's checklists and the model's own (store.rs ucl/…, cat/…, task/pick).
        checklists: p.checklists && typeof p.checklists === 'object' ? p.checklists : (state.checklists || { user: [], ai: [] }),
      };
      if (p.settings) applySettings(p.settings);
      else if (typeof p.enabled === 'boolean') settings = { enabled: true, thresholdPercent: settings ? settings.thresholdPercent : null };
      paint();
      subs.forEach((fn) => { try { fn(state); } catch (e) { /* a listener is not our problem */ } });
    } else if (type === 'context.tree_action') {
      state.log = [p, ...state.log].slice(0, 50);
      paint();
    } else if (type === 'context.tree_changed') {
      // The model changed the tree mid-turn: read the new state from the engine.
      refresh();
    } else if (type === 'context.request') {
      // A request was sent (a step, a retry or a summary): read the ledger again.
      if (!p.sessionKey || p.sessionKey === activeKey()) readRequests();
    }
  }

  /** Fold one `ctx` tool result into the panel's state. */
  /** Fold a `ctx` tool result in. Returns true when the result was used. */
  function onToolResult(name, result) {
    if (name !== 'ctx') return false;
    const r = parseMaybeJSON(result, null);
    if (!r) return false;
    // A settings answer (`ctx.settings`) carries the switch and nothing else.
    if (applySettings(r.settings)) return true;
    if (r.rev != null) state.rev = r.rev;
    if (r.counts) state.counts = r.counts;
    if (r.tokens) state.tokens = r.tokens;
    if (Array.isArray(r.results)) {
      state.log = [
        ...r.results.map((o) => ({
          actor: 'model',
          at: Date.now(),
          ops: JSON.stringify([{ id: o.id, action: o.action, ok: o.ok }]),
          reason: o.ok ? null : o.message,
          tokensBefore: o.tokens && o.tokens.before,
          tokensAfter: o.tokens && o.tokens.after,
        })),
        ...state.log,
      ].slice(0, 50);
    }
    paint();
    return true;
  }

  /** Normalise whatever the engine sent into the three things the panel shows. */
  function normalizeSettings(raw) {
    const s = parseMaybeJSON(raw, null);
    if (!s || typeof s !== 'object') return null;
    if (typeof s.enabled !== 'boolean') return null;
    // The checklist is always on: there is no off, whatever an old engine says.
    return {
      enabled: true,
      thresholdPercent: typeof s.thresholdPercent === 'number' ? s.thresholdPercent : null,
    };
  }

  let appRef = null;
  /** The chat whose tree the panel shows: the open main chat. */
  const activeKey = () => (appRef && appRef.chat && appRef.chat.mainId) || null;

  /**
   * The bridge to the engine. The app talks to the native engine through the
   * plugin's `agent.subagents` channel (the same one the memory screen uses), and
   * the engine routes every `ctx.*` action to the context tree. The old lookup
   * (`window.__runtime.action` / `Engine.action`) matched nothing in this app, so
   * the switch only ever changed the panel, never the engine.
   */
  function ctxSend() {
    try {
      const kit = typeof nativeKit === 'function' ? nativeKit() : null;
      if (kit && kit.agent && typeof kit.agent.subagents === 'function') {
        return async (action, extra) => {
          const r = await kit.agent.subagents({ action, sessionKey: activeKey() || '', ...(extra || {}) });
          if (r && typeof r.resultJson === 'string') return parseMaybeJSON(r.resultJson, {});
          if (r && typeof r.json === 'string') return parseMaybeJSON(r.json, {});
          return parseMaybeJSON(r, {});
        };
      }
    } catch (e) { /* no native engine in this build */ }
    const rt = (typeof window !== 'undefined' && (window.__runtime || window.__agentRuntime)) || null;
    if (rt && typeof rt.action === 'function') return (a, p) => rt.action(a, p);
    return null;
  }

  const errText = (e) => String(e && e.message ? e.message : e || 'unknown error');
  function fail(what, e) {
    console.warn('context tree ' + what, e);
    lastError = { what, message: errText(e), at: Date.now() };
  }

  /** Read the switch and the tree for the open chat from the engine. */
  /** Read the request ledger again, at most every 600 ms (one turn can send many). */
  let reqTimer = null;
  function readRequests() {
    if (reqTimer) return;
    reqTimer = setTimeout(() => {
      reqTimer = null;
      const send = ctxSend();
      if (!send || !activeKey()) return;
      Promise.resolve(send('ctx.requests', {}))
        .then((r) => { if (r && Array.isArray(r.turns)) { state.requests = r; if (panel.open) paint(true); } })
        .catch(() => { /* an older engine without the ledger */ });
    }, 600);
  }
  /** The ledger row of turn `n` in the open chat, if requests were filed for it. */
  const turnReqs = (n) => (state.requests && Array.isArray(state.requests.turns) ? state.requests.turns.find((t) => Number(t.turn) === Number(n)) || null : null);

  function refresh() {
    // Same gate as the card itself: an engine that does not list "contextTree" has no
    // ctx.* actions, and asking anyway answered every load and chat switch with
    // "unknown action 'ctx.settings'" (and called an engine that has no sub-agents).
    // While the engine's feature list is still loading, wait for it rather than guess.
    try {
      if (typeof engine !== 'undefined' && engine && engine._loading && !(engine.info && engine.info.features && engine.info.features.length)) {
        return Promise.resolve(engine._loading).catch(() => null).then(() => (available() ? readNow() : null));
      }
    } catch (e) { /* no engine object in this build */ }
    if (!available()) return Promise.resolve(null);
    return readNow();
  }
  function readNow() {
    const send = ctxSend();
    if (!send) return Promise.resolve(null);
    const settingsP = Promise.resolve(send('ctx.settings', {}))
      .then((r) => {
        if (applySettings(r && r.settings)) { if (lastError && lastError.what === 'read') lastError = null; }
        paint();
      })
      .catch((e) => { fail('read', e); paint(); });
    // The tree belongs to one chat; with no chat open there is nothing to list.
    const treeP = !activeKey() ? Promise.resolve() : Promise.resolve(send('ctx.tree', {}))
      .then((p) => { if (p && typeof p === 'object' && (Array.isArray(p.items) || p.counts)) onEvent('context.tree', p); })
      .catch((e) => console.warn('context tree refresh', e));
    return Promise.all([settingsP, treeP]);
  }

  /** The checklist is always on: there is no switch. Kept for older callers;
   * it only reads the settings again and always answers enabled. */
  function setEnabled() {
    settings = { enabled: true, thresholdPercent: settings ? settings.thresholdPercent : null };
    paint();
    refresh();
    return Promise.resolve({ enabled: true });
  }

  /** One checklist action on a memory row (`mem/<ID>`): include, exclude,
   * auto, all_versions, latest, inactive, active, remove. It applies to the
   * next request; the panel reads the tree again afterwards. */
  function setMemory(rid, action, key) {
    const send = ctxSend();
    if (!send || !rid || !action) return Promise.resolve(false);
    // Another chat's row (a range summary of a chat that is not open) changes in that chat's own checklist.
    const other = !!key && key !== activeKey();
    pendingMem.set(rid, action);
    paint();
    return Promise.resolve(send('ctx.set', { ops: [{ id: `mem/${rid}`, action }], ...(other ? { sessionKey: key } : {}) }))
      .then((r) => {
        const rows = r && Array.isArray(r.memory) ? r.memory : [];
        const op = rows.find((o) => o && (o.rid === rid || o.id === `mem/${rid}`)) || rows[0];
        if (!r || r.ok === false || (op && op.ok === false)) {
          throw new Error((op && op.message) || (r && (r.error || r.text)) || 'The engine refused the change.');
        }
        if (lastError && lastError.what === 'set') lastError = null;
        return true;
      })
      .catch((e) => {
        lastError = { what: 'set', message: String((e && e.message) || e) };
        return false;
      })
      .finally(() => { pendingMem.delete(rid); paint(); refresh(); });
  }

  /** The engine's checklist row of one memory record (`S<from>-<to>` for a range
   * summary) in the open chat's memory, or null when the panel has not got it. */
  function memRecord(rid) {
    const m = state.memory;
    if (!m || !Array.isArray(m.groups)) return null;
    for (const g of m.groups) {
      for (const r of (Array.isArray(g.items) ? g.items : [])) if (r && r.rid === rid) return r;
    }
    return null;
  }
  /** Whether a range's summary goes with the next request, from the engine's own pick:
   * `out` (unticked) never, `in` always, `auto` when relevance sends it. The last
   * choice made here is used until the engine's answer comes back, and for a chat
   * whose memory is not loaded. */
  const segPicks = new Map(); // `${key}|S1-5` -> 'in' | 'out'
  function segIncluded(key, rid) {
    const pend = pendingMem.get(rid);
    if (pend === 'include') return { on: true, pend: true, auto: false };
    if (pend === 'exclude') return { on: false, pend: true, auto: false };
    if (pend === 'hide' || pend === 'delete') return { on: false, pend: true, auto: false };
    // Hidden, deleted and a change still on its way to the engine: the local choice wins.
    const sp = segPick(key, rid);
    if (sp === 'hidden' || sp === 'deleted' || sp === 'out') return { on: false, auto: false };
    if (sp === 'in') return { on: true, auto: false };
    const r = (!key || key === activeKey()) ? memRecord(rid) : null;
    if (r) {
      const pick = r.pick || 'auto';
      if (pick === 'out') return { on: false, auto: false };
      if (pick === 'in') return { on: true, auto: false };
      // Same reading as the memory checklist's own box: under auto, ticked when the engine sends it.
      return { on: r.colour === 'sent' || r.colour === 'pinned', auto: true };
    }
    const local = segPicks.get(`${key}|${rid}`);
    return { on: local !== 'out', auto: !local };
  }

  /** "Reset tree" (plan §15.4): start this chat's tree again. Every item, note,
   * summary, strategy and log row of the open chat goes; the settings stay and
   * the next request lists the transcript again. The person confirms first,
   * because notes the model wrote cannot be brought back. */
  function resetTree({ confirmed = false } = {}) {
    const send = ctxSend();
    if (!send) return Promise.resolve({ reset: false, error: 'no engine' });
    const ask = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm.bind(window) : null;
    if (!confirmed && ask && !ask('Reset the context tree of this chat? Its notes, summaries and strategy are deleted; the chat itself stays.')) {
      paint();
      return Promise.resolve({ reset: false, cancelled: true });
    }
    busy = 'reset';
    lastError = null;
    paint();
    return Promise.resolve(send('ctx.reset', {}))
      .then((res) => {
        busy = null;
        const ok = !!(res && res.reset);
        if (ok) {
          state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: state.model || '', memory: null, requests: null, checklists: { user: [], ai: [] } };
          lastReset = { at: Date.now(), removed: (res && res.removed) || {} };
        }
        paint();
        refresh();
        return { reset: ok, removed: (res && res.removed) || {} };
      })
      .catch((e) => {
        busy = null;
        fail('reset', e);
        paint();
        return { reset: false, error: errText(e) };
      });
  }

  function resetNote() {
    if (!lastReset || Date.now() - lastReset.at > 60000) return '';
    const r = lastReset.removed || {};
    return `<p class="ct-note ct-reset-done">The tree was reset: ${num(r.nodes || 0)} items and ${num(r.notes || 0)} notes removed.</p>`;
  }

  function stageNote() {
    const s = state.stage;
    if (!s || s === 'none') return '';
    const text = s === 'warn_soft' ? 'The window is getting full; nothing has been removed yet.'
      : s === 'compact' ? 'The least valuable items were taken out to stay inside the window.'
      : s === 'force' ? 'The window overflowed: even pinned items were taken out, and this is logged.'
      : s === 'starved' ? 'The window is too small for the locked rules and tools alone; only the rules and your message are sent.'
      : '';
    return text ? `<p class="ct-note ct-${esc(s)}">${esc(text)}</p>` : '';
  }

  /** Take an item out of the window or bring it back (the checklist). */
  function setItem(id, include, key) {
    const send = ctxSend();
    const other = !!key && key !== activeKey();
    const list = other ? ((convs.get(key) || {}).items || []) : state.items;
    const it = list.find((x) => x.id === id);
    if (!send || !it) return Promise.resolve(false);
    const pkey = pk(it);
    pendingSet.set(pkey, include ? 'in' : 'out');
    paint();
    // Another chat's item changes in that chat's own tree: it applies when that chat sends next.
    return Promise.resolve(send('ctx.set', { ops: [{ id, action: include ? 'include' : 'exclude' }], ...(other ? { sessionKey: key } : {}) }))
      .then((r) => {
        const op = r && Array.isArray(r.results) ? r.results.find((o) => o && o.id === id) : null;
        if (!r || r.ok === false || (op && op.ok === false)) {
          throw new Error((op && op.message) || (r && (r.error || r.text)) || 'The engine refused the change.');
        }
        it.state = (op && op.state) || (include ? 'in' : 'out');
        if (lastError && lastError.what === 'set') lastError = null;
        return true;
      })
      .catch((e) => {
        lastError = { what: 'set', message: String((e && e.message) || e) };
        return false;
      })
      .finally(() => { pendingSet.delete(pkey); paint(); if (other) loadConv(key, true); else refresh(); });
  }

  /* ---------- Activity: requests, policy, savings and window changes ----------
     What used to be the Log tab, read for people: no raw ids or JSON. */
  const ACTION_VERB = { include: 'Brought back', exclude: 'Left out', note_only: 'Kept as a note', pin: 'Pinned', unpin: 'Unpinned', move: 'Moved', tag: 'Tagged', evict: 'Left out' };
  const STAGE_REASON = { compact: 'the window was getting full', force: 'the window overflowed', warn_soft: 'the window was getting full', starved: 'the window was too small', quotas: 'routine clean-up of old storage' };
  /** A readable name for an item id, from the checklist when it is there. */
  function itemName(id) {
    const s = String(id || '');
    const it = state.items.find((x) => x && x.id === s);
    if (it && it.title && it.title !== s) return clip(it.title, 48);
    let m;
    if ((m = /^turn\/t?(\d+)\/call\/(\d+)/.exec(s))) return `Turn ${m[1]}, tool call ${m[2]}`;
    if ((m = /^turn\/t?(\d+)/.exec(s))) return `Turn ${m[1]}`;
    if ((m = /^sum\/(\d+)-(\d+)/.exec(s))) return `Summary of turns ${m[1]}\u2013${m[2]}`;
    const k = KIND_OF_PREFIX[s.split('/')[0]];
    const label = { sysPart: 'Rule', result: 'Tool result', summary: 'Summary', tempSummary: 'Temporary summary', note: 'Note', file: 'File', strategy: 'Strategy', subagent: 'Sub-agent', essential: 'Essential', category: 'Category' }[k];
    return label || 'Item';
  }
  /** What kind of thing an id is, for counts ("3 tool calls"). */
  function idKind(id) {
    const s = String(id || '');
    if (/^turn\/t?\d+\/call\//.test(s)) return 'tool call';
    if (/^turn\//.test(s)) return 'turn';
    const k = KIND_OF_PREFIX[s.split('/')[0]];
    return { result: 'result', summary: 'summary', tempSummary: 'summary', sysPart: 'rule', note: 'note', file: 'file' }[k] || 'item';
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  /** One log row in plain words: { who, what, why, before, after, at, n, names }. */
  function readLog(e) {
    const ops = parseMaybeJSON(e.ops, e.ops);
    let action = '', ids = [], extra = '';
    if (Array.isArray(ops)) {
      for (const o of ops) {
        if (typeof o === 'string') { ids.push(o); action = action || (e.actor === 'policy' ? 'evict' : ''); }
        else if (o && typeof o === 'object') { ids.push(o.id); action = action || o.action || ''; if (o.ok === false) extra = 'some were refused'; }
      }
    } else if (ops && typeof ops === 'object') {
      if (Array.isArray(ops.ids)) ids = ops.ids;
      if (ops.op === 'forget_turns') { action = 'forget'; extra = typeof ops.keptTurns === 'number' ? `kept the first ${plural(ops.keptTurns, 'turn')}` : ''; }
      else if (ops.op === 'gc') { action = 'gc'; const n = (ops.nodesTrimmed || 0) + (ops.notesTrimmed || 0) + (ops.tempTrimmed || 0); extra = n ? `${plural(n, 'old entry')} removed`.replace('entrys', 'entries') : 'nothing to remove'; }
    }
    ids = ids.filter((x) => x != null).map(String);
    const counts = {};
    for (const id of ids) { const k = idKind(id); counts[k] = (counts[k] || 0) + 1; }
    const countText = Object.entries(counts).map(([k, n]) => plural(n, k)).join(', ');
    const verb = action === 'forget' ? 'Rewound the chat' : action === 'gc' ? 'Cleaned up storage' : ACTION_VERB[action] || (ids.length ? 'Changed' : 'Updated the window');
    const what = action === 'forget' ? (ids.length ? `${verb}: ${countText} removed` : verb) : action === 'gc' ? verb : `${verb}${countText ? ' ' + countText : ''}`;
    const reasonRaw = e.reason ? String(e.reason) : '';
    const why = REASON_LABEL[reasonRaw] || STAGE_REASON[reasonRaw] || reasonRaw.replace(/_/g, ' ');
    const before = typeof e.tokensBefore === 'number' ? e.tokensBefore : null;
    const after = typeof e.tokensAfter === 'number' ? e.tokensAfter : null;
    return { who: ACTOR_LABEL[e.actor] || (e.actor ? String(e.actor) : 'Engine'), actor: e.actor || 'engine', what, why, extra, before, after, at: Number(e.at) || 0, names: ids.slice(0, 3).map(itemName), more: Math.max(0, ids.length - 3), key: `${e.actor}|${verb}|${reasonRaw}` };
  }
  /** Window changes, newest first, with repeats of the same change folded into one row. */
  function windowChanges() {
    const rows = [];
    for (const e of state.log.slice(0, 40)) {
      const r = readLog(e);
      const last = rows[rows.length - 1];
      if (last && last.key === r.key && !r.names.length && !last.names.length) { last.n += 1; last.after = last.after ?? r.after; last.before = r.before ?? last.before; continue; }
      rows.push({ ...r, n: 1 });
    }
    return rows;
  }
  const agoText = (ms) => {
    if (!ms) return '';
    const t = ms < 1e12 ? ms * 1000 : ms;
    const d = Math.max(0, Date.now() - t);
    if (d < 45000) return 'just now';
    if (d < 3600000) return `${Math.round(d / 60000)} min ago`;
    if (d < 86400000) return `${Math.round(d / 3600000)} h ago`;
    return new Date(t).toLocaleDateString();
  };
  const savedPct = (sent, full) => (typeof sent === 'number' && typeof full === 'number' && full > 0 ? Math.max(0, Math.round((1 - sent / full) * 100)) : null);
  const msText = (n) => (typeof n !== 'number' ? '' : n >= 10000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
  const policySummary = () => { const cp = policyApi(); try { return cp && cp.available() && cp.summary ? cp.summary() : null; } catch (e) { return null; } };

  /** The selection summary beside the checklist: what is ticked in, out, kept as a note or summarised. */
  function selectionSummary() {
    const items = state.items.filter((it) => it && groupOf(it));
    if (!items.length) return '';
    const n = { in: 0, out: 0, note: 0, temp: 0 };
    let leftTokens = 0, locked = 0;
    for (const it of items) {
      const st = stateOf(it);
      n[st in n ? st : 'out'] += 1;
      if (st === 'out' || st === 'temp') leftTokens += Number(it.tokens) || 0;
      if (it.pin === 'locked' || it.pin === 'policy') locked += 1;
    }
    const chipH = (cls, glyph, count, label) => (count ? `<li class="cc-sel-chip cc-sel-${cls}"><span class="cc-sel-glyph" aria-hidden="true">${glyph}</span><b>${esc(num(count))}</b> ${esc(label)}</li>` : '');
    const total = items.length;
    const pctIn = Math.round(((n.in + n.note) / total) * 100);
    return `<section class="cc-sel" data-slot="selection-summary" aria-label="Selection summary">
      <div class="cc-sel-ring" style="--p:${pctIn}" role="img" aria-label="${pctIn}% of items sent"><span>${pctIn}%</span></div>
      <div class="cc-sel-body">
        <p class="cc-sel-title">${esc(num(n.in + n.note))} of ${esc(num(total))} items go with the next request</p>
        <ul class="cc-sel-chips">${chipH('in', '\u25cf', n.in, 'in')}${chipH('note', '\u25d0', n.note, 'as notes')}${chipH('temp', '\u2726', n.temp, 'summarised')}${chipH('out', '\u25cb', n.out, 'left out')}${chipH('lock', '\u26bf', locked, 'locked')}</ul>
        ${leftTokens ? `<p class="cc-sel-note">Leaving out about <b>${esc(short(leftTokens))}</b> tokens of this chat.</p>` : ''}
      </div>
    </section>`;
  }

  /** One small line beside the selection: "6 of 9 sent · 9.2k tokens left out". The full breakdown is in Activity. */
  function selectionLine() {
    const items = state.items.filter((it) => it && groupOf(it));
    if (!items.length) return '';
    let sent = 0, left = 0;
    for (const it of items) {
      const st = stateOf(it);
      if (st === 'in' || st === 'note') sent += 1;
      if (st === 'out' || st === 'temp') left += Number(it.tokens) || 0;
    }
    return `<p class="cc-sel-line" data-slot="selection-line">${esc(num(sent))} of ${esc(num(items.length))} sent${left ? ` \u00b7 ${esc(short(left))} tokens left out` : ''}<button class="cc-link" type="button" data-tab-go="activity">Activity</button></p>`;
  }

  /** The requests in the order they were sent, each with its number in that order:
   * the engine's step number when it gives one, else its place (#1, #2, ...). The
   * engine's events carry `seq`, not `step`, so reading `step` alone gave #0. */
  function reqOrder(steps) {
    const key = (e) => (typeof e.seq === 'number' ? e.seq : typeof e.at === 'number' ? e.at : null);
    const list = steps.map((e, i) => ({ e, i }));
    list.sort((a, b) => { const x = key(a.e); const y = key(b.e); return x != null && y != null && x !== y ? x - y : a.i - b.i; });
    return list.map(({ e }, i) => ({ e, n: Number(e.step) > 0 ? Number(e.step) : i + 1 }));
  }

  /** Turns against real requests, from the engine's request ledger: per turn how many
   * requests were really sent, tokens full / sent / saved, and the chat's totals. */
  function requestsBlock() {
    const L = state.requests;
    const t = L && L.total;
    if (!t || !t.requests) return '';
    const pct = (v) => `\u2212${Math.round(v)}%`;
    const stat = (k, title, v, sub, cls = '') => `<li class="cc-rq-stat ${cls}" title="${esc(title)}">${svgI(k, 13)}<b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</li>`;
    const head = `<ul class="cc-rq-strip" aria-label="Chat totals">
      ${stat('chat', `${plural(t.turns, 'turn')} (messages you sent)`, esc(num(t.turns)))}
      ${stat('bolt', `${plural(t.requests, 'real request')} \u00b7 ${t.requestsPerTurn} per turn`, esc(num(t.requests)))}
      ${stat('up', `${num(t.sentTokens)} tokens sent of ${num(t.fullTokens)} full`, esc(short(t.sentTokens)), `/${esc(short(t.fullTokens))}`)}
      ${stat('down', `${t.savedPct}% saved \u00b7 ${num(t.savedTokens)} tokens`, esc(`${t.savedPct}%`), '', 'cc-rq-hero')}
    </ul>`;
    const extra = [
      t.inputTokens || t.outputTokens ? mi('io', `Provider: ${num(t.inputTokens)} input / ${num(t.outputTokens)} output tokens`, `${short(t.inputTokens)}/${short(t.outputTokens)}`) : '',
      t.summaryRequests ? mi('sum', `${t.summaryRequests} summarizer request${t.summaryRequests === 1 ? '' : 's'}`, t.summaryRequests, 'cc-mi-summ') : '',
      t.overflowRetries ? mi('retry', `${t.overflowRetries} retr${t.overflowRetries === 1 ? 'y' : 'ies'} after the window overflowed`, t.overflowRetries, 'cc-mi-bad') : '',
    ].filter(Boolean).join('');
    const turnRow = (r) => {
      const key = 'rq/' + r.turn;
      const open = !!(panel.detailsOpen && panel.detailsOpen[key]);
      const reqs = (r.list || []).map((q) => {
        const what = q.kind === 'summary' ? mi('sum', 'Summarizer request', null, 'cc-mi-summ')
          : q.status === 'overflow' ? mi('retry', `Step ${q.step}: retry after the window overflowed`, q.step, 'cc-mi-bad')
          : `<span class="cc-rq-step" title="Step ${esc(String(q.step))}">${esc(String(q.step))}</span>`;
        const tok = q.fullTokens == null ? `${short(q.sentTokens)}` : `${short(q.sentTokens)}<small>/${short(q.fullTokens)}</small>`;
        const sv = q.kind === 'summary' ? '<span class="cc-rq-save" title="Extra cost of the summary">+</span>' : q.savedPct > 0 ? `<span class="cc-rq-save cc-act-pos" title="Saved against full">${esc(pct(q.savedPct))}</span>` : '<span class="cc-rq-save" title="Sent in full">\u2014</span>';
        return `<li class="cc-rq-req${q.status === 'overflow' ? ' cc-rq-bad' : ''}"><span class="cc-rq-n" title="Request ${esc(num(q.n))}">${esc(num(q.n))}</span><span class="cc-rq-what">${what}${q.policy ? ` <small>${esc(q.policy)}</small>` : ''}</span><span class="cc-rq-tok" title="Tokens sent / full">${tok}</span>${sv}<span class="cc-rq-io" title="Provider input / output tokens">${q.inputTokens ? esc(short(q.inputTokens)) + '/' + esc(short(q.outputTokens)) : '\u2014'}</span><span class="cc-rq-ms" title="Response time">${esc(msText(q.latencyMs))}</span></li>`;
      }).join('');
      return `<li class="cc-rq-turn"><details data-key="${esc(key)}"${open ? ' open' : ''}><summary><span class="cc-num">${esc(String(r.turn))}</span><span class="cc-rq-prompt" title="${esc(r.prompt || `Turn ${r.turn}`)}">${esc(clip(r.prompt || `Turn ${r.turn}`, 200))}</span>${mi('bolt', `${plural(r.requests, 'request')} for this turn`, num(r.requests), 'cc-mi-req')}<span class="cc-rq-tok" title="${esc(`${num(r.sentTokens)} sent of ${num(r.fullTokens)} full`)}">${esc(short(r.sentTokens))}<small>/${esc(short(r.fullTokens))}</small></span><span class="cc-rq-save${r.savedPct > 0 ? ' cc-act-pos' : ''}" title="${esc(`Saved ${num(r.savedTokens)} tokens`)}">${r.savedPct > 0 ? esc(pct(r.savedPct)) : '\u2014'}</span></summary>
        <p class="cc-rq-meta">${esc([plural(r.steps, 'step'), r.summaryRequests ? plural(r.summaryRequests, 'summary').replace('summarys', 'summaries') : '', r.overflowRetries ? plural(r.overflowRetries, 'retry').replace('retrys', 'retries') : '', `saved ${num(r.savedTokens)} tokens`, (r.models || []).join(', '), msText(r.latencyMs)].filter(Boolean).join(' \u00b7 '))}</p>
        <ol class="cc-rq-reqs">${reqs}</ol></details></li>`;
    };
    const turns = L.turns || [];
    const openT = !!(panel.detailsOpen && panel.detailsOpen.rqturns);
    return `<section class="cc-act cc-rq" data-slot="requests" aria-label="Turns and real requests"><h4 class="cc-act-h">${svgI('bolt', 13)} Requests ${infoBtn('requests')}</h4>${tip('requests')}${head}${extra ? `<p class="cc-rq-extra">${extra}</p>` : ''}
      <details class="cc-act-more" data-key="rqturns"${openT ? ' open' : ''}><summary>${svgI('chat', 12)} <span class="cc-act-count">${esc(num(turns.length))}</span></summary><ul class="cc-rq-turns">${turns.map(turnRow).join('')}</ul></details></section>`;
  }

  /** Requests, the policy used and what it saved, then the window changes: the Activity tab. */
  function activityBlock() {
    const ps = policySummary();
    const mt = ps && ps.metrics && ps.metrics.total;
    const steps = (ps && ps.steps) || [];
    const parts = [];
    // 1. The totals of this chat, from the engine's own measurements.
    if (ps) {
      const reqs = mt && typeof mt.requests === 'number' ? mt.requests : steps.length;
      const sent = mt ? mt.inputTokens : steps.reduce((a, e) => a + (e.inputTokens || 0), 0);
      const full = mt ? mt.t7Tokens : steps.reduce((a, e) => a + (e.t7Tokens || 0), 0);
      const pct = savedPct(sent, full);
      const live = ps.live;
      const current = (live && live.policy) || (ps.pin) || (ps.task && ps.task.policy) || (ps.mode === 'off' ? 'T7' : null);
      const name = current ? ((ps.registry || []).find((r) => r.id === current) || {}).name : '';
      const tile = (k, v, sub, cls = '') => `<div class="cc-act-tile ${cls}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
      parts.push(`<dl class="cc-act-tiles">
        ${tile('Requests sent', num(reqs), mt && mt.tasks ? plural(mt.tasks, 'turn') : 'in this chat')}
        ${tile('Policy', current || '\u2014', name ? String(name).replace(/_/g, ' ') : ps.mode === 'off' ? 'policies off' : ps.mode ? `${ps.mode} mode` : '')}
        ${tile('Saved', pct == null ? '\u2014' : `${pct}%`, full ? `${short(Math.max(0, full - sent))} of ${short(full)} tokens` : 'nothing measured yet', 'cc-act-hero')}
        ${tile('Avg latency', mt && typeof mt.avgLatencyMs === 'number' ? msText(mt.avgLatencyMs) : '\u2014', mt && mt.fallbacks ? plural(mt.fallbacks, 'fallback') : 'no fallbacks')}
      </dl>`);
      if (ps.check) parts.push(`<p class="cc-act-check cc-act-check-${esc(ps.check.kind)}" role="status">${esc(ps.check.text)}</p>`);
      const byP = Object.entries((ps.metrics && ps.metrics.byPolicy) || {}).filter(([, v]) => v && v.requests).sort((x, y) => y[1].requests - x[1].requests);
      if (byP.length) {
        parts.push(`<ul class="cc-act-bars" aria-label="Requests by policy">${byP.map(([id, v]) => {
          const pc = savedPct(v.inputTokens, v.t7Tokens) || 0;
          return `<li><span class="cc-act-bar-id">${esc(id)}</span><span class="cc-act-track"><span style="width:${Math.max(2, pc)}%"></span></span><span class="cc-act-bar-num">${esc(plural(v.requests, 'req'))} \u00b7 ${pc}% saved</span></li>`;
        }).join('')}</ul>`);
      }
      // 2. Each request of the current or last turn.
      if (steps.length) {
        const open = !!(panel.detailsOpen && panel.detailsOpen.requests);
        parts.push(`<details class="cc-act-more" data-key="requests"${open ? ' open' : ''}><summary>Requests of the last turn <span class="cc-act-count">${esc(num(steps.length))}</span></summary>
          <ol class="cc-act-reqs">${reqOrder(steps).slice(-30).reverse().map(({ e, n }) => {
            const pc = savedPct(e.inputTokens, e.t7Tokens);
            return `<li class="cc-act-req"><span class="cc-act-req-step">#${esc(num(n))}</span><span class="cc-act-req-pol">${esc(e.policy || 'T7')}</span><span class="cc-act-req-tok">${esc(short(e.inputTokens))} <small>of ${esc(short(e.t7Tokens))}</small></span><span class="cc-act-req-save${pc ? ' cc-act-pos' : ''}">${pc ? `\u2212${pc}%` : 'full'}</span><span class="cc-act-req-ms">${esc(msText(e.latencyMs))}</span></li>`;
          }).join('')}</ol></details>`);
      }
    }
    // 3. What changed in the window (the old Log), in words.
    const changes = windowChanges();
    const openC = !!(panel.detailsOpen && panel.detailsOpen.changes);
    const changeRows = changes.slice(0, 15).map((r) => {
      const delta = r.before != null && r.after != null && r.before !== r.after ? r.after - r.before : null;
      const names = r.names.length ? `<span class="cc-chg-names">${r.names.map((x) => `<span>${esc(x)}</span>`).join('')}${r.more ? `<span>+${esc(num(r.more))} more</span>` : ''}</span>` : '';
      return `<li class="cc-chg cc-chg-${esc(r.actor)}"><span class="cc-chg-who">${esc(r.who)}</span><div class="cc-chg-main"><p class="cc-chg-what">${esc(r.what)}${r.n > 1 ? ` <span class="cc-chg-times">\u00d7${r.n}</span>` : ''}</p>${names}<p class="cc-chg-why">${[r.why ? `Because ${r.why}` : "", r.extra, delta != null ? `${short(r.before)} \u2192 ${short(r.after)} tokens` : "", agoText(r.at)].filter(Boolean).map(esc).join(' \u00b7 ')}</p></div>${delta != null ? `<span class="cc-chg-delta${delta < 0 ? ' cc-act-pos' : ''}">${delta < 0 ? '\u2212' : '+'}${esc(short(Math.abs(delta)))}</span>` : ''}</li>`;
    }).join('');
    parts.push(`<details class="cc-act-more" data-key="changes"${openC ? ' open' : ''}><summary>Window changes <span class="cc-act-count">${esc(num(state.log.length))}</span></summary><p class="cc-act-cap">${esc(INFO.log)}</p>
      ${changeRows ? `<ul class="cc-chg-list">${changeRows}</ul>` : '<p class="ct-empty">Nothing has been taken out of the window yet.</p>'}</details>`);
    return `<section class="cc-act" data-slot="activity" aria-label="Requests and savings"><h4 class="cc-act-h">Requests &amp; savings</h4>${parts.join('')}</section>`;
  }

  const ERROR_LEAD = {
    read: 'Could not read the context window settings from the engine.',
    on: 'Could not turn the context window on.',
    off: 'Could not turn the context window off.',
    reset: 'Could not reset the tree.',
    set: 'Could not change that item.',
  };
  /** The last failure, in words, with a retry. role="alert" so a screen reader hears it. */
  function errorNote() {
    if (!lastError) return '';
    const retry = lastError.what === 'reset' ? 'ct-reset-btn' : 'ct-retry';
    if (lastError.what === 'set') {
      return `<div class="ct-error" role="alert"><p><strong>${esc(ERROR_LEAD.set)}</strong>
      <span class="ct-error-msg">${esc(lastError.message)}</span></p>
      <button class="ct-retry ct-error-retry" type="button">Dismiss</button></div>`;
    }
    return `<div class="ct-error" role="alert"><p><strong>${esc(ERROR_LEAD[lastError.what] || 'Something went wrong.')}</strong>
      <span class="ct-error-msg">${esc(lastError.message)}</span></p>
      <button class="${retry} ct-error-retry" type="button"${busy ? ' disabled' : ''}>Try again</button></div>`;
  }
  const busyAttr = (kind) => (busy ? ` disabled aria-busy="${busy === kind}"` : '');

  /* ---------- the context card ----------
     One small card above the composer, with tabs: Checklist (just the tree,
     with the token use by kind and a one-line selection summary on top),
     Summary (always sent), Activity (the selection breakdown, requests,
     policy, savings and window changes), Settings and Policy.
     It replaces the old context sheet, the Chat memory screen and the
     Sections sheet, which showed the same things in three places. */
  // Activity sits where the old Log tab was: requests, savings and window changes.
  const BASE_TABS = [['items', 'Checklist'], ['summary', 'Summary'], ['activity', 'Activity'], ['settings', 'Settings'], ['policy', 'Policy']];
  // The Policy tab only with the engine's `contextPolicy` feature.
  const policyApi = () => (typeof window !== 'undefined' && window.__contextPolicies) || null;
  const policyOn = () => { try { const p = policyApi(); return !!(p && p.available()); } catch (e) { return false; } };
  const tabList = () => BASE_TABS.filter(([id]) => id !== 'policy' || policyOn());
  const INFO = {
    mycl: 'Checklists you make. + makes one (a title, an optional token cap); Select rows, then the list icon, files them in one. Untick a list to leave all its items out; a cap sends its items in order until it is full. Deleting a list puts its items back where they were.',
    aicl: 'Categories and task picks the model made with ctx. Untick one to leave its items out (a task pick off means the task runs with full context). Tap the spark to see why the model made it.',
    meter: 'Tokens the next request carries, by kind, against the model\u2019s window. Below, tick an item to include it and untick to leave it out; nothing is deleted. \u25cf in \u00b7 \u25cb out \u00b7 \u25d0 note only \u00b7 \u2726 replaced by a summary \u00b7 \u26bf locked.',
    turn: 'Every stored chat, newest first. Open one to see its turns, each tool call with its result, and its range summaries; tick a box to keep an item in that chat\'s context or leave it out. The arrow opens the chat or jumps to the turn. On a row: \u26a1 real requests, the wrench tool calls, \u03a3 and a violet bar a summarized turn, a struck-through title a left-out item; the number on the right is the tokens it sends. Long titles scroll sideways.',
    call: 'One tool call with its result. It can be left out on its own; the rest of the turn stays.',
    result: 'A large tool result kept in storage. Left out, the model sees only its id and can read it back.',
    segment: 'A summary of exactly these turns, written once and never changed. R = its own range version. \u0394 = what it changed against earlier ranges. The box in front says whether this summary goes at all: untick it to leave the range\u2019s summary out of the next requests, tick it to always send it. Sum sends the summary (default), Raw sends the original turns instead, Both sends both. Open it to send single original turns.',
    ranges: 'Every range summary with its own version (R1, R2\u2026), the memory version it was built on, and what it changed against the earlier ranges.',
    data: 'Everything this chat\u2019s memory stores, as saved.',
    tempSummary: 'A summary made on request: it stands in for the turns in its tag, which stay stored. The person icon means you made it, the spark that the agent did, the target shows its focus. Untick it to leave it out of the next request.',
    requests: 'One message you send is one turn (\u25a2), but answering it can take many real requests to the model (\u26a1): one per tool step, a retry when the window overflowed (\u21bb); a turn shows \u26a1 only when it took more than one, and the summarizer\u2019s own requests (\u03a3). \u2191 is what was really sent, after the checklist, memory and policy, out of the full chat; \u2193 is what was saved. Tap a turn for its requests: number, step, sent/full, saved, provider in/out and response time.',
    rolling: 'The summary that stands in for the turns before it when the window had to be compacted.',
    summary: 'The chat\u2019s running summary: goals, decisions, facts, files, tasks and ranges. Only the parts that fit the request are sent; each part is a row under Chat memory in the Checklist, coloured by whether it was sent, left out or is waiting behind \u201cshow more\u201d.',
    log: 'Every change to what the requests carry: who made it (you, the model or the engine), why, and how many tokens it saved.',
    tree: 'Always on. Lists everything the model can be given, by group, and lets you and the model put items in or take them out. The chat memory is part of it, so there is no separate memory tool.',
    memory: 'The chat memory as groups: goals, goal history, topics & titles, decisions, replaced decisions, facts, preferences, files, tasks, ranges, old ranges and versions. Every row keeps all its versions. Colours: sent \u00b7 left out (matched but cut, or taken out) \u00b7 show more (stored, not needed now) \u00b7 tag inactive \u00b7 earlier version sent. Tick to always send, untick to never send, \u21ba to give it back to relevance. Name a row in the chat as #ID (#D12, #plan.md, #D12@v1): only the last mention of a tag counts.',
    reset: 'Deletes this chat\u2019s tree, notes and strategy. The chat itself stays.',
  };
  // Colour groups, in the order they are listed and drawn in the bar.
  const GROUPS = [
    ['rules', 'Rules'],
    ['memory', 'Memory'],
    ['summary', 'Summaries'],
    ['turns', 'Turns'],
    ['calls', 'Tool calls'],
    ['results', 'Results'],
  ];
  const KIND_OF_PREFIX = { sys: 'sysPart', ess: 'essential', sum: 'summary', res: 'result', file: 'file', tmp: 'tempSummary', note: 'note', strat: 'strategy', sub: 'subagent', cat: 'category' };
  function kindOf(it) {
    if (it && typeof it.kind === 'string' && it.kind) return it.kind;
    const id = String((it && it.id) || '');
    if (/^turn\/t?\d+\/call\/\d+/.test(id)) return 'turnPart';
    if (/^turn\//.test(id)) return 'turn';
    return KIND_OF_PREFIX[id.split('/')[0]] || 'other';
  }
  function groupOf(it) {
    const k = kindOf(it);
    if (k === 'sysPart' || k === 'strategy' || k === 'system') return 'rules';
    if (k === 'summary' || k === 'tempSummary') return 'summary';
    if (k === 'turn') return 'turns';
    if (k === 'turnPart') return 'calls';
    if (k === 'result') return 'results';
    if (k === 'category') return null;
    return 'memory';
  }
  const turnOf = (it) => {
    if (typeof it.turn === 'number') return it.turn;
    const m = /^turn\/t?(\d+)/.exec(String(it.id || ''));
    return m ? Number(m[1]) : null;
  };
  const callOf = (it) => {
    if (typeof it.callIndex === 'number') return it.callIndex;
    const m = /\/call\/(\d+)/.exec(String(it.id || ''));
    return m ? Number(m[1]) : null;
  };
  const rangeOf = (id) => {
    const m = /^sum\/(\d+)-(\d+)$/.exec(String(id || ''));
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const noteCost = (it) => (typeof it.tokensNote === 'number' ? it.tokensNote : Math.round((it.tokens || 0) / 10));
  const pk = (it) => `${(it && it._key) || ''}|${it && it.id}`;
  const stateOf = (it) => (pendingSet.has(pk(it)) ? pendingSet.get(pk(it)) : (it.state || 'out'));
  const sentOf = (it) => { const st = stateOf(it); return st === 'in' ? (it.tokens || 0) : st === 'note' ? noteCost(it) : 0; };
  const switchable = (it) => it.pin !== 'locked' && it.pin !== 'policy' && it.kind !== 'system' && !String(it.id || '').startsWith('sys/');
  const cssId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const clip = (t, n) => { const v = String(t == null ? '' : t); return v.length > n ? v.slice(0, n) + '\u2026' : v; };
  const asText = (v) => { if (v == null) return ''; if (typeof v === 'string') return v; try { return JSON.stringify(v, null, 1); } catch (e) { return String(v); } };
  const when = (ms) => { const n = Number(ms); if (!n) return ''; const d = new Date(n < 1e12 ? n * 1000 : n); return isNaN(d) ? '' : d.toLocaleString(); };

  /** The open chat's messages as turns: the user's text and the tool calls of
   * the answer, in order. Used for titles, results and "go to". */
  function threadTurns(list) {
    let msgs = [];
    if (Array.isArray(list)) msgs = list;
    else try { msgs = (appRef && appRef.chat && appRef.chat.main && appRef.chat.main.messages) || []; } catch (e) { msgs = []; }
    const out = [];
    // Same rule as the engine's turns: a message that arrives while the turn
    // is still open (right after another message, or while the answer is
    // still calling tools) joins that turn instead of opening a new one.
    let open = false;
    for (const m of msgs) {
      if (!m) continue;
      const parts = Array.isArray(m.content) ? m.content : [];
      if (m.role === 'user') {
        const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ') || (typeof m.content === 'string' ? m.content : '');
        if (!text.trim() && parts.length && parts.every((p) => p && /tool[-_]?result/.test(p.type || ''))) continue;
        if (!(open && out.length)) out.push({ text: text.replace(/\s+/g, ' ').trim(), calls: [], index: out.length });
        open = true;
      } else if (m.role === 'assistant' && out.length) {
        for (const p of parts) if (p && p.type === 'tool-call') out[out.length - 1].calls.push(p);
        const last = parts.filter((p) => p && p.type !== 'reasoning').pop();
        open = !!(last && last.type === 'tool-call');
      }
    }
    return out;
  }
  /** The thread turn for engine turn `n`, checked against the title when there is one. */
  function threadTurn(turns, n, title) {
    const t = turns[n - 1];
    const probe = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 24).toLowerCase();
    if (!probe || probe === '(empty turn)') return t || null;
    if (t && t.text.toLowerCase().startsWith(probe)) return t;
    return turns.find((x) => x.text.toLowerCase().startsWith(probe)) || t || null;
  }

  /** Scroll the chat to a turn and close the card. */
  function goToTurn(n, title, key) {
    if (key && key !== activeKey()) {
      // Another conversation: open it, then scroll once its messages are there.
      if (!openConversation(key)) return false;
      const t0 = Date.now();
      const tick = () => {
        if (activeKey() === key && threadTurns().length >= n && goToTurn(n, title)) return;
        if (Date.now() - t0 < 5000) setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
      return true;
    }
    const t = threadTurn(threadTurns(), n, title);
    const idx = t ? t.index : n - 1;
    const roots = Array.from(document.querySelectorAll('.aui-thread-viewport .aui-user-message-root, .aui-user-message-root'))
      .filter((el, i, all) => all.indexOf(el) === i && !el.closest('.ct-panel'));
    const el = roots[idx];
    if (!el) return false;
    close(false);
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    el.classList.add('cc-flash');
    setTimeout(() => el.classList.remove('cc-flash'), 1600);
    return true;
  }

  const memApi = () => (typeof window !== 'undefined' && window.__chatMemory) || null;
  /** The chat whose memory the Summary and Settings tabs show: the open chat,
   * or the sub-agent whose "Open full memory" opened the card. */
  const memKey = () => panel.memKey || activeKey();
  const memData = (key) => { const cm = memApi(); const k = key || memKey(); try { return (cm && k && cm.chats && cm.chats.get(k)) || null; } catch (e) { return null; } };

  const infoBtn = (key) => `<button class="cc-i" type="button" data-info="${esc(key)}" aria-label="About this" aria-expanded="${panel.tips.has(key)}">i</button>`;
  // A key may carry a suffix ("segment:3-7") so each row opens its own tip;
  // the text is the base key's.
  const tip = (key) => { const t = INFO[key] || INFO[String(key).split(':')[0]]; return panel.tips.has(key) && t ? `<p class="cc-tip" role="note">${esc(t)}</p>` : ''; };
  const twisty = (id, label) => {
    const open = panel.expanded.has(id);
    return `<button class="cc-tw" type="button" data-tw="${esc(id)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(label)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  };
  const noTwisty = '<span class="cc-tw cc-tw-none" aria-hidden="true"></span>';
  const GO_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /* Minimal row glyphs: colour and a small icon stand in for words; the words
   * live in the tooltip (title / aria-label), the (i) tip and the menu. */
  const MI = {
    bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    stack: '<path d="M4 6h16M4 11h16M4 16h10"/>',
    focus: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>',
    raw: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
    delta: '<path d="M12 4L3 20h18z"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16v.5"/>',
    retry: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>',
    sum: '<path d="M17 5H7l6 7-6 7h10"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    io: '<path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4"/>',
    always: '<path d="M12 3v13M7 11l5 5 5-5"/><path d="M5 21h14"/>',
    hide: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.4 6.4C4.3 7.8 2.7 10 2 12c1 2.5 5 7 10 7 1.6 0 3-.4 4.3-1"/>',
    eye: '<path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="3"/>',
    archive: '<path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    cap: '<path d="M5 20h14"/><path d="M7 16V9M12 16V5M17 16v-4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const svgI = (k, sz = 12) => `<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MI[k] || ''}</svg>`;
  /** A small glyph, optionally with a number beside it; `title` says it in words. */
  const mi = (k, title, n, cls = '') => `<span class="cc-mi cc-mi-${k}${cls ? ' ' + cls : ''}" role="img" title="${esc(title)}" aria-label="${esc(title)}">${svgI(k)}${n != null && n !== '' ? `<b>${esc(String(n))}</b>` : ''}</span>`;
  /** The glyph that says who made a summary. */
  const srcIco = (w) => (w.by === 'user' ? 'user' : w.by ? 'spark' : 'stack');
  /** The chat a "go to" button opens, when it is not the open one. */
  const goKey = () => (RK && RK !== activeKey() ? ` data-go-key="${esc(RK)}"` : '');

  /** The include switch of one engine item: a checkbox, or the state symbol when it is locked. */
  function control(it) {
    const st = stateOf(it);
    const label = `${STATE_LABEL[st] || st}${it.pin && it.pin !== 'none' ? ' \u00b7 pinned (' + it.pin + ')' : ''}`;
    if (!switchable(it)) return `<span class="ct-sym" title="${esc(label)}" aria-label="${esc(label)}">${it.pin === 'locked' || it.pin === 'policy' ? SYMBOL.locked : (SYMBOL[st] || '\u00b7')}</span>`;
    const checked = st === 'in' || st === 'note' || st === 'temp';
    const can = !busy && !pendingSet.has(pk(it));
    return `<input class="ct-check" type="checkbox" data-id="${esc(it.id || '')}"${it._key ? ` data-key="${esc(it._key)}"` : ''}${checked ? ' checked' : ''}${can ? '' : ' disabled'}${pendingSet.has(pk(it)) ? ' aria-busy="true"' : ''} aria-label="${esc((checked ? 'Leave out: ' : 'Include: ') + (it.title || it.id))}" title="${esc(label)}">`;
  }
  function costText(it) {
    const st = stateOf(it);
    return st === 'in' ? short(it.tokens) : st === 'note' ? short(noteCost(it)) : '\u2013';
  }

  /** The token use by colour group: the old "Token breakdown", now one bar. */
  function meter() {
    const by = {};
    let total = 0;
    for (const it of state.items) { const g = groupOf(it); if (!g) continue; const v = sentOf(it); by[g] = (by[g] || 0) + v; total += v; }
    const t = state.tokens || {};
    if (typeof t.sent === 'number' && t.sent > total) total = t.sent;
    const win = typeof t.window === 'number' && t.window ? t.window : (typeof t.selectable === 'number' && t.selectable ? t.selectable : null);
    const scale = win || total || 1;
    const segs = GROUPS.filter(([g]) => by[g]).map(([g, label]) => `<span class="cc-seg cc-g-${g}" style="width:${Math.max(0.6, Math.min(100, (by[g] / scale) * 100)).toFixed(2)}%" title="${esc(label)} ${esc(num(by[g]))}"></span>`).join('');
    const legend = GROUPS.filter(([g]) => by[g]).map(([g, label]) => `<li class="cc-g-${g}"><span class="cc-dot"></span>${esc(label)} <b>${esc(short(by[g]))}</b></li>`).join('');
    const c = state.counts || {};
    return `<div class="cc-meter" data-slot="context-meter">
      <div class="cc-meter-line"><span class="cc-meter-num">${esc(short(total))}${win ? ' / ' + esc(short(win)) : ''} tokens</span><span class="cc-meter-counts">${state.model ? esc(state.model) + ' \u00b7 ' : ''}${num(c.in)} in \u00b7 ${num(c.out)} out</span>${infoBtn('meter')}</div>
      ${tip('meter')}
      <div class="cc-bar" role="img" aria-label="${esc(short(total))} tokens${win ? ' of ' + esc(short(win)) : ''}">${segs}</div>
      ${legend ? `<ul class="cc-legend">${legend}</ul>` : ''}
      ${selectionLine()}
    </div>`;
  }

  /** One engine item as a leaf row. */
  function leafRow(it, extra = '') {
    const st = stateOf(it);
    const ra = !RK && switchable(it) && !extra && !/^(sys|ess)\//.test(it.id || '') ? rowAct({ kind: 'item', node: it.id, label: it.title || it.id }) : null;
    return `<div class="ct-item cc-row cc-g-${groupOf(it) || 'memory'} ct-state-${esc(st)}${kindOf(it) === 'summary' ? ' ct-kind-summary' : ''}${ra ? ' cc-actrow' : ''}" data-node="${esc(it.id)}"${ra ? ra.attrs : ''}>
      ${ra ? selDot(ra.on) : ''}${noTwisty}${control(it)}<span class="ct-title" title="${esc(it.title || it.id)}">${esc(it.title || it.id)}</span>${extra}<span class="ct-cost" title="${esc(STATE_LABEL[st] || st)}">${esc(costText(it))}</span></div>`;
  }

  /** A collapsible group of plain items (rules, memory, anything else). */
  function groupBlock(gid, label, items) {
    if (!items.length) return '';
    const id = NS + 'grp/' + gid;
    const open = panel.expanded.has(id);
    const sent = items.reduce((n, it) => n + sentOf(it), 0);
    const inCount = items.filter((it) => ['in', 'note', 'temp'].includes(stateOf(it))).length;
    return `<div class="cc-node cc-group cc-g-${gid}" data-group="${esc(gid)}">
      <div class="cc-row cc-head">${twisty(id, label)}<span class="cc-dot"></span><span class="ct-title cc-group-name">${esc(label)}</span><span class="ct-cost">${inCount}/${items.length} \u00b7 ${esc(short(sent))}</span></div>
      ${open ? `<div class="cc-kids">${items.map((it) => leafRow(it)).join('')}</div>` : ''}
    </div>`;
  }

  /** One tool call of a turn, with its result when it is open. */
  function callNode(n, k, node, part, turnOut) {
    const id = NS + `call/${n}/${k}`;
    const open = panel.expanded.has(id);
    const name = part ? part.toolName : (node && node.title ? String(node.title).split(' ')[0] : 'tool');
    const args = part ? (part.argsText || asText(part.args)) : (node && node.title ? String(node.title).slice(name.length).trim() : '');
    const st = node ? stateOf(node) : (turnOut ? 'out' : 'in');
    const err = part && part.isError;
    const body = open ? `<div class="cc-detail">
        ${args && args !== '{}' ? `<div class="cc-detail-k">Input</div><pre class="cc-pre">${esc(clip(args, 800))}</pre>` : ''}
        <div class="cc-detail-k">Result${err ? ' (error)' : ''}</div>
        <pre class="cc-pre${err ? ' cc-err' : ''}">${part && part.result != null ? esc(clip(asText(part.result), 2400)) : '\u2014'}</pre>
      </div>` : '';
    const ctl = node ? control(node) : `<span class="ct-sym" title="Follows its turn">${SYMBOL[st] || '\u00b7'}</span>`;
    return `<div class="cc-node cc-call ct-state-${esc(st)}" data-call="${esc(n + '/' + k)}">
      <div class="ct-item cc-row cc-g-calls" data-node="${esc(node ? node.id : `turn/t${n}/call/${k}`)}">${twisty(id, name)}${ctl}<span class="ct-title"><span class="cc-tool">${esc(name)}</span> <span class="cc-args">${esc(clip(args.replace(/\s+/g, ' '), 60))}</span></span><span class="cc-meta">${err ? mi('alert', 'Tool error', null, 'cc-mi-bad') : ''}</span><span class="ct-cost">${node ? esc(costText(node)) : ''}</span></div>
      ${body}
    </div>`;
  }

  /** One turn: the row, and under it its tool calls and stored results. */
  function turnNode(n, it, kids, results, tt, newest) {
    const nid = it ? it.id : `turn/t${n}`;
    const id = NS + nid;
    const open = panel.expanded.has(id);
    const title = (it && it.title) || (tt && tt.text) || `Turn ${n}`;
    const st = it ? stateOf(it) : 'in';
    const turnOut = st === 'out';
    const tkey = RK || activeKey();
    const thidden = hiddenTurns(tkey).has(Number(n));
    if (thidden && !act.showHidden) return '';
    const ra = rowAct({ kind: 'turn', key: tkey, n, node: nid, label: title });
    const tmark = thidden ? 'hidden' : st === 'temp' ? 'summarized' : turnOut ? 'out' : '';
    const calls = new Map();
    for (const c of kids) { const k = callOf(c); if (k != null) calls.set(k, { node: c, part: null }); }
    (tt ? tt.calls : []).forEach((p, i) => { const k = i + 1; const cur = calls.get(k) || { node: null, part: null }; cur.part = p; calls.set(k, cur); });
    const total = [it, ...kids, ...results].filter(Boolean).reduce((a, x) => a + sentOf(x), 0);
    const count = calls.size + results.length;
    // One turn, many requests: how many this turn really sent (open chat only).
    const tr = !RK ? turnReqs(n) : null;
    const reqBadge = tr && tr.requests > 1 ? mi('bolt', `${plural(tr.requests, 'request')} for this turn \u00b7 ${num(tr.sentTokens)} of ${num(tr.fullTokens)} tokens sent \u00b7 ${tr.savedPct}% saved`, num(tr.requests), 'cc-mi-req') : '';
    const markI = tmark === 'hidden' ? mi('hide', 'Hidden from the checklist') : '';
    const inner = open ? `<div class="cc-kids">${[...calls.keys()].sort((a, b) => a - b).map((k) => callNode(n, k, calls.get(k).node, calls.get(k).part, turnOut)).join('')}${results.map((r) => leafRow(r, `<button class="cc-go" type="button" data-open-result="${esc(String(r.id).replace(/^res\//, ''))}"${RK ? ` data-key="${esc(RK)}"` : ''} aria-label="Open result" title="Open result">${svgI('eye', 14)}</button>`)).join('')}${count ? '' : '<p class="cc-none">No tool calls</p>'}</div>` : '';
    return `<div class="cc-node cc-turn ct-state-${esc(st)}${tmark ? ' cc-m-' + tmark : ''}${ra.on ? ' cc-selected' : ''}" data-turn="${n}">
      <div class="ct-item cc-row cc-g-turns cc-actrow" data-node="${esc(nid)}"${ra.attrs}${act.select ? ' tabindex="0"' : ''}>${selDot(ra.on)}${twisty(id, 'turn ' + n)}${it ? control(it) : `<span class="ct-sym">${SYMBOL.in}</span>`}<span class="cc-num">${n}</span><span class="ct-title" title="${esc(title)}">${esc(clip(title, 240))}</span><span class="cc-meta">${markI}${count ? mi('tool', plural(count, 'tool call or result'), count) : ''}${reqBadge}${newest ? '<span class="cc-now" role="img" title="Latest turn" aria-label="Latest turn"><svg viewBox="0 0 8 8" width="7" height="7" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg></span>' : ''}</span><span class="ct-cost" title="${esc(tmark === 'summarized' ? 'Summarized: a summary stands in for this turn' : `${num(total)} tokens sent`)}">${esc(total ? short(total) : '\u2013')}</span><button class="cc-go" type="button" data-go-turn="${n}" data-go-title="${esc(clip(title, 40))}"${goKey()} aria-label="Go to turn ${n} in the chat">${GO_ICON}</button>${menuBtn('turn ' + n)}</div>
      ${inner}
    </div>`;
  }

  /* ---------- range summaries: per-range version, changes, raw vs summary ---------- */

  const RAW_MODES = [['summary', 'Sum', 'Send the summary (default)'], ['raw', 'Raw', 'Send the original turns instead of the summary'], ['both', 'Both', 'Send the summary and the original turns']];
  const CHANGE_VERB = { added: 'added', replaced: 'replaced', updated: 'reworded', done: 'done', retired: 'retired', superseded: 'superseded', more: '' };
  /** The raw-vs-summary choice of a chat: { selection, plan } from memory.get. */
  function rawOf(key) {
    const md = memData(key || RK || activeKey());
    const d = md && md.data;
    const sel = (d && d.rawSelection) || {};
    return { ranges: Array.isArray(sel.ranges) ? sel.ranges : [], turns: new Set((Array.isArray(sel.turns) ? sel.turns : []).map(Number)), plan: (d && d.rawPlan) || {} };
  }
  const modeOf = (raw, a, b) => { const r = raw.ranges.find((x) => Number(x.fromTurn) === a && Number(x.toTurn) === b); return (r && r.mode) || 'summary'; };
  const revOf = (seg, i) => Number(seg.rev) || i + 1;

  /** Set a range's mode or one turn's raw switch in the engine, then reread. */
  function setRaw(key, extra) {
    const send = ctxSend();
    if (!send || !key) return;
    panel.rawBusy = true; paint(true);
    Promise.resolve(send('memory.raw', { sessionKey: key, ...extra }))
      .then((r) => { if (r && (r.ok === false || r.error)) throw new Error(r.error || 'Could not change it.'); })
      .catch((e) => fail('raw', e))
      .then(() => { const cm = memApi(); return cm && cm.refresh ? cm.refresh(key) : null; })
      .catch(() => {})
      .finally(() => { panel.rawBusy = false; refresh(); paint(true); });
  }

  /** The original turns of a summarized range from the engine (transcript, or
   * the archive), with their tool calls and results: read once per range. */
  function loadOriginals(key, a, b) {
    const k = `${key}|${a}-${b}`;
    const o = (panel.originals ||= new Map());
    if (o.has(k)) return o.get(k);
    const entry = { loading: true, turns: new Map(), error: '' };
    o.set(k, entry);
    const send = ctxSend();
    if (!send) { entry.loading = false; entry.error = 'The engine is not ready.'; return entry; }
    Promise.resolve(send('memory.turns', { sessionKey: key, fromTurn: a, toTurn: b }))
      .then((r) => { for (const t of (r && Array.isArray(r.turns) ? r.turns : [])) entry.turns.set(Number(t.turn), t); entry.missing = (r && r.missing) || []; })
      .catch((e) => { entry.error = errText(e); })
      .finally(() => { entry.loading = false; paint(true); });
    return entry;
  }

  /** One structured change of a range against the earlier ranges. */
  function changeRow(c) {
    if (c.kind === 'more') return `<li class="cc-chg cc-chg-more">${esc(c.text)}</li>`;
    const from = c.priorRev ? `R${c.priorRev}` : (Array.isArray(c.priorRange) ? `t${c.priorRange[0]}\u2013${c.priorRange[1]}` : '');
    const verb = CHANGE_VERB[c.action] != null ? CHANGE_VERB[c.action] : c.action;
    const head = c.priorId && c.id !== c.priorId ? `${esc(c.id)} ${esc(verb)} ${esc(c.priorId)}` : `${esc(c.id || c.priorId)} ${esc(verb)}`;
    const was = c.priorText ? `<span class="cc-chg-was">${esc(clip(c.priorText, 120))}</span>` : '';
    const now = c.text && c.action !== 'retired' && c.action !== 'done' ? `<span class="cc-chg-now">${esc(clip(c.text, 120))}</span>` : '';
    return `<li class="cc-chg cc-chg-${esc(c.action)}" data-change="${esc(c.id || c.priorId)}"><span class="cc-chg-head"><span class="cc-chg-kind cc-k-${esc(c.kind)}">${esc(c.kind)}</span>${head}${from ? `<span class="cc-badge" title="Was set in this earlier range">from ${esc(from)}</span>` : ''}${c.turn ? `<span class="cc-when">t${esc(c.turn)}</span>` : ''}</span>${was}${was && now ? '<span class="cc-chg-arrow" aria-hidden="true">\u2192</span>' : ''}${now}${c.reason ? `<span class="cc-chg-why">${esc(clip(c.reason, 120))}</span>` : ''}</li>`;
  }
  const changesList = (seg) => (Array.isArray(seg.changes) && seg.changes.length ? `<ul class="cc-chgs" aria-label="Changes against earlier ranges">${seg.changes.map(changeRow).join('')}</ul>` : '');

  /** A summarized turn inside its range: a switch to send the original, and
   * its tool calls and results as a tree (from the chat, else the engine). */
  function coveredTurn(key, n, tt, orig, sendsRaw, byRange, a, b) {
    const id = NS + `orig/${n}`;
    const open = panel.expanded.has(id);
    const text = (tt && tt.text) || (orig && String(orig.text || '').split('\n').find((l) => l.trim() && !/^#|^turn \d+/i.test(l.trim()))) || `Turn ${n}`;
    const calls = tt && Array.isArray(tt.calls) && tt.calls.length ? tt.calls : (orig && Array.isArray(orig.calls) ? orig.calls : []);
    const disabled = panel.rawBusy || byRange || !key;
    const label = byRange ? 'Sent as written with its range' : sendsRaw ? 'Original sent beside the summary' : 'Send the original turn';
    const check = `<input class="cc-raw-check" type="checkbox" data-raw-turn="${n}" data-key="${esc(key || '')}"${sendsRaw ? ' checked' : ''}${disabled ? ' disabled' : ''} aria-label="${esc(label + ': turn ' + n)}" title="${esc(label)}">`;
    let inner = '';
    if (open) {
      const parts = calls.map((p, i) => {
        const cid = NS + `orig/${n}/${i + 1}`;
        const o = panel.expanded.has(cid);
        const name = p.toolName || p.name || 'tool';
        const args = p.argsText || asText(p.args != null ? p.args : p.input);
        const res = p.result != null ? asText(p.result) : '';
        const err = p.isError;
        return `<div class="cc-node cc-call" data-orig-call="${n}/${i + 1}"><div class="cc-row cc-g-calls">${twisty(cid, name)}<span class="ct-sym" title="Follows its turn">${sendsRaw ? SYMBOL.in : SYMBOL.temp}</span><span class="ct-title"><span class="cc-tool">${esc(name)}</span> <span class="cc-args">${esc(clip(String(args || '').replace(/\s+/g, ' '), 60))}</span></span><span class="cc-meta">${err ? mi('alert', 'Tool error', null, 'cc-mi-bad') : ''}</span></div>
          ${o ? `<div class="cc-detail">${args && args !== '{}' ? `<div class="cc-detail-k">Input</div><pre class="cc-pre">${esc(clip(args, 800))}</pre>` : ''}<div class="cc-detail-k">Result${err ? ' (error)' : ''}</div><pre class="cc-pre${err ? ' cc-err' : ''}">${res ? esc(clip(res, 2400)) : '\u2014'}</pre></div>` : ''}</div>`;
      }).join('');
      const raw = !calls.length && orig && orig.text ? `<pre class="cc-pre">${esc(clip(orig.text, 2400))}</pre>` : '';
      inner = `<div class="cc-kids">${parts || raw || '<p class="cc-none">No tool calls</p>'}</div>`;
    }
    return `<div class="cc-node cc-covered${sendsRaw ? ' cc-raw-on' : ''}" data-covered="${n}">
      <div class="cc-row cc-g-turns">${twisty(id, 'original turn ' + n)}${check}<span class="cc-num">${n}</span><span class="ct-title" title="${esc(text)}">${esc(clip(text, 240))}</span><span class="cc-meta">${calls.length ? mi('tool', plural(calls.length, 'tool call'), calls.length) : ''}${sendsRaw ? mi('raw', 'The original goes to the model', null, 'cc-mi-raw') : ''}</span><button class="cc-go" type="button" data-go-turn="${n}" data-go-title="${esc(clip(text, 40))}"${goKey()} aria-label="Go to turn ${n} in the chat">${GO_ICON}</button></div>
      ${inner}
    </div>`;
  }

  /** A summary of one range of turns, placed right after that range, in the
   * summary colour: its range version (R\u2026), what it changed against the
   * earlier ranges, and the raw-vs-summary switch for the range and for each
   * turn it covers. */
  function segmentNode(seg, memNode, turns, index) {
    const a = Number(seg.fromTurn) || 0, b = Number(seg.toTurn) || a;
    const key = RK || activeKey();
    const id = NS + `seg/${a}-${b}`;
    const open = panel.expanded.has(id);
    const raw = rawOf(key);
    const mode = modeOf(raw, a, b);
    const rev = revOf(seg, index);
    const nChg = Array.isArray(seg.changes) ? seg.changes.filter((c) => c.kind !== 'more').length : 0;
    const rid = `S${a}-${b}`;
    const smark = segMark(key, rid, mode);
    if (smark === 'deleted') return '';
    if (smark === 'hidden' && !act.showHidden) return '';
    const ra = rowAct({ kind: 'seg', key, rid, a, b, label: seg.title || seg.topic || seg.summary || 'Summary' });
    const inc = segIncluded(key, rid);
    // Raw sends the original turns instead, so there is no summary to include.
    const incOn = mode !== 'raw' && inc.on;
    const incBox = `<input class="cc-seg-check" type="checkbox" data-seg-rid="${esc(rid)}" data-key="${esc(key || '')}"${incOn ? ' checked' : ''}${inc.auto && mode !== 'raw' ? ' data-auto="1"' : ''}${inc.pend || mode === 'raw' || panel.rawBusy ? ' disabled' : ''} aria-label="${esc(`Send the summary of turns ${a} to ${b}`)}" title="${esc(mode === 'raw' ? 'Raw mode sends the original turns instead of this summary' : incOn ? 'Summary goes with the next request \u2014 untick to leave it out' : 'Summary is left out \u2014 tick to send it')}">`;
    const modes = `<span class="cc-seg-modes" role="radiogroup" aria-label="What turns ${a} to ${b} send">${RAW_MODES.map(([m, l, t]) => `<button class="cc-mode${m === mode ? ' on' : ''}" type="button" role="radio" aria-checked="${m === mode}" data-raw-mode="${m}" data-raw-range="${a}-${b}" data-key="${esc(key || '')}" title="${esc(t)}"${panel.rawBusy ? ' disabled' : ''}>${l}</button>`).join('')}</span>`;
    let inner = '';
    if (open) {
      const covered = [];
      let orig = null;
      for (let n = a; n <= b && covered.length < 60; n++) {
        const tt = turns[n - 1] || null;
        if (!tt || !Array.isArray(tt.calls)) { if (!orig && key) orig = loadOriginals(key, a, b); }
        covered.push(n);
      }
      const byRange = mode === 'raw' || mode === 'both';
      const meta = [`R${rev}`, seg.baseVersion ? `built on v${seg.baseVersion}` : '', seg.topic ? `#${seg.topic}` : '', seg.createdAt ? when(seg.createdAt) : ''].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
      inner = `<div class="cc-detail cc-g-summary">
        <div class="cc-seg-ctl"><span class="cc-rev" title="Range version">R${rev}</span>${modes}${infoBtn('segment:' + a + '-' + b)}</div>
        ${seg.title ? `<p class="cc-seg-title">${esc(seg.title)}</p>` : ''}
        <p class="cc-seg-text">${esc(seg.summary || '')}</p>
        <p class="cc-seg-meta">${meta}</p>
        ${changesList(seg)}
        ${orig && orig.loading ? '<p class="cc-none" role="status" aria-busy="true">Loading originals\u2026</p>' : ''}${orig && orig.error ? `<p class="ct-note ct-error" role="alert">${esc(orig.error)}</p>` : ''}
        <div class="cc-kids" role="group" aria-label="Original turns ${a} to ${b}">${covered.map((n) => coveredTurn(key, n, turns[n - 1] || null, orig ? orig.turns.get(n) : null, byRange || raw.turns.has(n), byRange, a, b)).join('')}</div>
      </div>`;
    }
    const st = mode === 'raw' || !incOn ? 'out' : (memNode ? stateOf(memNode) : 'in');
    const picked = mode === 'summary' ? [...raw.turns].filter((n) => n >= a && n <= b).length : 0;
    return `<div class="cc-node cc-seg-node ct-kind-summary ct-state-${esc(st)} cc-mode-${esc(mode)} cc-m-${esc(smark)}${ra.on ? ' cc-selected' : ''}" data-segment="${a}-${b}" data-rev="${rev}">
      <div class="cc-row cc-g-summary cc-actrow"${ra.attrs}${act.select ? ' tabindex="0"' : ''}>${selDot(ra.on)}${twisty(id, `summary of turns ${a} to ${b}`)}${incBox}<span class="cc-num" title="${esc(`Summary of turns ${a}\u2013${b} \u00b7 R${rev}`)}">${a === b ? a : a + '\u2013' + b}</span><span class="ct-title" title="${esc(seg.title || seg.topic || seg.summary || 'Summary')}">${esc(clip(seg.title || seg.topic || seg.summary || 'Summary', 240))}</span><span class="cc-meta">${mode !== 'summary' ? mi('raw', mode === 'raw' ? 'Sends the original turns instead' : 'Sends the summary and the original turns', null, 'cc-mi-raw') : ''}${nChg ? mi('delta', `${nChg} change${nChg === 1 ? '' : 's'} against earlier ranges`, nChg, 'cc-mi-summ') : ''}${picked ? mi('raw', `${picked} original turn${picked === 1 ? '' : 's'} sent beside the summary`, '+' + picked, 'cc-mi-raw') : ''}${smark === 'always' ? mi('always', 'Always sent', null, 'cc-mi-always') : smark === 'hidden' ? mi('hide', 'Hidden from the checklist') : ''}</span>${menuBtn(`summary of turns ${a} to ${b}`)}</div>
      ${inner}${open ? tip('segment:' + a + '-' + b) : ''}
    </div>`;
  }

  /** Where a summary belongs and what it covers: the continuity summary
   * (`sum/1-N`) right after turn N, the earlier-chat summary (`sum/chat`) above
   * the first stored turn, a temporary summary (`tmp/...`) right after the last
   * turn it stands in for. `turns` is what it covers, `tag` says it in words. */
  function sumWhere(s, firstTurn) {
    const r = rangeOf(s.id);
    if (r) return { at: r[1] + 0.6, turns: rowRange(r[0], r[1]), tag: `${r[0] === r[1] ? r[0] : r[0] + '\u2013' + r[1]}`, long: `Turns ${r[0] === r[1] ? r[0] : r[0] + '\u2013' + r[1]}`, src: 'Chat summary', info: 'rolling' };
    if (s.id === 'sum/chat') {
      const before = firstTurn < 1e9 ? firstTurn : 0;
      return { at: 0.4, turns: [], tag: before > 1 ? `<${before}` : '\u2026', long: before > 1 ? `Before turn ${before}` : 'Earlier chat', src: 'Chat summary', info: 'rolling' };
    }
    const covers = Array.isArray(s.covers) ? s.covers.map(Number).filter((n) => n > 0).sort((a, b) => a - b) : [];
    const by = s.madeBy === 'user' ? 'By you' : s.madeBy === 'model' ? 'By the agent' : s.madeBy ? 'By ' + s.madeBy : '';
    const who = s.madeBy || '';
    if (covers.length) return { at: covers[covers.length - 1] + 0.55, turns: covers, tag: turnsText(covers), long: `Turn${covers.length === 1 ? '' : 's'} ${turnsText(covers)}`, src: by ? `Summary \u00b7 ${by}` : 'Summary', by: who, info: 'tempSummary' };
    return { at: 1e9, turns: [], tag: '?', long: 'Unplaced', src: by ? `Summary \u00b7 ${by}` : 'Summary', by: who, info: 'tempSummary' };
  }
  const rowRange = (a, b) => Array.from({ length: Math.max(0, Math.min(400, b - a + 1)) }, (_, i) => a + i);
  /** A summary row, where its turns were: selectable, with its checkbox and a
   * tag that says which turns it stands in for and who made it. */
  function sumNode(s, w) {
    const key = RK || activeKey();
    const ra = rowAct({ kind: 'sum', key, node: s.id, a: w.turns.length ? w.turns[0] : '', b: w.turns.length ? w.turns[w.turns.length - 1] : '', label: s.title || w.tag, list: w.turns });
    const st = stateOf(s);
    const focus = s.focus ? mi('focus', 'Focus: ' + s.focus, null, 'cc-mi-summ') : '';
    const tag = `<span class="cc-sum-tag" title="${esc(w.src + ' \u00b7 ' + w.long)}">${esc(w.tag)}</span>`;
    const tipKey = w.info + ':' + s.id;
    const srcBtn = `<button class="cc-src" type="button" data-info="${esc(tipKey)}" aria-expanded="${panel.tips.has(tipKey)}" title="${esc(w.src)}" aria-label="${esc(w.src + ' \u2014 about this')}">${svgI(srcIco(w))}</button>`;
    const stTitle = st === 'out' ? 'Left out of the next request' : (STATE_LABEL[st] || st);
    return `<div class="cc-node cc-seg-node ct-kind-summary cc-sum ct-state-${esc(st)}${ra.on ? ' cc-selected' : ''}" data-summary="${esc(s.id)}">
      <div class="ct-item cc-row cc-g-summary cc-actrow ct-state-${esc(st)}" data-node="${esc(s.id)}"${ra.attrs}${act.select ? ' tabindex="0"' : ''}>${selDot(ra.on)}${noTwisty}${control(s)}${tag}<span class="ct-title" title="${esc(s.title || w.src)}">${esc(clip(s.title || w.src, 240))}</span><span class="cc-meta">${focus}${srcBtn}</span><span class="ct-cost" title="${esc(stTitle)}">${esc(costText(s))}</span>${menuBtn(w.src + ' ' + w.long)}</div>
      ${panel.tips.has(tipKey) ? `<p class="cc-tip" role="note">${esc([w.src + ' \u00b7 ' + w.long, s.focus ? 'Focus: ' + s.focus : '', INFO[w.info] || ''].filter(Boolean).join(' \u2014 '))}</p>` : ''}
    </div>`;
  }

  /** One conversation's stored items, sorted into the tree: its rules and
   * memory, and its turns in order with each range summary right after the
   * turns it covers. */
  function convParts(items, turns, segs) {
    const plain = { rules: [], memory: [] };
    const turnNodes = new Map(), parts = new Map(), results = new Map(), sums = [];
    let memNode = null;
    for (const it of items) {
      const k = kindOf(it);
      if (k === 'category') continue;
      if (k === 'turn') { const n = turnOf(it); if (n != null) turnNodes.set(n, it); else plain.memory.push(it); continue; }
      if (k === 'turnPart') { const n = turnOf(it); if (n == null) { plain.memory.push(it); continue; } if (!parts.has(n)) parts.set(n, []); parts.get(n).push(it); continue; }
      if (k === 'result') { const n = turnOf(it); if (n == null) { plain.memory.push(it); continue; } if (!results.has(n)) results.set(n, []); results.get(n).push(it); continue; }
      if (k === 'summary' || k === 'tempSummary') { if (it.id === 'sum/memory') memNode = it; else sums.push(it); continue; }
      (plain[groupOf(it)] || plain.memory).push(it);
    }
    const entries = [];
    for (const [n, it] of turnNodes) entries.push({ at: n, html: () => turnNode(n, it, parts.get(n) || [], results.get(n) || [], threadTurn(turns, n, it.title), false) });
    for (const [n, list] of parts) if (!turnNodes.has(n)) entries.push({ at: n, html: () => turnNode(n, null, list, results.get(n) || [], threadTurn(turns, n, ''), false) });
    for (const [n, list] of results) if (!turnNodes.has(n) && !parts.has(n)) entries.push({ at: n, html: () => turnNode(n, null, [], list, threadTurn(turns, n, ''), false) });
    segs.forEach((s, i) => entries.push({ at: (Number(s.toTurn) || 0) + 0.5, html: () => segmentNode(s, memNode, turns, i) }));
    const firstTurn = Math.min(...[...turnNodes.keys(), ...parts.keys(), ...results.keys()], 1e9);
    for (const s of sums) {
      const w = sumWhere(s, firstTurn);
      entries.push({ at: w.at, html: () => sumNode(s, w) });
    }
    entries.sort((a, b) => a.at - b.at);
    const nums = new Set([...turnNodes.keys(), ...parts.keys(), ...results.keys()]);
    const newest = Math.max(0, ...nums);
    const sent = items.filter((it) => kindOf(it) !== 'category').reduce((n, it) => n + sentOf(it), 0);
    return {
      plain, memNode, sent, turnCount: nums.size, empty: !entries.length && !memNode,
      body: () => entries.map((e) => e.html()).join('').replace(`data-turn="${newest}"`, `data-turn="${newest}" data-newest="true"`),
    };
  }

  /** The stored conversations, newest first; the open chat always among them. */
  function conversationList() {
    const cur = activeKey();
    let list = [];
    try {
      const c = appRef && appRef.chat;
      if (c && typeof c.threads === 'function') list = [...c.threads('regular'), ...c.threads('archived').map((t) => ({ ...t, archived: true }))];
    } catch (e) { list = []; }
    list = list.filter((t) => t && t.id && !String(t.id).startsWith('subagent:'));
    list.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    if (cur && !list.some((t) => t.id === cur)) list.unshift({ id: cur, title: '' });
    return list;
  }
  const ago = (ms) => {
    const n = Number(ms); if (!n) return '';
    const s = Math.max(0, (Date.now() - (n < 1e12 ? n * 1000 : n)) / 1000);
    return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 86400 * 30 ? `${Math.floor(s / 86400)}d` : new Date(n < 1e12 ? n * 1000 : n).toLocaleDateString();
  };
  const segsOf = (key) => { const md = memData(key); return (md && md.data && md.data.memory && Array.isArray(md.data.memory.segments)) ? md.data.memory.segments : []; };

  /** Read another conversation's tree, messages and memory, for its row. */
  function loadConv(key, force) {
    if (!key || key === activeKey()) return Promise.resolve();
    let c = convs.get(key);
    if (!c) { c = { items: [], tokens: null, counts: null, msgs: null, loading: false, error: '', at: 0 }; convs.set(key, c); }
    if (c.loading || (!force && c.at && Date.now() - c.at < 15000)) return c.loading || Promise.resolve();
    const send = ctxSend();
    if (!send) { c.error = 'The engine is not ready.'; paint(true); return Promise.resolve(); }
    const tree = Promise.resolve(send('ctx.tree', { sessionKey: key })).then((p) => {
      if (p && (p.ok === false || p.error)) throw new Error(p.error || p.text || 'Could not read this chat.');
      c.items = (p && Array.isArray(p.items) ? p.items : []).map((it) => ({ ...it, _key: key }));
      c.tokens = (p && p.tokens) || null; c.counts = (p && p.counts) || null;
    });
    const msgs = (async () => {
      const rt = appRef && appRef.chat && appRef.chat.runtimes && appRef.chat.runtimes.get && appRef.chat.runtimes.get(key);
      if (rt && Array.isArray(rt.messages) && rt.messages.length) return rt.messages;
      if (typeof bridge === 'undefined' || !bridge || typeof bridge.loadSession !== 'function' || typeof convertEngineMessages !== 'function') return [];
      return convertEngineMessages(await bridge.loadSession(key)).map((pair) => pair[1]);
    })().then((m) => { c.msgs = m; }).catch(() => { c.msgs = c.msgs || []; });
    const cm = memApi();
    const mem = cm && cm.refresh ? Promise.resolve(cm.refresh(key)).catch(() => null) : Promise.resolve();
    c.loading = Promise.allSettled([tree, msgs, mem]).then((r) => {
      c.error = r[0].status === 'rejected' ? String((r[0].reason && r[0].reason.message) || r[0].reason) : '';
      c.at = Date.now();
    }).finally(() => { c.loading = false; paint(true); });
    paint(true);
    return c.loading;
  }

  /** Open a stored conversation in the chat, and close the card. */
  function openConversation(key) {
    const chat = appRef && appRef.chat;
    if (!key || !chat || typeof chat.switchToThread !== 'function') return false;
    if (key === activeKey()) { close(false); return true; }
    close(false);
    try { chat.switchToThread(key); } catch (e) { return false; }
    try { if (typeof appRef.setMobileSidebar === 'function') appRef.setMobileSidebar(false); } catch (e) { /* desktop */ }
    return true;
  }

  /** One conversation as a collapsible node: its name, what it holds, and a
   * button to open it. The open chat is drawn from the live state. */
  function convNode(t, cur, curParts) {
    const isCur = t.id === cur;
    const id = isCur ? 'conv/current' : 'conv/' + t.id;
    const open = panel.expanded.has(id);
    const name = (isCur ? (t.title || (appRef && appRef.chat && appRef.chat.mainItem && appRef.chat.mainItem.title)) : t.title) || 'New chat';
    const c = isCur ? null : convs.get(t.id);
    let inner = '', meta = '', metaT = '';
    NS = isCur ? '' : `c:${t.id}|`; RK = isCur ? '' : t.id;
    try {
      if (isCur) {
        const q = curParts;
        meta = `${q.turnCount} \u00b7 ${short(q.sent)}`; metaT = `${plural(q.turnCount, 'turn')} \u00b7 ${num(q.sent)} tokens`;
        if (open) {
          const memRow = q.memNode ? `<div class="cc-node cc-seg-node ct-kind-summary">${leafRow(q.memNode, `<button class="cc-go" type="button" data-tab-go="summary" aria-label="View summary" title="View summary">${svgI('eye', 14)}</button>`)}</div>` : '';
          inner = q.empty ? '<p class="cc-none">Nothing stored yet</p>' : memRow + q.body();
        }
      } else if (c && c.at) {
        const q = convParts(c.items, threadTurns(c.msgs || []), segsOf(t.id));
        meta = `${q.turnCount} \u00b7 ${short(q.sent)}`; metaT = `${plural(q.turnCount, 'turn')} \u00b7 ${num(q.sent)} tokens`;
        if (open) {
          const memRow = q.memNode ? `<div class="cc-node cc-seg-node ct-kind-summary">${leafRow(q.memNode)}</div>` : '';
          const err = c.error ? `<p class="ct-note ct-error" role="alert">${esc(c.error)} <button class="ct-error-retry" type="button" data-conv-retry="${esc(t.id)}">Retry</button></p>` : '';
          inner = err + (q.empty && !c.error ? '<p class="cc-none">Nothing stored yet</p>' : groupBlock('memory', 'Memory', q.plain.memory) + memRow + q.body());
        }
      } else {
        meta = ago(t.lastMessageAt);
      }
      // Opened before (and kept open) but not read since a chat switch: read it now.
      if (open && !isCur && !c) setTimeout(() => loadConv(t.id), 0);
      if (open && !isCur && (!c || c.loading)) inner = (c && c.at ? inner : '') + '<p class="cc-none" role="status" aria-busy="true">Loading\u2026</p>';
    } finally { NS = ''; RK = ''; }
    const go = isCur ? '<span class="cc-go cc-here" role="img" title="Open now" aria-label="Open now"><svg viewBox="0 0 8 8" width="7" height="7" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg></span>'
      : `<button class="cc-go cc-open" type="button" data-open-conv="${esc(t.id)}" aria-label="Open chat ${esc(clip(name, 40))}">${GO_ICON}</button>`;
    return `<div class="cc-node cc-conv${isCur ? ' cc-conv-current' : ''}" data-conv="${esc(t.id)}"${isCur ? ' data-current="true"' : ''}>
      <div class="cc-row cc-conv-head cc-g-turns">${twisty(id, 'chat ' + name)}<span class="ct-title" title="${esc(name)}">${esc(clip(name, 200))}</span><span class="cc-meta">${t.archived ? mi('archive', 'Archived') : ''}</span><span class="ct-cost cc-conv-meta"${metaT ? ` title="${esc(metaT)}"` : ''}>${esc(meta)}</span>${go}</div>
      ${open ? `<div class="cc-kids">${inner}</div>` : ''}
    </div>`;
  }

  /** The checklist: the open chat's rules and memory, then every stored
   * conversation; the open one first and expanded. */

  /* ---------- Checklists: the person's own (ucl/…) and the model's (cat/…, task/pick) ---------- */
  let clForm = null; // { mode: 'new'|'rename'|'cap', id, items, title, cap }
  const clData = () => state.checklists || { user: [], ai: [] };
  function filedIds() {
    const set = new Set();
    for (const l of clData().user || []) for (const id of l.items || []) set.add(id);
    return set;
  }
  const isFiled = (id, set) => set.has(id) || set.has(String(id).split('/call/')[0]);
  /** The engine id a selected row files under, or '' when it cannot be filed. */
  function clItemId(r) {
    if (!r || (r.key && r.key !== activeKey())) return '';
    if (r.kind === 'turn') return r.n ? `turn/t${r.n}` : '';
    if (r.kind === 'sum' || r.kind === 'item') return r.node || '';
    return '';
  }
  function clOp(op, extra) {
    const send = ctxSend();
    if (!send) { say('No engine in this build', 'error'); return Promise.resolve(null); }
    // Optimistic: a switch flips at once.
    if (op === 'include' || op === 'exclude') {
      const d = clData();
      for (const l of [...(d.user || []), ...(d.ai || [])]) if (l.id === extra.id) l.included = op === 'include';
      paint(true);
    }
    return Promise.resolve(send('ctx.checklist', { op, ...extra }))
      .then((r) => {
        if (!r || r.ok === false) throw new Error((r && (r.error || r.text)) || 'The engine refused the change.');
        if (r.checklists) state.checklists = r.checklists;
        return r;
      })
      .catch((e) => { say(errText(e), 'error'); return null; })
      .finally(() => { paint(true); refresh(); });
  }
  function openClForm(mode, id, items) {
    const l = (clData().user || []).find((x) => x.id === id) || {};
    clForm = { mode, id, items: items || [], title: l.title || '', cap: l.cap || '' };
    panel.expanded.add('grp/mycl');
    paint(true);
    requestAnimationFrame(() => { const f = panel.body && panel.body.querySelector(mode === 'cap' ? '.cc-clform [name=cap]' : '.cc-clform [name=title]'); if (f) { f.focus(); if (f.select) f.select(); } });
  }
  function saveClForm() {
    const f = clForm;
    const root = panel.body && panel.body.querySelector('.cc-clform');
    if (!f || !root) return;
    const title = (root.querySelector('[name=title]') || {}).value || '';
    const capRaw = (root.querySelector('[name=cap]') || {}).value || '';
    const cap = capRaw ? Math.max(0, Math.round(Number(String(capRaw).replace(/k$/i, '')) * (/k$/i.test(capRaw) ? 1000 : 1))) || null : null;
    clForm = null;
    if (f.mode === 'new') clOp('create', { title: title.trim() || 'Checklist', cap, items: f.items }).then((r) => { if (r && r.id) panel.expanded.add('cl/' + r.id); });
    else if (f.mode === 'rename') clOp('rename', { id: f.id, title });
    else clOp('cap', { id: f.id, cap });
    paint(true);
  }
  function clFormHtml() {
    if (!clForm) return '';
    const f = clForm;
    const showTitle = f.mode !== 'cap', showCap = f.mode !== 'rename';
    return `<div class="cc-clform" role="group" aria-label="${f.mode === 'new' ? 'New checklist' : 'Edit checklist'}">
      ${svgI('user', 14)}
      ${showTitle ? `<input name="title" type="text" maxlength="120" placeholder="Checklist title" value="${esc(f.title)}" aria-label="Title" enterkeyhint="done">` : `<span class="cc-clform-t">${esc(f.title)}</span>`}
      ${showCap ? `<label class="cc-clform-cap" title="Token cap (optional)">${svgI('cap', 12)}<input name="cap" type="text" inputmode="numeric" placeholder="cap" value="${esc(f.cap || '')}" aria-label="Token cap (optional)"></label>` : ''}
      ${f.items.length ? `<span class="cc-mi" title="${f.items.length} items to add">${svgI('list')}<b>${f.items.length}</b></span>` : ''}
      <button class="cc-iconbtn ok" type="button" data-cl-save aria-label="Save">${svgI('check', 14)}</button>
      <button class="cc-iconbtn" type="button" data-cl-cancel aria-label="Cancel">${svgI('x', 14)}</button>
    </div>`;
  }
  /** An item filed in a checklist, by its engine id. */
  function clItemRow(id, list, mine) {
    const it = (state.items || []).find((x) => x.id === id);
    const rm = mine ? `<button class="cc-iconbtn cc-cl-rm" type="button" data-cl-remove="${esc(id)}" data-cl-list="${esc(list.id)}" aria-label="Take out of the list" title="Back to where it was">${svgI('x', 12)}</button>` : '';
    if (it) return leafRow(it, rm);
    const t = /^turn\/t(\d+)$/.exec(id);
    const title = t ? (threadTurn(threadTurns(), Number(t[1]), '') || {}).title || `Turn ${t[1]}` : id;
    return `<div class="ct-item cc-row cc-g-memory" data-node="${esc(id)}">${noTwisty}<span class="ct-sym">\u00b7</span><span class="ct-title" title="${esc(title)}">${esc(title)}</span>${rm}<span class="ct-cost">\u2013</span></div>`;
  }
  function clRow(l, mine) {
    const id = 'cl/' + l.id;
    const open = panel.expanded.has(id);
    const items = l.items || [];
    const on = l.included !== false;
    const tipKey = 'clwhy:' + l.id;
    const kindIco = mine ? '' : l.kind === 'task' ? mi('focus', 'Task pick' + (l.policy ? ' \u00b7 ' + l.policy : '')) : '';
    const src = mine
      ? `<span class="cc-cl-src cc-cl-src-user" role="img" aria-label="Yours" title="Yours">${svgI('user')}</span>`
      : `<button class="cc-cl-src cc-cl-src-ai" type="button" data-info="${esc(tipKey)}" aria-expanded="${panel.tips.has(tipKey)}" aria-label="Why the model made it" title="Why">${svgI('spark')}</button>`;
    const why = !mine && panel.tips.has(tipKey) ? `<p class="cc-tip" role="note">${esc([l.kind === 'task' ? 'Task pick' + (l.policy ? ' ' + l.policy : '') : 'Category ' + l.id, l.focus ? 'Focus: ' + l.focus : 'No reason given', l.cap ? 'cap ' + short(l.cap) : ''].filter(Boolean).join(' \u2014 '))}</p>` : '';
    const capI = l.cap ? mi('cap', `Token cap ${num(l.cap)}`, short(l.cap)) : '';
    return `<div class="cc-node cc-cl ${mine ? 'cc-cl-user' : 'cc-cl-ai'}${on ? '' : ' cc-cl-off ct-state-out'}" data-cl="${esc(l.id)}">
      <div class="cc-row cc-cl-row">${twisty(id, l.title)}<input class="cc-cl-check" type="checkbox" data-cl-id="${esc(l.id)}"${on ? ' checked' : ''} aria-label="${esc((on ? 'Leave out: ' : 'Include: ') + l.title)}">${src}<span class="ct-title" title="${esc(l.title)}">${esc(l.title)}</span><span class="cc-meta">${kindIco}${capI}${mi('list', `${items.length} items`, items.length)}</span><span class="ct-cost" title="Tokens its items send">${esc(on ? short(l.tokens || 0) : '\u2013')}</span>${mine ? `<button class="cc-kebab" type="button" data-cl-menu="${esc(l.id)}" aria-haspopup="menu" aria-label="${esc('More actions for ' + l.title)}">${MENU_ICON}</button>` : ''}</div>
      ${why}
      ${open ? `<div class="cc-kids">${items.length ? items.map((x) => clItemRow(x, l, mine)).join('') : `<p class="cc-cl-empty">${svgI('select')} Select rows, then ${svgI('list')}</p>`}</div>` : ''}
    </div>`;
  }
  function clGroupHead(gid, label, icon, lists, extra) {
    const on = lists.filter((l) => l.included !== false);
    const tok = on.reduce((n, l) => n + (Number(l.tokens) || 0), 0);
    return `<div class="cc-row cc-head">${twisty('grp/' + gid, label)}<span class="cc-cl-gico cc-cl-gico-${icon}">${svgI(icon)}</span><span class="ct-title cc-group-name">${esc(label)}</span>${extra || ''}<span class="ct-cost" title="${on.length} of ${lists.length} on \u00b7 tokens">${on.length}/${lists.length} \u00b7 ${esc(short(tok))}</span>${infoBtn(gid)}</div>${tip(gid)}`;
  }
  function clGroups() {
    if (RK) return '';
    const d = clData();
    const user = d.user || [], ai = d.ai || [];
    const plus = `<button class="cc-iconbtn cc-cl-plus" type="button" data-cl-new aria-label="New checklist" title="New checklist">${svgI('plus', 14)}</button>`;
    const mine = `<div class="cc-node cc-group cc-g-mycl" data-group="mycl">${clGroupHead('mycl', 'My checklists', 'user', user, plus)}${panel.expanded.has('grp/mycl') ? `<div class="cc-kids">${clForm && clForm.mode === 'new' ? clFormHtml() : ''}${user.map((l) => (clForm && clForm.id === l.id ? clFormHtml() : '') + clRow(l, true)).join('')}${!user.length && !clForm ? `<button class="cc-cl-empty cc-link" type="button" data-cl-new>${svgI('plus')} New checklist</button>` : ''}</div>` : ''}</div>`;
    const theirs = `<div class="cc-node cc-group cc-g-aicl" data-group="aicl">${clGroupHead('aicl', 'AI checklists', 'spark', ai, '')}${panel.expanded.has('grp/aicl') ? `<div class="cc-kids">${ai.length ? ai.map((l) => clRow(l, false)).join('') : `<p class="cc-cl-empty">${svgI('spark')} none yet</p>`}</div>` : ''}</div>`;
    return mine + theirs;
  }
  /** A sheet of choices (the same look as a row's menu). */
  function openSheet(title, sub, items, rows, opener) {
    const host = ensureMenuHost();
    if (!host) return;
    closeMenu(false);
    act.menu = { r: rows[0], rows, opener };
    host.innerHTML = `<div class="cc-scrim" data-menu-close="1"></div>
      <div class="cc-sheet" role="menu" aria-label="${esc(title)}">
        <div class="cc-grab" aria-hidden="true"></div>
        <div class="cc-sheet-head"><span class="cc-sheet-title">${esc(title)}</span></div>
        ${sub ? `<p class="cc-sheet-sub">${esc(sub)}</p>` : ''}
        <div class="cc-sheet-list">${items.map((it) => it.sep ? '<div class="cc-sheet-sep" role="separator"></div>' : `<button class="cc-sheet-item${it.danger ? ' danger' : ''}${it.tone ? ' tone-' + it.tone : ''}" type="button" role="menuitem" data-menu-act="${esc(it.k)}" tabindex="-1">${ico(it.icon)}<span class="cc-si-text"><span class="cc-si-label">${esc(it.label)}</span>${it.hint ? `<span class="cc-si-hint">${esc(it.hint)}</span>` : ''}</span></button>`).join('')}</div>
        <button class="cc-sheet-cancel" type="button" data-menu-close="1">Cancel</button>
      </div>`;
    host.hidden = false;
    host.dataset.open = '1';
    const first = host.querySelector('.cc-sheet-item');
    requestAnimationFrame(() => { host.dataset.shown = '1'; if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } } });
  }
  function openClPicker(rows) {
    const ok = rows.filter(clItemId);
    if (!ok.length) { say('Only turns, summaries and notes of this chat can be filed'); return; }
    const user = clData().user || [];
    const items = [{ k: 'cl-new', icon: 'plus', label: 'New checklist', hint: `With ${ok.length} item${ok.length === 1 ? '' : 's'}`, tone: 'always' }];
    if (user.length) items.push({ sep: true });
    for (const l of user) items.push({ k: 'cl-to:' + l.id, icon: 'list', label: l.title, hint: `${(l.items || []).length} items${l.cap ? ' \u00b7 cap ' + short(l.cap) : ''}` });
    openSheet('Add to checklist', `${ok.length} selected`, items, ok, null);
  }
  function openClMenu(id, opener) {
    const l = (clData().user || []).find((x) => x.id === id);
    if (!l) return;
    const r = { id: 'cl:' + id, kind: 'cl', node: id, label: l.title };
    openSheet(l.title, `${(l.items || []).length} items${l.cap ? ' \u00b7 cap ' + num(l.cap) : ''}`, [
      { k: 'clm-add', icon: 'select', label: 'Add items', hint: 'Select rows, then the list icon' },
      { k: 'clm-rename', icon: 'edit', label: 'Rename', hint: '' },
      { k: 'clm-cap', icon: 'cap', label: l.cap ? 'Change token cap' : 'Set token cap', hint: 'Items go in order until it is full' },
      { sep: true },
      { k: 'clm-delete', icon: 'del', label: 'Delete checklist', hint: 'Its items go back where they were', danger: true },
    ], [r], opener);
  }
  function clMenuAct(k, r) {
    const id = r && r.node;
    if (!id) return;
    if (k === 'clm-add') { act.select = true; paint(true); say('Select rows, then the list icon'); return; }
    if (k === 'clm-rename') { openClForm('rename', id, []); return; }
    if (k === 'clm-cap') { openClForm('cap', id, []); return; }
    if (k === 'clm-delete') { clOp('delete', { id }).then((x) => { if (x) say('Checklist deleted; its items are back'); }); }
  }

  function tree() {
    const items = state.items || [];
    const cur = activeKey();
    const segs = segsOf(cur);
    // A sub-agent's brain is its own session: other chats are not its conversations.
    const sub = scopeInfo().sub;
    const list = conversationList().filter((t) => !sub || t.id === cur);
    const others = list.filter((t) => t.id !== cur);
    if (!items.length && !segs.length && !others.length) return '<p class="ct-empty">Empty until the first message.</p>';
    NS = ''; RK = '';
    const filed = filedIds();
    const q = convParts(filed.size ? items.filter((it) => !isFiled(it.id, filed)) : items, threadTurns(), segs);
    const all = panel.expanded.has('convs/all');
    const curRow = list.find((t) => t.id === cur);
    const shown = [...(curRow ? [curRow] : []), ...(all ? others : others.slice(0, CONV_PAGE))];
    const more = all || others.length <= CONV_PAGE ? '' : `<button class="cc-link cc-more-convs" type="button" data-tw="convs/all">Show ${others.length - CONV_PAGE} more</button>`;
    const convo = shown.length
      ? `<div class="cc-node cc-group cc-g-turns" data-group="turns"><div class="cc-row cc-head">${twisty('grp/turns', 'conversations')}<span class="cc-dot"></span><span class="ct-title cc-group-name">Conversations</span><span class="ct-cost">${list.length}</span>${infoBtn('turn')}</div>${tip('turn')}${panel.expanded.has('grp/turns') ? `<div class="cc-kids">${shown.map((t) => convNode(t, cur, q)).join('')}${more}</div>` : ''}</div>`
      : '';
    return groupBlock('rules', 'Rules', q.plain.rules) + clGroups() + groupBlock('memory', 'Memory', q.plain.memory) + memoryTree() + convo;
  }

  // ── The chat memory as checklist groups (always on; memory_checklist.rs).
  const MEM_COLOURS = { sent: 'Sent', left_out: 'Left out', show_more: 'Show more', inactive: 'Tag inactive', pinned: 'Earlier version sent' };
  const MEM_PAGE = 6;

  /** One #tag of the chat with its own controls: an active tag can be made
   * inactive or removed, an inactive or removed one made active again. Only
   * the last mention of a tag carries its context (sent once). */
  function tagChip(t) {
    const st = t.state || 'active';
    const pend = pendingMem.has(t.rid);
    const label = `${t.tag}${t.version ? '@v' + t.version : ''}`;
    const btn = (op, text, aria) => `<button type="button" class="cc-tag-op" data-mem-op="${op}" data-rid="${esc(t.rid)}" aria-label="${esc(aria)}"${pend ? ' disabled' : ''}>${text}</button>`;
    const ops = st === 'active'
      ? btn('inactive', '\u23f8', `Make ${label} inactive`) + btn('remove', '\u00d7', `Remove ${label}`)
      : btn('active', '\u21ba', `Make ${label} active again`);
    return `<span class="cc-mem-tag cc-tag-${esc(st)}" title="${esc(t.rid)} \u00b7 ${esc(st)} \u00b7 \u00d7${esc(t.mentions)} \u00b7 last turn ${esc(t.lastTurn)}">${esc(label)}${ops}</span>`;
  }

  function memRow(r) {
    const id = 'mem/' + r.rid;
    const open = panel.expanded.has(id);
    const pend = pendingMem.get(r.rid);
    const pick = r.pick || 'auto';
    const colour = MEM_COLOURS[r.colour] ? r.colour : 'show_more';
    const checked = pick === 'in' || (pick === 'auto' && (colour === 'sent' || colour === 'pinned'));
    const mixed = pick === 'auto';
    const tagState = r.tagState || '';
    const mentions = r.mentions && r.mentions.count ? `<span class="cc-badge cc-mem-mentions" title="named ${esc(r.mentions.count)}\u00d7, last in turn ${esc(r.mentions.lastTurn)}">\u00d7${esc(r.mentions.count)}</span>` : '';
    const versions = Number(r.versionCount) > 1 ? `<span class="cc-badge cc-mem-ver">v${esc(r.versionCount)}</span>` : '';
    const btn = (op, label, title) => `<button class="cc-link cc-mem-op" type="button" data-mem-op="${op}" data-rid="${esc(r.rid)}" title="${esc(title)}"${pend ? ' disabled' : ''}>${label}</button>`;
    const detail = open ? `<div class="cc-detail cc-mem-detail">
        <p class="cc-seg-text">${esc(r.line || '')}</p>
        <p class="cc-seg-meta"><span>${esc(r.status || '')}</span>${r.turn ? `<span>turn ${esc(r.turn)}</span>` : ''}<span>${esc(MEM_COLOURS[colour])}${r.reason && r.reason !== colour ? ' \u00b7 ' + esc(r.reason === 'inline' ? 'at its last #tag in the chat' : r.reason) : ''}</span>${r.pickedBy ? `<span>picked by ${esc(r.pickedBy)}</span>` : ''}</p>
        <div class="cc-mem-actions">
          ${pick !== 'auto' ? btn('auto', '\u21ba Auto', 'Give it back to relevance') : ''}
          ${r.versionsMode === 'all' ? btn('latest', 'Newest only', 'Send only the newest version') : btn('all_versions', 'All versions', 'Send every earlier version with it')}
          ${tagState === 'inactive' ? btn('active', 'Tag active', 'The tag pulls it in again') : btn('inactive', 'Tag inactive', 'Keep the tag, stop it pulling the row in')}
          ${tagState && tagState !== 'removed' ? btn('remove', 'Remove tag', 'Forget the mentions so far') : ''}
        </div>
        ${Array.isArray(r.versions) && r.versions.length > 1 ? `<ol class="cc-mem-versions">${r.versions.map((v) => `<li><span class="cc-rev">v${esc(v.v)}</span> ${esc(clip(String(v.line || '').replace(/^- /, ''), 160))}</li>`).join('')}</ol>` : ''}
      </div>` : '';
    return `<div class="cc-node cc-mem-row cc-mc-${esc(colour)}${tagState ? ' cc-tag-' + esc(tagState) : ''}${pend ? ' cc-pending' : ''}" data-rid="${esc(r.rid)}" data-colour="${esc(colour)}" role="treeitem">
      <div class="cc-row">${twisty(id, r.title || r.rid)}<input class="cc-mem-check" type="checkbox" data-rid="${esc(r.rid)}" aria-label="Send ${esc(r.rid)}"${checked ? ' checked' : ''}${mixed ? ' data-auto="1"' : ''}${pend ? ' disabled' : ''}><span class="cc-mem-tag">${esc(r.tag || '#' + r.rid)}</span><span class="ct-title">${esc(clip(r.title || r.rid, 60))}</span>${versions}${mentions}<span class="cc-mem-dot" title="${esc(MEM_COLOURS[colour])}"></span></div>${detail}</div>`;
  }

  function memGroup(g, byParent) {
    const id = 'memgrp/' + g.id;
    const open = panel.expanded.has(id);
    // Deleted rows are gone; hidden rows wait behind "Show hidden".
    const items = (Array.isArray(g.items) ? g.items : []).filter((r) => r && r.pick !== 'deleted' && (act.showHidden || r.pick !== 'hidden'));
    const kids = byParent.get(g.id) || [];
    const total = items.length + kids.reduce((n, k) => n + (k.count || 0), 0);
    if (!total) return '';
    // Rows that are sent or left out come first; stored rows ("show more")
    // wait behind their own button, in their own colour.
    const main = items.filter((r) => r.colour !== 'show_more');
    const more = items.filter((r) => r.colour === 'show_more');
    const all = panel.expanded.has(id + '/more');
    const shownMore = all ? more : more.slice(0, Math.max(0, MEM_PAGE - main.length));
    const hidden = more.length - shownMore.length;
    const left = items.filter((r) => r.colour === 'left_out').length;
    const sent = items.filter((r) => r.colour === 'sent' || r.colour === 'pinned').length;
    const body = open ? `<div class="cc-kids">${main.map(memRow).join('')}${shownMore.map(memRow).join('')}${hidden > 0 ? `<button class="cc-link cc-mem-more cc-mc-show_more" type="button" data-tw="${esc(id)}/more">Show ${hidden} more</button>` : ''}${kids.map((k) => memGroup(k, byParent)).join('')}</div>` : '';
    return `<div class="cc-node cc-group cc-g-memory cc-mem-group${g.readOnly ? ' cc-mem-ro' : ''}" data-mem-group="${esc(g.id)}" role="treeitem">
      <div class="cc-row cc-head">${twisty(id, g.title)}<span class="cc-dot"></span><span class="ct-title cc-group-name">${esc(g.title)}</span>${g.readOnly ? '<span class="cc-badge cc-ro" title="Shared from the parent agent: it can be sent, not changed here">Read-only</span>' : ''}<span class="ct-cost">${sent}/${total}${left ? ` \u00b7 <span class="cc-mc-left_out cc-mem-count">${left} left out</span>` : ''}</span>${groupOps(g)}</div>${body}</div>`;
  }

  /** One tap for a whole group (and its child groups): send all, leave all
   * out, or hand it back to relevance. The engine expands `group:<id>`. */
  function groupOps(g) {
    if (!g.items || !g.items.length) return '';
    const rid = 'group:' + g.id;
    const pend = pendingMem.has(rid);
    const btn = (op, label, title) => `<button class="cc-link cc-mem-op cc-mem-group-op" type="button" data-mem-op="${op}" data-rid="${esc(rid)}" title="${esc(title)}"${pend ? ' disabled' : ''}>${label}</button>`;
    return `<span class="cc-mem-group-ops">${btn('include', 'All in', `Send every row of ${g.title}`)}${btn('exclude', 'All out', `Leave every row of ${g.title} out`)}${btn('auto', 'Auto', `Let relevance choose for ${g.title}`)}</span>`;
  }

  function memoryTree() {
    const m = state.memory;
    if (!m || !Array.isArray(m.groups)) return '';
    const byParent = new Map();
    for (const g of m.groups) {
      if (!g.parent) continue;
      if (!byParent.has(g.parent)) byParent.set(g.parent, []);
      byParent.get(g.parent).push(g);
    }
    const top = byParent.get('mem') || [];
    const inner = top.map((g) => memGroup(g, byParent)).join('');
    if (!inner) return '';
    const c = m.counts || {};
    const id = 'memgrp/mem';
    if (!panel.expanded.has(id) && !panel.memTouched) { panel.expanded.add(id); panel.memTouched = true; }
    const open = panel.expanded.has(id);
    const legend = `<div class="cc-mem-legend" aria-label="Colours">${Object.entries(MEM_COLOURS).map(([k, v]) => `<span class="cc-mc-${k}"><span class="cc-mem-dot"></span>${esc(v)}</span>`).join('')}</div>`;
    const tags = Array.isArray(m.tags) && m.tags.length ? `<div class="cc-mem-tags">${m.tags.slice(0, 30).map(tagChip).join('')}</div>` : '';
    return `<div class="cc-node cc-group cc-g-memory cc-mem-root" data-group="chat-memory" role="treeitem">
      <div class="cc-row cc-head">${twisty(id, 'Chat memory')}<span class="cc-dot"></span><span class="ct-title cc-group-name">${scopeInfo().sub ? 'Sub-agent memory' : 'Chat memory'}</span><span class="ct-cost">${esc(c.sent || 0)} sent \u00b7 <span class="cc-mc-left_out cc-mem-count">${esc(c.leftOut || 0)} left out</span> \u00b7 <span class="cc-mc-show_more cc-mem-count">${esc(c.showMore || 0)} more</span></span>${infoBtn('memory')}</div>${tip('memory')}
      ${open ? `<div class="cc-kids">${legend}${tags}${inner}</div>` : ''}</div>`;
  }

  /* ---------- row actions: ⋮ menu and long-press sheet, multi-select, summarize, hide, delete ----------
     Every checklist row that can change (a turn, a range summary) has a ⋮ button; a long
     press (touch), a right click (mouse) or the context-menu key / Shift+F10 (keyboard)
     opens the same menu. On a phone it is a bottom sheet inside the card, on a wide card a
     popover beside the row. Each action is real:
       * Summarize   the selected turns go to the agent as one `ctx summarize` request; the
                     summary replaces them in the window (they turn violet: "Summarized").
       * Leave out   the engine's own pick (`exclude`), honoured from the very next step.
       * Hide        a range summary: pick `hidden` (never sent, off the list until "Show
                     hidden"); a turn: left out of the window and kept off the list.
       * Delete      a range summary: pick `deleted` after a 5 s undo window; it leaves the
                     checklist and the chat's colour marks, and is never sent again.
     The same states colour the chat itself (paintMainMarks), with the same tokens. */
  const act = { select: false, sel: new Map(), showHidden: false, menu: null, undo: null, lp: null, swallow: 0 };
  const MARK_LABEL = { summarized: 'Summarized', always: 'Always sent', out: 'Left out', hidden: 'Hidden', deleted: 'Deleted', summarizing: 'Summarizing\u2026', raw: 'Original sent' };
  const localSeg = new Map(); // `${key}|S1-4` -> 'hidden' | 'deleted' | 'out' | 'in' | 'auto' until the engine confirms
  const pendingSum = new Map(); // chat key -> Set of turn numbers sent to be summarized
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  const hiddenTurns = (key) => new Set((lsGet('cc.hiddenTurns.' + (key || ''), []) || []).map(Number));
  function setHiddenTurn(key, n, on) {
    const s = hiddenTurns(key);
    if (on) s.add(Number(n)); else s.delete(Number(n));
    lsSet('cc.hiddenTurns.' + key, [...s]);
  }
  /** The engine's pick for a range summary (`auto`, `in`, `out`, `hidden`, `deleted`). */
  function segPick(key, rid) {
    const loc = localSeg.get(`${key || ''}|${rid}`);
    if (loc) return loc;
    const r = (!key || key === activeKey()) ? memRecord(rid) : null;
    if (r) return r.pick || 'auto';
    const p = segPicks.get(`${key}|${rid}`);
    return p || 'auto';
  }
  /** One state word for a range summary row and its turns in the chat. */
  function segMark(key, rid, mode) {
    const p = segPick(key, rid);
    if (p === 'deleted') return 'deleted';
    if (p === 'hidden') return 'hidden';
    if (mode === 'raw') return 'raw';
    if (p === 'out') return 'out';
    if (p === 'in') return 'always';
    return 'summarized';
  }
  const turnsText = (nums) => {
    const s = [...new Set(nums.map(Number))].filter((n) => n > 0).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(i === j ? `${s[i]}` : `${s[i]}\u2013${s[j]}`);
      i = j;
    }
    return out.join(', ');
  };
  const say = (msg, type) => { try { if (typeof toast === 'function') toast(msg, type ? { type } : undefined); } catch (e) { /* no toast */ } };

  const MENU_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></svg>';
  const ICONS = {
    select: '<path d="M4 12.5l5 5L20 6.5"/>',
    summarize: '<path d="M4 6h16M4 11h10M4 16h6"/><path d="M17 14l1.2 2.6L21 18l-2.8 1.4L17 22l-1.2-2.6L13 18l2.8-1.4z"/>',
    always: '<path d="M12 3v13M7 11l5 5 5-5"/><path d="M5 21h14"/>',
    auto: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
    out: '<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>',
    hide: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.4 6.4C4.3 7.8 2.7 10 2 12c1 2.5 5 7 10 7 1.6 0 3-.4 4.3-1"/>',
    show: '<path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="3"/>',
    del: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    go: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    cap: '<path d="M5 20h14"/><path d="M7 16V9M12 16V5M17 16v-4"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/>',
  };
  const ico = (k) => `<svg class="cc-act-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ''}</svg>`;

  /** Attributes that make a row selectable and give it a menu. */
  function rowAct(d) {
    const id = d.kind === 'seg' ? `seg:${d.key || ''}:${d.rid}` : d.kind === 'sum' ? `sum:${d.key || ''}:${d.node}` : d.kind === 'item' ? `item:${d.key || ''}:${d.node}` : `turn:${d.key || ''}:${d.n}`;
    const on = act.sel.has(id);
    return { id, on, attrs: ` data-act-id="${esc(id)}" data-act-kind="${d.kind}" data-act-key="${esc(d.key || '')}" data-act-n="${esc(d.n || '')}" data-act-rid="${esc(d.rid || '')}" data-act-a="${esc(d.a || '')}" data-act-b="${esc(d.b || '')}" data-act-node="${esc(d.node || '')}" data-act-label="${esc(d.label || '')}"${d.list ? ` data-act-list="${esc(d.list.join(','))}"` : ''}${act.select ? ` aria-selected="${on}"` : ''}` };
  }
  const selDot = (on) => (act.select ? `<span class="cc-sel-dot${on ? ' on' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : '');
  const menuBtn = (label) => `<button class="cc-kebab" type="button" data-row-menu="1" aria-haspopup="menu" aria-label="${esc('More actions for ' + label)}">${MENU_ICON}</button>`;
  const markChip = (m) => (m && MARK_LABEL[m] ? `<span class="cc-mark cc-mark-${m}">${esc(MARK_LABEL[m])}</span>` : '');

  /** The row a menu or selection acts on, from its data attributes. */
  function rowData(el) {
    const d = el && el.dataset;
    if (!d || !d.actId) return null;
    const list = d.actList ? d.actList.split(',').map(Number).filter((n) => n > 0) : null;
    return { id: d.actId, kind: d.actKind, key: d.actKey || activeKey(), n: Number(d.actN) || 0, rid: d.actRid, a: Number(d.actA) || 0, b: Number(d.actB) || 0, node: d.actNode, label: d.actLabel, list };
  }
  const rowTurns = (r) => (r.kind === 'seg' ? Array.from({ length: Math.max(0, r.b - r.a + 1) }, (_, i) => r.a + i) : r.kind === 'sum' ? (r.list || []) : [r.n]);

  /* the menu */
  function menuItems(r) {
    const items = [];
    items.push({ k: 'select', icon: 'select', label: act.select ? (act.sel.has(r.id) ? 'Unselect' : 'Select') : 'Select', hint: 'Pick several rows, then act on all of them' });
    if (clItemId(r)) items.push({ k: 'cl-add', icon: 'list', label: 'Add to checklist', hint: 'File it in one of your checklists' });
    if (r.kind === 'item') {
      const it = rowItem(r);
      if (it && switchable(it)) items.push(stateOf(it) === 'out' ? { k: 'turn-in', icon: 'always', label: 'Send again', hint: 'Back in the window', tone: 'always' } : { k: 'turn-out', icon: 'out', label: 'Leave out', hint: 'Not sent, stays stored', tone: 'out' });
      return items;
    }
    if (r.kind === 'seg') {
      const p = segPick(r.key, r.rid);
      items.push({ k: 'summarize', icon: 'summarize', label: 'Summarize this part again', hint: `One fresh summary of turns ${r.a}\u2013${r.b}` });
      items.push({ sep: true });
      items.push({ k: 'pick-in', icon: 'always', label: 'Always send', hint: 'Goes with every request', on: p === 'in', tone: 'always' });
      items.push({ k: 'pick-auto', icon: 'auto', label: 'Send when relevant', hint: 'The engine decides (default)', on: p === 'auto', tone: 'summarized' });
      items.push({ k: 'pick-out', icon: 'out', label: 'Leave out', hint: 'Never sent, from the next step', on: p === 'out', tone: 'out' });
      items.push({ sep: true });
      items.push(p === 'hidden' ? { k: 'unhide', icon: 'show', label: 'Show in checklist', hint: 'Back in the list, chosen by relevance' } : { k: 'hide', icon: 'hide', label: 'Hide from checklist', hint: 'Not sent and kept off the list', tone: 'hidden' });
      items.push({ k: 'delete', icon: 'del', label: 'Delete summary', hint: 'Removed from the checklist and the chat', danger: true });
    } else if (r.kind === 'sum') {
      const it = rowItem(r);
      const st = it ? stateOf(it) : 'in';
      const span = rowTurns(r);
      if (span.length) items.push({ k: 'summarize', icon: 'summarize', label: 'Summarize these turns again', hint: `One fresh summary of turns ${turnsText(span)}` });
      items.push({ sep: true });
      if (it && switchable(it)) items.push(st === 'out' ? { k: 'turn-in', icon: 'always', label: 'Send again', hint: 'Back in the window', tone: 'always' } : { k: 'turn-out', icon: 'out', label: 'Leave out', hint: 'Not sent, stays stored', tone: 'out' });
      if (span.length) items.push({ k: 'go', icon: 'go', label: `Go to turn ${span[0]} in chat`, hint: '' });
    } else {
      const it = rowItem(r);
      const st = it ? stateOf(it) : 'in';
      const hidden = hiddenTurns(r.key).has(r.n);
      items.push({ k: 'summarize', icon: 'summarize', label: 'Summarize this turn', hint: 'The summary stands in for it' });
      items.push({ sep: true });
      if (it && switchable(it)) items.push(st === 'out' ? { k: 'turn-in', icon: 'always', label: 'Send again', hint: 'Back in the window', tone: 'always' } : { k: 'turn-out', icon: 'out', label: 'Leave out', hint: 'Not sent, stays stored', tone: 'out' });
      items.push(hidden ? { k: 'unhide', icon: 'show', label: 'Show in checklist', hint: 'Back in the list and the window' } : { k: 'hide', icon: 'hide', label: 'Hide from checklist', hint: 'Left out and kept off the list', tone: 'hidden', disabled: !it || !switchable(it) });
      items.push({ k: 'go', icon: 'go', label: 'Go to turn in chat', hint: '' });
    }
    return items;
  }
  function rowItem(r) {
    const list = r.key && r.key !== activeKey() ? ((convs.get(r.key) || {}).items || []) : state.items;
    return list.find((x) => x.id === (r.node || `turn/t${r.n}`)) || null;
  }

  function ensureMenuHost() {
    if (!panel.root) return null;
    let host = panel.root.querySelector('.cc-act-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'cc-act-host';
      host.addEventListener('click', onMenuClick);
      host.addEventListener('keydown', onMenuKey);
      panel.root.appendChild(host);
    }
    return host;
  }
  function openMenu(rowEl, opener) {
    const r = rowData(rowEl);
    const host = ensureMenuHost();
    if (!r || !host) return;
    closeMenu(false);
    act.menu = { r, opener: opener || rowEl.querySelector('.cc-kebab') || rowEl };
    rowEl.classList.add('cc-menu-for');
    const items = menuItems(r);
    const wide = panel.root.getBoundingClientRect().width >= 520 && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const span = r.kind === 'sum' ? rowTurns(r) : [];
    const title = r.kind === 'seg' ? `Summary of turns ${r.a}\u2013${r.b}`
      : r.kind === 'sum' ? (span.length ? `Summary of turn${span.length === 1 ? '' : 's'} ${turnsText(span)}` : 'Chat summary')
      : r.kind === 'item' ? (r.label || r.node) : `Turn ${r.n}`;
    const mark = r.kind === 'seg' ? segMark(r.key, r.rid, modeOf(rawOf(r.key), r.a, r.b)) : turnMark(r);
    host.innerHTML = `<div class="cc-scrim" data-menu-close="1"></div>
      <div class="cc-sheet${wide ? ' cc-pop' : ''}" role="menu" aria-label="${esc(title)}">
        ${wide ? '' : '<div class="cc-grab" aria-hidden="true"></div>'}
        <div class="cc-sheet-head"><span class="cc-sheet-title">${esc(title)}</span>${markChip(mark)}</div>
        <p class="cc-sheet-sub">${esc(clip(r.label || '', 90))}</p>
        <div class="cc-sheet-list">${items.map((it) => it.sep ? '<div class="cc-sheet-sep" role="separator"></div>' : `<button class="cc-sheet-item${it.danger ? ' danger' : ''}${it.on ? ' on' : ''}${it.tone ? ' tone-' + it.tone : ''}" type="button" role="${/^pick-/.test(it.k) ? 'menuitemradio' : 'menuitem'}"${/^pick-/.test(it.k) ? ` aria-checked="${!!it.on}"` : ''} data-menu-act="${it.k}"${it.disabled ? ' disabled' : ''} tabindex="-1">${ico(it.icon)}<span class="cc-si-text"><span class="cc-si-label">${esc(it.label)}</span>${it.hint ? `<span class="cc-si-hint">${esc(it.hint)}</span>` : ''}</span>${it.on ? '<span class="cc-si-check" aria-hidden="true">\u2713</span>' : ''}</button>`).join('')}</div>
        ${wide ? '' : '<button class="cc-sheet-cancel" type="button" data-menu-close="1">Cancel</button>'}
      </div>`;
    host.hidden = false;
    host.dataset.open = '1';
    const sheet = host.querySelector('.cc-sheet');
    if (wide) {
      const pr = panel.root.getBoundingClientRect();
      const rr = rowEl.getBoundingClientRect();
      const w = 272;
      sheet.style.width = `${w}px`;
      sheet.style.left = `${Math.max(8, Math.min(rr.right - pr.left - w - 8, pr.width - w - 8))}px`;
      const below = rr.bottom - pr.top + 4;
      const h = Math.min(sheet.scrollHeight || 360, pr.height - 16);
      sheet.style.top = `${Math.max(8, below + h > pr.height - 8 ? rr.top - pr.top - h - 4 : below)}px`;
    }
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* no haptics */ }
    const first = sheet.querySelector('.cc-sheet-item:not([disabled])');
    requestAnimationFrame(() => { host.dataset.shown = '1'; if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } } });
  }
  function closeMenu(focusBack) {
    const host = panel.root && panel.root.querySelector('.cc-act-host');
    const m = act.menu;
    act.menu = null;
    if (panel.body) panel.body.querySelectorAll('.cc-menu-for').forEach((el) => el.classList.remove('cc-menu-for'));
    if (!host || host.hidden) return;
    host.dataset.shown = '';
    host.dataset.open = '';
    const done = () => { if (!host.dataset.open) { host.hidden = true; host.innerHTML = ''; } };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 170);
    if (focusBack && m && m.opener && m.opener.isConnected) { try { m.opener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  function onMenuKey(e) {
    const items = Array.from(e.currentTarget.querySelectorAll('.cc-sheet-item:not([disabled])'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    const n = e.key === 'ArrowDown' ? (i + 1) % items.length : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (n >= 0 && items[n]) { e.preventDefault(); items[n].focus(); }
    if (e.key === 'Tab') { e.preventDefault(); const k = e.shiftKey ? (i - 1 + items.length) % items.length : (i + 1) % items.length; if (items[k]) items[k].focus(); }
  }
  function onMenuClick(e) {
    if (e.target.closest('[data-menu-close]')) { closeMenu(true); return; }
    const b = e.target.closest('[data-menu-act]');
    if (!b || b.disabled || !act.menu) return;
    const r = act.menu.r;
    const rows = act.menu.rows || [r];
    const k = b.dataset.menuAct;
    closeMenu(k !== 'go');
    runAction(k, rows);
  }

  /* the actions, on one row or on the selection */
  function runAction(k, rows) {
    if (!rows.length) return;
    if (k === 'select') {
      act.select = true;
      for (const r of rows) { if (act.sel.has(r.id)) act.sel.delete(r.id); else act.sel.set(r.id, r); }
      paint(true);
      return;
    }
    if (k === 'go') { const r = rows[0]; const n = r.kind === 'seg' ? r.a : r.kind === 'sum' ? (rowTurns(r)[0] || 0) : r.n; if (n) goToTurn(n, '', r.key && r.key !== activeKey() ? r.key : ''); return; }
    if (k === 'summarize') { summarizeRows(rows); return; }
    if (k === 'cl-add') { openClPicker(rows); return; }
    if (k === 'cl-new') { const ids = rows.map(clItemId).filter(Boolean); act.select = false; act.sel.clear(); openClForm('new', '', ids); return; }
    if (k.startsWith('cl-to:')) { const ids = rows.map(clItemId).filter(Boolean); clOp('add', { id: k.slice(6), items: ids }).then((r) => { if (r) say(`${ids.length} added`); }); endSelect(); return; }
    if (k.startsWith('clm-')) { clMenuAct(k, rows[0]); return; }
    if (/^pick-/.test(k)) {
      const action = { 'pick-in': 'include', 'pick-auto': 'auto', 'pick-out': 'exclude' }[k];
      for (const r of rows) if (r.kind === 'seg') segSet(r, action);
      return;
    }
    if (k === 'turn-in' || k === 'turn-out' || k === 'out') {
      for (const r of rows) {
        if (r.kind === 'seg') segSet(r, 'exclude');
        else { const it = rowItem(r); if (it && switchable(it)) setItem(it.id, k === 'turn-in', r.key && r.key !== activeKey() ? r.key : ''); }
      }
      endSelect();
      return;
    }
    if (k === 'hide') {
      for (const r of rows) {
        if (r.kind === 'seg') segSet(r, 'hide');
        else if (r.kind === 'sum') continue;
        else { const it = rowItem(r); if (it && switchable(it)) { setHiddenTurn(r.key, r.n, true); setItem(it.id, false, r.key && r.key !== activeKey() ? r.key : ''); } }
      }
      say(rows.length === 1 ? 'Hidden from the checklist and left out' : `${rows.length} rows hidden and left out`);
      endSelect();
      return;
    }
    if (k === 'unhide') {
      for (const r of rows) {
        if (r.kind === 'seg') segSet(r, 'unhide');
        else if (r.kind === 'sum') continue;
        else { setHiddenTurn(r.key, r.n, false); const it = rowItem(r); if (it && switchable(it)) setItem(it.id, true, r.key && r.key !== activeKey() ? r.key : ''); }
      }
      endSelect();
      return;
    }
    if (k === 'delete') { deleteRows(rows.filter((r) => r.kind === 'seg')); return; }
  }
  function endSelect() { act.select = false; act.sel.clear(); paint(true); }

  /** A range summary's pick, kept locally until the engine's answer is read back. */
  function segSet(r, action) {
    const loc = { include: 'in', exclude: 'out', auto: 'auto', hide: 'hidden', delete: 'deleted', unhide: 'auto', restore: 'auto' }[action] || 'auto';
    const lk = `${r.key || ''}|${r.rid}`;
    localSeg.set(lk, loc);
    if (loc === 'in' || loc === 'out') segPicks.set(lk, loc); else segPicks.delete(lk);
    paint(true);
    return setMemory(r.rid, action, r.key).then((ok) => {
      if (!ok) say('The engine did not take that change. Try again.', 'error');
      // The engine's row is the truth from here on.
      setTimeout(() => { localSeg.delete(lk); paint(true); }, ok ? 1200 : 0);
      return ok;
    });
  }

  /** Delete with undo: the rows leave at once, the engine is told after 5 s unless undone. */
  function deleteRows(rows) {
    if (!rows.length) { say('Only range summaries can be deleted. Use Hide for turns.'); return; }
    flushUndo();
    for (const r of rows) localSeg.set(`${r.key || ''}|${r.rid}`, 'deleted');
    for (const r of rows) act.sel.delete(r.id);
    if (!act.sel.size) act.select = false;
    const timer = setTimeout(() => commitDelete(), 5000);
    act.undo = { rows, timer };
    paint(true);
    showUndo(rows.length === 1 ? `Summary of turns ${rows[0].a}\u2013${rows[0].b} deleted` : `${rows.length} summaries deleted`);
  }
  function commitDelete() {
    const u = act.undo;
    if (!u) return;
    act.undo = null;
    clearTimeout(u.timer);
    hideUndo();
    for (const r of u.rows) segSet(r, 'delete');
  }
  function flushUndo() { if (act.undo) commitDelete(); }
  function undoDelete() {
    const u = act.undo;
    if (!u) return;
    act.undo = null;
    clearTimeout(u.timer);
    for (const r of u.rows) localSeg.delete(`${r.key || ''}|${r.rid}`);
    hideUndo();
    paint(true);
  }
  function showUndo(text) {
    if (!panel.root) return;
    let bar = panel.root.querySelector('.cc-undo');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'cc-undo';
      bar.setAttribute('role', 'status');
      bar.addEventListener('click', (e) => { if (e.target.closest('[data-undo]')) undoDelete(); });
      panel.root.appendChild(bar);
    }
    bar.innerHTML = `<span class="cc-undo-dot" aria-hidden="true"></span><span class="cc-undo-text">${esc(text)}</span><button type="button" data-undo="1">Undo</button><span class="cc-undo-timer" aria-hidden="true"></span>`;
    bar.hidden = false;
    requestAnimationFrame(() => { bar.dataset.shown = '1'; });
  }
  function hideUndo() {
    const bar = panel.root && panel.root.querySelector('.cc-undo');
    if (!bar) return;
    bar.dataset.shown = '';
    setTimeout(() => { if (!bar.dataset.shown) bar.hidden = true; }, 200);
  }

  /** Summarize the chosen turns (and the turns of chosen ranges) through the agent: it
   * runs `ctx summarize` on exactly those ids and stores one summary that replaces them. */
  function summarizeRows(rows) {
    const key = activeKey();
    const other = rows.find((r) => r.key && r.key !== key);
    if (other) { say('Open that chat to summarize its turns.', 'error'); return; }
    const nums = [...new Set(rows.flatMap(rowTurns))].sort((a, b) => a - b);
    if (!nums.length) { say('Select a turn, a range or a summary of turns to summarize.', 'error'); return; }
    let rt = null;
    try { rt = appRef && appRef.chat && appRef.chat.main; } catch (e) { rt = null; }
    if (!rt || typeof rt.append !== 'function') { say('The chat is not ready to summarize yet.', 'error'); return; }
    if (rt.isRunning) { say('Wait for the current reply to finish, then summarize.', 'error'); return; }
    const ids = nums.map((n) => `turn/t${n}`);
    const list = turnsText(nums);
    const context = [
      '[Context checklist action, sent by the user from the context card]',
      `Summarize turns ${list} of this conversation into ONE concise summary that keeps every decision, fact, name, number, file and open task from them.`,
      `Do it with the ctx tool: {"action":"summarize","ids":${JSON.stringify(ids)},"focus":"what turns ${list} decided and what is still open"}; when it asks for the text, write the summary and store it with ctx summarize {"ids":${JSON.stringify(ids)},"text":"..."}.`,
      'The summary replaces those turns in the window; the originals stay stored. Do nothing else, then reply with one short line saying what the summary covers.',
    ].join('\n');
    pendingSum.set(key, new Set([...(pendingSum.get(key) || []), ...nums]));
    endSelect();
    close(false);
    rt.append({ text: `Summarize turns ${list}`, context });
    say(`Summarizing turns ${list}\u2026`);
    paintMainMarks();
  }

  /** The selection bar at the bottom of the card while selecting. */
  function selectBar() {
    if (!act.select) return '';
    const rows = [...act.sel.values()];
    const n = rows.length;
    const segs = rows.filter((r) => r.kind === 'seg').length;
    const anyHidden = rows.some((r) => (r.kind === 'seg' ? segPick(r.key, r.rid) === 'hidden' : hiddenTurns(r.key).has(r.n)));
    const dis = n ? '' : ' disabled';
    return `<div class="cc-selbar" role="toolbar" aria-label="Selected rows">
      <button class="cc-selbar-x" type="button" data-sel-act="cancel" aria-label="Stop selecting"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      <span class="cc-selbar-n" aria-live="polite">${n ? `${n} selected` : 'Tap rows to select'}</span>
      <button class="cc-selbar-b cc-selbar-ico tone-always" type="button" data-sel-act="cl-add"${rows.some(clItemId) ? '' : ' disabled'} title="Add to checklist" aria-label="Add to checklist">${ico('list')}</button>
      <button class="cc-selbar-b tone-summarized" type="button" data-sel-act="summarize"${dis} title="Summarize the selected turns into one">${ico('summarize')}<span>Summarize</span></button>
      <button class="cc-selbar-b tone-out" type="button" data-sel-act="out"${dis} title="Leave the selected rows out">${ico('out')}<span>Leave out</span></button>
      <button class="cc-selbar-b tone-hidden" type="button" data-sel-act="${anyHidden ? 'unhide' : 'hide'}"${dis} title="${anyHidden ? 'Show in the checklist again' : 'Hide from the checklist'}">${ico(anyHidden ? 'show' : 'hide')}<span>${anyHidden ? 'Show' : 'Hide'}</span></button>
      <button class="cc-selbar-b danger" type="button" data-sel-act="delete"${segs ? '' : ' disabled'} title="${segs ? 'Delete the selected summaries' : 'Select a range summary to delete it'}">${ico('del')}<span>Delete</span></button>
    </div>`;
  }
  /** "Show hidden" and "Select" above the tree. */
  function actionsTop(nHidden) {
    return `<div class="cc-acttop">
      <button class="cc-chipbtn${act.select ? ' on' : ''}" type="button" data-sel-act="${act.select ? 'cancel' : 'start'}" aria-pressed="${act.select}">${ico('select')}<span>${act.select ? 'Done' : 'Select'}</span></button>
      ${nHidden ? `<button class="cc-chipbtn${act.showHidden ? ' on' : ''}" type="button" data-show-hidden="1" aria-pressed="${act.showHidden}">${ico(act.showHidden ? 'show' : 'hide')}<span>${act.showHidden ? 'Hide hidden' : `Show hidden (${nHidden})`}</span></button>` : ''}
      <span class="cc-actlegend" aria-label="Colours"><i class="lg-summarized"></i>Summary<i class="lg-always"></i>Always<i class="lg-out"></i>Left out<i class="lg-hidden"></i>Hidden</span>
    </div>`;
  }
  function countHidden() {
    const key = activeKey();
    let n = hiddenTurns(key).size;
    const md = memData(key);
    const segs = (md && md.data && md.data.memory && md.data.memory.segments) || [];
    for (const s of segs) if (segPick(key, `S${Number(s.fromTurn) || 0}-${Number(s.toTurn) || 0}`) === 'hidden') n++;
    return n;
  }

  /** Long press (touch / pen), right click and the context-menu key open a row's menu;
   * while selecting, a tap on a row toggles it. */
  function wireRowActions(body) {
    const LP_MS = 450;
    const cancelLp = () => { if (act.lp) { clearTimeout(act.lp.t); if (act.lp.el) act.lp.el.classList.remove('cc-pressing'); act.lp = null; } };
    body.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'mouse') return;
      const row = e.target.closest('[data-act-id]');
      if (!row || e.target.closest('input,button:not(.ct-title)')) return;
      cancelLp();
      row.classList.add('cc-pressing');
      act.lp = { el: row, x: e.clientX, y: e.clientY, t: setTimeout(() => { const el = row; cancelLp(); act.swallow = Date.now(); openMenu(el); }, LP_MS) };
    });
    body.addEventListener('pointermove', (e) => { if (act.lp && Math.hypot(e.clientX - act.lp.x, e.clientY - act.lp.y) > 8) cancelLp(); });
    ['pointerup', 'pointercancel', 'scroll'].forEach((t) => body.addEventListener(t, cancelLp, { passive: true }));
    body.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('[data-act-id]');
      if (!row) return;
      e.preventDefault();
      if (Date.now() - act.swallow < 800) return; // the long press already opened it
      openMenu(row);
    });
    body.addEventListener('click', (e) => {
      if (Date.now() - act.swallow < 600) { e.preventDefault(); e.stopPropagation(); act.swallow = 0; return; }
      const k = e.target.closest('[data-row-menu]');
      if (k) { e.preventDefault(); e.stopPropagation(); const row = k.closest('[data-act-id]'); if (row) openMenu(row, k); return; }
      if (act.select) {
        const row = e.target.closest('[data-act-id]');
        if (row && !e.target.closest('input,.cc-go,.cc-i,.cc-seg-modes,.ct-twisty,[data-tw]')) {
          e.preventDefault(); e.stopPropagation();
          const r = rowData(row);
          if (act.sel.has(r.id)) act.sel.delete(r.id); else act.sel.set(r.id, r);
          paint(true);
          return;
        }
      }
      const s = e.target.closest('[data-sel-act]');
      if (s) {
        e.stopPropagation();
        const a = s.dataset.selAct;
        if (a === 'start') { act.select = true; paint(true); return; }
        if (a === 'cancel') { endSelect(); return; }
        runAction(a, [...act.sel.values()]);
        return;
      }
      if (e.target.closest('[data-show-hidden]')) { e.stopPropagation(); act.showHidden = !act.showHidden; paint(true); }
    }, true);
    body.addEventListener('keydown', (e) => {
      const row = e.target.closest && e.target.closest('[data-act-id]');
      if (!row) return;
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenu(row); }
      else if (act.select && (e.key === ' ' || e.key === 'Enter') && e.target === row) { e.preventDefault(); const r = rowData(row); if (act.sel.has(r.id)) act.sel.delete(r.id); else act.sel.set(r.id, r); paint(true); }
      else if (e.key === 'Escape' && act.select) { e.stopPropagation(); endSelect(); }
    });
  }

  /* ---------- the same states in the chat itself ---------- */
  function turnMark(r) {
    if (hiddenTurns(r.key).has(r.n)) return 'hidden';
    const it = rowItem(r);
    const st = it ? stateOf(it) : 'in';
    if (st === 'out') return 'out';
    if (st === 'temp' || st === 'note') return 'summarized';
    return '';
  }
  /** Colour every message of the open chat by what the context does with its turn:
   * summarized (violet), always sent (blue), left out (grey, dimmed), hidden (amber),
   * being summarized (violet, pulsing). A deleted summary leaves no mark at all. */
  function paintMainMarks() {
    if (typeof document === 'undefined') return;
    const key = activeKey();
    const all = Array.from(document.querySelectorAll('.aui-user-message-root, .aui-assistant-message-root')).filter((el) => !el.closest('.ct-panel'));
    if (!key || !all.length) return;
    const marks = new Map(); // turn -> { m, label, first }
    const md = memData(key);
    const segs = (md && md.data && md.data.memory && md.data.memory.segments) || [];
    const raw = rawOf(key);
    segs.forEach((s, i) => {
      const a = Number(s.fromTurn) || 0, b = Number(s.toTurn) || a;
      const m = segMark(key, `S${a}-${b}`, modeOf(raw, a, b));
      if (m === 'deleted' || m === 'raw') return;
      for (let n = a; n <= b; n++) marks.set(n, { m, label: `${MARK_LABEL[m]} \u00b7 R${revOf(s, i)} \u00b7 turns ${a}\u2013${b}`, first: n === a });
    });
    for (const it of state.items) {
      if (kindOf(it) !== 'turn') continue;
      const n = turnOf(it);
      if (n == null) continue;
      const st = stateOf(it);
      if (st === 'out') marks.set(n, { m: 'out', label: 'Left out of the context', first: true });
      else if (st === 'temp') marks.set(n, { m: 'summarized', label: 'Summarized \u00b7 a summary stands in for it', first: true });
    }
    for (const n of hiddenTurns(key)) marks.set(n, { m: 'hidden', label: 'Hidden from the checklist \u00b7 left out', first: true });
    const pend = pendingSum.get(key);
    if (pend) {
      // Done once the engine shows those turns replaced (or left out).
      const done = [...pend].every((n) => { const x = marks.get(n); return x && (x.m === 'summarized' || x.m === 'out'); });
      if (done) pendingSum.delete(key);
      else for (const n of pend) if (!marks.has(n) || marks.get(n).m !== 'summarized') marks.set(n, { m: 'summarizing', label: 'Being summarized\u2026', first: true });
    }
    let n = 0;
    for (const el of all) {
      const user = el.classList.contains('aui-user-message-root');
      if (user) n++;
      const x = n ? marks.get(n) : null;
      const want = x ? x.m : '';
      if ((el.dataset.ccMark || '') !== want) { if (want) el.dataset.ccMark = want; else delete el.dataset.ccMark; }
      const label = user && x && x.first ? x.label : '';
      if ((el.dataset.ccLabel || '') !== label) { if (label) el.dataset.ccLabel = label; else delete el.dataset.ccLabel; }
      if (user) { const t = x ? x.label : ''; if ((el.getAttribute('title') || '') !== t && (t || el.hasAttribute('data-cc-title'))) { if (t) { el.setAttribute('title', t); el.setAttribute('data-cc-title', ''); } else { el.removeAttribute('title'); el.removeAttribute('data-cc-title'); } } }
    }
  }
  let marksQueued = false;
  const scheduleMarks = () => { if (marksQueued) return; marksQueued = true; (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(() => { marksQueued = false; try { paintMainMarks(); } catch (e) { /* never break the chat */ } }); };

  /** Whose brain the card shows: the main agent or one sub-agent (its own
   * checklist, summary and long-term memory), from the engine's `scope`. */
  function scopeInfo() {
    const key = memKey() || '';
    const sc = (state.memory && state.memory.scope && (!state.sessionKey || state.sessionKey === activeKey()) && key === activeKey()) ? state.memory.scope : null;
    const sub = sc ? sc.kind === 'subagent' : /^subagent:/.test(key);
    let name = sc && sc.name ? sc.name : '';
    if (!name && sub) {
      try {
        const it = appRef && appRef.chat && appRef.chat.items && appRef.chat.items.get && appRef.chat.items.get(key);
        name = (appRef && appRef.chat && appRef.chat.titles && appRef.chat.titles[key]) || (it && it.title) || '';
      } catch (e) { /* no chat list */ }
    }
    return { sub, key, name: name || (sub ? key.replace(/^subagent:/, '') : 'Main agent'), mode: (sc && sc.mode) || (sub ? 'private' : ''), readsParent: !!(sc && sc.readsParent) };
  }
  const MODE_LABEL = { private: 'Own memory', read_parent: 'Own memory \u00b7 reads parent', shared: 'Shares parent memory' };
  const MODE_HINT = {
    private: 'Its checklist, summary and long-term memory are its own. Nothing from the main chat or other sub-agents is sent.',
    read_parent: 'Its checklist, summary and long-term memory are its own. The parent\u2019s long-term memory is shown read-only, in its own group.',
    shared: 'Its checklist and summary are its own; it reads and writes its parent\u2019s long-term memory.',
  };
  function scopeHead() {
    const s = scopeInfo();
    if (!s.sub) return '';
    const short = s.key.replace(/^subagent:/, '').slice(0, 8);
    return `<div class="cc-scope" role="status" data-slot="brain-scope" data-scope="subagent" data-mode="${esc(s.mode)}">
      <span class="cc-scope-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 8V4H8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4" y="8" width="16" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 13v2M15 13v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
      <span class="cc-scope-txt"><span class="cc-scope-name">${esc(clip(s.name, 40))}</span><span class="cc-scope-sub">Sub-agent session \u00b7 ${esc(short)}</span></span>
      <span class="cc-badge cc-scope-mode" title="${esc(MODE_HINT[s.mode] || '')}">${esc(MODE_LABEL[s.mode] || 'Own memory')}</span>
    </div>`;
  }

  function tabItems() {
    // Always on: there is no "off" screen and no "Turn on" button.
    return `${errorNote()}${scopeHead()}${stageNote()}${meter()}${actionsTop(countHidden())}<div class="cc-tree ct-list${act.select ? ' cc-selecting' : ''}" role="tree" aria-label="Checklist"${act.select ? ' aria-multiselectable="true"' : ''}>${tree()}</div>${resetNote()}${selectBar()}`;
  }

  /** Every range with its version and changes, and what the request sends
   * for it (summary, original turns, or both). */
  function rangesBlock(key, m) {
    const segs = m && Array.isArray(m.segments) ? m.segments : [];
    if (!segs.length) return '';
    const raw = rawOf(key);
    const plan = raw.plan || {};
    const rawN = Array.isArray(plan.rawTurns) ? plan.rawTurns.length : 0;
    const rows = segs.map((seg, i) => {
      const a = Number(seg.fromTurn) || 0, b = Number(seg.toTurn) || a;
      const mode = modeOf(raw, a, b);
      const id = `rng/${a}-${b}`;
      const open = panel.expanded.has(id);
      return `<li class="cc-range cc-mode-${esc(mode)}" data-range="${a}-${b}"><div class="cc-row cc-g-summary">${twisty(id, `range ${a} to ${b}`)}<span class="cc-rev">R${revOf(seg, i)}</span><span class="cc-num">${a === b ? a : a + '\u2013' + b}</span><span class="ct-title">${esc(clip(seg.title || seg.topic || seg.summary, 50))}</span>${(seg.changes || []).length ? `<span class="cc-badge cc-chg-badge">\u0394${seg.changes.filter((c) => c.kind !== 'more').length}</span>` : ''}<span class="cc-badge">${esc(mode === 'summary' ? 'summary' : mode === 'raw' ? 'original' : 'both')}</span></div>
        ${open ? `<div class="cc-detail cc-g-summary"><p class="cc-seg-text">${esc(seg.summary || '')}</p><p class="cc-seg-meta">${[seg.baseVersion ? `built on v${seg.baseVersion}` : '', seg.topic ? '#' + seg.topic : '', seg.createdAt ? when(seg.createdAt) : ''].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</p>${changesList(seg) || '<p class="cc-none">No changes to earlier ranges</p>'}</div>` : ''}</li>`;
    }).join('');
    const reset = rawN || raw.ranges.length ? `<button class="cc-link" type="button" data-raw-clear="1" data-key="${esc(key)}">All summaries</button>` : '';
    return `<div class="cc-sec"><div class="cc-sec-head"><span class="cc-sec-name">Ranges</span><span class="cc-when">${segs.length}${rawN ? ` \u00b7 ${rawN} original turn${rawN === 1 ? '' : 's'} sent` : ''}${plan.capped ? ` \u00b7 ${esc(plan.capped)} capped` : ''}</span>${reset}${infoBtn('ranges')}</div>${tip('ranges')}<ol class="cc-ranges">${rows}</ol></div>`;
  }

  /** Everything the memory record stores, as saved: the scalars as a compact
   * list and the whole record on demand. */
  function dataBlock(d, m) {
    if (!m) return '';
    const items = Array.isArray(m.items) ? m.items : [];
    const byKind = {};
    for (const it of items) { const k = `${it.kind}/${it.status}`; byKind[k] = (byKind[k] || 0) + 1; }
    const kv = [
      ['Memory version', m.version], ['Summarized through', m.throughTurn ? `turn ${m.throughTurn}` : ''], ['Ranges', (m.segments || []).length],
      ['Decisions', `${(m.decisions && m.decisions.current || []).length} current \u00b7 ${(m.decisions && m.decisions.superseded || []).length} replaced`],
      ['Records', Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(' \u00b7 ')], ['Next ids', `D${m.nextDecision || 1} \u00b7 #${m.nextItem || 1}`],
      ['Summary calls', m.calls], ['Schema', m.schemaVersion], ['Updated', m.updatedAt ? when(m.updatedAt) : ''],
      ['Recovered from', m.recoveredFrom ? `v${m.recoveredFrom}` : ''], ['Unreadable', m.unreadable ? 'yes' : ''],
      ['Settings', d.settings ? Object.entries(d.settings).map(([k, v]) => `${k} ${v}`).join(' \u00b7 ') : ''],
      ['Status', d.status ? [d.status.status, d.status.reason].filter(Boolean).join(' \u00b7 ') : ''],
      ['Storage', d.storage ? Object.entries(d.storage).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k} ${v}`).join(' \u00b7 ') : ''],
    ].filter(([, v]) => v !== '' && v != null && v !== 0);
    const openAll = panel.detailsOpen && panel.detailsOpen.rawjson;
    return `<details class="cc-more" data-key="data"${panel.detailsOpen && panel.detailsOpen.data ? ' open' : ''}><summary>Saved data</summary>${tip('data')}
      <dl class="cc-kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <details class="cc-more cc-more-in" data-key="rawjson"${openAll ? ' open' : ''}><summary>Full record</summary>${openAll ? `<pre class="cc-pre cc-json">${esc(JSON.stringify(m, null, 1))}</pre>` : ''}</details>
    </details>`;
  }

  function tabSummary() {
    const key = memKey();
    const md = memData();
    const d = md && md.data;
    const m = d && d.memory;
    const at = m && (m.updatedAt || m.createdAt);
    const sub = panel.memKey ? `<div class="cc-sub-note" role="status"><span class="cc-badge">Sub-agent</span><span class="ct-title">${esc(clip(String(panel.memKey).replace(/^subagent:/, ''), 40))}</span><button class="cc-link" type="button" data-mem-back="1">This chat</button></div>` : scopeHead();
    const head = `${sub}<div class="cc-sumhead"><span class="cc-badge cc-always">Chosen per request</span>${m && m.throughTurn ? `<span class="cc-when">Turns 1\u2013${esc(num(m.throughTurn))}</span>` : ''}${m && m.version ? `<span class="cc-when">v${esc(num(m.version))}</span>` : ''}${at ? `<span class="cc-when" data-slot="summary-created">${esc(when(at))}</span>` : ''}${infoBtn('summary')}</div>${tip('summary')}`;
    if (!memApi()) return head + '<p class="ct-empty">No summary yet.</p>';
    return `${head}<div class="cc-mem" data-mem="summary"></div>${rangesBlock(key, m)}${d ? dataBlock(d, m) : ''}
      <details class="cc-more" data-key="versions"${panel.detailsOpen && panel.detailsOpen.versions ? ' open' : ''}><summary>Versions</summary><div class="cc-mem" data-mem="history"></div></details>`;
  }

  /** Activity: the selection breakdown, then requests, policy, savings and window changes. */
  function tabActivity() {
    return `${errorNote()}${selectionSummary()}${requestsBlock()}${activityBlock()}`;
  }

  function tabSettings() {
    const unknown = settings == null;
    return `${errorNote()}${scopeHead()}
      <div class="cc-set"><span class="cc-set-name">Context checklist</span>${infoBtn('tree')}
        <span class="cc-badge cc-always-on" role="status" aria-label="Always on"${unknown ? ' data-unknown="true"' : ''}>Always on</span></div>${tip('tree')}
      ${policyOn() ? '<div class="cc-set"><span class="cc-set-name">Context Policies</span><button class="cc-btn cc-btn-quiet" type="button" data-cp-open="1">Open</button></div>' : ''}
      <div class="cc-set"><span class="cc-set-name">Reset tree</span>${infoBtn('reset')}<button class="ct-reset-btn cc-btn cc-btn-quiet" type="button"${busyAttr('reset')}>${busy === 'reset' ? 'Resetting\u2026' : 'Reset'}</button></div>${tip('reset')}
      ${resetNote()}
      ${memApi() ? `<div class="cc-mem cc-mem-settings" data-mem="settings"></div>` : ''}`;
  }

  /** The current tab's content (also what tests read). */
  function render() {
    const t = panel.tab;
    if (t === 'policy' && policyOn()) return '<div class="cc-policy" data-cp-host></div>';
    return t === 'summary' ? tabSummary() : t === 'activity' ? tabActivity() : t === 'settings' ? tabSettings() : tabItems();
  }

  /** Fill the Chat memory parts (summary, versions, settings) the card reuses. */
  function hydrate(root) {
    if (root && panel.tab === 'policy') {
      const host = root.querySelector('[data-cp-host]');
      const cp = policyApi();
      if (host && cp) { try { cp.paintTab(host); } catch (e) { console.warn('context card policy', e); } }
      return;
    }
    const cm = memApi();
    const key = memKey();
    if (!cm || !key || !root) return;
    for (const el of root.querySelectorAll('[data-mem]')) {
      const what = el.getAttribute('data-mem');
      try {
        if (what === 'summary' && cm.paintSummary) cm.paintSummary(key, el, { index: false });
        else if (what === 'history' && cm.paintHistory) cm.paintHistory(key, el, () => paint(true));
        else if (what === 'settings' && cm.paintSettings) cm.paintSettings(key, el, () => paint(true));
        else if (what === 'results' && cm.paintResults) cm.paintResults(key, el);
      } catch (e) { console.warn('context card memory', e); }
    }
  }

  function paintTabs() {
    if (!panel.tabs) return;
    if (panel.tabs.children.length !== tabList().length) {
      panel.tabs.innerHTML = tabList().map(([k, label]) => `<button class="cc-tab" type="button" role="tab" id="cc-tab-${k}" data-tab="${k}" aria-controls="cc-body" aria-selected="false" tabindex="-1">${label}</button>`).join('');
    }
    for (const b of panel.tabs.querySelectorAll('[data-tab]')) {
      const on = b.getAttribute('data-tab') === panel.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (panel.body) panel.body.setAttribute('aria-labelledby', `cc-tab-${panel.tab}`);
  }

  function paint(force) {
    if (panel.body && !force && panel.open && panel.tab === 'policy') return; // the policy view paints itself
    if (panel.body && !force && panel.open && (panel.tab === 'settings' || panel.tab === 'summary')) {
      // Do not repaint a form under the person's fingers.
      const a = document.activeElement;
      if (a && panel.body.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    }
    if (panel.body && !force && clForm) {
      const a = document.activeElement;
      if (a && panel.body.contains(a) && a.closest && a.closest('.cc-clform')) return;
    }
    const html = (() => { try { return render(); } catch (e) { console.warn('context card paint', e); return null; } })();
    if (html == null) return;
    if (panel.body) {
      const sc = panel.body.scrollTop;
      panel.body.innerHTML = html;
      hydrate(panel.body);
      scheduleMarks();
      panel.body.scrollTop = sc;
    }
    paintTabs();
  }

  function setTab(t, focus) {
    if (!tabList().some(([k]) => k === t)) t = 'items';
    panel.tab = t;
    paint(true);
    if (panel.body) panel.body.scrollTop = 0;
    if (t === 'summary' || t === 'settings') { const cm = memApi(); const k = memKey(); if (cm && k && cm.refresh) Promise.resolve(cm.refresh(k)).then(() => paint(true)).catch(() => {}); }
    if (focus && panel.tabs) { const b = panel.tabs.querySelector(`[data-tab="${t}"]`); if (b) b.focus(); }
  }

  function onBodyClick(ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!t) return;
    if (t.dataset.cpOpen) { const cp = policyApi(); if (cp) cp.open(); return; }
    if (t.dataset.clNew != null) { openClForm('new', '', []); return; }
    if (t.dataset.clSave != null) { saveClForm(); return; }
    if (t.dataset.clCancel != null) { clForm = null; paint(true); return; }
    if (t.dataset.clRemove) { clOp('remove', { id: t.dataset.clList, items: [t.dataset.clRemove] }); return; }
    if (t.dataset.clMenu) { openClMenu(t.dataset.clMenu, t); return; }
    if (t.dataset.info) { const k = t.dataset.info; if (panel.tips.has(k)) panel.tips.delete(k); else panel.tips.add(k); paint(true); return; }
    if (t.dataset.tw) {
      const k = t.dataset.tw;
      if (panel.expanded.has(k)) panel.expanded.delete(k); else panel.expanded.add(k);
      if (k.startsWith('conv/') && k !== 'conv/current' && panel.expanded.has(k)) loadConv(k.slice(5));
      paint(true);
      return;
    }
    if (t.dataset.rawMode) {
      const [a, b] = t.dataset.rawRange.split('-').map(Number);
      setRaw(t.dataset.key || activeKey(), { range: [a, b], mode: t.dataset.rawMode });
      return;
    }
    if (t.dataset.rawClear) { setRaw(t.dataset.key || memKey(), { clear: true }); return; }
    if (t.dataset.memBack) { panel.memKey = null; setTab('summary'); return; }
    if (t.dataset.openConv) { openConversation(t.dataset.openConv); return; }
    if (t.dataset.convRetry) { loadConv(t.dataset.convRetry, true); return; }
    if (t.dataset.goTurn) { goToTurn(Number(t.dataset.goTurn), t.dataset.goTitle || '', t.dataset.goKey || ''); return; }
    if (t.dataset.tabGo) { setTab(t.dataset.tabGo, true); return; }
    if (t.dataset.openResult) { const cm = memApi(); const k = t.dataset.key || activeKey(); if (cm && cm.openResult && k) cm.openResult(k, t.dataset.openResult); return; }
    const c = t.classList;
    if (t.dataset.memOp) { t.disabled = true; setMemory(t.dataset.rid, t.dataset.memOp); return; }
    if (c.contains('ct-reset-btn')) { t.disabled = true; resetTree(); }
    else if (c.contains('ct-retry')) { t.disabled = true; lastError = null; paint(true); refresh(); }
  }
  function onBodyChange(ev) {
    const t = ev.target;
    if (t && t.classList && t.classList.contains('cc-mem-check')) setMemory(t.dataset.rid, t.checked ? 'include' : 'exclude');
    else if (t && t.classList && t.classList.contains('cc-seg-check')) {
      // A range summary's own row in the memory checklist (`mem/S<from>-<to>`): unticked, the
      // engine leaves that summary out of every request (even when relevant); ticked, it always goes.
      const k = t.dataset.key || activeKey();
      const rid = t.dataset.segRid;
      segPicks.set(`${k}|${rid}`, t.checked ? 'in' : 'out');
      setMemory(rid, t.checked ? 'include' : 'exclude', k);
    }
    else if (t && t.classList && t.classList.contains('cc-cl-check')) clOp(t.checked ? 'include' : 'exclude', { id: t.dataset.clId });
    else if (t && t.classList && t.classList.contains('ct-check')) setItem(t.dataset.id, !!t.checked, t.dataset.key || '');
    else if (t && t.classList && t.classList.contains('cc-raw-check')) setRaw(t.dataset.key || activeKey(), { turn: Number(t.dataset.rawTurn), raw: !!t.checked });
  }
  function onToggleDetails(ev) {
    const d = ev.target;
    if (d && d.tagName === 'DETAILS' && d.dataset.key) {
      const was = !!(panel.detailsOpen || {})[d.dataset.key];
      (panel.detailsOpen ||= {})[d.dataset.key] = d.open;
      // The full record is drawn only while it is open.
      if (d.dataset.key === 'rawjson' && was !== d.open) paint(true);
    }
  }

  /** The composer the card belongs to: it opens just above the message box. */
  function composerShell(anchor) {
    return (anchor && anchor.closest && anchor.closest('.aui-composer-shell'))
      || document.querySelector('.aui-composer-root .aui-composer-shell, .aui-composer-shell')
      || null;
  }

  /** Build the card once. */
  function ensureSheet() {
    if (panel.root) return panel.root;
    const root = document.createElement('div');
    root.className = 'ct-panel cc-card';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', 'Context');
    root.hidden = true;
    root.innerHTML = `<div class="cc-top">
        <div class="cc-tabs" role="tablist" aria-label="Context">${tabList().map(([k, label]) => `<button class="cc-tab" type="button" role="tab" id="cc-tab-${k}" data-tab="${k}" aria-controls="cc-body" aria-selected="false" tabindex="-1">${label}</button>`).join('')}</div>
        <button class="ct-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <div class="ct-body cc-body" id="cc-body" role="tabpanel" tabindex="-1"></div>`;
    const body = root.querySelector('.ct-body');
    const tabs = root.querySelector('.cc-tabs');
    root.querySelector('.ct-close').addEventListener('click', () => close(true));
    // A tap or click moves focus to the tapped tab (iOS and some webviews leave it on the
    // old one), and without the ring: only the keyboard shows a focus ring.
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-tab]');
      if (!b) return;
      setTab(b.getAttribute('data-tab'));
      const nb = tabs.querySelector(`[data-tab="${b.getAttribute('data-tab')}"]`) || b;
      try { nb.focus({ preventScroll: true, focusVisible: false }); } catch (err) { /* old webview */ }
    });
    root.addEventListener('pointerdown', () => setKbd(false), true);
    tabs.addEventListener('keydown', (e) => {
      const i = tabList().findIndex(([k]) => k === panel.tab);
      const n = e.key === 'ArrowRight' ? (i + 1) % tabList().length : e.key === 'ArrowLeft' ? (i - 1 + tabList().length) % tabList().length : e.key === 'Home' ? 0 : e.key === 'End' ? tabList().length - 1 : -1;
      if (n < 0) return;
      e.preventDefault();
      setTab(tabList()[n][0], true);
    });
    wireRowActions(body);
    body.addEventListener('click', onBodyClick);
    body.addEventListener('change', onBodyChange);
    body.addEventListener('toggle', onToggleDetails, true);
    panel.root = root;
    panel.body = body;
    panel.tabs = tabs;
    return root;
  }

  /** Fixed on the page, beside the composer, and always inside the visible
   * viewport (the keyboard and the safe areas included): it opens on the side
   * with more room, its height is capped to that room and its body scrolls. */
  function place(anchor) {
    const root = ensureSheet();
    if (root.parentNode !== document.body) document.body.appendChild(root);
    const header = (anchor || panel.anchor)?.closest?.('.topbar') || null;
    const shell = header ? null : composerShell(anchor || panel.anchor);
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const vw = Math.round(vv ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 360));
    const vTop = vv ? vv.offsetTop : 0;
    const vLeft = vv ? vv.offsetLeft : 0;
    const vBottom = vTop + (vv ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 640));
    const m = 8;
    const w = Math.max(200, Math.min(420, vw - 2 * m));
    const r = shell ? shell.getBoundingClientRect() : null;
    let left = r ? r.left : vLeft + (vw - w) / 2;
    left = Math.max(vLeft + m, Math.min(left, vLeft + vw - w - m));
    const s = root.style;
    if (header) {
      // Opened from the brain button: a sheet below the top bar, aligned to its right edge,
      // with margins on every side and its body scrolling inside the visible viewport.
      const hr = header.getBoundingClientRect();
      const ww = Math.max(220, Math.min(440, vw - 2 * m));
      const l = Math.max(vLeft + m, Math.min(hr.right - ww - m, vLeft + vw - ww - m));
      root.dataset.place = 'header';
      root.dataset.side = 'below';
      s.width = `${ww}px`; s.left = `${Math.round(l)}px`;
      const top = Math.round(Math.max(hr.bottom, vTop) + m);
      s.top = `${top}px`; s.bottom = 'auto';
      s.maxHeight = `${Math.max(200, Math.floor(vBottom - top - m - 12))}px`;
      return;
    }
    root.dataset.place = shell ? 'composer' : 'float';
    root.style.width = `${w}px`;
    root.style.left = `${Math.round(left)}px`;
    if (!r) {
      root.dataset.side = 'center';
      s.top = `${Math.round(vTop + m)}px`; s.bottom = 'auto';
      s.maxHeight = `${Math.max(160, Math.floor(vBottom - vTop - 2 * m))}px`;
      return;
    }
    const above = Math.floor(Math.min(r.top, vBottom) - vTop - 2 * m);
    const below = Math.floor(vBottom - Math.max(r.bottom, vTop) - 2 * m);
    const side = above >= 240 || above >= below ? 'above' : 'below';
    root.dataset.side = side;
    const room = Math.max(160, Math.min(side === 'above' ? above : below, Math.floor((vBottom - vTop) * 0.8)));
    s.maxHeight = `${room}px`;
    const layoutH = window.innerHeight || document.documentElement.clientHeight || 0;
    if (side === 'above') { s.top = 'auto'; s.bottom = `${Math.round(layoutH - Math.min(r.top, vBottom) + m)}px`; }
    else { s.bottom = 'auto'; s.top = `${Math.round(Math.max(r.bottom, vTop) + m)}px`; }
  }
  const replace = () => { if (panel.open) place(panel.anchor); };

  function onKey(e) {
    if (/^(Tab|Arrow|Home$|End$|Enter$| $)/.test(e.key)) setKbd(true);
    if (e.key === 'Escape' && panel.open) {
      e.stopPropagation();
      // Escape peels one layer at a time: the menu, then selecting, then the card.
      if (act.menu) { e.preventDefault(); closeMenu(true); return; }
      if (act.select) { e.preventDefault(); endSelect(); return; }
      close(true);
    }
  }
  /** Whether the person is using the keyboard: only then the card shows focus rings. */
  let usingKbd = false;
  try {
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', (e) => { if (/^(Tab|Arrow|Home$|End$)/.test(e.key)) usingKbd = true; }, true);
      document.addEventListener('pointerdown', () => { usingKbd = false; }, true);
    }
  } catch (e) { /* no document */ }
  function setKbd(on) {
    usingKbd = !!on;
    if (panel.root) { if (usingKbd) panel.root.setAttribute('data-kbd', ''); else panel.root.removeAttribute('data-kbd'); }
  }
  function onOutside(e) {
    if (!panel.open || !panel.root) return;
    const t = e.target;
    if (panel.root.contains(t)) return;
    if (t && t.closest && t.closest('[data-slot="context-button"], .ct-toggle, .modal-backdrop, [role="dialog"]')) return;
    close(false);
  }

  /** Open the card. `tab` picks the tab: items (default), summary, log, settings.
   * `key` names another chat's memory for the Summary and Settings tabs (a
   * sub-agent's "Open full memory"); without it they show the open chat. */
  function open(anchor, tab, key) {
    if (!available()) return;
    panel.memKey = key && key !== activeKey() ? String(key) : null;
    panel.anchor = (anchor && anchor.nodeType === 1 ? anchor : null) || document.querySelector('[data-slot="context-button"]') || document.querySelector('.ct-toggle');
    if (typeof anchor === 'string') tab = anchor;
    if (tab) panel.tab = tabList().some(([k]) => k === tab) ? tab : 'items';
    place(panel.anchor);
    panel.open = true;
    panel.root.hidden = false;
    syncExpanded();
    setTab(panel.tab);
    refresh();
    { const cp = policyApi(); if (cp && cp.refresh && policyOn() && panel.tab !== 'policy') Promise.resolve(cp.refresh()).catch(() => {}); }
    const cm = memApi(); const k = memKey();
    if (cm && k && cm.refresh) Promise.resolve(cm.refresh(k)).then(() => paint()).catch(() => {});
    if (panel.memKey && cm && cm.refresh && activeKey()) Promise.resolve(cm.refresh(activeKey())).catch(() => {});
    // Opened with the keyboard: focus goes to the selected tab, with its ring. Opened by a
    // tap: focus goes to the card's body, so no tab keeps a ring that looks like a second selection.
    setKbd(usingKbd);
    try {
      const b = panel.tabs.querySelector('[aria-selected="true"]');
      if (usingKbd && b) b.focus({ preventScroll: true });
      else panel.body.focus({ preventScroll: true, focusVisible: false });
    } catch (e) { /* old webview */ }
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', replace);
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', replace); window.visualViewport.addEventListener('scroll', replace); }
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }

  function close(focusBack) {
    if (!panel.root) return;
    closeMenu(false);
    flushUndo();
    panel.open = false;
    panel.root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', replace);
    if (window.visualViewport) { window.visualViewport.removeEventListener('resize', replace); window.visualViewport.removeEventListener('scroll', replace); }
    syncExpanded();
    if (focusBack && panel.anchor && panel.anchor.isConnected) { try { panel.anchor.focus(); } catch (e) { /* gone */ } }
  }

  function toggle(anchor, tab) {
    if (panel.open) close(true);
    else open(anchor, tab);
  }

  function syncExpanded() {
    for (const b of document.querySelectorAll('[data-slot="context-button"], .ct-toggle')) {
      b.setAttribute('aria-expanded', String(!!panel.open));
      b.setAttribute('aria-controls', 'cc-body');
    }
  }

  /** The context card opens from the brain button in the top bar (TokenMeter adds it);
   * the composer has no context chip any more. Old chips are removed. */
  function attachToggles() {
    for (const old of document.querySelectorAll('.aui-composer-root .ct-toggle')) old.remove();
    if (typeof TokenMeter !== 'undefined' && TokenMeter.attach) TokenMeter.attach();
  }

  /** Make the card ready (closed) and the composer chip. */
  function mount() {
    if (!available()) return;
    ensureSheet();
    if (!panel.root.parentNode) document.body.appendChild(panel.root);
    attachToggles();
    const cm = memApi();
    if (cm && cm.subscribe && !panel.memSub) panel.memSub = cm.subscribe((k) => { if (panel.open && (k === activeKey() || k === panel.memKey || convs.has(k))) paint(); });
    // Activity shows the policy's requests and savings: repaint when they change.
    const cp = policyApi();
    if (cp && cp.subscribe && !panel.cpSub) panel.cpSub = cp.subscribe(() => { if (panel.open && panel.tab === 'activity') paint(); });
    paint();
  }

  /** `#` in the composer lists the checklist's records by tag (newest
   * memory snapshot), so the user names stored data the way the model does:
   * the last #tag of a record is where its context is sent, once. */
  function memoryTagNames() {
    const m = state.memory;
    if (!m || !Array.isArray(m.groups)) return [];
    const out = [];
    for (const g of m.groups) {
      (g.items || []).forEach((r) => { if (r && r.tag) out.push({ tag: String(r.tag).replace(/^#/, ''), title: String(r.title || r.line || ''), group: String(g.title || '') }); });
    }
    const seen = new Set();
    return out.filter((x) => (seen.has(x.tag.toLowerCase()) ? false : seen.add(x.tag.toLowerCase())));
  }

  let tagPop = null;
  function closeTagPop() { if (tagPop) { tagPop.remove(); tagPop = null; } }
  function onComposerInput(e) {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement) || !el.classList.contains('aui-composer-input')) return;
    const upto = el.value.slice(0, el.selectionStart || 0);
    const mt = /(?:^|\s)#([\w./@-]{0,40})$/.exec(upto);
    if (!mt) return closeTagPop();
    const q = mt[1].toLowerCase();
    const hits = memoryTagNames().filter((x) => x.tag.toLowerCase().startsWith(q) || x.title.toLowerCase().includes(q)).slice(0, 8);
    if (!hits.length) return closeTagPop();
    closeTagPop();
    tagPop = document.createElement('div');
    tagPop.className = 'cc-tag-pop';
    tagPop.setAttribute('role', 'listbox');
    tagPop.innerHTML = hits.map((h) => `<button type="button" role="option" data-tag="${esc(h.tag)}"><b>#${esc(h.tag)}</b> <span>${esc(h.group)} \u00b7 ${esc(h.title.slice(0, 60))}</span></button>`).join('');
    tagPop.addEventListener('pointerdown', (ev) => {
      const b = ev.target.closest('button[data-tag]');
      if (!b) return;
      ev.preventDefault();
      const pos = el.selectionStart || 0;
      const start = pos - mt[1].length;
      const ins = b.dataset.tag + ' ';
      el.value = el.value.slice(0, start) + ins + el.value.slice(pos);
      el.selectionStart = el.selectionEnd = start + ins.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      closeTagPop();
      el.focus();
    });
    const shell = el.closest('.aui-composer-root') || el.parentElement;
    shell.appendChild(tagPop);
  }

  // ── #tags inside the chat's messages: each known tag is shown by its state
  // in the checklist (active, inactive, removed, or a record not tagged yet),
  // and the LAST active mention of a record is marked as the one place its
  // context is sent; every earlier mention only refers to it. Tapping a tag
  // makes it inactive, or active again (same ctx.set as the panel).
  const TAG_IN_TEXT = /(^|[^\w&#/])#([A-Za-z0-9][A-Za-z0-9_.:/\-]{0,100})(@v(\d{1,5}))?/g;
  const TAG_STATES = { active: 'active tag', inactive: 'inactive tag (context not sent)', removed: 'removed tag', untagged: 'record in the checklist' };

  /** tag (lowercase, no #) -> { rid, state } from the newest memory snapshot. */
  function chatTagIndex() {
    const m = state.memory;
    const idx = new Map();
    if (!m || typeof m !== 'object') return idx;
    const key = (s) => String(s || '').replace(/^#/, '').toLowerCase();
    (Array.isArray(m.groups) ? m.groups : []).forEach((g) => (Array.isArray(g && g.items) ? g.items : []).forEach((r) => {
      if (!r || !r.rid) return;
      const st = r.tagState || 'untagged';
      [r.tag, r.rid, ...(Array.isArray(r.aliases) ? r.aliases : [])].map(key).filter(Boolean).forEach((k) => { if (!idx.has(k)) idx.set(k, { rid: String(r.rid), tag: key(r.tag) || key(r.rid), state: st }); });
    }));
    (Array.isArray(m.tags) ? m.tags : []).forEach((t) => {
      const k = key(t && t.tag);
      if (k) idx.set(k, { rid: String(t.rid), tag: k, state: t.state || 'active' });
    });
    return idx;
  }

  function lookupTag(idx, raw) {
    let k = String(raw || '').replace(/[.,;:)!?/]+$/, '').toLowerCase();
    if (k.startsWith('mem/')) k = k.slice(4);
    return { k, hit: idx.get(k) };
  }

  /** Wrap the known #tags of rendered messages and colour them. Idempotent:
   * wrapped tags are not wrapped again, only their state is refreshed.
   * Returns how many tags are marked. */
  function decorateChatTags(root) {
    if (typeof document === 'undefined') return 0;
    const scope = root || document;
    const idx = chatTagIndex();
    if (!idx.size) return 0;
    const mds = scope.querySelectorAll ? scope.querySelectorAll('.aui-md') : [];
    mds.forEach((md) => {
      if (md.closest('.cc-sheet, .cc-panel, [data-context-panel]')) return;
      const walker = document.createTreeWalker(md, 4 /* text */, {
        acceptNode: (n) => (n.nodeValue && n.nodeValue.includes('#') && n.parentElement && !n.parentElement.closest('code, pre, a, button, textarea, .cc-chat-tag') ? 1 : 3),
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((n) => {
        const text = n.nodeValue;
        TAG_IN_TEXT.lastIndex = 0;
        let mt; let at = 0; let any = false;
        const frag = document.createDocumentFragment();
        while ((mt = TAG_IN_TEXT.exec(text))) {
          const raw = mt[2];
          const trimmed = raw.replace(/[.,;:)!?/]+$/, '');
          const { hit } = lookupTag(idx, trimmed);
          if (!hit) continue;
          any = true;
          const start = mt.index + mt[1].length;
          const ver = raw === trimmed ? (mt[3] || '') : '';
          const word = '#' + trimmed + ver;
          frag.appendChild(document.createTextNode(text.slice(at, start)));
          const s = document.createElement('span');
          s.className = 'cc-chat-tag';
          s.dataset.rid = hit.rid;
          s.dataset.key = lookupTag(idx, trimmed).k;
          if (ver) s.dataset.version = ver.slice(2);
          s.setAttribute('role', 'button');
          s.tabIndex = 0;
          s.textContent = word;
          frag.appendChild(s);
          at = start + word.length;
        }
        if (!any) return;
        frag.appendChild(document.createTextNode(text.slice(at)));
        n.parentNode.replaceChild(frag, n);
      });
    });
    // States, and the last active mention of each record (document order).
    const spans = document.querySelectorAll('.aui-md .cc-chat-tag');
    const last = new Map();
    spans.forEach((s) => {
      const hit = idx.get(s.dataset.key);
      const st = hit ? hit.state : 'untagged';
      s.dataset.state = st;
      s.className = `cc-chat-tag cc-tag-${st}`;
      if (pendingMem.has(s.dataset.rid)) s.classList.add('cc-chat-tag-pending');
      if (st === 'active') last.set(s.dataset.rid, s);
    });
    spans.forEach((s) => {
      const isLast = last.get(s.dataset.rid) === s;
      if (s.dataset.state === 'active') s.classList.add(isLast ? 'cc-chat-tag-last' : 'cc-chat-tag-ref');
      const what = TAG_STATES[s.dataset.state] || s.dataset.state;
      const where = s.dataset.state === 'active' ? (isLast ? ' \u00b7 its context is sent here, once' : ' \u00b7 refers to the last mention') : '';
      const act = s.dataset.state === 'active' ? 'Tap to make it inactive' : (s.dataset.state === 'untagged' ? '' : 'Tap to make it active again');
      s.title = `${s.dataset.rid}${s.dataset.version ? ' @v' + s.dataset.version : ''} \u00b7 ${what}${where}${act ? ' \u00b7 ' + act : ''}`;
    });
    return spans.length;
  }

  function onChatTagActivate(e) {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    const s = e.target && e.target.closest ? e.target.closest('.aui-md .cc-chat-tag') : null;
    if (!s || !s.dataset.rid) return;
    const st = s.dataset.state;
    if (st === 'untagged' || pendingMem.has(s.dataset.rid)) return;
    e.preventDefault();
    e.stopPropagation();
    setMemory(s.dataset.rid, st === 'active' ? 'inactive' : 'active');
  }

  let tagTimer = null;
  function scheduleChatTags() {
    if (tagTimer) return;
    tagTimer = setTimeout(() => { tagTimer = null; try { decorateChatTags(); } catch (e) { console.warn('chat tags', e); } try { paintMainMarks(); } catch (e) { console.warn('chat marks', e); } }, 120);
  }

  /** Wire the panel to the engine's event stream, once. Called with the app
   * (`ContextTree.install(app)`); the events arrive on `app.chat._onEvent` with
   * their name in `eventType`, like every other engine event. */
  function install(app) {
    try {
      if (!document._ctChatTags && typeof MutationObserver !== 'undefined' && document.body) {
        document._ctChatTags = true;
        new MutationObserver(scheduleChatTags).observe(document.body, { childList: true, subtree: true, characterData: true });
        document.addEventListener('click', onChatTagActivate, true);
        document.addEventListener('keydown', onChatTagActivate, true);
        subs.add(scheduleChatTags);
      }
      if (!document._ctTagPop) {
        document._ctTagPop = true;
        document.addEventListener('input', onComposerInput, true);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTagPop(); }, true);
        document.addEventListener('focusout', (e) => { if (e.target && e.target.classList && e.target.classList.contains('aui-composer-input')) setTimeout(closeTagPop, 150); }, true);
      }
      if (app && app.chat) appRef = app;
      const runtime = (app && app.chat) || app;
      if (runtime && typeof runtime._onEvent === 'function' && !runtime._ctWrapped) {
        const base = runtime._onEvent.bind(runtime);
        runtime._ctWrapped = true;
        runtime._onEvent = (event) => {
          const type = event && (event.eventType || event.type || event.name);
          if (typeof type === 'string' && type.startsWith('context.')) {
            const p = parseMaybeJSON(event.payloadJson ?? event.payload ?? event.data, null);
            const key = p && p.sessionKey;
            // Only the open chat's tree is shown; a sub-agent's or another chat's
            // event does not overwrite it.
            if (!key || !activeKey() || key === activeKey()) {
              try { onEvent(type, p); } catch (e) { console.warn('context tree', e); }
            } else if (convs.has(key) && Array.isArray(p.items)) {
              // Another stored chat that is open in the card: keep its rows current.
              const c = convs.get(key);
              c.items = p.items.map((it) => ({ ...it, _key: key }));
              if (p.tokens) c.tokens = p.tokens;
              if (p.counts) c.counts = p.counts;
              if (panel.open) paint();
            }
          }
          return base(event);
        };
        if (typeof runtime.on === 'function') {
          runtime.on('main', () => { state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: '', memory: null, requests: null, checklists: { user: [], ai: [] } }; pendingSet = new Map(); convs.clear(); attachToggles(); refresh(); });
          // The composer can be rebuilt (a chat switch): keep the chip there.
          runtime.on('threads', () => attachToggles());
        }
      }
      mount();
      refresh();
    } catch (e) {
      console.warn('context tree install', e);
    }
  }

  /** Settings arriving with an event or a `ctx` answer. */
  function applySettings(raw) {
    const s = normalizeSettings(raw);
    if (!s) return false;
    settings = s;
    paint();
    return true;
  }

  const out = {
    install,
    mount,
    open,
    close,
    toggle,
    isOpen: () => panel.open,
    activeKey,
    tab: () => panel.tab,
    expand: (id, on = true) => { if (on) panel.expanded.add(id); else panel.expanded.delete(id); paint(true); },
    setTab,
    goToTurn,
    threadTurns,
    place,
    setItem,
    render,
    onEvent,
    onToolResult,
    available,
    state: () => state,
    settings: () => settings,
    error: () => lastError,
    applySettings,
    setEnabled,
    setMemory,
    decorateChatTags,
    resetTree,
    refresh,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  if (typeof window !== 'undefined') {
    window.__contextTree = out;
    // Self-installing, like the rest of the screens: wait for the DOM, then try
    // once. `mount` is a no-op unless the engine advertises the feature, and the
    // whole thing is wrapped so an old build cannot break the app.
    const boot = () => {
      try {
        if (appRef) return; // ContextTree.install(app) already ran
        const runtime = window.__app || window.__runtime || window.__agentRuntime || null;
        out.install(runtime);
      } catch (e) {
        console.warn('context tree boot', e);
      }
    };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
  return out;
})();
