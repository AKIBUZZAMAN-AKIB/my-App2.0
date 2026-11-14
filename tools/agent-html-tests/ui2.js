// Phase 6 checks: footer layout (user's case), message edit + versions, fork, approval edits,
// widgets, canvas, code-block actions, skill templates, widget guide. Mock NativeKit only.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { check, sleep, send, emit, overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = require('path').join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = require('fs').existsSync(b) ? require('fs').readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? require('path').join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${require('path').resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/impl/shots6';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync('/home/sprite/impl/test/mock3.js', 'utf8');
const { schemaGuard } = require('./tool-schemas.js');
const { realWorkspaceScript } = require('./workspace-real.js');
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

async function open(browser, w, hgt, mobile, dark) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(schemaGuard);
  // The file canvas reads through the app's own workspace reader (bridge/workspace-files.ts).
  await ctx.addInitScript(() => { window.__ws = window.__ws || {}; window.__ws.files = Object.assign(window.__ws.files || {}, { 'notes/todo.md': new TextEncoder().encode('# Todo\n- one\n') }); });
  await ctx.addInitScript(realWorkspaceScript());
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(250);
  return { p, ctx, errs };
}
const calls = (p) => p.evaluate(() => window.__mock.calls);
const lastSend = async (p) => { const c = await calls(p); return [...c].reverse().find((x) => x.name === 'agent.sendMessage' || x.name === 'agent.followUp'); };
const promptOf = (c) => (typeof c?.args === 'string' ? c.args : c?.args?.prompt ?? c?.args?.message ?? JSON.stringify(c?.args));

const USER_CASE = 'আজকের রুটিন:\n\n| Time | Course | Room |\n|---|---|---|\n| 9:00 AM | CSE-1101 Structured Programming | 302 |\n| 10:30 AM | MAT-1103 Calculus | 214 |\n| 1:00 PM | PHY-1105 Physics Lab | Lab-2 |\n\nDetails are on [the routine page](https://example.edu/notices/routine-changes-for-the-spring-semester-2026).';

const S = {};
/* 1. The user's case: web_fetch card, table, two sources, timestamp, action row. */
S.footer = async (p, tag, env) => {
  const a = await send(p, 'Show today\'s routine');
  const k = a.sessionKey;
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'w1', toolName: 'web_fetch', args: { url: 'https://example.edu/routine/today-full-schedule-for-first-year', method: 'GET' } }]]);
  await sleep(1500);
  await emit(p, [['tool_result', { sessionKey: k, toolCallId: 'w1', result: { output: JSON.stringify({ status: 200, body: 'ok' }) } }], ['text_delta', { sessionKey: k, delta: USER_CASE }], ['agent.completed', { sessionKey: k }]]);
  await sleep(600);
  const lay = await p.evaluate(() => {
    const m = [...document.querySelectorAll('[data-role=assistant]')].pop();
    const r = (el) => el && el.getBoundingClientRect();
    const src = r(m.querySelector('.aui-sources')); const bar = r(m.querySelector('.aui-assistant-action-bar-root'));
    const took = m.querySelector('.aui-message-took');
    return { n: m.querySelectorAll('.aui-source-chip').length, hrefs: [...m.querySelectorAll('.aui-source-chip')].map((a) => a.tagName + ':' + a.getAttribute('href')), srcBottom: src?.bottom, barTop: bar?.top, tookH: r(took)?.height, tookText: took?.textContent, tookRight: r(took)?.right, vw: innerWidth,
      cut: [...m.querySelectorAll('.aui-source-label')].map((e) => e.scrollWidth - e.clientWidth), btns: [...m.querySelectorAll('.aui-assistant-action-bar-root > .aui-button-icon')].map((b) => b.getAttribute('aria-label')) };
  });
  ck(`${tag} two real source links`, lay.n === 2 && lay.hrefs.every((x) => /^A:https:/.test(x)), JSON.stringify(lay.hrefs));
  ck(`${tag} sources row above the action row`, lay.srcBottom <= lay.barTop + 0.5, `${lay.srcBottom} / ${lay.barTop}`);
  ck(`${tag} timestamp on one line`, lay.tookH <= 32 && lay.tookRight <= lay.vw && /\d:\d\d/.test(lay.tookText), JSON.stringify([lay.tookH, lay.tookText]));
  ck(`${tag} Copy, Regenerate and More in the row`, ['Copy', 'Regenerate', 'More'].every((x) => lay.btns.includes(x)), JSON.stringify(lay.btns));
  ck(`${tag} no 👍/👎`, !(await p.evaluate(() => /helpful|thumbs/i.test(document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, '')))));
  // earlier replies get the same row too
  const a2 = await send(p, 'Thanks');
  await emit(p, [['text_delta', { sessionKey: a2.sessionKey ?? k, delta: 'You are welcome.' }], ['agent.completed', { sessionKey: a2.sessionKey ?? k }]]);
  await sleep(500);
  const rows = await p.evaluate(() => [...document.querySelectorAll('[data-role=assistant] .aui-assistant-action-bar-root')].map((b) => [getComputedStyle(b).opacity, b.querySelectorAll(':scope > .aui-button-icon').length]));
  ck(`${tag} every reply has the same visible action row`, rows.length >= 2 && rows.every(([o, n]) => o === '1' && n >= 3), JSON.stringify(rows));
  // scroll up so the scroll-to-bottom button shows, then check it does not cover any action row
  await p.evaluate(() => { const v = document.querySelector('.aui-thread-viewport'); v.scrollTop = Math.max(0, v.scrollHeight - v.clientHeight - 140); v.dispatchEvent(new Event('scroll')); });
  await sleep(400);
  const sb = await p.evaluate(() => { const b = document.querySelector('.aui-thread-scroll-to-bottom'); if (!b) return { none: true }; const cs = getComputedStyle(b); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return { hidden: true }; const x = b.getBoundingClientRect(); const hits = [...document.querySelectorAll('.aui-assistant-action-bar-root .aui-button-icon, .aui-source-chip')].filter((el) => { const y = el.getBoundingClientRect(); return y.width && !(x.right <= y.left || x.left >= y.right || x.bottom <= y.top || x.top >= y.bottom); }).length; return { hits }; });
  ck(`${tag} scroll-to-bottom button covers no button or source`, sb.hidden || sb.none || sb.hits === 0, JSON.stringify(sb));
  await p.evaluate(() => { const m = [...document.querySelectorAll('[data-role=assistant]')][0]; m.querySelector('.aui-assistant-message-footer').scrollIntoView({ block: 'end' }); });
  await sleep(250);
  if (env.shot) await p.screenshot({ path: `${SHOTS}/footer-${env.w}${env.dark ? '-dark' : ''}.png` });
};

