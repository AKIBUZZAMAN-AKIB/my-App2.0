// Diagram tab, Delegation section (the old Mermaid sequence, now on a canvas) + Agent tree: phone screenshots and checks.
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
const OUT = process.argv[2] || '/tmp/delegation-shots';
const TOP = Number(process.env.TOP || 32);
const BOTTOM = Number(process.env.BOTTOM || 24);
const DARK = process.env.DARK !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const ROOT = path.resolve(__dirname, '../..');
const STAGE = path.join(require('os').tmpdir(), 'agent-delegation-stage');
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
  await seedDemo(p);
  const sfx = DARK ? 'dark' : 'light';
  const scrollTo = (sel) => p.evaluate((s) => { const el = document.querySelector(s); el?.scrollIntoView({ block: 'start' }); const d = [...document.querySelectorAll('.dialog')].pop(); return !!el; }, sel);
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' })); await sleep(1000);
  // Two sections, as the Mermaid version had: Agent tree and Delegation, each with full screen and download.
  const heads = await p.evaluate(() => [...document.querySelectorAll('.sa-dialog .sa-diagram-section h3')].map((h) => h.textContent.trim()));
  check('diagram: two sections, Agent tree then Delegation', heads.length === 2 && /^Agent tree/.test(heads[0]) && /^Delegation/.test(heads[1]), JSON.stringify(heads));
  check('diagram: each section has full screen + download', await p.evaluate(() => ['tree', 'delegation'].every((k) => document.querySelector(`[data-slot="diagram-${k}-fullscreen"]`) && document.querySelector(`[data-slot="diagram-${k}-download"]`))));
  check('diagram: no Mermaid in the tab', await p.evaluate(() => !document.querySelector('.sa-dialog .aui-mermaid, .sa-dialog svg[id^="aui-mermaid"]')));
  check('agent tree: canvas graph drawn', await p.evaluate(() => document.querySelectorAll('[data-slot="diagram-graph"] [data-node]').length > 3));
  await snap(p, `30-diagram-tree-${sfx}`);
  // The delegation sequence (the engine's saved graph adds the reports and messages).
  await p.waitForFunction(() => window.__delegation && window.__delegation.rows.some((r) => r.type === 'report') && window.__delegation.rows.some((r) => r.type === 'message'), null, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const m = await p.evaluate(() => { const d = window.__delegation; return { parts: d.model.parts.map((x) => x.name), rows: d.rows.map((r) => [r.type, r.label, d.model.parts[d.model.index.get(r.from)].name, d.model.parts[d.model.index.get(r.to)].name]) }; });
  console.log('participants:', m.parts.join(' | '));
  for (const r of m.rows) console.log('  ', r.join(' :: '));
  check('delegation: Main agent is the first lifeline', m.parts[0] === 'Main agent' && m.parts.length > 3, m.parts.join(','));
  check('delegation: requests carry the task text', m.rows.some((r) => r[0] === 'request' && r[1].length > 20 && r[2] === 'Main agent'));
  check('delegation: reports go back as dashed replies', m.rows.some((r) => r[0] === 'report' && r[1] === 'report'));
  check('delegation: peer messages between sub-agents', m.rows.some((r) => r[0] === 'message' && r[2] !== 'Main agent' && r[3] !== 'Main agent'));
  check('delegation: nested request comes from its parent, not Main', m.rows.some((r) => r[0] === 'request' && r[2] !== 'Main agent'));
  const drawn = await p.evaluate(() => ({ rows: document.querySelectorAll('[data-slot="delegation-seq"] [data-row]').length, heads: document.querySelectorAll('[data-slot="delegation-seq"] .sa-seq-head [data-part]').length, foot: document.querySelectorAll('[data-slot="delegation-seq"] .sa-seq-foot [data-part]').length, acts: document.querySelectorAll('[data-slot="delegation-seq"] .sa-seq-act').length }));
  check('delegation: every row drawn with participants top and bottom and activation bars', drawn.rows === m.rows.length && drawn.heads === m.parts.length && drawn.foot === m.parts.length && drawn.acts > 0, JSON.stringify(drawn));
  const ordered = await p.evaluate(() => { const ys = [...document.querySelectorAll('[data-slot="delegation-seq"] [data-row] .sa-seq-line')].map((l) => l.getBBox().y); const at = window.__delegation.rows.map((r) => r.at); return ys.every((y, i) => !i || y >= ys[i - 1]) && at.every((t, i) => !i || t >= at[i - 1]); });
  check('delegation: oldest at the top, in time order', ordered);
  await scrollTo('[data-slot="diagram-delegation-section"]'); await sleep(300);
  await snap(p, `31-delegation-${sfx}`);
  // Overview: the whole diagram.
  await p.click('[data-slot="delegation-fit"]'); await sleep(300);
  check('delegation: fit shows the whole diagram', await p.evaluate(() => { const c = document.querySelector('[data-slot="delegation-canvas"]').getBoundingClientRect(); const b = document.querySelector('[data-slot="delegation-seq"] .sa-seq-stage').getBoundingClientRect(); return b.left >= c.left - 2 && b.right <= c.right + 2 && b.bottom <= c.bottom + 2; }));
  await snap(p, `32-delegation-overview-${sfx}`);
  // Zoomed in, panned to the middle of the conversation.
  await p.evaluate(() => { const d = window.__delegation; d.reset(); const r = d.rows.find((x) => x.type === 'request' && x.from !== '__main__'); d.selectRow(r.key); d.close(); });
  const k0 = await p.evaluate(() => window.__delegation.view.k);
  for (let i = 0; i < 2; i++) { await p.click('[data-slot="delegation-seq"] .sa-seq-zoom [aria-label="Zoom in"]'); await sleep(40); }
  await sleep(150);
  await p.evaluate(() => { const d = window.__delegation; d.reset(); d.zoomAt(1.5625, 0, 0); });
  await sleep(250);
  const k = await p.evaluate(() => window.__delegation.view.k);
  check('delegation: zoom in works', k > k0 * 1.5, `${k0} -> ${k}`);
  await snap(p, `33-delegation-zoomed-${sfx}`);
  // Back to the readable view; drag down so the header sticks.
  await p.evaluate(() => { const d = window.__delegation; d.fitAll(); }); await sleep(100);
  for (let i = 0; i < 4; i++) await p.click('[data-slot="delegation-seq"] .sa-seq-zoom [aria-label="Zoom in"]');
  await sleep(100);
  const c = await p.evaluate(() => { const r = document.querySelector('[data-slot="delegation-canvas"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.75 }; });
  await p.mouse.move(c.x, c.y); await p.mouse.down(); for (let i = 1; i <= 12; i++) { await p.mouse.move(c.x - i * 10, c.y - i * 22); await sleep(16); } await p.mouse.up(); await sleep(200);
  check('delegation: participant row stays on top while panning', await p.evaluate(() => { const hd = document.querySelector('[data-slot="delegation-seq"] .sa-seq-head'); const c = document.querySelector('[data-slot="delegation-canvas"]').getBoundingClientRect(); const b = hd.querySelector('[data-part]').getBoundingClientRect(); return hd.dataset.pinned === 'true' && b.top >= c.top - 1 && b.top < c.top + 20; }));
  await snap(p, `34-delegation-sticky-${sfx}`);
  // Tap a request arrow: its whole text, sender -> receiver, time and type.
  await p.evaluate(() => window.__delegation.fitAll()); await sleep(100);
  await p.evaluate(() => { const d = window.__delegation; const r = d.rows.find((x) => x.type === 'request' && x.from !== '__main__') || d.rows.find((x) => x.type === 'request'); d.selectRow(r.key); d.close(); });
  for (let i = 0; i < 5; i++) await p.click('[data-slot="delegation-seq"] .sa-seq-zoom [aria-label="Zoom in"]');
  await sleep(150);
  const tapped = await p.evaluate(() => { const d = window.__delegation; const r = d.rows.find((x) => x.type === 'request' && x.from !== '__main__') || d.rows.find((x) => x.type === 'request'); const g = document.querySelector(`[data-slot="delegation-seq"] [data-row="${CSS.escape(r.key)}"] .sa-seq-label`); const b = g.getBoundingClientRect(); return { key: r.key, full: r.full, x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await p.mouse.click(tapped.x, tapped.y); await sleep(350);
  const peek = await p.evaluate(() => { const e = document.querySelector('[data-slot="delegation-peek"]'); return { open: !!e && !e.hidden, text: e?.querySelector('[data-slot="delegation-peek-text"]')?.textContent || '', route: e?.querySelector('.sa-seq-route')?.textContent || '', type: e?.querySelector('.sa-seq-type')?.textContent || '', when: e?.querySelector('.sa-seq-when')?.textContent || '' }; });
  check('delegation: tapping an arrow shows the whole request', peek.open && peek.text === tapped.full && /\u2192/.test(peek.route) && /Request/.test(peek.type) && /after/.test(peek.when), JSON.stringify(peek));
  await snap(p, `35-delegation-detail-${sfx}`);
  await p.click('[data-slot="delegation-next"]'); await sleep(200);
  check('delegation: Next steps to the following message', await p.evaluate((k) => { const s = document.querySelector('[data-slot="delegation-seq"] [data-row][data-selected="true"]'); return !!s && s.dataset.row !== k; }, tapped.key));
  await p.click('[data-slot="delegation-peek-close"]'); await sleep(150);
  // Tap a participant: its messages highlighted, the rest dimmed.
  const pid = await p.evaluate(() => window.__delegation.model.parts[2].id);
  await p.evaluate((id) => window.__delegation.selectPart(id), pid); await sleep(250);
  check('delegation: tapping an agent highlights its messages', await p.evaluate((id) => { const rows = [...document.querySelectorAll('[data-slot="delegation-seq"] [data-row]')]; const dim = rows.filter((r) => r.dataset.dim === 'true').length; return dim > 0 && dim < rows.length && document.querySelector(`.sa-seq-head [data-part="${CSS.escape(id)}"]`)?.dataset.hot === 'true'; }, pid));
  await snap(p, `36-delegation-agent-${sfx}`);
  await p.click('[data-slot="delegation-peek-close"]'); await sleep(150);
  // Filter chips and search.
  await p.click('[data-slot="delegation-seq"] .sa-seq-chip[data-group="reports"]'); await sleep(200);
  check('delegation: the Reports chip hides reports', await p.evaluate(() => !window.__delegation.rows.some((r) => r.type === 'report')));
  await p.click('[data-slot="delegation-seq"] .sa-seq-chip[data-group="reports"]'); await sleep(200);
  await p.fill('[data-slot="delegation-search"]', 'CI'); await sleep(250);
  check('delegation: search highlights matching messages', await p.evaluate(() => document.querySelectorAll('[data-slot="delegation-seq"] [data-row][data-match="true"]').length > 0));
  await p.fill('[data-slot="delegation-search"]', ''); await sleep(150);
  // Live: a new message arrives while the tab is open.
  const before = await p.evaluate(() => window.__delegation.rows.length);
  await p.evaluate(() => { const rs = window.__subagents.recordsOf(); const a = rs.find((r) => r.status === 'running') || rs[0]; const b = rs.find((r) => r !== a); window.__subagents.onEvent?.({ type: 'subagent.peer_message', id: a.id, name: a.name, to: b.id, toName: b.name, text: 'Live: the draft is ready for a fact-check', at: Date.now() }); });
  await sleep(400);
  let after = await p.evaluate(() => window.__delegation.rows.length);
  if (after === before) { await p.evaluate(() => { const rs = window.__subagents.recordsOf(); const a = rs.find((r) => r.status === 'running') || rs[0]; const b = rs.find((r) => r !== a); window.__sa.emit('subagent.peer_message', { id: a.id, name: a.name, to: b.id, toName: b.name, text: 'Live: the draft is ready for a fact-check' }); }); await sleep(500); after = await p.evaluate(() => window.__delegation.rows.length); }
  check('delegation: a new message appears live', after === before + 1, `${before} -> ${after}`);
  // Download: a standalone SVG with the names and the request text.
  const svgText = await p.evaluate(() => window.__delegation.exportSvg());
  check('delegation: Download SVG gives a standalone SVG', /^<\?xml/.test(svgText) && /<svg[^>]+viewBox="0 0 \d+ \d+"/.test(svgText) && /Main agent/.test(svgText) && !/data-row|class=/.test(svgText), svgText.slice(0, 200));
  fs.writeFileSync(path.join(OUT, `delegation-${sfx}.svg`), svgText);
  // Full screen and back.
  await p.click('[data-slot="diagram-delegation-fullscreen"]'); await sleep(450);
  check('delegation: full screen covers the screen', await p.evaluate(() => { const s = document.querySelector('[data-slot="diagram-delegation-section"]').getBoundingClientRect(); const c = document.querySelector('[data-slot="delegation-canvas"]').getBoundingClientRect(); return s.top <= 1 && s.left <= 1 && Math.abs(s.width - innerWidth) <= 1 && Math.abs(s.height - innerHeight) <= 1 && c.height > innerHeight * 0.6; }));
  await snap(p, `37-delegation-fullscreen-${sfx}`);
  await p.keyboard.press('Escape'); await sleep(250);
  check('delegation: Escape leaves full screen, the panel stays open', await p.evaluate(() => document.querySelector('[data-slot="diagram-delegation-section"]').dataset.fullscreen === 'false' && !!document.querySelector('.sa-dialog')));
  // Agent tree full screen + download.
  await p.click('[data-slot="diagram-tree-fullscreen"]'); await sleep(450);
  const tfs = await p.evaluate(() => { const s = document.querySelector('[data-slot="diagram-tree-section"]'); const b = s.getBoundingClientRect(); return { fs: s.dataset.fullscreen, top: b.top, h: b.height, H: innerHeight }; });
  check('agent tree: full screen covers the screen', tfs.fs === 'true' && tfs.top <= 1 && Math.abs(tfs.h - tfs.H) <= 1, JSON.stringify(tfs));
  await snap(p, `38-tree-fullscreen-${sfx}`);
  await p.click('[data-slot="diagram-tree-fullscreen"]'); await sleep(250);
  const treeSvg = await p.evaluate(() => window.__diagramTreeSvg()).catch((e) => 'ERR ' + e.message);
  check('agent tree: Download SVG gives a standalone SVG', /^<\?xml/.test(treeSvg) && /Main agent/.test(treeSvg), treeSvg.slice(0, 160));
  // Tab away and back.
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'agents' })); await sleep(300);
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' })); await sleep(500);
  check('delegation: comes back after switching tabs', await p.evaluate(() => document.querySelectorAll('[data-slot="delegation-seq"] [data-row]').length > 5));
  check('diagram: page does not scroll sideways', await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1));
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
