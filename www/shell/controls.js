/* ==========================================================================
   My App — the shared dropdown (injected at build time into every page).

   Every native <select> in every app is upgraded into ONE designed dropdown,
   so no page ever shows the platform's own picker, and all of them look and
   behave the same (styles: shell/controls.css):

   - a combobox trigger and a listbox popup (WAI-ARIA "select-only combobox");
   - desktop and tablets: a popover that opens below the trigger, or above it
     when there is more room there, clamped 8 px inside the viewport;
   - phones (< 640 px wide, or a coarse pointer under 768 px): a bottom sheet
     with a title, a grabber and a 44 px close button, over a scrim;
   - lists over 8 options get a search box; options may carry data-desc (a
     second line), data-badge (a tag on the right) and data-short (a shorter
     label for the trigger); <optgroup> becomes a labelled group;
   - keyboard: Up/Down, Home/End, PageUp/PageDown, Enter/Space, Esc, Tab and
     type-ahead; focus returns to the trigger on close.

   The <select> stays in the DOM, hidden, as the source of truth: existing code
   keeps reading and writing select.value / selectedIndex (both are hooked so
   the trigger follows) and listening for 'input' and 'change'. Selects added
   later are upgraded too. Opt out with data-native="true" (or data-plain) on a
   select, or with <html data-mc-dropdown="own"> for a page that ships its own
   implementation of this same component (agent.html).
   ========================================================================== */
