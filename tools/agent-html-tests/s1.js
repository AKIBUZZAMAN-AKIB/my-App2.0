// S1 hard checks: the sub-agent queue, the sub-agent as a full chat, partial use, reuse,
// the delete-data sheet, bulk delete and cross-session messaging, with failure paths,
// keyboard/a11y and layout at 320/360/390/1280 light and dark. Mock NativeKit only.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep, overflow } = require('./feat.js');
const EXE = '/home/sprite/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const URL_ = process.env.URL_ || 'file:///home/sprite/my-App/www/agent.html';
const SHOTS = process.env.SHOTS || '/home/sprite/safe/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const dir = __dirname;
const mock = fs.readFileSync(`${dir}/mock3.js`, 'utf8');
const mockV2 = fs.readFileSync(`${dir}/mock-v2.js`, 'utf8');
const mockSA = fs.readFileSync(`${dir}/mock-subagents.js`, 'utf8');
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + String(extra).slice(0, 400) : ''}`); return ok; };

// Records what the page copies (clipboard API or the execCommand fallback).
const clipSpy = `(() => {
  window.__copied = [];
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(String(t)); }, readText: async () => window.__copied.at(-1) || '' } }); } catch {}
  const ex = Document.prototype.execCommand;
  Document.prototype.execCommand = function (c, ...r) { if (c === 'copy') { const a = document.activeElement; window.__copied.push(a && 'value' in a ? a.value : String(getSelection())); return true; } return ex.call(this, c, ...r); };
})();`;

async function open(browser, { w = 390, hgt = 844, mobile = true, dark = false, cfg = {}, storageState, ctxIn } = {}) {
  const ctx = ctxIn || await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', storageState });
  if (!ctxIn) {
    await ctx.addInitScript(`window.__SA_CFG = ${JSON.stringify(cfg)};`);
    await ctx.addInitScript(mock);
    await ctx.addInitScript(mockV2);
    await ctx.addInitScript(mockSA);
    await ctx.addInitScript(clipSpy);
  }
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
const acts = async (p, action) => (await calls(p)).filter((x) => x.action === action);
const sa = (p, fn, arg) => p.evaluate(fn, arg);
const toastText = (p) => p.evaluate(() => [...document.querySelectorAll('.toast, [data-sonner-toast], .aui-toast, [role="status"].toast')].map((t) => t.textContent).join(' | '));
const composerText = (p) => p.evaluate(() => document.querySelector('.aui-composer-input')?.value || '');
const closeDialogs = async (p) => { for (let i = 0; i < 5; i++) { if (!(await p.$('.dialog'))) break; await p.keyboard.press('Escape'); await sleep(120); } };
const openDetail = async (p, id) => { await p.evaluate((i) => window.__subagents.open(window.__app, { id: i }), id); await p.waitForSelector('.sa-detail-name', { timeout: 5000 }); await sleep(250); };
const openList = async (p) => { await p.evaluate(() => window.__subagents.open(window.__app)); await p.waitForSelector('.sa-dialog .sa-panel'); await sleep(250); };

/** A finished sub-agent with a rich chat: task, tool use, tool result, a final reply with blocks. */
const richChat = () => sa(null, null); // placeholder (see seedRich)
async function seedRich(p, { status = 'finished', name = 'researcher', depth = 1, parentSessionKey } = {}) {
  return sa(p, ({ status, name, depth, parentSessionKey }) => {
    const s = window.__sa.make({ name, task: 'Summarise CSE 201', status, depth, parentSessionKey, result: status === 'finished' ? 'Final report: 3 units.' : null, steps: 3, toolCalls: 1, inputTokens: 1200, outputTokens: 300, tools: ['web_fetch'] });
    window.__sa.transcripts.set(s.id, [
      { role: 'user', content: 'Summarise CSE 201' },
      { role: 'assistant', content: [{ type: 'text', text: 'Fetching the page.' }, { type: 'tool_use', id: 't1', name: 'web_fetch', input: { url: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-OTHER-HISTORY page body' }] },
      { role: 'assistant', content: [{ type: 'text', text: '## Units\n\n- Unit one\n- Unit two\n\n```python\nprint("hi")\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nLast paragraph here.' }] },
      { role: 'user', content: 'Add the exam dates' },
      { role: 'assistant', content: [{ type: 'text', text: 'Exams are in week 8.' }] },
    ]);
    return s.id;
  }, { status, name, depth, parentSessionKey });
}

