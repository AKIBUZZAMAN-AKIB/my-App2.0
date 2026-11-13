/* ==========================================================================
   Token meter (stage E). Reads the engine's `context.limit_resolved` and
   `context.usage` events (token counts in the active model's own tokenizer)
   and shows how full the context window is, per chat, next to the model
   button. With engine feature `countTokens`, the draft in the composer is
   counted too (debounced, offline count; a rough 4-chars-per-token estimate
   otherwise). Nothing here changes an existing NativeKit method or key.
   ========================================================================== */
const TokenMeter = (() => {
  const usage = new Map(); // sessionKey -> merged numbers
  const windows = new Map(); // `${provider}/${model}` -> context window in tokens
  let appRef = null;
  let draft = { tokens: 0, method: '', text: '' };
  let draftTimer = 0;
  let draftSeq = 0;
  let popover = null;
  const subs = new Set();

  const valid = (v) => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const fmt = (n) => {
    n = num(n);
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(Math.round(n));
  };
  const full = (n) => Math.round(num(n)).toLocaleString('en-US');
  const activeKey = () => appRef?.chat?.mainId || null;

  /** The window for a model, from engine events first, then from the model list. */
  function windowFor(provider, model) {
    if (!model) return 0;
    const k = `${provider || ''}/${model}`;
    if (windows.get(k)) return windows.get(k);
    const list = appRef?.settings?.models?.[provider];
    const m = Array.isArray(list) ? list.find((x) => x && x.id === model) : null;
    const v = m ? num(m.contextLength ?? m.context_length ?? m.contextWindow ?? m.context_window ?? m.inputTokenLimit ?? m.top_provider?.context_length) : 0;
    return v;
  }

  /** One engine event. Returns true when it was a token event. */
  function onEvent(type, p) {
    if (type !== 'context.usage' && type !== 'context.limit_resolved') return false;
    if (!p || typeof p !== 'object') return true;
    if (type === 'context.usage' && !valid(p.inputTokens) && !valid(p.outputTokens)) return true; // nothing usable
    const key = typeof p.sessionKey === 'string' && p.sessionKey ? p.sessionKey : activeKey() || '_';
    const cur = usage.get(key) || {};
    const next = { ...cur, at: Date.now() };
    if (type === 'context.limit_resolved') {
      for (const f of ['contextLimitTokens', 'contextBudgetTokens', 'configuredBudgetTokens', 'reservedInputTokens', 'estimatedContextTokens', 'maxOutputTokens']) if (valid(p[f])) next[f] = Number(p[f]);
      if (next.reservedOutputTokens === undefined && p.maxOutputTokens !== undefined) next.reservedOutputTokens = num(p.maxOutputTokens);
      // A fresh request: until the reply's usage comes back, the estimate is the best number.
      if (p.estimatedContextTokens !== undefined) next.estimated = num(p.reservedInputTokens) + num(p.estimatedContextTokens);
      next.pending = true;
    } else {
      for (const f of ['inputTokens', 'outputTokens', 'contextLimitTokens', 'contextBudgetTokens', 'reservedOutputTokens', 'estimatedInputTokens']) if (valid(p[f])) next[f] = Number(p[f]);
      if (p.tokenizer && typeof p.tokenizer === 'object') next.tokenizer = { encoding: String(p.tokenizer.encoding || ''), exact: !!p.tokenizer.exact, method: String(p.tokenizer.method || '') };
      if (p.provider) next.provider = String(p.provider);
      if (p.model) next.model = String(p.model);
      next.pending = false;
    }
    if (next.provider && next.model && next.contextLimitTokens) windows.set(`${next.provider}/${next.model}`, next.contextLimitTokens);
    usage.set(key, next);
    paint();
    return true;
  }

  /** What the meter shows for the active chat: used, limit, percent. */
  function snapshot(key = activeKey()) {
    const u = usage.get(key || '_') || (key ? null : usage.get('_')) || null;
    const s = appRef?.settings;
    const provider = u?.provider || s?.get?.('provider') || '';
    const model = u?.model || s?.get?.('model') || '';
    const limit = num(u?.contextBudgetTokens) || num(u?.contextLimitTokens) || windowFor(provider, model);
    const used = u ? (u.pending && u.estimated ? u.estimated : num(u.inputTokens) + num(u.outputTokens) || num(u.estimated)) : 0;
    const withDraft = used + num(draft.tokens);
    const pct = limit ? Math.min(100, (withDraft / limit) * 100) : 0;
    return { u, used, draft: num(draft.tokens), draftMethod: draft.method, withDraft, limit, pct, provider, model, window: num(u?.contextLimitTokens) || windowFor(provider, model) };
  }

  function level(pct) { return pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : 'ok'; }

  function meterEl() {
    const btn = h('button', {
      type: 'button', class: 'tk-meter', 'data-slot': 'token-meter', hidden: true,
      'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onclick: (e) => { e.stopPropagation(); togglePopover(btn); },
    },
    h('span', { class: 'tk-ring', 'aria-hidden': 'true' }, h('span', { class: 'tk-ring-fill' })),
    h('span', { class: 'tk-text' }));
    return btn;
  }

  function paint() {
    const snap = snapshot();
    for (const btn of document.querySelectorAll('[data-slot="token-meter"]')) {
      const has = snap.used > 0 || snap.draft > 0;
      btn.hidden = !has;
      if (!has) continue;
      const lv = level(snap.pct);
      btn.dataset.level = lv;
      btn.style.setProperty('--tk-pct', `${snap.pct.toFixed(1)}%`);
      btn.querySelector('.tk-text').textContent = snap.limit ? `${fmt(snap.withDraft)} / ${fmt(snap.limit)}` : `${fmt(snap.withDraft)} tokens`;
      btn.setAttribute('aria-label', snap.limit
        ? `Context: ${full(snap.withDraft)} of ${full(snap.limit)} tokens (${Math.round(snap.pct)}%)${snap.draft ? `, including about ${full(snap.draft)} in your draft` : ''}. Show details`
        : `Context: ${full(snap.withDraft)} tokens used. Show details`);
    }
    if (popover?.isConnected) fillPopover(popover);
    for (const fn of subs) { try { fn(snap); } catch { /* listener bug */ } }
  }

  function fillPopover(pop) {
    const s = snapshot();
    const u = s.u || {};
    const row = (label, value, slot) => h('div', { class: 'tk-row', 'data-slot': slot }, h('dt', null, label), h('dd', null, value));
    const tok = u.tokenizer;
    pop.querySelector('.tk-pop-body').replaceChildren(
      h('div', { class: 'tk-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(s.limit || 0)), 'aria-valuenow': String(Math.round(s.withDraft)), 'aria-label': 'Context used', 'data-level': level(s.pct) },
        h('span', { class: 'tk-bar-fill', style: `width:${s.pct.toFixed(1)}%` })),
      h('dl', { class: 'tk-rows' },
        row('Model', s.model ? `${s.model}` : 'Not chosen', 'tk-model'),
        row('Model window', s.window ? `${full(s.window)} tokens` : 'Unknown', 'tk-window'),
        row('Budget for this chat', s.limit ? `${full(s.limit)} tokens${u.configuredBudgetTokens ? ' (your limit)' : ''}` : 'Unknown', 'tk-budget'),
        row(u.pending ? 'Sent so far (estimate)' : 'Last request', `${full(u.pending ? u.estimated : u.inputTokens)} tokens`, 'tk-input'),
        !u.pending && row('Last reply', `${full(u.outputTokens)} tokens`, 'tk-output'),
        u.reservedOutputTokens ? row('Kept free for the reply', `${full(u.reservedOutputTokens)} tokens`, 'tk-reserved') : null,
        s.draft ? row('Your draft', `${s.draftMethod === 'estimate' ? 'about ' : ''}${full(s.draft)} tokens`, 'tk-draft') : null,
        row('Counted with', tok ? `${tok.encoding || 'model tokenizer'}${tok.exact ? '' : ' (estimate)'}` : 'Engine estimate', 'tk-tokenizer')),
      s.pct >= 80 ? h('p', { class: 'tk-warn', role: 'note' }, s.pct >= 95 ? 'Almost full. The engine will drop or summarise the oldest messages on the next turn.' : 'Getting full. Older messages may be shortened soon.') : null,
    );
  }

  function togglePopover(anchor) {
    if (popover?.isConnected) { closePopover(); return; }
    popover = h('div', { class: 'tk-pop', role: 'dialog', 'aria-label': 'Context usage', 'data-slot': 'token-details', tabindex: '-1' },
      h('div', { class: 'tk-pop-head' }, h('p', { class: 'tk-pop-title' }, 'Context usage'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Close', onclick: () => closePopover() }, icon('x'))),
      h('div', { class: 'tk-pop-body' }));
    fillPopover(popover);
    const host = anchor.closest('.aui-composer-shell') || document.body;
    host.append(popover);
    anchor.setAttribute('aria-expanded', 'true');
    popover.focus();
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', esc, true);
  }
  function outside(e) { if (popover && !popover.contains(e.target) && !e.target.closest?.('[data-slot="token-meter"]')) closePopover(); }
  function esc(e) { if (e.key === 'Escape' && popover?.isConnected) { e.stopPropagation(); closePopover(true); } }
  function closePopover(focusBack) {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    popover?.remove();
    popover = null;
    const btn = document.querySelector('[data-slot="token-meter"]');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (focusBack) btn.focus(); }
  }

  /** Count the draft: engine `countTokens` when it has it, else about 4 characters per token. */
  function countDraft(text) {
    clearTimeout(draftTimer);
    const seq = ++draftSeq;
    if (!text.trim()) { draft = { tokens: 0, method: '', text: '' }; paint(); return; }
    draftTimer = setTimeout(async () => {
      let tokens = Math.ceil(text.length / 4), method = 'estimate';
      const a = nativeKit()?.agent;
      const s = appRef?.settings;
      const provider = s?.get?.('provider') || '', model = s?.get?.('model') || '';
      if (engine.has('countTokens') && typeof a?.countTokens === 'function' && provider && model && provider !== 'auto') {
        try {
          const r = await a.countTokens(provider, model, text, { online: false });
          const v = parseMaybeJSON(r?.resultJson, r) || r;
          if (Number.isFinite(Number(v?.tokens))) { tokens = Number(v.tokens); method = v.method || 'exact'; }
        } catch { /* keep the estimate */ }
      }
      if (seq !== draftSeq) return; // a newer keystroke won
      draft = { tokens, method, text };
      paint();
    }, 500);
  }

  function attach() {
    for (const start of document.querySelectorAll('.aui-composer-root .aui-composer-action-start')) {
      if (start.querySelector('[data-slot="token-meter"]')) continue;
      start.append(meterEl());
      const input = start.closest('.aui-composer-shell')?.querySelector('.aui-composer-input');
      if (input && !input._tkWired) {
        input._tkWired = true;
        input.addEventListener('input', () => countDraft(input.value));
      }
    }
    paint();
  }

  function install(app) {
    appRef = app;
    const runtime = app.chat;
    if (runtime && typeof runtime._onEvent === 'function' && !runtime._tkWrapped) {
      const base = runtime._onEvent.bind(runtime);
      runtime._tkWrapped = true;
      runtime._onEvent = (event) => {
        const type = event?.eventType ?? event?.type ?? '';
        if (type === 'context.usage' || type === 'context.limit_resolved') {
          const p = parseMaybeJSON(event?.payloadJson ?? event?.payload ?? event?.data, {}) || {};
          try { onEvent(type, p); } catch (e) { console.warn('token meter', e); }
        }
        return base(event);
      };
    }
    runtime?.on?.('main', () => { draft = { tokens: 0, method: '', text: '' }; attach(); });
    runtime?.on?.('threads', () => attach());
    attach();
    // After a send the composer clears without an input event.
    document.addEventListener('submit', () => countDraft(''), true);
  }

  const api = { install, onEvent, snapshot, windowFor, attach, usage, windows, fmt, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }, resetDraft() { countDraft(''); } };
  if (typeof window !== 'undefined') window.__tokens = api;
  return api;
})();
