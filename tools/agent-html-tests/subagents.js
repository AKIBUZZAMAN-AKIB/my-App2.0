// Sub-agents UI (stage B) and live diagrams (stage C): hard checks with a stateful fake engine.
// Covers feature detection, NativeKit rejections, out-of-order and late events, approval
// labelling, parallel runs, memory ops, limits validation, rapid taps, reload persistence,
// keyboard, injection, huge lists, and layout at 320/360/390/desktop in light and dark.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep, overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = require('path').join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = require('fs').existsSync(b) ? require('fs').readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? require('path').join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${require('path').resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/safe/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const dir = __dirname;
const mock = fs.readFileSync(`${dir}/mock3.js`, 'utf8');
const mockV2 = fs.readFileSync(`${dir}/mock-v2.js`, 'utf8');
const mockSA = fs.readFileSync(`${dir}/mock-subagents.js`, 'utf8');
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + extra : ''}`); return ok; };

async function open(browser, { w = 390, hgt = 844, mobile = true, dark = false, cfg = {}, storageState } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', storageState });
  await ctx.addInitScript(`window.__SA_CFG = ${JSON.stringify(cfg)};`);
  await ctx.addInitScript(mock);
  await ctx.addInitScript(mockV2);
  await ctx.addInitScript(mockSA);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob):/.test(u)) errs.push('NETWORK: ' + u); });
  p.on('dialog', (d) => { errs.push('NATIVE DIALOG: ' + d.message()); d.dismiss(); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => { if (window.__sa) window.__sa.mainKey = window.__app.chat.mainId; });
  await sleep(150);
  return { p, ctx, errs };
}
const calls = (p, name = 'agent.subagents') => p.evaluate((n) => window.__mock.calls.filter((c) => c.name === n).map((c) => c.args), name);
const sa = (p, fn, arg) => p.evaluate(fn, arg);
const toastText = (p) => p.evaluate(() => [...document.querySelectorAll('.toast, [data-sonner-toast], .aui-toast')].map((t) => t.textContent).join(' | '));
const openScreen = async (p) => { await p.evaluate(() => window.__subagents.open(window.__app)); await p.waitForSelector('.sa-dialog .sa-panel'); await sleep(200); };
const closeDialogs = async (p) => { for (let i = 0; i < 4; i++) { if (!(await p.$('.dialog'))) break; await p.keyboard.press('Escape'); await sleep(120); } };

async function testFeatureMissing(browser) {
  for (const cfg of [{ feature: false }, { method: false }]) {
    const tag = cfg.feature === false ? 'no feature' : 'no method';
    const { p, ctx, errs } = await open(browser, { cfg });
    const hidden = await p.evaluate(() => [...document.querySelectorAll('.sa-open-screen')].every((b) => b.hidden));
    check(`[${tag}] Agents sidebar button hidden`, hidden);
    await p.evaluate(() => window.__subagents.open(window.__app));
    await sleep(200);
    const note = await p.evaluate(() => document.querySelector('.sa-dialog .sa-panel')?.innerText || '');
    check(`[${tag}] screen explains the engine is too old`, /newer app engine/i.test(note), note);
    check(`[${tag}] no subagents() call made`, (await calls(p)).length === 0);
    // A spawn_subagent tool card still renders (from args alone) without the feature.
    await p.evaluate(() => window.__mock.emit('tool_use', { toolCallId: 'x1', toolName: 'spawn_subagent', args: { name: 'scout', task: 'look around' } }));
    await sleep(200);
    const card = await p.evaluate(() => document.querySelector('[data-slot="subagent-card"]')?.innerText || '');
    check(`[${tag}] inline card falls back to the call's args`, /scout/.test(card) && /look around/.test(card), card);
    check(`[${tag}] no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

async function testCardAndEvents(browser) {
  const { p, ctx, errs } = await open(browser);
  // The main agent calls spawn_subagent; the engine starts it and streams progress.
  await sa(p, () => {
    window.__mock.emit('agent.started', {});
    window.__mock.emit('tool_use', { toolCallId: 'call-1', toolName: 'spawn_subagent', args: { name: 'researcher', task: 'Find the CSE 201 syllabus' } });
    const s = window.__sa.make({ name: 'researcher', task: 'Find the CSE 201 syllabus', tokenBudget: 10000, maxSteps: 5 });
    window.__sa.emit('subagent.started', { ...s });
    window.__sa.progress(s.id, { steps: 1, preview: 'Searching the course pages' }, 'step');
    window.__sa.emit('subagent.tool_call', { ...s, tool: 'web_fetch', toolCallId: 'w1' });
    window.__sa.progress(s.id, { inputTokens: 4000, outputTokens: 3500, totalTokens: 7500 }, 'usage');
  });
  await sleep(300);
  const card = () => p.evaluate(() => { const c = document.querySelector('[data-slot="subagent-card"]'); return c ? { text: c.innerText, status: c.dataset.status, stop: c.querySelector('.sa-stop')?.disabled, meter: c.querySelector('.sa-meter')?.dataset.level, now: c.querySelector('.sa-meter')?.getAttribute('aria-valuenow') } : null; });
  let c = await card();
  check('card shows the sub-agent name and task', c && /researcher/.test(c.text) && /CSE 201 syllabus/.test(c.text), JSON.stringify(c));
  check('card shows live steps x/max', c && /1\/5 steps/.test(c.text), c?.text);
  check('card shows live tool call', c && /web_fetch/.test(c.text), c?.text);
  check('card shows tokens vs budget', c && /7\.5k \/ 10k tokens/.test(c.text), c?.text);
  check('token meter is amber at 75%', c?.meter === 'mid' && c?.now === '7500', JSON.stringify(c));
  check('card shows the step preview', c && /Searching the course pages/.test(c.text));
  check('Stop enabled while running', c?.stop === false);
  // Rapid repeated taps on Stop make one call only.
  const stopBtn = p.locator('[data-slot="subagent-card"] .sa-stop');
  await stopBtn.click(); await stopBtn.click({ force: true }).catch(() => {}); await stopBtn.click({ force: true }).catch(() => {});
  await sleep(400);
  const stops = (await calls(p)).filter((x) => x.action === 'stop');
  check('rapid Stop taps send one stop call', stops.length === 1, JSON.stringify(stops));
  c = await card();
  check('card shows Stopped after cancel event', c?.status === 'cancelled' && /Stopped/.test(c.text), JSON.stringify(c));
  // Late, out-of-order progress after the end must not flip it back to running.
  await sa(p, () => { const s = [...window.__sa.subs.values()][0]; window.__sa.emit('subagent.step', { ...s, status: 'running', steps: 1, preview: 'late' }); window.__sa.emit('subagent.usage', { ...s, status: 'running', inputTokens: 1, outputTokens: 1 }); });
  await sleep(250);
  c = await card();
  check('late step/usage events keep the final status', c?.status === 'cancelled', JSON.stringify(c));
  check('Stop disabled once stopped', c?.stop === true);
  // Retry from the detail, then finish with a report.
  const id = await sa(p, () => [...window.__sa.subs.keys()][0]);
  await p.locator('[data-slot="subagent-card"] .sa-open').click();
  await p.waitForSelector('.sa-dialog .sa-detail-name');
  check('Open goes straight to that sub-agent', (await p.textContent('.sa-detail-name')) === 'researcher');
  const retry = p.locator('.sa-detail-actions button', { hasText: 'Try again' });
  await retry.click(); await retry.click({ force: true }).catch(() => {});
  await sleep(400);
  check('rapid Retry taps send one retry', (await calls(p)).filter((x) => x.action === 'retry').length === 1);
  await sa(p, (i) => window.__sa.finish(i, 'Syllabus: 5 units, 2 CTs, final in week 16.'), id);
  await sleep(700);
  const detail = await p.evaluate(() => document.querySelector('.sa-dialog .sa-panel')?.innerText || '');
  check('detail re-fetches and shows the report after finishing', /Syllabus: 5 units/.test(detail) && /Finished/.test(detail), detail.slice(0, 300));
  check('detail shows the chat view', await p.evaluate(() => !!document.querySelector('.sa-chat .sa-chat-msg[data-role="user"] .sa-bubble') && !!document.querySelector('.sa-chat .sa-chat-msg[data-role="assistant"] .sa-msg-body')));
  await closeDialogs(p);
  c = await card();
  check('card shows the report when finished', /Syllabus: 5 units/.test(c?.text || '') && c?.status === 'finished', JSON.stringify(c));
  // Approval request from a sub-agent is labelled with its name.
  await sa(p, () => window.__mock.emit('approval_request', { toolCallId: 'ap-1', toolName: 'write_file', args: { path: 'notes.md', content: 'x' }, subagent: { id: 'sa_0001', name: 'researcher' }, subagentSessionKey: 'sub:sa_0001', sessionKey: window.__app.chat.mainId }));
  await sleep(300);
  const ap = await p.evaluate(() => { const c = document.querySelector('[data-slot="approval-card"]'); return c ? { by: c.querySelector('[data-slot="approval-card-subagent"]')?.textContent, label: c.getAttribute('aria-label') } : null; });
  check('approval card names the sub-agent', /Asked by sub-agent researcher/.test(ap?.by || ''), JSON.stringify(ap));
  check('approval card aria-label names the sub-agent', /asked by sub-agent researcher/.test(ap?.label || ''));
  // Approve it: the response goes to the engine with the same toolCallId.
  const approve = p.locator('[data-slot="approval-card"] [data-slot="approval-card-allow-once"]').first();
  if (await approve.count()) { await approve.click(); await sleep(250); }
  const resp = await calls(p, 'agent.respondToApproval');
  check('approving a sub-agent request answers its toolCallId', resp.some((r) => JSON.stringify(r).includes('ap-1')), JSON.stringify(resp));
  // A regular approval has no sub-agent line.
  await sa(p, () => window.__mock.emit('approval_request', { toolCallId: 'ap-2', toolName: 'execute_command', args: { command: 'ls' } }));
  await sleep(250);
  const plain = await p.evaluate(() => [...document.querySelectorAll('[data-slot="approval-card"]')].map((c) => !!c.querySelector('[data-slot="approval-card-subagent"]')));
  check('main-agent approval has no sub-agent label', plain.length >= 2 && plain[plain.length - 1] === false, JSON.stringify(plain));
  // A sub-agent's MCP call must not show up as the main agent's tool call.
  const before = await p.evaluate(() => document.querySelectorAll('.aui-tool-call').length);
  await sa(p, () => window.__mock.emit('mcp_tool_call', { toolCallId: 'm1', toolName: 'device__vibrate', args: {}, subagent: { id: 'sa_0001', name: 'researcher' }, sessionKey: window.__app.chat.mainId }));
  await sleep(250);
  check("a sub-agent's MCP call stays out of the main thread", (await p.evaluate(() => document.querySelectorAll('.aui-tool-call').length)) === before);
  // Garbage events never throw.
  await sa(p, () => { window.__mock.emit('subagent.step', null); window.__mock.emit('subagent.step', { noid: 1 }); window.__mock.emit('subagent.unknown_kind', { id: 'zzz' }); window.__mock.listener; });
  await sleep(200);
  check('malformed sub-agent events are ignored safely', !errs.some((e) => /pageerror/.test(e)), errs.join(' / '));
  check('no console errors (card + events)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testScreen(browser) {
  const { p, ctx, errs } = await open(browser);
  check('Agents sidebar button visible with the feature', await p.evaluate(() => [...document.querySelectorAll('.sa-open-screen')].some((b) => !b.hidden)));
  await openScreen(p);
  check('empty state shown with no sub-agents', /No sub-agents yet/.test(await p.innerText('.sa-panel')));
  // Presets: validation.
  await p.click('[data-tab="presets"]');
  await sleep(150);
  const form = '.sa-form';
  await p.click(`${form} button:has-text("Add preset")`);
  await sleep(150);
  check('preset with empty name is rejected', (await p.getAttribute(`${form} input[type="text"]`, 'aria-invalid')) === 'true');
  await p.fill(`${form} input[type="text"] >> nth=0`, 'researcher');
  await p.fill(`${form} input[type="text"] >> nth=1`, 'Researcher');
  await p.fill(`${form} textarea`, 'Cite every source.');
  const nums = p.locator(`${form} input[type="number"]`);
  await nums.nth(0).fill('500'); // below 1000
  await p.click(`${form} button:has-text("Add preset")`);
  await sleep(150);
  check('preset with a too-small budget is rejected', (await nums.nth(0).getAttribute('aria-invalid')) === 'true' && !(await p.evaluate(() => localStorage.getItem('agent.subagents.presets.v1'))));
  await nums.nth(0).fill('50000'); await nums.nth(1).fill('12');
  const firstTool = p.locator(`${form} .sa-tool-opt input`).first();
  check('preset tool picker lists engine tools', (await p.locator(`${form} .sa-tool-opt`).count()) >= 20);
  check('preset tool picker excludes ui__ and sub-agent tools', !(await p.evaluate(() => [...document.querySelectorAll('.sa-tool-opt code')].some((c) => /^ui__|_subagent/.test(c.textContent)))));
  await firstTool.check();
  await p.click(`${form} button:has-text("Add preset")`);
  await sleep(200);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('agent.subagents.presets.v1') || '[]'));
  check('preset saved with role, prompt, budget, steps and tools', saved.length === 1 && saved[0].role === 'Researcher' && saved[0].tokenBudget === 50000 && saved[0].maxSteps === 12 && saved[0].tools.length === 1 && saved[0].prompt === 'Cite every source.', JSON.stringify(saved));
  await p.fill(`${form} input[type="text"] >> nth=0`, 'RESEARCHER');
  await p.click(`${form} button:has-text("Add preset")`);
  await sleep(150);
  check('duplicate preset name (any case) rejected', (await p.evaluate(() => JSON.parse(localStorage.getItem('agent.subagents.presets.v1')).length)) === 1);
  // Run the preset: empty task blocked, then spawn with the preset's spec.
  await p.click('.sa-list button:has-text("Run")');
  await p.waitForSelector('.dialog textarea[aria-label="Task"]');
  await p.click('.dialog button:has-text("Start")');
  await sleep(150);
  check('Run with empty task blocked', (await calls(p)).filter((x) => x.action === 'spawn').length === 0);
  await p.fill('.dialog textarea[aria-label="Task"]', 'Summarise chapter 3');
  const start = p.locator('.dialog button:has-text("Start")');
  await start.click(); await start.click({ force: true }).catch(() => {});
  await sleep(500);
  const spawns = (await calls(p)).filter((x) => x.action === 'spawn');
  check('rapid Start taps spawn once', spawns.length === 1, JSON.stringify(spawns));
  check('spawn carries the preset spec', spawns[0] && spawns[0].name === 'researcher' && spawns[0].role === 'Researcher' && spawns[0].systemPrompt === 'Cite every source.' && spawns[0].tokenBudget === 50000 && spawns[0].maxSteps === 12 && spawns[0].tools?.length === 1 && spawns[0].task === 'Summarise chapter 3', JSON.stringify(spawns[0]));
  check('after spawn the detail of the new sub-agent opens', /researcher/.test((await p.textContent('.sa-detail-name').catch(() => '')) || ''));
  // Parallel + filter.
  await sa(p, () => { window.__sa.make({ name: 'coder', task: 'Write tests' }); window.__sa.make({ name: 'checker', task: 'Review', status: 'finished', result: 'All good' }); });
  await p.click('[data-tab="agents"]');
  await p.click('.sa-toolbar button[aria-label="Refresh"]');
  await sleep(300);
  const rows = await p.evaluate(() => [...document.querySelectorAll('.sa-row .sa-row-name')].map((e) => e.textContent));
  check('list shows all sub-agents, running first', rows.length === 3 && rows[rows.length - 1] === 'checker', JSON.stringify(rows));
  check('parallel slot count shown', /2 of 3 parallel slots/.test(await p.innerText('.sa-panel')));
  await p.selectOption('.sa-toolbar select', 'finished');
  await sleep(200);
  check('filter Finished shows only finished', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.sa-row .sa-row-name')].map((e) => e.textContent))) === '["checker"]');
  await p.selectOption('.sa-toolbar select', 'all');
  // Stop all with confirm.
  await p.click('.sa-toolbar button:has-text("Stop all")');
  await p.waitForSelector('.dialog >> text=Stop every running sub-agent?');
  await p.click('.dialog button:has-text("Stop all") >> nth=-1');
  await sleep(400);
  check('Stop all sends stop {all:true} after confirm', (await calls(p)).some((x) => x.action === 'stop' && x.all === true));
  check('no running sub-agents after Stop all', !(await p.evaluate(() => [...window.__subagents.records.values()].some((r) => r.status === 'running'))));
  // NativeKit rejection: toast, no crash, button usable again.
  const cid = await sa(p, () => [...window.__sa.subs.values()].find((s) => s.name === 'coder').id);
  await sa(p, () => window.__sa.failNext.set('retry', 'engine busy (test)'));
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i }), cid);
  await p.waitForSelector('.sa-detail-name');
  await p.click('.sa-detail-actions button:has-text("Try again")');
  await sleep(400);
  check('a rejected retry shows the error as a toast', /engine busy \(test\)/.test(await toastText(p)), await toastText(p));
  // get() failing: detail shows the error and still has Back.
  await sa(p, () => window.__sa.failNext.set('get', 'disk full (test)'));
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i }), cid);
  await sleep(400);
  const dt = await p.innerText('.sa-panel');
  check('detail shows a failed get() and stays usable', /disk full \(test\)/.test(dt) && /All agents/.test(dt), dt.slice(0, 200));
  // Memory ops.
  await sa(p, () => window.__sa.memory.set('coder', [{ key: 'style', text: 'Use Vitest', updatedAt: 1 }, { key: 'repo', text: 'my-App2.0', updatedAt: 2 }]));
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i }), cid);
  await p.waitForSelector('.sa-mem-row');
  check('memory entries listed', (await p.locator('.sa-mem-row').count()) === 2);
  await p.click('.sa-mem-row >> nth=0 >> button[aria-label="Copy to main memory"]');
  await sleep(300);
  await p.click('.sa-mem-row >> nth=0 >> button[aria-label="Delete entry"]');
  await sleep(400);
  const mem = (await calls(p)).filter((x) => x.action === 'memory');
  check('promote one entry sends op promote with key', mem.some((m) => m.op === 'promote' && m.key === 'style' && m.name === 'coder'), JSON.stringify(mem));
  check('delete entry sends op delete with key', mem.some((m) => m.op === 'delete' && m.key === 'style'));
  check('deleted entry disappears', (await p.locator('.sa-mem-row').count()) === 1);
  await p.click('.sa-section button:has-text("Clear")');
  await p.waitForSelector('.dialog >> text=memory?');
  await p.keyboard.press('Escape');
  await sleep(200);
  check('Clear needs a confirm (Escape cancels)', !(await calls(p)).some((x) => x.action === 'memory' && x.op === 'clear'));
  await p.click('.sa-section button:has-text("Clear")');
  await p.click('.dialog button:has-text("Clear") >> nth=-1');
  await sleep(400);
  check('Clear after confirm clears memory', (await calls(p)).some((x) => x.action === 'memory' && x.op === 'clear' && x.name === 'coder') && (await p.locator('.sa-mem-row').count()) === 0);
  // Message: empty blocked, then sent.
  await p.click('.sa-section button:has-text("Send")');
  check('empty message blocked', (await p.getAttribute('.sa-msg-input', 'aria-invalid')) === 'true' && !(await calls(p)).some((x) => x.action === 'message'));
  await p.fill('.sa-msg-input', 'Also cover edge cases');
  await p.click('.sa-section button:has-text("Send")');
  await sleep(300);
  check('message sent to the sub-agent', (await calls(p)).some((x) => x.action === 'message' && x.id === cid && x.message === 'Also cover edge cases'));
  // Delete with confirm.
  await p.click('.sa-detail-actions button:has-text("Delete")');
  await p.check('[data-slot="delete-sheet"] input[data-part="all"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  await p.click('[data-slot="delete-confirm"]');
  await sleep(400);
  check('delete removes it and returns to the list', !(await p.evaluate((i) => window.__subagents.records.has(i), cid)) && !!(await p.$('.sa-list, .sa-empty')));
  // Limits: invalid values rejected, valid saved.
  await p.click('[data-tab="settings"]');
  await sleep(150);
  const lim = p.locator('.sa-panel input[type="number"]');
  await lim.nth(1).fill('0');
  await p.click('.sa-panel button:has-text("Save")');
  await sleep(200);
  check('max parallel 0 rejected without a call', (await lim.nth(1).getAttribute('aria-invalid')) === 'true' && !(await calls(p)).some((x) => x.action === 'settings' && x.settings));
  await lim.nth(1).fill('2.5');
  await p.click('.sa-panel button:has-text("Save")');
  await sleep(150);
  check('fractional max parallel rejected', !(await calls(p)).some((x) => x.action === 'settings' && x.settings));
  await lim.nth(1).fill('5'); await lim.nth(0).fill('2'); await lim.nth(4).fill('120');
  await p.click('.sa-panel button:has-text("Save")');
  await sleep(400);
  const st = (await calls(p)).filter((x) => x.action === 'settings' && x.settings).pop();
  check('valid limits saved to the engine', st && st.settings.maxParallel === 5 && st.settings.maxDepth === 2 && st.settings.timeoutSeconds === 120, JSON.stringify(st));
  // Keyboard: tabs with arrows, Escape closes and returns focus.
  await p.focus('[data-tab="settings"]');
  await p.keyboard.press('ArrowRight');
  check('ArrowRight wraps to the first tab', (await p.evaluate(() => document.activeElement?.dataset.tab)) === 'agents' && (await p.getAttribute('[data-tab="agents"]', 'aria-selected')) === 'true');
  await p.keyboard.press('End');
  check('End goes to the last tab', (await p.evaluate(() => document.activeElement?.dataset.tab)) === 'settings');
  check('tabs have roles and aria-controls', await p.evaluate(() => [...document.querySelectorAll('.sa-tabs [role="tab"]')].every((t) => document.getElementById(t.getAttribute('aria-controls')))));
  await p.keyboard.press('Escape');
  await sleep(200);
  check('Escape closes the Agents screen', !(await p.$('.sa-dialog')));
  check('no console errors (screen)', !errs.length, errs.join(' / '));
  // Reload persistence of presets.
  await p.reload();
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'presets' }));
  await sleep(300);
  check('presets survive a reload', /researcher/.test(await p.innerText('.sa-panel')));
  await ctx.close();
}

async function testDiagrams(browser) {
  const { p, ctx, errs } = await open(browser);
  await sa(p, () => {
    const a1 = window.__sa.make({ name: 'researcher', task: 'Find; the: syllabus #1' });
    const a2 = window.__sa.make({ name: '<img src=x onerror=window.__pwned=1>', task: '"]; click main call alert(1)' });
    window.__sa.emit('subagent.started', { ...a1, task: a1.task });
    window.__sa.emit('subagent.started', { ...a2, task: a2.task });
    window.__sa.finish(a1.id, 'done');
  });
  await sleep(200);
  const tree = await p.evaluate(() => window.__subagents.treeSource());
  check('tree source has main and both sub-agents', /Main agent/.test(tree) && /researcher/.test(tree) && (tree.match(/main --> a\d/g) || []).length === 2, tree);
  check('tree source strips markup and quotes from names', !tree.includes('<img') && !/onerror=/.test(tree) && !/\["[^"\n]*"[^\]\n]*"\]/.test(tree), tree);
  check('tree source colours by status', /:::ok/.test(tree) && /:::run/.test(tree));
  const seq = await p.evaluate(() => window.__subagents.sequenceSource());
  check('sequence closes each activation it opened', (seq.match(/->>\+/g) || []).length >= (seq.match(/--(?:>>|x)-/g) || []).length, seq);
  check('sequence strips ; # : from messages', !/Find; the:/.test(seq));
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' }));
  await p.waitForFunction(() => document.querySelectorAll('.sa-diagram svg[id^="aui-mermaid"]').length >= 2, null, { timeout: 15000 }).catch(() => {});
  const svgs = await p.evaluate(() => [...document.querySelectorAll('.sa-diagram')].map((d) => ({ svg: !!d.querySelector('svg[id^="aui-mermaid"]'), err: d.querySelector('.aui-mermaid')?.dataset.state, text: [...(d.querySelector('svg[id^="aui-mermaid"]')?.querySelectorAll('text, tspan, foreignObject') || [])].map((t) => t.textContent).join(' ').slice(0, 400) })));
  check('both diagrams render as SVG', svgs.length === 2 && svgs.every((s) => s.svg), JSON.stringify(svgs));
  check('tree diagram shows the names', /researcher/.test(svgs[0]?.text || ''));
  check('no script from a hostile name ran', !(await p.evaluate(() => window.__pwned)));
  // Live update: a new sub-agent appears in the open diagram.
  await sa(p, () => { const s = window.__sa.make({ name: 'latecomer', task: 'x' }); window.__sa.emit('subagent.started', { ...s }); });
  await p.waitForFunction(() => /latecomer/.test(document.querySelector('.sa-diagram svg[id^="aui-mermaid"]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('diagram updates live with a new sub-agent', /latecomer/.test(await p.evaluate(() => document.querySelector('.sa-diagram svg[id^="aui-mermaid"]')?.textContent || '')));
  // Unpaired finish (missed the start event) still renders.
  await sa(p, () => { const s = window.__sa.make({ name: 'orphan' }); window.__sa.finish(s.id, 'ok'); window.__sa.fail(s.id, 'oops: bad'); });
  const seq2 = await p.evaluate(() => window.__subagents.sequenceSource());
  { const act = {}; let ok = true; for (const l of seq2.split('\n')) { let m = l.match(/->>\+(S\d+)/); if (m) act[m[1]] = (act[m[1]] || 0) + 1; m = l.match(/^\s*(S\d+)--(?:>>|x)-M/); if (m) { act[m[1]] = (act[m[1]] || 0) - 1; if (act[m[1]] < 0) ok = false; } } check('unpaired end events never deactivate an inactive participant', ok, seq2); }
  await sleep(1200);
  const svg2 = await p.evaluate(() => [...document.querySelectorAll('.sa-diagram')].map((d) => !!d.querySelector('svg[id^="aui-mermaid"]') || (d.querySelector('.aui-mermaid')?.dataset.state + ' ' + (d.querySelector('.aui-mermaid-note')?.textContent || '') + ' SRC ' + d._src)));
  check('diagrams still render after unpaired events', svg2.length === 2 && svg2.every((x) => x === true), JSON.stringify(svg2));
  // Opening the diagram from the inline card.
  await p.keyboard.press('Escape');
  await sa(p, () => window.__mock.emit('tool_use', { toolCallId: 'c9', toolName: 'spawn_subagent', args: { name: 'researcher', task: 'Find; the: syllabus #1' } }));
  await sleep(200);
  await p.click('[data-slot="subagent-card"] .sa-tree');
  await sleep(300);
  check('card Diagram button opens the Diagram tab', (await p.getAttribute('[data-tab="diagram"]', 'aria-selected')) === 'true');
  check('no console errors (diagrams)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testHugeAndLayout(browser) {
  const sizes = [[320, 640, true], [360, 740, true], [390, 844, true], [1280, 800, false]];
  for (const [w, hgt, mobile] of sizes) for (const dark of [false, true]) {
    const tag = `${w}${dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, { w, hgt, mobile, dark });
    await sa(p, () => {
      for (let i = 0; i < 200; i++) window.__sa.make({ name: i % 7 ? `agent-${i}` : `a-very-long-sub-agent-name-${'x'.repeat(60)}-${i}`, task: 'T'.repeat(i % 5 ? 30 : 3000), status: i < 3 ? 'running' : ['finished', 'error', 'cancelled'][i % 3], inputTokens: i * 1000, outputTokens: i * 500, steps: i % 25 });
      window.__mock.emit('tool_use', { toolCallId: 'big', toolName: 'spawn_subagent', args: { name: 'agent-1', task: 'W'.repeat(5000) } });
    });
    const t0 = Date.now();
    await openScreen(p);
    await p.click('.sa-toolbar button[aria-label="Refresh"]');
    await p.waitForFunction(() => document.querySelectorAll('.sa-row').length === 200, null, { timeout: 8000 }).catch(() => {});
    const ms = Date.now() - t0;
    check(`[${tag}] 200 sub-agents listed`, (await p.locator('.sa-row').count()) === 200);
    check(`[${tag}] big list renders under 3 s`, ms < 3000, `${ms} ms`);
    let o = await overflow(p);
    check(`[${tag}] list: no page sideways scroll`, o.ok, JSON.stringify(o));
    if (w === 390 && !dark) await p.screenshot({ path: `${SHOTS}/agents-list-390.png` });
    if (w === 390 && dark) await p.screenshot({ path: `${SHOTS}/agents-list-390-dark.png` });
    const id = await sa(p, () => [...window.__sa.subs.values()][7].id);
    await sa(p, (i) => window.__sa.memory.set(window.__sa.subs.get(i).name, [{ key: 'k'.repeat(200), text: 'v '.repeat(400), updatedAt: 1 }]), id);
    await p.evaluate((i) => window.__subagents.open(window.__app, { id: i }), id);
    await p.waitForSelector('.sa-detail-name');
    o = await overflow(p);
    check(`[${tag}] detail: no page sideways scroll`, o.ok, JSON.stringify(o));
    if (w === 390 && !dark) await p.screenshot({ path: `${SHOTS}/agents-detail-390.png` });
    for (const tab of ['diagram', 'presets', 'settings']) {
      await p.click(`[data-tab="${tab}"]`);
      await sleep(tab === 'diagram' ? 1500 : 200);
      o = await overflow(p);
      check(`[${tag}] ${tab}: no page sideways scroll`, o.ok, JSON.stringify(o));
      if (w === 390 && (!dark || tab === 'diagram')) await p.screenshot({ path: `${SHOTS}/agents-${tab}-390${dark ? '-dark' : ''}.png` });
    }
    await closeDialogs(p);
    o = await overflow(p);
    check(`[${tag}] chat with a huge sub-agent card: no sideways scroll`, o.ok, JSON.stringify(o));
    if (w === 390 && !dark) { await p.locator('[data-slot="subagent-card"]').first().scrollIntoViewIfNeeded().catch(() => {}); await p.screenshot({ path: `${SHOTS}/subagent-card-390.png` }); }
    check(`[${tag}] no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testFeatureMissing, testCardAndEvents, testScreen, testDiagrams, testHugeAndLayout };
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 4).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\nsubagents: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
