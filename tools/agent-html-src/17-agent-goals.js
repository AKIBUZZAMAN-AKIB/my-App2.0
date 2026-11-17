/* ==========================================================================
   Agent view: Goals and Memory tabs (PARITY_PLAN phase 5).

   Every agent (the main agent and each sub-agent) has its own session, so it
   has its own goals and rolling memory in the engine (`memory.get`,
   `memory.goal`, `memory.turns`). These tabs read and change them for the
   agent in view; the main agent's tabs show the open chat's.
   - Goals: the current goal, every goal by status, its history; create a
     goal, complete, cancel or resume one.
   - Memory: what is summarised and through which turn, the turn index, the
     decisions and facts kept; retry a failed summary; open the full memory
     screen for this agent.
   ========================================================================== */
const AgentGoals = (() => {
  const GOAL_LABEL = { active: 'Active', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled' };
  const OP_LABEL = { create: 'Created', complete: 'Completed', resume: 'Resumed', cancel: 'Cancelled', pause: 'Paused', update: 'Updated' };
  const ORDER = { active: 0, paused: 1, completed: 2, cancelled: 3 };
  const extraIcons = {
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  };
  if (typeof ICONS !== 'undefined') for (const [k, v] of Object.entries(extraIcons)) if (!ICONS[k]) ICONS[k] = v;

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const keyOf = (ctx) => String(ctx.r?.isMain ? ctx.chatKey || ctx.r.sessionKey : ctx.r?.sessionKey || '');
  const when = (ms) => { ms = num(ms); if (!ms) return ''; try { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const note = (text, type = 'info') => h('p', { class: 'settings-note', 'data-type': type }, icon(type === 'error' ? 'circle-exclamation-point' : 'info'), h('span', null, text));
  const errText = (e) => redactSecrets(e?.message || String(e), 300);
  const section = (title, slot, ...kids) => h('section', { class: 'sa-vsection', 'data-slot': slot }, h('h4', { class: 'sa-vsection-title' }, title), ...kids);

  async function memGet(ctx, key) { return ctx.call('memory.get', { sessionKey: key }); }

  /* ---------------- Goals ---------------- */
  function goalsTab(ctx) {
    const key = keyOf(ctx);
    const box = h('div', { class: 'sa-vpane sa-goals', 'data-slot': 'agent-tab-goals', 'data-session': key });
    if (!key) { setChildren(box, note('This agent has no session yet.')); return box; }
    if (ctx.can && !ctx.can('turnMemory')) { setChildren(box, note('Goals need the newer app engine.')); return box; }
    let goals = null;
    let busy = false;
    const status = h('p', { class: 'field-hint', 'aria-live': 'polite', 'data-slot': 'goals-status' });

    const titleIn = h('input', { class: 'input', id: `sa-goal-title-${uid(4)}`, type: 'text', maxlength: '200', placeholder: 'e.g. Ship the release notes', 'data-slot': 'goal-new-title' });
    const descIn = h('textarea', { class: 'textarea', id: `sa-goal-desc-${uid(4)}`, rows: '2', maxlength: '2000', placeholder: 'Optional: what \u201cdone\u201d looks like', 'data-slot': 'goal-new-description' });
    const newErr = h('p', { class: 'field-error', role: 'alert', hidden: true, 'data-slot': 'goal-new-error' });
    titleIn.addEventListener('input', () => { newErr.hidden = true; titleIn.removeAttribute('aria-invalid'); });
    const createBtn = h('button', { type: 'submit', class: 'btn btn-default btn-sm', 'data-slot': 'goal-create' }, icon('plus'), 'Add goal');
    const form = h('form', { class: 'sa-goal-new', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const t = titleIn.value.trim();
      if (!t) { newErr.textContent = 'Give the goal a title.'; newErr.hidden = false; titleIn.setAttribute('aria-invalid', 'true'); titleIn.focus(); return; }
      const open = (goals?.goals || []).find((g) => g.status === 'active');
      run({ op: 'create', title: t, description: descIn.value.trim() }, open ? `Added. ${open.goalId} is paused; the new goal is now current.` : 'Goal added.', () => { titleIn.value = ''; descIn.value = ''; });
    } },
      h('div', { class: 'field' }, h('label', { class: 'label', for: titleIn.id }, 'Title'), titleIn),
      h('div', { class: 'field' }, h('label', { class: 'label', for: descIn.id }, 'Description'), descIn),
      newErr, h('div', { class: 'row-actions' }, createBtn));

    const listBox = h('div', { 'data-slot': 'goals-list' });
    async function run(req, okText, after) {
      if (busy) return;
      busy = true; createBtn.disabled = true; status.textContent = 'Saving\u2026';
      for (const b of listBox.querySelectorAll('button')) b.disabled = true;
      try {
        const res = await ctx.call('memory.goal', { sessionKey: key, ...req });
        goals = res?.goals || goals;
        status.textContent = okText;
        toast(okText, { type: 'success' });
        after?.();
      } catch (e) {
        status.textContent = errText(e);
        toast(errText(e), { type: 'error' });
      } finally {
        busy = false; createBtn.disabled = false;
        paint();
      }
    }
    function paint() {
      const list = Array.isArray(goals?.goals) ? goals.goals.slice() : [];
      const cur = goals?.currentGoalId || '';
      list.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || String(b.goalId).localeCompare(String(a.goalId)));
      const counts = {};
      for (const g of list) counts[g.status] = (counts[g.status] || 0) + 1;
      const head = list.length ? h('p', { class: 'field-hint', 'data-slot': 'goals-counts' }, Object.entries(counts).map(([s, n]) => `${n} ${(GOAL_LABEL[s] || s).toLowerCase()}`).join(' \u00b7 ')) : null;
      const items = list.map((g) => {
        const isCur = g.goalId === cur;
        const actions = [];
        if (g.status === 'active' || g.status === 'paused') {
          if (g.status === 'paused') actions.push(h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-goal-action': 'resume', onclick: () => run({ op: 'resume', goalId: g.goalId }, `${g.goalId} is current again.`) }, icon('play'), 'Resume'));
          actions.push(h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-goal-action': 'complete', onclick: () => run({ op: 'complete', goalId: g.goalId }, `${g.goalId} completed.`) }, icon('circle-check'), 'Complete'));
          actions.push(h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-danger', 'data-goal-action': 'cancel', onclick: () => confirmDialog({ title: `Cancel ${g.goalId}?`, description: `\u201c${g.title}\u201d stays in the history as cancelled.`, confirmLabel: 'Cancel goal', destructive: true, onConfirm: () => run({ op: 'cancel', goalId: g.goalId }, `${g.goalId} cancelled.`) }) }, icon('circle-x'), 'Cancel'));
        }
        return h('li', { class: 'sa-goal', 'data-goal-id': g.goalId, 'data-goal-status': g.status, 'aria-current': isCur ? 'true' : null },
          h('div', { class: 'sa-goal-head' },
            h('span', { class: 'sa-goal-id' }, g.goalId),
            h('span', { class: 'chip sa-goal-status', 'data-status': g.status }, GOAL_LABEL[g.status] || g.status),
            isCur ? h('span', { class: 'chip sa-goal-current', 'data-slot': 'goal-current' }, 'Current') : null),
          h('p', { class: 'sa-goal-title' }, g.title || '(untitled)'),
          g.description ? h('p', { class: 'sa-goal-desc' }, g.description) : null,
          h('p', { class: 'field-hint' }, [num(g.sourceTurn) ? `From turn ${num(g.sourceTurn)}` : '', g.createdAt ? `created ${when(g.createdAt)}` : '', g.completedAt ? `completed ${when(g.completedAt)}` : ''].filter(Boolean).join(' \u00b7 ')),
          actions.length ? h('div', { class: 'row-actions sa-goal-actions' }, ...actions) : null);
      });
      const events = Array.isArray(goals?.events) ? goals.events.slice(0, 20) : [];
      setChildren(listBox,
        cur ? null : h('p', { class: 'field-hint', 'data-slot': 'goals-no-current' }, 'No goal is current now.'),
        head,
        list.length ? h('ol', { class: 'sa-goal-list' }, ...items) : h('p', { class: 'field-hint', 'data-slot': 'goals-empty' }, ctx.r?.isMain ? 'This chat has no goals yet. The agent records one when you give it a task; you can add one here too.' : 'This agent has no goals yet. It records one when it takes on a task; you can add one here too.'),
        events.length ? h('details', { class: 'sa-goal-events', 'data-slot': 'goals-history' }, h('summary', null, `History (${events.length})`),
          h('ol', { class: 'sa-goal-eventlist' }, ...events.map((e) => h('li', { 'data-goal-op': e.op }, h('span', null, `${OP_LABEL[e.op] || e.op} ${e.goalId || ''}`), h('span', { class: 'field-hint' }, [num(e.turn) ? `turn ${num(e.turn)}` : '', e.origin && e.origin !== 'user' ? e.origin : '', when(e.at || e.atMs || e.createdAt)].filter(Boolean).join(' \u00b7 ')))))) : null);
    }
    setChildren(box, section('Goals', 'agent-goals-list', listBox), section('New goal', 'agent-goals-new', form), status);
    setChildren(listBox, h('p', { class: 'field-hint settings-loading' }, icon('loader-circle', 'spin'), 'Loading\u2026'));
    memGet(ctx, key).then((d) => { goals = d?.goals || { goals: [], events: [] }; paint(); }).catch((e) => setChildren(listBox, note(errText(e), 'error')));
    return box;
  }

  /* ---------------- Memory ---------------- */
  function memoryTab(ctx) {
    const key = keyOf(ctx);
    const box = h('div', { class: 'sa-vpane sa-memory', 'data-slot': 'agent-tab-memory', 'data-session': key });
    if (!key) { setChildren(box, note('This agent has no session yet.')); return box; }
    if (ctx.can && !ctx.can('turnMemory')) { setChildren(box, note('Memory needs the newer app engine.')); return box; }
    const body = h('div', { 'data-slot': 'memory-body' }, h('p', { class: 'field-hint settings-loading' }, icon('loader-circle', 'spin'), 'Loading\u2026'));
    const openFull = typeof ChatMemory !== 'undefined' ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-slot': 'memory-open-full', onclick: () => ChatMemory.open('summary', key) }, icon('maximize-2'), 'Open full memory') : null;
    const refresh = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-slot': 'memory-refresh', onclick: () => load() }, icon('refresh-cw'), 'Refresh');
    const mode = ctx.r?.memoryMode || ctx.r?.memory || '';
    const modeText = { private: 'Private: only this agent sees it', shared: 'Shared with the main agent', inherit: 'Starts from the main agent\u2019s memory', none: 'Off for this agent' }[mode] || '';
    async function retry() {
      try { await ctx.call('memory.retry', { sessionKey: key }); toast('Summary queued again.', { type: 'success' }); load(); } catch (e) { toast(errText(e), { type: 'error' }); }
    }
    function paint(d) {
      const m = d?.memory || {};
      const through = num(m.throughTurn);
      const turns = Array.isArray(d?.turns) ? d.turns : [];
      const st = d?.status?.status || 'ok';
      // TurnMemory (turn_memory.rs): decisions { current, superseded }, facts and preferences [{ text, turn }], openItems [string].
      const decisions = Array.isArray(m.decisions) ? m.decisions : Array.isArray(m.decisions?.current) ? m.decisions.current : [];
      const facts = [...(Array.isArray(m.facts) ? m.facts : []), ...(Array.isArray(m.preferences) ? m.preferences : [])];
      const open = Array.isArray(m.openItems) ? m.openItems : [];
      const kv = (k, v) => h('div', { class: 'sa-x-kv' }, h('dt', null, k), h('dd', null, v));
      const facts2 = h('dl', { class: 'sa-x-facts', 'data-slot': 'memory-facts' },
        kv('Summarised', through ? `through turn ${through}` : 'nothing yet'),
        kv('Turns kept', String(turns.length)),
        kv('Version', d?.version ? `v${d.version}` : '\u2014'),
        kv('State', d?.summarizing ? `summarising turns ${num(d.summarizing.fromTurn)}\u2013${num(d.summarizing.toTurn)}` : st === 'ok' ? 'up to date' : st),
        modeText ? kv('Mode', modeText) : null);
      const list = (title, slot, arr) => arr.length ? section(title, slot, h('ul', { class: 'sa-mem-list' }, ...arr.slice(0, 30).map((x) => h('li', null, typeof x === 'string' ? x : [x.id ? `${x.id} ` : '', x.text || x.title || ''].join(''), typeof x === 'object' && num(x.turn) ? h('span', { class: 'field-hint' }, ` \u00b7 turn ${num(x.turn)}`) : null)))) : null;
      const rendered = String(d?.rendered || '').trim();
      const recent = turns.slice(-8).reverse();
      setChildren(body,
        d?.settings && d.settings.enabled === false ? note('Memory is off in the app settings, so nothing new is summarised.') : null,
        st !== 'ok' && !d?.summarizing ? h('div', { class: 'settings-note', 'data-type': 'warning', 'data-slot': 'memory-failed' }, icon('triangle-alert'), h('span', null, `The last summary did not finish (${st}).`), h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-slot': 'memory-retry', onclick: retry }, 'Retry')) : null,
        facts2,
        list('Decisions', 'memory-decisions', decisions),
        list('Facts', 'memory-facts-list', facts),
        list('Open items', 'memory-open', open),
        m.goal ? section('Goal in memory', 'memory-goal', h('p', { class: 'sa-goal-desc' }, String(m.goal).slice(0, 600))) : null,
        !decisions.length && !facts.length && rendered ? section('Summary', 'memory-rendered', h('pre', { class: 'sa-mem-rendered' }, rendered.slice(0, 6000))) : null,
        recent.length ? section('Recent turns', 'memory-turns', h('ol', { class: 'sa-mem-turns' }, ...recent.map((t) => h('li', { 'data-turn': String(num(t.turn)) },
          h('span', { class: 'sa-goal-id' }, `#${num(t.turn)}`), h('span', null, String(t.user || t.title || t.preview || t.summary || '').replace(/\s+/g, ' ').slice(0, 140) || '(no text)'),
          t.goalId ? h('span', { class: 'chip' }, t.goalId) : null)))) : null,
        !through && !turns.length ? h('p', { class: 'field-hint', 'data-slot': 'memory-empty' }, 'Nothing remembered yet. The agent\u2019s memory fills in as it works.') : null);
    }
    function load() { memGet(ctx, key).then(paint).catch((e) => setChildren(body, note(errText(e), 'error'))); loadEntries(); }

    /* Its own named store (sub-agents only): what it saved with its memory tool. Search, delete, copy to main, clear. */
    const entriesBox = ctx.r?.isMain ? null : h('div', { 'data-slot': 'memory-entries' });
    let entries = [];
    const q = h('input', { type: 'search', class: 'input', placeholder: 'Search its saved entries', 'aria-label': 'Search its saved entries', 'data-slot': 'memory-entries-search', oninput: () => paintEntries() });
    async function memOp(op, k, okText) {
      try {
        const res = await ctx.call('memory', { id: ctx.r.id, op, ...(k ? { key: k } : {}) });
        if (op === 'promote' && !num(res?.promoted)) { toast('Nothing was copied.', { type: 'error' }); return; }
        toast(okText, { type: 'success' });
        loadEntries();
      } catch (e) { toast(errText(e), { type: 'error' }); }
    }
    function paintEntries() {
      if (!entriesBox) return;
      const t = q.value.trim().toLowerCase();
      const shown = entries.filter((e) => !t || `${e.key} ${e.text}`.toLowerCase().includes(t));
      setChildren(entriesBox,
        entries.length > 4 ? q : null,
        shown.length ? h('ul', { class: 'sa-mem-entries' }, ...shown.slice(0, 200).map((e) => h('li', { class: 'sa-mem-entry', 'data-key': e.key },
          h('div', { class: 'sa-mem-entrytext' }, h('code', null, String(e.key)), h('p', null, String(e.text || '').slice(0, 400)), e.updatedAt ? h('span', { class: 'field-hint' }, when(e.updatedAt)) : null),
          h('div', { class: 'sa-mem-entryactions' },
            iconButton('Copy to main memory', icon('arrow-up-right'), () => memOp('promote', e.key, 'Copied to main memory.')),
            iconButton('Delete entry', icon('trash'), () => confirmDialog({ title: `Delete \u201c${e.key}\u201d?`, confirmLabel: 'Delete', destructive: true, onConfirm: () => memOp('delete', e.key, 'Entry deleted.') }))))))
          : h('p', { class: 'field-hint', 'data-slot': 'memory-entries-empty' }, entries.length ? 'No entry matches.' : 'It has saved nothing with its memory tool.'),
        entries.length ? h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-slot': 'memory-promote-all', onclick: () => memOp('promote', null, 'All entries copied to main memory.') }, icon('arrow-up-right'), 'Copy all to main'),
          h('button', { type: 'button', class: 'btn btn-ghost btn-xs sa-danger', 'data-slot': 'memory-clear', onclick: () => confirmDialog({ title: `Clear all ${entries.length} entries?`, description: 'This cannot be undone.', confirmLabel: 'Clear', destructive: true, onConfirm: () => memOp('clear', null, 'Memory cleared.') }) }, icon('trash'), 'Clear')) : null);
    }
    function loadEntries() {
      if (!entriesBox) return;
      ctx.call('memory', { id: ctx.r.id, op: 'list' }).then((d) => { entries = Array.isArray(d?.entries) ? d.entries : []; paintEntries(); }).catch((e) => setChildren(entriesBox, note(errText(e), 'error')));
    }
    setChildren(box, h('div', { class: 'row-actions sa-vrow' }, openFull, refresh), body, entriesBox ? section('Saved entries', 'agent-memory-entries', entriesBox) : null);
    load();
    return box;
  }

  return { goalsTab, memoryTab, keyOf };
})();
if (typeof window !== 'undefined') window.__agentGoals = AgentGoals;
