/* A sub-agent opened as a chat of its own, in the same chat surface as the main agent:
   the same thread, message renderer, tool cards, approval cards, composer, Stop,
   copy/edit/retry and branch controls. What the main agent does through the chat
   session, a sub-agent does through the engine's sub-agent actions:
     send     -> subagents { action: 'message' }   (runs it again, or queues while busy)
     Stop     -> subagents { action: 'cancel' }
     edit     -> subagents { action: 'edit', turn } (cuts its chat back, sends the new text)
     retry    -> subagents { action: 'regenerate' }
     approval -> respondToApproval (the request id is the engine's)
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
    call('stop', { id }).catch((e) => this.host.notify(e?.message || 'It could not be stopped.', 'error'));
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
    call('edit', { id: this.subagentId, turn: Math.max(0, Number(keep) || 0), message: prompt }).catch((e) => this.fail(e?.message || String(e)));
  };

  /* ---- ChatRuntime: send through the sub-agent, open a sub-agent as the main thread ---- */
  const baseSubmit = ChatRuntime.prototype.submit;
  ChatRuntime.prototype.submit = async function submit(runtime, prompt) {
    if (!runtime.subagentId) return baseSubmit.call(this, runtime, prompt);
    const r = await call('message', { id: runtime.subagentId, message: prompt });
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
    header.replaceChildren(
      h('div', { class: 'sa-chat-head-row' }, backBtn,
        h('div', { class: 'sa-chat-head-text' },
          h('nav', { class: 'sa-crumbs truncate', 'aria-label': 'Started by', 'data-slot': 'subagent-chat-crumbs' }, ...crumbEls),
          h('p', { class: 'sa-chat-head-title truncate', 'data-slot': 'subagent-chat-title' }, rec.title || rec.name),
          rec.description ? h('p', { class: 'sa-chat-head-desc truncate', 'data-slot': 'subagent-chat-desc', title: rec.description }, rec.description) : null),
        h('span', { class: 'badge', 'data-status': rec.status, 'data-slot': 'subagent-chat-status' }, String(rec.status))),
      h('div', { class: 'sa-chat-head-actions', 'data-slot': 'subagent-chat-actions' },
        h('span', { class: 'field-hint' }, `Level ${rec.depth || 1} \u00b7 ${rec.model || 'main model'}`),
        h('span', { class: 'sa-spacer' }),
        live ? btn('Stop', 'square', () => runtime.cancelRun?.() || call('stop', { id: rec.id }), { 'data-slot': 'subagent-chat-stop' }) : btn('Retry', 'refresh-cw', () => call('retry', { id: rec.id }).then(() => { if (!runtime._run) runtime._startAssistant(runtime.headId); }).catch((e) => toast(e?.message || 'Retry failed.', { type: 'error' })), { 'data-slot': 'subagent-chat-retry' }),
        btn('Setup', 'sliders-horizontal', () => Subagents.open(appRef, { id: rec.id, section: 'setup' }), { 'data-slot': 'subagent-chat-setup' }),
        btn('Graph', 'git-fork', () => Subagents.open(appRef, { tab: 'diagram' }), { 'data-slot': 'subagent-chat-graph' })));
  }

  function install(app) {
    appRef = app;
    header = h('div', { class: 'sa-chat-head', 'data-slot': 'subagent-chat-header', role: 'region', 'aria-label': 'Sub-agent', hidden: true });
    const vp = app.thread?.viewport;
    if (vp?.parentNode) vp.parentNode.insertBefore(header, vp);
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

  const api = { install, openSubagent: (id) => appRef?.chat?.openSubagent(id), paintHeader };
  if (typeof window !== 'undefined') window.__subagentChat = api;
  return api;
})();
