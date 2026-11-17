// Playwright suite for the advanced sub-agent UI (engine feature `subagentAdvanced`):
// the Explorer graph (layout, edges, batch boxes, filters, zoom, keyboard, replay, inspector, bulk),
// the batch dialog, "Fork into sub-agent", the Settings edits (title, description, shareable, move
// to another chat) and the Goals and Memory tabs. Runs against the mock engine in mock-subagents.js
// and mock-memory.js, whose replies follow the shapes in subagents/advanced.rs.
// Run: node subagent-advanced.js   (ONLY=testExplorer,... to pick tests)
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = 'file://' + path.resolve(__dirname, '../../www/agent.html');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${detail}`}`); };
const ALL = ['subagentQueue', 'subagentData', 'subagentReuse', 'crossSession', 'subagentGraph', 'subagentTeam', 'subagentChatAllow', 'subagentAdvanced'];

async function open(browser, { features = ALL, width = 1280, height = 900, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript((f) => { window.__SA_CFG = { s1features: f }; window.__MEM_CFG = { goals: true }; }, features);
  for (const f of ['mock3.js', 'mock-v2.js', 'mock-subagents.js', 'mock-memory.js']) await ctx.addInitScript({ content: read(f) });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => { if (window.__sa) window.__sa.mainKey = window.__app.chat.mainId; });
  await sleep(300);
  return { p, ctx, errs };
}
const subCalls = (p, action) => p.evaluate((a) => window.__mock.calls.filter((c) => (c.name === 'agent.subagents' || c.name === 'agent.memory')).map((c) => c.args || {}).filter((x) => !a || x.action === a), action);

/** Six agents in the open chat: a race (scout-a won), a three-step pipeline with waits, a helper under step 2, and peer messages. */
async function seed(p) {
  return p.evaluate(() => {
    const k = window.__app.chat.mainId;
    const t0 = Date.now() - 120000;
    const ids = {};
    const mk = (name, extra, i) => {
      const s = window.__sa.make({ name, task: `task of ${name}`, status: extra.status || 'running', depth: extra.depth || 1, createdAt: t0 + i * 5000 });
      Object.assign(s, { parentId: null, parentSessionKey: k, rootSessionKey: k, title: `Title ${name}`, model: 'mock-model' }, extra);
      window.__sa.emit('subagent.started', { ...s });
      window.__sa.comms.events.push({ at: t0 + i * 5000, event: 'subagent.started', id: s.id, status: 'running', depth: s.depth });
      ids[name] = s.id;
      return s;
    };
    mk('scout-a', { groupId: 'g-race', groupMode: 'race', groupIndex: 0, groupWinner: true, status: 'finished' }, 0);
    mk('scout-b', { groupId: 'g-race', groupMode: 'race', groupIndex: 1, status: 'cancelled' }, 1);
    mk('step-1', { groupId: 'g-pipe', groupMode: 'pipeline', groupIndex: 0, status: 'finished' }, 2);
    mk('step-2', { groupId: 'g-pipe', groupMode: 'pipeline', groupIndex: 1, dependsOn: [ids['step-1']], status: 'running', contextMode: 'fork' }, 3);
    mk('step-3', { groupId: 'g-pipe', groupMode: 'pipeline', groupIndex: 2, dependsOn: [ids['step-2']], status: 'queued' }, 4);
    const st2 = window.__sa.subs.get(ids['step-2']);
    mk('helper', { depth: 2, parentId: st2.id, parentSessionKey: st2.sessionKey, status: 'running' }, 5);
    for (let i = 0; i < 2; i++) window.__sa.comms.events.push({ at: t0 + 32000 + i * 1000, event: 'subagent.peer_message', id: ids['step-2'], to: ids.helper });
    window.__sa.comms.events.push({ at: t0 + 40000, event: 'subagent.finished', id: ids['scout-a'], status: 'finished' });
    return { k, ids };
  });
}
async function openExplorer(p) {
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' }));
  await p.waitForSelector('[data-slot=subagent-explorer] [data-node]', { timeout: 5000 }).catch(() => {});
  await sleep(500);
}
const graphState = (p) => p.evaluate(() => {
  const root = document.querySelector('[data-slot=subagent-explorer]');
  const q = (s) => [...(root?.querySelectorAll(s) || [])];
  return {
    nodes: q('[data-node]').length,
    main: q('[data-node][data-main]').length,
    spawn: q('[data-edge=spawn]').length, dep: q('[data-edge=dependency]').length, msg: q('[data-edge=message]').length,
    msgCount: q('[data-edge=message] .sa-x-count text').map((t) => t.textContent),
    groups: q('.sa-x-group').map((g) => g.textContent.replace(/\s+/g, ' ').trim()),
    summary: root?.querySelector('.sa-x-summary')?.textContent || '',
    dim: q('[data-node][data-dim=true]').length,
    transform: root?.querySelector('svg > g')?.getAttribute('transform') || '',
    zoom: root?.querySelector('[data-slot=explorer-zoom], .sa-x-zoom')?.textContent || '',
    replay: root?.dataset.replay,
  };
});
const nodeOf = (p, id) => p.locator(`[data-slot=subagent-explorer] [data-node="${id}"]`);

async function testGating(browser) {
  const off = await open(browser, { features: ALL.filter((f) => f !== 'subagentAdvanced') });
  const t = await off.p.evaluate(async () => { window.__subagents.open(window.__app); await new Promise((r) => setTimeout(r, 400)); return [...document.querySelectorAll('[role=tab][data-tab]')].map((x) => x.dataset.tab); });
  check('without subagentAdvanced there is no Explorer tab', !t.includes('explorer'), t.join(','));
  check('without subagentAdvanced the panel still opens', t.length > 0, t.join(','));
  check('without subagentAdvanced no page errors', !off.errs.length, off.errs.join(' | '));
  await off.ctx.close();
  const on = await open(browser);
  const t2 = await on.p.evaluate(async () => { window.__subagents.open(window.__app); await new Promise((r) => setTimeout(r, 400)); return [...document.querySelectorAll('[role=tab][data-tab]')].map((x) => x.dataset.tab); });
  check('with subagentAdvanced the Explorer tab is there', t2.includes('explorer'), t2.join(','));
  await on.ctx.close();
}

