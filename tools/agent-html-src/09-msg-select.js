/* ==========================================================================
   Message multi-select for a sub-agent's chat (the Chat tab and "Open as chat").
   Research (docs/subagents/SUBAGENT_UI_REDESIGN.md, "Multi-select"):
   - Telegram / WhatsApp / iMessage: long-press a message enters selection; a tap
     then adds or removes; a bar shows the count and the actions; Esc or X leaves.
   - Material 3 contextual action bar: the count replaces the title, a close icon
     leads, the actions trail; Apple HIG edit mode: real checkboxes, Select all.
   - Desktop: Shift-click selects a range, Ctrl/Cmd-click starts or toggles,
     Space toggles the focused message, Shift+Arrow extends, Ctrl/Cmd+A selects all.
   Selection never changes the chat; it only feeds the bar's actions.
   One controller per container; state survives a repaint of the container.
   ========================================================================== */
const MsgSelect = (() => {
  const LONG_MS = 450;
  const MOVE_PX = 8;
  if (typeof ICONS !== 'undefined') {
    if (!ICONS['square-check']) ICONS['square-check'] = '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>';
    if (!ICONS['check-check']) ICONS['check-check'] = '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>';
  }

  /**
   * attach(root, opts) -> controller
   *   opts.items(): the message elements, in order
   *   opts.keyOf(el): a stable key for a message
   *   opts.textOf(el): what a message contributes (plain text / markdown)
   *   opts.whoOf(el): 'You' or the agent's name, for a copy of several messages
   *   opts.state: { on, keys:Set, anchor } kept by the caller across repaints
   *   opts.actions: [{ id, label, icon, run(text, keys), primary, hidden() }]
   *   opts.onChange(state): after any change (to hide a composer, etc.)
   *   opts.barHost: where the bar goes (default: after root)
   *   opts.label: what the messages are, for screen readers ('message')
   */
  function attach(root, opts) {
    const state = opts.state || { on: false, keys: new Set(), anchor: null };
    if (!(state.keys instanceof Set)) state.keys = new Set(state.keys || []);
    const items = () => opts.items();
    const keyOf = (el) => String(opts.keyOf(el));
    let timer = null, start = null, pressed = null, swallowClick = false;
    // Text selected by hand inside the messages (what "Pick parts" also allowed): the
    // same bar offers its actions for just that text, without selection mode.
    let textSel = '';
    const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-slot': 'msel-live' });

    /* ---- the contextual bar ---- */
    const count = h('span', { class: 'msel-count', 'data-slot': 'msel-count' });
    const close = h('button', { type: 'button', class: 'aui-button-icon msel-close', 'aria-label': 'Cancel selection', 'data-tooltip': 'Cancel (Esc)', 'data-slot': 'msel-cancel', onclick: () => exit() }, icon('x'));
    const all = h('button', { type: 'button', class: 'btn btn-ghost btn-xs msel-all', 'data-slot': 'msel-all', onclick: () => toggleAll() }, icon('check-check'), h('span', { class: 'msel-label' }, 'Select all'));
    const actBtns = (opts.actions || []).map((a) => {
      const b = h('button', { type: 'button', class: `btn ${a.primary ? 'btn-default' : 'btn-ghost'} btn-xs msel-act`, 'data-slot': `msel-${a.id}`, 'data-tooltip': a.label, 'aria-label': a.label, onclick: async () => {
        const t = text();
        if (!t) return;
        b.disabled = true;
        try { const keep = await a.run(t, [...state.keys]); if (!keep) { if (state.on) exit(); else { textSel = ''; doc.getSelection?.()?.removeAllRanges(); } } } finally { b.disabled = false; sync(); }
      } }, icon(a.icon), h('span', { class: 'msel-label' }, a.short || a.label));
      b._act = a;
      return b;
    });
    const bar = h('div', { class: 'msel-bar', role: 'toolbar', 'aria-label': 'Selected messages', 'data-slot': 'msel-bar', hidden: true },
      close, count, h('span', { class: 'sa-spacer' }), all, ...actBtns);
    bar.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exit(); } });

    /* ---- decoration: checkbox per message, roving focus ---- */
    function decorate() {
      const list = items();
      let tabbed = false;
      list.forEach((el, i) => {
        const k = keyOf(el);
        el.dataset.selKey = k;
        el.classList.add('msel-item');
        const sel = state.on && state.keys.has(k);
        el.dataset.selected = sel ? 'true' : 'false';
        let cb = el.querySelector(':scope > .msel-check');
        if (state.on && !cb) {
          cb = h('input', { type: 'checkbox', class: 'checkbox msel-check', tabindex: '-1' });
          cb.addEventListener('click', (e) => { e.stopPropagation(); });
          cb.addEventListener('change', () => { setKey(k, cb.checked); state.anchor = k; sync(); });
          el.prepend(cb);
        } else if (!state.on && cb) cb.remove();
        if (cb) { cb.checked = sel; cb.setAttribute('aria-label', `Select ${opts.label || 'message'} ${i + 1} of ${list.length}${opts.whoOf ? `, from ${opts.whoOf(el)}` : ''}`); }
        if (!el.hasAttribute('tabindex') || el.getAttribute('tabindex') === '0' || el.getAttribute('tabindex') === '-1') {
          const want = !tabbed && (el === doc.activeElement || (state.anchor ? k === state.anchor : i === list.length - 1)) ? '0' : '-1';
          if (want === '0') tabbed = true;
          el.setAttribute('tabindex', want);
        }
        if (!el.getAttribute('aria-label') && opts.whoOf) el.setAttribute('aria-roledescription', 'message');
      });
      if (!tabbed && list.length) list[list.length - 1].setAttribute('tabindex', '0');
      root.dataset.selecting = state.on ? 'true' : 'false';
    }
    function setKey(k, on) { if (on) state.keys.add(k); else state.keys.delete(k); }
    function text() {
      if (!state.on && textSel) return textSel;
      const chosen = items().filter((el) => state.keys.has(keyOf(el)));
      const parts = chosen.map((el) => ({ who: opts.whoOf ? opts.whoOf(el) : '', t: String(opts.textOf(el) || '').trim() })).filter((p) => p.t);
      if (parts.length === 1) return parts[0].t;
      return parts.map((p) => (p.who ? `**${p.who}:**\n${p.t}` : p.t)).join('\n\n');
    }
    function sync() {
      // Keys of messages that are gone (an edit cut the chat back) drop out.
      const present = new Set(items().map(keyOf));
      for (const k of [...state.keys]) if (!present.has(k)) state.keys.delete(k);
      decorate();
      const n = state.keys.size;
      bar.hidden = !state.on && !textSel;
      bar.dataset.mode = state.on ? 'messages' : textSel ? 'text' : '';
      count.textContent = state.on ? `${n} selected` : 'Selected text';
      all.hidden = !state.on;
      const total = present.size;
      all.querySelector('.msel-label').textContent = n && n === total ? 'Clear' : 'Select all';
      all.setAttribute('aria-label', n && n === total ? 'Clear selection' : 'Select all messages');
      for (const b of actBtns) { b.disabled = state.on ? !n : !textSel; b.hidden = !!b._act.hidden?.(); }
      opts.onChange?.(state);
    }
    function announce(msg) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); }
    function enter(el) {
      const was = state.on;
      textSel = '';
      state.on = true;
      if (el) { const k = keyOf(el); setKey(k, true); state.anchor = k; }
      sync();
      if (!was) announce(`Selecting messages. ${state.keys.size} selected. Space toggles, Escape cancels.`);
    }
    function exit() {
      if (!state.on) return;
      state.on = false;
      state.keys.clear();
      state.anchor = null;
      sync();
      announce('Selection cancelled.');
      const f = items().find((x) => x.getAttribute('tabindex') === '0');
      if (bar.contains(doc.activeElement)) f?.focus({ preventScroll: true });
    }
    function toggle(el) {
      const k = keyOf(el);
      setKey(k, !state.keys.has(k));
      state.anchor = k;
      if (!state.keys.size) { exit(); return; }
      sync();
      announce(`${state.keys.size} selected`);
    }
    function range(el) {
      const list = items();
      const a = list.findIndex((x) => keyOf(x) === state.anchor);
      const b = list.indexOf(el);
      if (a < 0 || b < 0) { toggle(el); return; }
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i += 1) state.keys.add(keyOf(list[i]));
      sync();
      announce(`${state.keys.size} selected`);
    }
    function toggleAll() {
      const list = items();
      if (state.keys.size === list.length) { exit(); return; }
      state.on = true;
      list.forEach((el) => state.keys.add(keyOf(el)));
      sync();
      announce(`All ${list.length} selected`);
    }
    const itemOf = (t) => { const el = t?.closest?.('.msel-item'); return el && root.contains(el) ? el : null; };
    const interactive = (t) => !!t?.closest?.('a[href], button, input, textarea, select, summary, [contenteditable="true"]');

    /* ---- long-press (touch, pen and a held mouse button) ---- */
    const cancelPress = () => { clearTimeout(timer); timer = null; pressed?.classList.remove('msel-pressing'); pressed = null; };
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const el = itemOf(e.target);
      if (!el || (interactive(e.target) && !state.on)) return;
      start = { x: e.clientX, y: e.clientY };
      pressed = el;
      el.classList.add('msel-pressing');
      timer = setTimeout(() => {
        timer = null;
        el.classList.remove('msel-pressing');
        swallowClick = true;
        doc.getSelection?.()?.removeAllRanges();
        try { navigator.vibrate?.(12); } catch { /* not allowed */ }
        if (state.on) toggle(el); else enter(el);
        el.focus({ preventScroll: true });
      }, LONG_MS);
    });
    root.addEventListener('pointermove', (e) => { if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_PX) cancelPress(); });
    root.addEventListener('pointerup', () => { cancelPress(); if (swallowClick) setTimeout(() => { swallowClick = false; }, 400); });
    root.addEventListener('pointercancel', cancelPress);
    root.addEventListener('pointerleave', cancelPress);
    // A long-press on a phone also opens the system menu: not while selecting.
    root.addEventListener('contextmenu', (e) => { if (swallowClick || (state.on && itemOf(e.target))) e.preventDefault(); });
    root.addEventListener('click', (e) => {
      const el = itemOf(e.target);
      if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; }
      if (!el) return;
      if (e.target.classList?.contains('msel-check')) return;
      if (state.on) {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) range(el); else toggle(el);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !interactive(e.target)) { e.preventDefault(); enter(el); }
    }, true);

    /* ---- keyboard ---- */
    root.addEventListener('keydown', (e) => {
      const el = itemOf(e.target);
      if (!el || e.target !== el) {
        if (e.key === 'Escape' && state.on) { e.preventDefault(); e.stopPropagation(); exit(); }
        return;
      }
      const list = items();
      const i = list.indexOf(el);
      const move = (j) => { const t = list[Math.max(0, Math.min(list.length - 1, j))]; if (!t) return null; list.forEach((x) => x.setAttribute('tabindex', x === t ? '0' : '-1')); t.focus(); t.scrollIntoView?.({ block: 'nearest' }); return t; };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const t = move(i + (e.key === 'ArrowDown' ? 1 : -1));
        if (e.shiftKey && t) { if (!state.on) enter(el); state.keys.add(keyOf(t)); sync(); announce(`${state.keys.size} selected`); }
      } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); move(e.key === 'Home' ? 0 : list.length - 1); }
      else if (e.key === ' ' || (e.key === 'Enter' && state.on)) { e.preventDefault(); if (state.on) toggle(el); else enter(el); }
      else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && state.on) { e.preventDefault(); toggleAll(); }
      else if (e.key === 'Escape' && state.on) { e.preventDefault(); e.stopPropagation(); exit(); }
    });

    // Esc anywhere leaves selection first (before a panel or a chat closes on it),
    // unless a dialog or a menu is open on top.
    doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !state.on || !root.isConnected || e.defaultPrevented) return;
      if (e.target?.closest?.('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault(); e.stopPropagation(); exit();
    }, true);
    const onSel = () => {
      if (!root.isConnected) { doc.removeEventListener('selectionchange', onSel); return; }
      if (state.on) return;
      const sl = doc.getSelection?.();
      const inside = sl && !sl.isCollapsed && sl.rangeCount && root.contains(sl.getRangeAt(0).commonAncestorContainer) && !sl.anchorNode?.parentElement?.closest?.('textarea, input');
      const t = inside && items().length ? String(sl).trim() : '';
      // A tap on the bar's own buttons collapses nothing; keep the text until it is used.
      if (!t && bar.contains(doc.activeElement)) return;
      if (t === textSel) return;
      textSel = t;
      sync();
    };
    doc.addEventListener('selectionchange', onSel);
    (opts.barHost || root.parentNode)?.append?.(bar);
    root.after?.(live);
    sync();
    // The container may be put in the page after attach: decorate again then.
    requestAnimationFrame(() => sync());
    return { state, bar, enter: (el) => enter(el || items()[items().length - 1]), exit, toggleAll, sync, text, get on() { return state.on; } };
  }
  return { attach };
})();
