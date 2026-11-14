// One action bar per assistant turn. The engine stores a turn as one assistant
// message per step (reasoning, each round of tool calls, the final answer), and
// each step used to get its own Copy / Regenerate / ... bar with a timestamp.
// Checks, at 320/375/768/1366 px in light and dark:
//  - while streaming: no bar at all;
//  - after agent.completed (the engine's per-step display messages): one bar, under the final answer;
//  - after a reload of the saved history: the same;
//  - Copy copies the whole turn's answer, Regenerate resends the turn's user message once.
// Mock NativeKit only; no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const { schemaGuard } = require('./tool-schemas.js');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const mock = fs.readFileSync(path.join(__dirname, 'mock3.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

// A turn as the engine stores it: reasoning, then 2 tool calls, then 3 more, then the answer.
const T0 = Date.now() - 600e3;
const steps = (prompt) => [
  { role: 'user', content: prompt, createdAt: T0 },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'The user wants a summary. I should list the files first.' }], createdAt: T0 + 1000 },
  { role: 'assistant', content: [{ type: 'text', text: 'Let me look at your files.' }], tool_calls: [{ id: 'a1', name: 'list_files', input: { path: '.' } }, { id: 'a2', name: 'find_files', input: { pattern: '*.md' } }], createdAt: T0 + 2000 },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'Now read the notes.' }], tool_results: [{ tool_call_id: 'a1', output: '{"entries":[]}' }, { tool_call_id: 'a2', output: '{"files":["notes.md"]}' }], tool_calls: [{ id: 'b1', name: 'read_file', input: { path: 'notes.md' } }, { id: 'b2', name: 'read_file', input: { path: 'todo.md' } }, { id: 'b3', name: 'memory_search', input: { query: 'files' } }], createdAt: T0 + 3000 },
  { role: 'assistant', content: 'Here is the summary: **notes.md** has 3 ideas and todo.md has 2 tasks.', tool_results: [{ tool_call_id: 'b1', output: 'ideas' }, { tool_call_id: 'b2', output: 'tasks' }, { tool_call_id: 'b3', output: '[]' }], createdAt: T0 + 4000 },
];
const HISTORY = [...steps('Summarize my files'), { role: 'user', content: 'Thanks!', createdAt: T0 + 5000 }, { role: 'assistant', content: 'You are welcome.', createdAt: T0 + 6000 }];

const extraMock = `(() => {
  const a = window.NativeKit.agent;
  const inner = a.loadSession;
  a.loadSession = async (k, id) => (k === 'chat-1690000000000' ? { messagesJson: ${JSON.stringify(JSON.stringify(HISTORY))} } : inner(k, id));
  window.__copied = [];
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } }); } catch {}
})();`;

const bars = (p) => p.evaluate(() => {
  const list = [...document.querySelectorAll('[data-role="assistant"], .aui-assistant-message-root')].filter((el, i, all) => !all.some((o) => o !== el && o.contains(el)));
  return list.map((m) => ({
    bar: !!m.querySelector('.aui-assistant-action-bar-root'),
    text: m.innerText.replace(/\s+/g, ' ').slice(0, 400),
    tools: m.querySelectorAll('.aui-tool-fallback-root, .aui-tool-group-root').length,
    reasoning: m.querySelectorAll('.aui-reasoning-root, [data-slot="reasoning"]').length,
  }));
});

async function open(browser, { w, h, mobile, dark }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(extraMock);
  await ctx.addInitScript(schemaGuard);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(250);
  return { p, ctx, errs };
}

