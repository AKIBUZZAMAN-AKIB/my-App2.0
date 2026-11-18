/* A sub-agent opened as a chat of its own, in the same chat surface as the main agent:
   the same thread, message renderer, tool cards, approval cards, composer, Stop,
   copy/edit/retry and branch controls. What the main agent does through the chat
   session, a sub-agent does through the engine's sub-agent actions:
     send     -> subagents { action: 'message' }   (runs it again, or queues while busy)
     Stop     -> subagents { action: 'cancel' }
     edit     -> subagents { action: 'edit', turn } (cuts its chat back, sends the new text)
     retry    -> subagents { action: 'regenerate' }
     approval -> respondToApproval (the request id is the engine's)
     images   -> the same actions with attachmentsJson (engines with subagentTeam or later)
     versions -> subagents { action: 'branches' | 'restoreBranch' } (kept on disk, so the
                 earlier versions of its chat survive a reload)
   A header names the agent (title, description, who started it, level, status) and
   carries the rest: back to the parent, model/provider/tools (Setup), Retry, Details. */
const SubagentChat = (() => {
  let appRef = null;
  const kit = () => nativeKit();
  function parseOut(r) {
    if (r == null) return {};
    if (typeof r === 'string') return parseMaybeJSON(r, {}) || {};
    if (typeof r.resultJson === 'string') return parseMaybeJSON(r.resultJson, {}) || {};
    return r;
  }
  async function call(action, extra = {}) {
    if (typeof kit()?.agent?.subagents !== 'function') throw new Error('Sub-agents need the app engine.');
    return parseOut(await kit().agent.subagents({ action, ...extra }));
  }
  /** Engines from the team build on take images on message/edit and keep chat versions. */
  const canAttach = () => engine.has('subagentTeam') || engine.has('subagentAdvanced');
  const attachmentsArg = (images) => {
    if (!images?.length) return {};
    if (!canAttach()) throw new Error('This app version can\u2019t send images to a sub-agent yet. Update the app, or remove the image.');
    return { attachmentsJson: JSON.stringify(images.map((i) => ({ type: 'image', mediaType: i.mediaType, data: i.data, ...(i.name ? { name: i.name } : {}) }))) };
  };
  const recOf = (id) => (typeof Subagents !== 'undefined' ? Subagents.records.get(String(id)) : null);
  const isLive = (r) => r && ['running', 'queued', 'waiting', 'pending'].includes(String(r.status));

  /** Its saved chat: the engine session `subagent:<id>`, else the transcript action. */
  async function loadTranscript(rec) {
    let msgs = null;
    try { msgs = await bridge.loadSession(rec.sessionKey || `subagent:${rec.id}`); } catch { msgs = null; }
    if (!Array.isArray(msgs) || !msgs.length) {
      try { const d = await call('get', { id: rec.id }); if (Array.isArray(d?.transcript)) msgs = d.transcript; } catch { /* none */ }
    }
    return Array.isArray(msgs) ? msgs : [];
  }

  /* ---- ThreadRuntime: route a sub-agent thread's actions to the engine's sub-agent actions ---- */
  const baseCancel = ThreadRuntime.prototype.cancelRun;
  ThreadRuntime.prototype.cancelRun = function cancelRun() {
    if (!this.subagentId) return baseCancel.call(this);
    if (!this._run) return;
    const id = this.subagentId;
    // The composer's square stops only the current step (Interrupt); the header's
    // Stop stops the agent. An engine without interrupt falls back to stop.
    call('interrupt', { id }).catch((e) => (/unknown action|not supported|unsupported/i.test(String(e?.message || e)) ? call('stop', { id }) : Promise.reject(e)))
      .catch((e) => this.host.notify(e?.message || 'It could not be interrupted.', 'error'));
    const message = this._live();
    const content = message.content.map((c) => (c.type === 'tool-call' && c.approval && c.approval.approved === undefined ? { ...c, approval: { ...c.approval, resolution: 'cancelled' } } : c));
    this._commit(this._run.parentId, { ...message, content, status: { type: 'incomplete', reason: 'cancelled' } });
    this._run = null;
    this.emit('runEnd', { messageId: message.id });
  };
  const baseRetry = ThreadRuntime.prototype.retry;
  ThreadRuntime.prototype.retry = function retry(assistantId) {
    if (!this.subagentId) return baseRetry.call(this, assistantId);
    if (this.isRunning || !this.repository.has(assistantId)) return;
    let { parentId } = this.repository.getMessage(assistantId);
    while (parentId && this.repository.getMessage(parentId).message.role !== 'user') parentId = this.repository.getMessage(parentId).parentId;
    if (!parentId) return;
    // Answer that user message again (its later turns are replaced), as in the main chat.
    const turn = Math.max(0, userTurnsBefore(this, parentId));
    const message = this._startAssistant(parentId);
    this.repository.switchToBranch(message.id);
    this._notify();
    call('regenerate', { id: this.subagentId, turn }).catch((e) => this.fail(e?.message || String(e)));
  };
  const baseEditUser = ThreadRuntime.prototype.editUser;
  ThreadRuntime.prototype.editUser = function editUser(userId, text) {
    if (!this.subagentId) return baseEditUser.call(this, userId, text);
    if (this.isRunning || !this.repository.has(userId) || !String(text || '').trim()) return false;
    const turn = Math.max(0, userTurnsBefore(this, userId));
    const { parentId, message: old } = this.repository.getMessage(userId);
    const user = { id: uid(), role: 'user', createdAt: Date.now(), content: [{ type: 'text', text }], attachments: [], metadata: { custom: { ...(old.metadata?.custom || {}) } } };
    this.repository.addOrUpdateMessage(parentId, user);
    this.repository.switchToBranch(user.id);
    this.emit('append', user);
    this._startAssistant(user.id);
    call('edit', { id: this.subagentId, turn, message: text }).catch((e) => this.fail(e?.message || String(e)));
    return true;
  };
  const baseRewound = ThreadRuntime.prototype._sendRewound;
  ThreadRuntime.prototype._sendRewound = function sendRewound(keep, expected, prompt, fallbackPrompt, images) {
    if (!this.subagentId) return baseRewound.call(this, keep, expected, prompt, fallbackPrompt, images);
    (async () => call('edit', { id: this.subagentId, turn: Math.max(0, Number(keep) || 0), message: prompt, ...attachmentsArg(images) }))().catch((e) => this.fail(e?.message || String(e)));
  };

  /* ---- ChatRuntime: send through the sub-agent, open a sub-agent as the main thread ---- */
  const baseSubmit = ChatRuntime.prototype.submit;
  ChatRuntime.prototype.submit = async function submit(runtime, prompt) {
    if (!runtime.subagentId) return baseSubmit.call(this, runtime, prompt);
    // Images picked in the composer ride along (ThreadRuntime.append leaves them here).
    const images = runtime._outgoingImages;
    runtime._outgoingImages = null;
    const r = await call('message', { id: runtime.subagentId, message: prompt, ...attachmentsArg(images) });
    if (r?.subagent && typeof Subagents !== 'undefined') Subagents.onEvent?.({ eventType: 'subagent.update', payloadJson: JSON.stringify(r.subagent) });
    if (r?.resumed === false) this.notify('It is busy: your message reaches it after its current step.', 'success');
  };

  /** Open sub-agent `id` in the chat surface. `back` is the chat to return to. */
  ChatRuntime.prototype.openSubagent = async function openSubagent(id) {
    const rec = recOf(id);
    if (!rec) { this.notify('That sub-agent is not in the list any more.', 'error'); return false; }
    if (this.main?.isRunning && !this.main.subagentId) { this.notify('Stop the current reply before opening a sub-agent as a chat.', 'error'); return false; }
    const key = rec.sessionKey || `subagent:${rec.id}`;
    const runtime = this.runtimeFor(key);
    runtime.subagentId = rec.id;
    runtime.sessionReady = true;
    if (!this.main?.subagentId) this.subagentBack = this.mainId;
    runtime.load(await loadTranscript(rec));
    this.mainId = key;
    // Still working: show it running, with Stop, until its run ends.
    if (isLive(rec) && !runtime._run) runtime._startAssistant(runtime.headId);
    this.emit('main');
    paintHeader();
    return true;
  };
  /** Back to the chat the sub-agent was opened from. */
  ChatRuntime.prototype.closeSubagent = function closeSubagent() {
    const back = this.subagentBack;
    this.subagentBack = null;
    if (back && this.items.has(back)) this.openSession(back);
    else this.newThread?.();
  };
  const baseSwitch = ChatRuntime.prototype.switchToThread;
  ChatRuntime.prototype.switchToThread = function switchToThread(id) {
    // Leaving a sub-agent chat for a normal chat never needs its run stopped.
    if (this.main?.subagentId) { this.subagentBack = null; return this.openSession(id); }
    return baseSwitch.call(this, id);
  };

  /* ---- live updates of the open sub-agent chat ---- */
  const reloadTimers = new Map();
  function scheduleReload(rec, endRun) {
    const chat = appRef?.chat;
    const runtime = chat?.runtimes?.get?.(rec.sessionKey || `subagent:${rec.id}`);
    if (!runtime || !runtime.subagentId) return;
    clearTimeout(reloadTimers.get(rec.id));
    reloadTimers.set(rec.id, setTimeout(async () => {
      const msgs = await loadTranscript(rec);
      if (endRun) {
        runtime._run = null;
        runtime.load(msgs);
        runtime.emit('runEnd', { messageId: runtime.messages[runtime.messages.length - 1]?.id || null });
      } else if (runtime._run) {
        // Keep the running reply at the end; the saved steps go before it.
        const live = runtime._live();
        runtime.load(msgs);
        const m = runtime._startAssistant(runtime.headId);
        if (live?.content?.length) runtime._commit(runtime._run.parentId, { ...m, content: live.content.filter((c) => c.type === 'tool-call' && c.approval && c.approval.approved === undefined) });
      } else runtime.load(msgs);
      runtime._notify?.();
    }, endRun ? 50 : 400));
  }
  function onEvent(event) {
    const type = String(event?.eventType ?? event?.type ?? '');
    if (!type.startsWith('subagent.')) return;
    const p = parseMaybeJSON(event?.payloadJson ?? event?.payload, {}) || {};
    const id = String(p.id || '');
    const rec = recOf(id) || (id ? { id, sessionKey: p.sessionKey } : null);
    if (!rec) return;
    const runtime = appRef?.chat?.runtimes?.get?.(rec.sessionKey || `subagent:${rec.id}`);
    if (!runtime?.subagentId) return;
    const kind = type.slice('subagent.'.length);
    if (kind === 'started' && !runtime._run) runtime._startAssistant(runtime.headId);
    if ((kind === 'tool_call' || kind === 'tool_use') && runtime._run && p.toolCallId) { const a = parseMaybeJSON(p.args ?? p.input, {}) || {}; runtime._patchTool(String(p.toolCallId), { toolName: String(p.tool || p.toolName || 'tool'), args: typeof a === 'object' ? a : {}, argsText: typeof p.args === 'string' ? p.args : JSON.stringify(a) }, true); }
    if (kind === 'tool_result' && runtime._run && p.toolCallId) runtime._patchTool(String(p.toolCallId), { result: p.preview ?? (p.isError ? 'Failed' : 'Done'), isError: !!p.isError }, false);
    if (kind === 'step') scheduleReload(rec, false);
    if (kind === 'finished' || kind === 'error' || kind === 'cancelled') scheduleReload(rec, true);
    if (appRef?.chat?.mainId === (rec.sessionKey || `subagent:${rec.id}`)) paintHeader();
  }

  /* ---- versions: the kept versions of its chat (edits, retries, restores) ---- */
  const REASON = { edit: 'Before an edit', regenerate: 'Before a retry', restore: 'Replaced by a restore' };
  function firstUserText(messages, turn) {
    const users = (messages || []).filter((m) => m?.role === 'user');
    const m = users[Math.min(Math.max(0, turn || 0), users.length - 1)];
    const c = m?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
    return String(t || '').replace(/\s+/g, ' ').trim();
  }
  async function openVersions(rec) {
    let list = [];
    try { list = (await call('branches', { id: rec.id }))?.branches || []; } catch (e) { appRef?.chat?.notify?.(e?.message || 'Its versions could not be loaded.', 'error'); return null; }
    let dialog = null;
    const live = isLive(rec);
    const items = list.slice().reverse().map((b, i) => {
      const msgs = Array.isArray(b.messages) ? b.messages : [];
      const users = msgs.filter((m) => m?.role === 'user').length;
      const when = b.createdAt ? new Date(b.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const restore = h('button', { type: 'button', class: 'btn btn-outline btn-xs', 'data-slot': 'subagent-version-restore', 'data-branch': b.id, disabled: live || undefined,
        title: live ? 'Stop it first: a running agent keeps its current chat.' : undefined,
        onclick: async () => {
          restore.disabled = true;
          try {
            const r = await call('restoreBranch', { id: rec.id, branchId: b.id });
            if (r?.subagent && typeof Subagents !== 'undefined') Subagents.onEvent?.({ eventType: 'subagent.update', payloadJson: JSON.stringify(r.subagent) });
            const runtime = appRef?.chat?.runtimes?.get?.(rec.sessionKey || `subagent:${rec.id}`);
            if (runtime?.subagentId) { const had = !!runtime._run; runtime._run = null; runtime.load(await loadTranscript(rec)); if (had) runtime.emit('runEnd', { messageId: runtime.messages[runtime.messages.length - 1]?.id || null }); runtime._notify?.(); }
            appRef?.chat?.notify?.('Restored that version. The one you had is kept in Versions.', 'success');
            dialog?.close();
          } catch (e) { restore.disabled = false; appRef?.chat?.notify?.(e?.message || 'It could not be restored.', 'error'); }
        } }, icon('rotate-ccw'), 'Restore');
      return h('li', { class: 'sa-version', 'data-slot': 'subagent-version', 'data-branch': b.id },
        h('div', { class: 'sa-version-text' },
          h('p', { class: 'sa-version-title' }, `Version ${list.length - i}`, h('span', { class: 'badge badge-outline' }, REASON[b.reason] || String(b.reason || 'Kept'))),
          h('p', { class: 'field-hint' }, [when, `${msgs.length} message${msgs.length === 1 ? '' : 's'}`, `differs from message ${(Number(b.turn) || 0) + 1} of ${Math.max(users, 1)}`].filter(Boolean).join(' \u00b7 ')),
          firstUserText(msgs, b.turn) ? h('p', { class: 'sa-version-quote truncate' }, `\u201c${firstUserText(msgs, b.turn)}\u201d`) : null),
        restore);
    });
    dialog = openDialog({ title: `Versions of ${rec.name}`, description: 'Each edit or retry keeps the chat it replaced, on the phone, so they are still here after a reload. Restoring one keeps the current chat as a version.', size: 'sm',
      body: items.length ? h('ol', { class: 'sa-versions', 'data-slot': 'subagent-versions' }, ...items) : h('p', { class: 'field-hint', 'data-slot': 'subagent-versions-empty' }, 'No earlier versions yet. Editing a message or retrying a reply keeps the chat it replaces here.'),
      footer: h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Close')) });
    return dialog;
  }

  /* ---- header: who it is, where it sits, and its controls ---- */
  let header = null;
  let lastSig = '';
  function paintHeader() {
    if (!header) return;
    const chat = appRef?.chat;
    const runtime = chat?.main;
    const rec = runtime?.subagentId ? recOf(runtime.subagentId) : null;
    doc.body.dataset.subagentChat = rec ? 'true' : 'false';
    if (!rec) { header.hidden = true; header.replaceChildren(); lastSig = ''; return; }
    const parentId = typeof Subagents !== 'undefined' ? Subagents.parentOf(rec) : null;
    const parent = parentId ? recOf(parentId) : null;
    const sig = JSON.stringify([rec.id, rec.status, rec.title, rec.description, rec.model, rec.depth, parent?.id, parent?.status]);
    if (sig === lastSig) return;
    lastSig = sig;
    header.hidden = false;
    const btn = (label, ic, fn, extra = {}) => h('button', { type: 'button', class: 'btn btn-outline btn-xs', onclick: fn, ...extra }, icon(ic), label);
    const backBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon-sm', 'aria-label': parent ? `Back to ${parent.name}` : 'Back to the main chat', 'data-slot': 'subagent-chat-back',
      onclick: () => (parent ? chat.openSubagent(parent.id) : chat.closeSubagent()) }, icon('arrow-left'));
    const crumbs = [];
    let cur = parent;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); crumbs.unshift(cur); const pid = Subagents.parentOf(cur); cur = pid ? recOf(pid) : null; }
    const crumbEls = [h('button', { type: 'button', class: 'sa-crumb', onclick: () => chat.closeSubagent() }, 'Main agent'),
      ...crumbs.flatMap((c) => [h('span', { class: 'sa-crumb-sep', 'aria-hidden': 'true' }, '\u203a'), h('button', { type: 'button', class: 'sa-crumb', 'data-id': c.id, onclick: () => chat.openSubagent(c.id) }, c.name)]),
      h('span', { class: 'sa-crumb-sep', 'aria-hidden': 'true' }, '\u203a'), h('span', { class: 'sa-crumb sa-crumb-here' }, rec.name)];
    const live = isLive(rec);
    // One line, the same as the panel's header: back, name, status ··· Stop, menu.
    // The path shows as a small line above only when it is nested.
    const stopBtn = live ? AgentTabs.action({ label: 'Stop', icon: 'square', tone: 'danger', slot: 'subagent-chat-stop', hint: 'Stop the agent (its work so far is kept)', onClick: (e) => { e.currentTarget.disabled = true; call('stop', { id: rec.id }).catch((er) => toast(er?.message || 'It could not be stopped.', { type: 'error' })); } })
      : AgentTabs.action({ label: 'Try again', icon: 'rotate-ccw', slot: 'subagent-chat-retry', hint: 'Run the same task again', onClick: () => call('retry', { id: rec.id }).then(() => { if (!runtime._run) runtime._startAssistant(runtime.headId); }).catch((e) => toast(e?.message || 'Retry failed.', { type: 'error' })) });
    const more = AgentTabs.action({ label: 'More actions', icon: 'ellipsis', slot: 'subagent-chat-more' });
    more.dataset.iconOnly = 'true';
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', () => openMenu(more, [
      live ? { label: 'Interrupt', sub: 'Stop the current step; a message goes on', icon: 'hand', onSelect: () => runtime.cancelRun?.(), attrs: { 'data-slot': 'subagent-chat-interrupt' } } : null,
      { label: 'Select messages', sub: 'Or long-press a message', icon: 'square-check', onSelect: () => select?.enter(), attrs: { 'data-slot': 'subagent-chat-select' } },
      canAttach() ? { label: 'Versions', icon: 'history', onSelect: () => openVersions(rec), attrs: { 'data-slot': 'subagent-chat-versions' } } : null,
      { separator: true },
      { label: 'Agent details', sub: 'Overview, activity, settings', icon: 'info', onSelect: () => Subagents.open(appRef, { id: rec.id }), attrs: { 'data-slot': 'subagent-chat-details' } },
      { label: 'Model and limits', icon: 'sliders-horizontal', onSelect: () => Subagents.open(appRef, { id: rec.id, section: 'setup' }), attrs: { 'data-slot': 'subagent-chat-setup' } },
      { label: 'Graph', icon: 'git-fork', onSelect: () => Subagents.open(appRef, { tab: 'diagram' }), attrs: { 'data-slot': 'subagent-chat-graph' } },
    ], { side: 'bottom', align: 'end', label: `${rec.name} actions` }));
    setChildren(header,
      crumbs.length ? h('nav', { class: 'sa-crumbs sa-chat-crumbs truncate', 'aria-label': 'Started by', 'data-slot': 'subagent-chat-crumbs' }, ...crumbEls) : null,
      h('div', { class: 'sa-chat-head-row', 'data-slot': 'subagent-chat-head-row' }, backBtn,
        h('div', { class: 'sa-chat-head-text' },
          h('p', { class: 'sa-chat-head-title', 'data-slot': 'subagent-chat-title', title: [rec.title || rec.name, rec.description, `Level ${rec.depth || 1} \u00b7 ${rec.model || 'main model'}`].filter(Boolean).join('\n') }, rec.title || rec.name),
          typeof AgentTabs !== 'undefined' && AgentTabs.statusChip ? AgentTabs.statusChip(rec.status) : h('span', { class: 'badge', 'data-status': rec.status }, String(rec.status))),
        h('div', { class: 'sa-chat-head-actions', role: 'toolbar', 'aria-label': 'Agent actions', 'data-slot': 'subagent-chat-actions' }, stopBtn, more)),
      rec.description ? h('span', { class: 'sr-only', 'data-slot': 'subagent-chat-desc' }, rec.description) : null);
    header.querySelector('.sa-chat-head-text > :nth-child(2)')?.setAttribute('data-slot', 'subagent-chat-status');
  }

  /* Long-press multi-select in "Open as chat" (09-msg-select.js), the same as the
     panel's Chat tab. Only a sub-agent's chat takes part; the main chat is untouched. */
  let select = null;
  function installSelect(app) {
    const t = app.thread;
    if (!t?.group || typeof MsgSelect === 'undefined') return;
    const inSub = () => doc.body.dataset.subagentChat === 'true';
    const chat = app.chat;
    const msgOf = (el) => (chat?.main?.messages || []).find((m) => m.id === el.dataset.messageId);
    const textOf = (el) => { const m = msgOf(el); if (!m) return el.innerText || ''; try { return (m.role === 'assistant' ? replyText(m) : messageText(m)) || ''; } catch { return el.innerText || ''; } };
    const recNow = () => (chat?.main?.subagentId ? recOf(chat.main.subagentId) : null);
    const st = { on: false, keys: new Set(), anchor: null };
    select = MsgSelect.attach(t.group, {
      items: () => (inSub() ? [...t.group.querySelectorAll('.aui-message[data-message-id]')].filter((el) => textOf(el).trim()) : []),
      keyOf: (el) => el.dataset.messageId,
      textOf,
      whoOf: (el) => (el.dataset.role === 'user' ? 'You' : recNow()?.name || 'Agent'),
      state: st,
      barHost: t.footer,
      actions: [
        { id: 'copy', label: 'Copy', icon: 'copy', run: async (x) => { if (await copyText(x)) toast('Copied.'); else toast("Couldn't copy to the clipboard.", { type: 'error' }); } },
        { id: 'quote', label: 'Quote in message', short: 'Quote', icon: 'quote', run: (x) => { if (t.composer?.quote) t.composer.quote(x); } },
        { id: 'main', label: 'Send to main chat', short: 'To main chat', icon: 'arrow-up-right', primary: true, run: (x) => {
          const r = recNow();
          chat.closeSubagent();
          setTimeout(() => { appRef?.thread?.composer?.quote?.(`From sub-agent ${r?.name || 'agent'}:\n${x}`); toast('Added to your message in the main chat.', { type: 'success' }); }, 0);
        } },
      ],
      onChange: (s2) => { if (t.composer?.el) t.composer.el.hidden = !!s2.on; },
      label: 'message',
    });
    if (t.composer?.el) t.footer.insertBefore(select.bar, t.composer.el);
    // Views repaint their messages: put the checkboxes back, a frame later.
    let queued = false;
    new MutationObserver(() => { if (queued || !inSub()) return; queued = true; requestAnimationFrame(() => { queued = false; select.sync(); }); }).observe(t.group, { childList: true, subtree: true });
    app.chat?.on?.('main', () => { select.exit(); select.sync(); });
  }
  function install(app) {
    appRef = app;
    header = h('div', { class: 'sa-chat-head', 'data-slot': 'subagent-chat-header', role: 'region', 'aria-label': 'Sub-agent', hidden: true });
    const vp = app.thread?.viewport;
    if (vp?.parentNode) vp.parentNode.insertBefore(header, vp);
    installSelect(app);
    app.chat?.on?.('main', () => { lastSig = ''; paintHeader(); });
    if (typeof Subagents !== 'undefined') Subagents.subscribe?.(() => paintHeader());
    const native = kit();
    // Same event stream the chat listens to.
    const runtime = app.chat;
    if (runtime && typeof runtime._onEvent === 'function' && !runtime._scWrapped) {
      const base = runtime._onEvent.bind(runtime);
      runtime._scWrapped = true;
      runtime._onEvent = (event) => {
        try { onEvent(event); } catch (e) { eventLog.add('error', `subagent chat: ${e?.message || e}`); }
        const type = event?.eventType ?? event?.type ?? '';
        const main = runtime.main;
        // While a sub-agent chat is open, the engine's chat events (agent.*, text, tools)
        // belong to normal chats: a sub-agent's own approval goes into its open chat.
        if (main?.subagentId && type === 'approval_request') {
          const n = parseMaybeJSON(event?.payloadJson ?? event?.payload, {}) || {};
          if (String(n.subagent?.id || '') === main.subagentId || (n.subagentSessionKey && n.subagentSessionKey === main.id)) {
            if (!main._run) main._startAssistant(main.headId);
            main.onApproval({ toolCallId: n.toolCallId ?? n.tool_call_id, toolName: n.toolName ?? n.tool_name, args: n.args ?? n.input, requireBiometric: n.requireBiometric ?? n.require_biometric, subagent: n.subagent, subagentSessionKey: n.subagentSessionKey });
            return undefined;
          }
        }
        if (main?.subagentId && /^(agent\.|text|thinking|tool_use|tool_result|tool_call)/.test(type)) {
          const n = parseMaybeJSON(event?.payloadJson ?? event?.payload, {}) || {};
          if (!n.sessionKey) return undefined; // the main agent's stream has no place in a sub-agent's chat
        }
        return base(event);
      };
    }
    void native;
  }

  const api = { install, openSubagent: (id) => appRef?.chat?.openSubagent(id), paintHeader, openVersions: (id) => (recOf(id) ? openVersions(recOf(id)) : null) };
  if (typeof window !== 'undefined') window.__subagentChat = api;
  return api;
})();
