// Swarm UI: the Swarm group inside the agent view's one section nav (Swarm, Topics, Blackboard, Decisions), the
// settings sheet, the "How it talks" spawn fields, errors, and layout at 1280/390, light and dark.
// Runs on the mock engine (mock-swarm.js mirrors the Rust app API in subagents/channels.rs).
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { seedDemo } = require('./demo-seed.js');
const { seedSwarm } = require('./swarm-seed.js');
const { layoutAudit } = require('./layout-audit.js');

const EXE = (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = 'file://' + path.resolve(__dirname, '../../www/agent.html');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`); };
const BASE = ['subagentQueue', 'subagentData', 'subagentReuse', 'crossSession', 'subagentGraph', 'subagentTeam', 'subagentChatAllow', 'subagentAdvanced'];

async function open(browser, { width = 1280, height = 900, dark = false, swarm = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript((f) => { window.__SA_CFG = { s1features: f }; window.__MEM_CFG = { goals: true }; }, swarm ? [...BASE, 'subagentSwarm'] : BASE);
  for (const f of ['mock3.js', 'mock-v2.js', 'mock-subagents.js', 'mock-memory.js', 'mock-swarm.js']) await ctx.addInitScript({ content: read(f) });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => { window.__sa.mainKey = window.__app.chat.mainId; });
  await sleep(300);
  return { p, ctx, errs };
}

async function seed(p, opts) { const { ids, k } = await seedDemo(p); await seedSwarm(p, ids, opts); return { ids, k }; }
const subCalls = (p, action) => p.evaluate((a) => window.__mock.calls.filter((c) => c.name === 'agent.subagents').map((c) => c.args || {}).filter((x) => !a || x.action === a), action);
const calls = subCalls;
const text = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);
const visible = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);

/** Opens an agent on a section; at >= 1000px expands the dock first, so the side nav shows. */
async function openTab(p, id, tab, { expand = false } = {}) {
  await p.evaluate(([i, t]) => window.__subagents.open(window.__app, { id: i, agentTab: t }), [id, tab]);
  await sleep(500);
  if (expand && await visible(p, '[data-slot=sa-dock-expand]')) { await p.locator('[data-slot=sa-dock-expand]').click(); await sleep(500); }
}
/** Clicks a section in the nav, through "More" when the row has folded it away. */
async function pick(p, tab) {
  // Swarm sections live in the Agents panel's Swarm tab now.
  if (['swarm', 'topics', 'board', 'decisions'].includes(tab)) { await p.locator(`[data-slot=swarm-sections] [data-section="${tab}"]`).click(); await sleep(500); return; }
  const hidden = await p.$eval(`[data-slot="agent-view-tabs"] [data-tab="${tab}"]`, (e) => e.hidden || !e.offsetParent).catch(() => true);
  if (hidden) { await p.locator('[data-slot="agent-view-more"]').click(); await sleep(150); await p.locator(`.sa-more-menu [data-tab="${tab}"]`).click(); }
  else await p.locator(`[data-slot="agent-view-tabs"] [data-tab="${tab}"]`).click();
  await sleep(500);
}
async function confirm(p) {
  const b = p.locator('[role=dialog] .btn-destructive:visible, [role=alertdialog] .btn-destructive:visible').last();
  await b.waitFor({ timeout: 3000 });
  await b.click();
  await sleep(500);
}

async function testGating(browser) {
  for (const swarm of [false, true]) {
    const { p, ctx, errs } = await open(browser, { swarm });
    const { ids } = await seed(p);
    await openTab(p, ids.draft, 'overview');
    const tabs = await p.$$eval('[data-slot="agent-view-tabs"] [data-tab]', (els) => els.map((e) => e.dataset.tab));
    const sw = ['swarm', 'topics', 'board', 'decisions'];
    check(`${swarm ? 'with' : 'without'} the swarm feature an agent's nav has no swarm sections (they are chat-wide)`, sw.every((t) => !tabs.includes(t)), tabs.join());
    await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'agents' })); await sleep(400);
    const ptabs = await p.$$eval('.sa-tabs [data-tab]', (els) => els.map((e) => e.dataset.tab));
    check(`${swarm ? 'with' : 'without'} the swarm feature the Agents panel ${swarm ? 'has' : 'has no'} a Swarm tab`, ptabs.includes('swarm') === swarm, ptabs.join());
    const rows = await p.evaluate(() => [...document.querySelectorAll('[role=tablist]')].filter((t) => t.offsetParent && t.closest('[data-slot=subagents-panel], .sa-panel, .sa-agent-view, body')).length);
    check(`${swarm ? 'with' : 'without'} swarm: one section nav, never stacked tab rows`, rows <= 1, String(rows));
    check(`${swarm ? 'with' : 'without'} swarm: no page errors`, !errs.length, errs.join(' | ').slice(0, 300));
    await ctx.close();
  }
}

