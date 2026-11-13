// Feature checks for the improved agent (3) copy. Mock NativeKit only; no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const EXE = '/home/sprite/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const URL_ = process.env.URL_ || 'file:///home/sprite/impl/work.html';
const SHOTS = process.env.SHOTS || '/home/sprite/impl/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync('/home/sprite/impl/test/mock3.js', 'utf8');
const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

async function open(browser, w, hgt, mobile, dark) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);

  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(250);
  return { p, ctx, errs };
}
const overflow = (p) => p.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === 'hidden') continue;
    let a = el.parentElement, clipped = false;
    while (a && a !== document.body) { const o = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(o.overflowX)) { clipped = true; break; } a = a.parentElement; }
    if (!clipped && (r.right > w + 1 || r.left < -1)) bad.push(`${el.tagName}.${String(el.className.baseVal ?? el.className)}`.slice(0, 80) + ` ${Math.round(r.left)}-${Math.round(r.right)}`);
  }
  return { ok: document.documentElement.scrollWidth <= w && !bad.length, w, sw: document.documentElement.scrollWidth, bad: bad.slice(0, 4) };
});
async function send(p, text) {
  await p.locator('.aui-composer-input').first().fill(text);
  await p.locator('.aui-composer-send').first().click();
  await sleep(250);
  const c = await p.evaluate(() => window.__mock.calls);
  const last = [...c].reverse().find((x) => x.name === 'agent.sendMessage' || x.name === 'agent.followUp');
  if (last && typeof last.args === 'string') return { prompt: last.args, sessionKey: [...c].reverse().find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey };
  return last?.args;
}
const emit = (p, events) => p.evaluate((ev) => { for (const [n, d] of ev) window.__mock.emit(n, d); }, events);
const text = (p) => p.evaluate(() => document.querySelector('.aui-thread-viewport')?.innerText || '');

const SCENARIOS = {};
module.exports = { SCENARIOS, check, sleep, send, emit, text, overflow };

