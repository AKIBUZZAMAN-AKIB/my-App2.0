/* ==========================================================================
   Tool permissions page (stage F). Every tool the agent can call, grouped:
   the engine's own tools, device__*, MCP servers, ui__ widgets, sub-agent and
   chat tools. Each gets Always allow / Always ask / Ask + fingerprint / Never
   in a custom dropdown (listbox), saved through the existing
   setToolPermission(toolName, permission, enabled) — "Never" is enabled:false.
   With engine feature `toolRules`, tools whose rules match an argument get
   allowed/blocked pattern lists through listToolRules/setToolRules.
   Search, category groups, bulk actions and reset to defaults.
   ========================================================================== */
const ToolPermissions = (() => {
  const CHOICES = [
    { value: 'always_allow', label: 'Always allow', hint: 'Runs without asking' },
    { value: 'always_ask', label: 'Always ask', hint: 'Asks you each time' },
    { value: 'always_ask_biometric', label: 'Ask + fingerprint', hint: 'Asks, then checks your fingerprint or face' },
    { value: 'never', label: 'Never', hint: 'The agent can’t use it' },
  ];
  const choiceOf = (pm) => (pm && pm.enabled === false ? 'never' : (pm?.permission || 'always_ask'));
  const SESSION_TOOLS = ['list_sessions', 'ask_session'];
  const SUB_TOOLS = ['spawn_subagent', 'list_subagents', 'message_subagent', 'stop_subagent'];
  const GROUPS = [
    ['files', 'Files'], ['git', 'Git'], ['shell', 'Commands'], ['web', 'Web'], ['memory', 'Memory'], ['docs', 'Documents'],
    ['auto', 'Automations'], ['device', 'Phone (device)'], ['mcp', 'MCP servers'], ['ui', 'Widgets (ui__)'], ['agents', 'Sub-agents & chats'], ['other', 'Other'],
  ];
  function groupOf(name, mcpNames) {
    if (name.startsWith('device__')) return 'device';
    if (name.startsWith('ui__')) return 'ui';
    if (SUB_TOOLS.includes(name) || SESSION_TOOLS.includes(name)) return 'agents';
    if (mcpNames.has(name)) return 'mcp';
    if (/^git_/.test(name)) return 'git';
    if (name === 'execute_command') return 'shell';
    if (name === 'web_fetch' || /^web_/.test(name)) return 'web';
    if (/^memory_/.test(name)) return 'memory';
    if (/document/.test(name)) return 'docs';
    if (/cron|automation|skill/.test(name)) return 'auto';
    if (/file|^find_|^grep_/.test(name)) return 'files';
    return 'other';
  }
  const DEFAULTS = () => new Map((typeof DEFAULT_TOOL_PERMISSIONS !== 'undefined' ? DEFAULT_TOOL_PERMISSIONS : []).map((p) => [p.toolName, p]));
  /** The shipped default for a tool that has no row in the table. */
  function fallbackFor(name) {
    const d = DEFAULTS().get(name);
    if (d) return { ...d };
    if (/^ui__/.test(name) || name === 'list_subagents' || name === 'list_sessions') return { toolName: name, permission: 'always_allow', enabled: true };
    return { toolName: name, permission: 'always_ask', enabled: true };
  }

  /** Every tool name the page can see, with where it came from. */
  function collect(app, perms) {
    const conn = app?.chat?.native?.mcp?.connection;
    const mcpTools = Array.isArray(conn?.tools) ? conn.tools : [];
    const mcpNames = new Set();
    const desc = new Map();
    for (const t of mcpTools) {
      const n = String(t?.name || '');
      if (!n) continue;
      if (!n.startsWith('device__')) mcpNames.add(n);
      if (t.description) desc.set(n, String(t.description));
    }
    const ui = (typeof UI_TOOLS !== 'undefined' ? UI_TOOLS : []).map((t) => `ui__${t.name}`);
    for (const t of (typeof UI_TOOLS !== 'undefined' ? UI_TOOLS : [])) desc.set(`ui__${t.name}`, String(t.description || '').split('. ')[0]);
    const names = new Set([...DEFAULTS().keys(), ...perms.map((p) => p.toolName), ...mcpTools.map((t) => String(t?.name || '')), ...ui]);
    if (engine.has('subagents')) SUB_TOOLS.forEach((n) => names.add(n));
    if (engine.has('crossSession')) SESSION_TOOLS.forEach((n) => names.add(n));
    names.delete('');
    const byName = new Map(perms.map((p) => [p.toolName, p]));
    return [...names].sort().map((name) => ({ name, group: groupOf(name, mcpNames), stored: byName.get(name) || null, perm: byName.get(name) || fallbackFor(name), desc: desc.get(name) || '' }));
  }

  /* ---------- custom dropdown (button + listbox, keyboard and touch) ---------- */
  let openMenu = null;
  function closeMenu(focusBack = false) {
    if (!openMenu) return;
    const { list, btn } = openMenu;
    list.remove();
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    openMenu = null;
    if (focusBack) btn.focus();
  }
  function onOutside(e) { if (openMenu && !openMenu.list.contains(e.target) && e.target !== openMenu.btn && !openMenu.btn.contains(e.target)) closeMenu(); }
  function dropdown({ value, label, onChange, disabled = false, slot = 'perm-dropdown' }) {
    const id = `pd-${uid(6)}`;
    let cur = value;
    const text = h('span', { class: 'pd-text' });
    const btn = h('button', { type: 'button', class: 'pd-btn', 'data-slot': slot, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label, disabled }, text, icon('chevron-down'));
    const paint = () => { const c = CHOICES.find((x) => x.value === cur) || CHOICES[1]; text.textContent = c.label; btn.dataset.value = cur; };
    paint();
    const pick = async (v) => {
      closeMenu(true);
      if (v === cur) return;
      const prev = cur;
      cur = v; paint();
      btn.disabled = true;
      try { const ok = await onChange(v); if (ok === false) { cur = prev; paint(); } } catch { cur = prev; paint(); } finally { btn.disabled = false; }
    };
    const open = () => {
      if (openMenu?.btn === btn) { closeMenu(true); return; }
      closeMenu();
      const list = h('ul', { class: 'pd-list', role: 'listbox', id, 'aria-label': label, tabindex: '-1' },
        ...CHOICES.map((c) => h('li', { role: 'option', id: `${id}-${c.value}`, class: 'pd-option', 'data-value': c.value, 'aria-selected': String(c.value === cur), onclick: () => pick(c.value) },
          h('span', { class: 'pd-option-label' }, c.label), h('span', { class: 'pd-option-hint' }, c.hint))));
      let active = Math.max(0, CHOICES.findIndex((c) => c.value === cur));
      const mark = () => { [...list.children].forEach((li, i) => li.classList.toggle('is-active', i === active)); list.setAttribute('aria-activedescendant', list.children[active].id); };
      list.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { active = (active + 1) % CHOICES.length; mark(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { active = (active + CHOICES.length - 1) % CHOICES.length; mark(); e.preventDefault(); }
        else if (e.key === 'Home') { active = 0; mark(); e.preventDefault(); }
        else if (e.key === 'End') { active = CHOICES.length - 1; mark(); e.preventDefault(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(CHOICES[active].value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
        else if (e.key === 'Tab') closeMenu();
      });
      btn.after(list);
      // Open upwards when there is no room below.
      const r = btn.getBoundingClientRect();
      if (innerHeight - r.bottom < 220 && r.top > 220) list.classList.add('pd-up');
      mark();
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', id);
      openMenu = { list, btn };
      setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
      list.focus();
    };
    btn.addEventListener('click', open);
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
    return { el: h('div', { class: 'pd' }, btn), set: (v) => { cur = v; paint(); }, get: () => cur };
  }

  /* ---------- the page ---------- */
  const state = { q: '', group: 'all', selected: new Set(), collapsed: new Set() };

  function patternsEditor(name, subject, rule, onSaved) {
    const lines = (a) => (Array.isArray(a) ? a.join('\n') : '');
    const allow = h('textarea', { class: 'textarea pr-patterns', rows: '2', spellcheck: false, autocapitalize: 'off', 'aria-label': `Allowed ${subject} patterns for ${name}`, placeholder: subject === 'command' ? 'git status*\nls *' : subject === 'url' ? 'https://en.wikipedia.org/*' : subject === 'path' ? 'notes/**' : 'one per line' }, lines(rule?.allow));
    const deny = h('textarea', { class: 'textarea pr-patterns', rows: '2', spellcheck: false, autocapitalize: 'off', 'aria-label': `Blocked ${subject} patterns for ${name}`, placeholder: subject === 'command' ? 'rm -rf *' : subject === 'path' ? '.env\nsecrets/**' : 'one per line' }, lines(rule?.deny));
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const parse = (t) => [...new Set(t.value.split('\n').map((x) => x.trim()).filter(Boolean))];
    const save = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'rules-save', onclick: async () => {
      const a = parse(allow), d = parse(deny);
      const bad = [...a, ...d].find((x) => x.length > 500);
      if (bad) { err.hidden = false; err.textContent = 'A pattern can be at most 500 characters.'; return; }
      err.hidden = true;
      save.disabled = true;
      try {
        await nativeKit().agent.setToolRules(name, { allow: a, deny: d });
        toast(a.length || d.length ? `Rules saved for ${name}.` : `Rules removed for ${name}.`, { type: 'success' });
        onSaved?.({ allow: a, deny: d });
      } catch (e) { err.hidden = false; err.textContent = redact(e?.message || String(e)); } finally { save.disabled = false; }
    } }, 'Save rules');
    return h('div', { class: 'pr-rules', 'data-slot': 'tool-rules', 'data-tool': name },
      h('p', { class: 'field-hint' }, `Patterns match the tool’s ${subject}. Blocked always wins; allowed skips the question. * matches anything.`),
      h('label', { class: 'pr-rules-label' }, 'Allowed (no question)', allow),
      h('label', { class: 'pr-rules-label' }, 'Blocked (never runs)', deny),
      err, h('div', { class: 'row-actions' }, save));
  }
  const redact = (s) => String(s).replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '[hidden]').replace(/(bearer\s+)[^\s]+/ig, '$1[hidden]');

  async function render(app, refresh) {
    const bridgeRef = typeof bridge !== 'undefined' ? bridge : null;
    let perms = [];
    let loadErr = '';
    try { perms = await bridgeRef.listToolPermissions(); } catch (e) { loadErr = e?.message || String(e); }
    let rules = { rules: {}, subjects: {} };
    const rulesOn = engine.has('toolRules') && typeof nativeKit()?.agent?.listToolRules === 'function';
    if (rulesOn) { try { const r = await nativeKit().agent.listToolRules(); rules = { rules: r?.rules || {}, subjects: r?.subjects || {} }; } catch { /* rules hidden below */ } }
    const tools = collect(app, perms);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of [...state.selected]) if (!byName.has(n)) state.selected.delete(n);

    const setOne = async (name, v) => {
      const t = byName.get(name);
      const permission = v === 'never' ? (t.perm.permission || 'always_ask') : v;
      try {
        await bridgeRef.setToolPermission(name, permission, v !== 'never');
        t.perm = { toolName: name, permission, enabled: v !== 'never' }; t.stored = t.perm;
        return true;
      } catch (e) { toast(`${name}: ${redact(e?.message || e)}`, { type: 'error' }); return false; }
    };

    const listHost = h('div', { class: 'pr-groups' });
    const countEl = h('p', { class: 'pr-count', 'aria-live': 'polite', 'data-slot': 'perm-count' });
    const bulkBar = h('div', { class: 'pr-bulk', 'data-slot': 'perm-bulk' });
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search tools', 'aria-label': 'Search tools', value: state.q, 'data-slot': 'perm-search', autocomplete: 'off', spellcheck: false });
    const groupSel = h('select', { class: 'select select-sm', 'aria-label': 'Category', 'data-slot': 'perm-group' },
      h('option', { value: 'all' }, 'All categories'),
      ...GROUPS.filter(([g]) => tools.some((t) => t.group === g)).map(([g, l]) => h('option', { value: g, selected: state.group === g }, `${l} (${tools.filter((t) => t.group === g).length})`)));

    const visible = () => {
      const q = state.q.trim().toLowerCase();
      return tools.filter((t) => (state.group === 'all' || t.group === state.group) && (!q || t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)));
    };

    const paintBulk = () => {
      const n = state.selected.size;
      const vis = visible();
      const allOn = vis.length && vis.every((t) => state.selected.has(t.name));
      const selAll = h('input', { type: 'checkbox', class: 'checkbox', 'aria-label': 'Select all shown tools', 'data-slot': 'perm-select-all', checked: !!allOn, onchange: () => { for (const t of vis) { if (selAll.checked) state.selected.add(t.name); else state.selected.delete(t.name); } paintList(); } });
      const bulkDd = dropdown({ value: 'always_ask', label: 'Set selected tools to', slot: 'perm-bulk-dropdown', disabled: !n, onChange: async (v) => {
        const names = [...state.selected];
        let ok = 0;
        for (const name of names) if (await setOne(name, v)) ok++;
        toast(ok === names.length ? `${ok} tool${ok === 1 ? '' : 's'} set to ${CHOICES.find((c) => c.value === v).label}.` : `${ok} of ${names.length} changed; the rest failed.`, { type: ok === names.length ? 'success' : 'error' });
        state.selected.clear();
        paintList();
        return true;
      } });
      bulkBar.replaceChildren(h('label', { class: 'pr-selall' }, selAll, h('span', null, n ? `${n} selected` : 'Select')), h('span', { class: 'pr-bulk-label' }, 'Set to'), bulkDd.el,
        n ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { state.selected.clear(); paintList(); } }, 'Clear') : null);
    };

    function row(t) {
      const dd = dropdown({ value: choiceOf(t.perm), label: `Permission for ${t.name}`, onChange: (v) => setOne(t.name, v) });
      const sel = h('input', { type: 'checkbox', class: 'checkbox', 'aria-label': `Select ${t.name}`, checked: state.selected.has(t.name), onchange: () => { if (sel.checked) state.selected.add(t.name); else state.selected.delete(t.name); paintBulk(); } });
      const subject = rules.subjects[t.name];
      const rule = rules.rules[t.name];
      const nRules = (rule?.allow?.length || 0) + (rule?.deny?.length || 0);
      let rulesBox = null;
      const rulesBtn = rulesOn && subject ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm pr-rules-btn', 'aria-expanded': 'false', 'data-slot': 'rules-toggle', 'aria-label': `Patterns for ${t.name}${nRules ? ` (${nRules})` : ''}`, onclick: () => {
        if (rulesBox) { rulesBox.remove(); rulesBox = null; rulesBtn.setAttribute('aria-expanded', 'false'); return; }
        rulesBox = patternsEditor(t.name, subject, rules.rules[t.name], (r) => { rules.rules[t.name] = r; const c = r.allow.length + r.deny.length; rulesBtn.querySelector('.pr-rules-n').textContent = c ? String(c) : ''; });
        li.append(rulesBox);
        rulesBtn.setAttribute('aria-expanded', 'true');
      } }, icon('list'), 'Patterns', h('span', { class: 'pr-rules-n' }, nRules ? String(nRules) : '')) : null;
      const li = h('li', { class: 'pr-row', 'data-tool': t.name, 'data-choice': choiceOf(t.perm) },
        h('div', { class: 'pr-row-main' }, sel,
          h('div', { class: 'pr-row-text' }, h('code', { class: 'pr-name' }, t.name),
            t.desc ? h('span', { class: 'pr-desc' }, t.desc) : null,
            !t.stored ? h('span', { class: 'pr-default', 'data-slot': 'perm-unsaved' }, 'Default, not saved yet') : null),
          dd.el),
        rulesBtn ? h('div', { class: 'pr-row-extra' }, rulesBtn) : null);
      return li;
    }

    function paintList() {
      const vis = visible();
      countEl.textContent = `${vis.length} of ${tools.length} tools`;
      const groups = GROUPS.map(([g, l]) => [g, l, vis.filter((t) => t.group === g)]).filter(([, , ts]) => ts.length);
      listHost.replaceChildren(...(groups.length ? groups.map(([g, l, ts]) => {
        const collapsed = state.collapsed.has(g) && !state.q;
        const head = h('button', { type: 'button', class: 'pr-group-head', 'aria-expanded': String(!collapsed), 'data-slot': 'perm-group-head', onclick: () => { if (state.collapsed.has(g)) state.collapsed.delete(g); else state.collapsed.add(g); paintList(); } },
          icon(collapsed ? 'chevron-right' : 'chevron-down'), h('span', null, l), h('span', { class: 'pr-group-n' }, String(ts.length)));
        return h('section', { class: 'pr-group', 'data-group': g }, head, collapsed ? null : h('ul', { class: 'pr-list', 'aria-label': l }, ...ts.map(row)));
      }) : [h('p', { class: 'field-hint', 'data-slot': 'perm-empty' }, state.q ? `No tool matches “${state.q}”.` : 'No tools in this category.')]));
      paintBulk();
    }
    let timer = 0;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value; paintList(); }, 120); });
    groupSel.addEventListener('change', () => { state.group = groupSel.value; paintList(); });
    paintList();

    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-slot': 'perm-reset', onclick: () => confirmDialog({
      title: 'Reset tool permissions to the defaults?', description: 'Every choice you made here is forgotten and the shipped defaults come back. Pattern rules are kept.', confirmLabel: 'Reset', destructive: true,
      onConfirm: async () => {
        try { await bridgeRef.resetToolPermissions(); await bridgeRef.seedToolPermissions(); toast('Tool permissions reset to the defaults.', { type: 'success' }); } catch (e) { toast(redact(e?.message || e), { type: 'error' }); }
        refresh();
      } }) }, icon('rotate-ccw'), 'Reset to defaults');
    const seedBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'perm-seed', onclick: async () => {
      try { await bridgeRef.seedToolPermissions(); toast('Missing defaults added; your choices were kept.', { type: 'success' }); refresh(); } catch (e) { toast(redact(e?.message || e), { type: 'error' }); }
    } }, icon('plus'), 'Add missing defaults');

    return h('div', { class: 'pr-page', 'data-slot': 'tool-permissions' },
      h('div', { class: 'field-label-row' }, h('p', { class: 'field-label' }, 'Tool permissions'), h('div', { class: 'row-actions' }, seedBtn, resetBtn)),
      h('p', { class: 'field-hint' }, '“Never” turns the tool off. “Ask + fingerprint” checks your fingerprint or face before it runs.' + (rulesOn ? ' Patterns let a tool run some commands, paths or sites without asking, or block them.' : '')),
      loadErr ? h('p', { class: 'field-error', role: 'alert', 'data-slot': 'perm-error' }, `Couldn’t read the saved permissions: ${redact(loadErr)}. Showing the defaults.`) : null,
      h('div', { class: 'pr-toolbar' }, search, groupSel),
      countEl, bulkBar, listHost);
  }

  const api = { render, collect, CHOICES, groupOf, closeMenu };
  if (typeof window !== 'undefined') window.__toolPermissions = api;
  return api;
})();
