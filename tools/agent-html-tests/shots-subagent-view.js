// Before/after screenshots of the sub-agent view (header, Overview, Chat with multi-select, the ··· menu)
// at 390 and 1280 px, light and dark, from mock data.
// Run: OUT=/home/sprite/shots-view PREFIX=after node shots-subagent-view.js
//      URL_=file://<old agent.html> PREFIX=before OUT=... node shots-subagent-view.js
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { open, makeChain, EXE } = require('./subagent-graph-fixes.js');

const OUT = process.env.OUT || path.join(require('os').tmpdir(), 'agent-html-shots', 'subagent-view');
const PREFIX = process.env.PREFIX || 'after';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = [[390, 844, false], [390, 844, true], [1280, 900, false], [1280, 900, true]];

const seed = (p, id) => p.evaluate((x) => {
  window.__sa.transcripts.set(x, [
    { role: 'user', content: 'Find the three best sources on grid-scale solar storage costs.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Found three: the NREL Annual Technology Baseline, the IEA Batteries report and the Lazard LCOS study.' }] },
    { role: 'user', content: 'Now compare their numbers for 4-hour systems.' },
    { role: 'assistant', content: [{ type: 'text', text: '**4-hour systems, 2025:**\n\n- NREL: $250 per kWh\n- IEA: $280 per kWh\n- Lazard: $265 per kWh\n\nThe gap is mostly cell prices and what each counts as balance of system.' }] },
  ]);
}, id);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE || undefined });
  for (const [w, hgt, dark] of SIZES) {
    const t = `${w}-${dark ? 'dark' : 'light'}`;
    const { p, ctx } = await open(browser, { w, hgt });
    if (dark) await p.evaluate(() => document.documentElement.classList.add('dark'));
    const ids = await makeChain(p, { finish: false });
    await seed(p, ids.b);
    await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'overview' }), ids.b);
    await sleep(700);
    const ex = p.locator('[data-slot=sa-dock-expand]');
    if (w >= 1000 && await ex.isVisible().catch(() => false)) { await ex.click(); await sleep(700); }
    const shot = async (name) => { await p.screenshot({ path: `${OUT}/${PREFIX}-${name}-${t}.png` }); console.log('wrote', `${PREFIX}-${name}-${t}`); };
    await shot('overview');
    // Chat tab, then multi-select (after) or Pick parts (before).
    await p.click('[data-slot="agent-view-tabs"] [data-tab="chat"]').catch(() => null);
    await sleep(500);
    const msgs = p.locator('.sa-chat > li[data-sel-key]');
    if (await msgs.count()) {
      const pt = await msgs.nth(1).evaluate((el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 12 }; });
      await p.mouse.move(pt.x, pt.y); await p.mouse.down(); await sleep(650); await p.mouse.up(); await sleep(150);
      await msgs.nth(3).click();
      await sleep(300);
      await p.evaluate(() => document.querySelector('[data-slot="msel-bar"]:not([hidden])')?.scrollIntoView({ block: 'end' }));
      await sleep(200);
      await shot('chat-select');
      await p.keyboard.press('Escape');
    } else {
      const pick = p.locator('button:has-text("Pick parts")').first();
      if (await pick.count()) { await pick.click().catch(() => null); await sleep(300); }
      await shot('chat-select');
    }
    await sleep(200);
    await p.click('[data-slot="subagent-more"]').catch(() => null);
    await sleep(400);
    await shot('menu');
    await ctx.close();
  }
  await browser.close();
})();