/* 2. Edit a sent message: new version, branch picker, followUp, switch back. */
S.edit = async (p, tag, env) => {
  const a = await send(p, 'What is 2+2?');
  const k = a.sessionKey;
  await emit(p, [['text_delta', { sessionKey: k, delta: 'It is 4.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  await p.locator('[data-role=user] [data-action=edit-message]').last().click();
  await sleep(200);
  const ta = p.locator('.aui-edit-composer-input');
  ck(`${tag} edit box opens with the old text`, (await ta.inputValue()) === 'What is 2+2?');
  if (env.shot) await p.screenshot({ path: `${SHOTS}/edit-open-${env.w}.png` });
  await ta.fill('What is 3+3?');
  await p.locator('[data-action=edit-send]').click();
  await sleep(300);
  const c = await lastSend(p);
  ck(`${tag} edited text goes out through followUp`, c?.name === 'agent.followUp' && /3\+3/.test(promptOf(c)) && /edited my earlier message/.test(promptOf(c)), JSON.stringify(c).slice(0, 200));
  await emit(p, [['text_delta', { sessionKey: k, delta: 'It is 6.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  const st = await p.evaluate(() => ({ picker: [...document.querySelectorAll('[data-role=user] .aui-branch-picker-state')].pop()?.textContent, users: [...document.querySelectorAll('[data-role=user] .aui-user-message-content')].map((e) => e.textContent) }));
  ck(`${tag} branch picker shows 2 / 2`, st.picker === '2 / 2' && /3\+3/.test(st.users[st.users.length - 1]) && !st.users.some((x) => /2\+2/.test(x)), JSON.stringify(st));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/edit-versions-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('[data-role=user] [data-branch=prev]').last().click();
  await sleep(250);
  const back = await p.evaluate(() => ({ picker: [...document.querySelectorAll('[data-role=user] .aui-branch-picker-state')].pop()?.textContent, user: [...document.querySelectorAll('[data-role=user] .aui-user-message-content')].pop()?.textContent, reply: [...document.querySelectorAll('[data-role=assistant]')].pop()?.innerText || '' }));
  ck(`${tag} switching back shows version 1 and its reply`, back.picker === '1 / 2' && /2\+2/.test(back.user) && /It is 4/.test(back.reply), JSON.stringify(back).slice(0, 200));
  // regenerate: a second reply version with its own picker
  await p.locator('[data-role=user] [data-branch=next]').last().click();
  await sleep(200);
  await p.locator('[data-role=assistant] [data-action=regenerate]').last().click();
  await sleep(300);
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Six.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  const rp = await p.evaluate(() => [...document.querySelectorAll('[data-role=assistant] .aui-branch-picker-state')].map((e) => e.textContent).pop());
  ck(`${tag} regenerated reply has a version picker`, rp === '2 / 2', String(rp));
};

/* 3. Fork from a message into a new chat; edit into a new chat. */
S.fork = async (p, tag) => {
  const a = await send(p, 'Plan my week');
  const k = a.sessionKey;
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Mon: maths. Tue: physics.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  await p.locator('[data-role=assistant] [aria-label="More"]').last().click();
  await sleep(150);
  await p.getByRole('menuitem', { name: 'Fork from here' }).click();
  await sleep(400);
  const chip = await p.evaluate(() => document.querySelector('.aui-context-chip')?.textContent || '');
  ck(`${tag} fork opens a new chat with the context chip`, /\d+ messages from "Plan my week"/.test(chip), chip);
  await p.locator('.aui-composer-input').first().fill('Add chemistry on Wed');
  await p.locator('.aui-composer-send').first().click();
  await sleep(300);
  const c = await lastSend(p);
  const pr = promptOf(c);
  ck(`${tag} forked first message carries the earlier turns`, c?.name === 'agent.sendMessage' && /Plan my week/.test(pr) && /Mon: maths/.test(pr) && /Add chemistry on Wed$/.test(pr), pr.slice(0, 160));
  const ui = await p.evaluate(() => ({ shown: [...document.querySelectorAll('[data-role=user] .aui-user-message-content')].pop()?.innerText || '', det: !!document.querySelector('.aui-carried-context') }));
  ck(`${tag} the context is folded away in the bubble`, ui.det && /Add chemistry on Wed/.test(ui.shown), JSON.stringify(ui).slice(0, 160));
};

/* 4. Approval: edit args, send back with respondToApproval(id, false, reason). */
S.approval = async (p, tag, env) => {
  const a = await send(p, 'Delete the build folder');
  const k = a.sessionKey;
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'x1', toolName: 'execute_command', args: { command: 'rm -rf build', cwd: 'app' } }], ['approval_request', { sessionKey: k, approvalId: 'ap1', toolCallId: 'x1', toolName: 'execute_command', args: { command: 'rm -rf build', cwd: 'app' }, reason: 'Runs a shell command' }]]);
  await sleep(400);
  const has = await p.locator('[data-slot=approval-card-edit]').count();
  ck(`${tag} approval card has Edit`, has === 1, String(has));
  if (!has) return;
  await p.locator('[data-slot=approval-card-edit]').click();
  await sleep(150);
  await p.locator('.aui-approval-edit [data-arg=command]').fill('rm -rf build/tmp');
  await p.locator('.aui-approval-edit textarea[aria-label="Note for the agent"]').fill('Only the tmp folder');
  if (env.shot) await p.screenshot({ path: `${SHOTS}/approval-edit-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('[data-slot=approval-card-send-edits]').click();
  await sleep(500);
  const c = (await calls(p)).filter((x) => x.name === 'agent.respondToApproval').pop();
  ck(`${tag} edits go back via respondToApproval(id, false, reason)`, c && ['ap1', 'x1'].includes(c.args[0]) && c.args[1] === false && /rm -rf build\/tmp/.test(c.args[2]) && /Only the tmp folder/.test(c.args[2]), JSON.stringify(c?.args).slice(0, 220));
};

/* 5. Widgets from ```widget blocks. */
const W = (o) => '```widget\n' + JSON.stringify(o) + '\n```';
S.widgets = async (p, tag, env) => {
  const a = await send(p, 'Help me set up');
  const k = a.sessionKey;
  const reply = ['Pick one:', W({ type: 'options', title: 'Exam to study for', options: [{ id: 'ct', label: 'CT-2', description: 'Next Monday' }, { id: 'mid', label: 'Midterm' }] }),
    W({ type: 'form', title: 'Your details', fields: [{ name: 'roll', label: 'Roll', type: 'number', required: true }, { name: 'sec', label: 'Section', type: 'select', options: ['A', 'B'] }] }),
    W({ type: 'todo', title: 'Study plan', items: [{ text: 'Read chapter 3', done: true }, { text: 'Solve 10 problems' }] }),
    W({ type: 'table', title: 'Marks', columns: ['Name', 'Marks'], rows: [['Rafi', '72'], ['Akib', '91']] }),
    W({ type: 'chart', kind: 'bar', title: 'Study hours', labels: ['Sat', 'Sun', 'Mon'], series: [{ name: 'Hours', data: [2, 3.5, 1] }] }),
    W({ type: 'artifact', title: 'hello.html', language: 'html', content: '<h1>Hello</h1>\n<p>Draft</p>' }),
    '```widget\n{not json}\n```'].join('\n\n');
  await emit(p, [['text_delta', { sessionKey: k, delta: reply.slice(0, 40) }]]);
  await sleep(200);
  await emit(p, [['text_delta', { sessionKey: k, delta: reply.slice(40) }], ['agent.completed', { sessionKey: k }]]);
  await p.waitForFunction(() => document.querySelectorAll('.aui-widget').length === 7 && !document.querySelector('.aui-widget-building') && document.querySelectorAll('.aui-widget[data-state=pending]').length === 0, null, { timeout: 15000 }).catch(() => {});
  await sleep(300);
  const kinds = await p.evaluate(() => [...document.querySelectorAll('.aui-widget-card')].map((e) => e.dataset.widget));
  ck(`${tag} six widgets render`, ['options', 'form', 'todo', 'table', 'chart', 'artifact'].every((x) => kinds.includes(x)), JSON.stringify(kinds));
  const bad = await p.evaluate(() => { const w = [...document.querySelectorAll('.aui-widget')].pop(); return { st: w.dataset.state, note: w.querySelector('.aui-widget-note')?.textContent || '', code: getComputedStyle(w.querySelector('.aui-code-block')).display !== 'none' }; });
  ck(`${tag} broken widget JSON falls back to code with a note`, bad.st === 'error' && bad.code && /isn't valid/.test(bad.note), JSON.stringify(bad));
  if (env.shot) { await p.locator('[data-widget=options]').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/widgets-options-form-${env.w}${env.dark ? '-dark' : ''}.png` }); }
  // option list -> sends the choice
  await p.locator('[data-widget=options] .aui-widget-option[data-id=ct]').click();
  await p.locator('[data-widget=options] [data-action=widget-submit]').click();
  await sleep(300);
  let c = await lastSend(p);
  ck(`${tag} option choice is sent as a chat message`, /Exam to study for: CT-2/.test(promptOf(c)), promptOf(c));
  const rc = await p.evaluate(() => document.querySelector('[data-widget=options] .aui-widget-receipt')?.textContent || '');
  ck(`${tag} option widget shows the answer with Change`, /CT-2/.test(rc) && /Change/.test(rc), rc);
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await sleep(200);
  // form: required check, then send
  await p.locator('[data-widget=form] [data-action=widget-submit]').click();
  await sleep(150);
  const err = await p.evaluate(() => document.querySelector('[data-widget=form] [role=alert]')?.textContent || '');
  ck(`${tag} form blocks a missing required field`, /Roll/.test(err), err);
  await p.locator('[data-widget=form] input[name=roll]').fill('2203045');
  await p.locator('[data-widget=form] select[name=sec]').selectOption('B');
  await p.locator('[data-widget=form] [data-action=widget-submit]').click();
  await sleep(300);
  c = await lastSend(p);
  ck(`${tag} form answers are sent`, /Roll: 2203045/.test(promptOf(c)) && /Section: B/.test(promptOf(c)), promptOf(c));
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await sleep(200);
  // todo: tick, add, send
  await p.locator('[data-widget=todo] .aui-widget-todo-item').nth(1).locator('input[type=checkbox]').check();
  await p.locator('[data-widget=todo] .aui-widget-add').fill('Revise notes');
  await p.locator('[data-widget=todo] .aui-widget-add').press('Enter');
  const cnt = await p.evaluate(() => document.querySelector('[data-widget=todo] .aui-widget-count')?.textContent);
  ck(`${tag} checklist ticks and adds items`, cnt === '2 of 3 done', cnt);
  if (env.shot) { await p.locator('[data-widget=todo]').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/widgets-todo-table-${env.w}${env.dark ? '-dark' : ''}.png` }); }
  await p.locator('[data-widget=todo] [data-action=widget-submit]').click();
  await sleep(300);
  c = await lastSend(p);
  ck(`${tag} edited checklist is sent back`, /\[x\] Solve 10 problems/.test(promptOf(c)) && /\[ \] Revise notes/.test(promptOf(c)), promptOf(c).slice(0, 160));
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await sleep(200);
  // table: edit a cell, send edits as CSV
  const cell = p.locator('[data-widget=table] td[data-r="0"][data-c="1"]');
  await cell.click();
  await p.keyboard.press('End');
  await p.keyboard.type('5');
  await p.keyboard.press('Enter');
  await sleep(150);
  const vis = await p.evaluate(() => !document.querySelector('[data-widget=table] [data-action=widget-submit]').hidden);
  ck(`${tag} table cell edit shows Send edits`, vis);
  await p.locator('[data-widget=table] [data-action=widget-submit]').click();
  await sleep(300);
  c = await lastSend(p);
  ck(`${tag} table edits are sent as CSV`, /Rafi,725/.test(promptOf(c)), promptOf(c).slice(0, 160));
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await sleep(200);
  const svg = await p.evaluate(() => document.querySelectorAll('[data-widget=chart] .aui-widget-chart rect').length);
  ck(`${tag} chart draws bars`, svg === 3, String(svg));
  // artifact opens the canvas
  await p.locator('[data-widget=artifact] [data-action=widget-open]').click();
  await sleep(400);
  const cv = await p.evaluate(() => ({ open: !!document.querySelector('.aui-canvas'), frame: !!document.querySelector('.aui-canvas-frame'), sandbox: document.querySelector('.aui-canvas-frame')?.getAttribute('sandbox') }));
  ck(`${tag} artifact opens in canvas with a sandboxed preview`, cv.open && cv.frame && !/allow-same-origin/.test(cv.sandbox || ''), JSON.stringify(cv));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/canvas-preview-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('.aui-canvas-tab[data-view=edit]').click();
  await p.locator('.aui-canvas-editor').fill('<h1>Hello Akib</h1>');
  await p.locator('[data-action=canvas-save]').click();
  await sleep(300);
  const w = (await calls(p)).filter((x) => x.name === 'agent.invokeTool' && x.args[0] === 'write_file').pop();
  ck(`${tag} canvas saves through invokeTool write_file`, w && w.args[1].path === 'hello.html' && w.args[1].content === '<h1>Hello Akib</h1>', JSON.stringify(w?.args));
  const ed = await p.evaluate(() => document.querySelector('.aui-canvas-status')?.textContent || '');
  ck(`${tag} canvas marks the text as edited`, /edited/.test(ed), ed);
  if (env.shot) await p.screenshot({ path: `${SHOTS}/canvas-edit-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('[data-action=canvas-send]').click();
  await sleep(200);
  const staged = await p.locator('.aui-composer-input').first().inputValue();
  ck(`${tag} "Send to chat" puts the edit in the message box for review`, /Hello Akib/.test(staged), staged.slice(0, 80));
  await p.locator('.aui-composer-input').first().fill('');
};

/* 6. Code block: open in canvas, download. Read_file card: open in canvas. */
S.code = async (p, tag) => {
  const a = await send(p, 'Write code');
  const k = a.sessionKey;
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'r1', toolName: 'read_file', args: { path: 'notes/todo.md' } }], ['tool_result', { sessionKey: k, toolCallId: 'r1', result: { output: '# Todo\n- one' } }],
    ['text_delta', { sessionKey: k, delta: 'Here:\n\n```python\n# calc.py\nprint(2 + 2)\n```' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(500);
  const btns = await p.evaluate(() => [...document.querySelectorAll('.aui-code-header-root [data-action]')].map((b) => b.dataset.action));
  ck(`${tag} code header has copy, canvas and download`, ['copy-code', 'canvas-code', 'download-code'].every((x) => btns.includes(x)), JSON.stringify(btns));
  await p.locator('[data-action=canvas-code]').last().click();
  await sleep(300);
  const t = await p.evaluate(() => ({ title: document.querySelector('.dialog-title, [role=dialog] h2')?.textContent, val: document.querySelector('.aui-canvas-editor')?.value }));
  ck(`${tag} code opens in canvas named from its first line`, t.title === 'calc.py' && /print\(2 \+ 2\)/.test(t.val), JSON.stringify(t));
  await p.keyboard.press('Escape');
  await sleep(200);
  await p.locator('.aui-tool-card, [data-tool]').filter({ hasText: 'todo.md' }).first().locator('button[aria-expanded]').first().click().catch(() => {});
  await sleep(200);
  const n = await p.locator('[data-action=tool-canvas]').count();
  ck(`${tag} read_file card offers Open in canvas`, n >= 1, String(n));
  if (n) {
    await p.locator('[data-action=tool-canvas]').first().click();
    await sleep(400);
    await p.locator('.aui-canvas-tab[data-view=edit]').click({ timeout: 2000 }).catch(() => {});
    await sleep(250);
    const r = await p.evaluate(() => ({ app: (window.__ws.reads || []).filter((x) => x.path === 'notes/todo.md').length, val: document.querySelector('.aui-canvas-editor')?.value || '' }));
    const tool = (await calls(p)).filter((x) => x.name === 'agent.invokeTool' && x.args[0] === 'read_file').length;
    ck(`${tag} file canvas reads the whole file through the app, not the model's read_file`, r.app >= 1 && tool === 0 && /# Todo/.test(r.val), JSON.stringify({ ...r, tool }));
    await p.keyboard.press('Escape');
  }
};

/* 7. Settings: skill templates, duplicate, widget guide. */
S.settings = async (p, tag, env) => {
  await p.locator('button[aria-label="Settings"]:visible').first().click(); await sleep(400); await p.locator('#settings-tab-automations').click();
  await sleep(600);
  await p.locator('details.advanced summary', { hasText: 'New skill' }).first().click({ timeout: 4000 });
  await sleep(200);
  const tpl = await p.locator('.aui-skill-templates [data-template]').count();
  ck(`${tag} skill templates shown`, tpl === 6, String(tpl));
  if (tpl) {
    await p.locator('.aui-skill-templates [data-template="Study planner"]').click({ timeout: 4000 });
    await sleep(150);
    const v = await p.evaluate(() => { const d = document.querySelector('.aui-skill-templates').closest('.advanced-body'); return [...d.querySelectorAll('input, textarea')].map((e) => e.value); });
    ck(`${tag} template fills the New skill form`, v.includes('Study planner') && v.some((x) => /study plan/.test(x)), JSON.stringify(v).slice(0, 120));
    if (env.shot) await p.screenshot({ path: `${SHOTS}/skills-templates-${env.w}${env.dark ? '-dark' : ''}.png` });
  }
  const dup = await p.locator('[aria-label="Duplicate Tidy notes"]').count();
  ck(`${tag} existing skill can be duplicated`, dup === 1, String(dup));
  await p.keyboard.press('Escape');
  await sleep(300);
  await p.locator('button[aria-label="Settings"]:visible').first().click(); await sleep(400); await p.locator('#settings-tab-memory').click();
  await sleep(600);
  const g = await p.locator('[data-action=add-widget-guide]').count();
  ck(`${tag} persona has Add widget guide`, g === 1, String(g));
  if (g) {
    await p.locator('[data-action=add-widget-guide]').click({ timeout: 4000 });
    await sleep(150);
    const val = await p.evaluate(() => [...document.querySelectorAll('textarea')].map((t) => t.value).find((v) => v.includes('Interactive widgets')) || '');
    ck(`${tag} widget guide is added to the persona text`, /```widget|`widget`/.test(val), val.slice(0, 60));
  }
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const sizes = (process.env.SIZES || '320x640m,360x740m,390x844m,740x360m,1280x800').split(',').map((s) => { const m = /^(\d+)x(\d+)(m?)$/.exec(s); return [+m[1], +m[2], !!m[3]]; });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [w, hgt, mobile] of sizes) {
    for (const dark of [false, true]) {
      for (const [name, fn] of Object.entries(S)) {
        if (only && !only.includes(name)) continue;
        const tag = `${w}x${hgt}${dark ? ' dark' : ''} ${name}`;
        const { p, ctx, errs } = await open(browser, w, hgt, mobile, dark);
        const shot = !!process.env.SHOT && (w === 360 || w === 390) && (!dark || name === 'footer' || name === 'widgets');
        try { await fn(p, tag, { w, dark, shot }); } catch (e) { ck(`${tag} ran`, false, e.message.split('\n')[0]); }
        const ov = await overflow(p);
        ck(`${tag} no page sideways scroll`, ov.ok, JSON.stringify(ov));
        ck(`${tag} no console errors / network`, !errs.length, errs.slice(0, 3).join(' | '));
        await ctx.close();
      }
    }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(fails.join('\n'));
  console.log(`${results.length - fails.length}/${results.length} passed`);
})();
