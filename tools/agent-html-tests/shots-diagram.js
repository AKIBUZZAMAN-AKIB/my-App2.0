// Diagram tab (agent graph on the Explorer canvas): phone screenshots + live / drag / peek checks.
// Phone screenshots of the Agents panel exactly as the Android build ships it: agent.html with the
// shared shell (bottom bar + runtime) injected the way scripts/prepare-web.mjs does, and the real
// system-bar insets that MainActivity publishes as --safe-area-inset-* (status bar on top, gesture
// bar at the bottom). Also checks that nothing in the panel sits under the status bar, under the
// composer or under the bottom bar, and that a long line scrolls on its own, not the whole page.
//   node tools/agent-html-tests/shots-phone-shell.js [outDir]   (DARK=1, TOP=32, BOTTOM=24)
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const OUT = process.argv[2] || '/tmp/diagram-shots';
const TOP = Number(process.env.TOP || 32);
const BOTTOM = Number(process.env.BOTTOM || 24);
const DARK = process.env.DARK !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const ROOT = path.resolve(__dirname, '../..');
const STAGE = path.join(require('os').tmpdir(), 'agent-diagram-stage');
fs.mkdirSync(OUT, { recursive: true });

// Stage www/ with the shell tags, like prepare-web.mjs (no bridge/CSP: the mock is the bridge).
fs.rmSync(STAGE, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'www'), STAGE, { recursive: true });
const NAV_TAGS = [
  '<script src="./shell/theme-boot.js" data-myapp-nav></script>',
  '<link rel="stylesheet" href="./shell/runtime.css" data-myapp-nav>',
  '<link rel="stylesheet" href="./shell/nav.css" data-myapp-nav>',
  '<link rel="stylesheet" href="./shell/controls.css" data-myapp-nav>',
  '<script defer src="./shell/controls.js" data-myapp-nav></script>',
  '<script defer src="./shell/runtime.js" data-myapp-nav></script>',
  '<script defer src="./shell/nav.js" data-myapp-nav></script>',
].join('\n    ');
const agentFile = path.join(STAGE, 'agent.html');
fs.writeFileSync(agentFile, fs.readFileSync(agentFile, 'utf8').replace(/<\/head>/i, `    ${NAV_TAGS}\n  </head>`));
const URL_ = 'file://' + agentFile;

const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${detail}`}`);

async function open(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: DARK ? 'dark' : 'light' });
  await ctx.addInitScript((f) => { window.__SA_CFG = { s1features: f }; window.__MEM_CFG = { goals: true }; }, ['subagentQueue', 'subagentData', 'subagentReuse', 'crossSession', 'subagentGraph', 'subagentTeam', 'subagentChatAllow', 'subagentAdvanced']);
  for (const f of ['mock3.js', 'mock-v2.js', 'mock-subagents.js', 'mock-memory.js']) await ctx.addInitScript({ content: read(f) });
  if (process.env.MODE === 'dialog') await ctx.addInitScript(() => { try { localStorage.setItem('agent.subagents.openIn.v1', 'dialog'); } catch {} });
  // What MainActivity does on a real phone: publish the system-bar insets on <html>.
  await ctx.addInitScript(([t, b]) => {
    const set = () => { const s = document.documentElement.style; s.setProperty('--safe-area-inset-top', t + 'px'); s.setProperty('--safe-area-inset-bottom', b + 'px'); s.setProperty('--safe-area-inset-left', '0px'); s.setProperty('--safe-area-inset-right', '0px'); };
    if (document.documentElement) set(); else document.addEventListener('readystatechange', set, { once: true });
  }, [TOP, BOTTOM]);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 2).join(' <- ')));
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 10000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => { if (window.__sa) window.__sa.mainKey = window.__app.chat.mainId; });
  await sleep(400);
  return { p, ctx, errs };
}

/** Draws the phone's status bar and gesture bar over the screenshot area so the picture reads like the phone. */
const paintSystemBars = (p) => p.evaluate(([t, b]) => {
  for (const [id, css] of [['__sb_top', `top:0;height:${t}px`], ['__sb_bot', `bottom:0;height:${b}px`]]) {
    if (document.getElementById(id)) continue;
    const d = document.createElement('div'); d.id = id;
    d.style.cssText = `position:fixed;left:0;right:0;${css};z-index:2147483647;pointer-events:none;background:rgba(0,0,0,.55);color:#fff;font:600 12px system-ui;display:flex;align-items:center;justify-content:space-between;padding:0 16px`;
    if (id === '__sb_top') d.innerHTML = '<span>5:43</span><span>\u25CF \u25B2 \u25AE 85%</span>'; else d.innerHTML = '<span style="margin:auto;width:110px;height:4px;border-radius:2px;background:#fff"></span>';
    document.body.appendChild(d);
  }
}, [TOP, BOTTOM]);

const snap = async (p, name) => { await paintSystemBars(p); const f = path.join(OUT, `${name}.png`); await p.screenshot({ path: f }); console.log('shot', f); };