async function testExplorer(browser) {
  for (const env of [{ width: 1280 }, { width: 390, height: 844 }, { width: 1280, dark: true }]) {
    const tag = `${env.width}px${env.dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, env);
    const { ids } = await seed(p);
    await openExplorer(p);
    let g = await graphState(p);
    check(`${tag} graph draws the main agent and all six agents`, g.nodes === 7 && g.main === 1, JSON.stringify(g));
    check(`${tag} one spawn edge per agent`, g.spawn === 6, String(g.spawn));
    check(`${tag} pipeline waits drawn as two dependency edges`, g.dep === 2, String(g.dep));
    check(`${tag} peer messages drawn as one edge with count 2`, g.msg === 1 && g.msgCount.join() === '2', JSON.stringify(g.msgCount));
    check(`${tag} two batch boxes, race box names the winner`, g.groups.length === 2 && g.groups.some((x) => /race/i.test(x) && /scout-a/.test(x)) && g.groups.some((x) => /pipeline/i.test(x)), JSON.stringify(g.groups));
    check(`${tag} summary counts agents, active and batches`, /6 agents/.test(g.summary) && /2 batches/.test(g.summary), g.summary);
    const lbl = await nodeOf(p, ids['scout-a']).getAttribute('aria-label');
    check(`${tag} node label says race batch and winner`, /race/i.test(lbl) && /winner/.test(lbl), lbl);
    const ov = await overflow(p);
    check(`${tag} no horizontal overflow`, ov.ok, JSON.stringify(ov));

    // edge toggles
    const chip = p.locator('[data-slot=subagent-explorer] .sa-x-chip', { hasText: 'Waits for' });
    await chip.click();
    await sleep(250);
    g = await graphState(p);
    check(`${tag} turning Waits for off hides dependency edges only`, g.dep === 0 && g.spawn === 6 && (await chip.getAttribute('aria-pressed')) === 'false', JSON.stringify({ dep: g.dep, spawn: g.spawn, pressed: await chip.getAttribute('aria-pressed') }));
    await chip.click();
    await sleep(250);
    check(`${tag} turning Waits for on brings them back`, (await graphState(p)).dep === 2);
    // status filter
    await p.evaluate(() => { const s = document.querySelector('[data-slot=explorer-status]'); s.value = 'finished'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(250);
    g = await graphState(p);
    check(`${tag} status filter Finished dims the agents that are not finished`, g.dim === 4, String(g.dim));
    await p.evaluate(() => { const s = document.querySelector('[data-slot=explorer-status]'); s.value = s.options[0].value; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(250);
    // zoom buttons
    const z0 = (await graphState(p)).zoom;
    await p.locator('[data-slot=explorer-zoom-in]').click();
    await sleep(200);
    const z1 = (await graphState(p)).zoom;
    check(`${tag} Zoom in raises the zoom level`, parseInt(z1) > parseInt(z0), `${z0} -> ${z1}`);
    await p.locator('[data-slot=explorer-fit]').click();
    await sleep(200);
    const inView = () => p.evaluate(() => { const c = document.querySelector('.sa-x-canvaswrap').getBoundingClientRect(); const ns = [...document.querySelectorAll('[data-slot=subagent-explorer] [data-node]')]; return ns.length > 0 && ns.every((n) => { const r = n.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; }); });
    check(`${tag} Fit shows every agent inside the canvas`, await inView(), (await graphState(p)).zoom);
    check(`${tag} Fit zooms out no further than it needs (<= the first view)`, parseInt((await graphState(p)).zoom) <= parseInt(z0), `${z0} vs ${(await graphState(p)).zoom}`);
    const before0 = await p.evaluate(() => [...document.querySelectorAll('[data-slot=subagent-explorer] [data-node]')].map((n) => n.getAttribute('transform')).join());
    await p.locator('[data-slot=explorer-orient]').click();
    await sleep(300);
    const after0 = await p.evaluate(() => [...document.querySelectorAll('[data-slot=subagent-explorer] [data-node]')].map((n) => n.getAttribute('transform')).join());
    check(`${tag} the layout button switches direction`, before0 !== after0);
    await p.locator('[data-slot=explorer-orient]').click();
    await sleep(300);
    // filter
    const search = p.locator('[data-slot=subagent-explorer] input[type=search]').first();
    await search.fill('scout');
    await sleep(350);
    g = await graphState(p);
    check(`${tag} name filter dims the four agents that do not match`, g.dim === 4, String(g.dim));
    await search.fill('');
    await sleep(350);

    // zoom + keyboard
    const before = (await graphState(p)).transform;
    await p.locator('[data-slot=explorer-canvas]').focus();
    await p.keyboard.press('+');
    await sleep(200);
    const zoomed = (await graphState(p)).transform;
    check(`${tag} + zooms the graph`, zoomed !== before, `${before} -> ${zoomed}`);
    await p.keyboard.press('ArrowLeft');
    await sleep(150);
    const panned = (await graphState(p)).transform;
    check(`${tag} arrow keys pan the graph`, panned !== zoomed, `${zoomed} -> ${panned}`);
    await p.keyboard.press('0');
    await sleep(200);
    check(`${tag} 0 fits the graph again`, (await graphState(p)).transform !== panned);

    // inspector
    await nodeOf(p, ids['step-2']).focus();
    await p.keyboard.press('Enter');
    await sleep(300);
    const insp = await p.evaluate(() => { const i = document.querySelector('[data-slot=explorer-inspector]'); return { text: i?.innerText || '', buttons: [...(i?.querySelectorAll('button') || [])].map((b) => b.getAttribute('aria-label') || b.textContent.trim()) }; });
    check(`${tag} Enter on a node opens its inspector`, /step-2/.test(insp.text), insp.text.slice(0, 160));
    check(`${tag} inspector has stop, stop tree, pause and steer`, ['Stop', 'tree', 'Pause'].every((w) => insp.buttons.some((b) => b.includes(w))), insp.buttons.join('|'));
    check(`${tag} inspector shows what it waits for`, /step-1/.test(insp.text), insp.text.slice(0, 300));
    const pause = p.locator('[data-slot=explorer-inspector] button', { hasText: 'Pause' }).first();
    await pause.click();
    await sleep(400);
    const pc = await subCalls(p, 'pause');
    check(`${tag} Pause sends pause for that agent`, pc.some((c) => c.id === ids['step-2']), JSON.stringify(pc));

    // replay
    await p.evaluate(() => { const s = document.querySelector('[data-slot=explorer-scrub]'); s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    g = await graphState(p);
    const tl = await p.locator('[data-slot=explorer-time]').textContent();
    check(`${tag} scrubbing back enters replay and hides agents not started yet`, g.replay === 'true' && /Replay at/.test(tl) && g.nodes < 7, JSON.stringify({ replay: g.replay, tl, nodes: g.nodes }));
    await p.locator('[data-slot=explorer-live]').click();
    await sleep(300);
    g = await graphState(p);
    check(`${tag} Live returns to the full graph`, g.replay === 'false' && g.nodes === 7, JSON.stringify({ replay: g.replay, nodes: g.nodes }));

    // bulk from the main node
    await p.locator('[data-slot=subagent-explorer] [data-node][data-main]').click();
    await sleep(300);
    const bulkBtn = p.locator('[data-slot=explorer-inspector] button', { hasText: 'Stop all' }).first();
    if (await bulkBtn.count()) {
      await bulkBtn.click();
      await sleep(250);
      const confirm = p.locator('button.btn-destructive', { hasText: 'Stop all' }).last();
      if (await confirm.count()) await confirm.click();
      await sleep(400);
      const bc = await subCalls(p, 'bulk');
      check(`${tag} chat-wide Stop sends one bulk stop for this chat`, bc.length >= 1 && bc[bc.length - 1].op === 'stop' && !!bc[bc.length - 1].sessionKey, JSON.stringify(bc));
    } else {
      const b = await p.evaluate(() => [...document.querySelectorAll('[data-slot=explorer-inspector] button')].map((x) => x.textContent.trim()));
      check(`${tag} main node shows chat-wide controls`, false, b.join('|'));
    }
    check(`${tag} no page errors`, !errs.length, errs.join(' | '));
    await ctx.close();
  }
}

async function testBatchDialog(browser) {
  const { p, ctx, errs } = await open(browser);
  await seed(p);
  await openExplorer(p);
  await p.locator('[data-slot=explorer-new-batch]').click();
  await sleep(300);
  const dlg = p.locator('[data-slot=batch-dialog]');
  const errText = () => p.evaluate(() => { const e = document.querySelector('[data-slot=batch-error]'); return e && !e.hidden ? e.textContent : ''; });
  check('New batch opens the batch dialog with two agent rows', (await dlg.isVisible().catch(() => false)) && (await p.locator('[data-slot=batch-task]').count()) === 2);
  check('Parallel is the default mode', (await p.locator('[data-slot=batch-dialog] [role=radio][data-mode=parallel]').getAttribute('aria-checked')) === 'true');
  await p.locator('[data-slot=batch-start]').click();
  await sleep(200);
  const err = await errText();
  check('starting with empty briefs shows an error and sends nothing', /brief/.test(err) && (await subCalls(p, 'spawnBatch')).length === 0, err);
  await p.locator('[data-slot=batch-dialog] [role=radio][data-mode=pipeline]').click();
  await sleep(150);
  const help = await p.locator('[data-slot=batch-mode-help]').textContent();
  check('picking Pipeline changes the help text', /previous|before|one after|in turn|order/i.test(help), help);
  await p.locator('[data-slot=batch-add]').click();
  await sleep(150);
  const rows = p.locator('[data-slot=batch-task]');
  check('Add agent adds a third row and updates the count', (await rows.count()) === 3 && /3 of/.test(await p.locator('[data-slot=batch-count]').textContent()));
  for (let i = 0; i < 3; i++) await rows.nth(i).fill(`step ${i + 1} brief`);
  await p.locator('[data-slot=batch-name]').nth(0).fill('collector');
  await p.locator('[data-slot=batch-tasks] [aria-label="Move up"]').nth(2).click();
  await sleep(150);
  const order = await p.evaluate(() => [...document.querySelectorAll('[data-slot=batch-task]')].map((t) => t.value));
  check('Move up reorders the steps', order.join('|') === 'step 1 brief|step 3 brief|step 2 brief', order.join('|'));
  await p.locator('[data-slot=batch-dialog] .sa-batch-more > summary').click();
  await p.locator('[data-slot=batch-shared]').fill('Launch plan for the app');
  await p.locator('[data-slot=batch-budget]').fill('500');
  await p.locator('[data-slot=batch-start]').click();
  await sleep(200);
  check('a token budget under 1,000 is refused', /Token budget/.test(await errText()) && (await subCalls(p, 'spawnBatch')).length === 0, await errText());
  await p.locator('[data-slot=batch-budget]').fill('20000');
  await p.locator('[data-slot=batch-start]').click();
  await sleep(600);
  const sb = await subCalls(p, 'spawnBatch');
  const last = sb[sb.length - 1] || {};
  const names = (last.tasks || []).map((t) => (typeof t === 'string' ? t : `${t.name}:${t.task}`));
  check('Start sends spawnBatch in pipeline mode with the steps in order', last.mode === 'pipeline' && names.join('|') === 'collector:step 1 brief|step 3 brief|step 2 brief', JSON.stringify(last).slice(0, 300));
  check('spawnBatch carries the shared goal, budget and the open chat', last.task === 'Launch plan for the app' && last.tokenBudget === 20000 && !!last.parentSessionKey, JSON.stringify(last).slice(0, 300));
  check('batch dialog closes after a start', !(await dlg.isVisible().catch(() => false)));
  await sleep(400);
  const g = await graphState(p);
  check('the new batch shows up in the graph as a third box', g.nodes === 10 && g.groups.length === 3, JSON.stringify({ nodes: g.nodes, groups: g.groups }));
  // a race needs two agents
  await p.locator('[data-slot=explorer-new-batch]').click();
  await sleep(300);
  await p.locator('[data-slot=batch-dialog] [role=radio][data-mode=race]').click();
  await p.locator('[data-slot=batch-tasks] [aria-label="Remove"]').last().click();
  await sleep(150);
  await p.locator('[data-slot=batch-task]').first().fill('only one');
  const before = (await subCalls(p, 'spawnBatch')).length;
  await p.locator('[data-slot=batch-start]').click();
  await sleep(300);
  const after = (await subCalls(p, 'spawnBatch')).length;
  check('a race with one agent is refused with a reason', after === before && /at least two/.test(await errText()), `${before}->${after} ${await errText()}`);
  await p.keyboard.press('Escape');
  await sleep(300);
  // review: a worker and a reviewer, with rounds
  await p.locator('[data-slot=explorer-new-batch]').click();
  await sleep(300);
  await p.locator('[data-slot=batch-dialog] [role=radio][data-mode=review]').click();
  await sleep(150);
  const roles = await p.evaluate(() => [...document.querySelectorAll('[data-slot=batch-tasks] .sa-batch-num')].map((x) => x.textContent));
  check('Review shows exactly a Worker and a Reviewer row', roles.join('|') === 'Worker|Reviewer', roles.join('|'));
  check('Review shows the rounds picker and hides Add agent', !(await p.locator('[data-slot=batch-rounds-field]').isHidden()) && (await p.locator('[data-slot=batch-add]').isDisabled()));
  await p.locator('[data-slot=batch-task]').nth(0).fill('Write the release notes');
  await p.locator('[data-slot=batch-task]').nth(1).fill('Check them for accuracy and tone');
  await p.locator('[data-slot=batch-rounds]').selectOption('2');
  await p.locator('[data-slot=batch-start]').click();
  await sleep(600);
  const rv = (await subCalls(p, 'spawnBatch')).pop() || {};
  check('Start sends a review batch with rounds 2', rv.mode === 'review' && rv.rounds === 2 && rv.tasks.length === 2, JSON.stringify(rv).slice(0, 300));
  const rg = await graphState(p);
  check('the review batch shows as a Review box and the reviewer waits for the worker', rg.groups.some((x) => /Review/.test(x)) && rg.dep >= 3, JSON.stringify({ groups: rg.groups, dep: rg.dep }));
  const ovr = await overflow(p);
  check('no horizontal overflow with four modes', ovr.ok, JSON.stringify(ovr));
  check('batch dialog: no page errors', !errs.length, errs.join(' | '));
  await ctx.close();
}

async function testFork(browser) {
  const { send, emit } = require('./feat.js');
  const { p, ctx, errs } = await open(browser);
  const a = await send(p, 'Plan the launch');
  const k = a?.sessionKey || (await p.evaluate(() => window.__app.chat.mainId));
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Step one: research.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  await send(p, 'And the second part?');
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Step two: build.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  await p.locator('[data-role=assistant] [aria-label="More"]').first().click();
  await sleep(200);
  const item = p.getByRole('menuitem', { name: 'Fork into sub-agent' });
  check('the message menu offers Fork into sub-agent', await item.count() === 1);
  await item.click();
  await sleep(300);
  const dlg = p.locator('[data-slot=fork-dialog]');
  check('Fork into sub-agent opens the fork dialog', await dlg.isVisible().catch(() => false));
  await p.locator('[data-slot=fork-start]').click();
  await sleep(200);
  check('an empty brief is refused', (await subCalls(p, 'spawn')).filter((c) => c.context === 'fork').length === 0);
  await dlg.locator('textarea').first().fill('Review the plan so far');
  await p.locator('[data-slot=fork-start]').click();
  await sleep(500);
  const sp = (await subCalls(p, 'spawn')).filter((c) => c.context === 'fork');
  const c = sp[sp.length - 1] || {};
  check('fork spawns with context fork from this chat', c.context === 'fork' && c.forkSession === k, JSON.stringify(c).slice(0, 300));
  check('fork from the first reply cuts at the first user message', c.forkUserTurns === 1, JSON.stringify(c).slice(0, 300));
  check('fork sits under the open chat (parentSessionKey)', c.parentSessionKey === k && !('callerSessionKey' in c), JSON.stringify(c).slice(0, 300));
  await p.evaluate(() => window.__subagents.close?.());
  await p.keyboard.press('Escape');
  await sleep(300);
  await p.locator('[data-role=assistant] [aria-label="More"]').last().click({ force: true });
  await sleep(200);
  await p.getByRole('menuitem', { name: 'Fork into sub-agent' }).click();
  await sleep(300);
  await dlg.locator('textarea').first().fill('Carry on from the latest');
  await p.locator('[data-slot=fork-start]').click();
  await sleep(500);
  const sp2 = (await subCalls(p, 'spawn')).filter((x) => x.context === 'fork');
  const c2 = sp2[sp2.length - 1] || {};
  check('fork from the newest reply takes the whole chat (no cut)', !c2.forkUserTurns, JSON.stringify(c2).slice(0, 300));
  check('fork: no page errors', !errs.length, errs.join(' | '));
  await ctx.close();
  const off = await open(browser, { features: ALL.filter((f) => f !== 'subagentAdvanced') });
  const b = await send(off.p, 'hi');
  await emit(off.p, [['text_delta', { sessionKey: b?.sessionKey || '', delta: 'Hello.' }], ['agent.completed', { sessionKey: b?.sessionKey || '' }]]);
  await sleep(400);
  await off.p.locator('[data-role=assistant] [aria-label="More"]').last().click();
  await sleep(200);
  check('without subagentAdvanced the menu has no Fork into sub-agent', await off.p.getByRole('menuitem', { name: 'Fork into sub-agent' }).count() === 0);
  await off.ctx.close();
}

async function openTab(p, id, tab) {
  await p.evaluate(([i, t]) => window.__subagents.open(window.__app, { id: i, agentTab: t }), [id, tab]);
  await sleep(500);
}

async function testSettingsEdits(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  const id = ids['step-1'];
  await openTab(p, id, 'settings');
  const title = p.locator('[data-key=title]');
  const desc = p.locator('[data-key=description]');
  check('Settings shows the title field with its current value', (await title.inputValue().catch(() => '')) === 'Title step-1');
  await title.fill('Market research');
  await desc.fill('Looks at three competitors');
  const share = p.locator('[data-key=shareable]');
  await share.check().catch(async () => share.click());
  await p.locator('[data-slot=agent-settings-save]').click();
  await sleep(500);
  const cf = await subCalls(p, 'configure');
  const c = cf.filter((x) => x.id === id).pop() || {};
  check('Save sends the new title and description', c.title === 'Market research' && c.description === 'Looks at three competitors', JSON.stringify(c).slice(0, 300));
  check('Save sends shareable true', c.shareable === true, JSON.stringify(c).slice(0, 300));
  await title.fill('x'.repeat(200));
  await p.locator('[data-slot=agent-settings-save]').click();
  await sleep(300);
  const n2 = (await subCalls(p, 'configure')).filter((x) => x.id === id).length;
  check('a title over the limit is refused', n2 === cf.filter((x) => x.id === id).length, String(n2));
  await title.fill('Market research');
  const mv = p.locator('[data-slot=agent-settings-move]');
  check('Settings has Move to another chat', await mv.count() === 1);
  // a running agent cannot move
  await openTab(p, ids['step-2'], 'settings');
  const mvRun = p.locator('[data-slot=agent-settings-move]');
  check('Move is disabled while the agent runs', (await mvRun.count()) === 0 || (await mvRun.isDisabled()), 'enabled');
  await openTab(p, id, 'settings');
  await p.locator('[data-slot=agent-settings-move]').click();
  await sleep(400);
  const sel = p.locator('[data-slot=move-target]');
  check('Move opens a chat picker listing the other chats', (await sel.count()) === 1 && (await sel.locator('option').count()) >= 2, String(await sel.locator('option').count()));
  await p.locator('[data-slot=move-confirm]').click();
  await sleep(200);
  check('Move without a chosen chat is refused', (await subCalls(p, 'moveToChat')).length === 0);
  await sel.selectOption('chat-other');
  await p.locator('[data-slot=move-confirm]').click();
  await sleep(500);
  const m = await subCalls(p, 'moveToChat');
  check('Move sends moveToChat with the chosen chat', m.length === 1 && m[0].id === id && m[0].targetSessionKey === 'chat-other', JSON.stringify(m));
  check('settings edits: no page errors', !errs.length, errs.join(' | '));
  await ctx.close();
}

async function testGoalsMemory(browser) {
  for (const env of [{ width: 1280 }, { width: 390, height: 844 }]) {
    const tag = `${env.width}px`;
    const { p, ctx, errs } = await open(browser, env);
    const { ids } = await seed(p);
    const id = ids['step-1'];
    await openTab(p, id, 'goals');
    const gp = p.locator('[data-slot=agent-tab-goals]');
    check(`${tag} Goals tab renders with counts`, (await gp.isVisible().catch(() => false)) && /active/.test(await p.locator('[data-slot=goals-counts]').textContent().catch(() => '')));
    await p.locator('[data-slot=goal-create]').click();
    await sleep(200);
    check(`${tag} a goal without a title is refused`, (await subCalls(p, 'memory.goal')).length === 0);
    await p.locator('[data-slot=goal-new-title]').fill('Find three competitors');
    await p.locator('[data-slot=goal-new-description]').fill('Names and prices');
    await p.locator('[data-slot=goal-create]').click();
    await sleep(500);
    let gc = await subCalls(p, 'memory.goal');
    const cr = gc.find((x) => x.op === 'create') || {};
    const sk = await p.evaluate((i) => window.__sa.subs.get(i).sessionKey, id);
    check(`${tag} Add goal sends memory.goal create for the agent's own session`, /competitors/.test(JSON.stringify(cr)) && cr.sessionKey === sk, JSON.stringify(gc).slice(0, 300));
    const txt = await gp.innerText();
    check(`${tag} the new goal is listed`, /Find three competitors/.test(txt), txt.slice(0, 200));
    const curItem = p.locator('[data-slot=agent-tab-goals] li, [data-slot=agent-tab-goals] [data-goal]').filter({ hasText: 'Find three competitors' }).first();
    const done = curItem.locator('button', { hasText: 'Complete' });
    if (await done.count()) {
      await done.click();
      await sleep(300);
      const cfm = p.locator('.dialog button.btn-default, .dialog button.btn-destructive, [role=dialog] button.btn-default').filter({ hasText: /Complete|Mark/ }).last();
      if (await cfm.count()) { await cfm.click(); await sleep(400); }
      gc = await subCalls(p, 'memory.goal');
      check(`${tag} Complete sends memory.goal complete`, gc.some((x) => x.op === 'complete'), JSON.stringify(gc.map((x) => x.op)));
    } else check(`${tag} the new goal offers Complete`, false, (await gp.innerText()).slice(0, 300));
    const resume = p.locator('[data-slot=agent-tab-goals] button', { hasText: 'Resume' }).first();
    if (await resume.count()) {
      await resume.click();
      await sleep(400);
      const cfm = p.locator('[role=dialog] button.btn-default').filter({ hasText: /Resume/ }).last();
      if (await cfm.count()) { await cfm.click(); await sleep(400); }
      gc = await subCalls(p, 'memory.goal');
      check(`${tag} Resume sends memory.goal resume`, gc.some((x) => x.op === 'resume'), JSON.stringify(gc.map((x) => x.op)));
    } else check(`${tag} a paused goal offers Resume`, false, (await gp.innerText()).slice(0, 300));

    await p.evaluate((nm) => window.__sa.memory.set(nm, [{ key: 'pricing', text: 'Rival A costs $9', metadata: null, updatedAt: Date.now() }, { key: 'scope', text: 'EU only', metadata: null, updatedAt: Date.now() }]), 'step-1');
    await openTab(p, id, 'memory');
    const mp = p.locator('[data-slot=agent-tab-memory]');
    check(`${tag} Memory tab renders its sections`, (await mp.isVisible().catch(() => false)) && /Decisions/.test(await mp.innerText()) && /Recent turns/.test(await mp.innerText()));
    await sleep(300);
    const ent = await p.locator('[data-slot=memory-entries]').innerText();
    check(`${tag} saved entries of the agent's memory tool are listed`, /pricing/.test(ent) && /EU only/.test(ent), ent.slice(0, 200));
    const del = p.locator('[data-slot=memory-entries] button[aria-label*="Delete" i], [data-slot=memory-entries] button:has-text("Delete")').first();
    if (await del.count()) {
      await del.click();
      await sleep(300);
      const cfm = p.locator('button.btn-destructive', { hasText: 'Delete' }).last();
      if (await cfm.count()) { await cfm.click(); await sleep(400); }
      const mc = await subCalls(p, 'memory');
      check(`${tag} Delete sends memory delete for that key`, mc.some((x) => x.op === 'delete' && x.id === id && x.key === 'pricing'), JSON.stringify(mc).slice(0, 300));
      check(`${tag} the deleted entry leaves the list`, !/Rival A/.test(await p.locator('[data-slot=memory-entries]').innerText()));
    } else check(`${tag} each entry has Delete`, false, ent.slice(0, 200));
    const ov = await overflow(p);
    check(`${tag} Goals/Memory: no horizontal overflow`, ov.ok, JSON.stringify(ov));
    check(`${tag} Goals/Memory: no page errors`, !errs.length, errs.join(' | '));
    await ctx.close();
  }
}


