/* Groups (plan.md, Phase 3): group chats of the user and three or more
 * sub-agents. Everything here is drawn from the engine's `groups.*` answers
 * (subagents channel); nothing is invented. The composer shows, before
 * sending, who will be woken and why (the same `decide` as the real post),
 * each message can say why each member was or was not woken, and the rules
 * sheet edits presets and rules with the engine's validation. */
const GroupsUI = (() => {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return d; } };
  const PRESETS = [
    ['social', 'Social', 'Agents answer when mentioned or replied to.'],
    ['everyone', 'Everyone answers', 'Every agent answers each of your messages.'],
    ['round_table', 'Round table', 'One agent answers each message, in turn.'],
    ['wait_your_turn', 'Wait your turn', 'An agent steps in after three unanswered messages.'],
    ['moderated', 'Moderated', 'Only you wake agents; agents cannot wake each other.'],
  ];
  const PRESENCE = { active: 'Active', idle: 'Idle', paused: 'Paused', suspended: 'Suspended', gone: 'Gone', left: 'Left', owner: 'You' };
  const st = { root: null, open: false, view: 'list', groups: [], group: null, detail: null, messages: [], preview: null, why: null, error: '', agents: [], picked: new Set(), tab: 'chat', previewTimer: 0 };

  /** The engine bridge: the plugin's subagents channel, else a test hook. */
  function send() {
    try {
      const kit = typeof nativeKit === 'function' ? nativeKit() : (typeof window !== 'undefined' ? window.NativeKit : null);
      if (kit && kit.agent && typeof kit.agent.subagents === 'function') {
        return async (action, extra) => {
          const r = await kit.agent.subagents({ action, ...(extra || {}) });
          if (r && typeof r.resultJson === 'string') return parse(r.resultJson, {});
          if (r && typeof r.json === 'string') return parse(r.json, {});
          return parse(r, {});
        };
      }
    } catch (e) { /* no engine */ }
    if (typeof window !== 'undefined' && typeof window.__groupsBridge === 'function') return window.__groupsBridge;
    return null;
  }
  async function call(action, extra) {
    const s = send();
    if (!s) throw new Error('Groups need the agent engine.');
    const r = await s(action, extra);
    if (r && r.error) throw new Error(String(r.error));
    return r || {};
  }
  function fail(e) { st.error = String((e && e.message) || e || 'Something went wrong.'); paint(); }

  function ensureRoot() {
    if (st.root) return st.root;
    const el = document.createElement('div');
    el.className = 'gr-sheet';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Groups');
    el.hidden = true;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.classList.contains('gr-input')) { e.preventDefault(); post(); }
    });
    st.root = el;
    document.body.appendChild(el);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.open && !el.contains(e.target)) close(); }, true);
    return el;
  }

  async function open(groupId) {
    ensureRoot();
    st.open = true;
    st.root.hidden = false;
    st.error = '';
    if (groupId) return openGroup(groupId);
    st.view = 'list';
    paint();
    try { st.groups = (await call('groups.list')).groups || []; } catch (e) { return fail(e); }
    paint();
  }
  function close() { st.open = false; if (st.root) st.root.hidden = true; }

  async function openGroup(id) {
    st.view = 'group';
    st.tab = 'chat';
    st.why = null;
    st.preview = null;
    try {
      st.detail = await call('groups.get', { group: id });
      st.group = st.detail.group || null;
      const r = await call('groups.read', { group: id, limit: 80 });
      st.messages = r.messages || [];
      const last = st.messages[st.messages.length - 1];
      if (last) call('groups.read_cursor', { group: id, message: last.id }).catch(() => {});
    } catch (e) { return fail(e); }
    paint();
  }

  async function startCreate() {
    st.view = 'create';
    st.picked = new Set();
    st.newName = '';
    st.newPurpose = '';
    st.newPreset = 'social';
    paint();
    try {
      const r = await call('list', { status: 'all' });
      st.agents = (r.items || r.subagents || []).filter((a) => a && a.id && !a.hidden);
    } catch (e) { return fail(e); }
    paint();
  }

  async function create() {
    const name = st.newName || '';
    const purpose = st.newPurpose || '';
    const preset = st.newPreset || 'social';
    if (st.picked.size < 3) { st.error = 'Pick at least three agents.'; return paint(); }
    try {
      const r = await call('groups.create', { name, purpose, preset, members: [...st.picked] });
      st.error = '';
      await openGroup(r.group.id);
    } catch (e) { fail(e); }
  }

  function draft() {
    const box = st.root && st.root.querySelector('.gr-input');
    return box ? box.value : '';
  }

  /** Live preview: who this message would wake, from the engine. */
  function schedulePreview() {
    clearTimeout(st.previewTimer);
    st.previewTimer = setTimeout(async () => {
      const text = draft();
      if (!st.group || !text.trim()) { st.preview = null; return paintPreview(); }
      try { st.preview = await call('groups.preview', { group: st.group.id, text, replyTo: st.replyTo || undefined }); } catch (e) { st.preview = { error: String(e.message || e) }; }
      paintPreview();
    }, 180);
  }

  async function post(force) {
    const text = draft();
    if (!st.group || !text.trim()) return;
    const p = st.preview;
    if (!force && p && p.needsConfirm) {
      st.confirm = p.needsConfirm;
      return paint();
    }
    st.confirm = null;
    try {
      await call('groups.post', { group: st.group.id, text, replyTo: st.replyTo || undefined });
      st.replyTo = null;
      st.preview = null;
      await openGroup(st.group.id);
    } catch (e) { fail(e); }
  }

  async function showWhy(mid) {
    try { st.why = { mid, rows: (await call('groups.dispatch', { message: mid })).rows || [] }; } catch (e) { return fail(e); }
    paint();
  }

  async function groupOp(action, extra) {
    try {
      await call(action, { group: st.group.id, ...(extra || {}) });
      st.error = '';
      st.draft = null;
      st.validation = null;
      await openGroup(st.group.id);
      if (action.startsWith('groups.rules')) loadRulesSide().then(paint);
      if (action.startsWith('rules') || action.startsWith('members')) st.tab = action.startsWith('rules') ? 'rules' : 'members';
      paint();
    } catch (e) { fail(e); }
  }

  function toggleRule(id, i) {
    editDraft((rules) => { const r = rules[i] || rules.find((x) => x.id === id); if (r) r.enabled = !r.enabled; });
  }

  function onInput(e) {
    if (e.target.classList.contains('gr-new-name')) st.newName = e.target.value;
    if (e.target.classList.contains('gr-new-purpose')) st.newPurpose = e.target.value;
    if (e.target.classList.contains('gr-input')) schedulePreview();
    if (e.target.classList.contains('gr-test-input')) scheduleTest(e.target.value);
    if (e.target.matches('input[type=number][data-gr="rule-param"]')) onRuleParam(e.target);
  }

  function onRuleParam(t) {
    const i = Number(t.getAttribute('data-i'));
    const k = t.getAttribute('data-k');
    const type = t.getAttribute('data-type');
    const val = type === 'bool' ? t.checked : type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
    editDraft((rules) => { if (rules[i]) rules[i].params[k] = val; });
  }

  function onChange(e) {
    const t = e.target;
    if (t.classList.contains('wb-holder-policy') && window.__wsBulk) {
      return Promise.resolve(window.__wsBulk.setHolderPolicy(t.getAttribute('data-holder'), t.value)).then(loadRulesSide).then(paint).catch(fail);
    }
    const a = t.getAttribute('data-gr');
    if (!a) return;
    const i = Number(t.getAttribute('data-i'));
    if (a === 'rule-toggle') return toggleRule(t.getAttribute('data-v'), i);
    if (a === 'rule-param' && t.type !== 'number') return onRuleParam(t);
    if (a === 'rule-scope') return editDraft((rules) => { if (rules[i]) rules[i].scope = t.value; });
    if (a === 'rule-add' && t.value) { const kind = t.value; return editDraft((rules) => rules.push({ id: '', scope: st.ruleScope || 'group', kind, params: ruleDefaults(kind), priority: 0, enabled: true })); }
    if (a === 'ai-context') return groupSide('groups.settings', { settings: { aiContext: t.value } });
    if (a === 'ctx-state') return groupSide('groups.context.set', { itemId: t.getAttribute('data-v'), state: t.value });
    if (a === 'ctx-lock') return groupSide('groups.context.set', { itemId: t.getAttribute('data-v'), state: t.getAttribute('data-state') || 'in', lock: t.checked });
  }

  async function groupSide(action, extra) {
    try {
      await call(action, { group: st.group.id, ...(extra || {}) });
      st.error = '';
      if (action === 'groups.settings') { st.detail = await call('groups.get', { group: st.group.id }); }
      await loadRulesSide();
      paint();
    } catch (e) { fail(e); }
  }

  function onClick(e) {
    const t = e.target.closest('[data-gr]');
    if (!t) return;
    const a = t.getAttribute('data-gr');
    const v = t.getAttribute('data-v') || '';
    if (a === 'close') return close();
    if (a === 'back') return open();
    if (a === 'open') return openGroup(v);
    if (a === 'new') return startCreate();
    if (a === 'new-preset') { st.newPreset = v; return; }
    if (a === 'pick') { if (st.picked.has(v)) st.picked.delete(v); else st.picked.add(v); return paint(); }
    if (a === 'create') return create();
    if (a === 'send') return post(false);
    if (a === 'send-anyway') return post(true);
    if (a === 'cancel-confirm') { st.confirm = null; return paint(); }
    if (a === 'why') return showWhy(v);
    if (a === 'why-close') { st.why = null; return paint(); }
    if (a === 'reply') { st.replyTo = v; paint(); schedulePreview(); return; }
    if (a === 'reply-clear') { st.replyTo = null; paint(); schedulePreview(); return; }
    if (a === 'tab') { st.tab = v; st.ruleScope = ''; if (v === 'rules') { st.draft = null; st.validation = null; loadRulesSide().then(paint); } return paint(); }
    if (a === 'preset') return groupOp('groups.rules.preset', { preset: v });
    if (a === 'rule-toggle' || a === 'rule-param' || a === 'rule-scope' || a === 'rule-add' || a === 'ai-context' || a === 'ctx-state' || a === 'ctx-lock') return;
    if (a === 'rule-up' || a === 'rule-down') { const i = Number(t.getAttribute('data-i')); const j = a === 'rule-up' ? i - 1 : i + 1; return editDraft((rules) => { if (rules[i] && rules[j]) [rules[i], rules[j]] = [rules[j], rules[i]]; }); }
    if (a === 'rule-del') { const i = Number(t.getAttribute('data-i')); return editDraft((rules) => rules.splice(i, 1)); }
    if (a === 'rules-save') return saveDraft();
    if (a === 'member-rules') { st.tab = 'rules'; st.draft = null; st.validation = null; st.ruleScope = v; loadRulesSide().then(paint); return paint(); }
    if (a === 'rule-scope-all') { st.ruleScope = ''; return paint(); }
    if (a === 'rules-reset') { st.draft = null; st.validation = null; return paint(); }
    if (a === 'remove') return groupOp('groups.members.remove', { pid: v });
    if (a === 'mute') return groupOp('groups.members.mute', { pid: v, until: Date.now() + 3600e3 });
    if (a === 'unmute') return groupOp('groups.members.mute', { pid: v, until: null });
    if (a === 'pin') return groupOp('groups.pin', { message: v });
    if (a === 'state') return groupOp('groups.' + v);
    if (a === 'nudge') return groupOp('groups.nudged', { message: v });
  }

  function presenceDot(p) { return `<span class="gr-dot gr-p-${esc(p)}" title="${esc(PRESENCE[p] || p)}"></span>`; }

  function listView() {
    const rows = st.groups.length
      ? st.groups.map((g) => `<button type="button" class="gr-row" data-gr="open" data-v="${esc(g.id)}"><span class="gr-name">#${esc(g.name)}</span>${g.unread ? `<span class="gr-badge">${esc(g.unread)}</span>` : ''}<span class="gr-sub">${(g.presence || []).map((m) => presenceDot(m.presence)).join('')} ${esc(g.members)} agents · ${esc(g.presetLabel || '')}${g.state !== 'active' ? ' · ' + esc(g.state) : ''}${g.suspended ? ` · ${esc(g.suspended)} suspended` : ''}</span></button>`).join('')
      : '<p class="gr-empty">No groups yet. A group is a chat with you and three or more agents.</p>';
    return `<header class="gr-head"><h2>Groups</h2><button type="button" class="gr-btn" data-gr="new">New group</button><button type="button" class="gr-x" data-gr="close" aria-label="Close">×</button></header><div class="gr-body">${rows}</div>`;
  }

  function createView() {
    const agents = st.agents.length
      ? st.agents.map((a) => `<label class="gr-pick"><input type="checkbox" data-gr="pick" data-v="${esc(a.id)}" ${st.picked.has(a.id) ? 'checked' : ''}> ${esc(a.title || a.name)} <span class="gr-sub">${a.shareable ? 'shareable' : 'this chat only'}</span></label>`).join('')
      : '<p class="gr-empty">No agents to add yet.</p>';
    const presets = PRESETS.map(([k, l, d]) => `<label class="gr-pick"><input type="radio" name="gr-preset" data-gr="new-preset" data-v="${k}" value="${k}" ${(st.newPreset || 'social') === k ? 'checked' : ''}> ${esc(l)} <span class="gr-sub">${esc(d)}</span></label>`).join('');
    return `<header class="gr-head"><button type="button" class="gr-x" data-gr="back" aria-label="Back">‹</button><h2>New group</h2></header><div class="gr-body"><input class="gr-field gr-new-name" placeholder="Name" aria-label="Group name" value="${esc(st.newName || '')}"><input class="gr-field gr-new-purpose" placeholder="Purpose (optional)" aria-label="Purpose" value="${esc(st.newPurpose || '')}"><h3>Members (${st.picked.size} of at least 3)</h3>${agents}<h3>Who answers</h3>${presets}<button type="button" class="gr-btn gr-primary" data-gr="create" ${st.picked.size < 3 ? 'disabled' : ''}>Create group</button></div>`;
  }

  function messageRow(m) {
    if (m.kind === 'system') return `<div class="gr-sys">${esc(m.text)}</div>`;
    const quote = m.replyQuote ? `<div class="gr-quote">↪ ${esc(m.replyQuote.fromName)}: ${esc(m.replyQuote.text)}</div>` : '';
    const mine = m.from === 'user';
    const del = m.state === 'deleted';
    return `<div class="gr-msg${mine ? ' gr-mine' : ''}${del ? ' gr-deleted' : ''}" data-mid="${esc(m.id)}">${quote}<div class="gr-from">${esc(m.fromName || m.from)}</div><div class="gr-text">${esc(m.text)}</div><div class="gr-acts">${del ? '' : `<button type="button" data-gr="reply" data-v="${esc(m.id)}">Reply</button>`}${mine ? `<button type="button" data-gr="why" data-v="${esc(m.id)}">Who was woken?</button>` : ''}<button type="button" data-gr="pin" data-v="${esc(m.id)}">Pin</button></div></div>`;
  }

  function previewHtml() {
    const p = st.preview;
    if (!p) return '';
    if (p.error) return `<div class="gr-preview gr-err">${esc(p.error)}</div>`;
    const names = p.names || {};
    const nm = (pid) => esc(names[pid] || pid);
    const wake = (p.wake || []).map((w) => nm(w.pid));
    const coalesce = (p.coalesce || []).map((w) => nm(w.pid));
    const queue = (p.queue || []).map((w) => nm(w.pid));
    let s = wake.length ? `Will wake: ${wake.join(', ')} (about ${esc(p.estTokens)} tokens)` : 'Wakes nobody; members can read it.';
    if (coalesce.length) s += ` · Added to the run going: ${coalesce.join(', ')}`;
    if (queue.length) s += ` · Queued (paused): ${queue.join(', ')}`;
    return `<div class="gr-preview">${s}</div>`;
  }
  function paintPreview() {
    const el = st.root && st.root.querySelector('.gr-preview-slot');
    if (el) el.innerHTML = previewHtml();
  }

  function membersTab(d) {
    return (d.members || []).filter((m) => m.pid !== 'user').map((m) => `<div class="gr-member">${presenceDot(m.presence)}<span class="gr-name">${esc(m.name)}</span><span class="gr-sub">${esc(m.role)}${m.crossChat ? ' · from another chat' : ''}${m.suspendedText ? ' · suspended: ' + esc(m.suspendedText) : ''}${m.engaged ? ' · in the conversation' : ''}${m.rules && m.rules.length ? ' · rules: ' + esc(m.rules.join(', ')) : ''}</span>${m.membership === 'left' ? '' : `${m.mutedUntil && m.mutedUntil > Date.now() ? `<button type="button" data-gr="unmute" data-v="${esc(m.pid)}">Unmute</button>` : `<button type="button" data-gr="mute" data-v="${esc(m.pid)}">Mute 1 h</button>`}<button type="button" data-gr="member-rules" data-v="${esc(m.pid)}" aria-label="Rules for ${esc(m.name)}">Rules</button><button type="button" data-gr="remove" data-v="${esc(m.pid)}">Remove</button>`}</div>`).join('');
  }

  // ------------------------------------------------------------ rules editor (Phase 5)
  // Plain controls per kind; every edit is validated by the engine before
  // Save; the test box asks the engine's preview, the same code as a send.
  const RULE_KINDS = {
    respond: { label: 'Who answers', fields: [['mode', 'choice', [['mention_only', 'Only who I mention'], ['everyone', 'Everyone'], ['round_robin', 'Take turns'], ['first_available', 'First available']]], ['on', 'choice', [['user_messages', 'My messages'], ['all_messages', 'All messages']]]] },
    delivery: { label: 'Who sees messages', fields: [['mode', 'choice', [['all', 'Everyone'], ['mentions_and_replies', 'Only mentions and replies'], ['none', 'Nobody']]]] },
    reply_wakes_author: { label: 'A reply wakes its author', fields: [['on', 'bool']] },
    agent_to_agent: { label: 'Agents can mention agents', fields: [['allowed', 'bool'], ['max_depth', 'number', 'Chain depth']] },
    unanswered_threshold: { label: 'Reply only after unanswered messages', fields: [['n', 'number', 'Reply only after'], ['count', 'choice', [['group', 'Count messages in the group'], ['member', 'Count since this member last spoke']]], ['wake', 'choice', [['least_recent', 'Wake who spoke least recently'], ['all', 'Wake everyone']]]] },
    silence_nudge: { label: 'When the group goes quiet', fields: [['after_secs', 'number', 'After seconds'], ['action', 'choice', [['notify_user', 'Tell me']]]] },
    cooldown: { label: 'Cooldown per agent', fields: [['secs', 'number', 'Seconds']] },
    max_replies_per_message: { label: 'Replies per message', fields: [['n', 'number', 'At most']] },
    rate: { label: 'Wake limit', fields: [['wakes_per_10min', 'number', 'Wakes per 10 minutes']] },
    budget: { label: 'Token budget', fields: [['tokens_per_day', 'number', 'Tokens per day'], ['on_exhausted', 'choice', [['mentions_only', 'Only mentions wake'], ['pause', 'Pause the group']]]] },
    quiet: { label: 'Quiet (never woken by rules)', fields: [] },
  };
  const ruleDefaults = (kind) => {
    const p = {};
    for (const [k, type, opts] of (RULE_KINDS[kind] || { fields: [] }).fields) p[k] = type === 'bool' ? true : type === 'number' ? 1 : opts[0][0];
    return p;
  };
  function draftRules() {
    if (!st.draft || st.draftGroup !== (st.group && st.group.id)) {
      st.draft = (st.detail.rules || []).map((r) => ({ ...r, params: { ...(r.params || {}) } }));
      st.draftGroup = st.group && st.group.id;
      st.draftDirty = false;
    }
    return st.draft;
  }
  let validateTimer = null;
  function editDraft(fn) {
    fn(draftRules());
    st.draftDirty = true;
    paint();
    clearTimeout(validateTimer);
    validateTimer = setTimeout(async () => {
      try {
        const v = await call('groups.rules.validate', { group: st.group.id, rules: st.draft });
        st.validation = v;
      } catch (e) { st.validation = { ok: false, errors: [String(e.message || e)], warnings: [] }; }
      paint();
    }, 250);
  }
  async function saveDraft() {
    try {
      const r = await call('groups.rules.set', { group: st.group.id, rules: st.draft });
      if (!r.saved) { st.validation = r.validation; return paint(); }
      st.warnings = (r.validation && r.validation.warnings) || [];
      st.draft = null;
      st.validation = null;
      await openGroup(st.group.id);
      st.tab = 'rules';
      await loadRulesSide();
      paint();
    } catch (e) { fail(e); }
  }
  async function loadRulesSide() {
    try {
      const [h, c] = await Promise.all([call('groups.rules.history', { group: st.group.id, limit: 30 }), call('groups.context.list', { group: st.group.id })]);
      st.rulesHistory = h.history || [];
      st.groupCtx = c;
      try { st.delPolicies = ((await call('items.policy.get', {})) || {}).policies || []; } catch (e) { st.delPolicies = null; }
    } catch (e) { st.rulesHistory = st.rulesHistory || []; }
  }
  let testTimer = null;
  function scheduleTest(text) {
    st.testText = text;
    clearTimeout(testTimer);
    testTimer = setTimeout(async () => {
      if (!text.trim()) { st.testResult = null; return paint(); }
      try { st.testResult = await call('groups.preview', { group: st.group.id, text }); } catch (e) { st.testResult = { error: String(e.message || e) }; }
      paint();
      const box = st.root && st.root.querySelector('.gr-test-input');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }, 300);
  }
  function ruleFields(r, i) {
    const def = RULE_KINDS[r.kind];
    if (!def) return `<span class="gr-sub">${esc(JSON.stringify(r.params))}</span>`;
    return def.fields.map(([k, type, extra]) => {
      const v = r.params[k];
      const attrs = `data-gr="rule-param" data-i="${i}" data-k="${k}" data-type="${type}"`;
      if (type === 'bool') return `<label class="gr-field"><input type="checkbox" ${attrs} ${v ? 'checked' : ''}> ${esc(k === 'on' ? 'On' : k === 'allowed' ? 'Allowed' : k)}</label>`;
      if (type === 'number') return `<label class="gr-field">${esc(extra)} <input type="number" min="0" class="gr-num" ${attrs} value="${esc(v == null ? '' : v)}"></label>`;
      return `<label class="gr-field"><select ${attrs} aria-label="${esc(def.label)} ${esc(k)}">${extra.map(([o, l]) => `<option value="${o}" ${v === o ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    }).join('');
  }
  function rulesTab(d) {
    const g = d.group || {};
    const presets = PRESETS.map(([k, l, desc]) => `<button type="button" class="gr-preset${g.preset === k ? ' gr-on' : ''}" data-gr="preset" data-v="${k}" title="${esc(desc)}">${esc(l)}</button>`).join('');
    const rules = draftRules();
    const members = (d.members || []).filter((m) => m.pid !== 'user' && m.membership !== 'left');
    const scopeName = st.ruleScope ? ((members.find((m) => m.pid === st.ruleScope) || {}).name || st.ruleScope) : '';
    const rows = rules.map((r, i) => (st.ruleScope && r.scope !== st.ruleScope ? '' : `<div class="gr-rule${r.enabled ? '' : ' gr-off'}" data-rule="${esc(r.id || i)}"><div class="gr-rule-head"><label><input type="checkbox" data-gr="rule-toggle" data-v="${esc(r.id)}" data-i="${i}" ${r.enabled ? 'checked' : ''}> ${esc((RULE_KINDS[r.kind] || {}).label || r.kind.replace(/_/g, ' '))} <span class="gr-sub gr-kind">${esc(r.kind)}</span></label><select data-gr="rule-scope" data-i="${i}" aria-label="Applies to"><option value="group" ${r.scope === 'group' ? 'selected' : ''}>Whole group</option>${members.map((m) => `<option value="${esc(m.pid)}" ${r.scope === m.pid ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select><button type="button" class="gr-mini" data-gr="rule-up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="gr-mini" data-gr="rule-down" data-i="${i}" aria-label="Move down" ${i === rules.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="gr-mini" data-gr="rule-del" data-i="${i}" aria-label="Remove rule">Remove</button></div><div class="gr-rule-fields">${ruleFields(r, i)}</div></div>`)).join('');
    const v = st.validation;
    const errs = v ? (v.errors || []).map((w) => `<div class="gr-err">${esc(w)}</div>`).join('') : '';
    const warn = (v ? v.warnings || [] : st.warnings || []).map((w) => `<div class="gr-warn">${esc(w)}</div>`).join('');
    const add = `<label class="gr-field">Add a rule <select data-gr="rule-add" aria-label="Add a rule"><option value="">Choose…</option>${Object.entries(RULE_KINDS).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join('')}</select></label>`;
    const save = st.draftDirty ? `<div class="gr-acts"><button type="button" class="gr-send" data-gr="rules-save" ${v && !v.ok ? 'disabled' : ''}>Save rules</button><button type="button" data-gr="rules-reset">Discard</button></div>` : '';
    const tr = st.testResult;
    const nameOf = (pid) => { const m = (d.members || []).find((x) => x.pid === pid); return m ? m.name : pid; };
    const test = `<div class="gr-test"><label for="gr-test-in">Test a message</label><input id="gr-test-in" class="gr-test-input" type="text" value="${esc(st.testText || '')}" placeholder="e.g. @Writer draft the intro" aria-label="Test a message">${tr ? (tr.error ? `<div class="gr-err">${esc(tr.error)}</div>` : `<div class="gr-test-out" role="status">${(tr.wake || []).length ? `Wakes ${(tr.wake || []).map((w) => esc(nameOf(w.pid))).join(', ')}` : 'Wakes nobody'} · about ${esc(tr.estTokens || 0)} tokens${(tr.skip || []).length ? `<div class="gr-sub">${(tr.skip || []).map((x) => `${esc(nameOf(x.pid))}: ${esc(x.reason || '')}`).join('<br>')}</div>` : ''}</div>`) : ''}</div>`;
    const ctx = st.groupCtx;
    const policy = (ctx && ctx.policy) || (g.settings && g.settings.aiContext) || 'user';
    const ctxRows = ctx ? (ctx.items || []).map((it) => { const c = it.context || {}; return `<div class="gr-ctx-row" data-item-id="${esc(it.id)}"><span class="gr-name">${esc(it.title)}</span><span class="gr-sub">${esc(it.kind)}${c.actor && c.actor !== 'default' && c.actor !== 'user' ? ` · AI set it: ${esc(c.reason)}` : ''}</span><select data-gr="ctx-state" data-v="${esc(it.id)}" aria-label="AI uses ${esc(it.title)}"><option value="in" ${c.state === 'in' ? 'selected' : ''}>Used</option><option value="out" ${c.state === 'out' ? 'selected' : ''}>Not used</option><option value="auto" ${c.state === 'auto' ? 'selected' : ''}>Automatic</option></select><label class="gr-field"><input type="checkbox" data-gr="ctx-lock" data-v="${esc(it.id)}" data-state="${esc(c.state)}" ${c.locked ? 'checked' : ''}> Only I decide</label></div>`; }).join('') || '<p class="gr-sub">Nothing is shared with this group yet.</p>' : '';
    const aiCtx = `<div class="gr-ai"><label class="gr-field">What the AI uses is decided by <select data-gr="ai-context" aria-label="Who decides what the AI uses"><option value="user" ${policy !== 'model' ? 'selected' : ''}>Me</option><option value="model" ${policy === 'model' ? 'selected' : ''}>The group's AI (logged, with reasons)</option></select></label>${ctxRows}</div>`;
    const hist = (st.rulesHistory || []).map((h) => `<li>${esc(new Date(h.at).toLocaleString())}: ${esc(h.action === 'rules.preset' ? `preset ${h.detail.preset}` : h.action === 'settings.aiContext' ? `AI context: ${h.detail.aiContext}` : `rules saved (${(h.detail.rules || []).length})`)}</li>`).join('') || '<li class="gr-sub">No changes yet.</li>';
    const scopeBar = st.ruleScope ? `<div class="gr-scope-bar" role="status">Rules for ${esc(scopeName)} <button type="button" class="gr-mini" data-gr="rule-scope-all">All rules</button></div>` : '';
    return `${scopeBar}<div class="gr-presets">${presets}${g.preset === 'custom' ? '<span class="gr-preset gr-on">Custom</span>' : ''}</div>${errs}${warn}<div class="gr-rules">${rows}</div>${add}${save}${test}<p class="gr-sub">Order: blocks (left, suspended, muted, paused) → your mentions, replies and direct messages → agents' mentions (chain depth, cooldown) → rules → caps. Your own mentions always wake.</p><p class="gr-sub">Tokens today: ${esc(d.tokensToday || 0)}</p><h4>Shared context</h4>${aiCtx}<h4>History</h4><ul class="gr-hist">${hist}</ul>${st.delPolicies && typeof window !== 'undefined' && window.__wsBulk ? window.__wsBulk.deleteLineHtml(`group:${g.id}`, st.delPolicies) : ''}`;
  }

  function groupView() {
    const d = st.detail || {};
    const g = st.group || {};
    const tabs = ['chat', 'members', 'rules'].map((t) => `<button type="button" class="gr-tab${st.tab === t ? ' gr-on' : ''}" data-gr="tab" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
    const stateBar = g.state && g.state !== 'active'
      ? `<div class="gr-banner">#${esc(g.name)} is ${esc(g.state)}${g.settings && g.settings.pausedReason === 'below_three' ? ': it needs three active agents' : ''}. <button type="button" data-gr="state" data-v="${g.state === 'archived' ? 'unarchive' : g.state === 'trashed' ? 'restore' : 'resume'}">${g.state === 'archived' ? 'Unarchive' : g.state === 'trashed' ? 'Restore' : 'Resume'}</button></div>`
      : '';
    const silence = d.silence && d.silence.messageId ? `<div class="gr-banner">No one has answered yet. <button type="button" data-gr="nudge" data-v="${esc(d.silence.messageId)}">Dismiss</button></div>` : '';
    const pins = (d.pins || []).length ? `<div class="gr-pins">📌 ${(d.pins || []).map((p) => esc(p.text || '')).join(' · ')}</div>` : '';
    let body = '';
    if (st.tab === 'members') body = membersTab(d);
    else if (st.tab === 'rules') body = rulesTab(d);
    else body = `${pins}${st.messages.length ? st.messages.map(messageRow).join('') : '<p class="gr-empty">No messages yet. Mention an agent with @name to wake it.</p>'}`;
    const why = st.why ? `<div class="gr-why" role="dialog" aria-label="Who was woken"><h3>Who was woken</h3>${st.why.rows.map((r) => `<div class="gr-why-row gr-d-${esc(r.decision)}">${esc(r.text)}</div>`).join('') || '<p class="gr-empty">No record for this message.</p>'}<button type="button" class="gr-btn" data-gr="why-close">Close</button></div>` : '';
    const confirm = st.confirm ? `<div class="gr-why" role="dialog"><p>This wakes ${esc(st.confirm.agents)} agents (about ${esc(st.confirm.estTokens)} tokens).</p><button type="button" class="gr-btn gr-primary" data-gr="send-anyway">Send</button><button type="button" class="gr-btn" data-gr="cancel-confirm">Cancel</button></div>` : '';
    const reply = st.replyTo ? `<div class="gr-replying">Replying to ${esc(st.replyTo)} <button type="button" data-gr="reply-clear" aria-label="Cancel reply">×</button></div>` : '';
    const composer = st.tab === 'chat' ? `<footer class="gr-compose">${reply}<div class="gr-preview-slot">${previewHtml()}</div><div class="gr-row2"><textarea class="gr-input" rows="1" placeholder="Message #${esc(g.name)}" aria-label="Message"></textarea><button type="button" class="gr-btn gr-primary" data-gr="send">Send</button></div></footer>` : '';
    return `<header class="gr-head"><button type="button" class="gr-x" data-gr="back" aria-label="Back">‹</button><h2>#${esc(g.name)}</h2><span class="gr-sub">${esc(g.presetLabel || '')}</span><button type="button" class="gr-x" data-gr="close" aria-label="Close">×</button></header><nav class="gr-tabs">${tabs}</nav>${stateBar}${silence}<div class="gr-body">${body}</div>${composer}${why}${confirm}`;
  }

  function paint() {
    if (!st.root || !st.open) return;
    const keep = draft();
    const err = st.error ? `<div class="gr-err" role="alert">${esc(st.error)}</div>` : '';
    st.root.innerHTML = (st.view === 'create' ? createView() : st.view === 'group' ? groupView() : listView()) + err;
    const box = st.root.querySelector('.gr-input');
    if (box && keep) box.value = keep;
    const body = st.root.querySelector('.gr-body');
    if (body && st.view === 'group' && st.tab === 'chat') body.scrollTop = body.scrollHeight;
  }

  /** A "Groups" chip in the composer, next to the context chip. */
  function attachChip() {
    for (const start of document.querySelectorAll('.aui-composer-root .aui-composer-action-start')) {
      if (start.querySelector('.gr-toggle')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gr-toggle';
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-label', 'Open groups');
      b.innerHTML = '<span>Groups</span>';
      b.addEventListener('click', (e) => { e.stopPropagation(); open(); });
      start.appendChild(b);
    }
  }

  /** Engine events about groups refresh the open group. */
  function onEvent(type, p) {
    if (!st.open || !st.group) return;
    if (type && String(type).startsWith('group.') && (!p || !p.group || p.group === st.group.id)) openGroup(st.group.id);
  }

  function install(app) {
    try {
      if (!send()) return;
      ensureRoot();
      attachChip();
      if (typeof MutationObserver !== 'undefined' && document.body && !document._grObs) {
        document._grObs = true;
        new MutationObserver(() => attachChip()).observe(document.body, { childList: true, subtree: true });
      }
      const runtime = (app && app.chat) || app;
      if (runtime && typeof runtime._onEvent === 'function' && !runtime._grWrapped) {
        const base = runtime._onEvent.bind(runtime);
        runtime._grWrapped = true;
        runtime._onEvent = (event) => {
          const type = event && (event.eventType || event.type || event.name);
          if (typeof type === 'string' && type.startsWith('group.')) { try { onEvent(type, parse(event.payloadJson ?? event.payload, null)); } catch (e) { /* keep the chat going */ } }
          return base(event);
        };
      }
    } catch (e) { console.warn('groups', e); }
  }

  const api = { install, open, close, openGroup, _state: st };
  if (typeof window !== 'undefined') {
    window.__groups = api;
    // Self-installing like the context tree; a no-op without the engine.
    const boot = () => { try { install(window.__app || window.__runtime || window.__agentRuntime || null); } catch (e) { console.warn('groups boot', e); } };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
  return api;
})();