async function run(browser, size, dark) {
  const tag = `[${size.w}${dark ? ' dark' : ''}]`;
  const { p, ctx, errs } = await open(browser, { ...size, dark });
  await p.evaluate(() => window.__app.startNewChat?.());
  await sleep(200);
  await p.locator('.aui-composer-input').fill('Summarize my files');
  await p.locator('.aui-composer-send').click();
  await sleep(300);
  const k = await p.evaluate(() => { const c = [...window.__mock.calls].reverse(); return c.find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey || c.find((x) => x.name === 'agent.sendMessage')?.args?.sessionKey || 'main'; });
  // Stream the turn step by step.
  const live = [
    ['thinking_delta', { text: 'The user wants a summary. ' }],
    ['tool_use', { toolCallId: 'a1', toolName: 'list_files', args: { path: '.' } }],
    ['tool_use', { toolCallId: 'a2', toolName: 'find_files', args: { pattern: '*.md' } }],
    ['tool_result', { toolCallId: 'a1', result: { output: '{"entries":[]}' } }],
    ['tool_result', { toolCallId: 'a2', result: { output: '{"files":["notes.md"]}' } }],
    ['thinking_delta', { text: 'Now read the notes.' }],
    ['tool_use', { toolCallId: 'b1', toolName: 'read_file', args: { path: 'notes.md' } }],
    ['tool_result', { toolCallId: 'b1', result: { output: 'ideas' } }],
    ['text_delta', { text: 'Here is the summary: **notes.md** has 3 ideas ' }],
  ];
  let barsWhileStreaming = 0;
  for (const [name, payload] of live) {
    await p.evaluate(([name, payload, k]) => window.__mock.emit(name, { sessionKey: k, ...payload }), [name, payload, k]);
    await sleep(60);
    barsWhileStreaming = Math.max(barsWhileStreaming, (await bars(p)).filter((b) => b.bar).length);
  }
  ck(`${tag} no action bar while the turn streams`, barsWhileStreaming === 0, String(barsWhileStreaming));
  // The engine completes with its stored per-step messages.
  const display = steps('Summarize my files').map((m) => ({ ...m }));
  await p.evaluate(([k, list]) => { window.__mock.emit('text_delta', { sessionKey: k, text: 'and todo.md has 2 tasks.' }); window.__mock.emit('agent.completed', { sessionKey: k, displayMessagesJson: JSON.stringify(list) }); }, [k, display]);
  await sleep(500);
  let b = await bars(p);
  const assistants = b.length;
  ck(`${tag} after completion the turn is one assistant message with one action bar`, assistants === 1 && b.filter((x) => x.bar).length === 1 && b[0].bar, JSON.stringify(b));
  ck(`${tag} that message keeps the reasoning, both tool rounds and the answer, in order`, b[0] && b[0].tools >= 1 && /summary/.test(b[0].text), JSON.stringify(b[0]));
  const barBelowAnswer = await p.evaluate(() => {
    const bar = document.querySelector('.aui-assistant-action-bar-root');
    const answer = [...document.querySelectorAll('.aui-md p, .aui-md')].find((e) => /Here is the summary/.test(e.textContent));
    return !!bar && !!answer && bar.getBoundingClientRect().top >= answer.getBoundingClientRect().bottom - 1;
  });
  ck(`${tag} the bar sits under the final answer`, barBelowAnswer);
  // Copy acts on the whole turn's answer.
  const copyBtn = p.locator('.aui-assistant-action-bar-root button[aria-label="Copy"]').first();
  await copyBtn.click({ force: true });
  await sleep(200);
  const copied = await p.evaluate(() => window.__copied.at(-1) || '');
  ck(`${tag} Copy copies the turn's text, intro and answer`, /Let me look at your files\./.test(copied) && /Here is the summary/.test(copied) && !/The user wants a summary/.test(copied), JSON.stringify(copied).slice(0, 200));
  // Regenerate resends the turn's user message, once.
  const SENDS = ['agent.sendMessage', 'agent.followUp'];
  const before = await p.evaluate((S) => window.__mock.calls.filter((c) => S.includes(c.name)).length, SENDS);
  await p.locator('.aui-assistant-action-bar-root button[aria-label="Regenerate"]').first().click({ force: true });
  await sleep(400);
  const sent = await p.evaluate((S) => window.__mock.calls.filter((c) => S.includes(c.name)), SENDS);
  ck(`${tag} Regenerate resends "Summarize my files" once`, sent.length === before + 1 && /Summarize my files/.test(JSON.stringify(sent.at(-1).args)), JSON.stringify(sent.at(-1)?.args).slice(0, 160));
  await p.evaluate((k) => window.__mock.emit('agent.completed', { sessionKey: k }), k);
  await sleep(200);

  // Reload a saved two-turn history.
  // The thread list is off-canvas on phones; the click is what matters here.
  await p.evaluate(() => document.querySelector('[data-thread="chat-1690000000000"]').click());
  await sleep(700);
  b = await bars(p);
  ck(`${tag} after reload: two turns, two assistant messages, one bar each`, b.length === 2 && b.every((x) => x.bar), JSON.stringify(b));
  ck(`${tag} after reload the first turn holds its reasoning, tools and answer`, b[0] && b[0].tools >= 1 && /summary/.test(b[0].text) && /welcome/.test(b[1]?.text || ''), JSON.stringify(b).slice(0, 300));
  const ts = await p.evaluate(() => document.querySelectorAll('.aui-assistant-action-bar-root time, .aui-assistant-action-bar-root [data-slot="timestamp"]').length);
  ck(`${tag} one timestamp per turn`, ts <= 2, String(ts));
  const of = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ck(`${tag} no sideways scrolling`, of <= 1, String(of));
  ck(`${tag} no page errors, console errors or network`, errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    for (const size of [{ w: 320, h: 640, mobile: true }, { w: 375, h: 760, mobile: true }, { w: 768, h: 1000, mobile: true }, { w: 1366, h: 860, mobile: false }]) {
      for (const dark of [false, true]) await run(browser, size, dark);
    }
  } catch (e) {
    ck('suite ran to the end', false, (e.stack || e.message).split('\n').slice(0, 4).join(' <- '));
  } finally {
    await browser.close();
  }
  for (const r of results) console.log(r);
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
