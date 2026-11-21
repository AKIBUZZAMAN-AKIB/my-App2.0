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

  let state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: '' };
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
  const panel = { root: null, body: null, tabs: null, open: false, anchor: null, tab: 'items', expanded: new Set(['grp/turns']), tips: new Set(), detailsOpen: {} };
  let pendingSet = new Map(); // id -> state asked for, until the engine confirms

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
      };
      if (p.settings) applySettings(p.settings);
      else if (typeof p.enabled === 'boolean') settings = { enabled: p.enabled, thresholdPercent: settings ? settings.thresholdPercent : null };
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
    return {
      enabled: s.enabled,
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
  function bridge() {
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
    const send = bridge();
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

  /** Ask the engine to flip the switch. The answer is what is shown, not the wish. */
  function setEnabled(on) {
    const send = bridge();
    const optimistic = () => {
      settings = { enabled: !!on, thresholdPercent: settings ? settings.thresholdPercent : null };
      paint();
    };
    if (!send) {
      // No bridge (a preview, an older app): say what will happen, do not lie
      // about the engine's state.
      optimistic();
      return Promise.resolve({ enabled: !!on, pending: true });
    }
    busy = on ? 'on' : 'off';
    lastError = null;
    paint();
    return Promise.resolve(send('ctx.settings', { settings: { enabled: !!on } }))
      .then((res) => {
        busy = null;
        const saved = normalizeSettings(res && res.settings);
        settings = saved || { enabled: !!on, thresholdPercent: settings ? settings.thresholdPercent : null };
        paint();
        refresh();
        return { enabled: settings.enabled };
      })
      .catch((e) => {
        busy = null;
        fail(on ? 'on' : 'off', e);
        paint();
        return { enabled: settings ? settings.enabled : null, error: errText(e) };
      });
  }

  /** "Reset tree" (plan §15.4): start this chat's tree again. Every item, note,
   * summary, strategy and log row of the open chat goes; the settings stay and
   * the next request lists the transcript again. The person confirms first,
   * because notes the model wrote cannot be brought back. */
  function resetTree({ confirmed = false } = {}) {
    const send = bridge();
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
  function setItem(id, include) {
    const send = bridge();
    const it = state.items.find((x) => x.id === id);
    if (!send || !it) return Promise.resolve(false);
    pendingSet.set(id, include ? 'in' : 'out');
    paint();
    return Promise.resolve(send('ctx.set', { ops: [{ id, action: include ? 'include' : 'exclude' }] }))
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
      .finally(() => { pendingSet.delete(id); paint(); refresh(); });
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
    const retry = lastError.what === 'on' ? 'ct-on' : lastError.what === 'off' ? 'ct-off-btn' : lastError.what === 'reset' ? 'ct-reset-btn' : 'ct-retry';
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
    turn: 'One turn of this chat: your message, the answer, and under it each tool call with its result. Tap the arrow to jump to it in the chat.',
    call: 'One tool call with its result. It can be left out on its own; the rest of the turn stays.',
    result: 'A large tool result kept in storage. Left out, the model sees only its id and can read it back.',
    segment: 'A summary of exactly these turns, written once when they were summarized. It is sent in their place.',
    rolling: 'The summary that stands in for the turns before it when the window had to be compacted.',
    summary: 'The chat\u2019s running summary: goal, decisions and facts. It is always sent to the model and cannot be left out.',
    log: 'Why items left the window, who asked, and what it saved.',
    tree: 'Lists what is in the window and lets you and the model take items out. Off: the chat is sent exactly as before.',
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
  const stateOf = (it) => (pendingSet.has(it.id) ? pendingSet.get(it.id) : (it.state || 'out'));
  const sentOf = (it) => { const st = stateOf(it); return st === 'in' ? (it.tokens || 0) : st === 'note' ? noteCost(it) : 0; };
  const switchable = (it) => it.pin !== 'locked' && it.pin !== 'policy' && it.kind !== 'system' && !String(it.id || '').startsWith('sys/');
  const cssId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const clip = (t, n) => { const v = String(t == null ? '' : t); return v.length > n ? v.slice(0, n) + '\u2026' : v; };
  const asText = (v) => { if (v == null) return ''; if (typeof v === 'string') return v; try { return JSON.stringify(v, null, 1); } catch (e) { return String(v); } };
  const when = (ms) => { const n = Number(ms); if (!n) return ''; const d = new Date(n < 1e12 ? n * 1000 : n); return isNaN(d) ? '' : d.toLocaleString(); };

  /** The open chat's messages as turns: the user's text and the tool calls of
   * the answer, in order. Used for titles, results and "go to". */
  function threadTurns() {
    let msgs = [];
    try { msgs = (appRef && appRef.chat && appRef.chat.main && appRef.chat.main.messages) || []; } catch (e) { msgs = []; }
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
  function goToTurn(n, title) {
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
  const memData = () => { const cm = memApi(); const k = activeKey(); try { return (cm && k && cm.chats && cm.chats.get(k)) || null; } catch (e) { return null; } };

  const infoBtn = (key) => `<button class="cc-i" type="button" data-info="${esc(key)}" aria-label="About this" aria-expanded="${panel.tips.has(key)}">i</button>`;
  const tip = (key) => (panel.tips.has(key) && INFO[key] ? `<p class="cc-tip" role="note">${esc(INFO[key])}</p>` : '');
  const twisty = (id, label) => {
    const open = panel.expanded.has(id);
    return `<button class="cc-tw" type="button" data-tw="${esc(id)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(label)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  };
  const noTwisty = '<span class="cc-tw cc-tw-none" aria-hidden="true"></span>';

  /** The include switch of one engine item: a checkbox, or the state symbol when it is locked. */
  function control(it) {
    const st = stateOf(it);
    const label = `${STATE_LABEL[st] || st}${it.pin && it.pin !== 'none' ? ' \u00b7 pinned (' + it.pin + ')' : ''}`;
    if (!switchable(it)) return `<span class="ct-sym" title="${esc(label)}" aria-label="${esc(label)}">${it.pin === 'locked' || it.pin === 'policy' ? SYMBOL.locked : (SYMBOL[st] || '\u00b7')}</span>`;
    const checked = st === 'in' || st === 'note' || st === 'temp';
    const can = !busy && !pendingSet.has(it.id);
    return `<input class="ct-check" type="checkbox" data-id="${esc(it.id || '')}"${checked ? ' checked' : ''}${can ? '' : ' disabled'}${pendingSet.has(it.id) ? ' aria-busy="true"' : ''} aria-label="${esc((checked ? 'Leave out: ' : 'Include: ') + (it.title || it.id))}" title="${esc(label)}">`;
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
    const id = 'grp/' + gid;
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
    const id = `call/${n}/${k}`;
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
    const id = it ? it.id : `turn/t${n}`;
    const open = panel.expanded.has(id);
    const title = (it && it.title) || (tt && tt.text) || `Turn ${n}`;
    const st = it ? stateOf(it) : 'in';
    const turnOut = st === 'out';
    const calls = new Map();
    for (const c of kids) { const k = callOf(c); if (k != null) calls.set(k, { node: c, part: null }); }
    (tt ? tt.calls : []).forEach((p, i) => { const k = i + 1; const cur = calls.get(k) || { node: null, part: null }; cur.part = p; calls.set(k, cur); });
    const total = [it, ...kids, ...results].filter(Boolean).reduce((a, x) => a + sentOf(x), 0);
    const count = calls.size + results.length;
    const inner = open ? `<div class="cc-kids">${[...calls.keys()].sort((a, b) => a - b).map((k) => callNode(n, k, calls.get(k).node, calls.get(k).part, turnOut)).join('')}${results.map((r) => leafRow(r, `<button class="cc-link" type="button" data-open-result="${esc(String(r.id).replace(/^res\//, ''))}">Open</button>`)).join('')}${count ? '' : '<p class="cc-none">No tool calls</p>'}</div>` : '';
    return `<div class="cc-node cc-turn ct-state-${esc(st)}" data-turn="${n}">
      <div class="ct-item cc-row cc-g-turns" data-node="${esc(id)}">${twisty(id, 'turn ' + n)}${it ? control(it) : `<span class="ct-sym">${SYMBOL.in}</span>`}<span class="cc-num">${n}</span><span class="ct-title">${esc(clip(title, 80))}</span>${count ? `<span class="cc-badge">${count}</span>` : ''}${newest ? '<span class="cc-badge">now</span>' : ''}<span class="ct-cost">${esc(short(total))}</span><button class="cc-go" type="button" data-go-turn="${n}" data-go-title="${esc(clip(title, 40))}" aria-label="Go to turn ${n} in the chat"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      ${inner}
    </div>`;
  }

  /** A summary of one range of turns, placed right after that range. */
  function segmentNode(seg, memNode, turns) {
    const a = Number(seg.fromTurn) || 0, b = Number(seg.toTurn) || a;
    const id = `seg/${a}-${b}`;
    const open = panel.expanded.has(id);
    const st = memNode ? stateOf(memNode) : 'in';
    const covered = [];
    for (let n = a; n <= b && covered.length < 40; n++) { const t = turns[n - 1]; covered.push({ n, text: t ? t.text : '' }); }
    const inner = open ? `<div class="cc-detail cc-g-summary">
        ${seg.title ? `<p class="cc-seg-title">${esc(seg.title)}</p>` : ''}
        <p class="cc-seg-text">${esc(seg.summary || '')}</p>
        ${seg.createdAt ? `<p class="cc-when">${esc(when(seg.createdAt))}</p>` : ''}
        <div class="cc-kids">${covered.map((c) => `<div class="cc-row cc-g-turns cc-covered">${noTwisty}<span class="ct-sym">${SYMBOL.temp}</span><span class="cc-num">${c.n}</span><span class="ct-title">${esc(clip(c.text || 'Turn ' + c.n, 70))}</span><button class="cc-go" type="button" data-go-turn="${c.n}" data-go-title="${esc(clip(c.text, 40))}" aria-label="Go to turn ${c.n} in the chat"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`).join('')}</div>
      </div>` : '';
    return `<div class="cc-node cc-seg-node ct-kind-summary ct-state-${esc(st)}" data-segment="${a}-${b}">
      <div class="cc-row cc-g-summary">${twisty(id, `summary of turns ${a} to ${b}`)}<span class="ct-sym" title="Sent with the chat summary">${SYMBOL.locked}</span><span class="cc-num">${a === b ? a : a + '\u2013' + b}</span><span class="ct-title">${esc(clip(seg.title || seg.topic || seg.summary || 'Summary', 70))}</span>${infoBtn('segment')}</div>
      ${tip('segment')}${inner}
    </div>`;
  }

  /** The checklist: rules and memory groups, then the conversation in order,
   * each summary right after the turns it covers. */
  function tree() {
    const items = state.items || [];
    const turns = threadTurns();
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
    const md = memData();
    const segs = (md && md.data && md.data.memory && Array.isArray(md.data.memory.segments)) ? md.data.memory.segments : [];
    const entries = [];
    for (const [n, it] of turnNodes) entries.push({ at: n, html: () => turnNode(n, it, parts.get(n) || [], results.get(n) || [], threadTurn(turns, n, it.title), false) });
    for (const [n, list] of parts) if (!turnNodes.has(n)) entries.push({ at: n, html: () => turnNode(n, null, list, results.get(n) || [], threadTurn(turns, n, ''), false) });
    for (const [n, list] of results) if (!turnNodes.has(n) && !parts.has(n)) entries.push({ at: n, html: () => turnNode(n, null, [], list, threadTurn(turns, n, ''), false) });
    for (const s of segs) entries.push({ at: (Number(s.toTurn) || 0) + 0.5, html: () => segmentNode(s, memNode, turns) });
    for (const s of sums) {
      const r = rangeOf(s.id);
      entries.push({ at: r ? r[1] + 0.6 : 1e9, html: () => `<div class="cc-node cc-seg-node ct-kind-summary">${leafRow(s, infoBtn('rolling'))}${tip('rolling')}</div>` });
    }
    entries.sort((a, b) => a.at - b.at);
    const newest = Math.max(0, ...[...turnNodes.keys()]);
    const body = entries.map((e) => e.html()).join('').replace(`data-turn="${newest}"`, `data-turn="${newest}" data-newest="true"`);
    const memRow = memNode ? `<div class="cc-node cc-seg-node ct-kind-summary">${leafRow(memNode, `<button class="cc-link" type="button" data-tab-go="summary">View</button>`)}</div>` : '';
    const convo = entries.length || memRow
      ? `<div class="cc-node cc-group cc-g-turns" data-group="turns"><div class="cc-row cc-head">${twisty('grp/turns', 'conversation')}<span class="cc-dot"></span><span class="ct-title cc-group-name">Conversation</span><span class="ct-cost">${turnNodes.size} turns</span>${infoBtn('turn')}</div>${tip('turn')}${panel.expanded.has('grp/turns') ? `<div class="cc-kids">${memRow}${body}</div>` : ''}</div>`
      : '';
    if (!items.length && !segs.length) return '<p class="ct-empty">Empty until the first message.</p>';
    return groupBlock('rules', 'Rules', plain.rules) + groupBlock('memory', 'Memory', plain.memory) + convo;
  }

  function tabItems() {
    const unknown = settings == null && lastError && (lastError.what === 'read' || lastError.what === 'on');
    if ((settings && settings.enabled === false) || unknown) {
      return `${errorNote()}<div class="cc-off"><span class="ct-head-line" role="status">${busy === 'on' ? 'Turning on\u2026' : unknown ? 'Status unknown.' : 'Context tree is off.'}</span>${infoBtn('tree')}<button class="ct-on cc-btn" type="button"${busyAttr('on')}>${busy === 'on' ? 'Turning on\u2026' : 'Turn on'}</button></div>${tip('tree')}`;
    }
    return `${errorNote()}${stageNote()}${meter()}<div class="cc-tree ct-list" role="tree" aria-label="Checklist">${tree()}</div>${resetNote()}`;
  }

  function tabSummary() {
    const md = memData();
    const d = md && md.data;
    const m = d && d.memory;
    const at = m && (m.updatedAt || m.createdAt);
    const head = `<div class="cc-sumhead"><span class="cc-badge cc-always">${SYMBOL.locked} Always sent</span>${m && m.throughTurn ? `<span class="cc-when">Turns 1\u2013${esc(num(m.throughTurn))}</span>` : ''}${at ? `<span class="cc-when" data-slot="summary-created">${esc(when(at))}</span>` : ''}${infoBtn('summary')}</div>${tip('summary')}`;
    if (!memApi()) return head + '<p class="ct-empty">No summary yet.</p>';
    return `${head}<div class="cc-mem" data-mem="summary"></div>
      <details class="cc-more" data-key="versions"${panel.detailsOpen && panel.detailsOpen.versions ? ' open' : ''}><summary>Versions</summary><div class="cc-mem" data-mem="history"></div></details>`;
  }

  function tabLog() {
    return `<div class="cc-sumhead"><span class="cc-when">${num(state.log.length)} entries</span>${infoBtn('log')}</div>${tip('log')}<div class="cc-log">${logRows()}</div>`;
  }

  function tabSettings() {
    const on = !!(settings && settings.enabled);
    const unknown = settings == null;
    return `${errorNote()}
      <div class="cc-set"><span class="cc-set-name">Context tree</span>${infoBtn('tree')}
        <button class="cc-switch ${on ? 'ct-off-btn' : 'ct-on'}" type="button" role="switch" aria-checked="${on}" aria-label="Context tree"${busy ? ' disabled' : ''}${unknown ? ' data-unknown="true"' : ''}><span></span></button></div>${tip('tree')}
      <div class="cc-set"><span class="cc-set-name">Reset tree</span>${infoBtn('reset')}<button class="ct-reset-btn cc-btn cc-btn-quiet" type="button"${busyAttr('reset')}>${busy === 'reset' ? 'Resetting\u2026' : 'Reset'}</button></div>${tip('reset')}
      ${resetNote()}
      ${memApi() ? `<div class="cc-mem cc-mem-settings" data-mem="settings"></div>
      <details class="cc-more" data-key="results"${panel.detailsOpen && panel.detailsOpen.results ? ' open' : ''}><summary>Stored results</summary><div class="cc-mem" data-mem="results"></div></details>` : ''}`;
  }

  /** The current tab's content (also what tests read). */
  function render() {
    const t = panel.tab;
    return t === 'summary' ? tabSummary() : t === 'log' ? tabLog() : t === 'settings' ? tabSettings() : tabItems();
  }

  /** Fill the Chat memory parts (summary, versions, settings) the card reuses. */
  function hydrate(root) {
    const cm = memApi();
    const key = activeKey();
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
    if (t === 'summary' || t === 'settings') { const cm = memApi(); const k = activeKey(); if (cm && k && cm.refresh) Promise.resolve(cm.refresh(k)).then(() => paint(true)).catch(() => {}); }
    if (focus && panel.tabs) { const b = panel.tabs.querySelector(`[data-tab="${t}"]`); if (b) b.focus(); }
  }

  function onBodyClick(ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!t) return;
    if (t.dataset.info) { const k = t.dataset.info; if (panel.tips.has(k)) panel.tips.delete(k); else panel.tips.add(k); paint(true); return; }
    if (t.dataset.tw) { const k = t.dataset.tw; if (panel.expanded.has(k)) panel.expanded.delete(k); else panel.expanded.add(k); paint(true); return; }
    if (t.dataset.goTurn) { goToTurn(Number(t.dataset.goTurn), t.dataset.goTitle || ''); return; }
    if (t.dataset.tabGo) { setTab(t.dataset.tabGo, true); return; }
    if (t.dataset.openResult) { const cm = memApi(); if (cm && cm.openResult && activeKey()) cm.openResult(activeKey(), t.dataset.openResult); return; }
    const c = t.classList;
    if (c.contains('ct-on')) { t.disabled = true; setEnabled(true); }
    else if (c.contains('ct-off-btn')) { t.disabled = true; setEnabled(false); }
    else if (c.contains('ct-reset-btn')) { t.disabled = true; resetTree(); }
    else if (c.contains('ct-retry')) { t.disabled = true; lastError = null; paint(true); refresh(); }
  }
  function onBodyChange(ev) {
    const t = ev.target;
    if (t && t.classList && t.classList.contains('ct-check')) setItem(t.dataset.id, !!t.checked);
  }
  function onToggleDetails(ev) {
    const d = ev.target;
    if (d && d.tagName === 'DETAILS' && d.dataset.key) (panel.detailsOpen ||= {})[d.dataset.key] = d.open;
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

  /** Open the card. `tab` picks the tab: items (default), summary, log, settings. */
  function open(anchor, tab) {
    if (!available()) return;
    panel.anchor = (anchor && anchor.nodeType === 1 ? anchor : null) || document.querySelector('.ct-toggle') || document.querySelector('[data-slot="token-meter"]:not([hidden])');
    if (typeof anchor === 'string') tab = anchor;
    if (tab) panel.tab = TABS.some(([k]) => k === tab) ? tab : 'items';
    place(panel.anchor);
    panel.open = true;
    panel.root.hidden = false;
    syncExpanded();
    setTab(panel.tab);
    refresh();
    const cm = memApi(); const k = activeKey();
    if (cm && k && cm.refresh) Promise.resolve(cm.refresh(k)).then(() => paint()).catch(() => {});
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
    if (cm && cm.subscribe && !panel.memSub) panel.memSub = cm.subscribe((k) => { if (panel.open && k === activeKey()) paint(); });
    paint();
  }

  /** Wire the panel to the engine's event stream, once. Called with the app
   * (`ContextTree.install(app)`); the events arrive on `app.chat._onEvent` with
   * their name in `eventType`, like every other engine event. */
  function install(app) {
    try {
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
            }
          }
          return base(event);
        };
        if (typeof runtime.on === 'function') {
          runtime.on('main', () => { state = { rev: 0, counts: null, tokens: null, items: [], log: [], stage: '', model: '' }; pendingSet = new Map(); attachToggles(); refresh(); });
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
