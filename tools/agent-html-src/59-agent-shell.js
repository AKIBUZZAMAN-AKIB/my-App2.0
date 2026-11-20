/* ==========================================================================
   Agent shell (phase 1 of the new UI): one navigation that never scrolls away,
   one dropdown that holds everything the top row cannot, and three panels the
   app was missing — agent parity, swarm messaging, and the social feed.

   Rules taken from the existing design (docs/subagents/SUBAGENT_UI_REDESIGN.md):

   * never stack nav rows: one sticky bar, overflow goes into a dropdown;
   * every row is a real <button> or <a>, focus is visible, Escape closes;
   * the bar is sticky inside its scroll container *and* reports how far the
     page has scrolled ("up" affordance) instead of disappearing;
   * a panel that has no engine answer says so, it does not invent numbers.
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
    { id: 'chat', label: 'Chat', row: true, hint: 'talk to the main agent' },
    { id: 'agents', label: 'Agents', row: true, hint: 'who is running, and what they may do' },
    { id: 'parity', label: 'Parity', row: false, group: 'Agents', hint: 'sub-agent vs main agent, side by side' },
    { id: 'swarm', label: 'Swarm', row: true, hint: 'agent-to-agent messages' },
    { id: 'social', label: 'Social', row: false, group: 'Publishing', hint: 'what the agents published' },
    { id: 'context', label: 'Context', row: false, group: 'Engine', hint: 'what is in the window' },
    { id: 'settings', label: 'Settings', row: false, group: 'Engine', hint: 'switches and numbers' },
  ];

  let state = {
    active: 'chat',
    scrolled: 0,
    parity: null, // { main: [...], sub: [...], same: [...] } as the engine reports it
    swarm: [], // { from, to, kind, text, at, delivered }
    social: [], // { author, title, body, at, liked }
  };
  const subs = new Set();
  const root = { bar: null, dropdown: null, panelHost: null, up: null };

  const emit = () => subs.forEach((fn) => { try { fn(state); } catch (e) { console.warn('agent shell', e); } });

  /** Pick a destination. The dropdown closes first so focus lands on the panel. */
  function go(id) {
    if (!DESTINATIONS.some((d) => d.id === id)) return false;
    state.active = id;
    if (typeof window !== 'undefined' && window.__personalize) { try { window.__personalize.visited(id); } catch (e) { console.warn('personalize', e); } }
    closeDropdown();
    paint();
    emit();
    return true;
  }

  /* ---- the sticky bar ------------------------------------------------------- */
  function bar() {
    const nav = el('nav', { class: 'as-bar', 'aria-label': 'App sections', 'data-slot': 'app-bar' });
    const row = el('div', { class: 'as-row', role: 'tablist' });
    // The user's order wins over the default one, so a pinned screen stays put.
    const P = (typeof window !== 'undefined' && window.__personalize) || null;
    let ordered = DESTINATIONS;
    if (P) {
      try {
        const ids = P.order(DESTINATIONS.map((d) => d.id));
        ordered = ids.map((id) => DESTINATIONS.find((d) => d.id === id)).filter(Boolean);
      } catch (e) { console.warn('personalize', e); }
    }
    for (const d of ordered.filter((x) => x.row)) {
      row.appendChild(
        el('button', {
          class: 'as-tab' + (d.id === state.active ? ' is-on' : ''),
          type: 'button',
          role: 'tab',
          'aria-selected': String(d.id === state.active),
          title: d.hint,
          onclick: () => go(d.id),
        }, d.label)
      );
    }
    nav.appendChild(row);
    nav.appendChild(dropdown());
    nav.appendChild(upButton());
    return nav;
  }

  function dropdown() {
    const wrap = el('div', { class: 'as-more' });
    const btn = el('button', { class: 'as-tab as-more-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: tips.dropdown }, 'More ▾');
    const menu = el('div', { class: 'as-menu', role: 'menu', hidden: '' });
    // Group in the order they first appear, so the list reads like the app.
    const groups = new Map();
    for (const d of DESTINATIONS) {
      const g = d.group || 'Go to';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(d);
    }
    for (const [g, items] of groups) {
      menu.appendChild(el('div', { class: 'as-menu-group', role: 'presentation' }, g));
      for (const d of items) {
        menu.appendChild(
          el('button', {
            class: 'as-menu-item' + (d.id === state.active ? ' is-on' : ''),
            type: 'button',
            role: 'menuitem',
            title: d.hint,
            onclick: () => { go(d.id); btn.focus(); },
          }, d.label)
        );
      }
    }
    btn.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) {
        const first = menu.querySelector('.as-menu-item');
        if (first) first.focus();
      }
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDropdown();
      if (e.key === 'ArrowDown') { e.preventDefault(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); const f = menu.querySelector('.as-menu-item'); if (f) f.focus(); }
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.as-menu-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { closeDropdown(); btn.focus(); }
      else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    root.dropdown = { btn, menu };
    return wrap;
  }

  function closeDropdown() {
    if (!root.dropdown) return;
    root.dropdown.menu.hidden = true;
    root.dropdown.btn.setAttribute('aria-expanded', 'false');
  }

  function upButton() {
    const b = el('button', { class: 'as-up', type: 'button', title: 'Back to the top', hidden: '' }, '↑');
    b.addEventListener('click', () => {
      const sc = scrollParent();
      if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    root.up = b;
    return b;
  }

  function scrollParent() {
    let n = root.bar && root.bar.parentElement;
    while (n && n !== document.body) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
      n = n.parentElement;
    }
    return null;
  }

  /* ---- the three new panels ------------------------------------------------ */
  const PANEL = {
    chat: () => '<p class="as-note">Pick a screen from the bar. Everything the app can do is reachable from “More”.</p>',

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

    agents: () => (window.__subagents && typeof window.__subagents.render === 'function'
      ? '<p class="as-note">The Agents screen owns this area; its own tab is in the top row.</p>'
      : '<p class="as-note">No agent screen is mounted in this build.</p>'),

    context: () => (window.__contextTree
      ? '<p class="as-note">The context panel lives in its own module and keeps its own state.</p>'
      : '<p class="as-note">The context panel is not in this build.</p>'),

    settings: () => `<p class="as-note">Switches and numbers for each feature live with that feature. The context window's
      own switch is inside its panel — it is the only number that can change what the model is sent.</p>`,
  };

  // A destination that matches a screen this build really has is hosted here;
  // otherwise the built-in panel explains itself. Never a blank area.
  const HOSTABLE = { vault: 'vault', notes: 'notes', genui: 'genui', folders: 'folders' };

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
  function mount(host) {
    if (root.bar) return root.bar;
    const target = host || document.querySelector('[data-app-shell]') || document.body;
    const shell = el('div', { class: 'as-shell', 'data-app-shell': '' });
    const b = bar();
    shell.appendChild(b);
    const body = el('div', { class: 'as-body', 'data-slot': 'shell-body' });
    shell.appendChild(body);
    target.insertBefore(shell, target.firstChild);
    root.bar = b;
    root.panelHost = body;

    // The bar is sticky; this listener only decides whether “up” is offered.
    const onScroll = () => {
      const sc = scrollParent();
      const y = (sc ? sc.scrollTop : window.scrollY) || 0;
      state.scrolled = y;
      if (root.up) root.up.hidden = y < 240;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    const sc = scrollParent();
    if (sc) sc.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });
    paint();
    return shell;
  }

  function paint() {
    if (!root.bar) return;
    // Tabs first, so a repaint never loses the reader's place.
    const tabs = root.bar.querySelectorAll('.as-tab');
    tabs.forEach((t) => {
      const on = t.textContent.trim() === DESTINATIONS.find((d) => d.id === state.active)?.label;
      t.classList.toggle('is-on', !!on);
      if (t.getAttribute('role') === 'tab') t.setAttribute('aria-selected', String(!!on));
    });
    if (root.panelHost) {
      root.panelHost.innerHTML = panelBody();
      const holder = (window.__hostedScreens || {})[state.active];
      if (holder && holder.isConnected === false) root.panelHost.appendChild(holder.firstChild || holder);
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
