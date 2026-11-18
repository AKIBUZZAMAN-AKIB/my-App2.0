// Screenshots of the opened sub-agent's header and tabs (docked panel and Open as chat),
// at 390 and 1280 px, light and dark. Not a test: run it before and after a header change.
// Run: OUT=/tmp/shots PREFIX=after node tools/agent-html-tests/shot-subagent-header.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('./pw.js');
const { sleep } = require('./feat.js');
const { open, makeChain, EXE } = require('./subagent-graph-fixes.js');

const OUT = process.env.OUT || '/tmp/subagent-header-shots';
const PREFIX = process.env.PREFIX || 'shot';

async function shoot(browser, w, dark) {
  const tag = `${w}-${dark ? 'dark' : 'light'}`;
  const { p, ctx } = await open(browser, { w, hgt: 844 });
  if (dark) await p.evaluate(() => document.documentElement.classList.add('dark'));
  const ids = await makeChain(p, { finish: false });
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), ids.b);
  await sleep(700);
  const clip = await p.evaluate(() => {
    const panel = document.querySelector('.dialog.sa-dialog');
    const tabs = document.querySelector('[data-slot="agent-view-tabs"]');
    const pr = panel.getBoundingClientRect();
    const bottom = tabs ? tabs.getBoundingClientRect().bottom + 16 : pr.top + 220;
    return { x: Math.max(0, pr.left), y: Math.max(0, pr.top), width: Math.min(pr.width, document.documentElement.clientWidth - Math.max(0, pr.left)), height: Math.min(360, bottom - Math.max(0, pr.top)) };
  });
  await p.screenshot({ path: path.join(OUT, `${PREFIX}-panel-${tag}.png`), clip });
  const openBtn = await p.$('[data-slot="agent-header"] [data-slot="subagent-open-chat"]');
  if (openBtn) {
    await openBtn.click();
    await sleep(800);
    const c2 = await p.evaluate(() => {
      const head = document.querySelector('[data-slot="subagent-chat-head-row"]');
      if (!head) return null;
      const r = head.getBoundingClientRect();
      return { x: 0, y: Math.max(0, r.top - 12), width: document.documentElement.clientWidth, height: Math.min(200, r.height + 140) };
    });
    if (c2) await p.screenshot({ path: path.join(OUT, `${PREFIX}-openchat-${tag}.png`), clip: c2 });
  }
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE || undefined });
  for (const w of [390, 1280]) for (const dark of [false, true]) await shoot(browser, w, dark);
  await browser.close();
  console.log(fs.readdirSync(OUT).filter((f) => f.startsWith(PREFIX)).join('\n'));
})();
