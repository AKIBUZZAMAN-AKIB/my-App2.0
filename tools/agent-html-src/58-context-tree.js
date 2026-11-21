/* ==========================================================================
   Context tree: the window the model is actually given.

   The engine now gives the model a checklist of everything in and around its
   context window (in / out / note / temp / locked, with what each item costs)
   and a `ctx` tool to change it. This screen shows the *same* truth to the
   person using the app, plus the one thing the model cannot see: why an item
   left ("budget", "category cap", "forced"), from the engine's action log.

   Two rules shape it:

   * **Nothing here is invented.** Every row comes from a `context.tree` event or
     from a `ctx` tool result the engine already produced. If the engine does not
     send it, the panel says so instead of guessing.
   * **It never throws.** A missing field, an old build or a half-written event
     leaves a warning in the console and an empty panel, never a broken chat.

   Available when the engine lists "contextTree"; otherwise the entry point is
   not shown at all.
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
  const panel = { root: null, body: null, open: false, anchor: null, inline: null };
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

  function headLine() {
    const c = state.counts || {};
    const t = state.tokens || {};
    const parts = [];
    if (state.model) parts.push(esc(state.model));
    parts.push(`${num(c.in)} in · ${num(c.note)} note · ${num(c.out)} out`);
    if (t.selectable) parts.push(`${short(t.sent)} / ${short(t.selectable)} tokens`);
    if (state.rev) parts.push(`rev ${esc(state.rev)}`);
    return parts.join(' · ');
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

  const CAT_LABEL = { sys: 'Rules', rules: 'Rules', tools: 'Tools', turns: 'Conversation', files: 'Files', notes: 'Notes', memory: 'Memory', items: 'Items' };
  const catLabel = (c) => CAT_LABEL[c] || String(c).replace(/^cat\//, '').replace(/[-_]/g, ' ');
  /** Can the person switch this item in or out? Locked and engine-pinned items cannot. */
  const switchable = (it) => it.pin !== 'locked' && it.pin !== 'policy' && it.kind !== 'system' && !String(it.id || '').startsWith('sys/');

  /** The checklist: every item, grouped, with a real checkbox for the ones the
   * person may change (bring back / take out). The state shown is the engine's;
   * a change waits for the engine's answer (shown as busy) and is undone with a
   * message if the engine refuses it. */
  function itemRows() {
    if (!state.items.length) return '<p class="ct-empty">No items yet. The list appears with the first request after the feature is on.</p>';
    const byCat = new Map();
    for (const it of state.items) {
      const cat = it.cat || it.parent || 'items';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    let html = '';
    const noteCost = (it) => (typeof it.tokensNote === 'number' ? it.tokensNote : Math.round((it.tokens || 0) / 10));
    for (const [cat, items] of byCat) {
      const sent = items.reduce((n, it) => n + (it.state === 'in' ? (it.tokens || 0) : it.state === 'note' ? noteCost(it) : 0), 0);
      const inCount = items.filter((it) => it.state === 'in' || it.state === 'note').length;
      html += `<fieldset class="ct-cat"><legend class="ct-cat-head"><span class="ct-cat-name">${esc(catLabel(cat))}</span><span class="ct-cat-meta">${inCount}/${items.length} · ${short(sent)}</span></legend>`;
      for (const it of items) {
        const st = pendingSet.has(it.id) ? pendingSet.get(it.id) : (it.state || 'out');
        const sym = it.pin === 'locked' ? SYMBOL.locked : (SYMBOL[st] || '·');
        const cost = st === 'in' ? short(it.tokens) : st === 'note' ? `${short(noteCost(it))} note` : st === 'temp' ? 'summary' : 'out';
        const label = `${STATE_LABEL[st] || st}${it.pin && it.pin !== 'none' ? ' · pinned (' + it.pin + ')' : ''}`;
        const checked = st === 'in' || st === 'note' || st === 'temp';
        const canSwitch = switchable(it) && !busy;
        const control = switchable(it)
          ? `<input class="ct-check" type="checkbox" data-id="${esc(it.id || '')}"${checked ? ' checked' : ''}${canSwitch && !pendingSet.has(it.id) ? '' : ' disabled'}${pendingSet.has(it.id) ? ' aria-busy="true"' : ''} aria-describedby="ct-d-${esc(cssId(it.id))}">`
          : `<span class="ct-sym" aria-hidden="true">${sym}</span>`;
        html += `<label class="ct-item ct-state-${esc(st)}${it.kind === 'summary' ? ' ct-kind-summary' : ''}" title="${esc(label)}">
            ${control}
            <span class="ct-title">${esc(it.title || it.id)}</span>
            <span class="ct-cost" id="ct-d-${esc(cssId(it.id))}"><span class="ct-sr">${esc(label)}, </span>${esc(cost)}</span>
            <span class="ct-id">${esc(it.id || '')}</span>
          </label>`;
      }
      html += '</fieldset>';
    }
    return html;
  }
  const cssId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');

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


  /** What each item costs, subtotals by state, and the total against the budget.
   * Every number shown is a number the engine sent; a missing one reads "—" rather
   * than a zero that would look like a measurement. */
  function tokenCard() {
    const items = Array.isArray(state.items) ? state.items : [];
    const tok = (i) => {
      const v = i.tokens ?? i.tokensFull ?? i.tokens_full;
      return typeof v === 'number' ? v : null;
    };
    const sum = (list) => list.reduce((a, i) => a + (tok(i) || 0), 0);
    const byState = {};
    for (const i of items) {
      const k = i.state || 'unknown';
      byState[k] = (byState[k] || 0) + (tok(i) || 0);
    }
    const total = state.tokens && typeof state.tokens.selected === 'number'
      ? state.tokens.selected
      : sum(items);
    const windowSize = state.tokens && typeof state.tokens.window === 'number' ? state.tokens.window : null;
    const pct = windowSize ? Math.min(100, Math.round((total / windowSize) * 100)) : null;
    const rows = items
      .slice()
      .sort((a, b) => (tok(b) || 0) - (tok(a) || 0))
      .map((i) => `<tr><td class="ct-tk-name">${esc(i.title || i.id || '—')}</td>
        <td class="ct-tk-sym">${esc(SYMBOL[i.state] || '·')}</td>
        <td class="ct-tk-num">${tok(i) == null ? '—' : num(tok(i))}</td></tr>`)
      .join('');
    const subs = Object.keys(byState)
      .map((k) => `<li><span>${esc(STATE_LABEL[k] || k)}</span><span class="ct-tk-num">${num(byState[k])}</span></li>`)
      .join('');
    return `<div class="ct-card">
      <div class="ct-tk-head">
        <span>${esc(short(total))} tokens sent</span>
        <span>${windowSize ? 'of ' + esc(short(windowSize)) + ' window' : 'window size unknown'}${pct == null ? '' : ' · ' + pct + '%'}</span>
      </div>
      <ul class="ct-tk-sub">${subs || '<li><span>The engine has not sent a breakdown yet</span><span class="ct-tk-num">—</span></li>'}</ul>
      <table class="ct-tk-table"><thead><tr><th>Item</th><th></th><th>Tokens</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="ct-tk-empty">No items yet.</td></tr>'}</tbody></table>
    </div>`;
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

  function render() {
    // Never a dead end: when the engine's answer is unknown because reading it
    // failed, offer the switch instead of an empty tree with only an "Off" button.
    const unknown = settings == null && lastError && (lastError.what === 'read' || lastError.what === 'on');
    if ((settings && settings.enabled === false) || unknown) {
      return `<div class="ct-head"><strong class="ct-head-title">Context window</strong><span class="ct-head-line" role="status">${busy === 'on' ? 'Turning on…' : unknown ? 'Status unknown' : 'Off'}</span></div>
      ${errorNote()}
      <p class="ct-off">The context window is off. The chat behaves exactly as it did before this feature existed:
      nothing is listed, nothing is summarised, and no turn is touched.</p>
      <button class="ct-on" type="button"${busyAttr('on')}>${busy === 'on' ? 'Turning on…' : 'Turn it on'}</button>
      <p class="ct-foot">Turning it on lists what is in the window and lets the model ask for things to be
      summarised. Nothing is ever deleted.</p>`;
    }
    return `<div class="ct-head"><strong class="ct-head-title">Context window</strong><span class="ct-head-line" role="status">${busy === 'off' ? 'Turning off…' : headLine()}</span><button class="ct-off-btn" type="button" title="Turn the context window off" aria-label="Turn the context window off"${busyAttr('off')}>Off</button></div>
      ${errorNote()}
      ${stageNote()}
      <section class="ct-section ct-list" aria-labelledby="ct-h-items"><h3 id="ct-h-items">What is in the window</h3>
      <p class="ct-hint">Untick an item to leave it out of the next request; tick it to bring it back. Nothing is deleted.</p>
      ${itemRows()}</section>
      <details class="ct-section ct-more"${panel.detailsOpen?.tokens ? ' open' : ''} data-key="tokens"><summary>Token breakdown</summary>${tokenCard()}</details>
      <details class="ct-section ct-more"${panel.detailsOpen?.log ? ' open' : ''} data-key="log"><summary>Why things left</summary>${logRows()}</details>
      ${resetNote()}
      <p class="ct-foot">Nothing is deleted by taking it out: every item is still stored and can be brought back.</p>
      <div class="ct-actions"><button class="ct-reset-btn" type="button" title="Delete this chat's tree, notes and strategy; the chat stays"${busyAttr('reset')}>${busy === 'reset' ? 'Resetting…' : 'Reset tree'}</button></div>`;
  }

  function paint() {
    const html = (() => { try { return render(); } catch (e) { console.warn('context tree paint', e); return null; } })();
    if (html == null) return;
    // Painted on engine events and clicks only, never per keystroke. The
    // sheet's DOM stays current while closed so opening it is instant.
    if (panel.body) {
      const sc = panel.body.scrollTop;
      panel.body.innerHTML = html;
      panel.body.scrollTop = sc;
    }
    if (panel.inline && panel.inline.isConnected) panel.inline.innerHTML = html;
    paintUsage();
  }

  /** The usage line in the sheet's header: the same numbers as the token chip. */
  function paintUsage() {
    if (!panel.root || !panel.open) return;
    const el = panel.root.querySelector('.ct-usage');
    const bar = panel.root.querySelector('.ct-usage-bar');
    const tk = typeof window !== 'undefined' ? window.__tokens : null;
    let text = '', pct = 0, lv = 'ok';
    try {
      const snap = tk && tk.snapshot ? tk.snapshot() : null;
      if (snap && (snap.used || snap.draft)) {
        text = snap.limit ? `${tk.fmt(snap.withDraft)} / ${tk.fmt(snap.limit)} tokens` : `${tk.fmt(snap.withDraft)} tokens`;
        pct = snap.pct || 0;
        lv = tk.level ? tk.level(pct) : 'ok';
      }
    } catch (e) { /* no meter in this build */ }
    if (el && el.textContent !== text) el.textContent = text;
    if (bar) {
      bar.hidden = !text;
      bar.dataset.level = lv;
      bar.style.setProperty('--ct-pct', `${pct.toFixed(1)}%`);
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
  }

  function onBodyClick(ev) {
    const t = ev.target;
    if (!t || !t.classList) return;
    if (t.classList.contains('ct-on')) {
      t.disabled = true;
      setEnabled(true);
    } else if (t.classList.contains('ct-off-btn')) {
      t.disabled = true;
      setEnabled(false);
    } else if (t.classList.contains('ct-reset-btn')) {
      t.disabled = true;
      resetTree();
    } else if (t.classList.contains('ct-retry')) {
      t.disabled = true;
      lastError = null;
      paint();
      refresh();
    }
  }
  function onBodyChange(ev) {
    const t = ev.target;
    if (t && t.classList && t.classList.contains('ct-check')) setItem(t.dataset.id, !!t.checked);
  }
  function onToggleDetails(ev) {
    const d = ev.target;
    if (d && d.tagName === 'DETAILS' && d.dataset.key) (panel.detailsOpen ||= {})[d.dataset.key] = d.open;
  }

  /** The composer the sheet belongs to: it opens just above the message box. */
  function composerShell(anchor) {
    return (anchor && anchor.closest && anchor.closest('.aui-composer-shell'))
      || document.querySelector('.aui-composer-root .aui-composer-shell, .aui-composer-shell')
      || null;
  }

  /** Build the sheet once. It lives with the composer, never in the message list. */
  function ensureSheet() {
    if (panel.root) return panel.root;
    const root = document.createElement('div');
    root.className = 'ct-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-labelledby', 'ct-sheet-title');
    root.hidden = true;
    root.innerHTML = `<div class="ct-sheet-head">
        <div class="ct-sheet-titles">
          <h2 class="ct-sheet-title" id="ct-sheet-title">Context window</h2>
          <span class="ct-usage" aria-live="polite"></span>
        </div>
        <button class="ct-close" type="button" aria-label="Close the context window"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <div class="ct-usage-bar" role="meter" aria-label="Context used" aria-valuemin="0" aria-valuemax="100" hidden><span></span></div>
      <div class="ct-body" tabindex="-1"></div>`;
    const body = root.querySelector('.ct-body');
    root.querySelector('.ct-close').addEventListener('click', () => close(true));
    body.addEventListener('click', onBodyClick);
    body.addEventListener('change', onBodyChange);
    body.addEventListener('toggle', onToggleDetails, true);
    panel.root = root;
    panel.body = body;
    return root;
  }

  /** Put the sheet in the composer shell (absolute, above the input), or float it. */
  function place(anchor) {
    const root = ensureSheet();
    const shell = composerShell(anchor);
    const host = shell || document.body;
    if (root.parentNode !== host) host.appendChild(root);
    root.dataset.place = shell ? 'composer' : 'float';
    // Open on the side of the composer with more room, and never taller than
    // that room, so the header and close button are always on screen.
    root.dataset.side = 'above';
    root.style.removeProperty('--ct-room');
    if (shell) {
      const r = shell.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const above = r.top - 16;
      const below = vh - r.bottom - 16;
      const side = above >= 280 || above >= below ? 'above' : 'below';
      root.dataset.side = side;
      root.style.setProperty('--ct-room', `${Math.max(180, Math.floor(side === 'above' ? above : below))}px`);
    }
  }

  function onKey(e) {
    if (e.key === 'Escape' && panel.open) { e.stopPropagation(); close(true); }
  }
  function onOutside(e) {
    if (!panel.open || !panel.root) return;
    const t = e.target;
    if (panel.root.contains(t)) return;
    if (t && t.closest && t.closest('[data-slot="token-meter"], .ct-toggle')) return;
    close(false);
  }

  function open(anchor) {
    if (!available()) return;
    place(anchor);
    panel.anchor = anchor || document.querySelector('[data-slot="token-meter"]:not([hidden])') || document.querySelector('.ct-toggle');
    panel.open = true;
    panel.root.hidden = false;
    syncExpanded();
    paint();
    refresh();
    try { panel.body.focus({ preventScroll: true }); } catch (e) { /* old webview */ }
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }

  function close(focusBack) {
    if (!panel.root) return;
    panel.open = false;
    panel.root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    syncExpanded();
    if (focusBack && panel.anchor && panel.anchor.isConnected) { try { panel.anchor.focus(); } catch (e) { /* gone */ } }
  }

  function toggle(anchor) {
    if (panel.open && (!anchor || !panel.root || composerShell(anchor) === panel.root.parentNode || !composerShell(anchor))) close(true);
    else open(anchor);
  }

  function syncExpanded() {
    for (const b of document.querySelectorAll('[data-slot="token-meter"], .ct-toggle')) {
      b.setAttribute('aria-expanded', String(!!panel.open));
      b.setAttribute('aria-controls', 'ct-sheet-title');
    }
  }

  /** A small "Context" chip in the composer for when the token chip is not shown
   * yet (a new chat). With the token chip visible, CSS hides this one. */
  function attachToggles() {
    if (!available()) return;
    for (const start of document.querySelectorAll('.aui-composer-root .aui-composer-action-start')) {
      if (start.querySelector('.ct-toggle')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ct-toggle';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', String(!!panel.open));
      btn.setAttribute('aria-label', 'Open the context window');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zm-9 9l9 5 9-5M3 16l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>Context</span>';
      btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(btn); });
      start.appendChild(btn);
    }
  }

  /** Make the panel ready: the sheet (closed), the composer chip, and an inline
   * copy when a screen hosts it (`[data-panel-host]`, the agent shell's
   * Context screen). It is never put in the message list. */
  function mount() {
    if (!available()) return;
    ensureSheet();
    if (!panel.root.parentNode) place(null);
    attachToggles();
    if (!panel.usageSub) {
      const tk = typeof window !== 'undefined' ? window.__tokens : null;
      if (tk && typeof tk.subscribe === 'function') panel.usageSub = tk.subscribe(() => paintUsage());
    }
    const host = document.querySelector('[data-panel-host]');
    if (host && !host.querySelector('.ct-inline')) {
      const inline = document.createElement('div');
      inline.className = 'ct-inline ct-body';
      inline.addEventListener('click', onBodyClick);
      inline.addEventListener('change', onBodyChange);
      inline.addEventListener('toggle', onToggleDetails, true);
      host.appendChild(inline);
      panel.inline = inline;
    }
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
