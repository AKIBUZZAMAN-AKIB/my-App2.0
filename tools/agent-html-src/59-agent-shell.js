/* ==========================================================================
   Agent shell: the "Sections" sheet. One button in the chat's top bar opens a
   full-screen sheet that lists everything the agent screen can do, grouped,
   with a line on what each one is for. Tapping a row opens the real screen
   (Agents, Files, Vault, Memory, Settings…) or one of the shell's own panels
   (Parity, Swarm, Social, Context).

   Why a sheet and not a bar: this screen runs inside the app's own page frame
   (bottom bar Home / Academic / Agent / Calendar / More). The old version put
   a second tab bar plus a placeholder note ("Pick a screen from the bar…")
   *above* the chat, in the normal flow, so on a phone it pushed the chat down,
   stacked a header on a header, and left a big empty gap. The sheet is
   position: fixed, takes no space while closed, and never overlaps the chat.

   Rules kept from the earlier design (docs/subagents/SUBAGENT_UI_REDESIGN.md):
   every row is a real <button>, focus is visible, Escape closes, and a panel
   with no engine answer says so instead of inventing numbers.
   ========================================================================== */
const AgentShell = (() => {
  const tips = {
    sticky: 'The bar stays at the top of the screen while you scroll; tap “up” to jump back.',
    dropdown: 'Everything that does not fit in the top row lives here, grouped.',
    parity: 'A sub-agent may do what the main agent may do, minus the things that need the chat itself.',
    swarm: 'Agents message each other directly; every message is a record, not a broadcast.',
    social: 'What the agents published, newest first. Nothing leaves the app unless you share it.',
  };

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, String(v));
    }
    if (text != null) n.textContent = String(text);
    return n;
  };

  /* ---- what the shell shows -------------------------------------------------
     `destinations` is the one list both the top row and the dropdown read, so a
     new screen is added in exactly one place. `row: true` means it may sit in the
     top row on a wide screen; the dropdown always shows it. */
  const DESTINATIONS = [
    { id: 'chat', label: 'Chat', group: 'Agent', row: true, hint: 'Talk to the main agent' },
    { id: 'agents', label: 'Agents', group: 'Agent', row: true, hint: 'Sub-agents: who is running, their tree and goals', open: (a) => window.__subagents?.open?.(a) },
    { id: 'memory', label: 'Chat memory', group: 'Agent', hint: 'What this chat remembers and its turns', open: () => window.__chatMemory?.open?.(), when: () => window.__chatMemory?.available?.() !== false },
    { id: 'parity', label: 'Parity', group: 'Agent', row: false, hint: 'What a sub-agent may do next to the main agent' },
    { id: 'swarm', label: 'Swarm', group: 'Agent', row: true, hint: 'Agent-to-agent messages' },
    { id: 'files', label: 'Files', group: 'Workspace', hint: 'Browse, open and download workspace files', open: (a) => window.__files?.open?.(a) },
    { id: 'folders', label: 'Folders', group: 'Workspace', hint: 'Phone folders the agent may use', open: (a) => window.__folders?.open?.(a), when: () => window.__folders?.supported?.() !== false },
    { id: 'vault', label: 'Vault', group: 'Workspace', hint: 'Saved keys and secrets', open: (a) => window.__vault?.open?.(a) },
    { id: 'social', label: 'Social', group: 'Workspace', row: false, hint: 'What the agents published' },
    { id: 'context', label: 'Context', group: 'Engine', row: false, hint: 'What is in the model\u2019s window right now' },
    { id: 'settings', label: 'Settings', group: 'Engine', row: false, hint: 'Providers, models, MCP, automations', open: (a) => a?.openSettings?.('providers') },
    { id: 'automations', label: 'Automations', group: 'Engine', hint: 'Scheduled and triggered agent runs', open: (a) => a?.openSettings?.('automations') },
  ];
  const visible = () => DESTINATIONS.filter((d) => {
    if (d.id === 'chat') return false;
    try { return !d.when || d.when(); } catch (e) { return true; }
  });
  const appRef = () => (typeof window !== 'undefined' && window.__app) || null;

  let state = {
    active: 'chat',
    scrolled: 0,
    parity: null, // { main: [...], sub: [...], same: [...] } as the engine reports it
    swarm: [], // { from, to, kind, text, at, delivered }
    social: [], // { author, title, body, at, liked }
  };
  const subs = new Set();
  const root = { bar: null, dropdown: null, panelHost: null, up: null, sheet: null, title: null, back: null, trigger: null };

  const emit = () => subs.forEach((fn) => { try { fn(state); } catch (e) { console.warn('agent shell', e); } });

  /**
   * Pick a destination. 'chat' closes the sheet; a destination with a screen of
   * its own closes the sheet and opens that screen; a shell panel shows in the
   * sheet. 'more' (or 'menu') shows the list of sections.
   */
  function go(id) {
    if (id === 'more' || id === 'menu') { state.active = 'more'; openSheet(); paint(); emit(); return true; }
    const d = DESTINATIONS.find((x) => x.id === id);
    if (!d) return false;
    if (typeof window !== 'undefined' && window.__personalize) { try { window.__personalize.visited(id); } catch (e) { console.warn('personalize', e); } }
    closeDropdown();
    if (id === 'chat') { state.active = 'chat'; closeSheet(); paint(); emit(); return true; }
    if (d.open) {
      closeSheet();
      state.active = 'chat';
      let opened = null;
      try { opened = d.open(appRef()); } catch (e) { console.warn('agent shell open', e); }
      if (opened == null && !appRef()) say(`${d.label} is not available in this build.`);
      paint();
      emit();
      return true;
    }
    state.active = id;
    openSheet();
    paint();
    emit();
    return true;
  }
  function say(text) {
    try { if (typeof toast === 'function') toast(text, { type: 'default' }); } catch (e) { /* no toast host */ }
  }

  function openSheet() {
    if (!root.sheet) return;
    if (root.sheet.hidden) root.lastFocus = document.activeElement;
    root.sheet.hidden = false;
    document.documentElement.classList.add('as-sheet-open');
    if (root.trigger) root.trigger.setAttribute('aria-expanded', 'true');
    setTimeout(() => { try { (root.back || root.sheet).focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 0);
  }
  function closeSheet() {
    if (!root.sheet || root.sheet.hidden) return;
    root.sheet.hidden = true;
    document.documentElement.classList.remove('as-sheet-open');
    if (root.trigger) root.trigger.setAttribute('aria-expanded', 'false');
    const f = root.lastFocus; root.lastFocus = null;
    if (f && f.isConnected) { try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }

  /* ---- the sheet ------------------------------------------------------------ */
  function ordered() {
    const P = (typeof window !== 'undefined' && window.__personalize) || null;
    let list = visible();
    if (P) {
      try {
        const ids = P.order(list.map((d) => d.id));
        list = ids.map((id) => list.find((d) => d.id === id)).filter(Boolean);
      } catch (e) { console.warn('personalize', e); }
    }
    return list;
  }

  /** The list of sections, grouped, one real button per row. */
  function menuHtml() {
    const groups = new Map();
    for (const d of visible()) {
      if (!groups.has(d.group)) groups.set(d.group, []);
      groups.get(d.group).push(d);
    }
    let html = '';
    for (const [g, items] of groups) {
      html += `<section class="as-group"><h3 class="as-group-title">${esc(g)}</h3><div class="as-grid">`;
      html += items.map((d) => `<button type="button" class="as-item" data-go="${esc(d.id)}">
          <span class="as-item-label">${esc(d.label)}</span><span class="as-item-hint">${esc(d.hint)}</span>
          <span class="as-item-go" aria-hidden="true">${d.open ? '\u2197' : '\u203A'}</span></button>`).join('');
      html += '</div></section>';
    }
    return html;
  }

  /** Kept for callers of the old API: the "tabs" are the sheet's chips. */
  function bar() {
    const nav = el('nav', { class: 'as-bar', 'aria-label': 'App sections', 'data-slot': 'app-bar' });
    const row = el('div', { class: 'as-row', role: 'tablist' });
    for (const d of ordered().filter((x) => x.row && !x.open)) {
      row.appendChild(el('button', {
        class: 'as-tab' + (d.id === state.active ? ' is-on' : ''), type: 'button', role: 'tab',
        'aria-selected': String(d.id === state.active), title: d.hint, 'data-go': d.id,
      }, d.label));
    }
    nav.appendChild(row);
    return nav;
  }

  function dropdown() { return el('div', { class: 'as-more', hidden: '' }); }
  function closeDropdown() { /* the sheet replaced the dropdown */ }
  function upButton() { const b = el('button', { class: 'as-up', type: 'button', hidden: '' }); root.up = b; return b; }
  function scrollParent() { return root.panelHost || null; }

  /** The button in the chat's top bar that opens the sheet. */
  function addTrigger() {
    if (root.trigger?.isConnected) return true;
    const topbar = document.querySelector('.topbar');
    if (!topbar) return false;
    const btn = el('button', {
      class: 'btn btn-ghost btn-icon as-trigger', type: 'button', 'aria-label': 'Sections',
      'data-tooltip': 'All sections', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-slot': 'sections',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
      onclick: () => go('more'),
    });
    // Before the settings button when there is one, so the order reads naturally.
    const settingsBtn = topbar.querySelector('[aria-label="Settings"]');
    if (settingsBtn && settingsBtn.parentElement) settingsBtn.parentElement.insertBefore(btn, settingsBtn);
    else topbar.appendChild(btn);
    root.trigger = btn;
    return true;
  }

  /* ---- the three new panels ------------------------------------------------ */
  const PANEL = {
    chat: () => menuHtml(),
    more: () => menuHtml(),

    parity: () => {
      const p = state.parity;
      if (!p) {
        // No engine answer yet: show the contract, marked as such, not as data.
        return `<p class="as-note">${esc(tips.parity)} <strong>The engine has not answered yet</strong>, so this is the
          rule the engine enforces, not a reading of a live agent.</p>
          <ul class="as-list">
            <li><strong>Same:</strong> every file, shell, web, doc and memory tool the parent was given.</li>
            <li><strong>Same:</strong> the ability to spawn its own children (deeper, never sideways-forever).</li>
            <li><strong>Same:</strong> the right to answer the user directly (<code>render_in_chat</code>).</li>
            <li><strong>Different:</strong> <code>ui__</code> tools stay with the main agent, so a child cannot redraw the app.</li>
            <li><strong>Different:</strong> it starts with the task, not the transcript; it must ask (<em>message</em>) for what it lacks.</li>
          </ul>`;
      }
      const rows = (p.main || []).map((m) => {
        const same = (p.sub || []).includes(m);
        return `<tr><td>${esc(m)}</td><td class="${same ? 'as-yes' : 'as-no'}">${same ? '✓ yes' : '— no'}</td></tr>`;
      }).join('');
      return `<table class="as-table"><thead><tr><th>Capability</th><th>Sub-agent</th></tr></thead><tbody>${rows}</tbody></table>`;
    },

    swarm: () => {
      const msgs = state.swarm;
      const head = `<p class="as-note">${esc(tips.swarm)}</p>`;
      if (!msgs.length) return `${head}<p class="as-empty">No messages yet. Agents talk when one needs something only the other has.</p>`;
      return `${head}<ol class="as-msgs">${msgs.map((m) => `<li class="as-msg ${m.delivered === false ? 'is-pending' : ''}">
          <span class="as-from">${esc(m.from)}</span><span class="as-arrow">→</span><span class="as-to">${esc(m.to)}</span>
          <span class="as-kind">${esc(m.kind || 'message')}</span>
          <div class="as-text">${esc(m.text)}</div>
        </li>`).join('')}</ol>`;
    },

    social: () => {
      const posts = state.social;
      if (!posts.length) return `<p class="as-note">${esc(tips.social)}</p><p class="as-empty">Nothing published yet.</p>`;
      return `<p class="as-note">${esc(tips.social)}</p><div class="as-feed">${posts.map((p) => `<article class="as-post">
          <header><strong>${esc(p.title || 'untitled')}</strong><span class="as-author">by ${esc(p.author || 'an agent')}</span></header>
          <p>${esc(p.body)}</p>
          <footer><span>${p.liked ? '♥ ' + p.liked : '♡ 0'}</span><span class="as-when">${esc(p.at || '')}</span></footer>
        </article>`).join('')}</div>`;
    },

    context: () => {
      const ct = window.__contextTree;
      if (ct && ct.available && ct.available()) {
        setTimeout(() => { try { ct.mount(); } catch (e) { console.warn('context', e); } }, 0);
        return '<p class="as-note">What the model is sent this turn, part by part.</p><div data-panel-host="context"></div>';
      }
      return `<p class="as-note">The context view shows what is in the model\u2019s window. It turns on in
        <button type="button" class="as-link" data-go="settings">Settings</button> once a chat has run with the native engine.</p>`;
    },
  };

  // A destination that matches a screen this build really has is hosted here;
  // otherwise the built-in panel explains itself. Never a blank area.
  const HOSTABLE = { notes: 'notes', genui: 'genui' };

  function panelBody() {
    const hostable = HOSTABLE[state.active];
    if (hostable && typeof window !== 'undefined' && window.__screens && window.__screens.has(hostable)) {
      const holder = document.createElement('div');
      holder.className = 'as-hosted';
      // Mount after the HTML is in place, so a screen can measure its container.
      setTimeout(() => { try { window.__screens.show(hostable, holder); } catch (e) { console.warn('host', e); } }, 0);
      window.__hostedScreens = (window.__hostedScreens || {});
      window.__hostedScreens[state.active] = holder;
      return '';
    }
    const fn = PANEL[state.active] || PANEL.chat;
    try { return fn(); } catch (e) { console.warn('agent shell panel', e); return '<p class="as-empty">That screen could not be drawn.</p>'; }
  }

  /* ---- mount / paint ------------------------------------------------------- */
  function mount() {
    if (root.sheet) { addTrigger(); return root.sheet; }
    const sheet = el('div', {
      class: 'as-shell as-sheet', 'data-app-shell': '', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': 'as-sheet-title', tabindex: '-1', hidden: '',
    });
    const head = el('header', { class: 'as-head' });
    const back = el('button', { class: 'as-back', type: 'button', 'aria-label': 'Back' }, '\u2039');
    back.addEventListener('click', () => { if (state.active === 'more' || state.active === 'chat') go('chat'); else go('more'); });
    const title = el('h2', { class: 'as-title', id: 'as-sheet-title' }, 'Sections');
    const close = el('button', { class: 'as-close', type: 'button', 'aria-label': 'Close' }, '\u00D7');
    close.addEventListener('click', () => go('chat'));
    head.append(back, title, close);
    const b = bar();
    const body = el('div', { class: 'as-body', 'data-slot': 'shell-body' });
    sheet.append(head, b, body);
    sheet.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-go]');
      if (t && sheet.contains(t)) { e.preventDefault(); go(t.getAttribute('data-go')); }
    });
    document.body.appendChild(sheet);
    root.sheet = sheet; root.bar = b; root.panelHost = body; root.title = title; root.back = back;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.sheet && !root.sheet.hidden && !document.querySelector('.modal-backdrop, [role="dialog"][aria-modal="true"]:not(.as-sheet)')) go('chat');
    });
    if (!addTrigger()) {
      // The chat UI mounts after this module; try again once it has.
      let tries = 0;
      const t = setInterval(() => { if (addTrigger() || ++tries > 40) clearInterval(t); }, 250);
    }
    paint();
    return sheet;
  }

  function paint() {
    if (!root.sheet) return;
    const active = state.active === 'chat' ? 'more' : state.active;
    const d = DESTINATIONS.find((x) => x.id === active);
    if (root.title) root.title.textContent = active === 'more' ? 'Sections' : (d ? d.label : 'Sections');
    if (root.back) root.back.setAttribute('aria-label', active === 'more' ? 'Back to chat' : 'All sections');
    root.bar.hidden = active === 'more';
    root.bar.querySelectorAll('.as-tab').forEach((t) => {
      const on = t.getAttribute('data-go') === active;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (root.panelHost) {
      const prevActive = root.panelHost.getAttribute('data-active');
      const keep = prevActive === active ? root.panelHost.scrollTop : 0;
      root.panelHost.setAttribute('data-active', active);
      const saved = state.active; state.active = active;
      root.panelHost.innerHTML = panelBody();
      state.active = saved;
      const holder = (window.__hostedScreens || {})[active];
      if (holder && holder.isConnected === false) root.panelHost.appendChild(holder);
      root.panelHost.scrollTop = keep;
    }
  }

  /* ---- engine answers ------------------------------------------------------
     Each of these is the shape the panel reads; none of them invents a value. */
  function applyParity(p) {
    if (!p || !Array.isArray(p.main)) return false;
    state.parity = { main: p.main, sub: Array.isArray(p.sub) ? p.sub : [] };
    paint();
    emit();
    return true;
  }
  function pushMessage(m) {
    if (!m || !m.from || !m.to) return false;
    state.swarm = [...state.swarm, { kind: 'message', at: new Date().toLocaleTimeString(), ...m }].slice(-200);
    paint();
    emit();
    return true;
  }
  function publish(post) {
    if (!post || !post.body) return false;
    state.social = [{ author: 'an agent', at: new Date().toLocaleString(), liked: 0, ...post }, ...state.social].slice(0, 50);
    paint();
    emit();
    return true;
  }

  /** Fold one engine event in, whatever kind it is. Unknown kinds are ignored. */
  function onEvent(type, payload) {
    const p = typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch (e) { return null; } })() : payload;
    if (!p) return false;
    switch (type) {
      case 'agent.message':
      case 'subagent.message':
        return pushMessage(p);
      case 'agent.parity':
        return applyParity(p);
      case 'social.post':
        return publish(p);
      default:
        return false;
    }
  }

  /** Join the runtime's event stream once, the same way the context panel does it.
   *
   * No bridge method is needed for any of this: `agents.*` and `social.*` ride the
   * same action channel `memory.*` already uses (`memory_request` in `lib.rs`), so
   * an older app keeps working and a newer engine answers. If the runtime is not
   * there at all, the panels still run — they just say they have no data yet.
   */
  function install(runtime) {
    try {
      if (runtime && typeof runtime._onEvent === 'function' && !runtime._asWrapped) {
        const base = runtime._onEvent.bind(runtime);
        runtime._asWrapped = true;
        runtime._onEvent = (event) => {
          const type = event && (event.type || event.name);
          if (typeof type === 'string' && (type.startsWith('agent.') || type.startsWith('social.'))) {
            const p = event.payloadJson ?? event.payload ?? event.data;
            try { onEvent(type, p); } catch (e) { console.warn('agent shell event', e); }
          }
          return base(event);
        };
      }
      mount();
      return true;
    } catch (e) {
      console.warn('agent shell install', e);
      return false;
    }
  }

  const out = {
    install,
    mount,
    go,
    paint,
    onEvent,
    applyParity,
    pushMessage,
    publish,
    destinations: () => DESTINATIONS.slice(),
    open: () => go('more'),
    close: () => go('chat'),
    isOpen: () => !!(root.sheet && !root.sheet.hidden),
    state: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    tips,
  };
  if (typeof window !== 'undefined') {
    window.__agentShell = out;
    const boot = () => {
      try {
        const runtime = window.__runtime || window.__agentRuntime || null;
        out.install(runtime);
      } catch (e) { console.warn('agent shell boot', e); }
    };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
  return out;
})();
