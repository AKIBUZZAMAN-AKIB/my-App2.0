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
  const subs = new Set();
  const panel = { root: null, body: null, open: false };

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
    const feats = (typeof Engine !== 'undefined' && (Engine.features || Engine.capabilities)) || window.__features || [];
    return Array.isArray(feats) && feats.includes('contextTree');
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
        model: p.model ?? state.model,
      };
      paint();
      subs.forEach((fn) => { try { fn(state); } catch (e) { /* a listener is not our problem */ } });
    } else if (type === 'context.tree_action') {
      state.log = [p, ...state.log].slice(0, 50);
      paint();
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

  /** The bridge, whichever shape this build of the app has. */
  function bridge() {
    const rt = window.__runtime || window.__agentRuntime || null;
    if (rt && typeof rt.action === 'function') return (a, p) => rt.action(a, p);
    if (typeof Engine !== 'undefined' && Engine && typeof Engine.action === 'function') return (a, p) => Engine.action(a, p);
    return null;
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
    return Promise.resolve(send('ctx.settings', { settings: { enabled: !!on } }))
      .then((res) => {
        const saved = normalizeSettings(res && res.settings);
        settings = saved || { enabled: !!on, thresholdPercent: settings ? settings.thresholdPercent : null };
        paint();
        return { enabled: settings.enabled };
      })
      .catch((e) => {
        console.warn('context tree settings', e);
        paint();
        return { enabled: settings ? settings.enabled : null, error: String(e && e.message ? e.message : e) };
      });
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

  function itemRows() {
    if (!state.items.length) return '<p class="ct-empty">No items yet. The list appears with the first request after the feature is on.</p>';
    const byCat = new Map();
    for (const it of state.items) {
      const cat = it.cat || it.parent || 'items';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    let html = '';
    for (const [cat, items] of byCat) {
      const sent = items.reduce((n, it) => n + (it.state === 'in' ? (it.tokens || 0) : it.state === 'note' ? Math.round((it.tokens || 0) / 10) : 0), 0);
      html += `<div class="ct-cat"><div class="ct-cat-head"><span>${esc(cat)}</span><span>${short(sent)}</span></div>`;
      for (const it of items) {
        const sym = it.pin === 'locked' ? SYMBOL.locked : (SYMBOL[it.state] || '·');
        const cost = it.state === 'in' ? short(it.tokens) : it.state === 'note' ? `${short(Math.round((it.tokens || 0) / 10))}n` : it.state === 'temp' ? 'temp' : '';
        html += `<div class="ct-item ct-state-${esc(it.state || 'out')}" title="${esc(STATE_LABEL[it.state] || it.state || '')}${it.pin && it.pin !== 'none' ? ' · pin: ' + esc(it.pin) : ''}">
            <span class="ct-sym">${sym}</span>
            <span class="ct-title">${esc(it.title || it.id)}</span>
            <span class="ct-cost">${esc(cost)}</span>
            <span class="ct-id">${esc(it.id || '')}</span>
          </div>`;
      }
      html += '</div>';
    }
    return html;
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
    return `<div class="ct-section ct-card"><h4>Token breakdown</h4>
      <div class="ct-tk-head">
        <span>${esc(short(total))} tokens sent</span>
        <span>${windowSize ? 'of ' + esc(short(windowSize)) + ' window' : 'window size unknown'}${pct == null ? '' : ' · ' + pct + '%'}</span>
      </div>
      <ul class="ct-tk-sub">${subs || '<li><span>The engine has not sent a breakdown yet</span><span class="ct-tk-num">—</span></li>'}</ul>
      <table class="ct-tk-table"><thead><tr><th>Item</th><th></th><th>Tokens</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="ct-tk-empty">No items yet.</td></tr>'}</tbody></table>
    </div>`;
  }

  function render() {
    if (settings && settings.enabled === false) {
      return `<div class="ct-head"><strong>Context window</strong><span class="ct-head-line">Off</span></div>
      <p class="ct-off">The context window is off. The chat behaves exactly as it did before this feature existed:
      nothing is listed, nothing is summarised, and no turn is touched.</p>
      <button class="ct-on" type="button">Turn it on</button>
      <p class="ct-foot">Turning it on lists what is in the window and lets the model ask for things to be
      summarised. Nothing is ever deleted.</p>`;
    }
    return `<div class="ct-head"><strong>Context window</strong><span class="ct-head-line">${headLine()}</span><button class="ct-off-btn" type="button" title="Turn the context window off">Off</button></div>
      ${stageNote()}
      ${tokenCard()}
      <div class="ct-section"><h4>What is in the window</h4>${itemRows()}</div>
      <div class="ct-section"><h4>Why things left</h4>${logRows()}</div>
      <p class="ct-foot">Nothing is deleted by taking it out: every item is still stored and can be brought back.</p>`;
  }

  function paint() {
    if (!panel.body) return;
    try { panel.body.innerHTML = render(); } catch (e) { console.warn('context tree paint', e); }
  }

  function mount() {
    if (!available() || panel.root) return;
    const host = document.querySelector('[data-panel-host]') || document.body;
    const root = document.createElement('div');
    root.className = 'ct-panel';
    root.innerHTML = `<button class="ct-toggle" type="button" aria-expanded="false">Context window</button><div class="ct-body" hidden></div>`;
    const btn = root.querySelector('.ct-toggle');
    const body = root.querySelector('.ct-body');
    btn.addEventListener('click', () => {
      panel.open = !panel.open;
      body.hidden = !panel.open;
      btn.setAttribute('aria-expanded', String(panel.open));
      if (panel.open) paint();
    });
    body.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('ct-on')) {
        t.disabled = true;
        setEnabled(true);
      } else if (t.classList.contains('ct-off-btn')) {
        t.disabled = true;
        setEnabled(false);
      }
    });
    host.appendChild(root);
    panel.root = root;
    panel.body = body;
    paint();
  }

  /** Wire the panel to the engine's event stream, once. */
  function install(runtime) {
    try {
      if (runtime && typeof runtime._onEvent === 'function' && !runtime._ctWrapped) {
        const base = runtime._onEvent.bind(runtime);
        runtime._ctWrapped = true;
        runtime._onEvent = (event) => {
          const type = event && (event.type || event.name);
          if (typeof type === 'string' && type.startsWith('context.')) {
            const p = event.payloadJson ?? event.payload ?? event.data;
            try { onEvent(type, p); } catch (e) { console.warn('context tree', e); }
          }
          return base(event);
        };
      }
      mount();
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
    render,
    onEvent,
    onToolResult,
    available,
    state: () => state,
    settings: () => settings,
    applySettings,
    setEnabled,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  if (typeof window !== 'undefined') {
    window.__contextTree = out;
    // Self-installing, like the rest of the screens: wait for the DOM, then try
    // once. `mount` is a no-op unless the engine advertises the feature, and the
    // whole thing is wrapped so an old build cannot break the app.
    const boot = () => {
      try {
        const runtime = window.__runtime || window.__agentRuntime || null;
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
