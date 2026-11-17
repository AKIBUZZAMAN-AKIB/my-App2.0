// Screenshots of the sub-agent UI against the mock engine (no checks; for review and the report).
// Run: node shots-subagents.js [outDir]   (default /home/sprite/shots/subagents)
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { open, seed } = require('./subagent-advanced.js');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const OUT = process.argv[2] || '/home/sprite/shots/subagents';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
fs.mkdirSync(OUT, { recursive: true });
const shots = [];
const snap = async (p, name) => { const f = path.join(OUT, `${name}.png`); await p.screenshot({ path: f }); shots.push(f); };
const openExplorer = async (p) => { await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' })); await p.waitForSelector('[data-slot=subagent-explorer] [data-node]', { timeout: 5000 }).catch(() => {}); await sleep(600); };
const openTab = async (p, id, tab) => { await p.evaluate(([i, t]) => window.__subagents.open(window.__app, { id: i, agentTab: t }), [id, tab]); await sleep(600); };

const { seedDemo } = require('./demo-seed.js');
const jobs = {
  async explorer(browser) {
    for (const env of [{ width: 1280, height: 860 }, { width: 1280, height: 860, dark: true }, { width: 390, height: 844 }, { width: 390, height: 844, dark: true }]) {
      const tag = `${env.width}-${env.dark ? 'dark' : 'light'}`;
      const { p, ctx } = await open(browser, env);
      const { ids } = await seedDemo(p);
      await openExplorer(p);
      if (env.width >= 1000) { await p.locator('[data-slot=sa-dock-expand]').click(); await sleep(500); await p.locator('[data-slot=subagent-explorer] [aria-label="Fit to screen"], [data-slot=explorer-fit]').first().click().catch(() => {}); await sleep(400); }
      await snap(p, `01-explorer-${tag}`);
      await p.locator(`[data-slot=subagent-explorer] [data-node="${ids.draft}"]`).click();
      await sleep(500);
      await snap(p, `02-inspector-${tag}`);
      if (!env.dark || env.width === 1280) {
        const tv = p.locator('[data-slot=explorer-view-timeline]');
        if (await tv.count()) { await tv.click(); await sleep(500); await snap(p, `03-timeline-${tag}`); await p.locator('[data-slot=explorer-view-graph]').click(); await sleep(300); }
      }
      if (env.width === 1280 && !env.dark) {
        await p.locator(`[data-slot=subagent-explorer] [data-node="${ids.reviewer}"]`).dispatchEvent('click'); await sleep(400);
        const cb = p.locator('[data-slot=explorer-inspector] [data-action=compare]');
        if (await cb.count()) { await cb.click(); await sleep(500); await snap(p, '13-compare-review-1280-light'); }
      }
      await ctx.close();
    }
  },
  async panel(browser) {
    for (const env of [{ width: 1280, height: 860 }, { width: 390, height: 844, dark: true }]) {
      const tag = `${env.width}-${env.dark ? 'dark' : 'light'}`;
      const { p, ctx } = await open(browser, env);
      const { ids } = await seedDemo(p);
      await p.evaluate(() => window.__subagents.open(window.__app));
      await sleep(600);
      await snap(p, `04-panel-list-${tag}`);
      await openTab(p, ids.draft, 'overview');
      await snap(p, `05-agent-overview-${tag}`);
      if (env.width === 1280) {
        for (const t of ['settings', 'goals', 'memory', 'team', 'activity']) { await openTab(p, ids.draft, t); await snap(p, `06-agent-${t}-${tag}`); }
      }
      await ctx.close();
    }
  },
  async batch(browser) {
    for (const env of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
      const tag = `${env.width}-light`;
      const { p, ctx } = await open(browser, env);
      await seedDemo(p);
      await openExplorer(p);
      await p.locator('[data-slot=explorer-new-batch]').click();
      await sleep(400);
      const rows = p.locator('[data-slot=batch-task]');
      await rows.nth(0).fill('Draft the launch announcement for the new sync feature');
      await rows.nth(1).fill('Review the draft for accuracy and tone');
      await p.locator('[data-slot=batch-dialog] [role=radio][data-mode=review]').click().catch(() => {});
      await sleep(300);
      await snap(p, `07-batch-review-${tag}`);
      await ctx.close();
    }
  },
  async fork(browser) {
    const { send, emit } = require('./feat.js');
    const { p, ctx } = await open(browser, { width: 1280, height: 860 });
    const a = await send(p, 'Plan the launch of the new sync feature');
    const k = a?.sessionKey || (await p.evaluate(() => window.__app.chat.mainId));
    await emit(p, [['text_delta', { sessionKey: k, delta: 'Here is a plan in three steps: research, build, announce.' }], ['agent.completed', { sessionKey: k }]]);
    await sleep(500);
    await p.locator('[data-role=assistant] [aria-label="More"]').first().click();
    await sleep(300);
    await snap(p, '08-fork-menu-1280-light');
    await p.getByRole('menuitem', { name: 'Fork into sub-agent' }).click();
    await sleep(400);
    await p.locator('[data-slot=fork-dialog] textarea').first().fill('Stress-test this plan and list the three biggest risks');
    await snap(p, '09-fork-dialog-1280-light');
    await ctx.close();
  },
  async chat(browser) {
    const { p, ctx } = await open(browser, { width: 1280, height: 860 });
    const { ids } = await seedDemo(p);
    await p.evaluate((i) => window.__app.chat.openSubagent(i), ids.draft);
    await sleep(700);
    await snap(p, '10-subagent-chat-1280-light');
    const v = p.locator('[data-slot=subagent-chat-versions]');
    if (await v.count()) { await v.click(); await sleep(600); await snap(p, '11-versions-1280-light'); }
    await ctx.close();
  },
  async approvals(browser) {
    const { p, ctx } = await open(browser, { width: 1280, height: 860 });
    await p.evaluate(() => { const s = window.__sa.make({ name: 'writer', task: 'write the release notes', status: 'running' }); s.rootSessionKey = window.__app.chat.mainId; s.parentSessionKey = window.__app.chat.mainId; window.__sa.emit('subagent.started', { ...s }); window.__mock.emit('approval_request', { toolCallId: 'ap-x', toolName: 'write_file', args: { path: 'release-notes.md', content: '# v2.4' }, subagent: { id: s.id, name: 'writer' }, sessionKey: window.__app.chat.mainId }); });
    await sleep(700);
    await snap(p, '12-approvals-tray-1280-light');
    await ctx.close();
  },
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  for (const [n, fn] of Object.entries(jobs)) {
    if (ONLY && !ONLY.includes(n)) continue;
    try { await fn(browser); } catch (e) { console.log(`job ${n} failed: ${(e.stack || e.message).split('\n').slice(0, 2).join(' ')}`); }
  }
  await browser.close();
  console.log(shots.join('\n'));
})();