(() => {
  'use strict';
  if (window.MyAppControls) return;
  const doc = document;
  const SEARCH_AT = 8;
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const indexDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  const SVG = (d, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
  const ICON = {
    chevron: SVG('<path d="m6 9 6 6 6-6"/>', 'mc-chevron'),
    check: SVG('<path d="M20 6 9 17l-5-5"/>'),
    search: SVG('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  };
  let seq = 0;
  const uid = (p) => `${p}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const el = (tag, attrs, html) => {
    const n = doc.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
    if (html != null) n.innerHTML = html;
    return n;
  };
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const useSheet = () => {
    const w = doc.documentElement.clientWidth;
    return w < 640 || (w < 768 && window.matchMedia('(pointer: coarse)').matches);
  };
  const labelFor = (sel) => (sel.id && doc.querySelector(`label[for="${CSS.escape(sel.id)}"]`)) || sel.closest('label');
  const labelText = (sel) => {
    const l = sel.__mc?.label || labelFor(sel);
    if (!l) return '';
    const f = l.querySelector('.field-label') || l;
    // The label may wrap the select itself: read only its own text.
    const clone = f.cloneNode(true);
    for (const n of clone.querySelectorAll('select, button, .mc-trigger')) n.remove();
    return clone.textContent.trim();
  };
  const nameOf = (sel) => sel.getAttribute('aria-label') || labelText(sel) || sel.dataset.label || sel.title || 'Choose an option';
  const optText = (opt) => (opt.label || opt.textContent || '').trim();
  const fire = (sel) => {
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  function refresh(sel) {
    const st = sel.__mc;
    if (!st) return;
    const opt = sel.options[indexDesc.get.call(sel)];
    const text = opt ? (opt.dataset.short || optText(opt)) : (sel.dataset.placeholder || 'Choose\u2026');
    st.value.textContent = text;
    st.value.dataset.placeholder = String(!opt);
    st.trigger.disabled = sel.disabled;
    st.trigger.setAttribute('aria-invalid', sel.getAttribute('aria-invalid') || 'false');
    if (sel.required) st.trigger.setAttribute('aria-required', 'true'); else st.trigger.removeAttribute('aria-required');
    const desc = sel.getAttribute('aria-describedby');
    if (desc) st.trigger.setAttribute('aria-describedby', desc); else st.trigger.removeAttribute('aria-describedby');
    const name = sel.getAttribute('aria-label');
    if (name) st.trigger.setAttribute('aria-label', `${name}: ${text}`);
    if (sel.title) st.trigger.title = sel.title;
    if (st.list && st.list.isConnected) markSelected(st);
  }

  function markSelected(st) {
    const cur = indexDesc.get.call(st.sel);
    for (const item of st.items) {
      const on = item.__index === cur;
      item.setAttribute('aria-selected', String(on));
      item.querySelector('.mc-check').innerHTML = on ? ICON.check : '';
    }
  }

  function choose(sel, index) {
    const before = indexDesc.get.call(sel);
    indexDesc.set.call(sel, index);
    refresh(sel);
    if (before !== index) fire(sel);
  }

  /* ---- the open popup (only one at a time) ---- */
  let current = null; // { sel, st, pop, scrim, sheet, cleanup }

  function close(refocus) {
    if (!current) return;
    const c = current;
    current = null;
    c.cleanup();
    c.st.trigger.setAttribute('aria-expanded', 'false');
    c.st.trigger.removeAttribute('aria-controls');
    c.st.list = null;
    const done = () => { c.pop.remove(); c.scrim?.remove(); };
    if (c.sheet && !reduced()) {
      c.pop.style.transition = 'transform 180ms cubic-bezier(0.2,0,0,1)';
      c.pop.style.transform = 'translateY(100%)';
      if (c.scrim) { c.scrim.style.transition = 'opacity 180ms'; c.scrim.style.opacity = '0'; }
      setTimeout(done, 190);
    } else done();
    doc.documentElement.classList.remove('mc-locked');
    if (refocus) c.st.trigger.focus({ preventScroll: true });
  }

  function place(c) {
    if (c.sheet) return;
    const { pop, st } = c;
    const r = st.trigger.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const m = 8, gap = 4;
    pop.style.minWidth = `${Math.min(Math.max(r.width, 160), vw - 2 * m)}px`;
    pop.style.maxHeight = '';
    const below = vh - r.bottom - gap - m;
    const above = r.top - gap - m;
    const natural = pop.scrollHeight + 2;
    const up = natural > below && above > below;
    const room = Math.max(120, up ? above : below);
    pop.style.maxHeight = `${Math.min(room, 352)}px`;
    const h = Math.min(pop.offsetHeight, room);
    const w = pop.offsetWidth;
    const rtl = getComputedStyle(st.trigger).direction === 'rtl';
    let left = rtl ? r.right - w : r.left;
    left = Math.max(m, Math.min(left, vw - w - m));
    pop.style.left = `${left}px`;
    pop.style.top = `${up ? Math.max(m, r.top - gap - h) : r.bottom + gap}px`;
    pop.dataset.side = up ? 'top' : 'bottom';
    pop.style.setProperty('--mc-origin', `${rtl ? 'right' : 'left'} ${up ? 'bottom' : 'top'}`);
  }

  function open(sel) {
    const st = sel.__mc;
    if (!st || sel.disabled) return;
    if (current && current.sel === sel) { close(true); return; }
    close(false);
    const sheet = useSheet();
    const listId = uid('mc-list');
    const name = nameOf(sel);
    const pop = el('div', { class: `mc-pop${sheet ? ' mc-sheet' : ''}`, role: sheet ? 'dialog' : 'presentation', 'aria-modal': sheet ? 'true' : null, 'aria-label': sheet ? name : null });
    // Keep the page's theme inside the popup: it is mounted on <body>, so a
    // .dark set on an inner container would not reach it otherwise.
    if (st.trigger.closest('.dark') && !doc.documentElement.classList.contains('dark')) pop.classList.add('dark');
    const list = el('div', { class: 'mc-list', role: 'listbox', id: listId, tabindex: '-1', 'aria-label': name });
    const items = [];
    st.items = items;
    st.list = list;
    const addOption = (opt, index) => {
      const item = el('div', {
        class: 'mc-option', role: 'option', id: `${listId}-${index}`, tabindex: '-1',
        'aria-selected': 'false', 'aria-disabled': opt.disabled ? 'true' : null, 'data-value': opt.value,
      });
      const text = el('span', { class: 'mc-option-text' });
      const label = el('span', { class: 'mc-option-label' });
      label.textContent = optText(opt);
      text.append(label);
      if (opt.dataset.desc) { const d = el('span', { class: 'mc-option-desc' }); d.textContent = opt.dataset.desc; text.append(d); }
      item.append(text);
      if (opt.dataset.badge) { const b = el('span', { class: 'mc-badge' }); b.textContent = opt.dataset.badge; item.append(b); }
      item.append(el('span', { class: 'mc-check', 'aria-hidden': 'true' }));
      item.__index = index;
      item.__text = `${optText(opt)} ${opt.value} ${opt.dataset.desc || ''}`.toLowerCase();
      item.addEventListener('click', () => {
        if (opt.disabled) return;
        choose(sel, index);
        close(true);
      });
      item.addEventListener('pointermove', () => {
        if (item.hidden) return;
        if (search && doc.activeElement === search) { if (active !== item) { active?.removeAttribute('data-active'); active = item; item.setAttribute('data-active', ''); search.setAttribute('aria-activedescendant', item.id); } }
        else if (doc.activeElement !== item) focusItem(item, false);
      });
      items.push(item);
      return item;
    };
    let index = 0;
    for (const child of sel.children) {
      if (child.tagName === 'OPTGROUP') {
        const gid = `${listId}-g${index}`;
        const group = el('div', { role: 'group', class: 'mc-group', 'aria-labelledby': gid });
        const gl = el('div', { class: 'mc-group-label', id: gid });
        gl.textContent = child.label;
        group.append(gl);
        for (const opt of child.children) if (opt.tagName === 'OPTION') group.append(addOption(opt, index++));
        list.append(group);
      } else if (child.tagName === 'OPTION') {
        if (child.hidden) { index++; continue; }
        list.append(addOption(child, index++));
      }
    }
    markSelected(st);
    const empty = el('p', { class: 'mc-empty', hidden: true });
    empty.textContent = 'No matches';
    const visible = () => items.filter((i) => !i.hidden && i.getAttribute('aria-disabled') !== 'true');
    let search = null;
    let active = null;
    function setActive(item) {
      if (active) active.removeAttribute('data-active');
      active = item || null;
      if (!active) { search?.removeAttribute('aria-activedescendant'); return; }
      active.setAttribute('data-active', '');
      active.scrollIntoView({ block: 'nearest' });
      search?.setAttribute('aria-activedescendant', active.id);
    }
    function focusItem(item, scroll = true) {
      if (!item) return;
      item.focus({ preventScroll: true });
      if (scroll) item.scrollIntoView({ block: 'nearest' });
      (search || list).setAttribute('aria-activedescendant', item.id);
    }
    if (items.length > SEARCH_AT || sel.dataset.search === 'true') {
      search = el('input', {
        class: 'mc-search-input', type: 'search', placeholder: sel.dataset.searchPlaceholder || 'Search\u2026', autocomplete: 'off', spellcheck: 'false',
        role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-label': `Search ${name}`,
      });
      // Focus stays in the search box; the highlighted option is tracked with
      // aria-activedescendant (the WAI-ARIA combobox pattern), starting on the
      // current value, so typing and the arrow keys work together.
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        for (const item of items) { item.hidden = !!q && !item.__text.includes(q); if (!item.hidden) shown++; }
        for (const g of list.querySelectorAll('.mc-group')) g.hidden = ![...g.querySelectorAll('.mc-option')].some((o) => !o.hidden);
        empty.hidden = shown > 0;
        const vis = visible();
        setActive(q ? vis[0] : (vis.find((i) => i.getAttribute('aria-selected') === 'true') || vis[0]));
      });
      search.addEventListener('keydown', (e) => {
        const vis = visible();
        const at = vis.indexOf(active);
        let next = null;
        if (e.key === 'ArrowDown') next = vis[Math.min(vis.length - 1, at + 1)];
        else if (e.key === 'ArrowUp') next = vis[Math.max(0, at - 1)];
        else if (e.key === 'PageDown') next = vis[Math.min(vis.length - 1, at + 8)];
        else if (e.key === 'PageUp') next = vis[Math.max(0, at - 8)];
        else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey) next = e.key === 'Home' ? vis[0] : vis[vis.length - 1];
        else if (e.key === 'Enter') { e.preventDefault(); (active && !active.hidden ? active : vis[0])?.click(); return; }
        else if (e.key === 'Tab') { close(false); return; }
        if (next) { e.preventDefault(); setActive(next); }
      });
    }
    let typed = '';
    let typedAt = 0;
    list.addEventListener('keydown', (e) => {
      const vis = visible();
      const at = vis.indexOf(doc.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = vis[Math.min(vis.length - 1, at + 1)];
      else if (e.key === 'ArrowUp') { if (at <= 0 && search) { e.preventDefault(); search.focus(); return; } next = vis[Math.max(0, at - 1)]; }
      else if (e.key === 'Home') next = vis[0];
      else if (e.key === 'End') next = vis[vis.length - 1];
      else if (e.key === 'PageDown') next = vis[Math.min(vis.length - 1, at + 8)];
      else if (e.key === 'PageUp') next = vis[Math.max(0, at - 8)];
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doc.activeElement?.click?.(); return; }
      else if (e.key === 'Tab') { close(false); return; }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (search) { search.focus(); return; }
        const now = Date.now();
        typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
        typedAt = now;
        const from = typed.length === 1 ? vis.slice(at + 1).concat(vis.slice(0, at + 1)) : vis;
        next = from.find((i) => i.textContent.trim().toLowerCase().startsWith(typed));
      }
      if (next) { e.preventDefault(); focusItem(next); }
    });

    let scrim = null;
    if (sheet) {
      scrim = el('div', { class: 'mc-scrim', 'aria-hidden': 'true' });
      const head = el('div', { class: 'mc-sheet-head' });
      head.append(el('span', { class: 'mc-grabber', 'aria-hidden': 'true' }));
      const title = el('p', { class: 'mc-sheet-title' });
      title.textContent = name;
      head.append(title);
      const x = el('button', { type: 'button', class: 'mc-sheet-close', 'aria-label': 'Close' }, ICON.x);
      x.addEventListener('click', () => close(true));
      head.append(x);
      pop.append(head);
    }
    if (search) { const s = el('div', { class: 'mc-search' }, ICON.search); s.append(search); pop.append(s); }
    pop.append(list, empty);
    if (scrim) doc.body.append(scrim);
    doc.body.append(pop);
    st.trigger.setAttribute('aria-expanded', 'true');
    st.trigger.setAttribute('aria-controls', listId);
    if (sheet) doc.documentElement.classList.add('mc-locked');

    const c = { sel, st, pop, scrim, sheet, cleanup: () => {} };
    current = c;
    place(c);
    const onDown = (e) => { if (!pop.contains(e.target) && !st.trigger.contains(e.target)) close(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (sheet && e.key === 'Tab') {
        // A modal sheet keeps focus inside.
        const f = [...pop.querySelectorAll('button, input, [role="option"]:not([hidden]):not([aria-disabled="true"])')];
        if (!f.length) return;
        if (!pop.contains(doc.activeElement)) { e.preventDefault(); f[0].focus(); }
      }
    };
    const onScroll = (e) => { if (!pop.contains(e.target)) place(c); };
    let lastW = doc.documentElement.clientWidth;
    const onResize = () => {
      const w = doc.documentElement.clientWidth;
      if (w !== lastW && useSheet() !== sheet) close(false); else place(c);
      lastW = w;
    };
    // The shell's hardware back button closes the popup first.
    const onBack = (e) => { e.preventDefault?.(); close(true); };
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.addEventListener('myapp:back', onBack);
    c.cleanup = () => {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.removeEventListener('myapp:back', onBack);
    };
    requestAnimationFrame(() => {
      if (current !== c) return;
      const sel0 = items.find((i) => i.getAttribute('aria-selected') === 'true');
      sel0?.scrollIntoView({ block: 'center' });
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      if (search && !coarse) { search.focus({ preventScroll: true }); setActive(sel0 || visible()[0]); }
      else focusItem(sel0 || visible()[0], false);
    });
  }

  function enhance(sel) {
    if (!sel || sel.__mc || sel.__dd || sel.multiple || Number(sel.size) > 1) return;
    if (sel.dataset.native === 'true' || sel.hasAttribute('data-plain') || sel.classList.contains('dd-native')) return;
    if (doc.documentElement.dataset.mcDropdown === 'own') return;
    const cs = getComputedStyle(sel);
    const parent = sel.parentElement;
    const parentW = parent ? parent.clientWidth - parseFloat(getComputedStyle(parent).paddingLeft || 0) - parseFloat(getComputedStyle(parent).paddingRight || 0) : 0;
    const block = cs.display === 'block' || cs.display === 'flex' || cs.display === 'grid' || (sel.offsetWidth > 0 && parentW > 0 && sel.offsetWidth >= parentW - 1) || /(^|\s)(w-full|block)(\s|$)/.test(sel.className);
    const small = sel.classList.contains('select-sm') || sel.classList.contains('sm') || (sel.offsetHeight > 0 && sel.offsetHeight <= 32);
    const value = el('span', { class: 'mc-value' });
    const trigger = el('button', {
      type: 'button', class: `mc-trigger${block ? ' mc-block' : ''}${small ? ' mc-sm' : ''}`, role: 'combobox',
      'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    });
    trigger.append(value);
    trigger.insertAdjacentHTML('beforeend', ICON.chevron);
    if (sel.style.cssText) trigger.style.cssText = sel.style.cssText;
    if (!block && sel.offsetWidth > 0) trigger.style.minWidth = `${Math.min(sel.offsetWidth, 320)}px`;
    if (cs.flexGrow && cs.flexGrow !== '0') trigger.style.flexGrow = cs.flexGrow;
    for (const cls of sel.classList) if (!['select', 'select-sm', 'sm', 'input'].includes(cls)) trigger.classList.add(cls);
    if (sel.dataset.setting) trigger.dataset.mcFor = sel.dataset.setting;
    const label = labelFor(sel);
    if (label && !sel.getAttribute('aria-label')) {
      const lid = label.id || (label.id = uid('mc-l'));
      trigger.setAttribute('aria-labelledby', `${lid} ${trigger.id || (trigger.id = uid('mc-t'))}`);
      if (sel.id && label.htmlFor === sel.id) label.htmlFor = trigger.id;
    }
    sel.__mc = { sel, trigger, value, label, items: [], list: null };
    sel.classList.add('mc-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel.after(trigger);
    // Programmatic writes (select.value = x, selectedIndex = n) update the trigger too.
    Object.defineProperty(sel, 'value', { configurable: true, get() { return valueDesc.get.call(this); }, set(v) { valueDesc.set.call(this, v); refresh(this); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return indexDesc.get.call(this); }, set(v) { indexDesc.set.call(this, v); refresh(this); } });
    new MutationObserver(() => refresh(sel)).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ['disabled', 'selected', 'label', 'required', 'aria-invalid', 'aria-describedby', 'aria-label', 'title'] });
    sel.addEventListener('change', () => refresh(sel));
    sel.addEventListener('focus', () => trigger.focus());
    // A wrapping <label> would also "click" the hidden select; keep one action.
    trigger.addEventListener('click', (e) => { e.preventDefault(); open(sel); });
    trigger.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); open(sel); }
    });
    sel.form?.addEventListener('reset', () => setTimeout(() => refresh(sel)));
    refresh(sel);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'SELECT') enhance(root);
    else if (root.querySelector) for (const sel of root.querySelectorAll('select')) enhance(sel);
  }
  function start() {
    if (doc.documentElement.dataset.mcDropdown === 'own') return;
    scan(doc.body);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) scan(n);
    }).observe(doc.body, { childList: true, subtree: true });
  }

  window.MyAppControls = Object.freeze({ Dropdown: Object.freeze({ enhance, refresh, open, close: () => close(true), choose, scan }) });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
