/* ==========================================================================
   Notes — the agent's working notes, visible and editable by the user.
   - One notepad shared by all chats, stored in the same SQLite row the
     device tools use (agent_tools.scratchpad_notes); localStorage outside
     the app.
   - update_notes / read_notes draw a Notes card. The newest card is a live
     editor (autosaves, Copy, Undo of your last edit); older cards show the
     notes as they were then, with "Use this version".
   - The agent sees the notes again: at the start of a chat, and on the next
     turn after the user changes them, as context on the user's message.
   ========================================================================== */
const Notepad = (() => {
  'use strict';
  const MAX = 10000;
  const LOCAL_KEY = 'agentNotesLocal';
  const SEEN_KEY = 'agentNotesSeen';
  const SAVE_MS = 600;
  const TABLE = 'CREATE TABLE IF NOT EXISTS scratchpad_notes (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT, updated_at INTEGER)';
  const EVT = 'nativekit:agent-notes';

  let cur = { text: '', updatedAt: 0 };
  let ready = null;
  const editors = new Set(); // live editor views

  /* ---------- storage ---------- */
  const db = () => { const s = nativeKit()?.sqlite; return s?.query && s?.run ? s : null; };
  async function load() {
    const s = db();
    try {
      if (s) {
        await s.run('agent_tools', TABLE, []);
        const r = await s.query('agent_tools', 'SELECT data, updated_at FROM scratchpad_notes WHERE id=1', []);
        const row = r?.values?.[0] || {};
        return { text: typeof row.data === 'string' ? row.data : '', updatedAt: Number(row.updated_at) || 0 };
      }
      const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
      return v && typeof v.text === 'string' ? { text: v.text, updatedAt: Number(v.updatedAt) || 0 } : { text: '', updatedAt: 0 };
    } catch { return { ...cur }; }
  }
  async function persist(text, updatedAt) {
    const s = db();
    if (s) {
      await s.run('agent_tools', TABLE, []);
      await s.run('agent_tools', 'INSERT OR REPLACE INTO scratchpad_notes (id, data, updated_at) VALUES (1, ?, ?)', [text, updatedAt]);
    } else localStorage.setItem(LOCAL_KEY, JSON.stringify({ text, updatedAt }));
  }
  const ensure = () => (ready ??= load().then((v) => { if (v.updatedAt >= cur.updatedAt) cur = v; return cur; }));

  /* ---------- what each chat has seen ---------- */
  const seen = {
    read() { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } },
    get(k) { return Number(this.read()[k]) || 0; },
    set(k, at) {
      try {
        const all = this.read(); all[k] = at;
        const keys = Object.keys(all); if (keys.length > 200) for (const x of keys.slice(0, keys.length - 200)) delete all[x];
        localStorage.setItem(SEEN_KEY, JSON.stringify(all));
      } catch { /* storage blocked */ }
    },
  };
  function markRunningSeen(at) {
    for (const rt of app?.chat?.runtimes?.values?.() || []) if (rt.isRunning) seen.set(rt.id, at);
  }

  /** Context for the next user message in this chat, or '' when the agent is up to date. */
  function contextFor(rt) {
    if (!rt?.id || !cur.text.trim()) return '';
    const last = seen.get(rt.id);
    if (last >= cur.updatedAt) return '';
    seen.set(rt.id, cur.updatedAt);
    const why = last ? 'The user edited your working notes since you last saw them. Current notes' : 'Your working notes from earlier (update_notes; the user can see and edit them)';
    return `<agent_notes>\n${why}:\n${cur.text}\n</agent_notes>`;
  }

  /* ---------- changes ---------- */
  function apply(text, updatedAt, by) {
    if (updatedAt < cur.updatedAt && text !== cur.text) return;
    cur = { text, updatedAt };
    if (by === 'agent') markRunningSeen(updatedAt);
    for (const v of [...editors]) { if (!v.el.isConnected) { editors.delete(v); continue; } v.sync(by); }
  }
  async function userSave(text) {
    const at = Math.max(Date.now(), cur.updatedAt + 1);
    await persist(text, at);
    apply(text, at, 'user');
    window.dispatchEvent(new CustomEvent(EVT, { detail: { notes: text, updatedAt: at, by: 'user', fromPage: true } }));
    return at;
  }

  /* ---------- the card ---------- */
  const resultText = (part) => {
    const r = part?.result;
    const t = typeof r === 'string' ? r : Array.isArray(r?.content) ? r.content.map((c) => c?.text || '').join('\n') : typeof r?.output === 'string' ? r.output : '';
    return t.replace(/^<untrusted_[a-z_]+>\n?|\n?<\/untrusted_[a-z_]+>$/g, '');
  };
  /** The notes as this call left them (from its result). */
  function snapshotOf(part) {
    const t = resultText(part);
    const m = /^(?:Saved|Appended to) your notes \(\d+ chars\)\. Current notes:\n([\s\S]*)$/.exec(t) || /^Your notes \(\d+ chars, last changed [^)]*\):\n([\s\S]*)$/.exec(t);
    if (m) return m[1];
    if (/^Your notes are empty/.test(t)) return '';
    return null;
  }
  function isNewest(part) {
    for (const rt of app?.chat?.runtimes?.values?.() || []) {
      const msgs = rt.messages || [];
      let last = null; let mine = false;
      for (const m of msgs) for (const p of Array.isArray(m?.content) ? m.content : []) {
        if (p?.type !== 'tool-call' || !/^device__(update_notes|read_notes)$/.test(p.toolName) || p.isError) continue;
        last = p.toolCallId; if (p.toolCallId === part.toolCallId) mine = true;
      }
      if (mine) return last === part.toolCallId;
    }
    return true;
  }

  function header(iconName, title, extra) {
    return h('div', { class: 'np-head' }, h('span', { class: 'np-icon', 'aria-hidden': 'true' }, icon(iconName)), h('span', { class: 'np-title' }, title), extra || null);
  }

  function liveCard(part) {
    const area = h('textarea', { class: 'np-text', rows: '4', maxlength: String(MAX), spellcheck: 'true', 'aria-label': 'Agent notes', placeholder: 'Nothing here yet. Notes you write here go to the assistant on your next message.' });
    const status = h('span', { class: 'np-status', role: 'status', 'aria-live': 'polite' });
    const count = h('span', { class: 'np-count' });
    const undoBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'notes-undo', hidden: '' }, icon('undo-2'), 'Undo');
    const copyBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'notes-copy' }, icon('copy'), 'Copy');
    const el = h('div', { class: 'np-card', 'data-slot': 'notes-card', 'data-live': 'true' },
      header('notebook-pen', 'Notes', h('span', { class: 'np-hint' }, 'You can edit these')),
      area,
      h('div', { class: 'np-foot' }, status, count, h('span', { class: 'np-spacer' }), undoBtn, copyBtn));
    let timer = 0; let before = null; let saving = Promise.resolve();
    const fit = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight + 2, 360)}px`; };
    const showCount = () => { count.textContent = area.value.length > MAX * 0.8 ? `${area.value.length.toLocaleString()} / ${MAX.toLocaleString()}` : ''; };
    const say = (t) => { status.textContent = t; };
    const view = {
      el,
      part,
      sync(by) {
        if (document.activeElement === area && by !== 'user') { say('The assistant changed the notes; yours are kept until you stop typing'); return; }
        if (area.value !== cur.text) { area.value = cur.text; fit(); showCount(); }
        if (by === 'agent') { before = null; undoBtn.hidden = true; say('Updated by the assistant'); }
      },
    };
    const flush = () => {
      clearTimeout(timer); timer = 0;
      const text = area.value;
      if (text === cur.text) { say(before !== null ? 'Saved' : ''); return saving; }
      say('Saving…');
      saving = saving.then(() => userSave(text)).then(() => say('Saved · the assistant sees this on your next message')).catch((e) => say(`Not saved: ${e?.message || e}`));
      return saving;
    };
    area.addEventListener('input', () => {
      if (before === null) { before = cur.text; undoBtn.hidden = false; }
      fit(); showCount(); say('Editing…');
      clearTimeout(timer); timer = setTimeout(flush, SAVE_MS);
    });
    area.addEventListener('blur', () => { if (timer) flush(); else if (area.value !== cur.text && before === null) view.sync('agent'); });
    area.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flush(); } e.stopPropagation(); });
    undoBtn.addEventListener('click', async () => {
      if (before === null) return;
      const back = before; before = null; undoBtn.hidden = true;
      area.value = back; fit(); showCount();
      clearTimeout(timer); await saving; await userSave(back); say('Your edit was undone');
    });
    copyBtn.addEventListener('click', async () => {
      if (await copyText(area.value)) { say('Copied'); } else toast("Couldn't copy to the clipboard.", { type: 'error' });
    });
    editors.add(view);
    area.value = cur.text;
    ensure().then(() => { if (document.activeElement !== area && before === null) { area.value = cur.text; fit(); showCount(); } });
    requestAnimationFrame(fit);
    return el;
  }

  function pastCard(part, snap) {
    const body = snap ? h('pre', { class: 'np-past' }, snap) : h('p', { class: 'np-empty' }, 'Empty');
    const use = snap !== null && snap !== cur.text ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'notes-restore', onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      await userSave(snap); btn.replaceWith(h('span', { class: 'np-status' }, 'Restored; the assistant sees it on your next message'));
    } }, icon('undo-2'), 'Use this version') : null;
    return h('details', { class: 'np-card np-old', 'data-slot': 'notes-card', 'data-live': 'false' },
      h('summary', {}, header('notebook-pen', part.toolName === 'device__read_notes' ? 'Notes, as read then' : 'Notes, as saved then', h('span', { class: 'np-hint' }, 'newer below'))),
      body, use ? h('div', { class: 'np-foot' }, h('span', { class: 'np-spacer' }), use) : null);
  }

  function card(part, status) {
    if (part.isError) return h('p', { class: 'field-hint' }, `Notes were not ${part.toolName === 'device__read_notes' ? 'read' : 'saved'}: ${truncate(resultText(part), 160)}`);
    if (part.result === undefined) return h('div', { class: 'wt-check', 'data-state': 'running', role: 'status' }, icon('loader'), h('span', {}, status?.type === 'running' ? (part.toolName === 'device__read_notes' ? 'Reading notes…' : 'Saving notes…') : 'Notes did not finish.'));
    const snap = snapshotOf(part);
    if (snap !== null && !cur.updatedAt && !ready) cur = { text: snap, updatedAt: 0 };
    if (!isNewest(part)) return pastCard(part, snap);
    // A newer call took over: earlier live editors turn into their snapshot.
    for (const v of [...editors]) {
      if (v.part.toolCallId === part.toolCallId) continue;
      editors.delete(v);
      if (v.el.isConnected) v.el.replaceWith(pastCard(v.part, snapshotOf(v.part)));
    }
    return liveCard(part);
  }

  function install() {
    TOOLKIT.device__update_notes = { ...(TOOLKIT.device__update_notes || {}), ui: card };
    TOOLKIT.device__read_notes = { ...(TOOLKIT.device__read_notes || {}), ui: card };
    window.addEventListener(EVT, (e) => {
      const d = e?.detail || {};
      if (d.fromPage) return;
      apply(typeof d.notes === 'string' ? d.notes : '', Number(d.updatedAt) || Date.now(), d.by === 'user' ? 'user' : 'agent');
    });
    // The notes ride on the user's next message as context (like a forked chat's history).
    const proto = ThreadRuntime.prototype;
    if (!proto.__notesWrapped) {
      const take = proto.takeContext;
      proto.takeContext = function () {
        const base = take.call(this);
        const notes = contextFor(this);
        return [notes, base].filter(Boolean).join('\n\n');
      };
      proto.__notesWrapped = true;
    }
    ensure();
  }

  return { install, contextFor, get current() { return { ...cur }; }, userSave, ensure };
})();
