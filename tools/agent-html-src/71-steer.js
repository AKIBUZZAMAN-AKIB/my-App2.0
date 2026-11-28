/* Steer and Update (docs/steer/PLAN.bn.md, step 0).

   While a reply runs, two symbol buttons sit beside the composer's queue button:
   - Steer (navigation arrow): the typed words go to the running turn now, through
     NativeKit.agent.steer({ text, id, mode: 'steer' }). The engine delivers them at
     the next safe point, inside the same turn.
   - Update (pen): the same, with mode 'update' (the user wants the task changed).
   Enter while a reply runs still queues, as before: steering is always a deliberate tap.

   Each steer gets a bubble above the composer: pending (sent, waiting for a safe point)
   -> applied (the model has it), or "not applied" with a Send as message button when
   the turn ended first. After the turn the engine's transcript shows steer messages in
   place, styled as steers (agent.html convertEngineMessages / UserMessageView).
   On start the engine's steer inbox is read: steers that never reached the model (the
   app closed in between) are shown so the user can send or dismiss them. */
const SteerUI = (() => {
  let appRef = null;
  let installed = false;
  let strip = null;
  const items = new Map(); // id -> { id, text, mode, status, at }

  Object.assign(ICONS, {
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  });

  const agentApi = () => nativeKit()?.agent;
  const newId = () => `st-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;

  function composer() { return appRef?.thread?.composer || null; }

  function mountStrip() {
    const c = composer();
    if (!c?.el) return false;
    if (!strip) strip = h('div', { class: 'st-strip', 'data-slot': 'steer-strip', role: 'list', 'aria-label': 'Steers', 'aria-live': 'polite', hidden: true });
    if (strip.parentElement !== c.el) c.el.insertBefore(strip, c.shell || c.el.firstChild);
    return true;
  }

  const LABEL = { pending: 'Sending…', accepted: 'Waiting for a safe point', applied: 'Applied', unapplied: 'Not applied', failed: 'Failed', answered: 'Answered', routed: 'Sent to sub-agent' };

  function render() {
    if (!mountStrip()) return;
    const list = [...items.values()];
    strip.hidden = list.length === 0;
    strip.replaceChildren(...list.map((it) => h('div', {
      class: 'st-bubble', role: 'listitem', 'data-steer-id': it.id, 'data-status': it.status, 'data-mode': it.mode,
    },
    h('span', { class: 'st-bubble-icon', 'aria-hidden': 'true' }, icon(it.mode === 'update' ? 'square-pen' : 'navigation')),
    h('span', { class: 'st-bubble-text', dir: 'auto' }, it.text),
    h('span', { class: 'st-bubble-status', 'data-slot': 'steer-status' }, it.answer ? `${LABEL[it.status]}: ${it.answer}` : (LABEL[it.status] || it.status)),
    it.status === 'unapplied' && h('button', { type: 'button', class: 'st-bubble-btn', 'data-action': 'steer-resend', onclick: () => resend(it) }, 'Send as message'),
    (it.status === 'unapplied' || it.status === 'failed' || it.status === 'applied' || it.status === 'answered' || it.status === 'routed') && h('button', { type: 'button', class: 'st-bubble-btn st-bubble-x', 'aria-label': 'Dismiss', 'data-action': 'steer-dismiss', onclick: () => dismiss(it) }, icon('x')))));
  }

  function set(id, patch) {
    const it = items.get(id);
    if (!it) return;
    // Never move back: applied is final unless the engine says otherwise explicitly.
    if (it.status === 'applied' && patch.status === 'accepted') return;
    Object.assign(it, patch);
    render();
  }

  async function steer(mode) {
    const c = composer();
    if (!c) return;
    const text = c.input.value.trim();
    if (!text) return;
    const api = agentApi();
    if (!api?.steer) { toast('Steering needs the native engine.', { type: 'error' }); return; }
    const id = newId();
    items.set(id, { id, text, mode, status: 'pending', at: Date.now() });
    c.input.value = '';
    c.autosize?.();
    try { Drafts.save(c.runtime.id, ''); } catch { /* no draft store */ }
    c.sync();
    render();
    try {
      await api.steer({ text, id, mode });
    } catch (e) {
      set(id, { status: 'failed' });
      toast(e?.message || 'The steer could not be sent.', { type: 'error' });
    }
  }

  function resend(it) {
    items.delete(it.id);
    render();
    try { agentApi()?.subagents?.({ action: 'steer.dismiss', id: it.id }); } catch { /* best effort */ }
    const c = composer();
    if (!c) return;
    c.input.value = it.text;
    c.send();
  }

  function dismiss(it) {
    items.delete(it.id);
    render();
    if (it.status === 'unapplied') { try { agentApi()?.subagents?.({ action: 'steer.dismiss', id: it.id }); } catch { /* best effort */ } }
  }

  function onEvent(type, n) {
    const id = n.id ?? (Array.isArray(n.ids) ? n.ids[0] : undefined);
    switch (type) {
      case 'steer.accepted':
        if (!items.has(id) && id) items.set(id, { id, text: n.text || '', mode: n.mode || 'steer', status: 'accepted', at: Date.now() });
        set(id, { status: 'accepted' });
        break;
      case 'steer.applied': set(id, { status: 'applied' }); break;
      case 'steer.unapplied':
        if (!items.has(id) && id && n.text) items.set(id, { id, text: n.text, mode: 'steer', status: 'unapplied', at: Date.now() });
        set(id, { status: 'unapplied' });
        break;
      case 'steer.answer': set(id, { status: 'answered', answer: n.text || '' }); break;
      case 'steer.routed': if (n.ok) set(id, { status: 'routed' }); break;
      default: break;
    }
  }

  /** Applied bubbles leave once the turn is over (the transcript holds them now). */
  function onTurnEnd() {
    let changed = false;
    for (const [k, it] of items) if (it.status === 'applied' || it.status === 'routed') { items.delete(k); changed = true; }
    if (changed) render();
  }

  async function loadInbox() {
    const api = agentApi();
    if (!api?.subagents) return;
    try {
      const res = await api.subagents({ action: 'steer.inbox' });
      const v = parseMaybeJSON(res?.json ?? res?.resultJson ?? res, {}) || {};
      for (const r of v.steers || []) {
        if (!items.has(r.id)) items.set(r.id, { id: r.id, text: r.text, mode: 'steer', status: 'unapplied', at: r.at });
      }
      render();
    } catch { /* older engine without steer actions */ }
  }

  function addButtons() {
    const c = composer();
    if (!c || c.steerButton) return;
    c.steerButton = h('button', {
      type: 'button', class: 'aui-composer-round aui-composer-steer', 'data-tooltip': 'Steer now', 'aria-label': 'Steer: send to the running reply now', hidden: true,
      onclick: () => steer('steer'),
    }, icon('navigation'));
    c.updateButton = h('button', {
      type: 'button', class: 'aui-composer-round aui-composer-update', 'data-tooltip': 'Update the task', 'aria-label': 'Update: change the running task', hidden: true,
      onclick: () => steer('update'),
    }, icon('square-pen'));
    c.queueButton.before(c.steerButton, c.updateButton);
    const baseSync = c.sync.bind(c);
    c.sync = () => {
      baseSync();
      const show = !!c.runtime?.isRunning && !!c.input.value.trim() && c.attachments.length === 0;
      c.steerButton.hidden = !show;
      c.updateButton.hidden = !show;
      c.steerButton.disabled = c.busy > 0;
      c.updateButton.disabled = c.busy > 0;
    };
    c.sync();
  }

  function install(app) {
    appRef = app;
    if (installed) return;
    installed = true;
    addButtons();
    const runtime = app.chat;
    if (runtime && typeof runtime._onEvent === 'function' && !runtime._steerWrapped) {
      const base = runtime._onEvent.bind(runtime);
      runtime._steerWrapped = true;
      runtime._onEvent = (event) => {
        const type = event?.eventType ?? event?.type ?? '';
        if (typeof type === 'string' && type.startsWith('steer.')) {
          const n = parseMaybeJSON(event?.payloadJson ?? event?.payload ?? event?.data, {}) || {};
          try { eventLog.add(type, n); } catch { /* no log */ }
          if (!n.sessionKey || n.sessionKey === runtime.main?.id) onEvent(type, n);
          return undefined;
        }
        const r = base(event);
        if (type === 'agent.completed' || type === 'agent.error' || type === 'agent.cancelled') { onTurnEnd(); composer()?.sync(); }
        return r;
      };
    }
    runtime?.on?.('main', () => { items.clear(); render(); composer()?.sync(); });
    setTimeout(loadInbox, 600);
    window.__steer = { items, steer, render };
  }

  return { install };
})();