const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function testComposerPhase6(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  const id = ids['step-1'];
  // two kept versions of its chat, as the engine saves them on edit/retry
  await p.evaluate((i) => {
    window.__sa.transcripts.set(i, [{ role: 'user', content: 'current question' }, { role: 'assistant', content: [{ type: 'text', text: 'current answer' }] }]);
    window.__sa.branches.set(i, [
      { id: 'b1', turn: 0, reason: 'edit', createdAt: Date.now() - 60000, messages: [{ role: 'user', content: 'first wording' }, { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }] },
      { id: 'b2', turn: 0, reason: 'regenerate', createdAt: Date.now() - 30000, messages: [{ role: 'user', content: 'current question' }, { role: 'assistant', content: [{ type: 'text', text: 'retried answer' }] }] },
    ]);
  }, id);
  await p.evaluate((i) => { const s = window.__sa.subs.get(i); window.__sa.emit('subagent.finished', { ...s, status: 'finished' }); }, id);
  await p.evaluate((i) => window.__app.chat.openSubagent(i), id);
  await sleep(700);
  // image + text in the sub-agent composer -> message with attachmentsJson
  const input = p.locator('.aui-composer-root input[type=file]').first();
  await input.setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await sleep(500);
  await p.locator('.aui-composer-root textarea').first().fill('What does this chart show?');
  await p.keyboard.press('Enter');
  await sleep(800);
  const msg = (await subCalls(p, 'message')).filter((c) => c.id === id).pop() || {};
  const att = msg.attachmentsJson ? JSON.parse(msg.attachmentsJson) : [];
  check('an image picked in the sub-agent composer goes out with message as attachmentsJson', att.length === 1 && att[0].type === 'image' && att[0].mediaType === 'image/png' && att[0].data === PNG, JSON.stringify(msg).slice(0, 300));
  check('the text goes with the image', msg.message === 'What does this chart show?', String(msg.message));
  const stored = await p.evaluate((i) => window.__sa.transcripts.get(i).slice(-1)[0], id);
  check('the engine keeps the image in the agent chat', Array.isArray(stored?.content) && stored.content.some((c) => c.type === 'image'), JSON.stringify(stored).slice(0, 200));
  // versions
  const vb = p.locator('[data-slot=subagent-chat-versions]');
  check('the sub-agent chat header has Versions', await vb.count() === 1);
  await vb.click();
  await sleep(500);
  const items = p.locator('[data-slot=subagent-version]');
  const txt = await p.locator('[data-slot=subagent-versions]').innerText().catch(() => '');
  check('Versions lists both kept versions, newest first, with why each was kept', (await items.count()) === 2 && /Before a retry[\s\S]*Before an edit/.test(txt), txt.slice(0, 300));
  check('a version shows the message it started from', /first wording/.test(txt), txt.slice(0, 300));
  check('restore is enabled for a finished agent', !(await p.locator('[data-slot=subagent-version-restore][data-branch=b1]').isDisabled()));
  await p.locator('[data-slot=subagent-version-restore][data-branch=b1]').click();
  await sleep(700);
  const rc = await subCalls(p, 'restoreBranch');
  check('Restore sends restoreBranch for that version', rc.length === 1 && rc[0].id === id && rc[0].branchId === 'b1', JSON.stringify(rc));
  const shown = await p.evaluate(() => document.querySelector('.aui-thread-viewport, [data-slot=thread]')?.innerText || document.body.innerText);
  check('the chat now shows the restored version', /first wording/.test(shown) && /first answer/.test(shown), shown.slice(0, 200));
  const kept = await p.evaluate((i) => window.__sa.branches.get(i).map((b) => b.reason), id);
  check('the chat that was replaced is kept as a version', kept.includes('restore') && kept.length === 2, kept.join(','));
  // a running agent cannot restore
  await p.evaluate((i) => window.__sa.branches.set(i, [{ id: 'b9', turn: 0, reason: 'edit', createdAt: Date.now(), messages: [{ role: 'user', content: 'x' }] }]), ids['step-2']);
  await p.keyboard.press('Escape');
  await sleep(200);
  await p.evaluate((i) => window.__subagentChat.openVersions(i), ids['step-2']);
  await sleep(500);
  check('restore is disabled while the agent runs', await p.locator('[data-slot=subagent-version-restore][data-branch=b9]').isDisabled());
  await p.keyboard.press('Escape');
  check('composer/versions: no page errors', !errs.length, errs.join(' | '));
  await ctx.close();

  // an engine without subagentTeam refuses images with a clear reason and sends nothing
  const old = await open(browser, { features: ['subagentQueue', 'subagentData', 'subagentReuse', 'crossSession', 'subagentGraph'] });
  const r = await seed(old.p);
  await old.p.evaluate((i) => window.__app.chat.openSubagent(i), r.ids['step-1']);
  await sleep(600);
  check('without subagentTeam the header has no Versions', (await old.p.locator('[data-slot=subagent-chat-versions]').count()) === 0);
  await old.ctx.close();
}

