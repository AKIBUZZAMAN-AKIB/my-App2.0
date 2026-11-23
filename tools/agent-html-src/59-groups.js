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
      await openGroup(st.group.id);
      if (action.startsWith('rules') || action.startsWith('members')) st.tab = action.startsWith('rules') ? 'rules' : 'members';
      paint();
    } catch (e) { fail(e); }
  }

  async function toggleRule(id) {
    const rules = (st.detail.rules || []).map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
    try {
      const r = await call('groups.rules.set', { group: st.group.id, rules });
      if (!r.saved) { st.error = ((r.validation && r.validation.errors) || []).join(' '); return paint(); }
      st.warnings = (r.validation && r.validation.warnings) || [];
      await openGroup(st.group.id);
      st.tab = 'rules';
      paint();
    } catch (e) { fail(e); }
  }

  function onInput(e) {
    if (e.target.classList.contains('gr-new-name')) st.newName = e.target.value;
    if (e.target.classList.contains('gr-new-purpose')) st.newPurpose = e.target.value;
    if (e.target.classList.contains('gr-input')) schedulePreview();
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
    if (a === 'tab') { st.tab = v; return paint(); }
    if (a === 'preset') return groupOp('groups.rules.preset', { preset: v });
    if (a === 'rule-toggle') return toggleRule(v);
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
    return (d.members || []).filter((m) => m.pid !== 'user').map((m) => `<div class="gr-member">${presenceDot(m.presence)}<span class="gr-name">${esc(m.name)}</span><span class="gr-sub">${esc(m.role)}${m.crossChat ? ' · from another chat' : ''}${m.suspendedText ? ' · suspended: ' + esc(m.suspendedText) : ''}${m.engaged ? ' · in the conversation' : ''}${m.rules && m.rules.length ? ' · rules: ' + esc(m.rules.join(', ')) : ''}</span>${m.membership === 'left' ? '' : `${m.mutedUntil && m.mutedUntil > Date.now() ? `<button type="button" data-gr="unmute" data-v="${esc(m.pid)}">Unmute</button>` : `<button type="button" data-gr="mute" data-v="${esc(m.pid)}">Mute 1 h</button>`}<button type="button" data-gr="remove" data-v="${esc(m.pid)}">Remove</button>`}</div>`).join('');
  }

  function rulesTab(d) {
    const g = d.group || {};
    const presets = PRESETS.map(([k, l, desc]) => `<button type="button" class="gr-preset${g.preset === k ? ' gr-on' : ''}" data-gr="preset" data-v="${k}" title="${esc(desc)}">${esc(l)}</button>`).join('');
    const rules = (d.rules || []).map((r) => `<div class="gr-rule${r.enabled ? '' : ' gr-off'}"><label><input type="checkbox" data-gr="rule-toggle" data-v="${esc(r.id)}" ${r.enabled ? 'checked' : ''}> ${esc(r.kind.replace(/_/g, ' '))}</label><span class="gr-sub">${esc(r.scope === 'group' ? 'whole group' : r.scope)} · ${esc(JSON.stringify(r.params))}</span></div>`).join('');
    const warn = (st.warnings || []).map((w) => `<div class="gr-warn">${esc(w)}</div>`).join('');
    return `<div class="gr-presets">${presets}${g.preset === 'custom' ? '<span class="gr-preset gr-on">Custom</span>' : ''}</div>${warn}${rules}<p class="gr-sub">Order: blocks (left, suspended, muted, paused) → your mentions, replies and direct messages → agents' mentions (chain depth, cooldown) → rules → caps. Your own mentions always wake.</p><p class="gr-sub">Tokens today: ${esc(d.tokensToday || 0)}</p>`;
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
