/* Workspace bulk actions, permissions, context use, Trash and delete
 * settings (plan.md, Phase 5). Everything shown comes from the engine's
 * `items.*` answers over the subagents channel; nothing is invented.
 *
 * - Items: every registry item by section, each row `data-item-id`. "Select"
 *   adds a checkbox to every row and a sticky action bar: Move to…, Share
 *   with…, Remove, Delete, Permissions, Use in context. The bar shows the
 *   selection count. Every bulk action runs `items.bulk`, all or nothing.
 * - Delete always shows the engine's dry run first: Trash with its removal
 *   date, or permanent, with a per-action override.
 * - Target picker: tabs Sub-agents / Groups / Sessions; sessions multi-select.
 * - Edit text in place (items.edit) for memory, notes and workspace files.
 * - Permissions editor per item: owner, holders with mode and permission,
 *   Revoke, history from `ws_audit`; main memory adds the read-only rows its
 *   memory modes imply and its pin status.
 * - Trash: removal date or "until you empty it", Restore, Delete now, Empty
 *   Trash (with count), filters by kind and origin.
 * - Deleting (settings): global mode and retention, per-kind overrides,
 *   per-holder overrides; "When I delete from here" lines for any holder.
 * Keyboard: every control is a button, checkbox or select; Escape closes. */