(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const { seedDemo } = require('./demo-seed.js');
  const { p, errs } = await open(browser);
  const { ids } = await seedDemo(p);
  const sfx = DARK ? 'dark' : 'light';
  const nodes = () => p.evaluate(() => [...document.querySelectorAll('[data-slot="diagram-graph"] [data-node]')].map((n) => n.dataset.node));
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' })); await sleep(900);
  await snap(p, `20-explorer-${sfx}`);
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' })); await sleep(900);
  check('diagram: graph canvas (not Mermaid, not list) renders', await p.evaluate(() => !!document.querySelector('[data-slot="diagram-graph"] svg.sa-x-svg') && !document.querySelector('.sa-dialog .mermaid, .sa-dialog [data-mermaid]')));
  const n0 = await nodes();
  check('diagram: main + sub-agent nodes drawn', n0.length > 3, String(n0.length));
  check('diagram: edges drawn', await p.evaluate(() => document.querySelectorAll('[data-slot="diagram-graph"] .sa-x-edge, [data-slot="diagram-graph"] [data-edge]').length > 0));
  await snap(p, `21-diagram-${sfx}`);
  if (process.env.FITALL) { await p.evaluate(() => window.__diagramGraph.fit(true)); await sleep(300); await snap(p, `21b-diagram-fitall-${sfx}`); await p.evaluate(() => window.__diagramGraph.toggleOrient?.()); }
  // Scroll down to show activity under the graph.
  await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); const sc = [...d.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)); sc.forEach((e) => { e.scrollTop = e.scrollHeight; }); });
  await sleep(300); await snap(p, `22-diagram-activity-${sfx}`);
  await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); [...d.querySelectorAll('*')].forEach((e) => { e.scrollTop = 0; }); });
  await sleep(200);
  // Tap a sub-agent: the peek card.
  // A sub-agent card whose middle is really on screen (not under the zoom buttons or off the canvas).
  const { target, box } = await p.evaluate(() => {
    for (const n of document.querySelectorAll('[data-slot="diagram-graph"] [data-node]')) {
      if (n.dataset.main === 'true') continue;
      const r = n.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (document.elementFromPoint(x, y)?.closest('[data-node]') === n) return { target: n.dataset.node, box: { x, y } };
    }
    return {};
  });
  await p.mouse.click(box.x, box.y); await sleep(400);
  check('diagram: tapping a node opens the peek card', await p.evaluate(() => { const e = document.querySelector('[data-slot="diagram-peek"]'); return !!e && !e.hidden && !!e.querySelector('[data-slot="diagram-peek-open"]'); }));
  await snap(p, `23-diagram-peek-${sfx}`);
  await p.evaluate(() => document.querySelector('[data-slot="diagram-peek-close"]')?.click()); await sleep(200);
  // Drag that node somewhere else.
  const before = await p.evaluate((id) => document.querySelector(`[data-slot="diagram-graph"] [data-node="${CSS.escape(id)}"]`).getAttribute('transform'), target);
  await p.mouse.move(box.x, box.y); await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(box.x - i * 6, box.y + i * 14); await sleep(16); } await p.mouse.up(); await sleep(300);
  const after = await p.evaluate((id) => document.querySelector(`[data-slot="diagram-graph"] [data-node="${CSS.escape(id)}"]`).getAttribute('transform'), target);
  check('diagram: a node can be dragged to a new place', before !== after, `${before} -> ${after}`);
  check('diagram: Reset layout appears after a drag', await p.evaluate(() => !document.querySelector('[data-slot="diagram-reset-layout"]').hidden));
  await snap(p, `24-diagram-dragged-${sfx}`);
  await p.evaluate(() => document.querySelector('[data-slot="diagram-reset-layout"]').click()); await sleep(300);
  check('diagram: Reset layout puts it back', await p.evaluate(([id, t]) => document.querySelector(`[data-slot="diagram-graph"] [data-node="${CSS.escape(id)}"]`).getAttribute('transform') === t, [target, before]));
  // Live: a new sub-agent appears, then its status change shows.
  const liveId = await p.evaluate(() => {
    const k = window.__app.chat.mainId; const now = Date.now();
    const parent = window.__subagents.recordsOf()[0];
    const s = window.__sa.make({ name: 'fact-checker', task: 'Check every source in the draft', status: 'running', depth: 2, createdAt: now });
    Object.assign(s, { parentId: parent.id, parentSessionKey: parent.sessionKey || k, rootSessionKey: k, startedAt: now, totalTokens: 2400, steps: 2 });
    s.title = 'Fact-check sources';
    window.__sa.emit('subagent.started', { ...s });
    return s.id;
  });
  await sleep(300);
  check('diagram: a new sub-agent appears live', (await nodes()).includes(liveId));
  await p.evaluate((id) => { const r = window.__subagents.recordsOf().find((x) => x.id === id); window.__sa.emit('subagent.finished', { ...r, status: 'finished', finishedAt: Date.now() }); }, liveId);
  await sleep(250);
  check('diagram: status change shows live (green + flash)', await p.evaluate((id) => { const n = document.querySelector(`[data-slot="diagram-graph"] [data-node="${CSS.escape(id)}"]`); return n?.dataset.status === 'finished'; }, liveId));
  // Search.
  await p.fill('[data-slot="diagram-graph"] .sa-x-search', 'pric'); await sleep(350);
  check('diagram: search highlights a match', await p.evaluate(() => document.querySelectorAll('[data-slot="diagram-graph"] [data-match="true"]').length > 0));
  await snap(p, `25-diagram-search-${sfx}`);
  await p.fill('[data-slot="diagram-graph"] .sa-x-search', ''); await sleep(250);
  // List mode still there.
  await p.evaluate(() => document.querySelector('[data-slot="diagram-mode-list"]').click()); await sleep(300);
  check('diagram: List mode shows the native tree', await p.evaluate(() => document.querySelectorAll('.at-tree .at-node').length > 1));
  await snap(p, `26-diagram-list-${sfx}`);
  await p.evaluate(() => document.querySelector('[data-slot="diagram-mode-graph"]').click()); await sleep(300);
  // Tab away and back: graph is mounted again.
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'agents' })); await sleep(300);
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' })); await sleep(500);
  check('diagram: graph comes back after switching tabs', (await nodes()).length > 3);
  // Nothing sticks out sideways.
  check('diagram: page does not scroll sideways', await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1));
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
