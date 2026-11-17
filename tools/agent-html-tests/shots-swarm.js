// Before/after and Swarm screenshots at 1280 and 390 px, light and dark (mock data).
// Run: OUT=/home/sprite/shots-after node shots-swarm.js; before: URL_=file://<old agent.html> PREFIX=before node shots-swarm.js
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { open: openChain, makeChain, EXE } = require('./subagent-graph-fixes.js');
const L = require('./subagent-swarm-explorer.js');
const OUT = process.env.OUT || path.join(require('os').tmpdir(), 'agent-html-shots', 'swarm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = [[1280, 900, false], [1280, 900, true], [390, 844, false], [390, 844, true]];
const tag = (w, dark) => `${w}-${dark ? 'dark' : 'light'}`;

async function agentView(browser, url, prefix) {
  for (const [w, hgt, dark] of SIZES) {
    const { p, ctx } = await openChain(browser, { w, hgt });
    if (dark) await p.evaluate(() => document.documentElement.classList.add('dark'));
    const ids = await makeChain(p, { finish: false });
    await p.evaluate((x) => window.__sa.finish(x.c, 'LEVEL3-OK written to deep3.txt'), ids);
    await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'overview' }), ids.b);
    await sleep(700);
    const ex = p.locator('[data-slot=sa-dock-expand]');
    if (w >= 1000 && await ex.isVisible().catch(() => false)) { await ex.click(); await sleep(700); }
    await p.screenshot({ path: `${OUT}/${prefix}-agent-view-${tag(w, dark)}.png` });
    console.log('wrote', `${prefix}-agent-view-${tag(w, dark)}`);
    await ctx.close();
  }
}

async function swarm(browser) {
  for (const [w, hgt, dark] of SIZES) {
    const { p, ctx } = await L.open(browser, { width: w, height: hgt, dark });
    const { ids } = await L.seed(p);
    await L.rule(p, 'polish', 'web-scout', false); await L.rule(p, 'writer', 'draft', true, true);
    const go = async (t) => {
      await p.evaluate(([i, tb]) => window.__subagents.open(window.__app, { id: i, agentTab: tb }), [ids.draft, t]);
      await sleep(600);
      const ex = p.locator('[data-slot=sa-dock-expand]');
      if (w >= 1000 && await ex.isVisible().catch(() => false)) { await ex.click(); await sleep(600); }
    };
    for (const [t, name] of [['swarm', 'swarm-overview'], ['topics', 'topics'], ['board', 'blackboard'], ['decisions', 'decisions']]) {
      await go(t);
      await p.screenshot({ path: `${OUT}/${name}-${tag(w, dark)}.png` }); console.log('wrote', `${name}-${tag(w, dark)}`);
    }
    await go('swarm');
    await p.locator('[data-slot=swarm-configure]').click(); await sleep(700);
    await p.screenshot({ path: `${OUT}/settings-sheet-${tag(w, dark)}.png` }); console.log('wrote', `settings-sheet-${tag(w, dark)}`);
    await p.keyboard.press('Escape'); await sleep(300);
    await L.openExplorer(p);
    const ex = p.locator('[data-slot=sa-dock-expand]');
    if (w >= 1000 && await ex.isVisible().catch(() => false)) { await ex.click(); await sleep(600); }
    await p.locator('[data-slot=explorer-fit]').click(); await sleep(500);
    await p.screenshot({ path: `${OUT}/explorer-swarm-${tag(w, dark)}.png` }); console.log('wrote', `explorer-swarm-${tag(w, dark)}`);
    if (w >= 1000 && !dark) {
      await p.locator('[data-slot=explorer-draw-rule]').click(); await sleep(200);
      await p.locator(`[data-node="${ids.polish}"]`).click(); await sleep(150);
      await p.locator(`[data-node="${ids.writer}"]`).click(); await sleep(500);
      await p.screenshot({ path: `${OUT}/explorer-draw-rule-${tag(w, dark)}.png` }); console.log('wrote', `explorer-draw-rule-${tag(w, dark)}`);
    }
    await ctx.close();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE });
  // URL_ picks the build (subagent-graph-fixes reads it); PREFIX=before with the old build takes only the agent view.
  await agentView(browser, null, process.env.PREFIX || 'after');
  if (!process.env.PREFIX) await swarm(browser);
  await browser.close();
})();
