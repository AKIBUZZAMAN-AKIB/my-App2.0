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
const OUT = process.argv[2] || '/tmp/phone-shots';
const TOP = Number(process.env.TOP || 32);
const BOTTOM = Number(process.env.BOTTOM || 24);
const DARK = process.env.DARK !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const ROOT = path.resolve(__dirname, '../..');
const STAGE = path.join(require('os').tmpdir(), 'agent-phone-stage');
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

/** Where the open sheet sits against the status bar, the composer and the bottom bar. */
const sheetFit = (p) => p.evaluate((top) => {
  const vis = (e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const dlg = [...document.querySelectorAll('.dialog')].filter(vis).pop();
  if (!dlg) return { none: true };
  const r = dlg.getBoundingClientRect();
  const title = [...dlg.querySelectorAll('.dialog-title, .sa-dhead, h2, header')].find((e) => e.getClientRects().length);
  const tr = title ? title.getBoundingClientRect() : r;
  const close = [...dlg.querySelectorAll('[aria-label=Close], .dialog-close')].find((e) => e.getClientRects().length);
  const cr = close ? close.getBoundingClientRect() : r;
  // Is anything painted ON TOP of the sheet's bottom part (composer, bar)?
  const xs = [r.left + 20, r.left + r.width / 2, r.right - 20];
  const covered = [];
  for (const y of [r.bottom - 6, r.bottom - 30, r.bottom - 60]) for (const x of xs) {
    const el = document.elementFromPoint(x, y);
    if (el && !dlg.contains(el) && !String(el.id).startsWith('__sb')) covered.push((el.className && String(el.className).slice(0, 40)) || el.tagName);
  }
  const bar = document.querySelector('.mn-bar, [data-myapp-nav-bar], nav.mn-nav, .mn-nav');
  const br = bar && vis(bar) ? bar.getBoundingClientRect() : null;
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), titleTop: Math.round(tr.top), closeTop: Math.round(cr.top), barTop: br ? Math.round(br.top) : null, innerH: innerHeight, covered: [...new Set(covered)], pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
}, TOP);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const { seedDemo } = require('./demo-seed.js');
  const { p, errs } = await open(browser);
  const { ids } = await seedDemo(p);
  // A sub-agent like the user's "bob", with the long things that used to break out of the cards.
  ids.bob = await p.evaluate(() => {
    const k = window.__app.chat.mainId; const now = Date.now();
    const s = window.__sa.make({ name: 'bob', task: 'You are Bob, a scientist, in a discussion on "What makes us human" with Charlie (an artist) and Alice (a philosopher). Read /data/user/0/com.myapp.suite/files/agent/workspace/discussions/what-makes-us-human/round-03/charlie-statement-final-v2.md and respond.', status: 'finished', depth: 1, createdAt: now - 90000 });
    Object.assign(s, { parentId: null, parentSessionKey: k, rootSessionKey: k, model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free', startedAt: now - 90000, finishedAt: now - 30000, durationMs: 60000, inputTokens: 13000, outputTokens: 3700, totalTokens: 16700, steps: 4, toolCalls: 2 });
    s.title = 'bob is a scientist';
    s.result = 'From neuroscience: flow states quiet the default mode network (DMN), the same network that builds our sense of self.\n\n```python\nresult = analyse_flow_state(eeg_recording="sessions/2026-11-25/charlie_painting_session_03.edf", band="theta", window_seconds=30, baseline="resting")\n```\n\n| Measure | Painting | Resting | Change |\n|---|---|---|---|\n| DMN activity (fMRI BOLD) | 0.42 | 0.71 | -41% |\n| Frontal theta power | 6.1 uV2 | 4.3 uV2 | +42% |\n\nSource: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC0000000/flow-state-default-mode-network-creativity-2026\n\nSo the machine can copy the output, but not the inner state that produced it.';
    window.__sa.emit('subagent.started', { ...s });
    window.__sa.emit('subagent.finished', { ...s });
    window.__sa.transcripts.set(s.id, [
      { role: 'user', content: s.task },
      { role: 'assistant', content: [{ type: 'text', text: s.result }] },
    ]);
    return s.id;
  });
  await snap(p, '00-chat');

  // Agents panel: list.
  await p.evaluate(() => window.__subagents.open(window.__app));
  await sleep(700);
  await snap(p, '01-agents-panel');
  let f = await sheetFit(p);
  console.log('panel', JSON.stringify(f));
  if (process.env.PROBE) console.log(await p.evaluate(() => {
    const d = [...document.querySelectorAll('.dialog')].pop();
    const out = [];
    const walk = (e, lvl) => { if (lvl > 4) return; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); out.push(`${'  '.repeat(lvl)}${e.tagName}.${String(e.className).slice(0, 50)} [${Math.round(r.top)}-${Math.round(r.bottom)}] ov=${s.overflowY} pos=${s.position} pad=${s.paddingTop}/${s.paddingBottom} z=${s.zIndex}`); for (const c of e.children) walk(c, lvl + 1); };
    walk(d.parentElement, 0);
    const comp = document.querySelector('.aui-composer-root'); const cs = comp && getComputedStyle(comp);
    out.push('composer ' + JSON.stringify(comp && comp.getBoundingClientRect()) + ' z=' + (cs && cs.zIndex) + ' pos=' + (cs && cs.position));
    out.push('portal z=' + getComputedStyle(document.getElementById('portal')).zIndex);
    return out.join('\n');
  }));
  check('Agents panel: title and close clear the status bar', f.titleTop >= TOP && f.closeTop >= TOP, JSON.stringify(f));
  check('Agents panel: nothing (composer / bottom bar) painted over the sheet', !f.covered.length, JSON.stringify(f));
  check('Agents panel: sheet ends above the bottom bar', f.barTop == null || f.bottom <= f.barTop + 1, JSON.stringify(f));
  check('Agents panel: page does not scroll sideways', f.pageX <= 1, JSON.stringify(f));
  await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); const sc = [...d.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)).pop(); if (sc) sc.scrollTop = sc.scrollHeight; });
  await sleep(300);
  await snap(p, '02-agents-panel-scrolled-end');
  f = await sheetFit(p);
  check('Agents panel scrolled to the end: last card fully above the bottom edge', !f.covered.length, JSON.stringify(f));

  // Sub-agent detail sheet.
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'overview' }), ids.bob);
  await sleep(700);
  await snap(p, '03-subagent-detail');
  f = await sheetFit(p);
  console.log('detail', JSON.stringify(f));
  check('Sub-agent sheet: header clears the status bar', f.titleTop >= TOP && f.closeTop >= TOP, JSON.stringify(f));
  check('Sub-agent sheet: nothing painted over the sheet', !f.covered.length, JSON.stringify(f));
  await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); const sc = [...d.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)).pop(); if (sc) sc.scrollTop = sc.scrollHeight; });
  await sleep(300);
  await snap(p, '04-subagent-detail-scrolled-end');
  // Overflow tour: every Agents tab and every per-agent tab, nothing may stick out sideways.
  const audit = () => p.evaluate(() => {
    const d = [...document.querySelectorAll('.dialog')].pop();
    if (!d) return [];
    const dr = d.getBoundingClientRect();
    const bad = [];
    const clipsX = (a) => /auto|scroll/.test(getComputedStyle(a).overflowX);
    for (const e of d.querySelectorAll('*')) {
      if (!e.getClientRects().length || e.closest('svg') || e.closest('[hidden]') || e.matches('.sr-only, .sr-only *')) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let inScroller = false;
      for (let a = e.parentElement; a && a !== d; a = a.parentElement) if (clipsX(a) && a.scrollWidth > a.clientWidth + 1) { inScroller = true; break; }
      if (inScroller) continue;
      const s = getComputedStyle(e);
      const sticks = r.right > dr.right + 1 || r.left < dr.left - 1;
      // Text cut off inside a box that does not scroll (and is not a deliberate ellipsis).
      const clipped = e.scrollWidth > e.clientWidth + 2 && !clipsX(e) && s.textOverflow !== 'ellipsis' && !/^(INPUT|TEXTAREA|SELECT|BUTTON|IMG|VIDEO|CANVAS|IFRAME)$/.test(e.tagName) && !e.closest('button') && e.children.length === 0;
      if (sticks || clipped) bad.push(`${sticks ? 'out' : 'clip'} ${e.tagName}.${String(e.className).slice(0, 36)} "${(e.textContent || '').trim().slice(0, 30)}" r=${Math.round(r.right)}`);
    }
    return bad.slice(0, 12);
  });
  const tour = [];
  for (const tab of ['agents', 'explorer', 'diagram', 'presets', 'settings']) {
    await p.evaluate((t) => window.__subagents.open(window.__app, { tab: t }), tab); await sleep(450);
    const a = await audit(); tour.push([tab, a]);
    if (tab !== 'agents') await snap(p, `10-tab-${tab}`);
  }
  for (const at of ['overview', 'chat', 'activity', 'tools', 'context', 'memory', 'settings']) {
    await p.evaluate(([i, t]) => window.__subagents.open(window.__app, { id: i, agentTab: t }), [ids.bob, at]); await sleep(450);
    const a = await audit(); tour.push(['agent:' + at, a]);
    if (at !== 'overview') await snap(p, `11-agent-${at}`);
  }
  for (const [t, a] of tour) { if (a.length) console.log('overflow', t, '\n   ' + a.join('\n   ')); check(`No sideways overflow in ${t}`, !a.length, a.slice(0, 3).join(' | ')); }
  await p.keyboard.press('Escape'); await sleep(200);
  await p.keyboard.press('Escape'); await sleep(300);

  // Long lines in a chat reply: a code line, a long URL, a long word, a wide table.
  const k = await p.evaluate(() => window.__app.chat.mainId);
  await p.locator('.aui-composer-input').first().fill('Show long content');
  await p.locator('.aui-composer-send').first().click();
  await sleep(300);
  const key = await p.evaluate(() => { const c = window.__mock.calls; return [...c].reverse().find((x) => x.name === 'agent.sendMessage' || x.name === 'agent.resumeSession')?.args?.sessionKey || window.__app.chat.mainId; });
  const text = 'Here is the build command and a long link:\n\n```bash\nnpx cap run android --target emulator-5554 --live-reload --external --port 5173 --flavor productionRelease --verbose\n```\n\nLink: https://github.com/AKIBUZZAMAN-AKIB/my-App2.0/blob/ui-ux/tools/agent-html-src/10-subagents.js#L120-L180\n\nIdentifier: `com.myapp.suite.agent.subagents.explorer.inspector.SuperLongIdentifierName`\n\n| Agent | Status | Tokens | Steps | Model | Started | Finished |\n|---|---|---|---|---|---|---|\n| web-scout | Finished | 18,240 | 9 | claude-sonnet-4.5 | 11:41:30 AM | 11:42:11 AM |\n| draft | Running | 22,870 | 11 | claude-sonnet-4.5 | 11:42:43 AM | - |\n\nAverylongwordwithoutanyspacesthatwouldnormallypushthecardoutsidethescreenontheandroidphone end.\n\nNormal prose still wraps on several lines like any paragraph should, and only the long things scroll sideways.';
  const chunks = text.match(/[\s\S]{1,60}/g);
  for (const c of chunks) await p.evaluate(([kk, d]) => window.__mock.emit('text_delta', { sessionKey: kk, delta: d }), [key, c]);
  await p.evaluate((kk) => window.__mock.emit('agent.completed', { sessionKey: kk }), key);
  await sleep(800);
  await p.evaluate(() => { const v = document.querySelector('.aui-thread-viewport'); v.scrollTop = v.scrollHeight; });
  await sleep(300);
  await snap(p, '05-long-lines');
  const ov = await p.evaluate(() => {
    const last = [...document.querySelectorAll('.aui-assistant-message-content')].pop();
    const lr = last.getBoundingClientRect();
    const out = [...last.querySelectorAll('*')].filter((e) => !e.closest('button') && !e.closest('svg')).filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > innerWidth + 1 || (e.scrollWidth > e.clientWidth + 2 && !/auto|scroll/.test(getComputedStyle(e).overflowX))); })
      .filter((e) => { // inside a sideways scroller is fine
        for (let a = e.parentElement; a && a !== last.parentElement; a = a.parentElement) { const s = getComputedStyle(a); if (/auto|scroll/.test(s.overflowX) && a.getBoundingClientRect().right <= innerWidth + 1) return false; }
        return true; }).map((e) => e.tagName + '.' + String(e.className).slice(0, 30));
    const scrollers = [...last.querySelectorAll('pre, table, .md-table-wrap, .aui-table-wrap, code')].filter((e) => e.scrollWidth > e.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(e).overflowX)).map((e) => e.tagName);
    return { out: out.slice(0, 8), scrollers, pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, msgRight: Math.round(lr.right) };
  });
  console.log('long', JSON.stringify(ov));
  check('Long lines: nothing sticks out of the screen', !ov.out.length, JSON.stringify(ov));
  check('Long lines: the page itself does not scroll sideways', ov.pageX <= 1, JSON.stringify(ov));
  check('Long lines: code / table scroll on their own', ov.scrollers.length >= 1, JSON.stringify(ov));
  // Scroll the code block sideways to prove it moves by itself.
  await p.evaluate(() => { const last = [...document.querySelectorAll('.aui-assistant-message-content')].pop(); for (const e of last.querySelectorAll('pre, table, .md-table-wrap, .aui-table-wrap')) if (e.scrollWidth > e.clientWidth) e.scrollLeft = 140; });
  await sleep(200);
  await snap(p, '06-long-lines-scrolled');
  /* ---- Settings-style redesign: (i) info, native live tree, running pill ---- */
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'agents' })); await sleep(450);
  await p.evaluate(() => document.querySelector('.sa-dialog .sa-row .aui-info-btn')?.click()); await sleep(350);
  check('row (i) opens a popover with details', await p.evaluate(() => !!document.querySelector('.aui-info-pop .aui-info-facts')));
  await snap(p, '12-info-popover');
  await p.keyboard.press('Escape'); await sleep(200);
  // Diagram: the tree must be there at once (no Mermaid wait) and follow a live change.
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' }));
  check('tree renders without waiting', await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.querySelectorAll('.at-tree .at-node').length > 1))))));
  const liveId = await p.evaluate((bob) => {
    const k = window.__app.chat.mainId; const now = Date.now();
    const s = window.__sa.make({ name: 'fact-checker', task: 'Check the sources in bob\u2019s report', status: 'running', depth: 2, createdAt: now });
    Object.assign(s, { parentId: bob, parentSessionKey: window.__sa.subs.get(bob)?.sessionKey || k, rootSessionKey: k, startedAt: now });
    s.title = 'fact-checker';
    window.__sa.emit('subagent.started', { ...s });
    return s.id;
  }, ids.bob);
  await sleep(120);
  check('new sub-agent appears in the tree live', await p.evaluate((id) => !!document.querySelector(`.at-node[data-id="${id}"]`), liveId));
  check('it hangs under its parent', await p.evaluate(([id, bob]) => document.querySelector(`.at-node[data-id="${id}"]`)?.parentElement?.closest('.at-node')?.dataset.id === bob, [liveId, ids.bob]));
  await snap(p, '13-tree-live-new-agent');
  await p.evaluate((id) => { const r = window.__subagents.recordsOf().find((x) => x.id === id); window.__sa.emit('subagent.finished', { ...r, status: 'finished', finishedAt: Date.now() }); }, liveId);
  await sleep(120);
  check('status change shows live in the tree', await p.evaluate((id) => document.querySelector(`.at-node[data-id="${id}"]`)?.dataset.tone === 'ok', liveId));
  await p.evaluate((bob) => document.querySelector(`.at-node[data-id="${bob}"] > .at-row > .at-twisty`)?.click(), ids.bob); await sleep(120);
  check('a branch collapses', await p.evaluate((bob) => document.querySelector(`.at-node[data-id="${bob}"]`)?.getAttribute('aria-expanded') === 'false', ids.bob));
  await snap(p, '14-tree-collapsed-branch');
  // Running pill above the composer.
  await p.evaluate(() => document.querySelector('.sa-dialog')?.closest('.dialog-root, [role="dialog"]')?.querySelector('[aria-label="Close"]')?.click()); await sleep(300);
  await p.evaluate(() => { const k = window.__app.chat.mainId; const s = window.__sa.make({ name: 'writer', task: 'Draft the summary', status: 'running', depth: 1, createdAt: Date.now() }); Object.assign(s, { parentSessionKey: k, rootSessionKey: k, startedAt: Date.now() }); window.__sa.emit('subagent.started', { ...s }); });
  await sleep(250);
  check('running pill shows above the composer', await p.evaluate(() => { const el = document.querySelector('[data-slot="subagents-pill"]'); return !!el && !el.hidden && el.getBoundingClientRect().height > 0; }));
  await snap(p, '15-running-pill');
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