const WorkspaceBulk = (() => {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return d; } };
  const SECTIONS = [['chats', 'Chats'], ['subagents', 'Sub-agents'], ['groups', 'Groups'], ['memory', 'Memory'], ['notes', 'Notes'], ['files', 'Files'], ['messages', 'Messages']];
  const KINDS = [['chat', 'Chats'], ['message', 'Messages'], ['memory', 'Memory'], ['memory_longterm', 'Main memory'], ['file', 'Files'], ['subagent', 'Agents'], ['group', 'Groups'], ['note', 'Notes']];
  const PERMS = [['view', 'View'], ['use', 'Use'], ['edit', 'Edit'], ['manage', 'Manage']];
  const MODES = [['reference', 'Reference'], ['mount', 'Mount']];
  const DAY = 86400;
  const RETAIN = [[DAY, '1 day'], [7 * DAY, '7 days'], [30 * DAY, '30 days'], [90 * DAY, '90 days'], ['', 'Until I empty it']];
  const st = {
    root: null, open: false, view: 'items', items: {}, selecting: false, picked: new Set(), error: '', note: '',
    picker: null, confirm: null, perms: null, edit: null, trash: null, trashKind: '', trashOrigin: '', policies: null, ctx: null, busy: false,
  };

  let appRef = null;
  const activeKey = () => (appRef && appRef.chat && appRef.chat.mainId) || '';
  function send() {
    if (typeof window !== 'undefined' && typeof window.__wsBulkBridge === 'function') return (a, e) => window.__wsBulkBridge(a, e || {});
    try {
      const kit = typeof nativeKit === 'function' ? nativeKit() : (typeof window !== 'undefined' ? window.NativeKit : null);
      if (kit && kit.agent && typeof kit.agent.subagents === 'function') {
        return async (action, extra) => {
          const r = await kit.agent.subagents({ action, sessionKey: activeKey(), ...(extra || {}) });
          if (r && typeof r.resultJson === 'string') return parse(r.resultJson, {});
          if (r && typeof r.json === 'string') return parse(r.json, {});
          return parse(r, {});
        };
      }
    } catch (e) { /* no engine */ }
    return null;
  }
  async function call(action, extra) {
    const s = send();
    if (!s) throw new Error('The engine is not available.');
    const r = await s(action, extra);
    if (r && r.error) throw new Error(r.error);
    return r;
  }
  const fail = (e) => { st.error = String((e && e.message) || e); st.busy = false; paint(); };
  const when = (ms) => { if (ms == null) return 'until you empty it'; try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return String(ms); } };
  const retainText = (secs) => { if (secs == null) return 'until I empty it'; const d = Math.round(secs / DAY); return d === 1 ? '1 day' : `${d} days`; };
  const policyText = (p) => (!p ? '' : p.mode === 'direct' ? 'Delete permanently' : `Trash, ${retainText(p.retainSecs)}`);
  const allItems = () => Object.values(st.items).flat();
  const byId = (id) => allItems().find((i) => i.id === id);

  function ensureRoot() {
    if (st.root || typeof document === 'undefined') return st.root;
    const r = document.createElement('section');
    r.className = 'wb-panel';
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-label', 'Workspace');
    r.hidden = true;
    r.addEventListener('click', onClick);
    r.addEventListener('change', onChange);
    r.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (st.confirm || st.picker) { st.confirm = null; st.picker = null; paint(); } else close(); } });
    document.body.appendChild(r);
    st.root = r;
    return r;
  }

  async function loadItems() {
    const t = await call('items.tree', { all: true });
    const sec = (t && t.sections) || {};
    st.items = {};
    for (const [k] of SECTIONS) {
      const v = sec[k];
      st.items[k] = Array.isArray(v) ? v : (v && v.items) || [];
    }
  }

  async function open(view) {
    ensureRoot();
    if (!st.root) return;
    st.open = true;
    st.view = view || st.view || 'items';
    st.root.hidden = false;
    st.error = '';
    await refresh();
    const f = st.root.querySelector('button, input, select');
    if (f) f.focus();
  }
  function close() { st.open = false; st.picker = null; st.confirm = null; if (st.root) st.root.hidden = true; }

  async function refresh() {
    try {
      if (st.view === 'items') await loadItems();
      if (st.view === 'trash') await loadTrash();
      if (st.view === 'deleting') await loadPolicies();
      if (st.view === 'perms' && st.perms) await loadPerms(st.perms.id);
      st.error = '';
    } catch (e) { st.error = String(e.message || e); }
    paint();
  }

  // ------------------------------------------------------------ selection
  function toggleSelect(on) { st.selecting = on == null ? !st.selecting : on; if (!st.selecting) st.picked.clear(); paint(); }
  function togglePick(id) { if (st.picked.has(id)) st.picked.delete(id); else st.picked.add(id); paint(); }

  // ------------------------------------------------------------ target picker
  async function openPicker(op) {
    try {
      const p = await call('principals.list', {});
      const rows = (p && p.principals) || [];
      const tabs = {
        subagents: rows.filter((r) => r.pid.startsWith('agent:') && r.pid !== 'agent:main' && r.state !== 'gone'),
        groups: rows.filter((r) => r.pid.startsWith('group:') && r.state !== 'gone'),
        sessions: rows.filter((r) => r.pid.startsWith('session:')),
      };
      st.picker = { op, tab: op === 'context' ? 'groups' : 'subagents', tabs, chosen: new Set(), perm: 'view', mode: 'reference', state: 'in' };
      paint();
    } catch (e) { fail(e); }
  }
  function pickTarget(pid) {
    const p = st.picker;
    const multi = p.tab === 'sessions' || p.op === 'share' || p.op === 'unshare';
    if (!multi) p.chosen.clear();
    if (p.chosen.has(pid)) p.chosen.delete(pid); else p.chosen.add(pid);
    paint();
  }

  async function runPicker() {
    const p = st.picker;
    const targets = [...p.chosen];
    if (!targets.length) { st.error = 'Choose a sub-agent, group or chat first.'; return paint(); }
    if (p.op === 'context') return setContext(targets[0], p.state);
    const op = p.op === 'perm' ? 'setPerm' : p.op;
    const body = { ids: [...st.picked], op, targets, perm: p.perm, mode: p.mode };
    // Moves and shares preview too, so a blocked item shows before anything changes.
    return preview(body);
  }

  async function setContext(holder, state) {
    try {
      await call('items.contextUse.set', { holder, ids: [...st.picked], state });
      st.note = `${st.picked.size} item${st.picked.size === 1 ? '' : 's'} set to ${state === 'in' ? 'used' : state === 'out' ? 'not used' : 'automatic'} for ${holder}.`;
      st.picker = null;
      await refresh();
    } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------ dry run + commit
  async function preview(body) {
    try {
      st.busy = true;
      const dry = await call('items.bulk', { ...body, dryRun: true });
      st.busy = false;
      st.picker = null;
      st.confirm = { body, dry };
      paint();
    } catch (e) { fail(e); }
  }
  async function commit() {
    const c = st.confirm;
    if (!c || !c.dry || !c.dry.ok) return;
    try {
      st.busy = true;
      const r = await call('items.bulk', { ...c.body, dryRun: false });
      st.busy = false;
      st.confirm = null;
      st.note = r.summary || 'Done.';
      if (c.body.op === 'delete' || c.body.op === 'move') st.picked.clear();
      await refresh();
    } catch (e) { st.confirm = null; fail(e); }
  }
  function deleteSelected(override) {
    const body = { ids: [...st.picked], op: 'delete' };
    if (override) body.policy = override;
    return preview(body);
  }

  // ------------------------------------------------------------ permissions
  async function loadPerms(id) {
    const [h, a] = await Promise.all([call('items.holders', { itemId: id }), call('items.audit', { itemId: id })]);
    const it = byId(id) || (st.perms && st.perms.item) || { id };
    st.perms = { id, item: it, refs: h.refs || [], implicit: h.implicit || [], pinned: h.pinned, audit: (a && (a.rows || a.audit || a.items)) || [] };
  }
  async function openPerms(id) {
    try { st.view = 'perms'; await loadPerms(id); st.error = ''; paint(); } catch (e) { fail(e); }
  }
  // ------------------------------------------------------------ edit in place
  // One copy, so an edit is seen by every holder at once (items.edit, plan.md
  // Phase 4). The engine checks the edit permission and the text limits.
  const EDITABLE = ['memory_longterm', 'agent_memory', 'note'];
  const canEdit = (it) => !!it && (EDITABLE.includes(it.kind) || (it.kind === 'file' && String(it.loc || '').startsWith('fs:workspace/'))) && (!it.ref || ['edit', 'manage'].includes(it.ref.perm)) && (!it.state || it.state === 'live');
  async function startEdit(id) {
    try {
      st.edit = { id, text: '', loading: true };
      paint();
      const r = await call('items.read', { id, limit: 20000 });
      const text = (r && (typeof r.text === 'string' ? r.text : r.content && typeof r.content.text === 'string' ? r.content.text : '')) || '';
      st.edit = { id, text, original: text, loading: false };
      st.error = '';
      paint();
    } catch (e) { st.edit = null; fail(e); }
  }
  async function saveEdit() {
    const ed = st.edit;
    if (!ed || ed.loading) return;
    const box = st.root.querySelector('.wb-edit-text');
    const text = box ? box.value : ed.text;
    if (!text.trim()) { st.error = 'The text is empty.'; return paint(); }
    try {
      st.edit = { ...ed, text, saving: true };
      await call('items.edit', { id: ed.id, text, via: 'workspace' });
      st.edit = null;
      st.note = 'Saved. Everyone it is shared with sees the new text.';
      st.error = '';
      await loadPerms(ed.id);
      paint();
    } catch (e) { st.edit = { ...ed, text, saving: false }; fail(e); }
  }
  async function refOp(action, extra) {
    try { await call(action, extra); await loadPerms(st.perms.id); st.error = ''; paint(); } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------ Trash
  async function loadTrash() {
    const t = await call('items.trashList', {});
    st.trash = (t && t.items) || [];
  }
  async function trashOp(action, extra, msg) {
    try { await call(action, extra); st.note = msg || ''; await loadTrash(); st.error = ''; paint(); } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------ Deleting settings
  async function loadPolicies() {
    const p = await call('items.policy.get', {});
    st.policies = (p && p.policies) || [];
  }
  const policyOf = (scope) => (st.policies || []).find((p) => p.scope === scope) || null;
  async function setPolicy(scope, mode, retain, confirm) {
    const apply = !!(st.root && st.root.querySelector('.wb-apply-existing') && st.root.querySelector('.wb-apply-existing').checked);
    try {
      const r = await call('items.policy.set', { scope, mode, retainSecs: retain === '' || retain == null ? null : Number(retain), applyToExisting: apply, confirm: !!confirm });
      if (r && r.needsConfirm) {
        st.confirm = { policy: { scope, mode, retain }, due: r.due, moved: r.moved, message: r.message };
        return paint();
      }
      st.confirm = null;
      st.note = `Saved: ${policyText(r.policy)}${r.moved ? ` · ${r.moved} in Trash re-dated` : ''}${r.purged ? ` · ${r.purged} removed` : ''}.`;
      await loadPolicies();
      paint();
    } catch (e) { fail(e); }
  }
  async function clearPolicy(scope) {
    try { await call('items.policy.clear', { scope }); await loadPolicies(); paint(); } catch (e) { fail(e); }
  }

  /** The "When I delete from here" line for any holder's settings sheet. */
  function deleteLineHtml(holder, policies) {
    const list = policies || st.policies || [];
    const own = list.find((p) => p.scope === `holder:${holder}`);
    const sel = (v) => (own ? (own.mode === 'direct' ? 'direct' : String(own.retainSecs == null ? '' : own.retainSecs)) : 'inherit') === v ? 'selected' : '';
    return `<label class="wb-delete-line" data-holder="${esc(holder)}">When I delete from here <select class="wb-holder-policy" data-holder="${esc(holder)}" aria-label="When I delete from here"><option value="inherit" ${sel('inherit')}>Use my default</option>${RETAIN.map(([v, l]) => `<option value="${v}" ${sel(String(v))}>Trash, ${esc(l.toLowerCase())}</option>`).join('')}<option value="direct" ${sel('direct')}>Delete permanently</option></select></label>`;
  }
  async function setHolderPolicy(holder, v) {
    if (v === 'inherit') return clearPolicy(`holder:${holder}`);
    if (v === 'direct') return setPolicy(`holder:${holder}`, 'direct', null);
    return setPolicy(`holder:${holder}`, 'timed', v);
  }

  // ------------------------------------------------------------ events
  function onChange(e) {
    const t = e.target;
    if (t.matches('[data-wb="pick"]')) return togglePick(t.getAttribute('data-v'));
    if (t.matches('[data-wb="target"]')) return pickTarget(t.getAttribute('data-v'));
    if (t.matches('.wb-perm-sel') && st.picker) { st.picker.perm = t.value; return; }
    if (t.matches('.wb-mode-sel') && st.picker) { st.picker.mode = t.value; return; }
    if (t.matches('.wb-ctx-sel') && st.picker) { st.picker.state = t.value; return; }
    if (t.matches('.wb-ref-perm')) return refOp('items.setPerm', { refId: t.getAttribute('data-ref'), perm: t.value });
    if (t.matches('.wb-ref-mode')) return refOp('items.setMode', { refId: t.getAttribute('data-ref'), mode: t.value });
    if (t.matches('.wb-override')) {
      const v = t.value;
      const o = v === 'policy' ? null : v === 'direct' ? { mode: 'direct' } : { mode: 'timed', retainSecs: v === 'forever' ? null : Number(v) };
      return deleteSelected(o);
    }
    if (t.matches('.wb-global-mode') || t.matches('.wb-global-retain')) {
      const mode = st.root.querySelector('.wb-global-mode').value;
      const retain = st.root.querySelector('.wb-global-retain').value;
      return setPolicy('global', mode, mode === 'direct' ? null : retain);
    }
    if (t.matches('.wb-kind-policy')) {
      const scope = `kind:${t.getAttribute('data-kind')}`;
      if (t.value === 'inherit') return clearPolicy(scope);
      if (t.value === 'direct') return setPolicy(scope, 'direct', null);
      return setPolicy(scope, 'timed', t.value);
    }
    if (t.matches('.wb-holder-policy')) return setHolderPolicy(t.getAttribute('data-holder'), t.value);
    if (t.matches('.wb-trash-kind')) { st.trashKind = t.value; return paint(); }
    if (t.matches('.wb-trash-origin')) { st.trashOrigin = t.value; return paint(); }
  }

  function onClick(e) {
    const t = e.target.closest('[data-wb]');
    if (!t || t.matches('input[type=checkbox], select')) return;
    const a = t.getAttribute('data-wb');
    const v = t.getAttribute('data-v') || '';
    st.note = a === 'tab' || a === 'go' ? '' : st.note;
    if (a === 'close') return close();
    if (a === 'go') { st.edit = null; st.view = v; st.confirm = null; st.picker = null; return refresh(); }
    if (a === 'select') return toggleSelect();
    if (a === 'clear') { st.picked.clear(); return paint(); }
    if (a === 'move' || a === 'share' || a === 'unshare' || a === 'context' || a === 'perm') return openPicker(a);
    if (a === 'delete') return deleteSelected(null);
    if (a === 'permissions') { const id = v || [...st.picked][0]; if (id) return openPerms(id); return; }
    if (a === 'tab' && st.picker) { st.picker.tab = v; return paint(); }
    if (a === 'picker-cancel') { st.picker = null; return paint(); }
    if (a === 'picker-go') return runPicker();
    if (a === 'confirm-cancel') { st.confirm = null; return paint(); }
    if (a === 'confirm-go') return st.confirm && st.confirm.policy ? setPolicy(st.confirm.policy.scope, st.confirm.policy.mode, st.confirm.policy.retain, true) : commit();
    if (a === 'edit') return startEdit(v);
    if (a === 'edit-cancel') { st.edit = null; return paint(); }
    if (a === 'edit-save') return saveEdit();
    if (a === 'revoke') return refOp('items.revoke', { refId: v });
    if (a === 'restore') return trashOp('items.restore', { id: v }, 'Restored.');
    if (a === 'purge') return trashOp('items.purge', { id: v }, 'Removed permanently.');
    if (a === 'empty') return trashOp('items.emptyTrash', {}, 'Trash emptied.');
    if (a === 'clear-policy') return clearPolicy(v);
  }

  // ------------------------------------------------------------ views
  function nav() {
    const tab = (k, l) => `<button type="button" class="wb-tab${st.view === k ? ' wb-on' : ''}" data-wb="go" data-v="${k}" aria-pressed="${st.view === k}">${l}</button>`;
    return `<nav class="wb-nav">${tab('items', 'Items')}${tab('trash', 'Trash')}${tab('deleting', 'Deleting')}</nav>`;
  }

  function itemRow(it) {
    const box = st.selecting ? `<input type="checkbox" data-wb="pick" data-v="${esc(it.id)}" aria-label="Select ${esc(it.title)}" ${st.picked.has(it.id) ? 'checked' : ''}>` : '';
    const ref = it.ref ? ` · shared, ${esc(it.ref.perm)}` : '';
    const ctx = it.context ? ` · AI: ${esc(it.context.state)}` : '';
    return `<div class="wb-row" data-item-id="${esc(it.id)}">${box}<span class="wb-title">${esc(it.title || it.id)}</span><span class="wb-sub">${esc(it.kind)}${it.state && it.state !== 'live' ? ' · ' + esc(it.state) : ''}${ref}${ctx}</span><button type="button" class="wb-mini" data-wb="permissions" data-v="${esc(it.id)}" aria-label="Permissions for ${esc(it.title)}">Permissions</button></div>`;
  }

  function itemsView() {
    const secs = SECTIONS.map(([k, l]) => {
      const rows = st.items[k] || [];
      if (!rows.length) return '';
      return `<h3 class="wb-h" data-ws-section="${k}">${esc(l)} <span class="wb-sub">${rows.length}</span></h3>${rows.map(itemRow).join('')}`;
    }).join('') || '<p class="wb-empty">Nothing in the workspace yet.</p>';
    const n = st.picked.size;
    const dis = n ? '' : 'disabled';
    const bar = st.selecting ? `<div class="wb-bar" role="toolbar" aria-label="Selected items"><span class="wb-count">${n} selected</span><button type="button" data-wb="move" ${dis}>Move to…</button><button type="button" data-wb="share" ${dis}>Share with…</button><button type="button" data-wb="unshare" ${dis}>Remove</button><button type="button" data-wb="delete" class="wb-danger" ${dis}>Delete</button><button type="button" data-wb="perm" ${dis}>Permissions</button><button type="button" data-wb="context" ${dis}>Use in context</button></div>` : '';
    return `<div class="wb-tools"><button type="button" class="wb-btn" data-wb="select" aria-pressed="${st.selecting}">${st.selecting ? 'Done' : 'Select'}</button>${st.selecting && n ? '<button type="button" class="wb-btn" data-wb="clear">Clear</button>' : ''}</div><div class="wb-list">${secs}</div>${bar}`;
  }

  function pickerHtml() {
    const p = st.picker;
    if (!p) return '';
    const TITLES = { move: 'Move to', share: 'Share with', unshare: 'Remove from', context: 'Use in context for', perm: 'Change permission for' };
    const tabs = [['subagents', 'Sub-agents'], ['groups', 'Groups'], ['sessions', 'Sessions']].map(([k, l]) => `<button type="button" class="wb-tab${p.tab === k ? ' wb-on' : ''}" data-wb="tab" data-v="${k}" aria-pressed="${p.tab === k}">${l}</button>`).join('');
    const multi = p.tab === 'sessions' || p.op === 'share' || p.op === 'unshare';
    const rows = (p.tabs[p.tab] || []).map((r) => `<label class="wb-pick"><input type="${multi ? 'checkbox' : 'radio'}" name="wb-target" data-wb="target" data-v="${esc(r.pid)}" ${p.chosen.has(r.pid) ? 'checked' : ''}> ${esc(r.name || r.pid)}</label>`).join('') || '<p class="wb-empty">None yet.</p>';
    const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
    let extra = '';
    if (p.op === 'share') extra = `<label>Mode <select class="wb-mode-sel">${opts(MODES, p.mode)}</select></label><label>Permission <select class="wb-perm-sel">${opts(PERMS, p.perm)}</select></label>`;
    if (p.op === 'perm') extra = `<label>Permission <select class="wb-perm-sel">${opts(PERMS, p.perm)}</select></label>`;
    if (p.op === 'context') extra = `<label>The AI <select class="wb-ctx-sel">${opts([['in', 'uses these'], ['out', 'does not use these'], ['auto', 'decides under budget']], p.state)}</select></label>`;
    const note = p.op === 'move' ? '<p class="wb-sub wb-move-note">Memory, notes and files change owner. A whole chat moves in as a reference. A single message is never moved out of its chat: it is shared as a reference and hidden here.</p>' : '';
    return `<div class="wb-sheet" role="dialog" aria-label="${esc(TITLES[p.op])}"><h3>${esc(TITLES[p.op])} (${st.picked.size} item${st.picked.size === 1 ? '' : 's'})</h3><nav class="wb-nav">${tabs}</nav><div class="wb-targets">${rows}</div>${extra}${note}<div class="wb-acts"><button type="button" class="wb-btn wb-primary" data-wb="picker-go">Continue</button><button type="button" class="wb-btn" data-wb="picker-cancel">Cancel</button></div></div>`;
  }

  function confirmHtml() {
    const c = st.confirm;
    if (!c) return '';
    if (c.policy) {
      return `<div class="wb-sheet wb-confirm" role="alertdialog" aria-label="Confirm"><p>${esc(c.message || '')}</p><p class="wb-sub">${esc(c.due)} item${c.due === 1 ? '' : 's'} in Trash ${c.due === 1 ? 'is' : 'are'} due and will be removed permanently now${c.moved ? `; ${esc(c.moved)} will get a new removal date` : ''}.</p><div class="wb-acts"><button type="button" class="wb-btn wb-danger" data-wb="confirm-go">Remove ${esc(c.due)} now</button><button type="button" class="wb-btn" data-wb="confirm-cancel">Cancel</button></div></div>`;
    }
    const d = c.dry || {};
    const rows = (d.results || []).map((r) => {
      let what = r.action;
      if (r.action === 'delete') what = r.permanent ? 'removed permanently' : `to Trash, removed ${when(r.purgeAfter)}`;
      if (r.action === 'detach') what = 'detached: kept for the holders it is shared with';
      if (r.action === 'move') what = r.as === 'owner' ? 'changes owner' : r.as === 'reference' ? 'moves in as a reference' : 'shared as a reference, hidden here';
      return `<li data-item-id="${esc(r.id)}">${esc(r.title || r.id)}: <span class="wb-sub">${esc(what)}</span></li>`;
    }).join('');
    const blocked = (d.blocked || []).map((b) => `<li class="wb-blocked" data-item-id="${esc(b.id)}">${esc(b.title || b.id)}: ${esc(b.reason)}</li>`).join('');
    const isDelete = c.body.op === 'delete';
    const perm = (d.counts && d.counts.permanent) || 0;
    const ov = c.body.policy;
    const ovVal = !ov ? 'policy' : ov.mode === 'direct' ? 'direct' : ov.retainSecs == null ? 'forever' : String(ov.retainSecs);
    const override = isDelete ? `<label class="wb-sub">This time <select class="wb-override" aria-label="Delete this time"><option value="policy" ${ovVal === 'policy' ? 'selected' : ''}>Use my delete settings</option><option value="${30 * DAY}" ${ovVal === String(30 * DAY) ? 'selected' : ''}>Trash for 30 days</option><option value="forever" ${ovVal === 'forever' ? 'selected' : ''}>Trash until I empty it</option><option value="direct" ${ovVal === 'direct' ? 'selected' : ''}>Delete permanently</option></select></label>` : '';
    const label = !d.ok ? '' : isDelete ? (perm ? `Delete ${esc(d.count)} (${esc(perm)} permanently)` : `Delete ${esc(d.count)}`) : 'Confirm';
    return `<div class="wb-sheet wb-confirm" role="alertdialog" aria-label="Check before it runs"><h3>${isDelete ? 'Delete' : esc(c.body.op)}: ${esc(d.count)} selected</h3><p class="wb-summary">${esc(d.summary || '')}</p><ul class="wb-dry">${rows}${blocked}</ul>${override}${d.ok ? '' : '<p class="wb-err">Nothing will change until every item can be done.</p>'}<div class="wb-acts">${d.ok ? `<button type="button" class="wb-btn ${isDelete ? 'wb-danger' : 'wb-primary'}" data-wb="confirm-go">${label}</button>` : ''}<button type="button" class="wb-btn" data-wb="confirm-cancel">Cancel</button></div></div>`;
  }

  function permsView() {
    const p = st.perms;
    if (!p) return '<p class="wb-empty">Choose an item.</p>';
    const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
    const owner = p.refs.find((r) => r.mode === 'owner');
    const rows = p.refs.filter((r) => r.mode !== 'owner').map((r) => `<div class="wb-holder" data-ref="${esc(r.id)}" data-state="${esc(r.state)}"><span class="wb-title">${esc(r.holderName || r.holder)}</span>${r.state === 'live' ? `<select class="wb-ref-mode" data-ref="${esc(r.id)}" aria-label="Mode for ${esc(r.holderName || r.holder)}">${opts(MODES, r.mode)}</select><select class="wb-ref-perm" data-ref="${esc(r.id)}" aria-label="Permission for ${esc(r.holderName || r.holder)}">${opts(PERMS, r.perm)}</select><button type="button" class="wb-mini" data-wb="revoke" data-v="${esc(r.id)}">Revoke</button>` : `<span class="wb-sub">${esc(r.state)}</span>`}</div>`).join('') || '<p class="wb-sub">Not shared with anyone.</p>';
    const implicit = p.implicit.map((r) => `<div class="wb-holder wb-implicit"><span class="wb-title">${esc(r.holderName || r.holder)}</span><span class="wb-sub">${esc(r.perm)} · ${esc(r.via)} (read-only)</span></div>`).join('');
    const pin = p.pinned == null ? '' : `<p class="wb-sub wb-pin">${p.pinned ? 'Protected from automatic removal because it is shared.' : 'Not pinned: the memory store may remove it when it is full.'}</p>`;
    const hist = (p.audit || []).slice(0, 30).map((h) => `<li>${esc(when(h.at))}: ${esc(h.actor)} ${esc(String(h.action).replace(/_/g, ' '))}${h.holder ? ' · ' + esc(h.holder) : ''}</li>`).join('') || '<li class="wb-sub">No changes yet.</li>';
    const ed = st.edit && st.edit.id === p.id ? st.edit : null;
    const editBlock = ed
      ? (ed.loading ? '<p class="wb-sub">Loading the text…</p>' : `<div class="wb-edit"><textarea class="wb-edit-text" rows="6" aria-label="Text of ${esc((p.item && p.item.title) || p.id)}">${esc(ed.text)}</textarea><div class="wb-acts"><button type="button" class="wb-btn wb-primary" data-wb="edit-save" ${ed.saving ? 'disabled' : ''}>Save</button><button type="button" class="wb-btn" data-wb="edit-cancel">Cancel</button></div></div>`)
      : canEdit(p.item) ? `<button type="button" class="wb-btn" data-wb="edit" data-v="${esc(p.id)}">Edit text</button>` : '';
    return `<div class="wb-perms" data-item-id="${esc(p.id)}"><h3>${esc((p.item && p.item.title) || p.id)}</h3><p class="wb-sub">Owner: ${esc(owner ? owner.holderName || owner.holder : (p.item && p.item.owner) || '')}</p>${pin}${editBlock}<h4>Holders</h4>${rows}${implicit}<h4>History</h4><ul class="wb-hist">${hist}</ul><button type="button" class="wb-btn" data-wb="go" data-v="items">Back to items</button></div>`;
  }

  function trashView() {
    const items = st.trash || [];
    const origins = [...new Set(items.map((i) => i.restoreOwner || i.owner).filter(Boolean))];
    const shown = items.filter((i) => (!st.trashKind || i.kind === st.trashKind) && (!st.trashOrigin || (i.restoreOwner || i.owner) === st.trashOrigin));
    const rows = shown.map((i) => `<div class="wb-row" data-item-id="${esc(i.id)}"><span class="wb-title">${esc(i.title || i.id)}</span><span class="wb-sub">${esc(i.kind)} · from ${esc(i.restoreOwner || i.owner)} · ${i.purgeAfter == null ? 'until you empty it' : 'removed ' + esc(when(i.purgeAfter))}</span><button type="button" class="wb-mini" data-wb="restore" data-v="${esc(i.id)}">Restore</button><button type="button" class="wb-mini wb-danger" data-wb="purge" data-v="${esc(i.id)}">Delete now</button></div>`).join('') || '<p class="wb-empty">Trash is empty.</p>';
    const kinds = `<select class="wb-trash-kind" aria-label="Filter by kind"><option value="">All kinds</option>${KINDS.map(([k, l]) => `<option value="${k}" ${st.trashKind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const orig = `<select class="wb-trash-origin" aria-label="Filter by origin"><option value="">Everywhere</option>${origins.map((o) => `<option value="${esc(o)}" ${st.trashOrigin === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    return `<div class="wb-tools">${kinds}${orig}<button type="button" class="wb-btn wb-danger" data-wb="empty" ${items.length ? '' : 'disabled'}>Empty Trash (${items.length})</button></div><div class="wb-list wb-trash">${rows}</div>`;
  }

  function deletingView() {
    const g = policyOf('global') || { mode: 'timed', retainSecs: 30 * DAY };
    const retainOpts = (cur) => RETAIN.map(([v, l]) => `<option value="${v}" ${String(cur == null ? '' : cur) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
    const kindRows = KINDS.map(([k, l]) => {
      const p = policyOf(`kind:${k}`);
      const cur = !p ? 'inherit' : p.mode === 'direct' ? 'direct' : String(p.retainSecs == null ? '' : p.retainSecs);
      return `<label class="wb-kind-row">${esc(l)} <select class="wb-kind-policy" data-kind="${k}" aria-label="${esc(l)}"><option value="inherit" ${cur === 'inherit' ? 'selected' : ''}>Default</option>${RETAIN.map(([v, rl]) => `<option value="${v}" ${cur === String(v) ? 'selected' : ''}>Trash, ${esc(rl.toLowerCase())}</option>`).join('')}<option value="direct" ${cur === 'direct' ? 'selected' : ''}>Delete permanently</option></select></label>`;
    }).join('');
    const holders = (st.policies || []).filter((p) => p.scope.startsWith('holder:'));
    const holderRows = holders.map((p) => `<div class="wb-row" data-scope="${esc(p.scope)}"><span class="wb-title">${esc(p.scope.slice(7))}</span><span class="wb-sub">${esc(policyText(p))}</span><button type="button" class="wb-mini" data-wb="clear-policy" data-v="${esc(p.scope)}">Use default</button></div>`).join('') || '<p class="wb-sub">No chat, agent or group has its own setting.</p>';
    return `<div class="wb-deleting"><h3>When I delete</h3><label>Mode <select class="wb-global-mode" aria-label="Delete mode"><option value="timed" ${g.mode !== 'direct' ? 'selected' : ''}>Timed: to Trash first</option><option value="direct" ${g.mode === 'direct' ? 'selected' : ''}>Direct: delete permanently</option></select></label><label>Keep in Trash <select class="wb-global-retain" aria-label="Keep in Trash" ${g.mode === 'direct' ? 'disabled' : ''}>${retainOpts(g.retainSecs)}</select></label><label class="wb-sub"><input type="checkbox" class="wb-apply-existing"> Apply to items in Trash</label><h4>By kind</h4>${kindRows}<h4>Chats, agents and groups with their own setting</h4>${holderRows}</div>`;
  }

  function paint() {
    if (!st.root || !st.open) return;
    const body = st.view === 'trash' ? trashView() : st.view === 'deleting' ? deletingView() : st.view === 'perms' ? permsView() : itemsView();
    const err = st.error ? `<div class="wb-err" role="alert">${esc(st.error)}</div>` : '';
    const note = st.note ? `<div class="wb-note" role="status">${esc(st.note)}</div>` : '';
    const focusSel = document.activeElement && st.root.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    st.root.innerHTML = `<header class="wb-head"><h2>Workspace</h2><button type="button" class="wb-x" data-wb="close" aria-label="Close">×</button></header>${nav()}${err}${note}<div class="wb-body">${body}</div>${pickerHtml()}${confirmHtml()}`;
    if (focusSel) { const el = st.root.querySelector(focusSel); if (el) el.focus(); }
    if (st.confirm || st.picker) { const f = st.root.querySelector('.wb-sheet button, .wb-sheet input, .wb-sheet select'); if (f && !(focusSel && st.root.querySelector('.wb-sheet ' + focusSel))) f.focus(); }
  }
  function focusKey(el) {
    const a = el.getAttribute('data-wb');
    const v = el.getAttribute('data-v');
    if (a) return `[data-wb="${a}"]${v ? `[data-v="${CSS.escape(v)}"]` : ''}`;
    const c = [...el.classList].find((x) => x.startsWith('wb-'));
    return c ? `.${c}` : null;
  }

  /** A "Workspace" button in the context panel opens this view. */
  function attachEntry() {
    for (const start of document.querySelectorAll('.aui-composer-root .aui-composer-action-start')) {
      if (start.querySelector('.wb-toggle')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wb-toggle';
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-label', 'Open workspace');
      b.innerHTML = '<span>Workspace</span>';
      b.addEventListener('click', (e) => { e.stopPropagation(); open('items'); });
      start.appendChild(b);
    }
  }

  function install(app) {
    try {
      if (app) appRef = app;
      if (!send()) return;
      ensureRoot();
      attachEntry();
      if (typeof MutationObserver !== 'undefined' && document.body && !document._wbObs) {
        document._wbObs = true;
        new MutationObserver(() => attachEntry()).observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) { console.warn('workspace bulk', e); }
  }

  const api = { install, open, close, refresh, openPerms, deleteLineHtml, setHolderPolicy, loadPolicies, _state: st };
  if (typeof window !== 'undefined') {
    window.__wsBulk = api;
    // Self-installing like the groups sheet; a no-op without the engine.
    const boot = () => { try { install(window.__app || window.__runtime || window.__agentRuntime || null); } catch (e) { console.warn('workspace bulk boot', e); } };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
  return api;
})();
