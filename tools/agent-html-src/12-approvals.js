/* Approvals tray: tool approvals that cannot sit in the open chat's live
   message. That is (1) a request from another chat, and (2) a sub-agent's
   request while the open chat's own run is not live (the main agent already
   finished, or never started). Each is answered straight through the engine
   (respondToApproval needs only the request id), so a sub-agent never stays
   stuck because its parent run ended, the open chat never pretends to be
   running, and a request is shown only in the chat it belongs to. */
const PendingApprovals = (() => {
  const items = new Map(); // approval id -> request
  const listeners = new Set();
  let appRef = null;
  let installed = false;
  let tray = null;

  function parseResult(r) {
    if (r == null) return {};
    if (typeof r === 'string') return parseMaybeJSON(r, {}) || {};
    if (typeof r.resultJson === 'string') return parseMaybeJSON(r.resultJson, {}) || {};
    if (typeof r.json === 'string') return parseMaybeJSON(r.json, {}) || {};
    return r;
  }
  const currentKey = () => appRef?.chat?.mainId || appRef?.chat?.main?.id || '';
  const titleOf = (key) => {
    const it = appRef?.chat?.items?.get?.(String(key || ''));
    return (it && it.title && it.title !== key ? it.title : '') || 'another chat';
  };
  const notify = () => { render(); for (const fn of listeners) { try { fn(); } catch { /* listener */ } } };

  function add(req) {
    const id = String(req?.toolCallId || '');
    if (!id || items.has(id)) return;
    const a = parseMaybeJSON(req.args, {}) || {};
    const sub = req.subagent && typeof req.subagent === 'object' && req.subagent.id ? { id: String(req.subagent.id), name: String(req.subagent.name || req.subagent.id) } : null;
    items.set(id, {
      id, toolName: String(req.toolName || 'tool'), args: a, requireBiometric: !!req.requireBiometric, subagent: sub,
      sessionKey: String(req.sessionKey || currentKey()), subagentSessionKey: req.subagentSessionKey ? String(req.subagentSessionKey) : '', at: Date.now(), busy: false,
    });
    if (items.get(id).sessionKey !== currentKey()) toast(`${titleOf(items.get(id).sessionKey)} needs your approval for ${items.get(id).toolName}.`, { type: 'default' });
    notify();
  }
  const has = (id) => items.has(String(id));
  const list = (sessionKey) => [...items.values()].filter((r) => sessionKey === undefined || r.sessionKey === sessionKey);
  /** A sub-agent ended: the engine no longer waits for its requests. */
  function dropFor(subagentId) {
    let n = 0;
    for (const [k, r] of items) if (r.subagent?.id === String(subagentId)) { items.delete(k); n += 1; }
    if (n) notify();
  }
  /** A chat's own run ended: its own (not sub-agent) requests expired with it. */
  function dropSession(sessionKey) {
    let n = 0;
    for (const [k, r] of items) if (r.sessionKey === sessionKey && !r.subagent) { items.delete(k); n += 1; }
    if (n) notify();
  }

  /**
   * "Always allow": where it applies follows Limits > "Always allow covers"
   * (engine setting alwaysAllowScope, default "chat"). Returns 'chat' when it
   * was saved for the chat (and every sub-agent started from it), 'global'
   * when the caller should save the tool's permission everywhere, or 'none'
   * when the chat-scoped save failed (the request is then allowed once).
   */
  async function allowAlways(toolName, sessionKey) {
    const scope = (typeof Subagents !== 'undefined' && Subagents.settings?.alwaysAllowScope) === 'global' ? 'global' : 'chat';
    const kit = nativeKit();
    if (scope === 'global' || !engine.has('subagentChatAllow') || typeof kit?.agent?.subagents !== 'function') return 'global';
    try {
      parseResult(await kit.agent.subagents({ action: 'allowTool', sessionKey: String(sessionKey || currentKey()), toolName: String(toolName) }));
      return 'chat';
    } catch (e) {
      eventLog.add('error', `allowTool: ${e?.message || e}`);
      return 'none';
    }
  }

  async function answer(id, { approved, optionId, reason, modifiedArgs } = {}) {
    const req = items.get(String(id));
    if (!req || req.busy) return false;
    req.busy = true;
    render();
    let ok = !!approved;
    let why = ok ? undefined : (reason || DENIED_REASON);
    if (ok && req.requireBiometric) {
      try { ok = await bridge.verifyBiometric(req.toolName); if (!ok) why = 'Biometric verification did not succeed; action denied.'; } catch (e) { ok = false; why = `Biometric unavailable: ${e?.message || e}`; }
    }
    try {
      let res;
      let scope = '';
      if (ok && modifiedArgs && engine.has('approvalWithArgs')) res = await bridge.respondToApprovalWithArgs(req.id, true, reason, modifiedArgs);
      else {
        const always = ok && optionId === 'allow-always' && !req.requireBiometric;
        if (always) {
          scope = await allowAlways(req.toolName, req.subagentSessionKey || req.sessionKey);
          if (scope === 'global') { try { await bridge.setToolPermission(req.toolName, 'always_allow', true); } catch (e) { eventLog.add('error', `setToolPermission: ${e?.message || e}`); } }
        }
        res = await bridge.respondToApproval(req.id, ok, ok ? undefined : why);
      }
      items.delete(req.id);
      if (res && res.delivered === false) toast('The agent stopped waiting for this approval.', { type: 'error' });
      else if (scope === 'chat') toast(`${req.toolName} will run without asking in this chat and its sub-agents.`, { type: 'success' });
      else if (scope === 'global') toast(`${req.toolName} will run without asking from now on.`, { type: 'success' });
      else toast(ok ? 'Allowed.' : 'Denied.', { type: ok ? 'success' : 'default' });
      if (scope === 'chat' || scope === 'global') {
        // Other requests for the same tool that this answer now covers.
        for (const other of [...items.values()]) if (other.toolName === req.toolName && !other.requireBiometric && (scope === 'global' || other.sessionKey === req.sessionKey)) answer(other.id, { approved: true });
      }
      notify();
      return true;
    } catch (e) {
      req.busy = false;
      toast(e?.message || 'The answer could not be sent to the agent.', { type: 'error' });
      notify();
      return false;
    }
  }

  function partFor(r) {
    return { type: 'tool-call', toolCallId: r.id, toolName: r.toolName, args: r.args, argsText: JSON.stringify(r.args), approval: { id: r.id, requireBiometric: r.requireBiometric, ...(r.subagent ? { subagent: r.subagent } : {}) } };
  }
  function render() {
    if (!tray) return;
    const key = currentKey();
    const mine = list(key).sort((a, b) => a.at - b.at);
    const others = list().filter((r) => r.sessionKey !== key);
    const rows = mine.map((r) => h('div', { class: 'ap-item', 'data-approval-id': r.id, 'data-busy': r.busy ? 'true' : 'false' },
      renderApprovalCard(partFor(r), { type: 'requires-action' }, (approved, optionId, reason, modifiedArgs) => answer(r.id, { approved, optionId, reason, modifiedArgs }))));
    const firstOther = others[0];
    const otherRow = others.length ? h('div', { class: 'ap-other', role: 'status', 'data-slot': 'approvals-other-chats' }, icon('messages-square'),
      h('span', { class: 'truncate' }, others.length === 1 ? `${titleOf(firstOther.sessionKey)} needs your approval` : `${others.length} approvals waiting in other chats`),
      h('button', { type: 'button', class: 'btn btn-outline btn-xs', onclick: () => appRef?.chat?.openSession?.(firstOther.sessionKey) }, 'Open')) : null;
    tray.replaceChildren(...rows, ...(otherRow ? [otherRow] : []));
    tray.hidden = !rows.length && !otherRow;
  }

  function install(app) {
    appRef = app;
    if (installed) return;
    installed = true;
    tray = h('div', { class: 'ap-tray', 'data-slot': 'approvals-tray', role: 'region', 'aria-label': 'Waiting for your approval', hidden: true });
    const footer = app.thread?.footer;
    const composerEl = app.thread?.composer?.el;
    if (footer && composerEl && composerEl.parentNode === footer) footer.insertBefore(tray, composerEl);
    else if (footer) footer.prepend(tray);
    const runtime = app.chat;
    runtime?.on?.('main', render);
    if (runtime && typeof runtime._onEvent === 'function' && !runtime._apWrapped) {
      const base = runtime._onEvent.bind(runtime);
      runtime._apWrapped = true;
      runtime._onEvent = (event) => {
        const type = event?.eventType ?? event?.type ?? '';
        if (type === 'agent.completed' || type === 'agent.error' || type === 'agent.cancelled') {
          const n = parseMaybeJSON(event?.payloadJson ?? event?.payload, {}) || {};
          if (n.sessionKey && n.sessionKey !== runtime.mainId) dropSession(String(n.sessionKey));
        }
        return base(event);
      };
    }
  }

  const api = { add, has, list, answer, dropFor, dropSession, allowAlways, install, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  if (typeof window !== 'undefined') window.__approvals = api;
  return api;
})();
