/* Cross-session UI: the ask_session approval card (names the target chat,
   shows the message, always-allow-this-chat), an inline result card, the
   audit note in the chat that was asked, and messaging another chat
   yourself. Feature-detected via getEngineFeatures ('crossSession'). */
/* Icons used by the sub-agent and cross-session screens (Lucide paths). */
Object.assign(ICONS, {
  'list-checks': '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  'corner-down-left': '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
});
const CrossSession = (() => {
  let appRef = null;
  let installed = false;
  const NOTE_RE = /^\[Message from your other chat "([^"]*)" \(sent by the (user|assistant) with the user's permission\)\.[^\]]*\]\s*/;
  const kit = () => (typeof NativeKit !== 'undefined' ? NativeKit : window.NativeKit);
  const available = () => engine.has('crossSession') && typeof kit()?.agent?.subagents === 'function';
  const titleOf = (key) => {
    const k = String(key || '');
    const it = appRef?.chat?.items?.get?.(k);
    return (appRef?.chat?.titles?.[k]) || (it && it.title !== k ? it.title : '') || k;
  };
  const parseNote = (text) => {
    const m = NOTE_RE.exec(String(text || ''));
    return m ? { from: m[1], by: m[2], body: String(text).slice(m[0].length) } : null;
  };

  /** Always allow one chat: add its session key to ask_session's allow list. */
  async function allowChat(key) {
    const agent = kit()?.agent;
    if (!key || typeof agent?.listToolRules !== 'function' || typeof agent?.setToolRules !== 'function') return false;
    try {
      const cur = (await agent.listToolRules())?.rules?.ask_session || { allow: [], deny: [] };
      const allow = Array.isArray(cur.allow) ? cur.allow.slice() : [];
      if (!allow.includes(key)) allow.push(key);
      await agent.setToolRules({ toolName: 'ask_session', ruleJson: JSON.stringify({ allow, deny: Array.isArray(cur.deny) ? cur.deny : [] }) });
      toast(`Messages to “${titleOf(key)}” won’t ask again. Change it in tool permissions.`, { type: 'success' });
      return true;
    } catch (e) {
      toast(`Couldn’t save the rule: ${redactSecrets(e?.message || String(e), 200)}`, { type: 'error' });
      return false;
    }
  }

  function resultCard(part, status) {
    const a = toolArgs(part);
    const state = toolState(part, status);
    const key = String(a.session_key ?? a.sessionKey ?? '');
    const raw = part.result === undefined ? '' : typeof part.result === 'string' ? part.result : JSON.stringify(part.result, null, 2);
    const body = [h('p', { class: 'cs-q' }, h('span', { class: 'cs-label' }, 'Asked'), truncate(String(a.message ?? ''), 2000))];
    if (part.result !== undefined) {
      const md = h('div', { class: 'aui-md cs-reply' });
      Markdown.render(md, truncate(raw, 20000), {});
      body.push(h('div', { class: 'cs-a' }, h('span', { class: 'cs-label' }, part.isError ? 'Not answered' : 'Reply'), md));
    } else if (state === 'running') {
      body.push(h('p', { class: 'cs-a field-hint shimmer' }, `Waiting for “${titleOf(key)}” to answer…`));
    }
    const title = state === 'running' ? `Asking “${titleOf(key)}”` : part.isError ? `“${titleOf(key)}” didn’t answer` : `Reply from “${titleOf(key)}”`;
    return toolCardShell({ kind: 'session', iconName: 'messages-square', title, subtitle: 'ask_session', state, duration: toolDuration(part),
      actions: part.result !== undefined ? [copyChip(() => raw, 'Copy reply')] : [], body });
  }

  /** Style the note a chat keeps when another chat asked it something. */
  function decorateNotes(root = doc) {
    for (const el of root.querySelectorAll('.aui-user-message-content:not([data-cs-checked])')) {
      el.dataset.csChecked = '1';
      const note = parseNote(el.textContent);
      if (!note) continue;
      el.closest('.aui-user-message-root')?.setAttribute('data-cross-session', 'true');
      el.replaceChildren(
        h('p', { class: 'cs-note', 'data-slot': 'cross-session-note' }, icon('messages-square'), h('span', null, `Asked from your chat “${note.from}” by ${note.by === 'user' ? 'you' : 'its assistant'}`)),
        h('div', { class: 'cs-note-body' }, note.body));
    }
  }

  /** The user messages another chat; only its reply comes back here. */
  async function openMessageDialog(fromKey) {
    if (!available()) { toast('Update the app to message another chat.', { type: 'error' }); return null; }
    const from = fromKey || appRef?.chat?.mainId || '';
    let chats = [];
    try { chats = (await kit().agent.subagents({ action: 'chats' }))?.chats || []; } catch (e) { toast(redactSecrets(e?.message || String(e), 200), { type: 'error' }); return null; }
    chats = chats.filter((c) => c && (c.sessionKey || c.session_key) && (c.sessionKey || c.session_key) !== from);
    const keyOf = (c) => String(c.sessionKey || c.session_key);
    const sel = h('select', { class: 'select', 'aria-label': 'Chat to message' }, ...(chats.length ? chats.map((c) => h('option', { value: keyOf(c) }, truncate(titleOf(keyOf(c)) || c.title || keyOf(c), 60))) : [h('option', { value: '' }, 'No other chats yet')]));
    const ta = h('textarea', { class: 'textarea', rows: '4', maxlength: '4000', 'aria-label': 'Message', placeholder: 'Ask the other chat something. It answers from its own history.' });
    const out = h('div', { class: 'cs-out', 'aria-live': 'polite' });
    let dialog = null;
    let busyKey = null;
    const send = h('button', { type: 'button', class: 'btn btn-default', disabled: !chats.length }, icon('send'), 'Send');
    const cancel = h('button', { type: 'button', class: 'btn btn-outline', hidden: true }, 'Cancel request');
    send.onclick = async () => {
      const target = sel.value;
      const text = ta.value.trim();
      if (!target) return;
      if (!text) { ta.setAttribute('aria-invalid', 'true'); ta.focus(); return; }
      if (busyKey) return;
      busyKey = target;
      send.disabled = true; cancel.hidden = false;
      out.replaceChildren(h('p', { class: 'field-hint shimmer' }, `Waiting for “${titleOf(target)}”…`));
      try {
        const res = await kit().agent.subagents({ action: 'ask', targetSessionKey: target, callerSessionKey: from, message: text });
        if (!dialog?.panel?.isConnected) return;
        const md = h('div', { class: 'aui-md cs-reply' });
        Markdown.render(md, truncate(String(res?.reply ?? ''), 20000), {});
        out.replaceChildren(h('p', { class: 'field-label' }, `Reply from “${titleOf(target)}”`), md,
          h('div', { class: 'row-actions' },
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => { const ok = await copyText(String(res?.reply ?? '')); toast(ok ? 'Copied.' : 'Couldn’t copy.', { type: ok ? 'success' : 'error' }); } }, icon('copy'), 'Copy'),
            h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { appRef?.thread?.composer?.quote?.(`Reply from my chat “${titleOf(target)}”:\n${String(res?.reply ?? '')}`); dialog.close(); } }, icon('arrow-up-right'), 'Add to my message')));
      } catch (e) {
        if (dialog?.panel?.isConnected) out.replaceChildren(h('p', { class: 'field-error', role: 'alert' }, redactSecrets(e?.message || String(e), 300)));
      } finally {
        busyKey = null;
        send.disabled = !chats.length; cancel.hidden = true;
      }
    };
    cancel.onclick = async () => {
      if (!busyKey) return;
      try { await kit().agent.subagents({ action: 'cancelAsk', targetSessionKey: busyKey }); } catch (e) { console.warn('cancelAsk', e); }
    };
    dialog = openDialog({ title: 'Message another chat', description: 'It answers from its own history. Only its reply comes back; a note is kept in that chat.', size: 'sm',
      body: h('div', { class: 'sa-sheet', 'data-slot': 'cross-session-dialog' }, labelledField('To chat', sel), labelledField('Message', ta), out),
      footer: [h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => dialog.close() }, 'Close'), cancel, send], initialFocus: chats.length ? ta : sel });
    return dialog;
  }
  const labelledField = (label, control) => h('label', { class: 'sa-field' }, h('span', { class: 'field-label' }, label), control);

  function install(app) {
    appRef = app;
    if (installed) return;
    installed = true;
    TOOLKIT.ask_session = {
      ...(TOOLKIT.ask_session || {}),
      ui: resultCard,
      approval: {
        title: 'Message another chat', icon: 'messages-square',
        details: (a) => [{ label: 'To chat', value: titleOf(a.session_key ?? a.sessionKey) }, { label: 'Message', value: String(a.message ?? '') }],
        alwaysLabel: (part) => `Always allow “${truncate(titleOf(toolArgs(part).session_key), 24)}”`,
        // One-time approve plus a rule for this chat only (not the whole tool).
        alwaysOption: 'allow',
        onAlways: (part) => { allowChat(String(toolArgs(part).session_key ?? '')); },
      },
    };
    TOOLKIT.list_sessions = { ...(TOOLKIT.list_sessions || {}), approval: { title: 'List your other chats', icon: 'messages-square', details: () => [] } };
    const mo = new MutationObserver(() => decorateNotes());
    mo.observe(doc.body, { childList: true, subtree: true });
    decorateNotes();
  }

  const api = { install, openMessageDialog, parseNote, allowChat, available, decorateNotes };
  if (typeof window !== 'undefined') window.__crossSession = api;
  return api;
})();