/* ---------------- tool cards ---------------- */
SCENARIOS.tools = async (p, tag, ctx) => {
  const a = await send(p, 'Do some work');
  const k = a.sessionKey;
  await emit(p, [
    ['tool_use', { sessionKey: k, toolCallId: 't1', toolName: 'execute_command', args: { command: 'npm test -- --reporter dot', cwd: 'app' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't1', result: { output: JSON.stringify({ exitCode: 1, stdout: '> app@1.0.0 test\n> vitest run\n\n ✓ src/a.test.ts (3)\n ✓ src/b.test.ts (5)\n', stderr: ' ✗ src/c.test.ts > adds numbers\n   expected 3, got 4', timedOut: false }) } }],
    ['text_delta', { sessionKey: k, delta: 'One test fails. Fixing it.' }],
    ['tool_use', { sessionKey: k, toolCallId: 't2', toolName: 'edit_file', args: { path: 'src/c.ts', old_text: 'export function add(a, b) {\n  return a + b + 1;\n}', new_text: 'export function add(a: number, b: number) {\n  return a + b;\n}' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't2', result: { output: JSON.stringify({ success: true, path: 'src/c.ts' }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 't3', toolName: 'read_file', args: { path: 'src/c.test.ts' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't3', result: { output: "import { add } from './c';\ntest('adds', () => expect(add(1, 2)).toBe(3));" } }],
    ['tool_use', { sessionKey: k, toolCallId: 't4', toolName: 'grep_files', args: { pattern: 'add(' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't4', result: { output: JSON.stringify({ matches: [{ path: 'src/c.ts', line: 1, content: 'export function add(a: number, b: number) {' }, { path: 'src/c.test.ts', line: 2, content: "test('adds', () => expect(add(1, 2)).toBe(3));" }] }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 't5', toolName: 'git_diff', args: {} }],
    ['tool_result', { sessionKey: k, toolCallId: 't5', result: { output: JSON.stringify({ changes: [{ path: 'src/c.ts', status: 'modified', patch: '@@ -1,3 +1,3 @@\n-export function add(a, b) {\n-  return a + b + 1;\n+export function add(a: number, b: number) {\n+  return a + b;\n }' }] }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 't6', toolName: 'git_log', args: { limit: 2 } }],
    ['tool_result', { sessionKey: k, toolCallId: 't6', result: { output: JSON.stringify({ commits: [{ sha: 'a1b2c3d4e5', message: 'fix: add()', author: 'Akib', timestamp: Math.floor(Date.now() / 1000) - 120 }] }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 't7', toolName: 'memory_recall', args: { query: 'exam dates' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't7', result: { output: JSON.stringify({ results: [{ key: 'cse2101-ct', text: 'CT-2 on Sunday 9 AM', score: 0.91 }] }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 't8', toolName: 'manage_cron', args: { action: 'add', name: 'Morning brief', schedule: '0 7 * * *', prompt: 'Summarise today' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't8', result: { output: JSON.stringify({ success: true, id: 'job1' }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 't9', toolName: 'web_fetch', args: { url: 'https://example.com/api', method: 'GET' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't9', result: { output: JSON.stringify({ status: 200, body: '{"ok":true}' }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 't10', toolName: 'github__create_issue', args: { title: 'Bug' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't10', result: { output: '{"number":12}' } }],
    ['tool_use', { sessionKey: k, toolCallId: 't11', toolName: 'list_files', args: { path: 'src' } }],
    ['tool_result', { sessionKey: k, toolCallId: 't11', result: { output: JSON.stringify({ entries: [{ name: 'c.ts', type: 'file', size: 64 }, { name: 'lib', type: 'directory' }] }) } }],
  ]);
  await sleep(500);
  const info = await p.evaluate(() => ({
    term: document.querySelectorAll('.aui-tool-card[data-kind=terminal]').length,
    termText: document.querySelector('.aui-tool-card[data-kind=terminal]')?.innerText || '',
    diff: document.querySelectorAll('.aui-tool-card[data-kind=diff]').length,
    add: document.querySelectorAll('.aui-diff-line[data-kind=add]').length,
    del: document.querySelectorAll('.aui-diff-line[data-kind=del]').length,
    rows: [...document.querySelectorAll('.aui-tool-fallback-root[data-tool]:not(.x)')].map((e) => e.dataset.tool + '=' + e.querySelector('.aui-tool-fallback-trigger-label')?.textContent.replace(/\s+/g, ' ')),
  }));
  check(`${tag} terminal card for execute_command`, info.term === 1 && info.termText.includes('npm test') && info.termText.includes('exit 1') && info.termText.includes('expected 3, got 4'), info.termText.slice(0, 120));
  check(`${tag} diff cards for edit_file + git_diff`, info.diff === 2 && info.add >= 4 && info.del >= 4, JSON.stringify([info.diff, info.add, info.del]));
  const want = ['read_file=Read c.test.ts', 'grep_files=Searched "add(" · 2 matches', 'git_log=Read git log · 1 commit', 'memory_recall=Recalled "exam dates" · 1', 'manage_cron=Scheduled "Morning brief"', 'web_fetch=Fetched example.com', 'github__create_issue=Called create_issue · github', 'list_files=Listed src · 2 items'];
  for (const w of want) check(`${tag} card ${w.split('=')[0]}`, info.rows.some((r) => r.startsWith(w)), info.rows.find((r) => r.startsWith(w.split('=')[0])));
  // open a couple of rows
  await p.evaluate(() => { for (const t of ['grep_files', 'manage_cron', 'memory_recall']) document.querySelector(`.aui-tool-fallback-root[data-tool="${t}"] .aui-tool-fallback-trigger`)?.click(); });
  await sleep(350);
  const opened = await p.evaluate(() => ({ grep: document.querySelectorAll('.aui-grep-file').length, sched: !!document.querySelector('.aui-schedule-card'), mem: document.querySelectorAll('.aui-memory-chip').length }));
  check(`${tag} card bodies render (grep, schedule, memory)`, opened.grep === 2 && opened.sched && opened.mem === 1, JSON.stringify(opened));
  ctx.k = k;
};


/* ---------------- retry / continue / queue ---------------- */
SCENARIOS.queue = async (p, tag) => {
  const a = await send(p, 'First question');
  const k = a.sessionKey;
  const FU = async () => (await p.evaluate(() => window.__mock.calls)).filter((c) => c.name === 'agent.followUp' || c.name === 'agent.sendMessage').map((c) => (typeof c.args === 'string' ? c.args : c.args.prompt));
  const base = (await FU()).length;
  check(`${tag} first message sent`, a.prompt === 'First question');
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Thinking about it' }]]);
  await sleep(150);
  // type while running -> queue button
  await p.locator('.aui-composer-input').first().fill('Second question');
  await sleep(100);
  const qbtn = await p.evaluate(() => { const b = document.querySelector('.aui-composer-queue'); return b && !b.hidden; });
  check(`${tag} queue button shows while running`, qbtn);
  await p.locator('.aui-composer-input').first().press('Enter');
  await p.locator('.aui-composer-input').first().fill('Third question');
  await p.locator('.aui-composer-queue').first().click();
  await sleep(150);
  const q = await p.evaluate(() => [...document.querySelectorAll('.aui-queue-item .aui-queue-text')].map((e) => e.textContent));
  check(`${tag} two messages queued`, q.length === 2 && q[0] === 'Second question', JSON.stringify(q));
  if (process.env.SHOT && (tag.startsWith('390px'))) await p.screenshot({ path: `${process.env.SHOTS || '/home/sprite/impl/shots'}/queue-${tag.includes('dark') ? 'dark' : 'light'}.png` });
  check(`${tag} nothing sent while queued`, (await FU()).length === base);
  await emit(p, [['agent.completed', { sessionKey: k, displayMessagesJson: JSON.stringify([{ role: 'user', content: 'First question' }, { role: 'assistant', content: [{ type: 'text', text: 'Answer one' }] }]) }]]);
  await sleep(400);
  let calls = (await FU()).slice(base);
  check(`${tag} queue drains with followUp after completion`, calls.length === 1 && calls[0] === 'Second question', JSON.stringify(calls));
  const left = await p.evaluate(() => document.querySelectorAll('.aui-queue-item').length);
  check(`${tag} one left in queue`, left === 1);
  // stop -> queue pauses
  await p.locator('.aui-composer-cancel').first().click();
  await sleep(200);
  const paused = await p.evaluate(() => ({ p: document.querySelector('.aui-queue')?.dataset.paused, abort: window.__mock.calls.filter((c) => c.name === 'agent.abort').length === 1 ? 1 : window.__mock.calls.filter((c) => c.name === 'agent.abort').length, retry: !!document.querySelector('.aui-retry') }));
  check(`${tag} stop pauses the queue and offers Retry`, paused.p === 'true' && paused.abort === 1 && paused.retry, JSON.stringify(paused));
  // Send now from queue
  await p.locator('.aui-queue-item [aria-label="Send now"]').first().click();
  await sleep(250);
  calls = (await FU()).slice(base);
  check(`${tag} Send now sends the queued message`, calls.length === 2 && calls[1] === 'Third question' && !(await p.evaluate(() => document.querySelectorAll('.aui-queue-item').length)));
  // error -> Retry re-sends the same prompt
  await emit(p, [['agent.error', { sessionKey: k, error: 'Rate limited' }]]);
  await sleep(250);
  const userCount = await p.evaluate(() => document.querySelectorAll('[data-role=user]').length);
  await p.locator('.aui-retry').first().click();
  await sleep(250);
  calls = (await FU()).slice(base);
  const after = await p.evaluate(() => ({ users: document.querySelectorAll('[data-role=user]').length, err: document.querySelector('.aui-thread-viewport').innerText.includes('Rate limited') }));
  check(`${tag} Retry re-sends the prompt without a duplicate bubble`, calls.length === 3 && calls[2] === 'Third question' && after.users === userCount && !after.err, JSON.stringify([calls.length, after, userCount]));
  // cut off by length -> Continue
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Partial answer' }]]);
  await p.locator('.aui-composer-cancel').first().click();
  await sleep(200);
  const cont = await p.locator('.aui-continue').count();
  check(`${tag} Continue offered after a stopped reply with text`, cont === 1);
  await p.locator('.aui-continue').first().click();
  await sleep(200);
  calls = (await FU()).slice(base);
  check(`${tag} Continue sends a follow-up`, calls.length === 4 && /Continue/.test(calls[3]), JSON.stringify(calls));
};


/* ---------------- math + mermaid ---------------- */
const MATH_REPLY = 'The quadratic formula is $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$, and Euler wrote:\n\n$$\ne^{i\\pi} + 1 = 0\n$$\n\nA wide one: \\[\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} + \\int_0^1 x^2\\,dx + \\int_0^1 x^3\\,dx + \\int_0^1 x^4\\,dx + \\int_0^1 x^5\\,dx\\]\n\nBroken: $\\frac{1}{$ stays as text.';
SCENARIOS.math = async (p, tag) => {
  const a = await send(p, 'Show some math');
  const k = a.sessionKey;
  await emit(p, [['text_delta', { sessionKey: k, delta: MATH_REPLY.slice(0, 40) }]]);
  await sleep(100);
  await emit(p, [['text_delta', { sessionKey: k, delta: MATH_REPLY.slice(40) }], ['agent.completed', { sessionKey: k, displayMessagesJson: JSON.stringify([{ role: 'user', content: 'Show some math' }, { role: 'assistant', content: [{ type: 'text', text: MATH_REPLY }] }]) }]]);
  await p.waitForFunction(() => document.querySelectorAll('.katex').length >= 3, null, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const r = await p.evaluate(() => ({
    inline: document.querySelectorAll('.aui-katex-inline .katex').length,
    block: document.querySelectorAll('.aui-katex-block .katex-display').length,
    rawLeft: [...document.querySelectorAll('code.aui-md-math, .aui-md-math-block code')].map((e) => e.textContent),
    err: document.querySelectorAll('[data-error=true]').length,
    mathml: document.querySelectorAll('.katex-mathml math').length,
    font: document.fonts.check('16px KaTeX_Main'),
  }));
  check(`${tag} KaTeX renders inline + display math`, r.inline >= 1 && r.block === 2 && r.mathml >= 3, JSON.stringify(r));
  check(`${tag} broken TeX stays raw with an error mark`, r.err === 1 && r.rawLeft.length === 1, JSON.stringify(r.rawLeft));
  const fontsLoaded = await p.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.family.includes('KaTeX') && f.status === 'loaded').length; });
  check(`${tag} KaTeX fonts load from the file (no network)`, fontsLoaded >= 2, String(fontsLoaded));
  const wide = await p.evaluate(() => { const b = document.querySelectorAll('.aui-katex-block')[1]; return { sw: b.scrollWidth, cw: b.clientWidth }; });
  check(`${tag} wide formula scrolls inside its own box`, wide.sw >= wide.cw, JSON.stringify(wide));
  await p.evaluate(() => document.querySelector('.aui-katex-block')?.scrollIntoView({ block: 'center' }));
};
const MERMAID_REPLY = 'Here is the login flow:\n\n```mermaid\nflowchart TD\n  A[Open app] --> B{Signed in?}\n  B -- Yes --> C[Home]\n  B -- No --> D[Login screen]\n  D --> E[Fingerprint]\n  E --> C\n```\n\nAnd a broken one:\n\n```mermaid\nflowchart TD\n  A -->\n```\n\nAnd a sequence:\n\n```mermaid\nsequenceDiagram\n  App->>NativeKit: sendMessage\n  NativeKit-->>App: text_delta\n```';
SCENARIOS.mermaid = async (p, tag) => {
  const a = await send(p, 'Draw a diagram');
  const k = a.sessionKey;
  await emit(p, [['text_delta', { sessionKey: k, delta: MERMAID_REPLY.slice(0, 60) }]]);
  await sleep(500);
  const midStream = await p.evaluate(() => ({ boxes: document.querySelectorAll('.aui-mermaid').length, code: document.querySelectorAll('.aui-code-block').length }));
  check(`${tag} diagram waits as code while streaming`, midStream.boxes === 0 && midStream.code >= 1, JSON.stringify(midStream));
  await emit(p, [['text_delta', { sessionKey: k, delta: MERMAID_REPLY.slice(60) }], ['agent.completed', { sessionKey: k, displayMessagesJson: JSON.stringify([{ role: 'user', content: 'Draw a diagram' }, { role: 'assistant', content: [{ type: 'text', text: MERMAID_REPLY }] }]) }]]);
  await p.waitForFunction(() => [...document.querySelectorAll('.aui-mermaid')].every((b) => ['done', 'error', 'unavailable'].includes(b.dataset.state)) && document.querySelectorAll('.aui-mermaid').length === 3, null, { timeout: 15000 }).catch(() => {});
  const r = await p.evaluate(() => [...document.querySelectorAll('.aui-mermaid')].map((b) => ({ state: b.dataset.state, view: b.dataset.view, svg: !!b.querySelector('.aui-mermaid-svg svg'), nodes: b.querySelectorAll('.aui-mermaid-svg .node, .aui-mermaid-svg .actor').length, note: b.querySelector('.aui-mermaid-note')?.textContent || '', codeVisible: getComputedStyle(b.querySelector('.aui-code-block')).display !== 'none' })));
  check(`${tag} flowchart drawn as SVG`, r[0]?.state === 'done' && r[0].svg && r[0].nodes >= 5 && !r[0].codeVisible, JSON.stringify(r[0]));
  check(`${tag} broken diagram falls back to code with a note`, r[1]?.state === 'error' && r[1].codeVisible && /Couldn't draw/.test(r[1].note), JSON.stringify(r[1]));
  check(`${tag} sequence diagram drawn`, r[2]?.state === 'done' && r[2].svg, JSON.stringify(r[2]));
  const strayErr = await p.evaluate(() => document.querySelectorAll('body > [id^="daui-mermaid"], body > svg[id^="aui-mermaid"]').length);
  check(`${tag} no stray Mermaid error nodes`, strayErr === 0, String(strayErr));
  await p.locator('.aui-mermaid').first().locator('.aui-mermaid-tab[data-mode=code]').click();
  const codeView = await p.evaluate(() => document.querySelector('.aui-mermaid').dataset.view);
  await p.locator('.aui-mermaid').first().locator('.aui-mermaid-tab[data-mode=diagram]').click();
  check(`${tag} Diagram/Code toggle works`, codeView === 'code');
  await p.evaluate(() => document.querySelector('.aui-mermaid')?.scrollIntoView({ block: 'start' }));
  await sleep(100);
};

/* ---------------- runner ---------------- */
if (require.main === module) (async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const sizes = (process.env.SIZES || '320x640m,360x740m,390x844m,1280x800').split(',').map((s) => { const m = /^(\d+)x(\d+)(m?)(d?)$/.exec(s); return [+m[1], +m[2], !!m[3], !!m[4]]; });
  const extra = fs.existsSync(__dirname + '/feat-more.js') ? require('./feat-more.js') : null;
  for (const [w, hgt, mobile, darkOnly] of sizes) {
    for (const dark of darkOnly ? [true] : [false, true]) {
      for (const [name, fn] of Object.entries(SCENARIOS)) {
        if (ONLY && !ONLY.includes(name)) continue;
        const tag = `${w}px${dark ? ' dark' : ''} ${name}`;
        const { p, ctx, errs } = await open(browser, w, hgt, mobile, dark);
        const c = {};
        try { await fn(p, tag, c, { w, mobile, dark, SHOTS }); } catch (e) { check(`${tag} ran`, false, e.message.split('\n')[0]); }
        const ov = await overflow(p);
        check(`${tag} no page sideways scroll`, ov.ok, JSON.stringify(ov));
        check(`${tag} no console errors / network`, !errs.length, errs.slice(0, 3).join(' | '));
        if (process.env.SHOT && (w === 390 || w === 1280)) await p.screenshot({ path: `${SHOTS}/${name}-${w}${dark ? '-dark' : ''}.png`, fullPage: false });
        await ctx.close();
      }
    }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(fails.join('\n'));
  console.log(`${results.length - fails.length}/${results.length} passed`);
})();
