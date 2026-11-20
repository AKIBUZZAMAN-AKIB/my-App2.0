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
  function onToolResult(name, result) {
    if (name !== 'ctx') return;
    const r = parseMaybeJSON(result, null);
    if (!r) return;
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

  function render() {
    return `<div class="ct-head"><strong>Context window</strong><span class="ct-head-line">${headLine()}</span></div>
      ${stageNote()}
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

  const out = { install, mount, render, onEvent, onToolResult, available, state: () => state, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };
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