async function testOverview(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await openTab(p, ids.draft, 'swarm', { expand: true });
  check('the Swarm section opens with its overview', await visible(p, '[data-slot=swarm-overview]'));
  check('the hero names the chat\'s topology (Hierarchical)', /Hierarchical/.test(await text(p, '[data-slot=swarm-topology]')), await text(p, '[data-slot=swarm-topology]'));
  check('the topology picture is drawn', await p.locator('[data-slot=swarm-topology] svg').count() >= 1);
  check('the live chip reads Live', /Live/.test(await text(p, '[data-slot=swarm-live]')), await text(p, '[data-slot=swarm-live]'));
  const stats = await text(p, '[data-slot=swarm-stats]');
  check('stats count 2 topics, 3 board keys, 2 open decisions and 2 handoffs', /2\s*\n?\s*Topics/i.test(stats) && /3\s*\n?\s*(Board|Blackboard)/i.test(stats) && /2\s*\n?\s*(Open decisions|Open)/i.test(stats) && /2\s*\n?\s*Handoffs/i.test(stats), stats.replace(/\n/g, ' / '));
  check('the coordinator is draft, term 2', /draft/.test(await text(p, '[data-slot=swarm-coordinator]')) && /2/.test(await text(p, '[data-slot=swarm-coordinator]')), await text(p, '[data-slot=swarm-coordinator]'));
  check('the activity feed lists recent swarm events', await p.locator('[data-slot=swarm-activity] li').count() >= 5, String(await p.locator('[data-slot=swarm-activity] li').count()));
  const comp = await text(p, '[data-slot=swarm-compaction]');
  check('the compaction card shows the folded topic posts and the thresholds', /5/.test(comp) && /6/.test(comp) && /10/.test(comp), comp.replace(/\n/g, ' / '));
  // roles and per-agent topology
  const roleSel = p.locator(`li[data-id="${ids.draft}"] [data-slot=swarm-role]`);
  check('opened from an agent, the Roles card marks that agent first with its role (Lead)', (await p.$eval('[data-slot=swarm-roles] li[data-focus=true]', (e) => e.dataset.id).catch(() => '')) === ids.draft && (await p.$eval('[data-slot=swarm-roles] li', (e) => e.dataset.id).catch(() => '')) === ids.draft && (await roleSel.inputValue()) === 'lead', String(await p.locator('[data-slot=swarm-role]').count()));
  await roleSel.selectOption('member');
  await sleep(500);
  const rc = await calls(p, 'setCommsRole');
  check('changing a role sends setCommsRole for that agent', rc.some((c) => c.id === ids.draft && c.role && c.role !== 'lead'), JSON.stringify(rc).slice(0, 200));
  await p.locator(`li[data-id="${ids.draft}"] [data-slot=swarm-agent-topology]`).selectOption('star');
  await sleep(500);
  check('changing an agent\'s topology sends setCommsRole with topology star', (await calls(p, 'setCommsRole')).some((c) => c.id === ids.draft && c.topology === 'star'));
  // pause
  await p.locator('[data-slot=swarm-pause]').click();
  await sleep(600);
  check('Pause saves paused: true for this chat', (await calls(p, 'setCommsConfig')).some((c) => c.patch && c.patch.paused === true));
  check('the chip then reads Paused', /Paused/.test(await text(p, '[data-slot=swarm-live]')), await text(p, '[data-slot=swarm-live]'));
  await p.locator('[data-slot=swarm-pause]').click();
  await sleep(600);
  check('Resume saves paused: false', (await calls(p, 'setCommsConfig')).some((c) => c.patch && c.patch.paused === false));
  // stop all, behind a confirm
  await p.locator('[data-slot=swarm-stop-all]').click();
  await sleep(200);
  check('Stop all does nothing before the confirm', !(await calls(p, 'commsStopAll')).length);
  await confirm(p);
  check('confirming Stop all sends commsStopAll for this chat', (await calls(p, 'commsStopAll')).length === 1);
  // a stat jumps to its section
  await p.locator('[data-slot=swarm-stats] [data-tab=topics], [data-slot=swarm-stats] button').first().click();
  await sleep(500);
  check('a stat opens its section', await visible(p, '[data-slot=topic-list]') || await visible(p, '[data-slot=board-list]') || await visible(p, '[data-slot=swarm-decisions]'));
  check('overview: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testTopics(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await openTab(p, ids.draft, 'topics', { expand: true });
  const names = await p.$$eval('[data-slot=topic-list] [data-topic]', (els) => els.map((e) => e.dataset.topic));
  check('the topic list has #research and #release-notes, busiest first', names[0] === 'research' && names.includes('release-notes'), names.join());
  const det = await text(p, '[data-slot=topic-detail]');
  check('the open topic shows its newest post', /1,512 words/.test(det), det.slice(0, 160));
  check('older posts show as one compacted digest line', await visible(p, '[data-slot=swarm-digest]') && /5/.test(await text(p, '[data-slot=topic-detail] [data-slot=swarm-digest]')), await text(p, '[data-slot=topic-detail] [data-slot=swarm-digest]'));
  await p.locator('[data-slot=topic-compose]').fill('User: keep it under 1,500.');
  await sleep(3500); // a poll re-renders; the draft must survive it
  check('a typed post survives the background refresh', (await p.locator('[data-slot=topic-compose]').inputValue()) === 'User: keep it under 1,500.');
  await p.locator('[data-slot=topic-send]').click();
  await sleep(600);
  check('Send publishes to #research', (await calls(p, 'topicPublish')).some((c) => c.topic === 'research' && /1,500/.test(c.message || c.text || '')), JSON.stringify(await calls(p, 'topicPublish')).slice(0, 200));
  check('the new post shows in the thread', /keep it under 1,500/.test(await text(p, '[data-slot=topic-detail]')));
  check('the composer clears after sending', (await p.locator('[data-slot=topic-compose]').inputValue()) === '');
  await p.locator('[data-slot=topic-new-name]').fill('Bad name!');
  await p.locator('[data-slot=topic-create]').click();
  await sleep(500);
  const bad = await p.evaluate(() => Object.keys(window.__swarm.topics));
  check('an invalid topic name is refused (normalised or rejected, never saved raw)', !bad.includes('Bad name!'), bad.join());
  await p.locator('[data-slot=topic-new-name]').fill('ops');
  await p.locator('[data-slot=topic-create]').click();
  await sleep(600);
  check('a new topic is created and listed', await p.locator('[data-slot=topic-list] [data-topic=ops]').count() === 1);
  await p.locator('[data-slot=topic-list] [data-topic=ops]').click();
  await sleep(300);
  await p.locator('[data-slot=topic-delete]').click();
  await confirm(p);
  check('Delete removes the topic after the confirm', await p.locator('[data-slot=topic-list] [data-topic=ops]').count() === 0 && (await calls(p, 'topicDelete')).length === 1);
  check('topics: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testBoard(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await openTab(p, ids.draft, 'board', { expand: true });
  const keys = await p.$$eval('[data-slot=board-list] [data-key]', (els) => els.map((e) => e.dataset.key));
  check('the blackboard lists every key', ['findings/bench', 'draft/wordcount', 'pricing/api'].every((k) => keys.includes(k)), keys.join());
  const row = p.locator('[data-slot=board-list] [data-key="findings/bench"]');
  check('a rewritten key shows version 2', /v\s?2/i.test(await row.innerText()), (await row.innerText()).slice(0, 160));
  const faded = await p.$eval('[data-slot=board-list] [data-key="pricing/api"]', (e) => e.dataset.faded || e.querySelector('[data-faded]')?.dataset.faded || '');
  check('a mark untouched for 2.5 hours shows as faded', /true|1/.test(faded), faded);
  await p.locator('[data-slot=board-filter]').fill('bench');
  await sleep(400);
  check('the filter narrows the list', await p.locator('[data-slot=board-list] [data-key]:visible').count() === 1, String(await p.locator('[data-slot=board-list] [data-key]:visible').count()));
  await p.locator('[data-slot=board-filter]').fill('');
  await sleep(300);
  // edit, then a conflict: an agent writes while the user edits
  await p.locator('[data-slot=board-list] [data-key="draft/wordcount"] [data-slot=board-edit]').click();
  await sleep(300);
  await p.locator('[data-slot=board-value]').fill('1498');
  await p.locator('[data-slot=board-save]').click();
  await sleep(600);
  const w = await calls(p, 'blackboardWrite');
  check('Save writes the key with the version it was read at', w.some((c) => c.key === 'draft/wordcount' && c.value === '1498' && Number(c.expectedVersion ?? c.version) === 1), JSON.stringify(w).slice(0, 200));
  await p.locator('[data-slot=board-list] [data-key="findings/bench"] [data-slot=board-edit]').click();
  await sleep(300);
  await p.evaluate((x) => window.__swarm.agentWrite('findings/bench', x, 'changed by the agent', {}), ids['fact-checker']);
  await p.locator('[data-slot=board-value]').fill('my edit');
  await p.locator('[data-slot=board-save]').click();
  await sleep(600);
  const err = await text(p, '[data-slot=board-error]');
  check('a stale save shows a version conflict and keeps the edit', /version|changed|conflict/i.test(err) && (await p.locator('[data-slot=board-value]').inputValue()) === 'my edit', err);
  check('the stale save did not overwrite the agent\'s value', await p.evaluate(() => window.__swarm.board['findings/bench'].value) === 'changed by the agent');
  await p.keyboard.press('Escape');
  await sleep(300);
  await p.locator('[data-slot=board-add]').click();
  await sleep(300);
  await p.locator('[data-slot=board-key]').fill('notes/user');
  await p.locator('[data-slot=board-value]').fill('Ship Friday');
  await p.locator('[data-slot=board-save]').click();
  await sleep(600);
  check('a new key is added', await p.locator('[data-slot=board-list] [data-key="notes/user"]').count() === 1);
  await p.locator('[data-slot=board-list] [data-key="notes/user"] [aria-label^="Delete"]').click();
  await confirm(p);
  check('Delete removes the key after the confirm', await p.locator('[data-slot=board-list] [data-key="notes/user"]').count() === 0 && (await calls(p, 'blackboardDelete')).length === 1);
  check('blackboard: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testDecisions(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await openTab(p, ids.draft, 'decisions', { expand: true });
  const kinds = await p.$$eval('[data-slot=decision-kinds] [data-kind]', (els) => els.map((e) => e.dataset.kind));
  check('one segmented control switches Market, Votes, Debates and Elections', kinds.length === 4, kinds.join());
  const kind = async (k) => { await p.locator(`[data-slot=decision-kinds] [data-kind="${k}"]`).click(); await sleep(400); };
  await kind(kinds[0]);
  check('Market lists both auctions', await p.locator('[data-slot=auction-card]').count() === 2);
  const aw = p.locator('[data-slot=auction-card][data-status=awarded]');
  check('the awarded auction marks outline\'s bid as the winner and shows the declined bid', /outline/.test(await aw.innerText()) && await aw.locator('[data-declined=true]').count() === 1, (await aw.innerText()).slice(0, 200));
  await kind(kinds[1]);
  const vote = await p.$eval('[data-slot=vote-card]', (e) => e.textContent);
  check('Votes shows the tally (2 to 1) and each ballot with its reason', /2/.test(vote) && /1/.test(vote) && /Room for sources/.test(vote), vote.slice(0, 200));
  await kind(kinds[2]);
  const deb = await text(p, '[data-slot=debate-card]');
  check('Debates shows rounds and the agreed outcome', /Round 1/i.test(deb) && /Round 2/i.test(deb) && /Agreed/.test(deb), deb.slice(0, 200));
  await kind(kinds[3]);
  check('Elections lists both terms, newest first', await p.locator('[data-slot=election-card]').count() === 2 && /2/.test(await p.locator('[data-slot=election-card]').first().innerText()));
  // keyboard on the segmented control
  await p.locator(`[data-slot=decision-kinds] [data-kind="${kinds[3]}"]`).focus();
  await p.keyboard.press('Home');
  await sleep(400);
  const sel = await p.$eval('[data-slot=decision-kinds] [aria-checked=true], [data-slot=decision-kinds] [aria-selected=true], [data-slot=decision-kinds] [aria-pressed=true]', (e) => e.dataset.kind).catch(() => '');
  check('Home on the segmented control goes to the first kind', sel === kinds[0], sel);
  check('decisions: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testSettings(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await openTab(p, ids.draft, 'swarm', { expand: true });
  await p.locator('[data-slot=swarm-configure]').click();
  await sleep(600);
  const sheet = p.locator('[data-slot=swarm-settings]');
  check('Configure opens the swarm settings sheet', await sheet.isVisible().catch(() => false));
  const cards = await p.$$eval('[data-slot=swarm-topologies] button[data-topology]', (els) => els.map((e) => [e.dataset.topology, e.getAttribute('aria-checked')]));
  check('nine topology cards, Hierarchical checked', cards.length === 9 && cards.find((c) => c[0] === 'hierarchical')?.[1] === 'true', JSON.stringify(cards));
  await p.locator('[data-slot=swarm-topologies] button[data-topology=hierarchical]').focus();
  await p.keyboard.press('ArrowRight');
  await sleep(200);
  const after = await p.$eval('[data-slot=swarm-topologies] button[aria-checked=true]', (e) => e.dataset.topology);
  check('arrow keys move the topology choice', after && after !== 'hierarchical', after);
  await p.locator('[data-slot=swarm-topologies] button[data-topology=swarm]').click();
  // a limit out of range is refused before saving
  const lim = sheet.locator('input[type=number]').first();
  const limName = await lim.getAttribute('data-key') || await lim.getAttribute('name') || '';
  await lim.fill('99999');
  await p.locator('[data-slot=swarm-settings-save]').click();
  await sleep(500);
  const se = await text(p, '[data-slot=swarm-settings-error]');
  check('an out-of-range limit blocks Save with a message', se.length > 0 && !(await calls(p, 'setCommsConfig')).length, `${limName}: ${se}`);
  await lim.fill(await lim.getAttribute('min') || '1');
  // a deny rule
  await sheet.locator('[data-slot=edge-add]').click();
  await sleep(200);
  check('Add rule lists the new rule', await sheet.locator('[data-slot=swarm-edges] [data-slot=edge-remove]').count() === 1);
  await sheet.locator('[data-slot=edge-from]').last().selectOption('draft');
  await sheet.locator('[data-slot=edge-to]').last().selectOption('polish');
  await sheet.locator('[data-slot=edge-kind]').last().selectOption('deny');
  await p.locator('[data-slot=swarm-settings-save]').click();
  await sleep(700);
  const sc = await calls(p, 'setCommsConfig');
  const last = sc[sc.length - 1] || {};
  const pt = last.patch || {};
  check('Save sends topology swarm and the deny rule for this chat', pt.topology === 'swarm' && (pt.edges || []).some((e) => e.from === 'draft' && e.to === 'polish' && e.allow === false) && last.sessionKey && last.sessionKey !== '*', JSON.stringify(last).slice(0, 300));
  check('the sheet closes after saving', !(await sheet.isVisible().catch(() => false)));
  check('the overview now names Swarm', /Swarm/.test(await text(p, '[data-slot=swarm-topology]')));
  // Defaults scope
  await p.locator('[data-slot=swarm-configure]').click();
  await sleep(600);
  await p.locator('[data-slot=swarm-settings] [data-scope=defaults]').click();
  await sleep(600);
  check('the Defaults scope loads the global defaults', (await calls(p, 'commsConfig')).some((c) => c.sessionKey === '*'));
  // presets
  const pre = p.locator('[data-slot=swarm-preset]');
  const opts = await pre.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  check('built-in presets are offered (9)', opts.length >= 9, opts.join());
  await p.locator('[data-slot=swarm-settings] [data-scope=chat]').click();
  await sleep(500);
  await pre.selectOption(opts.find((o) => /swarm/.test(o)) || opts[1]);
  await p.locator('[data-slot=swarm-preset-apply]').click();
  await sleep(600);
  check('Apply preset sends applyCommsPreset for this chat', (await calls(p, 'applyCommsPreset')).length === 1);
  if (!(await sheet.isVisible().catch(() => false))) { await p.locator('[data-slot=swarm-configure]').click(); await sleep(600); }
  await p.locator('[data-slot=swarm-preset-save]').click();
  await sleep(300);
  await p.locator('[data-slot=preset-name]').fill('my-team');
  await p.locator('[data-slot=preset-save]').click();
  await sleep(600);
  check('Save as preset stores a named preset', (await calls(p, 'saveCommsPreset')).some((c) => c.name === 'my-team'), JSON.stringify(await calls(p, 'saveCommsPreset')).slice(0, 200));
  await p.locator('[data-slot=swarm-preset]').selectOption('my-team');
  await sleep(200);
  await p.locator('[data-slot=swarm-preset-delete]').click();
  await confirm(p);
  check('a saved preset can be deleted', (await calls(p, 'deleteCommsPreset')).some((c) => c.name === 'my-team'));
  check('settings: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testSpawnFields(browser) {
  const { p, ctx, errs } = await open(browser);
  await seed(p);
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' }));
  await sleep(700);
  await p.locator('[data-slot=explorer-new-batch]').click();
  await sleep(400);
  check('the batch dialog has a "How it talks" topology field', await visible(p, '[data-slot=batch-topology]'));
  check('the hub field is hidden until a hub topology is chosen', !(await visible(p, '[data-slot=batch-hub-field]')));
  await p.locator('[data-slot=batch-topology]').selectOption('star');
  await sleep(200);
  check('choosing Star shows the hub field', await visible(p, '[data-slot=batch-hub-field]'));
  const tasks = p.locator('[data-slot=batch-task]');
  await tasks.nth(0).fill('Lead the research');
  await tasks.nth(1).fill('Collect sources');
  await p.locator('[data-slot=batch-hub]').selectOption({ index: 1 });
  await p.locator('[data-slot=batch-start]').click();
  await sleep(700);
  const sb = (await subCalls(p, 'spawnBatch')).concat(await subCalls(p, 'spawn')).pop() || {};
  check('the batch starts with topology star and the chosen hub', sb.topology === 'star' && sb.hub !== undefined && sb.hub !== '', JSON.stringify(sb).slice(0, 300));
  check('spawn fields: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testErrors(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await p.evaluate(() => { window.__swarm.failNext.set('swarmState', 'engine busy'); });
  await openTab(p, ids.draft, 'swarm', { expand: true });
  await sleep(300);
  const e = await text(p, '[data-slot=swarm-error]');
  check('a failed load shows the error with Try again', /engine busy/.test(e) && /Try again/i.test(e), e);
  await p.locator('[data-slot=swarm-error] button').first().click();
  await sleep(700);
  check('Try again loads the overview', await visible(p, '[data-slot=swarm-overview]') && !(await visible(p, '[data-slot=swarm-error]')));
  await ctx.close();
  // an empty chat: a calm empty state, not zeros everywhere
  const o = await open(browser);
  const id = await o.p.evaluate(() => { const k = window.__app.chat.mainId; const s = window.__sa.make({ name: 'solo', task: 't', status: 'running', depth: 1 }); Object.assign(s, { parentId: null, parentSessionKey: k, rootSessionKey: k }); window.__sa.emit('subagent.started', { ...s }); return s.id; });
  await openTab(o.p, id, 'topics', { expand: true });
  check('an empty swarm section shows an empty state that says what fills it', await visible(o.p, '[data-slot=swarm-empty]') && (await text(o.p, '[data-slot=swarm-empty]')).length > 20, await text(o.p, '[data-slot=swarm-empty]'));
  check('errors/empty: no unexpected page errors', !errs.filter((x) => !/engine busy/.test(x)).length && !o.errs.length, errs.concat(o.errs).join(' | ').slice(0, 300));
  await o.ctx.close();
}

async function testLayout(browser) {
  const audit = (p) => p.evaluate(`(${layoutAudit.toString()})()`);
  for (const env of [{ width: 1280, height: 1000 }, { width: 1280, height: 1000, dark: true }, { width: 390, height: 844 }, { width: 390, height: 844, dark: true }]) {
    const tag = `layout ${env.width}px${env.dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, env);
    const { ids } = await seed(p);
    await openTab(p, ids.draft, 'swarm', { expand: env.width >= 1000 });
    for (const t of ['swarm', 'topics', 'board', 'decisions']) {
      await pick(p, t);
      const a = await audit(p);
      check(`${tag} ${t}: no overlapping or cut-off text`, !a.length, a.join(' | ').slice(0, 400));
      const o = await p.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, bad: [...document.querySelectorAll('.sw-view *')].filter((e) => e.children.length === 0 && /\b(undefined|null|NaN|\[object)\b/.test(e.textContent)).map((e) => e.textContent.slice(0, 40)) }));
      check(`${tag} ${t}: no sideways page scroll and no undefined/null text`, o.x <= 1 && !o.bad.length, JSON.stringify(o));
    }
    await pick(p, 'swarm');
    await p.locator('[data-slot=swarm-configure]').click();
    await sleep(600);
    const a = await audit(p);
    check(`${tag} settings sheet: no overlapping or cut-off text`, !a.length, a.join(' | ').slice(0, 400));
    const fit = await p.evaluate(() => { const r = document.querySelector('[data-slot=swarm-settings]').closest('[role=dialog]')?.getBoundingClientRect() || document.querySelector('[data-slot=swarm-settings]').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
    check(`${tag} settings sheet fits the screen`, fit);
    check(`${tag} no page errors`, !errs.length, errs.join(' | ').slice(0, 300));
    await ctx.close();
  }
}

module.exports = { open, seed, openTab, pick, check, results };
if (require.main === module) (async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testGating, testOverview, testTopics, testBoard, testDecisions, testSettings, testSpawnFields, testErrors, testLayout };
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
