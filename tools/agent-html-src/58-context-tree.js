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

  let state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: '', memory: null };
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
        memory: p.memory && typeof p.memory === 'object' && Array.isArray(p.memory.groups) ? p.memory : state.memory,
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
  function setMemory(rid, action) {
    const send = ctxSend();
    if (!send || !rid || !action) return Promise.resolve(false);
    pendingMem.set(rid, action);
    paint();
    return Promise.resolve(send('ctx.set', { ops: [{ id: `mem/${rid}`, action }] }))
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
          state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: state.model || '' };
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

  function logRows() {
    if (!state.log.length) return '<p class="ct-empty">Nothing has been taken out of the window yet.</p>';
    return state.log.slice(0, 20).map((e) => {
      const ops = parseMaybeJSON(e.ops, []);
      const what = Array.isArray(ops)
        ? ops.map((o) => `${esc(o.id || '?')} ${esc(o.action || '')}${o.ok === false ? ' (refused)' : ''}`).join(', ')
        : esc(String(e.ops || ''));
      const why = e.reason ? (REASON_LABEL[e.reason] || e.reason) : '';
      const before = e.tokensBefore != null ? short(e.tokensBefore) : null;
      const after = e.tokensAfter != null ? short(e.tokensAfter) : null;
      return `<div class="ct-log-row">
          <div class="ct-log-what">${what || '—'}</div>
          <div class="ct-log-why">${esc(ACTOR_LABEL[e.actor] || e.actor || '')}${why ? ' — ' + esc(why) : ''}${before && after ? ` · ${esc(before)} → ${esc(after)} tokens` : ''}</div>
        </div>`;
    }).join('');
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
     One small card above the composer, with tabs: Checklist (the tree, with
     the token use by kind on top), Summary (always sent), Log and Settings.
     It replaces the old context sheet, the Chat memory screen and the
     Sections sheet, which showed the same things in three places. */
  const TABS = [['items', 'Checklist'], ['summary', 'Summary'], ['log', 'Log'], ['settings', 'Settings']];
  const INFO = {
    meter: 'Tokens the next request carries, by kind, against the model\u2019s window. Below, tick an item to include it and untick to leave it out; nothing is deleted. \u25cf in \u00b7 \u25cb out \u00b7 \u25d0 note only \u00b7 \u2726 replaced by a summary \u00b7 \u26bf locked.',
    turn: 'Every stored chat, newest first. Open one to see its turns, each tool call with its result, and its range summaries; tick a box to keep an item in that chat\'s context or leave it out. The arrow opens the chat or jumps to the turn.',
    call: 'One tool call with its result. It can be left out on its own; the rest of the turn stays.',
    result: 'A large tool result kept in storage. Left out, the model sees only its id and can read it back.',
    segment: 'A summary of exactly these turns, written once and never changed. R = its own range version. \u0394 = what it changed against earlier ranges. Sum sends the summary (default), Raw sends the original turns instead, Both sends both. Open it to send single original turns.',
    ranges: 'Every range summary with its own version (R1, R2\u2026), the memory version it was built on, and what it changed against the earlier ranges.',
    data: 'Everything this chat\u2019s memory stores, as saved.',
    rolling: 'The summary that stands in for the turns before it when the window had to be compacted.',
    summary: 'The chat\u2019s running summary: goals, decisions, facts, files, tasks and ranges. Only the parts that fit the request are sent; each part is a row under Chat memory in the Checklist, coloured by whether it was sent, left out or is waiting behind \u201cshow more\u201d.',
    log: 'Why items left the window, who asked, and what it saved.',
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
    for (const m of msgs) {
      if (!m) continue;
      const parts = Array.isArray(m.content) ? m.content : [];
      if (m.role === 'user') {
        const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ') || (typeof m.content === 'string' ? m.content : '');
        out.push({ text: text.replace(/\s+/g, ' ').trim(), calls: [], index: out.length });
      } else if (m.role === 'assistant' && out.length) {
        for (const p of parts) if (p && p.type === 'tool-call') out[out.length - 1].calls.push(p);
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
    return st === 'in' ? short(it.tokens) : st === 'note' ? `${short(noteCost(it))} note` : st === 'temp' ? 'summary' : 'out';
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
    </div>`;
  }

  /** One engine item as a leaf row. */
  function leafRow(it, extra = '') {
    const st = stateOf(it);
    return `<div class="ct-item cc-row cc-g-${groupOf(it) || 'memory'} ct-state-${esc(st)}${kindOf(it) === 'summary' ? ' ct-kind-summary' : ''}" data-node="${esc(it.id)}">
      ${noTwisty}${control(it)}<span class="ct-title">${esc(it.title || it.id)}</span>${extra}<span class="ct-cost">${esc(costText(it))}</span></div>`;
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
      <div class="ct-item cc-row cc-g-calls" data-node="${esc(node ? node.id : `turn/t${n}/call/${k}`)}">${twisty(id, name)}${ctl}<span class="ct-title"><span class="cc-tool">${esc(name)}</span> <span class="cc-args">${esc(clip(args.replace(/\s+/g, ' '), 60))}</span></span>${err ? '<span class="cc-badge cc-bad">error</span>' : ''}<span class="ct-cost">${node ? esc(costText(node)) : ''}</span></div>
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
    const calls = new Map();
    for (const c of kids) { const k = callOf(c); if (k != null) calls.set(k, { node: c, part: null }); }
    (tt ? tt.calls : []).forEach((p, i) => { const k = i + 1; const cur = calls.get(k) || { node: null, part: null }; cur.part = p; calls.set(k, cur); });
    const total = [it, ...kids, ...results].filter(Boolean).reduce((a, x) => a + sentOf(x), 0);
    const count = calls.size + results.length;
    const inner = open ? `<div class="cc-kids">${[...calls.keys()].sort((a, b) => a - b).map((k) => callNode(n, k, calls.get(k).node, calls.get(k).part, turnOut)).join('')}${results.map((r) => leafRow(r, `<button class="cc-link" type="button" data-open-result="${esc(String(r.id).replace(/^res\//, ''))}"${RK ? ` data-key="${esc(RK)}"` : ''}>Open</button>`)).join('')}${count ? '' : '<p class="cc-none">No tool calls</p>'}</div>` : '';
    return `<div class="cc-node cc-turn ct-state-${esc(st)}" data-turn="${n}">
      <div class="ct-item cc-row cc-g-turns" data-node="${esc(nid)}">${twisty(id, 'turn ' + n)}${it ? control(it) : `<span class="ct-sym">${SYMBOL.in}</span>`}<span class="cc-num">${n}</span><span class="ct-title">${esc(clip(title, 80))}</span>${count ? `<span class="cc-badge">${count}</span>` : ''}${newest ? '<span class="cc-badge">now</span>' : ''}<span class="ct-cost">${esc(short(total))}</span><button class="cc-go" type="button" data-go-turn="${n}" data-go-title="${esc(clip(title, 40))}"${goKey()} aria-label="Go to turn ${n} in the chat">${GO_ICON}</button></div>
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
        return `<div class="cc-node cc-call" data-orig-call="${n}/${i + 1}"><div class="cc-row cc-g-calls">${twisty(cid, name)}<span class="ct-sym" title="Follows its turn">${sendsRaw ? SYMBOL.in : SYMBOL.temp}</span><span class="ct-title"><span class="cc-tool">${esc(name)}</span> <span class="cc-args">${esc(clip(String(args || '').replace(/\s+/g, ' '), 60))}</span></span>${err ? '<span class="cc-badge cc-bad">error</span>' : ''}</div>
          ${o ? `<div class="cc-detail">${args && args !== '{}' ? `<div class="cc-detail-k">Input</div><pre class="cc-pre">${esc(clip(args, 800))}</pre>` : ''}<div class="cc-detail-k">Result${err ? ' (error)' : ''}</div><pre class="cc-pre${err ? ' cc-err' : ''}">${res ? esc(clip(res, 2400)) : '\u2014'}</pre></div>` : ''}</div>`;
      }).join('');
      const raw = !calls.length && orig && orig.text ? `<pre class="cc-pre">${esc(clip(orig.text, 2400))}</pre>` : '';
      inner = `<div class="cc-kids">${parts || raw || '<p class="cc-none">No tool calls</p>'}</div>`;
    }
    return `<div class="cc-node cc-covered${sendsRaw ? ' cc-raw-on' : ''}" data-covered="${n}">
      <div class="cc-row cc-g-turns">${twisty(id, 'original turn ' + n)}${check}<span class="cc-num">${n}</span><span class="ct-title">${esc(clip(text, 70))}</span>${calls.length ? `<span class="cc-badge">${calls.length}</span>` : ''}${sendsRaw ? '<span class="cc-badge cc-raw-badge" title="The original goes to the model">raw</span>' : ''}<button class="cc-go" type="button" data-go-turn="${n}" data-go-title="${esc(clip(text, 40))}"${goKey()} aria-label="Go to turn ${n} in the chat">${GO_ICON}</button></div>
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
        ${seg.title ? `<p class="cc-seg-title">${esc(seg.title)}</p>` : ''}
        <p class="cc-seg-text">${esc(seg.summary || '')}</p>
        <p class="cc-seg-meta">${meta}</p>
        ${changesList(seg)}
        ${orig && orig.loading ? '<p class="cc-none" role="status" aria-busy="true">Loading originals\u2026</p>' : ''}${orig && orig.error ? `<p class="ct-note ct-error" role="alert">${esc(orig.error)}</p>` : ''}
        <div class="cc-kids" role="group" aria-label="Original turns ${a} to ${b}">${covered.map((n) => coveredTurn(key, n, turns[n - 1] || null, orig ? orig.turns.get(n) : null, byRange || raw.turns.has(n), byRange, a, b)).join('')}</div>
      </div>`;
    }
    const st = mode === 'raw' ? 'out' : (memNode ? stateOf(memNode) : 'in');
    const picked = mode === 'summary' ? [...raw.turns].filter((n) => n >= a && n <= b).length : 0;
    return `<div class="cc-node cc-seg-node ct-kind-summary ct-state-${esc(st)} cc-mode-${esc(mode)}" data-segment="${a}-${b}" data-rev="${rev}">
      <div class="cc-row cc-g-summary">${twisty(id, `summary of turns ${a} to ${b}`)}<span class="cc-rev" title="Range version">R${rev}</span><span class="cc-num">${a === b ? a : a + '\u2013' + b}</span><span class="ct-title">${esc(clip(seg.title || seg.topic || seg.summary || 'Summary', 60))}</span>${nChg ? `<span class="cc-badge cc-chg-badge" title="${nChg} change${nChg === 1 ? '' : 's'} against earlier ranges">\u0394${nChg}</span>` : ''}${picked ? `<span class="cc-badge cc-raw-badge" title="Original turns sent beside the summary">+${picked}</span>` : ''}${modes}${infoBtn('segment:' + a + '-' + b)}</div>
      ${tip('segment:' + a + '-' + b)}${inner}
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
    for (const s of sums) {
      const r = rangeOf(s.id);
      entries.push({ at: r ? r[1] + 0.6 : 1e9, html: () => `<div class="cc-node cc-seg-node ct-kind-summary">${leafRow(s, infoBtn('rolling'))}${tip('rolling')}</div>` });
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
    let inner = '', meta = '';
    NS = isCur ? '' : `c:${t.id}|`; RK = isCur ? '' : t.id;
    try {
      if (isCur) {
        const q = curParts;
        meta = `${q.turnCount} turn${q.turnCount === 1 ? '' : 's'} \u00b7 ${short(q.sent)}`;
        if (open) {
          const memRow = q.memNode ? `<div class="cc-node cc-seg-node ct-kind-summary">${leafRow(q.memNode, `<button class="cc-link" type="button" data-tab-go="summary">View</button>`)}</div>` : '';
          inner = q.empty ? '<p class="cc-none">Nothing stored yet</p>' : memRow + q.body();
        }
      } else if (c && c.at) {
        const q = convParts(c.items, threadTurns(c.msgs || []), segsOf(t.id));
        meta = `${q.turnCount} turn${q.turnCount === 1 ? '' : 's'} \u00b7 ${short(q.sent)}`;
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
      // The chat's sub-agents (workspace registry, items.tree): nested under
      // the chat that started them, never as top-level rows.
      if (open) inner += wsAgentsBlock(t.id);
    } finally { NS = ''; RK = ''; }
    const go = isCur ? '<span class="cc-badge cc-here">Open now</span>'
      : `<button class="cc-go cc-open" type="button" data-open-conv="${esc(t.id)}" aria-label="Open chat ${esc(clip(name, 40))}">${GO_ICON}</button>`;
    return `<div class="cc-node cc-conv${isCur ? ' cc-conv-current' : ''}" data-conv="${esc(t.id)}"${isCur ? ' data-current="true"' : ''}>
      <div class="cc-row cc-conv-head cc-g-turns">${twisty(id, 'chat ' + name)}<span class="ct-title">${esc(clip(name, 60))}</span>${t.archived ? '<span class="cc-badge">Archived</span>' : ''}<span class="ct-cost">${esc(meta)}</span>${go}</div>
      ${open ? `<div class="cc-kids">${inner}</div>` : ''}
    </div>`;
  }

  /** The checklist: the open chat's rules and memory, then every stored
   * conversation; the open one first and expanded. */
  function tree() {
    const items = state.items || [];
    const cur = activeKey();
    const segs = segsOf(cur);
    const list = conversationList();
    const others = list.filter((t) => t.id !== cur);
    if (!items.length && !segs.length && !others.length) return '<p class="ct-empty">Empty until the first message.</p>';
    NS = ''; RK = '';
    const q = convParts(items, threadTurns(), segs);
    const all = panel.expanded.has('convs/all');
    const curRow = list.find((t) => t.id === cur);
    const shown = [...(curRow ? [curRow] : []), ...(all ? others : others.slice(0, CONV_PAGE))];
    const more = all || others.length <= CONV_PAGE ? '' : `<button class="cc-link cc-more-convs" type="button" data-tw="convs/all">Show ${others.length - CONV_PAGE} more</button>`;
    const convo = shown.length
      ? `<div class="cc-node cc-group cc-g-turns" data-group="turns"><div class="cc-row cc-head">${twisty('grp/turns', 'conversations')}<span class="cc-dot"></span><span class="ct-title cc-group-name">Conversations</span><span class="ct-cost">${list.length}</span>${infoBtn('turn')}</div>${tip('turn')}${panel.expanded.has('grp/turns') ? `<div class="cc-kids">${shown.map((t) => convNode(t, cur, q)).join('')}${more}</div>` : ''}</div>`
      : '';
    return groupBlock('rules', 'Rules', q.plain.rules) + groupBlock('memory', 'Memory', q.plain.memory) + memoryTree() + convo + wsAllBlock();
  }

  // ── The unified workspace (plan.md, Phase 1): sub-agents under the chat
  // that started them, and an "All" view of every item, read from the
  // engine's item registry with `items.tree`. Read-only in this phase.
  const wsTrees = new Map(); // holder ('session:<key>' | '*') -> { at, loading, tree, error }
  function loadWs(holder) {
    const cur = wsTrees.get(holder);
    if (cur && (cur.loading || Date.now() - cur.at < 4000)) return;
    const send = ctxSend();
    if (!send) return;
    wsTrees.set(holder, { ...(cur || {}), loading: true, at: Date.now() });
    const req = holder === '*' ? { all: true } : { holder };
    Promise.resolve(send('items.tree', req)).then((tree) => {
      wsTrees.set(holder, { at: Date.now(), loading: false, tree: tree || {} });
    }, (e) => {
      wsTrees.set(holder, { at: Date.now(), loading: false, error: errText(e) });
    }).finally(() => { try { paint(true); } catch (e) { /* closed */ } });
  }
  // One registry item as a read-only row. `data-item-id` is the handle the
  // later phases (permissions, Trash) act on.
  function wsItemRow(it, extra) {
    if (!it || typeof it !== 'object') return '';
    const st = String(it.state || '');
    const badge = st === 'missing' ? '<span class="cc-badge cc-bad" title="The source is gone; the entry is kept so it can be found">Missing</span>'
      : st === 'trashed' ? '<span class="cc-badge">In Trash</span>' : '';
    const ref = it.ref && typeof it.ref === 'object' ? it.ref : null;
    const perm = ref && ref.perm ? `<span class="cc-badge" title="What you may do with it">${esc(ref.perm)}</span>` : '';
    const from = ref && ref.mode ? `<span class="ct-cost">${esc(ref.mode)}</span>` : '';
    const meta = it.meta && typeof it.meta === 'object' ? it.meta : {};
    const fromDeleted = meta.fromDeletedHolder || it.owner === 'detached' ? '<span class="cc-badge" title="Kept because something still refers to it">From a deleted chat</span>' : '';
    return `<div class="cc-node cc-ws-leaf" data-item-id="${esc(it.id || '')}" data-ws-item="${esc(it.id || '')}" data-ws-kind="${esc(it.kind || '')}"><div class="cc-row"><span class="ct-title">${esc(clip(it.title || it.loc || it.kind || 'Item', 70))}</span>${badge}${fromDeleted}${perm}${from}${extra || ''}</div></div>`;
  }
  const wsPage = (p) => (p && Array.isArray(p.items) ? p : { items: Array.isArray(p) ? p : [], total: Array.isArray(p) ? p.length : 0 });
  // A collapsible sub-group of item rows; empty groups are left out.
  function wsSub(id, label, pg, slot) {
    const p = wsPage(pg);
    const total = Number(p.total) || p.items.length;
    if (!total) return '';
    const open = panel.expanded.has(id);
    const more = p.more ? `<p class="cc-none">${esc(total - p.items.length)} more not shown.</p>` : '';
    return `<div class="cc-node cc-ws-section" data-ws-section="${esc(slot)}"><div class="cc-row">${twisty(id, label)}<span class="ct-title">${esc(label)}</span><span class="ct-cost">${esc(total)}</span></div>${open ? `<div class="cc-kids">${p.items.map((it) => wsItemRow(it)).join('')}${more}</div>` : ''}</div>`;
  }

  function wsAgentNode(a, depth) {
    const it = a.item || {};
    const id = 'ws/agent/' + (it.id || '');
    const open = panel.expanded.has(id);
    const meta = it.meta || {};
    const kids = Array.isArray(a.subagents) ? a.subagents : [];
    const mem = Array.isArray(a.memory) ? a.memory : [];
    const files = Array.isArray(a.files) ? a.files : [];
    const chatMsgs = a.chat && a.chat.meta ? a.chat.meta.messages : 0;
    const aid = meta.agentId || '';
    const body = open ? `<div class="cc-kids">
        ${a.chat ? `<div class="cc-node cc-ws-leaf" data-item-id="${esc(a.chat.id)}" data-ws-item="${esc(a.chat.id)}"><div class="cc-row"><span class="ct-title">Chat</span><span class="ct-cost">${esc(chatMsgs || 0)} messages</span>${aid ? `<button class="cc-go cc-open" type="button" data-open-conv="${esc('subagent:' + aid)}" aria-label="Open the chat of ${esc(clip(it.title || 'the sub-agent', 40))}">${GO_ICON}</button>` : ''}</div></div>` : ''}
        ${wsSub(id + '/memory', 'Memory', mem, 'agent-memory')}
        ${wsSub(id + '/files', 'Files', files, 'agent-files')}
        ${depth < 6 ? kids.map((k) => wsAgentNode(k, depth + 1)).join('') : ''}
      </div>` : '';
    const st = String(it.state || '') === 'missing' ? '<span class="cc-badge cc-bad">Missing</span>' : '';
    return `<div class="cc-node cc-ws-agent" data-ws-agent="${esc(aid)}" data-item-id="${esc(it.id || '')}" role="treeitem">
      <div class="cc-row">${twisty(id, 'sub-agent ' + (it.title || ''))}<span class="ct-title">${esc(clip(it.title || meta.name || 'Sub-agent', 60))}</span><span class="cc-badge">${esc(meta.status || '')}</span>${st}${kids.length ? `<span class="ct-cost">${kids.length} sub-agent${kids.length === 1 ? '' : 's'}</span>` : ''}</div>${body}</div>`;
  }
  // Everything the registry knows for one chat: its sub-agents, its Files
  // (read in this chat, workspace, attachments, sub-agent files) and what
  // other holders shared with it.
  function wsAgentsBlock(chatId) {
    if (!chatId || String(chatId).startsWith('subagent:')) return '';
    const holder = 'session:' + chatId;
    const w = wsTrees.get(holder);
    if (!w || Date.now() - w.at > 4000) setTimeout(() => loadWs(holder), 0);
    const sec = (w && w.tree && w.tree.sections) || {};
    const agents = Array.isArray(sec.subagents) ? sec.subagents : [];
    const subs = agents.length
      ? `<div class="cc-node cc-group cc-g-subagents" data-group="subagents" data-ws-holder="${esc(holder)}"><div class="cc-row cc-head"><span class="cc-dot"></span><span class="ct-title cc-group-name">Sub-agents</span><span class="ct-cost">${agents.length}</span></div><div class="cc-kids">${agents.map((a) => wsAgentNode(a, 0)).join('')}</div></div>`
      : '';
    const f = sec.files && typeof sec.files === 'object' ? sec.files : {};
    const fid = 'ws/files/' + holder;
    const fileParts = [
      wsSub(fid + '/read', 'Read in this chat', f.read, 'files-read'),
      wsSub(fid + '/workspace', 'Workspace', f.workspace, 'files-workspace'),
      wsSub(fid + '/attachments', 'Attachments', f.attachments, 'files-attachments'),
      wsSub(fid + '/agents', 'Sub-agent files', f.subagentFiles, 'files-subagents'),
    ].join('');
    const fileTotal = ['read', 'workspace', 'attachments', 'subagentFiles'].reduce((n, k) => n + (Number(wsPage(f[k]).total) || wsPage(f[k]).items.length), 0);
    const filesOpen = panel.expanded.has(fid);
    const files = fileTotal
      ? `<div class="cc-node cc-group cc-g-files" data-group="files" data-ws-holder="${esc(holder)}"><div class="cc-row cc-head">${twisty(fid, 'files')}<span class="cc-dot"></span><span class="ct-title cc-group-name">Files</span><span class="ct-cost">${fileTotal}</span></div>${filesOpen ? `<div class="cc-kids">${fileParts}</div>` : ''}</div>`
      : '';
    const shared = wsPage(sec.sharedWithMe);
    const sid = 'ws/shared/' + holder;
    const sharedBlock = shared.items.length
      ? `<div class="cc-node cc-group cc-g-shared" data-group="shared-with-me" data-ws-holder="${esc(holder)}"><div class="cc-row cc-head">${twisty(sid, 'shared with me')}<span class="cc-dot"></span><span class="ct-title cc-group-name">Shared with me</span><span class="ct-cost">${shared.items.length}</span></div>${panel.expanded.has(sid) ? `<div class="cc-kids">${shared.items.map((it) => wsItemRow(it)).join('')}</div>` : ''}</div>`
      : '';
    return subs + files + sharedBlock;
  }
  function wsAllBlock() {
    const id = 'grp/ws-all';
    const open = panel.expanded.has(id);
    if (!ctxSend()) return '';
    let body = '';
    if (open) {
      const w = wsTrees.get('*');
      if (!w || Date.now() - w.at > 4000) setTimeout(() => loadWs('*'), 0);
      const sec = (w && w.tree && w.tree.sections) || {};
      const row = (label, k) => {
        const s2 = sec[k] || {};
        const items = Array.isArray(s2.items) ? s2.items : [];
        const rid = 'ws/all/' + k;
        const o = items.length && panel.expanded.has(rid);
        const more = o && s2.more ? `<p class="cc-none">${esc((Number(s2.total) || 0) - items.length)} more not shown.</p>` : '';
        return `<div class="cc-node cc-ws-section" data-ws-section="${esc(k)}"><div class="cc-row">${items.length ? twisty(rid, label) : ''}<span class="ct-title">${esc(label)}</span><span class="ct-cost">${esc(s2.total || items.length || 0)}</span></div>${o ? `<div class="cc-kids">${items.map((it) => wsItemRow(it)).join('')}${more}</div>` : ''}</div>`;
      };
      body = w && w.error ? `<p class="ct-note ct-error" role="alert">${esc(w.error)}</p>`
        : !w || !w.tree ? '<p class="cc-none" role="status" aria-busy="true">Loading\u2026</p>'
        : row('Chats', 'chats') + row('Sub-agents', 'subagents') + row('Files', 'files') + row('Memory', 'memory') + row('Notes and summaries', 'notes') + row('Messages', 'messages') + row('Groups', 'groups') + row('Missing', 'missing');
    }
    return `<div class="cc-node cc-group cc-g-ws-all" data-group="ws-all"><div class="cc-row cc-head">${twisty(id, 'everything')}<span class="cc-dot"></span><span class="ct-title cc-group-name">All</span></div>${open ? `<div class="cc-kids">${body}</div>` : ''}</div>`;
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
    const items = Array.isArray(g.items) ? g.items : [];
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
    return `<div class="cc-node cc-group cc-g-memory cc-mem-group" data-mem-group="${esc(g.id)}" role="treeitem">
      <div class="cc-row cc-head">${twisty(id, g.title)}<span class="cc-dot"></span><span class="ct-title cc-group-name">${esc(g.title)}</span><span class="ct-cost">${sent}/${total}${left ? ` \u00b7 <span class="cc-mc-left_out cc-mem-count">${left} left out</span>` : ''}</span>${groupOps(g)}</div>${body}</div>`;
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
      <div class="cc-row cc-head">${twisty(id, 'Chat memory')}<span class="cc-dot"></span><span class="ct-title cc-group-name">Chat memory</span><span class="ct-cost">${esc(c.sent || 0)} sent \u00b7 <span class="cc-mc-left_out cc-mem-count">${esc(c.leftOut || 0)} left out</span> \u00b7 <span class="cc-mc-show_more cc-mem-count">${esc(c.showMore || 0)} more</span></span>${infoBtn('memory')}</div>${tip('memory')}
      ${open ? `<div class="cc-kids">${legend}${tags}${inner}</div>` : ''}</div>`;
  }

  function tabItems() {
    // Always on: there is no "off" screen and no "Turn on" button.
    return `${errorNote()}${stageNote()}${meter()}<div class="cc-tree ct-list" role="tree" aria-label="Checklist">${tree()}</div>${resetNote()}`;
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
    const sub = panel.memKey ? `<div class="cc-sub-note" role="status"><span class="cc-badge">Sub-agent</span><span class="ct-title">${esc(clip(String(panel.memKey).replace(/^subagent:/, ''), 40))}</span><button class="cc-link" type="button" data-mem-back="1">This chat</button></div>` : '';
    const head = `${sub}<div class="cc-sumhead"><span class="cc-badge cc-always">Chosen per request</span>${m && m.throughTurn ? `<span class="cc-when">Turns 1\u2013${esc(num(m.throughTurn))}</span>` : ''}${m && m.version ? `<span class="cc-when">v${esc(num(m.version))}</span>` : ''}${at ? `<span class="cc-when" data-slot="summary-created">${esc(when(at))}</span>` : ''}${infoBtn('summary')}</div>${tip('summary')}`;
    if (!memApi()) return head + '<p class="ct-empty">No summary yet.</p>';
    return `${head}<div class="cc-mem" data-mem="summary"></div>${rangesBlock(key, m)}${d ? dataBlock(d, m) : ''}
      <details class="cc-more" data-key="versions"${panel.detailsOpen && panel.detailsOpen.versions ? ' open' : ''}><summary>Versions</summary><div class="cc-mem" data-mem="history"></div></details>`;
  }

  function tabLog() {
    return `<div class="cc-sumhead"><span class="cc-when">${num(state.log.length)} entries</span>${infoBtn('log')}</div>${tip('log')}<div class="cc-log">${logRows()}</div>`;
  }

  function tabSettings() {
    const unknown = settings == null;
    return `${errorNote()}
      <div class="cc-set"><span class="cc-set-name">Context checklist</span>${infoBtn('tree')}
        <span class="cc-badge cc-always-on" role="status" aria-label="Always on"${unknown ? ' data-unknown="true"' : ''}>Always on</span></div>${tip('tree')}
      <div class="cc-set"><span class="cc-set-name">Reset tree</span>${infoBtn('reset')}<button class="ct-reset-btn cc-btn cc-btn-quiet" type="button"${busyAttr('reset')}>${busy === 'reset' ? 'Resetting\u2026' : 'Reset'}</button></div>${tip('reset')}
      ${resetNote()}
      ${memApi() ? `<div class="cc-mem cc-mem-settings" data-mem="settings"></div>` : ''}`;
  }

  /** The current tab's content (also what tests read). */
  function render() {
    const t = panel.tab;
    return t === 'summary' ? tabSummary() : t === 'log' ? tabLog() : t === 'settings' ? tabSettings() : tabItems();
  }

  /** Fill the Chat memory parts (summary, versions, settings) the card reuses. */
  function hydrate(root) {
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
    for (const b of panel.tabs.querySelectorAll('[data-tab]')) {
      const on = b.getAttribute('data-tab') === panel.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (panel.body) panel.body.setAttribute('aria-labelledby', `cc-tab-${panel.tab}`);
  }

  function paint(force) {
    if (panel.body && !force && panel.open && (panel.tab === 'settings' || panel.tab === 'summary')) {
      // Do not repaint a form under the person's fingers.
      const a = document.activeElement;
      if (a && panel.body.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    }
    const html = (() => { try { return render(); } catch (e) { console.warn('context card paint', e); return null; } })();
    if (html == null) return;
    if (panel.body) {
      const sc = panel.body.scrollTop;
      panel.body.innerHTML = html;
      hydrate(panel.body);
      panel.body.scrollTop = sc;
    }
    paintTabs();
  }

  function setTab(t, focus) {
    if (!TABS.some(([k]) => k === t)) t = 'items';
    panel.tab = t;
    paint(true);
    if (panel.body) panel.body.scrollTop = 0;
    if (t === 'summary' || t === 'settings') { const cm = memApi(); const k = memKey(); if (cm && k && cm.refresh) Promise.resolve(cm.refresh(k)).then(() => paint(true)).catch(() => {}); }
    if (focus && panel.tabs) { const b = panel.tabs.querySelector(`[data-tab="${t}"]`); if (b) b.focus(); }
  }

  function onBodyClick(ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!t) return;
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
        <div class="cc-tabs" role="tablist" aria-label="Context">${TABS.map(([k, label]) => `<button class="cc-tab" type="button" role="tab" id="cc-tab-${k}" data-tab="${k}" aria-controls="cc-body" aria-selected="false" tabindex="-1">${label}</button>`).join('')}</div>
        <button class="ct-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <div class="ct-body cc-body" id="cc-body" role="tabpanel" tabindex="-1"></div>`;
    const body = root.querySelector('.ct-body');
    const tabs = root.querySelector('.cc-tabs');
    root.querySelector('.ct-close').addEventListener('click', () => close(true));
    tabs.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-tab]'); if (b) setTab(b.getAttribute('data-tab')); });
    tabs.addEventListener('keydown', (e) => {
      const i = TABS.findIndex(([k]) => k === panel.tab);
      const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
      if (n < 0) return;
      e.preventDefault();
      setTab(TABS[n][0], true);
    });
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
    const shell = composerShell(anchor || panel.anchor);
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
    root.dataset.place = shell ? 'composer' : 'float';
    root.style.width = `${w}px`;
    root.style.left = `${Math.round(left)}px`;
    const s = root.style;
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
    if (e.key === 'Escape' && panel.open) { e.stopPropagation(); close(true); }
  }
  function onOutside(e) {
    if (!panel.open || !panel.root) return;
    const t = e.target;
    if (panel.root.contains(t)) return;
    if (t && t.closest && t.closest('[data-slot="token-meter"], .ct-toggle, .modal-backdrop, [role="dialog"]')) return;
    close(false);
  }

  /** Open the card. `tab` picks the tab: items (default), summary, log, settings.
   * `key` names another chat's memory for the Summary and Settings tabs (a
   * sub-agent's "Open full memory"); without it they show the open chat. */
  function open(anchor, tab, key) {
    if (!available()) return;
    panel.memKey = key && key !== activeKey() ? String(key) : null;
    panel.anchor = (anchor && anchor.nodeType === 1 ? anchor : null) || document.querySelector('.ct-toggle') || document.querySelector('[data-slot="token-meter"]:not([hidden])');
    if (typeof anchor === 'string') tab = anchor;
    if (tab) panel.tab = TABS.some(([k]) => k === tab) ? tab : 'items';
    place(panel.anchor);
    panel.open = true;
    panel.root.hidden = false;
    syncExpanded();
    setTab(panel.tab);
    refresh();
    const cm = memApi(); const k = memKey();
    if (cm && k && cm.refresh) Promise.resolve(cm.refresh(k)).then(() => paint()).catch(() => {});
    if (panel.memKey && cm && cm.refresh && activeKey()) Promise.resolve(cm.refresh(activeKey())).catch(() => {});
    try { const b = panel.tabs.querySelector('[aria-selected="true"]'); (b || panel.body).focus({ preventScroll: true }); } catch (e) { /* old webview */ }
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', replace);
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', replace); window.visualViewport.addEventListener('scroll', replace); }
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }

  function close(focusBack) {
    if (!panel.root) return;
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
    for (const b of document.querySelectorAll('[data-slot="token-meter"], .ct-toggle')) {
      b.setAttribute('aria-expanded', String(!!panel.open));
      b.setAttribute('aria-controls', 'cc-body');
    }
  }

  /** The "Context" chip in the composer. With the token chip visible, CSS hides
   * this one and the token chip opens the card. */
  function attachToggles() {
    if (!available()) return;
    for (const start of document.querySelectorAll('.aui-composer-root .aui-composer-action-start')) {
      if (start.querySelector('.ct-toggle')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ct-toggle';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', String(!!panel.open));
      btn.setAttribute('aria-label', 'Open the context card');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zm-9 9l9 5 9-5M3 16l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>Context</span>';
      btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(btn); });
      start.appendChild(btn);
    }
  }

  /** Make the card ready (closed) and the composer chip. */
  function mount() {
    if (!available()) return;
    ensureSheet();
    if (!panel.root.parentNode) document.body.appendChild(panel.root);
    attachToggles();
    const cm = memApi();
    if (cm && cm.subscribe && !panel.memSub) panel.memSub = cm.subscribe((k) => { if (panel.open && (k === activeKey() || k === panel.memKey || convs.has(k))) paint(); });
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
    tagTimer = setTimeout(() => { tagTimer = null; try { decorateChatTags(); } catch (e) { console.warn('chat tags', e); } }, 120);
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
          runtime.on('main', () => { state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: '' }; pendingSet = new Map(); convs.clear(); attachToggles(); refresh(); });
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
    workspaceTree: (holder) => (wsTrees.get(holder || '*') || {}).tree || null,
    // The workspace sections as HTML (used by the chat rows and the All view; exposed for the UI suite).
    workspaceChatHtml: (chatId) => wsAgentsBlock(chatId),
    workspaceAllHtml: () => wsAllBlock(),
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