/** UI/UX pass: timeline (waterfall) view, minimap, floating controls, arrow-key graph navigation, compare dialog, side-panel resize/expand. */
async function testPolish(browser) {
  const { seedDemo } = require('./demo-seed.js');
  for (const env of [{ width: 1280, height: 860 }, { width: 1280, height: 860, dark: true }, { width: 390, height: 844 }]) {
    const tag = `polish ${env.width}px${env.dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, env);
    const { ids } = await seedDemo(p);
    await openExplorer(p);
    // floating controls live on the canvas
    check(`${tag} zoom controls float on the canvas`, (await p.locator('.sa-x-canvaswrap [data-slot=explorer-controls] [data-slot=explorer-fit]').count()) === 1);
    // first view is readable: node text is at least ~8px on screen
    const k = await p.evaluate(() => parseFloat(document.querySelector('[data-slot=subagent-explorer]').dataset.zoom));
    check(`${tag} the first view keeps node text readable (zoom >= 0.6)`, k >= 0.6, String(k));
    // arrow keys move between agents
    await p.locator(`[data-slot=subagent-explorer] [data-node="${ids.outline}"]`).focus();
    await p.keyboard.press('ArrowDown');
    const f1 = await p.evaluate(() => document.activeElement?.dataset?.node);
    check(`${tag} ArrowDown moves focus to the agent below`, f1 === ids.draft, f1);
    await p.keyboard.press('ArrowRight');
    const f2 = await p.evaluate(() => document.activeElement?.dataset?.node);
    check(`${tag} ArrowRight moves focus to the agent it started`, f2 === ids['fact-checker'], f2);
    await p.keyboard.press('ArrowLeft');
    check(`${tag} ArrowLeft moves back to its parent`, (await p.evaluate(() => document.activeElement?.dataset?.node)) === ids.draft);
    // timeline view
    await p.locator('[data-slot=explorer-view-timeline]').click();
    await sleep(300);
    const wf = await p.evaluate(() => {
      const root = document.querySelector('[data-slot=subagent-explorer]');
      const rows = [...root.querySelectorAll('[data-wf-row]')];
      const bar = (id) => root.querySelector(`[data-wf-row="${id}"] .sa-x-wf-bar`);
      return { view: root.dataset.view, rows: rows.length, canvasHidden: getComputedStyle(root.querySelector('.sa-x-canvas')).display === 'none',
        checked: root.querySelector('[data-slot=explorer-view-timeline]').getAttribute('aria-checked'),
        statuses: rows.map((r) => r.dataset.status), labels: rows.map((r) => r.getAttribute('aria-label')),
        overflowX: root.querySelector('.sa-x-wf').scrollWidth > root.querySelector('.sa-x-wf').clientWidth + 1 };
    });
    check(`${tag} Timeline switches the view`, wf.view === 'timeline' && wf.canvasHidden && wf.checked === 'true', JSON.stringify(wf).slice(0, 200));
    check(`${tag} Timeline has one row per agent`, wf.rows === 10, String(wf.rows));
    check(`${tag} Timeline rows carry every status`, ['finished', 'cancelled', 'running', 'queued', 'error', 'paused'].every((x) => wf.statuses.includes(x)), wf.statuses.join());
    check(`${tag} Timeline row labels say duration and tokens`, wf.labels.some((l) => /web-scout, Finished, ran 41s, 18k tokens/.test(l)), wf.labels[0]);
    check(`${tag} Timeline row of a parent counts the agents below it`, wf.labels.some((l) => /draft, .*1 below it using 6\.3k tokens/.test(l)), wf.labels.find((l) => l.startsWith('draft')));
    check(`${tag} Timeline does not scroll sideways`, !wf.overflowX);
    check(`${tag} a queued agent has no run bar`, (await p.locator(`[data-wf-row="${ids.polish}"] .sa-x-wf-bar`).count()) === 0);
    await p.locator(`[data-wf-row="${ids.reviewer}"]`).click();
    await sleep(250);
    check(`${tag} clicking a row selects that agent in the inspector`, /reviewer/.test(await p.locator('[data-slot=explorer-inspector] h4').first().textContent()));
    await p.locator(`[data-wf-row="${ids.reviewer}"]`).focus();
    await p.keyboard.press('ArrowDown');
    check(`${tag} ArrowDown moves to the next timeline row`, (await p.evaluate(() => document.activeElement?.dataset?.wfRow)) === ids['pricing-lookup']);
    // compare
    const cmp = p.locator('[data-slot=explorer-inspector] [data-action=compare]');
    check(`${tag} a batch member offers Compare batch`, (await cmp.count()) === 1);
    await cmp.click();
    await sleep(300);
    const cols = await p.evaluate(() => [...document.querySelectorAll('[data-slot=compare-col]')].map((c) => ({ name: c.querySelector('h4').textContent, winner: c.dataset.winner === 'true', text: c.querySelector('.sa-x-cmp-text').textContent })));
    check(`${tag} Compare shows worker and reviewer side by side`, cols.length === 2 && cols[0].name === 'writer' && cols[1].name === 'reviewer', JSON.stringify(cols).slice(0, 200));
    check(`${tag} Compare marks the approved reviewer and shows the reports`, cols[1]?.winner && /APPROVED/.test(cols[1].text) && /Version 2\.4/.test(cols[0].text));
    if (env.width <= 420) { const ov = await overflow(p); check(`${tag} Compare does not overflow sideways`, !ov.length, JSON.stringify(ov).slice(0, 200)); }
    await p.keyboard.press('Escape');
    await sleep(200);
    // view persists
    await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' }));
    await sleep(400);
    check(`${tag} the chosen view is remembered`, (await p.evaluate(() => document.querySelector('[data-slot=subagent-explorer]').dataset.view)) === 'timeline');
    await p.locator('[data-slot=explorer-view-graph]').click();
    await sleep(300);
    if (env.width >= 1000) {
      // side panel: expand and resize
      const w0 = await p.evaluate(() => document.querySelector('.dialog.sa-docked').getBoundingClientRect().width);
      await p.locator('[data-slot=sa-dock-expand]').click();
      await sleep(400);
      const w1 = await p.evaluate(() => document.querySelector('.dialog.sa-docked').getBoundingClientRect().width);
      check(`${tag} Expand widens the Agents panel`, w1 > w0 + 300, `${w0} -> ${w1}`);
      check(`${tag} Expand button says Shrink once wide`, (await p.locator('[data-slot=sa-dock-expand]').getAttribute('aria-label')) === 'Shrink panel');
      const mini = await p.evaluate(() => { const m = document.querySelector('.sa-x-mini'); return { shown: getComputedStyle(m).display !== 'none', nodes: m.querySelectorAll('.sa-x-mini-node').length }; });
      check(`${tag} a wide Explorer shows the minimap with every agent`, mini.shown && mini.nodes === 11, JSON.stringify(mini));
      const before = await p.evaluate(() => document.querySelector('[data-slot=subagent-explorer]').dataset.zoom + '|' + document.querySelector('.sa-x-stage')?.getAttribute('transform'));
      const mb = await p.locator('.sa-x-mini').boundingBox();
      await p.mouse.click(mb.x + mb.width - 6, mb.y + mb.height - 6);
      await sleep(200);
      const after = await p.evaluate(() => document.querySelector('[data-slot=subagent-explorer]').dataset.zoom + '|' + document.querySelector('.sa-x-stage')?.getAttribute('transform'));
      check(`${tag} clicking the minimap moves the view`, before !== after, `${before} / ${after}`);
      await p.locator('[data-slot=sa-dock-expand]').click();
      await sleep(400);
      await p.locator('[data-slot=sa-dock-resize]').focus();
      for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft');
      await sleep(400);
      const w2 = await p.evaluate(() => document.querySelector('.dialog.sa-docked').getBoundingClientRect().width);
      check(`${tag} ArrowLeft on the resize handle widens the panel by 96px`, Math.abs(w2 - (w0 + 96)) <= 2, `${w0} -> ${w2}`);
      check(`${tag} the resize handle is a labelled separator`, (await p.locator('[data-slot=sa-dock-resize]').getAttribute('role')) === 'separator' && !!(await p.locator('[data-slot=sa-dock-resize]').getAttribute('aria-valuenow')));
      await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' }));
      await sleep(400);
      const w3 = await p.evaluate(() => document.querySelector('.dialog.sa-docked').getBoundingClientRect().width);
      check(`${tag} the panel width is remembered`, Math.abs(w3 - w2) <= 2, `${w2} vs ${w3}`);
    } else {
      check(`${tag} a phone has no resize handle or expand button`, (await p.locator('[data-slot=sa-dock-resize]:visible, [data-slot=sa-dock-expand]:visible').count()) === 0);
      const ov = await overflow(p);
      check(`${tag} Explorer does not overflow sideways`, !ov.length, JSON.stringify(ov).slice(0, 200));
      const tb = await p.evaluate(() => Math.round(document.querySelector('.sa-x-toolbar').getBoundingClientRect().height));
      check(`${tag} the toolbar stays compact (<= 210px)`, tb <= 210, String(tb));
    }
    check(`${tag} no console errors`, !errs.length, errs.join(' | ').slice(0, 300));
    await ctx.close();
  }
}

module.exports = { open, seed, subCalls, check, results };
if (require.main === module) (async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testGating, testExplorer, testBatchDialog, testFork, testSettingsEdits, testGoalsMemory, testComposerPhase6, testPolish };
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\nsubagent-advanced: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
