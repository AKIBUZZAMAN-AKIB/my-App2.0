/* ==========================================================================
   Questions the agent asks in the chat, answered with a tap.
     ui__set_theme      switch the app theme (light / dark / system) after the
                        user confirms in a card; the same setting as
                        Settings → General → Theme, with Undo afterwards
     device__ask_user   the device tool's question card. The bridge asks by
                        DOM event (nativekit:agent-ask) and waits for the
                        paired answer event; this draws it in the thread.
   ========================================================================== */
const AskCards = (() => {
  'use strict';
  const THEMES = { light: ['Light', 'sun'], dark: ['Dark', 'moon'], system: ['System', 'monitor'] };
  const THEME_WAIT_S = 120;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const themeName = (t) => (THEMES[t] ? THEMES[t][0] : String(t));
  const settingsNow = () => app?.settings?.get('theme') || 'system';
  const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const looksDark = (t) => t === 'dark' || (t === 'system' && systemDark());
  const describe = (t) => (t === 'system' ? `System (${systemDark() ? 'dark' : 'light'} right now)` : themeName(t));

  /** The card frame shared by both questions (same look as the approval card). */
  function frame({ title, subtitle, iconName, body, actions, state, label }) {
    return h('div', { class: 'aui-approval-card ask-card paper animate-in fade-in slide-up-1 dur-200', 'data-slot': 'ask-card', 'data-state': state, role: 'group', 'aria-label': label || title },
      h('div', { class: 'aui-approval-card-header' },
        h('span', { class: 'aui-approval-card-icon', 'aria-hidden': 'true' }, icon(iconName)),
        h('div', { class: 'ask-card-head' }, h('p', { class: 'aui-approval-card-title' }, title), subtitle ? h('p', { class: 'aui-approval-card-subtitle' }, subtitle) : null)),
      body || null,
      h('div', { class: 'aui-approval-card-actions ask-card-actions' }, actions));
  }
  const receipt = (iconName, text, cls = '') => h('div', { class: 'aui-approval-card-receipt ask-card-receipt animate-in fade-in dur-300', role: 'status', 'data-receipt': '' }, icon(iconName, cls), h('span', {}, text));
  const pill = (label, primary, onclick, extra = {}) => h('button', { type: 'button', class: `aui-pill ${primary ? 'aui-pill-ink' : 'aui-pill-ghost'}`, onclick, ...extra }, label);

  /* ---------- set_theme ---------- */
  const themeAsks = new Map(); // toolCallId -> { theme, from, resolve, answer, el }

  function swatch(t) {
    const dark = looksDark(t);
    return h('span', { class: 'ask-swatch', 'data-dark': String(dark), 'aria-hidden': 'true' }, h('span', { class: 'ask-swatch-bar' }), h('span', { class: 'ask-swatch-line' }), h('span', { class: 'ask-swatch-line short' }));
  }

  function answerTheme(id, yes) {
    const ask = themeAsks.get(id);
    if (!ask || ask.answer) return;
    ask.answer = yes ? 'switched' : 'kept';
    if (yes) app.settings.set({ theme: ask.theme });
    ask.resolve?.(ask.answer);
    redraw(id);
  }
  function redraw(id) {
    const ask = themeAsks.get(id);
    const el = ask?.el;
    if (!el?.isConnected) return;
    const fresh = themeCard({ toolCallId: id, args: { theme: ask.theme }, result: undefined }, { type: 'running' });
    el.replaceWith(fresh);
    fresh.querySelector('[data-receipt]')?.focus?.({ preventScroll: true });
  }

  function parseThemeResult(text) {
    const t = String(text || '');
    if (/^Switched/.test(t)) return 'switched';
    if (/^The user kept/.test(t)) return 'kept';
    if (/^Already/.test(t)) return 'already';
    if (/^No answer/.test(t)) return 'expired';
    return null;
  }

  function themeCard(part, status) {
    const id = part.toolCallId;
    const a = isObj(part.args) ? part.args : {};
    const theme = THEMES[a.theme] ? a.theme : null;
    const ask = themeAsks.get(id);
    if (!theme) return part.result === undefined ? h('p', { class: 'field-hint' }, 'Preparing a theme change…') : h('p', { class: 'field-hint' }, 'The theme was not changed.');
    const name = themeName(theme);
    const from = ask?.from || null;
    const outcome = ask?.answer || (part.result !== undefined ? (part.isError ? 'failed' : parseThemeResult(typeof part.result === 'string' ? part.result : part.result?.output ?? '')) : null);
    let actions; let state;
    if (ask && !ask.answer) {
      state = 'request';
      actions = [
        pill(`Keep ${themeName(ask.from).toLowerCase()}`, false, () => answerTheme(id, false), { 'data-slot': 'ask-card-keep' }),
        pill(`Switch to ${name.toLowerCase()}`, true, () => answerTheme(id, true), { 'data-slot': 'ask-card-confirm' }),
      ];
    } else if (outcome === 'switched') {
      state = 'done';
      const undo = from && from !== theme ? h('button', { type: 'button', class: 'aui-pill aui-pill-ghost', 'data-slot': 'ask-card-undo', onclick: (e) => {
        app.settings.set({ theme: from });
        e.currentTarget.replaceWith(receipt('check', `Back to ${themeName(from).toLowerCase()}`));
      } }, 'Undo') : null;
      actions = [receipt('check', `Switched to ${name.toLowerCase()} theme`), undo];
    } else if (outcome === 'kept') { state = 'denied'; actions = receipt('x', 'Kept the current theme'); }
    else if (outcome === 'already') { state = 'done'; actions = receipt('check', `Already ${name.toLowerCase()}`); }
    else if (outcome === 'expired') { state = 'closed'; actions = receipt('circle-minus', 'No answer; nothing changed'); }
    else if (outcome === 'failed') { state = 'failed'; actions = receipt('circle-x', 'The theme was not changed'); }
    else if (status?.type === 'running') { state = 'preparing'; actions = receipt('loader-circle', 'Waiting…', 'spin'); }
    else { state = 'closed'; actions = receipt('circle-minus', 'Closed before a decision'); }
    const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim().slice(0, 200) : '';
    const body = h('div', { class: 'ask-theme-body' },
      from ? h('span', { class: 'ask-theme-swap' }, swatch(from), icon('chevron-right'), swatch(theme)) : swatch(theme),
      h('p', { class: 'ask-card-text' }, reason || (from ? `From ${describe(from).toLowerCase()} to ${describe(theme).toLowerCase()}.` : `${describe(theme)}.`)));
    const el = frame({ title: state === 'request' ? `Switch to ${name.toLowerCase()} theme?` : `${name} theme`, subtitle: state === 'request' ? 'The assistant asks to change the app theme' : 'App theme', iconName: THEMES[theme][1], body, actions, state, label: `Theme change to ${name.toLowerCase()}` });
    if (ask) ask.el = el;
    return el;
  }

  const setTheme = {
    name: 'set_theme',
    description: 'Switch the app between light, dark and system theme. The user sees a card and confirms or keeps the current theme; the change is the same as Settings → General → Theme and the card offers Undo. Use it only when the user asks for a different look or says the screen is too bright/dark. Widgets and cards follow the theme by themselves, so never call it to style a widget.',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark', 'system'], description: '"system" follows the phone\'s setting.' },
        reason: { type: 'string', description: 'One short line shown on the card, e.g. "Easier on the eyes at night."' },
      },
      required: ['theme'],
    },
    async execute(args, ctx) {
      const theme = String(args?.theme || '').toLowerCase().trim();
      if (!THEMES[theme]) throw new Error('theme must be "light", "dark" or "system".');
      const from = settingsNow();
      if (from === theme) return `Already ${themeName(theme).toLowerCase()} (${describe(theme)}); nothing changed and the user was not asked.`;
      const id = String(ctx?.toolCallId || `local-${Date.now()}`);
      const answer = await new Promise((resolve) => {
        const ask = { theme, from, answer: null, el: null, resolve: null };
        const timer = setTimeout(() => { if (!ask.answer) { ask.answer = 'expired'; redraw(id); resolve('expired'); } }, THEME_WAIT_S * 1000);
        const onAbort = () => { if (!ask.answer) { ask.answer = 'expired'; redraw(id); resolve('expired'); } };
        ask.resolve = (v) => { clearTimeout(timer); ctx?.signal?.removeEventListener?.('abort', onAbort); resolve(v); };
        ctx?.signal?.addEventListener?.('abort', onAbort, { once: true });
        themeAsks.set(id, ask);
        redraw(id);
      });
      if (answer === 'switched') return `Switched to ${themeName(theme).toLowerCase()} theme (was ${themeName(from).toLowerCase()}). The user confirmed; the card offers them Undo.`;
      if (answer === 'kept') return `The user kept the ${themeName(from).toLowerCase()} theme. Do not ask again unless they bring it up.`;
      return `No answer within ${THEME_WAIT_S / 60} minutes; the theme stays ${themeName(from).toLowerCase()}.`;
    },
  };

  /* ---------- device__ask_user ---------- */
  const asks = []; // { requestId, question, options, answer, at }
  const askViews = new Set(); // { el, part }
  const norm = (s) => String(s || '').trim().slice(0, 500);

  function findAsk(part) {
    const q = norm(part.args?.question);
    if (!q) return null;
    const bound = asks.find((a) => a.toolCallId === part.toolCallId);
    if (bound) return bound;
    const free = asks.filter((a) => !a.toolCallId && a.question === q);
    const pick = free[free.length - 1] || null;
    if (pick) pick.toolCallId = part.toolCallId;
    return pick;
  }

  function respond(ask, index) {
    if (!ask || ask.answer) return;
    ask.answer = { answer: ask.options[index], index };
    window.dispatchEvent(new CustomEvent('nativekit:agent-ask-response', { detail: { requestId: ask.requestId, answer: ask.answer } }));
    refreshAsks();
  }

  function refreshAsks() {
    for (const v of [...askViews]) {
      if (!v.el.isConnected) { askViews.delete(v); continue; }
      const fresh = askCard(v.part, v.status);
      v.el.replaceWith(fresh);
      askViews.delete(v);
    }
  }

  function askCard(part, status) {
    const a = isObj(part.args) ? part.args : {};
    const question = norm(a.question);
    const options = (Array.isArray(a.options) ? a.options : []).map((o) => String(o ?? '').trim().slice(0, 60)).filter(Boolean).slice(0, 6);
    const ask = findAsk(part);
    const resultText = typeof part.result === 'string' ? part.result : part.result?.output ?? part.result?.content?.[0]?.text ?? '';
    const chosenFromResult = /The user chose: (.+)/.exec(String(resultText))?.[1]?.trim();
    const chosen = ask?.answer?.answer ?? chosenFromResult ?? null;
    const noAnswer = !chosen && (/did not answer/.test(String(resultText)) || (part.result !== undefined && !ask));
    let state; let actions;
    if (ask && !ask.answer && part.result === undefined) {
      state = 'request';
      actions = h('div', { class: 'ask-options', role: 'group', 'aria-label': 'Answers' }, ask.options.map((o, i) => pill(o, false, () => respond(ask, i), { class: 'aui-pill ask-option', 'data-slot': 'ask-option' })));
    } else if (chosen) { state = 'done'; actions = receipt('check', `You chose: ${chosen}`); }
    else if (noAnswer) { state = 'closed'; actions = receipt('circle-minus', 'No answer in time'); }
    else { state = 'preparing'; actions = receipt('loader-circle', 'Opening the question…', 'spin'); }
    const el = frame({
      title: question || 'A question', subtitle: state === 'request' ? 'Tap an answer' : null, iconName: 'messages-square', state, label: question,
      body: state !== 'request' && options.length ? h('ul', { class: 'ask-chosen', 'aria-label': 'Options' }, options.map((o) => h('li', { 'data-chosen': String(o === chosen) }, o))) : null,
      actions,
    });
    if (!(state === 'done' || state === 'closed')) askViews.add({ el, part, status });
    return el;
  }

  function install() {
    GenUI.addTools([setTheme], themeCard);
    TOOLKIT.device__ask_user = { ...(TOOLKIT.device__ask_user || {}), ui: askCard };
    window.addEventListener('nativekit:agent-ask', (event) => {
      const d = event?.detail || {};
      const requestId = String(d.requestId || '');
      const question = norm(d.question);
      const options = (Array.isArray(d.options) ? d.options : []).map((o) => String(o ?? '').trim().slice(0, 60)).filter(Boolean).slice(0, 6);
      if (!requestId || !question || options.length < 2) return;
      asks.push({ requestId, question, options, answer: null, at: Date.now(), toolCallId: null });
      if (asks.length > 50) asks.splice(0, asks.length - 50);
      refreshAsks();
    });
  }

  return { install, setTheme, themeAsks, asks };
})();
