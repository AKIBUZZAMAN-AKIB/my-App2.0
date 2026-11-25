/* Running sub-agents pill.

   A small pill just above the chat composer while sub-agents of this chat are working:
   "2 sub-agents running", or "1 needs approval" in amber when one is waiting for the user.
   Tapping it opens the Agents panel (on the agent that needs approval, when there is one).
   It is the same idea as the background-task chip in Cursor, Devin and ChatGPT: you can see
   that work is going on without opening a panel, and it disappears when everything is done.

   It listens to the Subagents store (10-subagents.js) and only touches the DOM when the
   counts change, so live events cost nothing while the numbers stay the same. */
const AgentsPill = (() => {
  let appRef = null;
  let pill = null;
  let lastSig = '';

  /** Find the composer and put the pill right above it (the composer can be rebuilt). */
  function mount() {
    const composer = document.querySelector('.aui-composer-root');
    if (!composer) return false;
    if (!pill) {
      pill = h('button', { type: 'button', class: 'sa-run-pill', 'data-slot': 'subagents-pill', hidden: true, 'aria-live': 'polite' });
      pill.addEventListener('click', () => {
        const S = window.__subagents;
        if (!S) return;
        // Jump straight to the agent that waits for an approval; else open the list.
        const waiting = S.recordsOf().find((r) => r.status === 'waiting_approval');
        S.open(appRef, waiting ? { id: waiting.id } : {});
      });
    }
    if (pill.parentElement !== composer.parentElement || pill.nextElementSibling !== composer) composer.before(pill);
    return true;
  }

  function update() {
    const S = window.__subagents;
    if (!S || !S.available?.()) { if (pill) pill.hidden = true; return; }
    const list = S.recordsOf();
    const waiting = list.filter((r) => r.status === 'waiting_approval').length;
    const running = list.filter((r) => r.status === 'running' || r.status === 'queued').length;
    const sig = `${running}|${waiting}`;
    if (sig === lastSig && pill?.isConnected) return;
    lastSig = sig;
    if (!mount()) return;
    if (!running && !waiting) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.dataset.tone = waiting ? 'wait' : 'run';
    const text = waiting ? `${waiting} needs approval${running ? ` · ${running} running` : ''}` : `${running} sub-agent${running === 1 ? '' : 's'} running`;
    pill.setAttribute('aria-label', `${text}. Open Agents`);
    pill.replaceChildren(
      h('span', { class: 'at-dot', 'data-tone': waiting ? 'wait' : 'run', 'data-live': 'true', 'aria-hidden': 'true' }),
      h('span', { class: 'sa-run-pill-text' }, text),
      icon('chevron-right'));
  }

  function install(app) {
    appRef = app;
    const S = window.__subagents;
    if (!S?.subscribe) return;
    S.subscribe(update);
    // Switching chats changes which agents count: check again when the open chat changes.
    app?.chat?.on?.('main', () => { lastSig = ''; update(); });
    update();
  }

  return { install, update };
})();