async function testQueue(browser) {
  const { p, ctx, errs } = await open(browser);
  const id = await sa(p, () => {
    for (let i = 0; i < 3; i++) window.__sa.make({ name: `busy-${i}`, task: 'busy', status: 'running' });
    const s = window.__sa.make({ name: 'waiter', task: 'Wait your turn', status: 'queued', queuePosition: 2, priority: 0 });
    window.__mock.emit('tool_use', { toolCallId: 'q1', toolName: 'spawn_subagent', args: { name: 'waiter', task: 'Wait your turn' } });
    window.__sa.emit('subagent.queued', { ...s });
    return s.id;
  });
  await sleep(300);
  const card = await p.evaluate(() => { const c = [...document.querySelectorAll('[data-slot="subagent-card"]')].pop(); return c ? { text: c.innerText, status: c.dataset.status, stop: c.querySelector('.sa-stop')?.textContent, q: c.querySelector('[data-slot="subagent-queue"]')?.textContent } : null; });
  check('queue: card status is queued', card?.status === 'queued', JSON.stringify(card));
  check('queue: card shows the queue position', /Waiting in queue · #2/.test(card?.q || ''), JSON.stringify(card));
  check('queue: card button reads Cancel', /Cancel/.test(card?.stop || ''), card?.stop);
  // Position moves up live.
  await sa(p, (i) => window.__sa.progress(i, { queuePosition: 1, status: 'queued' }, 'queued'), id);
  await sleep(250);
  check('queue: position updates live', /#1/.test(await p.evaluate(() => [...document.querySelectorAll('[data-slot="subagent-queue"]')].pop()?.textContent || '')));
  // List: queued filter and waiting hint.
  await openList(p);
  await p.click('.sa-toolbar button[aria-label="Refresh"]');
  await sleep(300);
  const opts = await p.evaluate(() => [...document.querySelectorAll('.sa-toolbar select option')].map((o) => o.textContent));
  check('queue: list has a Queued filter with the count', opts.some((o) => /Queued \(1\)/.test(o)), JSON.stringify(opts));
  check('queue: list hint counts waiting ones', /1 waiting/.test(await p.evaluate(() => document.querySelector('.sa-panel')?.innerText || '')));
  await p.selectOption('.sa-toolbar select', 'queued');
  await sleep(150);
  check('queue: Queued filter shows only the queued one', (await p.locator('.sa-row').count()) === 1 && /waiter/.test(await p.locator('.sa-row').first().innerText()));
  await p.click('.sa-row-main');
  await p.waitForSelector('.sa-detail-name');
  await sleep(250);
  const box = await p.evaluate(() => { const b = document.querySelector('[data-slot="subagent-queue-box"]'); return b ? { text: b.innerText, role: b.getAttribute('role'), pri: b.querySelector('select')?.value, dis: b.querySelector('select')?.disabled } : null; });
  check('queue: detail shows the queue box (role=status)', box && box.role === 'status' && /Waiting in queue/.test(box.text), JSON.stringify(box));
  check('queue: priority select starts at Normal (0)', box?.pri === '0' && box?.dis === false, JSON.stringify(box));
  if (process.env.SHOT !== '0') await p.screenshot({ path: `${SHOTS}/s1-queue-390.png` });
  await p.selectOption('[data-slot="subagent-queue-box"] select', '5');
  await sleep(300);
  const pr = await acts(p, 'priority');
  check('queue: changing priority calls priority with the number', pr.length === 1 && pr[0].id === id && pr[0].priority === 5, JSON.stringify(pr));
  // A NativeKit error on priority shows a toast and keeps the screen working.
  await sa(p, () => window.__sa.failNext.set('priority', 'queue is locked'));
  await p.selectOption('[data-slot="subagent-queue-box"] select', '-5');
  await sleep(350);
  check('queue: priority error shows a toast', /queue is locked/.test(await toastText(p)));
  check('queue: select re-enabled after an error', !(await p.evaluate(() => document.querySelector('[data-slot="subagent-queue-box"] select')?.disabled ?? true)));
  // A late "queued" event after it started does not pull it back into the queue.
  await sa(p, (i) => { const s = window.__sa.subs.get(i); s.status = 'running'; s.queuePosition = null; s.steps = 1; window.__sa.emit('subagent.started', { ...s }); window.__sa.emit('subagent.queued', { ...s, status: 'queued', queuePosition: 3, steps: 0 }); }, id);
  await sleep(300);
  check('queue: late queued event keeps it running', (await p.evaluate((i) => window.__subagents.records.get(i)?.status, id)) === 'running');
  // Cancel while queued (fresh queued one), rapid taps make one call.
  const id2 = await sa(p, () => { const s = window.__sa.make({ name: 'later', task: 'later', status: 'queued', queuePosition: 1 }); window.__sa.emit('subagent.queued', { ...s }); return s.id; });
  await openDetail(p, id2);
  const cancel = p.locator('[data-slot="subagent-queue-box"] button:has-text("Cancel")');
  await cancel.click(); await cancel.click({ force: true, timeout: 500 }).catch(() => {}); await cancel.click({ force: true, timeout: 500 }).catch(() => {});
  await sleep(400);
  const st = (await acts(p, 'stop')).filter((x) => x.id === id2);
  check('queue: Cancel while queued sends one stop', st.length === 1, JSON.stringify(st));
  check('queue: cancelled one leaves the queue', (await p.evaluate((i) => window.__subagents.records.get(i)?.status, id2)) === 'cancelled');
  // Reload keeps the queue state (from the engine list).
  const id3 = await sa(p, () => window.__sa.make({ name: 'persist', task: 'p', status: 'queued', queuePosition: 4 }).id);
  await closeDialogs(p);
  await p.reload();
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await openList(p);
  await sleep(300);
  // The mock lives in the page, so after reload the engine state is fresh; seed and refresh again.
  await sa(p, () => window.__sa.make({ name: 'persist', task: 'p', status: 'queued', queuePosition: 4 }));
  await p.click('.sa-toolbar button[aria-label="Refresh"]');
  await sleep(300);
  check('queue: after reload the queued one shows its position', /Waiting in queue · #4/.test(await p.evaluate(() => document.querySelector('.sa-panel')?.innerText || '')));
  check('queue: no console errors', !errs.length, errs.join(' / '));
  await ctx.close();
  void id3;

  // Engine without subagentQueue: priority disabled, no edit/regenerate/run-again.
  const o = await open(browser, { cfg: { s1features: ['subagentData', 'subagentReuse'] } });
  const qid = await sa(o.p, () => window.__sa.make({ name: 'q', task: 'q', status: 'queued', queuePosition: 1 }).id);
  await openDetail(o.p, qid);
  check('no queue feature: priority select disabled', await o.p.evaluate(() => document.querySelector('[data-slot="subagent-queue-box"] select')?.disabled === true));
  const fid = await seedRich(o.p);
  await openDetail(o.p, fid);
  const btns = await o.p.evaluate(() => ({ edit: !!document.querySelector('.sa-chat button[aria-label="Edit and resend"]'), regen: !!document.querySelector('.sa-chat button[aria-label="Regenerate"]'), rerun: !!document.querySelector('[data-slot="subagent-rerun"]'), copy: !!document.querySelector('.sa-chat button[aria-label="Copy reply"]') }));
  check('no queue feature: edit/regenerate/run-again hidden, copy kept', !btns.edit && !btns.regen && !btns.rerun && btns.copy, JSON.stringify(btns));
  check('no queue feature: no console errors', !o.errs.length, o.errs.join(' / '));
  await o.ctx.close();
}

async function testChatView(browser) {
  const { p, ctx, errs } = await open(browser);
  const id = await seedRich(p);
  await openDetail(p, id);
  const v = await p.evaluate(() => ({
    msgs: document.querySelectorAll('.sa-chat > .sa-chat-msg').length,
    users: document.querySelectorAll('.sa-chat-msg[data-role="user"]').length,
    tool: document.querySelector('.sa-chat-tool')?.textContent || '',
    calls: document.querySelector('.sa-chat-calls')?.textContent || '',
    md: { h2: !!document.querySelector('.sa-chat h2'), code: !!document.querySelector('.sa-chat pre'), table: !!document.querySelector('.sa-chat table') },
    label: document.querySelector('.sa-chat')?.getAttribute('aria-label'),
    text: document.querySelector('.sa-chat')?.innerText || '',
    regen: document.querySelectorAll('.sa-chat button[aria-label="Regenerate"]').length,
  }));
  check('chat: shows every message (2 user turns, 3 replies)', v.msgs === 5 && v.users === 2, JSON.stringify(v));
  check('chat: tool results collapse to one quiet line', /1 tool result/.test(v.tool), v.tool);
  check('chat: tool calls named under the reply', /web_fetch/.test(v.calls));
  check('chat: tool result body is not dumped', !/SECRET-OTHER-HISTORY/.test(v.text));
  check('chat: replies render Markdown (heading, code, table)', v.md.h2 && v.md.code && v.md.table, JSON.stringify(v.md));
  check('chat: list has an accessible name', /Chat with researcher/.test(v.label || ''));
  check('chat: Regenerate only on the last reply', v.regen === 1);
  if (process.env.SHOT !== '0') { await p.locator('.sa-chat-section').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/s1-subagent-chat-390.png` }); }
  // Copy one message and one reply.
  await p.click('.sa-chat-msg[data-role="user"] button[aria-label="Copy message"] >> nth=0');
  await sleep(150);
  await p.click('.sa-chat-msg[data-role="assistant"] button[aria-label="Copy reply"] >> nth=-1');
  await sleep(200);
  const copied = await p.evaluate(() => window.__copied);
  check('chat: copy message copies its text', copied.includes('Summarise CSE 201'), JSON.stringify(copied));
  check('chat: copy reply copies the reply', copied.includes('Exams are in week 8.'), JSON.stringify(copied));
  // Regenerate.
  await p.click('.sa-chat button[aria-label="Regenerate"]');
  await sleep(400);
  check('chat: Regenerate calls regenerate', (await acts(p, 'regenerate')).some((x) => x.id === id));
  check('chat: regenerated reply shows', /Regenerated answer/.test(await p.evaluate(() => document.querySelector('.sa-chat')?.innerText || '')));
  // Edit and resend turn 1 ("Add the exam dates").
  await p.click('.sa-chat-msg[data-turn="1"] button[aria-label="Edit and resend"]');
  await sleep(150);
  check('chat: edit opens a textarea with the old text', (await p.inputValue('.sa-edit-input')) === 'Add the exam dates');
  check('chat: edit field has focus', await p.evaluate(() => document.activeElement?.classList.contains('sa-edit-input')));
  await p.fill('.sa-edit-input', '   ');
  await p.click('button:has-text("Save and resend")');
  check('chat: empty edit blocked', (await p.getAttribute('.sa-edit-input', 'aria-invalid')) === 'true' && !(await acts(p, 'edit')).length);
  await p.fill('.sa-edit-input', 'Add exam and CT dates');
  await sa(p, () => { window.__sa.delay = 150; });
  const save = p.locator('button:has-text("Save and resend")');
  await save.click(); await save.click({ force: true, timeout: 300 }).catch(() => {});
  await sleep(700);
  await sa(p, () => { window.__sa.delay = 0; });
  const ed = await acts(p, 'edit');
  check('chat: Save and resend sends one edit with the turn and text', ed.length === 1 && ed[0].turn === 1 && ed[0].message === 'Add exam and CT dates', JSON.stringify(ed));
  check('chat: edited answer replaces later messages', /Edited answer/.test(await p.evaluate(() => document.querySelector('.sa-chat')?.innerText || '')) && !/Exams are in week 8/.test(await p.evaluate(() => document.querySelector('.sa-chat')?.innerText || '')));
  // Edit cancel.
  await p.click('.sa-chat-msg[data-turn="0"] button[aria-label="Edit and resend"]');
  await p.click('.sa-chat-msg[data-editing="true"] button:has-text("Cancel")');
  check('chat: Cancel closes the editor without a call', !(await p.$('.sa-edit-input')) && (await acts(p, 'edit')).length === 1);
  // Edit error keeps the editor open.
  await p.click('.sa-chat-msg[data-turn="0"] button[aria-label="Edit and resend"]');
  await sa(p, () => window.__sa.failNext.set('edit', 'engine busy'));
  await p.fill('.sa-edit-input', 'Again');
  await p.click('button:has-text("Save and resend")');
  await sleep(350);
  check('chat: edit error shows a toast and keeps the editor', /engine busy/.test(await toastText(p)) && !!(await p.$('.sa-edit-input')));
  await p.click('.sa-chat-msg[data-editing="true"] button:has-text("Cancel")');
  // Continue.
  await p.click('[data-slot="subagent-continue"]');
  await sleep(300);
  check('chat: Continue sends "Continue."', (await acts(p, 'message')).some((x) => x.id === id && x.message === 'Continue.'));
  // Send with Ctrl+Enter.
  await p.fill('.sa-msg-input', 'One more thing');
  await p.focus('.sa-msg-input');
  await p.keyboard.press('Control+Enter');
  await sleep(300);
  check('chat: Ctrl+Enter sends the message', (await acts(p, 'message')).some((x) => x.id === id && x.message === 'One more thing'));
  check('chat: composer clears after send', (await p.inputValue('.sa-msg-input')) === '');
  // Try again (finished) -> retry.
  await p.click('.sa-detail-actions button:has-text("Try again")');
  await sleep(350);
  check('chat: Try again calls retry', (await acts(p, 'retry')).some((x) => x.id === id));
  // Now it's running: steer, stop; edit/regenerate disabled.
  await sleep(300);
  const run = await p.evaluate(() => ({ ph: document.querySelector('.sa-msg-input')?.placeholder, send: document.querySelector('[data-slot="subagent-send"]')?.textContent, edit: document.querySelector('.sa-chat button[aria-label="Edit and resend"]')?.disabled, regen: document.querySelector('.sa-chat button[aria-label="Regenerate"]')?.disabled, cont: document.querySelector('[data-slot="subagent-continue"]')?.hidden, tryAgain: [...document.querySelectorAll('.sa-detail-actions button')].find((b) => /Try again/.test(b.textContent))?.disabled }));
  check('chat (running): composer says Steer', /Steer/.test(run.ph || '') && /Steer/.test(run.send || ''), JSON.stringify(run));
  check('chat (running): edit and regenerate disabled, Continue hidden, Try again disabled', run.edit === true && run.regen !== false && run.cont === true && run.tryAgain === true, JSON.stringify(run));
  await p.fill('.sa-msg-input', 'Focus on labs');
  await p.click('[data-slot="subagent-send"]');
  await sleep(300);
  check('chat (running): steer sends a message', (await acts(p, 'message')).some((x) => x.message === 'Focus on labs'));
  await p.click('.sa-composer-actions button:has-text("Stop")');
  await sleep(350);
  check('chat (running): Stop sends stop', (await acts(p, 'stop')).some((x) => x.id === id));
  // Draft survives a repaint (live event).
  await p.fill('.sa-msg-input', 'draft text');
  await sa(p, (i) => window.__sa.progress(i, { steps: 9 }, 'step'), id);
  await sleep(300);
  check('chat: draft survives a live repaint', (await p.inputValue('.sa-msg-input')) === 'draft text');
  // NativeKit error on message keeps the draft.
  await sa(p, () => window.__sa.failNext.set('message', 'not delivered'));
  await p.click('[data-slot="subagent-send"]');
  await sleep(300);
  check('chat: send error keeps the draft', (await p.inputValue('.sa-msg-input')) === 'draft text' && /not delivered/.test(await toastText(p)));
  // Chat deleted state.
  const did = await sa(p, () => { const s = window.__sa.make({ name: 'wiped', task: 't', status: 'finished' }); s.chatDeleted = true; window.__sa.transcripts.set(s.id, []); return s.id; });
  await p.click('.sa-toolbar button[aria-label="Refresh"]').catch(() => {});
  await openDetail(p, did);
  check('chat: deleted chat explains Continue starts empty', /chat was deleted/.test(await p.evaluate(() => document.querySelector('[data-slot="subagent-chat-deleted"]')?.textContent || '')));
  check('chat: no console errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testPartial(browser) {
  const { p, ctx, errs } = await open(browser);
  const id = await seedRich(p);
  await openDetail(p, id);
  check('pick: use bar hidden until picking or selecting', !(await p.isVisible('[data-slot="use-main"]')));
  // Nothing picked -> error, no quote.
  await p.click('[data-slot="subagent-pick"]');
  await sleep(150);
  await p.click('[data-slot="use-main"]');
  await sleep(150);
  check('pick: nothing picked shows an error and adds nothing', /Pick blocks or select text first/.test(await toastText(p)) && (await composerText(p)) === '');
  await sleep(100);
  const n = await p.locator('.sa-block-check').count();
  check('pick: checkboxes on every reply block', n >= 6, String(n));
  const labels = await p.evaluate(() => [...document.querySelectorAll('.sa-block-check')].every((c) => /Use block \d+ of message \d+/.test(c.getAttribute('aria-label') || '')));
  check('pick: each checkbox has an aria-label', labels);
  // Pick the heading and the code block of the long reply.
  const keys = await p.evaluate(() => { const blocks = [...document.querySelectorAll('.sa-block')]; const h = blocks.find((b) => b.querySelector('h2')); const c = blocks.find((b) => b.querySelector('pre')); return [h, c].map((b) => b && b.querySelector('.sa-block-check').getAttribute('aria-label')); });
  for (const k of keys) await p.check(`.sa-block-check[aria-label="${k}"]`);
  await sleep(100);
  check('pick: counter shows 2 blocks picked', /2 blocks picked/.test(await p.evaluate(() => document.querySelector('[data-slot="use-count"]')?.textContent || '')));
  if (process.env.SHOT !== '0') { await p.locator('.sa-use-bar').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/s1-pick-parts-390.png` }); }
  await p.click('.sa-use-bar button:has-text("Copy")');
  await sleep(150);
  const cp = await p.evaluate(() => window.__copied.at(-1) || '');
  check('pick: Copy copies the picked blocks as Markdown', /^## Units/.test(cp) && /```python\nprint\("hi"\)\n```/.test(cp) && !/Unit one/.test(cp), cp);
  await p.click('[data-slot="use-main"]');
  await sleep(200);
  let ct = await composerText(p);
  check('pick: To main chat quotes only the picked parts', /> From sub-agent researcher:/.test(ct) && /> ## Units/.test(ct) && /print\("hi"\)/.test(ct) && !/Last paragraph/.test(ct), ct);
  // Text selection path.
  await p.evaluate(() => { const ta = document.querySelector('.aui-composer-input'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await openDetail(p, id);
  if (await p.$('.sa-block-check')) { await p.click('[data-slot="subagent-pick"]'); await sleep(150); }
  await p.evaluate(() => { const el = [...document.querySelectorAll('.sa-chat p')].find((x) => /Last paragraph here/.test(x.textContent)); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await sleep(150);
  check('pick: a text selection shows the use bar', await p.isVisible('[data-slot="use-main"]'));
  await p.evaluate(() => document.querySelector('[data-slot="use-main"]').click());
  await sleep(200);
  ct = await composerText(p);
  check('pick: selected text goes to the main chat', /Last paragraph here\./.test(ct) && !/Units/.test(ct), ct);
  // Nested sub-agent: send the part to its parent sub-agent.
  const parentId = await sa(p, () => window.__sa.make({ name: 'lead', task: 'lead', status: 'running' }).id);
  const parentKey = await sa(p, (i) => window.__sa.subs.get(i).sessionKey, parentId);
  const childId = await seedRich(p, { name: 'helper', depth: 2, parentSessionKey: parentKey });
  await p.evaluate(() => window.__subagents.refresh());
  await openDetail(p, childId);
  const toParent = await p.$('[data-slot="use-parent"]');
  check('pick (nested): To parent button names the parent', !!toParent && /To lead/.test(await toParent.textContent()));
  await p.click('[data-slot="subagent-pick"]');
  await sleep(150);
  await p.check('.sa-block-check >> nth=-1');
  await p.click('[data-slot="use-parent"]');
  await sleep(300);
  const pm = (await acts(p, 'message')).filter((x) => x.id === parentId);
  check('pick (nested): sends the part to the parent sub-agent', pm.length === 1 && /^From sub-agent helper:/.test(pm[0].message) && /Exams are in week 8/.test(pm[0].message), JSON.stringify(pm));
  check('pick: no console errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testReuse(browser) {
  const { p, ctx, errs } = await open(browser);
  const id = await seedRich(p);
  await openDetail(p, id);
  // Attach result.
  await p.click('[data-slot="subagent-attach"]');
  await sleep(150);
  check('reuse: Attach result quotes the report in the main composer', /Final report: 3 units\./.test(await composerText(p)));
  // Save as preset (and update on a second save).
  await p.click('.sa-detail-actions button:has-text("Save as preset")');
  await sleep(100);
  await p.click('.sa-detail-actions button:has-text("Save as preset")');
  await sleep(100);
  const presets = await p.evaluate(() => JSON.parse(localStorage.getItem('agent.subagents.presets.v1') || '[]'));
  check('reuse: Save as preset stores one preset with its tools', presets.length === 1 && presets[0].name === 'researcher' && presets[0].tools.includes('web_fetch'), JSON.stringify(presets));
  check('reuse: preset holds no secrets', !/sk-|token=|password/i.test(JSON.stringify(presets)));
  // Run again: as a copy (default) with an edited task.
  await p.click('[data-slot="subagent-rerun"]');
  await p.waitForSelector('#sa-as-copy');
  check('reuse: Run again sheet starts with the task', (await p.inputValue('.dialog textarea >> nth=-1')) === 'Summarise CSE 201');
  await p.fill('.dialog textarea >> nth=-1', 'Summarise CSE 202');
  await p.click('.dialog button:has-text("Run") >> nth=-1');
  await sleep(450);
  let f = await acts(p, 'fork');
  check('reuse: as a copy sends fork with the edited task', f.length === 1 && f[0].id === id && f[0].task === 'Summarise CSE 202' && f[0].keepHistory === false, JSON.stringify(f));
  check('reuse: the copy opens', /researcher-copy/.test(await p.evaluate(() => document.querySelector('.sa-detail-name')?.textContent || '')));
  // In place, same task, clean start -> retry.
  await openDetail(p, id);
  await p.click('[data-slot="subagent-rerun"]');
  await p.waitForSelector('#sa-as-copy');
  await p.uncheck('#sa-as-copy');
  await p.click('.dialog button:has-text("Run") >> nth=-1');
  await sleep(400);
  check('reuse: in place with the same task retries', (await acts(p, 'retry')).some((x) => x.id === id));
  // In place, keep its chat -> continue with the task as a message.
  await sa(p, (i) => window.__sa.finish(i, 'done again'), id);
  await sleep(200);
  await openDetail(p, id);
  await p.click('[data-slot="subagent-rerun"]');
  await p.waitForSelector('#sa-as-copy');
  await p.uncheck('#sa-as-copy');
  await p.check('#sa-keep-history');
  await p.fill('.dialog textarea >> nth=-1', 'Now the labs');
  await p.click('.dialog button:has-text("Run") >> nth=-1');
  await sleep(400);
  check('reuse: in place keeping its chat continues with a message', (await acts(p, 'message')).some((x) => x.id === id && x.message === 'Now the labs'));
  // Empty task blocked.
  await openDetail(p, id);
  await p.click('[data-slot="subagent-rerun"]');
  await p.waitForSelector('#sa-as-copy');
  await p.fill('.dialog textarea >> nth=-1', ' ');
  const before = (await acts(p, 'fork')).length;
  await p.click('.dialog button:has-text("Run") >> nth=-1');
  await sleep(200);
  check('reuse: empty task blocked', (await acts(p, 'fork')).length === before && (await p.getAttribute('.dialog textarea >> nth=-1', 'aria-invalid')) === 'true');
  // Fork error: toast, sheet stays.
  await sa(p, () => window.__sa.failNext.set('fork', 'limit reached'));
  await p.fill('.dialog textarea >> nth=-1', 'x');
  await p.click('.dialog button:has-text("Run") >> nth=-1');
  await sleep(350);
  check('reuse: fork error shows a toast and keeps the sheet', /limit reached/.test(await toastText(p)) && !!(await p.$('#sa-as-copy')));
  await closeDialogs(p);
  check('reuse: no console errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testDelete(browser) {
  const { p, ctx, errs } = await open(browser);
  const id = await seedRich(p, { name: 'old' });
  await sa(p, (i) => window.__sa.memory.set('old', [{ key: 'k', text: 'v', updatedAt: 1 }]), id);
  await openDetail(p, id);
  await p.click('[data-slot="subagent-delete-data"]');
  await p.waitForSelector('[data-slot="delete-sheet"]');
  check('delete: Delete starts disabled', await p.evaluate(() => document.querySelector('[data-slot="delete-confirm"]').disabled));
  check('delete: no dry run before a choice', !(await acts(p, 'deleteData')).length);
  for (const part of ['chat', 'memory', 'files', 'logs']) {
    await p.check(`[data-slot="delete-sheet"] input[data-part="${part}"]`);
    await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])', { timeout: 3000 }).catch(() => {});
    const d = (await acts(p, 'deleteData')).at(-1);
    check(`delete: ticking ${part} asks for a dry-run plan`, d && d.dryRun === true && d.parts.includes(part) && d.ids?.[0] === id, JSON.stringify(d));
  }
  const plan = await p.evaluate(() => { const b = document.querySelector('[data-slot="delete-plan"]'); return { text: b?.innerText || '', html: !!b?.querySelector('b') }; });
  check('delete: plan lists each part', /Chat: 6 messages/.test(plan.text) && /Memory/.test(plan.text) && /Files it created/.test(plan.text) && /Logs/.test(plan.text), plan.text);
  check('delete: file names in the plan are text, not HTML', !plan.html && /<b>x<\/b>/.test(plan.text), JSON.stringify(plan));
  if (process.env.SHOT !== '0') await p.screenshot({ path: `${SHOTS}/s1-delete-data-390.png` });
  await p.uncheck('[data-slot="delete-sheet"] input[data-part="files"]');
  await p.uncheck('[data-slot="delete-sheet"] input[data-part="logs"]');
  await p.uncheck('[data-slot="delete-sheet"] input[data-part="memory"]');
  await p.uncheck('[data-slot="delete-sheet"] input[data-part="chat"]');
  await sleep(150);
  check('delete: unticking all disables Delete again', await p.evaluate(() => document.querySelector('[data-slot="delete-confirm"]').disabled && /Choose what to delete/.test(document.querySelector('[data-slot="delete-plan"]').innerText)));
  // Everything disables the others.
  await p.check('[data-slot="delete-sheet"] input[data-part="all"]');
  await sleep(150);
  check('delete: Everything ticks and locks the other boxes', await p.evaluate(() => [...document.querySelectorAll('[data-slot="delete-sheet"] input:not([data-part="all"])')].every((c) => c.checked && c.disabled)));
  await p.uncheck('[data-slot="delete-sheet"] input[data-part="all"]');
  // Escape cancels: nothing deleted.
  await p.check('[data-slot="delete-sheet"] input[data-part="chat"]');
  await p.keyboard.press('Escape');
  await sleep(200);
  check('delete: Escape closes without deleting', !(await acts(p, 'deleteData')).some((x) => !x.dryRun));
  // Delete chat + memory for real.
  await p.click('[data-slot="subagent-delete-data"]');
  await p.check('[data-slot="delete-sheet"] input[data-part="chat"]');
  await p.check('[data-slot="delete-sheet"] input[data-part="memory"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  const del = p.locator('[data-slot="delete-confirm"]');
  await del.click(); await del.click({ force: true, timeout: 300 }).catch(() => {});
  await sleep(500);
  const real = (await acts(p, 'deleteData')).filter((x) => !x.dryRun);
  check('delete: one real call with the chosen parts', real.length === 1 && JSON.stringify(real[0].parts) === '["chat","memory"]', JSON.stringify(real));
  check('delete: chat gone, record kept', /chat was deleted/.test(await p.evaluate(() => document.querySelector('.sa-panel')?.innerText || '')), await p.evaluate(() => document.querySelector('.sa-panel')?.innerText.slice(0, 300)));
  // Everything for a running one: stops first.
  const rid = await sa(p, () => window.__sa.make({ name: 'live', task: 'live', status: 'running' }).id);
  await p.evaluate(() => window.__subagents.refresh());
  await openDetail(p, rid);
  await p.click('[data-slot="subagent-delete-data"]');
  await p.check('[data-slot="delete-sheet"] input[data-part="all"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  check('delete (running): plan warns it is stopped first', /stopped first/.test(await p.evaluate(() => document.querySelector('[data-slot="delete-plan"]').innerText)));
  await p.click('[data-slot="delete-confirm"]');
  await sleep(400);
  check('delete (running): toast says it stops first', /Stopping 1 first/.test(await toastText(p)));
  check('delete (running): it is stopped', (await p.evaluate((i) => window.__subagents.records.get(i)?.status, rid)) !== 'running');
  // Queued one: deleted at once, also leaves the queue.
  const qid = await sa(p, () => window.__sa.make({ name: 'queued-one', task: 'q', status: 'queued', queuePosition: 1 }).id);
  await p.evaluate(() => window.__subagents.refresh());
  await openDetail(p, qid);
  await p.click('[data-slot="subagent-delete-data"]');
  await p.check('[data-slot="delete-sheet"] input[data-part="all"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  await p.click('[data-slot="delete-confirm"]');
  await sleep(400);
  check('delete (queued): removed and back on the list', !(await p.evaluate((i) => window.__subagents.records.has(i), qid)) && !!(await p.$('.sa-list, .sa-empty')));
  // Error from the engine: toast with secrets redacted, sheet stays.
  await sa(p, () => { window.__mockDeleteFail = true; });
  await openDetail(p, id);
  await p.click('[data-slot="subagent-delete-data"]');
  await p.check('[data-slot="delete-sheet"] input[data-part="logs"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  await p.click('[data-slot="delete-confirm"]');
  await sleep(350);
  const tt = await toastText(p);
  check('delete: engine error shows a toast', /disk full/.test(tt), tt);
  check('delete: secrets in errors are redacted', !/sk-ABCDEFGHIJKLMNOPQRSTUVWX/.test(tt + await p.evaluate(() => document.body.innerText)), tt);
  check('delete: sheet stays open after an error, Delete usable', !!(await p.$('[data-slot="delete-sheet"]')) && !(await p.evaluate(() => document.querySelector('[data-slot="delete-confirm"]').disabled)));
  await sa(p, () => { window.__mockDeleteFail = false; });
  // Dry-run error shows in the plan box.
  await sa(p, () => window.__sa.failNext.set('deleteData', 'plan failed'));
  await p.check('[data-slot="delete-sheet"] input[data-part="memory"]');
  await sleep(300);
  check('delete: dry-run error shows in the sheet', /plan failed/.test(await p.evaluate(() => document.querySelector('[data-slot="delete-plan"]').innerText)));
  await closeDialogs(p);

  // Bulk.
  const ids = await sa(p, () => [1, 2, 3].map((i) => window.__sa.make({ name: `bulk-${i}`, task: 'b', status: 'finished' }).id));
  await openList(p);
  await p.click('.sa-toolbar button[aria-label="Refresh"]');
  await sleep(250);
  await p.click('[data-slot="subagent-select"]');
  await sleep(150);
  check('bulk: Select shows a checkbox per row', (await p.locator('.sa-row-check').count()) === (await p.locator('.sa-row').count()));
  check('bulk: Delete selected disabled with nothing picked', await p.evaluate(() => document.querySelector('[data-slot="bulk-delete-selected"]').disabled));
  await p.check(`.sa-row-check[aria-label="Select bulk-1"]`);
  await p.check(`.sa-row-check[aria-label="Select bulk-2"]`);
  check('bulk: counter shows 2 selected', /2 selected/.test(await p.evaluate(() => document.querySelector('.sa-bulk-bar').innerText)));
  await p.click('[data-slot="bulk-delete-selected"]');
  await p.waitForSelector('[data-slot="delete-sheet"]');
  check('bulk: sheet title counts the selection', /2 sub-agents/.test(await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop().innerText)));
  await p.check('[data-slot="delete-sheet"] input[data-part="all"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  await p.click('[data-slot="delete-confirm"]');
  await sleep(400);
  const bd = (await acts(p, 'deleteData')).filter((x) => !x.dryRun).at(-1);
  check('bulk: deletes exactly the selected ids', bd && JSON.stringify([...bd.ids].sort()) === JSON.stringify([ids[0], ids[1]].sort()) && bd.parts[0] === 'all', JSON.stringify(bd));
  check('bulk: deleted rows leave the list', !(await p.evaluate(() => /bulk-1|bulk-2/.test(document.querySelector('.sa-list')?.innerText || ''))));
  await p.click('[data-slot="bulk-delete-finished"]');
  await p.check('[data-slot="delete-sheet"] input[data-part="logs"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  await p.click('[data-slot="delete-confirm"]');
  await sleep(350);
  check('bulk: Finished… sends scope finished', (await acts(p, 'deleteData')).filter((x) => !x.dryRun).at(-1)?.scope === 'finished');
  await p.click('[data-slot="bulk-delete-all"]');
  await p.check('[data-slot="delete-sheet"] input[data-part="chat"]');
  await p.waitForSelector('[data-slot="delete-confirm"]:not([disabled])');
  check('bulk: All… dry run has scope all', (await acts(p, 'deleteData')).at(-1)?.scope === 'all');
  await closeDialogs(p);
  check('delete: no console errors', !errs.length, errs.join(' / '));
  await ctx.close();

  // Older engine (no subagentData): whole sub-agents only; running ones refused.
  const o = await open(browser, { cfg: { s1features: ['subagentQueue'] } });
  const r1 = await sa(o.p, () => window.__sa.make({ name: 'runner', task: 'r', status: 'running' }).id);
  await openDetail(o.p, r1);
  await o.p.click('[data-slot="subagent-delete-data"]');
  await sleep(200);
  check('old engine: running one is refused with a clear note', /Stop it first/.test(await toastText(o.p)) && !(await o.p.$('[data-slot="delete-sheet"]')));
  const f1 = await seedRich(o.p, { name: 'fin' });
  await openDetail(o.p, f1);
  await o.p.click('[data-slot="subagent-delete-data"]');
  await o.p.waitForSelector('.dialog >> text=Update the app');
  await o.p.click('.dialog button:has-text("Delete") >> nth=-1');
  await sleep(400);
  check('old engine: falls back to deleting the whole sub-agent', (await acts(o.p, 'delete')).some((x) => x.id === f1) && !(await acts(o.p, 'deleteData')).length);
  check('old engine: no console errors', !o.errs.length, o.errs.join(' / '));
  await o.ctx.close();
}

async function testCrossSession(browser) {
  const { p, ctx, errs } = await open(browser);
  // Approval for ask_session.
  await sa(p, () => window.__mock.emit('approval_request', { toolCallId: 'as-1', toolName: 'ask_session', args: { session_key: 'chat-other', message: 'What did we decide about the exam?' } }));
  await sleep(300);
  const ap = await p.evaluate(() => { const c = [...document.querySelectorAll('[data-slot="approval-card"]')].pop(); return c ? { text: c.innerText, always: c.querySelector('[data-slot="approval-card-always-allow"]')?.textContent } : null; });
  check('cross: approval card is titled Message another chat', /Message another chat/.test(ap?.text || ''), ap?.text);
  check('cross: approval names the chat and shows the message', /chat-other/.test(ap?.text || '') && /What did we decide about the exam\?/.test(ap?.text || ''), ap?.text);
  check('cross: always-allow is for this chat only', /Always allow “chat-other”/.test(ap?.always || ''), ap?.always);
  if (process.env.SHOT !== '0') { await p.locator('[data-slot="approval-card"]').last().scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/s1-cross-session-approval-390.png` }); }
  await p.click('[data-slot="approval-card"] [data-slot="approval-card-always-allow"] >> nth=-1');
  await sleep(400);
  const rules = await calls(p, 'agent.setToolRules');
  check('cross: always-allow adds the chat to ask_session allow list (bridge signature)', rules.length === 1 && rules[0][0] === 'ask_session' && JSON.stringify(rules[0][1].allow) === '["chat-other"]', JSON.stringify(rules));
  const resp = [...(await calls(p, 'agent.respondToApproval')), ...(await calls(p, 'agent.respondToApprovalWithArgs'))];
  check('cross: always-allow also approves this request', resp.some((r) => r[0] === 'as-1' && r[1] === true), JSON.stringify(resp));
  // Existing rules are kept when adding.
  await sa(p, () => { window.__rules.ask_session = { allow: ['chat-a'], deny: ['chat-x'] }; });
  await sa(p, () => window.__mock.emit('approval_request', { toolCallId: 'as-2', toolName: 'ask_session', args: { session_key: 'chat-b', message: 'hi' } }));
  await sleep(250);
  await p.click('[data-slot="approval-card"] [data-slot="approval-card-always-allow"] >> nth=-1');
  await sleep(400);
  const r2 = (await calls(p, 'agent.setToolRules')).at(-1);
  check('cross: always-allow keeps existing allow and deny entries', JSON.stringify(r2?.[1]) === JSON.stringify({ allow: ['chat-a', 'chat-b'], deny: ['chat-x'] }), JSON.stringify(r2));
  // Deny.
  await sa(p, () => window.__mock.emit('approval_request', { toolCallId: 'as-3', toolName: 'ask_session', args: { session_key: 'chat-other', message: 'and this?' } }));
  await sleep(250);
  await p.click('[data-slot="approval-card"] [data-slot="approval-card-deny"] >> nth=-1');
  await sleep(300);
  const resp2 = [...(await calls(p, 'agent.respondToApproval')), ...(await calls(p, 'agent.respondToApprovalWithArgs'))];
  check('cross: Deny sends a denial', resp2.some((r) => r[0] === 'as-3' && r[1] === false), JSON.stringify(resp2));
  check('cross: Deny adds no rule', (await calls(p, 'agent.setToolRules')).length === 2);
  // Asked-session label on a tool approval raised while answering another chat.
  await sa(p, () => window.__mock.emit('approval_request', { toolCallId: 'as-4', toolName: 'read_file', args: { path: 'a.md' }, askedSession: { sessionKey: 'chat-other', title: 'Physics notes' } }));
  await sleep(250);
  check('cross: approval raised for another chat says so', /Asked while answering for chat Physics notes/.test(await p.evaluate(() => [...document.querySelectorAll('[data-slot="approval-card-asked-session"]')].pop()?.textContent || '')));
  // Result card.
  await sa(p, () => { window.__mock.emit('tool_use', { toolCallId: 'r1', toolName: 'ask_session', args: { session_key: 'chat-other', message: 'Exam date?' } }); });
  await sleep(200);
  check('cross: result card shows waiting while it runs', /Waiting for “chat-other” to answer/.test(await p.evaluate(() => document.querySelector('.aui-thread-viewport')?.innerText || '')));
  await sa(p, () => window.__mock.emit('tool_result', { toolCallId: 'r1', toolName: 'ask_session', result: '**Exam** is on 2 Dec', isError: false }));
  await sleep(300);
  const rc = await p.evaluate(() => { const t = document.querySelector('.aui-thread-viewport')?.innerText || ''; return { t, strong: [...document.querySelectorAll('.cs-reply strong')].some((s) => s.textContent === 'Exam') }; });
  check('cross: result card shows the reply as Markdown', /Reply from “chat-other”/.test(rc.t) && rc.strong, rc.t.slice(-400));
  check('cross: result card shows the question asked', /Exam date\?/.test(rc.t));
  if (process.env.SHOT !== '0') { await p.locator('.cs-reply').last().scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/s1-cross-session-result-390.png` }); }
  await sa(p, () => { window.__mock.emit('tool_use', { toolCallId: 'r2', toolName: 'ask_session', args: { session_key: 'chat-other', message: 'Busy?' } }); window.__mock.emit('tool_result', { toolCallId: 'r2', toolName: 'ask_session', result: { output: 'The other chat is busy.', isError: true } }); });
  await sleep(300);
  check('cross: failed ask says it did not answer', /“chat-other” didn’t answer/.test(await p.evaluate(() => document.querySelector('.aui-thread-viewport')?.innerText || '')));
  // User-initiated message to another chat.
  await openList(p);
  const mbtn = await p.$('[data-slot="message-chat"]');
  check('cross: Agents screen has Message a chat', !!mbtn);
  await mbtn.click();
  await p.waitForSelector('[data-slot="cross-session-dialog"]');
  const opts = await p.evaluate(() => [...document.querySelectorAll('[data-slot="cross-session-dialog"] select option')].map((o) => o.value));
  const mainId = await p.evaluate(() => window.__app.chat.mainId);
  check('cross: dialog lists other chats, not the current one', opts.includes('chat-other') && !opts.includes(mainId), JSON.stringify(opts));
  const sendBtn = p.locator('.dialog button:has-text("Send") >> nth=-1');
  await sendBtn.click();
  check('cross: empty message blocked', !(await acts(p, 'ask')).length && (await p.getAttribute('[data-slot="cross-session-dialog"] textarea', 'aria-invalid')) === 'true');
  await p.selectOption('[data-slot="cross-session-dialog"] select', 'chat-other');
  await p.fill('[data-slot="cross-session-dialog"] textarea', 'Which chapters are in the CT?');
  await sendBtn.click(); await sendBtn.click({ force: true, timeout: 300 }).catch(() => {});
  await sleep(400);
  const ask = await acts(p, 'ask');
  check('cross: one ask with target, caller and message', ask.length === 1 && ask[0].targetSessionKey === 'chat-other' && ask[0].callerSessionKey === mainId && ask[0].message === 'Which chapters are in the CT?', JSON.stringify(ask));
  const dlg = await p.evaluate(() => document.querySelector('[data-slot="cross-session-dialog"]')?.innerText || '');
  check('cross: only the reply comes back', /Reply from “chat-other”/.test(dlg) && /Answer/.test(dlg) && /42/.test(dlg), dlg);
  const all = await calls(p);
  check('cross: never fetches the other chat\'s history', !all.some((c) => ['get', 'history', 'transcript'].includes(c.action) && (c.sessionKey === 'chat-other' || c.id === 'chat-other')) && !(await calls(p, 'agent.getHistory')).some((c) => JSON.stringify(c).includes('chat-other')) && !(await calls(p, 'agent.resumeSession')).some((c) => JSON.stringify(c).includes('chat-other')));
  await p.click('[data-slot="cross-session-dialog"] button:has-text("Add to my message")');
  await sleep(200);
  check('cross: Add to my message quotes the reply', /42/.test(await composerText(p)));
  // Failure: the other chat is busy.
  await sa(p, () => { window.__mockAskFail = true; });
  await p.evaluate(() => window.__crossSession.openMessageDialog());
  await p.waitForSelector('[data-slot="cross-session-dialog"]');
  await p.fill('[data-slot="cross-session-dialog"] textarea', 'hello');
  await p.click('.dialog button:has-text("Send") >> nth=-1');
  await sleep(300);
  check('cross: a failed ask shows an alert and re-enables Send', /busy/.test(await p.evaluate(() => document.querySelector('[data-slot="cross-session-dialog"] [role="alert"]')?.textContent || '')) && !(await p.evaluate(() => [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === 'Send')?.disabled)));
  await closeDialogs(p);
  check('cross: no console errors', !errs.length, errs.join(' / '));
  await ctx.close();

  {
  const n = await open(browser);
  // Audit note in the chat that was asked.
  await n.p.locator('.aui-composer-input').first().fill('[Message from your other chat "Main" (sent by the assistant with the user\'s permission). Reply to it.] What is the exam date?');
  await n.p.locator('.aui-composer-input').first().press('Enter');
  await sleep(500);
  const note = await n.p.evaluate(() => { const n = [...document.querySelectorAll('[data-slot="cross-session-note"]')].pop(); return n ? { t: n.textContent, body: n.parentElement.querySelector('.cs-note-body')?.textContent } : null; });
  check('cross: audit note names the asking chat and who sent it', /Asked from your chat “Main” by its assistant/.test(note?.t || ''), JSON.stringify(note));
  check('cross: audit note keeps the question body, hides the bracket', note?.body === 'What is the exam date?', JSON.stringify(note));
  check('cross note: no console errors', !n.errs.length, n.errs.join(' / '));
  await n.ctx.close();
  }
  // No crossSession feature: no Message button; the dialog refuses politely; card still renders.
  const o = await open(browser, { cfg: { s1features: ['subagentQueue', 'subagentData'] } });
  await openList(o.p);
  check('no cross feature: no Message a chat button', !(await o.p.$('[data-slot="message-chat"]')));
  await closeDialogs(o.p);
  await o.p.evaluate(() => window.__crossSession.openMessageDialog());
  await sleep(200);
  check('no cross feature: dialog refuses with an update note', /Update the app to message another chat/.test(await toastText(o.p)) && !(await acts(o.p, 'chats')).length);
  // Old bridge without tool rules: always-allow still approves, no crash.
  await o.p.evaluate(() => { delete window.NativeKit.agent.listToolRules; delete window.NativeKit.agent.setToolRules; });
  await o.p.evaluate(() => window.__mock.emit('approval_request', { toolCallId: 'z1', toolName: 'ask_session', args: { session_key: 'chat-other', message: 'x' } }));
  await sleep(250);
  await o.p.click('[data-slot="approval-card"] [data-slot="approval-card-always-allow"] >> nth=-1');
  await sleep(300);
  const rz = [...(await calls(o.p, 'agent.respondToApproval')), ...(await calls(o.p, 'agent.respondToApprovalWithArgs'))];
  check('no tool rules: always-allow still approves this request', rz.some((r) => r[0] === 'z1' && r[1] === true), JSON.stringify(rz));
  check('no cross feature: no console errors', !o.errs.length, o.errs.join(' / '));
  await o.ctx.close();
}

async function testEvents(browser) {
  const { p, ctx, errs } = await open(browser);
  const id = await seedRich(p, { status: 'running', name: 'evt' });
  await openDetail(p, id);
  // Out of order: finished, then a late step; status must stay finished.
  await sa(p, (i) => { window.__sa.finish(i, 'all done'); const s = window.__sa.subs.get(i); window.__sa.emit('subagent.step', { ...s, status: 'running', steps: 1, preview: 'late' }); }, id);
  await sleep(500);
  check('events: late step after finish keeps Finished', (await p.evaluate((i) => window.__subagents.records.get(i)?.status, id)) === 'finished');
  check('events: detail refetches the chat when the run ends', /all done/.test(await p.evaluate(() => document.querySelector('.sa-panel')?.innerText || '')));
  // Unknown event kinds and junk payloads are ignored.
  await sa(p, () => { window.__sa.emit('subagent.deleted', { id: 'nope' }); window.__sa.emit('subagent.weird', { id: 'sa_x', status: 'zzz' }); window.__mock.emit('subagent.step', null); });
  await sleep(300);
  check('events: junk events do not crash', !errs.some((e) => /pageerror/.test(e)), errs.join(' / '));
  // Rapid taps on Regenerate: one call (slow engine).
  await sa(p, () => { window.__sa.delay = 200; });
  const rg = p.locator('.sa-chat button[aria-label="Regenerate"]');
  await rg.click(); await rg.click({ force: true, timeout: 300 }).catch(() => {}); await rg.click({ force: true, timeout: 300 }).catch(() => {});
  await sleep(900);
  await sa(p, () => { window.__sa.delay = 0; });
  const n = (await acts(p, 'regenerate')).length;
  check('events: rapid Regenerate taps make at most one call', n === 1, String(n));
  // Keyboard: every button in the detail has an accessible name; Tab reaches the composer.
  const unnamed = await p.evaluate(() => [...document.querySelectorAll('.sa-dialog button, .sa-dialog input, .sa-dialog select, .sa-dialog textarea')].filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim() || b.labels?.length || b.getAttribute('title'))).map((b) => b.outerHTML.slice(0, 80)));
  check('a11y: every control in the detail has a name', !unnamed.length, JSON.stringify(unnamed.slice(0, 3)));
  await p.focus('.sa-msg-input');
  await p.keyboard.press('Shift+Tab');
  check('a11y: keyboard focus moves within the dialog', await p.evaluate(() => !!document.activeElement?.closest('.dialog')));
  check('events: no console errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testLayout(browser) {
  const sizes = [[320, 640, true], [360, 740, true], [390, 844, true], [1280, 800, false]];
  for (const [w, hgt, mobile] of sizes) for (const dark of [false, true]) {
    const tag = `${w}${dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, { w, hgt, mobile, dark });
    const id = await seedRich(p, { name: `long-name-${'x'.repeat(50)}` });
    await sa(p, (i) => { const t = window.__sa.transcripts.get(i); t.push({ role: 'user', content: 'W'.repeat(3000) }, { role: 'assistant', content: [{ type: 'text', text: '```js\n' + 'const a = 1;'.repeat(80) + '\n```\n\n| ' + 'col | '.repeat(14) + '\n|' + '---|'.repeat(14) + '\n| ' + 'value | '.repeat(14) + '\n\n' + 'https://example.com/' + 'a'.repeat(300) }] }); window.__sa.subs.get(i).files = [{ path: 'very/long/' + 'p'.repeat(200) + '.md', created: true }]; }, id);
    await p.evaluate(() => window.__subagents.refresh());
    await openDetail(p, id);
    let o = await overflow(p);
    check(`[${tag}] chat view: no page sideways scroll`, o.ok, JSON.stringify(o));
    await p.click('[data-slot="subagent-pick"]');
    await sleep(200);
    o = await overflow(p);
    check(`[${tag}] pick mode: no page sideways scroll`, o.ok, JSON.stringify(o));
    await p.click('[data-slot="subagent-delete-data"]');
    await p.check('[data-slot="delete-sheet"] input[data-part="all"]');
    await sleep(300);
    o = await overflow(p);
    check(`[${tag}] delete sheet: no page sideways scroll`, o.ok, JSON.stringify(o));
    await p.keyboard.press('Escape');
    await sleep(150);
    const qid = await sa(p, () => window.__sa.make({ name: 'q-' + 'y'.repeat(60), task: 'T'.repeat(500), status: 'queued', queuePosition: 12, priority: 10 }).id);
    await p.evaluate(() => window.__subagents.refresh());
    await openDetail(p, qid);
    o = await overflow(p);
    check(`[${tag}] queue box: no page sideways scroll`, o.ok, JSON.stringify(o));
    await p.click('.sa-back');
    await sleep(200);
    await p.click('[data-slot="subagent-select"]');
    await sleep(150);
    o = await overflow(p);
    check(`[${tag}] bulk bar: no page sideways scroll`, o.ok, JSON.stringify(o));
    await p.click('[data-slot="message-chat"]');
    await p.waitForSelector('[data-slot="cross-session-dialog"]');
    o = await overflow(p);
    check(`[${tag}] message dialog: no page sideways scroll`, o.ok, JSON.stringify(o));
    await closeDialogs(p);
    await sa(p, () => { window.__mock.emit('approval_request', { toolCallId: 'L1', toolName: 'ask_session', args: { session_key: 'chat-' + 'z'.repeat(80), message: 'M'.repeat(2000) } }); window.__mock.emit('tool_use', { toolCallId: 'L2', toolName: 'ask_session', args: { session_key: 'chat-other', message: 'Q' } }); window.__mock.emit('tool_result', { toolCallId: 'L2', toolName: 'ask_session', result: '| a | b |\n|---|---|\n| ' + 'x'.repeat(400) + ' | y |' }); });
    await sleep(350);
    o = await overflow(p);
    check(`[${tag}] cross-session cards: no page sideways scroll`, o.ok, JSON.stringify(o));
    check(`[${tag}] no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testQueue, testChatView, testPartial, testReuse, testDelete, testCrossSession, testEvents, testLayout };
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split("\n").slice(0, 14).join(" <- ")); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\ns1: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
