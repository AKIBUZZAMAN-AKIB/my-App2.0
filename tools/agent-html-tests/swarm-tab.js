// The Agents panel's Swarm tab and the 7-item agent menu, at a 390 px phone, with checks.
// Run: OUT=/tmp/shots node tools/agent-html-tests/swarm-tab.js
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const L = require('./subagent-swarm-explorer.js');
const { EXE } = require('./subagent-graph-fixes.js');
const OUT = process.env.OUT || path.join(require('os').tmpdir(), 'agent-html-shots', 'swarm-tab');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + info}`); };
const W = Number(process.env.W || 390), H = Number(process.env.H || 844);
const snap = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` }).then(() => console.log('wrote', n));
const tabsOf = (p) => p.$$eval('.sa-tabs [data-tab]', (a) => a.filter((e) => e.getClientRects().length).map((e) => e.dataset.tab));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const dark = !!process.env.DARK;
  // ---- Swarm mode on ----
  {
    const { p, ctx, errs } = await L.open(browser, { width: W, height: H, dark });
    const { ids } = await L.seed(p);
    await p.evaluate(() => window.__subagents.open(window.__app));
    await sleep(700);
    const tabs = await tabsOf(p);
    check('Swarm on: the Agents panel has a Swarm tab', tabs.includes('swarm'), tabs.join());
    await p.locator('.sa-tabs [data-tab=swarm]').click(); await sleep(800);
    check('Swarm tab shows the overview first', !!(await p.$('[data-slot=agents-swarm] [data-slot=swarm-overview]')));
    await snap(p, '02-swarm-tab-overview');
    for (const [sec, slot, name] of [['topics', 'swarm-topics', '03-swarm-tab-topics'], ['board', 'swarm-board', '04-swarm-tab-blackboard'], ['decisions', 'swarm-decisions', '05-swarm-tab-decisions']]) {
      await p.locator(`[data-slot=swarm-sections] [data-section=${sec}]`).click(); await sleep(700);
      const sel = await p.$eval(`[data-slot=swarm-sections] [data-section=${sec}]`, (e) => e.getAttribute('aria-selected'));
      check(`Swarm tab: ${sec} section opens and is selected`, sel === 'true' && !!(await p.$(`[data-slot=agents-swarm] [data-slot^="${slot}"]`)), sel);
      await snap(p, name);
    }
    // An (i) in the Swarm tab opens the shared popover.
    await p.locator('[data-slot=agents-swarm] .sw-tabhead [data-slot=info-tip]').click(); await sleep(400);
    const pop = await p.$eval('.aui-info-pop', (e) => e.textContent).catch(() => '');
    check('Swarm tab (i) opens the same info popover as elsewhere', /Decisions/.test(pop), pop.slice(0, 80));
    await snap(p, '06-info-button-open');
    await p.keyboard.press('Escape'); await sleep(300);

    // The per-agent More menu: 7 of the agent's own items, no swarm ones.
    await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'overview' }), ids.outline);
    await sleep(700);
    const more = p.locator('[data-slot=agent-view-more]').first();
    await more.click(); await sleep(400);
    const items = await p.$$eval('.sa-more-menu [data-tab]', (a) => a.filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()));
    console.log('More menu:', items.join(' | '));
    check('Agent More menu has the 7 own items', JSON.stringify(items) === JSON.stringify(['Team', 'Graph', 'Goals', 'Tools', 'Context', 'Memory', 'Settings']), items.join());
    await snap(p, '01-agent-more-menu-7-items');
    await p.keyboard.press('Escape'); await sleep(300);

    // Team tab: one swarm line, its (i) and its link.
    await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'team' }), ids.outline);
    await p.waitForSelector('[data-slot=team-swarm-role]:not([hidden])', { timeout: 4000 }).catch(() => {});
    await sleep(400);
    const line = await p.$eval('[data-slot=team-swarm-role]', (e) => ({ text: e.querySelector('.sw-roleline-text')?.textContent || '', hidden: e.hidden, h: e.getBoundingClientRect().height })).catch(() => null);
    console.log('Team swarm line:', JSON.stringify(line));
    check('Team tab shows the swarm role in one line', line && !line.hidden && /Lead/.test(line.text) && /#research/.test(line.text) && line.h < 60, JSON.stringify(line));
    await snap(p, '07-team-tab-swarm-line');
    await p.locator('[data-slot=team-swarm-role] [data-slot=info-tip]').click(); await sleep(400);
    const pop2 = await p.$eval('.aui-info-pop', (e) => e.textContent).catch(() => '');
    check('Team swarm (i) lists the details', /Voted/.test(pop2) && /Follows/.test(pop2), pop2.slice(0, 120));
    await snap(p, '08-team-swarm-info-open');
    await p.keyboard.press('Escape'); await sleep(300);
    await p.locator('[data-slot=team-swarm-open]').click(); await sleep(800);
    const after = await p.evaluate(() => ({ swarm: !!document.querySelector('[data-slot=agents-swarm] [data-slot=swarm-overview]'), focus: document.querySelector('[data-slot=swarm-roles] [data-focus=true]')?.dataset.id || null, back: document.querySelector('[data-slot=swarm-back]')?.dataset.id || null, sel: document.querySelector('.sa-tabs [data-tab=swarm]')?.getAttribute('aria-selected') }));
    check('Team link opens the panel Swarm tab with this agent marked', after.swarm && after.focus === ids.outline && after.back === ids.outline && after.sel === 'true', JSON.stringify(after));
    await snap(p, '09-swarm-tab-from-agent');
    await p.locator('[data-slot=swarm-back]').click(); await sleep(700);
    check('Back chip returns to the agent Team tab', !!(await p.$('[data-slot=agent-tab-team]')));

    // Old links into an agent's swarm tabs land in the panel tab.
    await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'decisions' }), ids.draft); await sleep(700);
    check('Old agentTab: decisions link opens Swarm > Decisions', await p.$eval('[data-slot=swarm-sections] [data-section=decisions]', (e) => e.getAttribute('aria-selected')).catch(() => '') === 'true');

    // Graph: only this agent's part, plus a link to the whole team.
    await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'graph' }), ids.outline); await sleep(1200);
    const g = await p.evaluate(() => ({ own: !!document.querySelector('[data-slot=agent-graph-own]'), team: !!document.querySelector('[data-slot=agent-graph-team]'), whole: !!document.querySelector('[data-slot=agent-graph-whole]') }));
    check('Agent Graph shows only its own part, with a link to the whole team', g.own && !g.team && g.whole, JSON.stringify(g));
    await snap(p, '10-agent-graph-own-only');
    await p.locator('[data-slot=agent-graph-whole]').click(); await sleep(800);
    check('Whole-team link opens the Diagram tab', await p.$eval('.sa-tabs [data-tab=diagram]', (e) => e.getAttribute('aria-selected')).catch(() => '') === 'true');

    // Turning Swarm mode off while the tab is open falls back to Agents.
    await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'swarm' })); await sleep(600);
    await p.evaluate(async () => { window.__SA_CFG.s1features = window.__SA_CFG.s1features.filter((f) => f !== 'subagentSwarm'); await window.__agentEngine.load(true); window.__sa.emit('subagent.updated', { id: 'none' }); });
    await sleep(900);
    const t2 = await tabsOf(p);
    check('Swarm mode turned off: the Swarm tab goes away', !t2.includes('swarm'), t2.join());
    check('No page errors (swarm on)', !errs.length, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
  // ---- Swarm mode off ----
  {
    const { p, ctx, errs } = await L.open(browser, { width: W, height: H, dark, swarm: false });
    const { ids } = await L.seed(p);
    await p.evaluate(() => window.__subagents.open(window.__app)); await sleep(700);
    const tabs = await tabsOf(p);
    check('Swarm off: no Swarm tab in the Agents panel', !tabs.includes('swarm'), tabs.join());
    await snap(p, '11-agents-panel-swarm-off');
    await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'swarm' }), ids.outline); await sleep(700);
    check('Swarm off: an old swarm link falls back to the Agents tab', await p.$eval('.sa-tabs [data-tab=agents]', (e) => e.getAttribute('aria-selected')).catch(() => 'hidden') !== 'false');
    await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'team' }), ids.outline); await sleep(900);
    check('Swarm off: no swarm line on the Team tab', !(await p.$('[data-slot=team-swarm-role]:not([hidden])')));
    check('No page errors (swarm off)', !errs.length, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log(`swarm-tab: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
