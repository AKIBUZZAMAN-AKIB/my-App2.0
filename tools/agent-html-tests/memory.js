// Chat memory UI (57-memory.js): indicator, status (summarized / summarizing / pending), summary with
// current and superseded decisions, version history with repair evidence and a confirmed Revert,
// archived turns, stored results with unavailable ones, settings, events, errors, keyboard,
// and layout at 320/375/768/1366 px in light and dark: overflow, contrast, 44 px tap targets on touch.
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'agent-html-shots', 'safe-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync(`${__dirname}/mock3.js`, 'utf8');
const mockV2 = fs.readFileSync(`${__dirname}/mock-v2.js`, 'utf8');
const mockSA = fs.readFileSync(`${__dirname}/mock-subagents.js`, 'utf8');
const mockMem = fs.readFileSync(`${__dirname}/mock-memory.js`, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + String(extra).slice(0, 400) : ''}`); return ok; };

async function open(browser, { w = 390, hgt = 844, mobile = true, dark = false, cfg = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(`window.__SA_CFG = {}; window.__MEM_CFG = ${JSON.stringify(cfg)};`);
  await ctx.addInitScript(mock);
  await ctx.addInitScript(mockV2);
  await ctx.addInitScript(mockSA);
  await ctx.addInitScript(mockMem);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) errs.push('NETWORK: ' + r.url()); });
  p.on('dialog', (d) => { errs.push('NATIVE DIALOG: ' + d.message()); d.dismiss(); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => window.__chatMemory?.refresh());
  await sleep(250);
  return { p, ctx, errs };
}
const memCalls = (p) => p.evaluate(() => window.__mock.calls.filter((c) => c.name === 'agent.memory').map((c) => c.args));
const openScreen = async (p, tab) => { await p.evaluate((t) => window.__chatMemory.open(t), tab); await p.waitForSelector('[data-slot="memory-screen"] .cm-panel'); await sleep(250); };
const tab = async (p, t) => { await p.click(`.cm-tabs [data-tab="${t}"]`); await sleep(250); };
const panelText = (p) => p.evaluate(() => document.querySelector('.cm-panel')?.innerText || '');
const statusText = (p) => p.evaluate(() => document.querySelector('[data-slot="memory-status"]')?.innerText || '');
const closeDialogs = async (p) => { for (let i = 0; i < 5; i++) { if (!(await p.$('.dialog'))) break; await p.keyboard.press('Escape'); await sleep(150); } };
const toastText = (p) => p.evaluate(() => [...document.querySelectorAll('.toast, [data-sonner-toast], .aui-toast')].map((t) => t.textContent).join(' | '));
const ind = (p) => p.evaluate(() => { const st = window.__chatMemory?.indicatorState?.(); if (!st) return null; return { ...st, w: st.hidden ? 0 : 1, h: st.hidden ? 0 : 1 }; });

/* ---------- contrast helpers (in page) ---------- */
const CONTRAST_FN = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let base = [255, 255, 255]; if (!layers.length || layers[layers.length - 1][3] < 1) base = document.documentElement.classList.contains('dark') ? [9, 9, 11] : [255, 255, 255]; for (let i = layers.length - 1; i >= 0; i--) { const [r, g, b, a] = layers[i]; base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]; } return base; };
  window.__ratio = (el) => { const st = getComputedStyle(el); const fg = rgba(st.color); const bg = bgOf(el); const f = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])]; const L1 = lum(f), L2 = lum(bg); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
})()`;

async function testFeatureGate(browser) {
  const { p, ctx, errs } = await open(browser, { cfg: { feature: false } });
  const i = await ind(p);
  check('[no feature] indicator hidden', !i || i.hidden, JSON.stringify(i));
  check('[no feature] no memory call made', (await memCalls(p)).length === 0);
  await p.evaluate(() => window.__chatMemory.open());
  await sleep(300);
  const st = await statusText(p);
  check('[no feature] the screen explains it needs a newer engine', /newer app engine/i.test(st), st);
  check('[no feature] no console errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testSummaryAndIndicator(browser) {
  const { p, ctx, errs } = await open(browser);
  let i = await ind(p);
  check('indicator visible with the summarized turn count', i && !i.hidden && i.count === '14' && i.state === 'ok', JSON.stringify(i));
  check('indicator has an accessible label', /summarized through turn 14/i.test(i?.label || ''), i?.label);
  await p.click('[data-slot="memory-indicator"]');
  await p.waitForSelector('[data-slot="memory-screen"]');
  await sleep(300);
  const dlg = await p.evaluate(() => { const d = document.querySelector('.cm-dialog'); return d ? { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), label: document.getElementById(d.getAttribute('aria-labelledby'))?.textContent } : null; });
  check('indicator opens a labelled modal dialog', dlg && dlg.role === 'dialog' && dlg.modal === 'true' && /Chat memory/.test(dlg.label || ''), JSON.stringify(dlg));
  const st = await statusText(p);
  check('status: summarized through turn 14, version, and the 7 recent turns', /Summarized through turn 14/.test(st) && /Version 3/.test(st) && /last 7 turns/.test(st), st);
  const t = await panelText(p);
  check('summary shows the goal', /offline notes app/.test(t), t.slice(0, 200));
  check('current decisions shown with IDs and "In force"', /D2/.test(t) && /SQLite/.test(t) && /D3/.test(t) && /In force/.test(t));
  const sup = await p.evaluate(() => { const li = document.querySelector('.cm-item[data-decision="D1"]'); return li ? { superseded: li.hasAttribute('data-superseded'), text: li.innerText, strike: getComputedStyle(li.querySelector('.cm-text-old')).textDecorationLine, sr: li.querySelector('.sr-only')?.textContent } : null; });
  check('superseded D1 is marked replaced, struck through, and says by D2 in turn 9', sup && sup.superseded && /Replaced/.test(sup.text) && /Replaced by\s*D2\s*in turn 9/.test(sup.text.replace(/\n/g, ' ')) && /line-through/.test(sup.strike), JSON.stringify(sup));
  check('superseded state is announced to screen readers, not only by style', /Replaced decision/.test(sup?.sr || ''));
  await p.click('.cm-item[data-decision="D1"] .cm-id-link');
  await sleep(500);
  const focus = await p.evaluate(() => document.activeElement?.dataset?.decision);
  check('"Replaced by D2" moves focus to decision D2', focus === 'D2', focus);
  check('facts and preferences show their source turns', /Rajshahi/.test(t) && /Answers in Bengali/.test(t) && /Turn 1/.test(t));
  check('files and open items shown', /src\/db\.rs/.test(t) && /conflict strategy/.test(t));
  check('turn index grouped by topic with ranges', /database/.test(t) && /sync/.test(t) && /8–14/.test(t) && /Turns 1–7/.test(t), t.slice(-300));
  // Turn link opens the original text.
  await p.click('.cm-index .cm-turn');
  await sleep(400);
  const orig = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.innerText || '');
  check('a turn link opens the original turns', /Original turns 1–7/.test(orig) && /Original text of turn 3/.test(orig), orig.slice(0, 200));
  await p.keyboard.press('Escape');
  await sleep(200);
  check('Escape closes only the nested viewer', !!(await p.$('[data-slot="memory-screen"]')));
  // Keyboard tabs.
  await p.focus('.cm-tabs [data-tab="summary"]');
  await p.keyboard.press('ArrowRight');
  await sleep(250);
  const sel = await p.evaluate(() => ({ sel: document.querySelector('.cm-tabs [aria-selected="true"]')?.dataset.tab, focus: document.activeElement?.dataset?.tab, labelled: document.querySelector('.cm-panel').getAttribute('aria-labelledby') }));
  check('arrow keys move between tabs (roving tabindex)', sel.sel === 'history' && sel.focus === 'history' && /history$/.test(sel.labelled || ''), JSON.stringify(sel));
  check('no console errors (summary)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testStatusStates(browser) {
  const { p, ctx, errs } = await open(browser);
  await openScreen(p);
  // Summarizing (event) -> in-progress everywhere.
  await p.evaluate(() => window.__mem.emit('memory.summarizing', { fromTurn: 15, toTurn: 21, version: 3 }));
  await sleep(250);
  let st = await statusText(p);
  let i = await ind(p);
  check('summarizing: status says which turns, with a spinner', /Summarizing turns 15–21/.test(st) && !!(await p.$('[data-slot="memory-status"] .spin')), st);
  check('summarizing: indicator busy with a label', i.state === 'busy' && /summarizing turns 15–21/i.test(i.label), JSON.stringify(i));
  const live = await p.evaluate(() => new Promise((r) => setTimeout(() => r(document.querySelector('[data-slot="memory-live"]')?.textContent), 120)));
  check('summarizing is announced in a polite live region', /Summarizing turns 15–21/.test(live || ''), live);
  // Fails -> pending with the reason.
  await p.evaluate(() => { window.__mem.state.status = { status: 'pending', message: 'summary failed, will retry', detail: 'summary failed, will retry (decision D2 is missing from the new summary)', retries: 2, at: Date.now() - 30000 }; window.__mem.emit('memory.pending', { reason: 'decision D2 is missing', retries: 2 }); });
  await sleep(400);
  st = await statusText(p);
  i = await ind(p);
  check('pending: "summary failed, will retry" with the reason, said once', (st.match(/summary failed, will retry/gi) || []).length === 1 && /Reason: decision D2 is missing from the new summary\./.test(st) && /Nothing was lost/.test(st) && /Tries so far: 2/.test(st), st);
  check('pending: indicator shows the warning state', i.state === 'pending' && /failed, will retry/i.test(i.label), JSON.stringify(i));
  // A run ending while summarizing clears the spinner (abort).
  await p.evaluate(() => { window.__mem.state.status = { status: 'ok' }; window.__mem.emit('memory.summarizing', { fromTurn: 15, toTurn: 21 }); });
  await sleep(150);
  await p.evaluate(() => window.__mem.emit('memory.cancelled', { fromTurn: 15, toTurn: 21 }));
  await sleep(400);
  i = await ind(p);
  check('cancelled: spinner clears and state returns to ok', i.state === 'ok', JSON.stringify(i));
  await p.evaluate(() => window.__mem.emit('memory.summarizing', { fromTurn: 15, toTurn: 21 }));
  await sleep(100);
  await p.evaluate(() => window.__mock.emit('agent.error', { error: 'network' }));
  await sleep(400);
  check('a run that ends with an error clears the spinner too', (await ind(p)).state === 'ok');
  // Updated -> refetch and new count.
  await p.evaluate(() => { const s = window.__mem.state; s.memory.throughTurn = 21; s.version = 4; s.versions.unshift({ version: 4, kind: 'summary', throughTurn: 21, createdAt: Date.now(), detail: { fromTurn: 15, toTurn: 21, calls: 1, portions: 1 } }); window.__mem.emit('memory.updated', { version: 4, throughTurn: 21 }); });
  await sleep(500);
  st = await statusText(p);
  i = await ind(p);
  check('updated: status and indicator move to turn 21', /Summarized through turn 21/.test(st) && i.count === '21', st + ' ' + JSON.stringify(i));
  // Summarizing reported by memory.get (screen opened mid-run / after reload).
  await closeDialogs(p);
  await p.evaluate(() => { window.__mem.state.summarizing = { fromTurn: 22, toTurn: 28 }; });
  await openScreen(p);
  await sleep(300);
  st = await statusText(p);
  check('a summary already running when the screen opens shows as in progress', /Summarizing turns 22–28/.test(st), st);
  await p.evaluate(() => { window.__mem.state.summarizing = null; });
  // Off.
  await p.evaluate(() => { window.__mem.state.settings.enabled = false; });
  await p.evaluate(() => window.__chatMemory.refresh());
  await sleep(300);
  i = await ind(p);
  check('off: indicator says memory is off', i.state === 'off' && /off/i.test(i.label), JSON.stringify(i));
  // Load error.
  await p.evaluate(() => { window.__mem.failNext = 'database is locked (token=sk-ABCDEFGHIJKLMNOPQRSTUV)'; });
  await p.evaluate(() => window.__chatMemory.refresh());
  await sleep(300);
  st = await statusText(p);
  check('a failing memory.get keeps the last data and does not crash', /Summarized|off/i.test(st) || /Could not load/.test(st), st);
  check('no secrets leak into the screen', !/sk-ABCDEFGHIJ/.test(await p.evaluate(() => document.body.innerText)));
  check('no console errors (status)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testHistoryRevert(browser) {
  const { p, ctx, errs } = await open(browser);
  await openScreen(p, 'history');
  let t = await panelText(p);
  check('history lists versions newest first with kinds', /v3[\s\S]*Repair[\s\S]*v2[\s\S]*Summary[\s\S]*v1/.test(t), t.slice(0, 300));
  check('summary version says what changed (turns, D1 replaced by D2)', /Summarized turns 8–14/.test(t) && /D1\s*replaced by\s*D2/.test(t.replace(/\n/g, ' ')));
  check('repair shows its evidence quote and turn', /Evidence/.test(t) && /the log is at \/tmp\/app\.log/.test(t) && /Why:/.test(t));
  check('only the repair has a Revert button', (await p.$$('.cm-revert')).length === 1);
  // Cancel first: nothing changes.
  await p.click('.cm-revert');
  await sleep(300);
  let conf = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.innerText || '');
  check('Revert asks for confirmation and says what it removes', /Revert the repair in version 3\?/.test(conf) && /removes the added fact/.test(conf), conf);
  await p.keyboard.press('Escape');
  await sleep(250);
  check('cancelling the confirmation makes no revert call', !(await memCalls(p)).some((c) => c.action === 'memory.revert'));
  // Confirm.
  await p.click('.cm-revert');
  await sleep(300);
  await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); [...d.querySelectorAll('button')].find((b) => /^Revert$/.test(b.textContent.trim())).click(); });
  await sleep(600);
  const rc = (await memCalls(p)).filter((c) => c.action === 'memory.revert');
  check('confirming sends memory.revert for version 3', rc.length === 1 && rc[0].version === 3, JSON.stringify(rc));
  t = await panelText(p);
  check('history now has the revert version and the repair is marked Reverted', /v4[\s\S]*Revert[\s\S]*Reverted the repair in version 3/.test(t) && /Reverted/.test(t) && (await p.$$('.cm-revert')).length === 0, t.slice(0, 300));
  check('success toast after revert', /Reverted/.test(await toastText(p)));
  check('status moves to version 4', /Version 4/.test(await statusText(p)));
  // Engine refuses (already reverted): error toast, no crash.
  await p.evaluate(() => { window.__mem.state.versions = window.__mem.state.versions.filter((v) => v.kind !== 'revert'); });
  await p.evaluate(() => window.__chatMemory.refresh());
  await sleep(300);
  await tab(p, 'summary'); await tab(p, 'history');
  await p.evaluate(() => { window.__mem.state.versions.unshift({ version: 9, kind: 'revert', throughTurn: 14, createdAt: Date.now(), detail: { revertedVersion: 3 } }); });
  if (await p.$('.cm-revert')) {
    await p.click('.cm-revert');
    await sleep(250);
    await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); [...d.querySelectorAll('button')].find((b) => /^Revert$/.test(b.textContent.trim())).click(); });
    await sleep(600);
    check('a revert the engine refuses shows its reason', /Not reverted: that repair was already reverted/.test(await toastText(p)), await toastText(p));
  } else check('a revert the engine refuses shows its reason', false, 'no revert button to test');
  // View a version.
  await p.click('.cm-history .cm-btn');
  await sleep(350);
  const v = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.innerText || '');
  check('View opens the rendered version', /native-agent-turn-memory-v1/.test(v), v.slice(0, 120));
  check('no console errors (history)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testTurnsResults(browser) {
  const { p, ctx, errs } = await open(browser);
  await openScreen(p, 'turns');
  let t = await panelText(p);
  check('turns: 21 stored, summarized vs sent in full', /21 turns stored/.test(t) && /Summarized/.test(t) && /Sent in full/.test(t), t.slice(0, 200));
  const order = await p.evaluate(() => [...document.querySelectorAll('.cm-turns .cm-turn')].slice(0, 2).map((b) => b.textContent));
  check('turns: newest first', order[0] === 'Turn 21', JSON.stringify(order));
  await tab(p, 'results');
  t = await panelText(p);
  check('results: R1 and R3 stored with tool, size, turn', /R1/.test(t) && /read_file/.test(t) && /2\.0 MB/.test(t) && /R3/.test(t) && /web_fetch/.test(t), t.slice(0, 400));
  const un = await p.evaluate(() => { const li = document.querySelector('.cm-item[data-unavailable][data-result="R2"]'); return li ? li.innerText : ''; });
  check('results: R2 marked unavailable, not guessed, with where it is referenced', /Unavailable/.test(un) && /does not guess/.test(un) && /turn 8/.test(un), un);
  // View R1 and page through it.
  await p.click('.cm-item[data-result="R1"] .cm-btn');
  await sleep(400);
  let r = await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); return { text: d.querySelector('.cm-pre')?.textContent || '', more: !d.querySelector('.cm-viewer .cm-btn')?.hidden, meta: d.querySelector('.cm-viewer .field-hint')?.textContent }; });
  check('a stored result opens with its first page and a Show more button', r.text.startsWith('INFO start') && r.more && !/NEEDLE/.test(r.text), JSON.stringify({ ...r, text: r.text.length }));
  await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop().querySelector('.cm-viewer .cm-btn').click());
  await sleep(400);
  r = await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); return { text: d.querySelector('.cm-pre')?.textContent || '', more: !d.querySelector('.cm-viewer .cm-btn')?.hidden }; });
  check('Show more loads the rest (the middle is not lost)', /NEEDLE/.test(r.text) && !r.more && r.text.length === 20000 + 9000 + 'INFO start\n'.length + '\nNEEDLE\n'.length, String(r.text.length));
  await p.keyboard.press('Escape');
  await sleep(200);
  // A result that disappears between list and open.
  await p.evaluate(() => { window.__mem.state.results.results = window.__mem.state.results.results.filter((x) => x.id !== 'R3'); });
  await p.click('.cm-item[data-result="R3"] .cm-btn');
  await sleep(400);
  const gone = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.querySelector('[data-slot="memory-result-unavailable"]')?.innerText || '');
  check('a result missing when opened says unavailable', /R3 is unavailable/.test(gone) && /does not guess/.test(gone), gone);
  check('no console errors (turns/results)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testSettings(browser) {
  const { p, ctx, errs } = await open(browser);
  await openScreen(p, 'settings');
  // The two summary settings (the storage fields of Phase 6 are checked in memory-p7.js).
  const vals = await p.evaluate(() => [...document.querySelectorAll('.cm-num[name]')].map((i) => ({ v: i.value, label: document.querySelector(`label[for="${i.id}"]`)?.textContent, desc: !!document.getElementById(i.getAttribute('aria-describedby')) })));
  check('settings show keep_recent and batch, both 7, labelled and described', vals.length === 2 && vals.every((x) => x.v === '7' && x.label && x.desc), JSON.stringify(vals));
  const sw = await p.evaluate(() => { const s = document.querySelector('.cm-switch .switch'); return { checked: s.checked, role: s.getAttribute('role'), label: document.querySelector(`label[for="${s.id}"]`)?.textContent }; });
  check('enable switch is on, a labelled switch', sw.checked && sw.role === 'switch' && /Summarize older turns/.test(sw.label), JSON.stringify(sw));
  // Invalid value.
  await p.fill('.cm-num[name="keepRecent"]', '0');
  await p.click('.cm-panel .cm-actions .btn-default');
  await sleep(250);
  const inv = await p.evaluate(() => ({ err: document.querySelector('.cm-field-error')?.textContent, aria: document.querySelector('.cm-num[name="keepRecent"]').getAttribute('aria-invalid'), focus: document.activeElement?.name }));
  check('an invalid number is refused with a message and focus', /1 to 50/.test(inv.err || '') && inv.aria === 'true' && inv.focus === 'keepRecent', JSON.stringify(inv));
  check('nothing saved for an invalid number', !(await memCalls(p)).some((c) => c.action === 'memory.settings'));
  await p.fill('.cm-num[name="keepRecent"]', '10');
  await p.fill('.cm-num[name="batch"]', '5');
  await p.click('.cm-panel .cm-actions .btn-default');
  await sleep(500);
  let sc = (await memCalls(p)).filter((c) => c.action === 'memory.settings');
  check('Save sends keepRecent 10, batch 5', sc.length === 1 && sc[0].settings.keepRecent === 10 && sc[0].settings.batch === 5 && sc[0].settings.enabled === true, JSON.stringify(sc));
  check('status reflects the new recent count', /last 10 turns/.test(await statusText(p)), await statusText(p));
  await p.click('.cm-panel .cm-actions .btn-outline');
  await sleep(500);
  sc = (await memCalls(p)).filter((c) => c.action === 'memory.settings');
  check('Use defaults sets 7 and 7 back', sc.length === 2 && sc[1].settings.keepRecent === 7 && sc[1].settings.batch === 7, JSON.stringify(sc[1]));
  await p.click('.cm-switch .switch');
  await sleep(500);
  sc = (await memCalls(p)).filter((c) => c.action === 'memory.settings');
  check('turning the switch off saves enabled=false and the indicator says off', sc.at(-1)?.settings?.enabled === false && (await ind(p)).state === 'off', JSON.stringify(sc.at(-1)));
  // Clear memory with confirmation.
  await p.click('.cm-danger');
  await sleep(300);
  const conf = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.innerText || '');
  check('Clear memory asks first and says the chat stays', /Clear this chat’s memory\?/.test(conf) && /chat itself stays/.test(conf), conf);
  await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); [...d.querySelectorAll('button')].find((b) => /Clear memory/.test(b.textContent)).click(); });
  await sleep(600);
  check('confirming sends memory.reset', (await memCalls(p)).some((c) => c.action === 'memory.reset'));
  await tab(p, 'summary');
  check('after clearing, the summary is empty', /No summary yet/.test(await panelText(p)));
  check('no console errors (settings)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testEmptyAndInjection(browser) {
  const { p, ctx, errs } = await open(browser, { cfg: { empty: true } });
  let i = await ind(p);
  check('[empty] indicator shown without a count', i && !i.hidden && i.count === '' && i.state === 'empty', JSON.stringify(i));
  await openScreen(p);
  const st = await statusText(p);
  check('[empty] status explains when the first summary runs (after 13 turns, 7 kept)', /Nothing summarized yet/.test(st) && /more than 13 finished turns/.test(st), st);
  for (const t of ['history', 'turns', 'results']) { await tab(p, t); check(`[empty] ${t} tab has an empty state`, (await panelText(p)).length > 20); }
  await closeDialogs(p);
  await ctx.close();
  // Injection: model-written text is shown as text.
  const o = await open(browser);
  await o.p.evaluate(() => { const m = window.__mem.state.memory; m.goal = '<img src=x onerror="window.__pwned=1">'; m.decisions.current[0].text = '<script>window.__pwned=2</script>'; m.files.push('"><b id=inj>x</b>'); });
  await o.p.evaluate(() => window.__chatMemory.refresh());
  await openScreen(o.p);
  await sleep(300);
  const pw = await o.p.evaluate(() => ({ pwned: window.__pwned, inj: !!document.getElementById('inj'), text: document.querySelector('.cm-goal')?.textContent }));
  check('model-written text is not parsed as HTML', !pw.pwned && !pw.inj && /<img/.test(pw.text || ''), JSON.stringify(pw));
  check('no console errors (empty/injection)', ![...errs, ...o.errs].length, [...errs, ...o.errs].join(' / '));
  await o.ctx.close();
}

async function testLayout(browser) {
  const sizes = (process.env.SIZES || '320x640m,375x812m,768x1024m,1366x768').split(',').map((s) => { const m = /^(\d+)x(\d+)(m?)$/.exec(s); return [+m[1], +m[2], !!m[3]]; });
  for (const [w, hh, mobile] of sizes) for (const dark of [false, true]) {
    const tag = `${w}${dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, { w, hgt: hh, mobile, dark });
    await p.evaluate(CONTRAST_FN);
    const i = await ind(p);
    check(`${tag} indicator visible in the top bar`, i && !i.hidden && i.w > 0, JSON.stringify(i));
    // Indicator hit area: 44 px on touch (taps 6 px around the 32 px button still hit it).
    if (mobile) {
      const hit = await p.evaluate(() => { const b = document.querySelector('[data-slot="memory-indicator"]'); const r = b.getBoundingClientRect(); const cx = r.left + r.width / 2; let top = r.top, bot = r.bottom; for (let y = r.top; y > r.top - 12; y--) { const e = document.elementFromPoint(cx, y); if (e && b.contains(e)) top = y; else break; } for (let y = r.bottom; y < r.bottom + 12; y++) { const e = document.elementFromPoint(cx, y); if (e && b.contains(e)) bot = y; else break; } return bot - top; });
      check(`${tag} indicator hit area ≥ 44px`, hit >= 43, String(hit));
    }
    const topbar = await p.evaluate(() => { const t = document.querySelector('.topbar'); return t.scrollWidth <= t.clientWidth + 1; });
    check(`${tag} top bar does not overflow with the indicator`, topbar);
    // Pending state on the summary tab, then each tab.
    await p.evaluate(() => { window.__mem.state.status = { status: 'pending', message: 'summary failed, will retry', detail: 'the summary JSON was cut off', retries: 1, at: Date.now() }; });
    await openScreen(p);
    await sleep(300);
    for (const t of ['summary', 'history', 'turns', 'results', 'settings']) {
      await tab(p, t);
      const lay = await p.evaluate(() => {
        const d = document.querySelector('.cm-dialog');
        const body = d.querySelector('.dialog-body');
        const vw = document.documentElement.clientWidth;
        const r = d.getBoundingClientRect();
        const wide = [...d.querySelectorAll('*')].filter((e) => { if (e.closest('.cm-tabs') || e.closest('.cm-pre')) return false; const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1); }).map((e) => e.className || e.tagName).slice(0, 3);
        return { inView: r.left >= -1 && r.right <= vw + 1, hScroll: body.scrollWidth > body.clientWidth + 1, wide };
      });
      check(`${tag} ${t}: no horizontal overflow`, lay.inView && !lay.hScroll && !lay.wide.length, JSON.stringify(lay));
      // Contrast of every text element we draw.
      const low = await p.evaluate(() => {
        const sel = '.cm-screen .cm-text, .cm-screen .cm-sub, .cm-screen .cm-tag, .cm-screen .cm-id, .cm-screen .cm-turn, .cm-screen .cm-id-link, .cm-screen .cm-meta, .cm-screen .cm-h, .cm-screen .cm-h4, .cm-screen .cm-status-title, .cm-screen .cm-status-sub, .cm-screen .cm-empty, .cm-screen .field-hint, .cm-screen .field-label, .cm-screen .cm-goal, .cm-screen .cm-topic-turns, .cm-screen .settings-note, .cm-screen .cm-tabs button, .cm-screen .cm-by, .cm-screen .cm-danger, .cm-screen .cm-label';
        return [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && e.textContent.trim()).map((e) => ({ c: e.className, r: window.__ratio(e) })).filter((x) => x.r < 4.5).slice(0, 4).map((x) => `${x.c}=${x.r.toFixed(2)}`);
      });
      check(`${tag} ${t}: text contrast ≥ 4.5:1`, !low.length, low.join(', '));
      if (mobile) {
        const small = await p.evaluate(() => [...document.querySelectorAll('.cm-dialog button, .cm-dialog input')].filter((b) => b.getClientRects().length && !b.disabled && !b.closest('.dialog-header')).map((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); const isSwitch = b.classList.contains('switch'); const after = isSwitch ? getComputedStyle(b, '::before') : getComputedStyle(b, '::after'); const extra = after.content !== 'none' && after.position === 'absolute' ? -(parseFloat(after.top) || 0) - (parseFloat(after.bottom) || 0) : 0; return { c: b.className || b.type, h: r.height + extra, tab: b.dataset.tab }; }).filter((x) => x.h < 43.5 && !x.tab).slice(0, 4));
        check(`${tag} ${t}: tap targets ≥ 44px`, !small.length, JSON.stringify(small));
      }
    }
    if (mobile) {
      const tabs = await p.evaluate(() => Math.min(...[...document.querySelectorAll('.cm-tabs button')].map((b) => b.getBoundingClientRect().height)));
      check(`${tag} tabs are ≥ 36px tall (segmented control, as in the rest of the app)`, tabs >= 35.5, String(tabs));
    }
    // Pending, superseded and unavailable are not colour alone.
    await tab(p, 'summary');
    const cues = await p.evaluate(() => ({ pending: /summary failed, will retry/i.test(document.querySelector('[data-slot="memory-status"]').innerText), sup: !!document.querySelector('[data-superseded] .cm-tag-old') }));
    await tab(p, 'results');
    cues.un = (await p.evaluate(() => /Unavailable/.test(document.querySelector('[data-unavailable]')?.innerText || '')));
    check(`${tag} pending, superseded and unavailable all have text labels`, cues.pending && cues.sup && cues.un, JSON.stringify(cues));
    if (process.env.SHOT !== '0') await p.screenshot({ path: `${SHOTS}/memory-${w}${dark ? '-dark' : ''}.png` });
    await tab(p, 'history');
    if (process.env.SHOT !== '0') await p.screenshot({ path: `${SHOTS}/memory-history-${w}${dark ? '-dark' : ''}.png` });
    check(`${tag} no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

// Phase 6/7: item status and history, replaced decisions with a reason,
// background jobs with Retry, coverage, unread ranges, archive sources,
// legacy context, storage and cleanup. Scripted mock data (mock-memory.js p7).
async function testPhase7States(browser) {
  const { p, ctx, errs } = await open(browser, { cfg: { p7: true } });
  await openScreen(p);
  const t = await panelText(p);
  // Items: current and closed, by kind.
  const items = await p.evaluate(() => [...document.querySelectorAll('[data-item]')].map((li) => ({ id: li.dataset.item, status: li.dataset.status, visible: li.checkVisibility() })));
  const by = (id) => items.find((i) => i.id === id) || {};
  check('p7 items: current facts, preferences, files and open items with IDs', ['F1', 'F3', 'P1', 'L1', 'O1'].every((id) => by(id).status === 'current' && by(id).visible), JSON.stringify(items.map((i) => i.id + ':' + i.status)));
  check('p7 items: closed items are collapsed under "Closed or replaced"', by('F2').status === 'superseded' && !by('F2').visible && by('O2').status === 'done' && /Closed or replaced \(1\)/.test(t), JSON.stringify([by('F2'), by('O2')]));
  check('p7 items: legacy plain lists are not drawn twice', (t.match(/Server port is 9443/g) || []).length === 1, String((t.match(/Server port is 9443/g) || []).length));
  await p.evaluate(() => document.querySelectorAll('[data-slot="memory-closed-items"]').forEach((d) => { d.open = true; }));
  const f2 = await p.evaluate(() => { const li = document.querySelector('[data-item="F2"]'); return { text: li.innerText.replace(/\s+/g, ' '), tag: li.querySelector('.cm-tag-old')?.textContent, sr: li.querySelector('.sr-only')?.textContent, strike: getComputedStyle(li.querySelector('.cm-text-old')).textDecorationLine }; });
  check('p7 superseded item says "Replaced", by F3, in turn 10, and why', f2.tag === 'Replaced' && /Replaced by\s*F3\s*in turn 10/.test(f2.text) && /Why: user moved the server/.test(f2.text), JSON.stringify(f2));
  check('p7 superseded item: struck through and announced as text, not style alone', /line-through/.test(f2.strike) && /Replaced:/.test(f2.sr || ''), JSON.stringify(f2));
  const o2 = await p.evaluate(() => document.querySelector('[data-item="O2"]').innerText.replace(/\s+/g, ' '));
  check('p7 done open item shows "Done" and its reason', /Done/.test(o2) && /benchmark finished: 4k writes\/s/.test(o2), o2);
  await p.click('[data-item="F2"] .cm-id-link');
  await sleep(500);
  check('p7 "Replaced by F3" moves focus to F3', (await p.evaluate(() => document.activeElement?.dataset?.item)) === 'F3');
  await p.evaluate(() => { const d = document.querySelector('[data-item="F3"] [data-slot="memory-item-history"]'); if (d) d.open = true; });
  const hist = await p.evaluate(() => document.querySelector('[data-item="F3"] [data-slot="memory-item-history"]')?.innerText.replace(/\s+/g, ' ') || '');
  check('p7 item history lists each change with turn, old text and reason', /History \(1 change\)/.test(hist) && /Updated in turn 12/.test(hist) && /Server port is 9000/.test(hist) && /typo fixed/.test(hist), hist);
  // Replaced decision with a reason.
  const d1 = await p.evaluate(() => document.querySelector('.cm-item[data-decision="D1"]')?.innerText.replace(/\s+/g, ' ') || '');
  check('p7 replaced decision shows its recorded reason', /Why: PostgreSQL needs a server; the app must work offline/.test(d1), d1);
  // Coverage.
  const cov = await p.evaluate(() => document.querySelector('[data-slot="memory-coverage"]')?.innerText.replace(/\s+/g, ' ') || '');
  check('p7 coverage: problems listed (gap, originals missing, item without source)', /Checked by code/.test(cov) && /missing from the index: turn 4/i.test(cov) && /Originals not stored anywhere: turn 2/.test(cov) && /Items without a source turn: F9/.test(cov), cov);
  check('p7 coverage: unsummarized range and archive-only turns', /Not summarized yet, sent in full: turns 15–21/.test(cov) && /kept in the memory archive: turns 20–21/.test(cov) && /turn 20/.test(cov), cov);
  // Legacy context.
  const lc = await p.evaluate(() => document.querySelector('[data-slot="memory-legacy-context"]')?.innerText.replace(/\s+/g, ' ') || '');
  check('p7 legacy context: older session summary shown, model still sees it', /Earlier context/i.test(lc) && /1 message from an older version/.test(lc) && /still sees it in full/.test(lc), lc);
  // Background job failed: status + Retry.
  let st = await statusText(p);
  const job = await p.evaluate(() => { const j = document.querySelector('[data-slot="memory-job"]'); return j ? { state: j.dataset.job, retry: !!j.querySelector('[data-slot="memory-retry"]') } : null; });
  check('p7 failed background job: says failed, attempts, error, nothing lost', /Background summary of turns 15–21 failed/.test(st) && /5 tries/.test(st) && /provider returned 503/.test(st) && /Nothing was lost/.test(st), st);
  check('p7 failed background job has a Retry button', job && job.state === 'failed' && job.retry, JSON.stringify(job));
  await p.click('[data-slot="memory-retry"]');
  await sleep(600);
  const calls = await p.evaluate(() => window.__mock.calls.filter((c) => c.name === 'agent.memory' && c.args?.action === 'memory.retry').length);
  st = await statusText(p);
  check('p7 Retry calls memory.retry and the job shows as queued', calls === 1 && /queued/.test(st), `${calls} ${st}`);
  check('p7 Retry confirms with a toast', /Retrying the summary now/.test(await toastText(p)));
  // Retry pending (backoff) and running states.
  await p.evaluate(() => { const s = window.__mem.state; s.jobs.active = { jobKey: 'j1', fromTurn: 15, toTurn: 21, status: 'queued', attempts: 2, maxAttempts: 5, nextAttemptAt: Date.now() + 120000, lastError: 'timeout' }; s.version++; });
  await closeDialogs(p); await openScreen(p);
  st = await statusText(p);
  check('p7 retrying job: when it retries, tries so far, error, Retry now', /will retry in 2 min/.test(st) && /Tried 2 times of 5/.test(st) && /timeout/.test(st) && !!(await p.$('[data-slot="memory-retry"]')), st);
  await p.evaluate(() => { const s = window.__mem.state; s.jobs.active = { jobKey: 'j1', fromTurn: 15, toTurn: 21, status: 'running', attempts: 0, maxAttempts: 5 }; s.version++; });
  await closeDialogs(p); await openScreen(p);
  st = await statusText(p);
  check('p7 running job: summarizing in the background, turns go on', /Summarizing turns 15–21 in the background/.test(st) && /Turns go on meanwhile/.test(st) && !(await p.$('[data-slot="memory-retry"]')), st);
  // Unreadable / recovered / newer build.
  await p.evaluate(() => { const s = window.__mem.state; s.recoveredFrom = 2; s.fromNewerBuild = true; s.version++; });
  await closeDialogs(p); await openScreen(p);
  st = await statusText(p);
  check('p7 recovered and newer-build memory are explained', /version 2 was loaded instead/.test(st) && /newer version of the app/.test(st), st);
  // Turns tab: archive-only tag; turn viewer: source, differs, missing, unread.
  await tab(p, 'turns');
  const arch = await p.evaluate(() => [...document.querySelectorAll('[data-source="archive"]')].map((e) => e.closest('[data-turn]')?.dataset.turn));
  check('p7 turns tab marks archive-only turns', arch.includes('20') && arch.includes('21') && !arch.includes('19'), JSON.stringify(arch));
  await p.evaluate(() => window.__chatMemory.openTurns(window.__app.chat.mainId, 1, 60));
  await sleep(600);
  const viewer = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.innerText.replace(/\s+/g, ' ') || '');
  const srcs = await p.evaluate(() => { const d = [...document.querySelectorAll('.dialog')].pop(); return { arch: [...d.querySelectorAll('[data-turn] [data-source="archive"]')].map((e) => e.closest('[data-turn]').dataset.turn), differs: [...d.querySelectorAll('[data-slot="memory-archive-differs"]')].map((e) => e.closest('[data-turn]').dataset.turn), unread: !!d.querySelector('[data-slot="memory-turns-unread"] button') }; });
  check('p7 turn viewer: archive-read turns are marked, and a differing archive copy is flagged', srcs.arch.join() === '20,21' && srcs.differs.join() === '20', JSON.stringify(srcs));
  check('p7 turn viewer: the unread range is shown with a button that reads it', /Not loaded in this view: turns 52–60/.test(viewer) && srcs.unread, viewer.slice(-200));
  await p.click('[data-slot="memory-turns-unread"] button');
  await sleep(600);
  const next = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.innerText.replace(/\s+/g, ' ') || '');
  check('p7 turn viewer: the button opens the unread turns', /Original turns 52–60/.test(next) && /Original text of turn 60/.test(next), next.slice(0, 200));
  await closeDialogs(p);
  await openScreen(p);
  check('p7 turn viewer: missing originals are reported, not hidden', /Not stored anywhere: turn 2/.test(viewer), viewer.slice(0, 300));
  check('p7 turn viewer: each turn says it was read from the chat', /From the chat/.test(viewer), viewer.slice(0, 300));
  await closeDialogs(p);
  // Results tab: storage, pruned result, cleanup.
  await openScreen(p); await tab(p, 'results');
  let r = await panelText(p);
  check('p7 results: storage line with budget, pruned count and last cleanup', /2 stored results, 2\.\d MB of 64\.0 MB/.test(r) && /1 result \(2\.9 KB\) removed by cleanup/.test(r) && /Last cleanup/.test(r), r.slice(0, 400));
  const r4 = await p.evaluate(() => document.querySelector('[data-result="R4"]')?.innerText.replace(/\s+/g, ' ') || '');
  check('p7 pruned result: "Removed by cleanup", when, why, size, turn', /Removed by cleanup/.test(r4) && /Removed on /.test(r4) && /nothing in this chat referred to it any more/.test(r4) && /turn 19/.test(r4), r4);
  await p.click('[data-slot="memory-prune"]');
  await sleep(300);
  const dlg = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.innerText.replace(/\s+/g, ' ') || '');
  check('p7 Clean up asks first and says referenced results are never removed', /Clean up stored results\?/.test(dlg) && /never removed/.test(dlg) && /7 days/.test(dlg), dlg);
  const btn = await p.evaluateHandle(() => [...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('button')].find((b) => /^Clean up$/.test(b.textContent.trim())));
  await btn.click();
  await sleep(700);
  r = await panelText(p);
  check('p7 Clean up calls memory.prune and the list updates', (await p.evaluate(() => window.__mock.calls.filter((c) => c.name === 'agent.memory' && c.args?.action === 'memory.prune').length)) === 1 && /Unavailable \(3\)/i.test(r) && !!(await p.$('[data-result="R3"][data-pruned]')), r.slice(0, 300));
  check('p7 Clean up reports what it removed', /Removed 1 result/.test(await toastText(p)), await toastText(p));
  // Settings: background summaries + storage.
  await tab(p, 'settings');
  const sw = await p.evaluate(() => { const i = document.querySelector('[data-setting="backgroundSummaries"]'); return i ? { checked: i.checked, label: document.querySelector(`label[for="${i.id}"]`)?.textContent } : null; });
  check('p7 settings: background summaries switch, labelled, reflects the setting', sw && sw.checked && /background/i.test(sw.label || ''), JSON.stringify(sw));
  await p.click('[data-setting="backgroundSummaries"]');
  await sleep(400);
  check('p7 settings: switching background summaries off saves it', (await p.evaluate(() => window.__mem.state.settings.backgroundSummaries)) === false);
  const vals = await p.evaluate(() => ({ b: document.querySelector('[data-setting="resultBudgetBytes"]').value, k: document.querySelector('[data-setting="keepUnreferencedResultDays"]').value }));
  check('p7 settings: storage budget 64 MB and keep 7 days shown', vals.b === '64' && vals.k === '7', JSON.stringify(vals));
  await p.fill('[data-setting="resultBudgetBytes"]', '0');
  await p.click('text=Save storage');
  await sleep(300);
  const inv = await p.evaluate(() => ({ inv: document.querySelector('[data-setting="resultBudgetBytes"]').getAttribute('aria-invalid'), err: document.querySelector('[data-slot="memory-storage-error"]')?.textContent, saved: window.__mem.state.settings.resultBudgetBytes }));
  check('p7 settings: an invalid budget is refused with a message, nothing saved', inv.inv === 'true' && /1 to 4096 MB/.test(inv.err || '') && inv.saved === 64 * 1048576, JSON.stringify(inv));
  await p.fill('[data-setting="resultBudgetBytes"]', '128');
  await p.fill('[data-setting="keepUnreferencedResultDays"]', '30');
  await p.click('text=Save storage');
  await sleep(400);
  const saved = await p.evaluate(() => window.__mem.state.settings);
  check('p7 settings: budget and keep days saved', saved.resultBudgetBytes === 128 * 1048576 && saved.keepUnreferencedResultDays === 30, JSON.stringify(saved));
  check('p7 no console errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testPhase7Layout(browser) {
  for (const [w, hh] of [[320, 640], [390, 844]]) for (const dark of [false, true]) {
    const tag = `p7 ${w}${dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, { w, hgt: hh, mobile: true, dark, cfg: { p7: true } });
    await p.evaluate(CONTRAST_FN);
    await openScreen(p);
    await p.evaluate(() => document.querySelectorAll('.cm-screen details').forEach((d) => { d.open = true; }));
    for (const t of ['summary', 'turns', 'results', 'settings']) {
      await tab(p, t);
      await p.evaluate(() => document.querySelectorAll('.cm-screen details').forEach((d) => { d.open = true; }));
      const lay = await p.evaluate(() => { const d = document.querySelector('.cm-dialog'); const body = d.querySelector('.dialog-body'); const r = d.getBoundingClientRect(); const wide = [...d.querySelectorAll('*')].filter((e) => { if (e.closest('.cm-tabs') || e.closest('.cm-pre')) return false; const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1); }).map((e) => e.className || e.tagName).slice(0, 3); return { hScroll: body.scrollWidth > body.clientWidth + 1, wide }; });
      check(`${tag} ${t}: no horizontal overflow`, !lay.hScroll && !lay.wide.length, JSON.stringify(lay));
      const low = await p.evaluate(() => [...document.querySelectorAll('.cm-screen .cm-text, .cm-screen .cm-sub, .cm-screen .cm-tag, .cm-screen .cm-id, .cm-screen .cm-label, .cm-screen .cm-status-title, .cm-screen .cm-status-sub, .cm-screen summary, .cm-screen .cm-by, .cm-screen .cm-meta')].filter((e) => e.getClientRects().length && e.textContent.trim()).map((e) => ({ c: e.className || e.tagName, r: window.__ratio(e) })).filter((x) => x.r < 4.5).slice(0, 4).map((x) => `${x.c}=${x.r.toFixed(2)}`));
      check(`${tag} ${t}: text contrast ≥ 4.5:1`, !low.length, low.join(', '));
      // Same rule as testLayout: an absolutely positioned ::after (::before on a switch) extends the hit area; the dialog's own close button is the app's shared chrome.
      const small = await p.evaluate(() => [...document.querySelectorAll('.cm-dialog button, .cm-dialog summary, .cm-dialog input')].filter((b) => b.getClientRects().length && !b.disabled && !b.closest('.dialog-header') && !b.closest('.cm-tabs') && !b.classList.contains('dialog-close')).map((b) => { const r = b.getBoundingClientRect(); const isSwitch = b.classList.contains('switch'); const after = isSwitch ? getComputedStyle(b, '::before') : getComputedStyle(b, '::after'); const extra = after.content !== 'none' && after.position === 'absolute' ? -(parseFloat(after.top) || 0) - (parseFloat(after.bottom) || 0) : 0; return { c: (b.className || b.tagName).toString().slice(0, 40), t: b.textContent.trim().slice(0, 20), h: Math.round(r.height + extra) }; }).filter((x) => x.h < 43.5).slice(0, 4));
      check(`${tag} ${t}: tap targets ≥ 44px`, !small.length, JSON.stringify(small));
    }
    if (process.env.SHOT !== '0') { await tab(p, 'summary'); await p.screenshot({ path: `${SHOTS}/memory-p7-${w}${dark ? '-dark' : ''}.png`, fullPage: true }); }
    check(`${tag} no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

async function testCompareAndContext(browser) {
  for (const [w, hgt, mobile] of [[320, 640, true], [1280, 800, false]]) {
    const tag = `[context ${w}]`;
    const { p, ctx, errs } = await open(browser, { w, hgt, mobile });
    // Version comparison (item 4).
    await openScreen(p, 'history');
    const cmp = await p.$$eval('.cm-compare', (b) => b.map((x) => x.dataset.version));
    check(`${tag} every version except the current one has Compare`, cmp.length === 2 && !cmp.includes('3'), JSON.stringify(cmp));
    await p.click('.cm-compare[data-version="1"]');
    await p.waitForSelector('[data-slot="memory-compare"] .cm-diff', { timeout: 4000 }).catch(() => {});
    const diff = await p.evaluate(() => { const b = document.querySelector('[data-slot="memory-compare"]'); return b && { text: b.innerText, del: [...b.querySelectorAll('[data-op="-"]')].map((x) => x.textContent), add: [...b.querySelectorAll('[data-op="+"]')].map((x) => x.textContent), title: [...document.querySelectorAll('.dialog')].pop()?.innerText.split('\n')[0] }; });
    check(`${tag} compare shows removed and added lines of the two versions`, diff && diff.del.some((x) => /Version 1/.test(x)) && diff.add.some((x) => /Version 3/.test(x)) && /1 line added, 1 line removed/.test(diff.text), JSON.stringify(diff));
    check(`${tag} compare dialog is titled with both versions`, /Version 1 \u2192 version 3/.test(diff?.title || ''), diff?.title);
    await p.keyboard.press('Escape'); await sleep(200);
    const lcs = await p.evaluate(() => JSON.stringify(window.__chatMemory.lineDiff('a\nb\nc', 'a\nc\nd')));
    check(`${tag} line diff is an LCS diff`, lcs === JSON.stringify([[' ', 'a'], ['-', 'b'], [' ', 'c'], ['+', 'd']]), lcs);
    // Context view (items 11-13): empty state, then real engine events.
    await tab(p, 'context');
    let t = await panelText(p);
    check(`${tag} context tab: empty state before any model call`, /No model call in this chat/.test(t), t);
    await p.evaluate(() => window.__mem.emit('context.assembly', { provider: 'openrouter', model: 'qwen/qwen3', contextWindowTokens: 65536, transcriptBudgetTokens: 30000, fullTranscriptBudgetTokens: 50000, overflowRetry: 1, reservedInputTokens: 4200, reservedOutputTokens: 8192, transcriptTokens: 28750, estimatedInputTokens: 32950, memoryPresent: true, memoryReason: 'turns 1\u201314 are folded into chat memory; the summary and the decisions in force stand in for them', bySource: { memory: 1800, userText: 900, assistantText: 21000, toolResults: 4000, toolResultReferences: 50, images: 0 }, actions: ['tool_results_compacted', 'trimmed'] }));
    await p.evaluate(() => window.__mem.emit('context.overflow', { attempt: 1, recovering: true, transcriptBudgetTokens: 50000, nextBudgetTokens: 30000, error: "API error (400): This model's maximum context length is 65536 tokens (context_length_exceeded)" }));
    await sleep(350);
    t = await panelText(p);
    check(`${tag} context: tokens, window and reply reserve from the engine event`, /32,950 input tokens of a 65,536-token window/.test(t) && /8,192 kept for the reply/.test(t), t.slice(0, 300));
    check(`${tag} context: why the memory is there`, /turns 1\u201314 are folded into chat memory/.test(t));
    check(`${tag} context: sources sorted largest first, zero sources hidden`, await p.evaluate(() => { const s = [...document.querySelectorAll('.cm-sources [data-source]')].map((x) => x.dataset.source); return s[0] === 'assistantText' && !s.includes('images') && s.length === 5; }));
    check(`${tag} context: the compaction actions of this call`, /old tool results replaced by references; oldest messages dropped/.test(t));
    check(`${tag} context: reduced budget after a too-long request is explained`, /reduced after the provider said the request was too long, retry 1/.test(t));
    check(`${tag} context: overflow listed as compacted and retried`, /Too-long requests \(1\)/i.test(t) && /Compacted and retried/i.test(t) && /context_length_exceeded/.test(t));
    check(`${tag} context: last successful summary from the version history`, /Last successful summary: version 2, through turn 14/.test(t), t.slice(-200));
    const fit = await p.evaluate(() => { const d = document.querySelector('[data-slot="memory-screen"]') || document.querySelector('.cm-dialog'); const r = d.getBoundingClientRect(); return { over: [...d.querySelectorAll('.cm-panel *')].filter((e) => e.getBoundingClientRect().right > r.right + 1).length, sw: document.documentElement.scrollWidth, vw: innerWidth }; });
    check(`${tag} context: nothing overflows horizontally`, fit.over === 0 && fit.sw <= fit.vw, JSON.stringify(fit));
    const tabsFit = await p.evaluate(() => { const l = document.querySelector('.cm-tabs'); return l.scrollWidth <= l.clientWidth + 1 || getComputedStyle(l).overflowX !== 'visible'; });
    check(`${tag} six tabs fit or scroll`, tabsFit);
    if (process.env.SHOT !== '0') await p.screenshot({ path: `${SHOTS}/memory-context-${w}.png`, fullPage: true });
    check(`${tag} no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

async function testGoalsAndAudit(browser) {
  for (const [w, hgt, mobile, dark] of [[320, 640, true, false], [1280, 800, false, true]]) {
    const tag = `[goals ${w}]`;
    const { p, ctx, errs } = await open(browser, { w, hgt, mobile, dark, cfg: { goals: true } });
    await openScreen(p, 'summary');
    const goals = await p.evaluate(() => { const s = document.querySelector('[data-slot="memory-goals"]'); return s && { current: s.dataset.currentGoal, rows: [...s.querySelectorAll('[data-goal-id]')].map((li) => [li.dataset.goalId, li.dataset.goalStatus, li.getAttribute('aria-current') === 'true']), text: s.innerText }; });
    check(`${tag} goals listed active first with their status`, goals && JSON.stringify(goals.rows) === JSON.stringify([['G003', 'active', true], ['G002', 'paused', false], ['G001', 'completed', false], ['G004', 'cancelled', false]]), JSON.stringify(goals));
    check(`${tag} the current goal is marked and named`, goals?.current === 'G003' && /Current/.test(goals.text) && /Write the release notes/.test(goals.text));
    check(`${tag} completed goal shows when; cancelled is not completed`, await p.evaluate(() => !!document.querySelector('[data-goal-id="G001"] [data-slot="memory-goal-completed"]') && !document.querySelector('[data-goal-id="G004"] [data-slot="memory-goal-completed"]')));
    check(`${tag} goal history with the migrated goal`, /Goal history \(3\)/.test(goals?.text || '') && await p.evaluate(() => /from the earlier goal text/.test(document.querySelector('[data-slot="memory-goal-events"]').textContent)));
    check(`${tag} the old free-text goal is not shown twice`, !(await panelText(p)).match(/^Goal$/m));
    const links = await p.evaluate(() => [...document.querySelectorAll('[data-decision] .cm-goal-link, [data-item] .cm-goal-link')].map((x) => `${x.closest('[data-decision],[data-item]').dataset.decision || x.closest('[data-item]').dataset.item}:${x.dataset.goal}`));
    check(`${tag} decisions and tasks show their goal link (none when unlinked)`, links.includes('D2:G001') && links.includes('D1:G001') && links.includes('O1:G002') && !links.some((l) => l.startsWith('O2:')), JSON.stringify(links));
    await tab(p, 'context');
    let t = await panelText(p);
    check(`${tag} context: the stored audit before any live call`, /Memory given to the model/i.test(t) && /Last recorded call/.test(t) && /memory version 2/.test(t) && /turns 15\u201322 in full/.test(t) && /6,100 of 50,000 input tokens/.test(t), t.slice(0, 500));
    const ids = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-audit]')].map((li) => [li.dataset.audit, [...li.querySelectorAll('.cm-chips li')].map((x) => x.textContent)])));
    check(`${tag} context: selected IDs by kind`, JSON.stringify(ids) === JSON.stringify({ goals: ['G003'], decisions: ['D2'], tasks: ['O2'], memory: ['P1'], segments: ['S13-14'] }), JSON.stringify(ids));
    check(`${tag} context: why and compaction`, /current_goal, newest_segment/.test(t) && /memory_fold:turns_1-14/.test(t));
    await p.evaluate(() => window.__mem.emit('context.assembly', { provider: 'openrouter', model: 'qwen/qwen3', contextWindowTokens: 65536, transcriptBudgetTokens: 30000, reservedInputTokens: 4200, reservedOutputTokens: 8192, transcriptTokens: 2000, estimatedInputTokens: 6900, memoryPresent: true, memoryReason: 'selected memory', bySource: { memory: 900 }, actions: [], assemblyId: 'asm-8', audit: { assemblyId: 'asm-8', createdAt: Date.now(), attempt: 1, memoryVersion: 2, summaryThroughTurn: 14, inputTokenBudget: 30000, estimatedInputTokens: 6900, includedRecentTurns: [16, 17, 18, 19, 20, 21, 22, 23], includedGoalIds: ['G003', 'G002'], includedDecisionIds: ['D1', 'D2'], includedTaskIds: [], includedMemoryIds: [], includedSummarySegmentIds: [], retrievalSources: ['history'], compactionActions: [], truncationActions: ['memory_reselected'] } }));
    await sleep(350);
    t = await panelText(p);
    const live = await p.evaluate(() => { const b = document.querySelector('[data-slot="memory-audit"]'); return b && { id: b.dataset.assemblyId, attempt: b.dataset.attempt }; });
    check(`${tag} context: a live call replaces the stored one`, live?.id === 'asm-8' && live.attempt === '1' && /Last call/.test(t) && /retry 1/.test(t) && /memory_reselected/.test(t) && /none/.test(t), JSON.stringify(live));
    const fit = await p.evaluate(() => { const d = document.querySelector('[data-slot="memory-screen"]') || document.querySelector('.cm-dialog'); const r = d.getBoundingClientRect(); return { over: [...d.querySelectorAll('.cm-panel *')].filter((e) => e.getBoundingClientRect().right > r.right + 1).length, sw: document.documentElement.scrollWidth, vw: innerWidth }; });
    check(`${tag} nothing overflows horizontally`, fit.over === 0 && fit.sw <= fit.vw, JSON.stringify(fit));
    await tab(p, 'settings');
    const sw = await p.$('[data-setting="autoPruneResults"]');
    check(`${tag} settings: automatic cleanup is off by default`, sw && !(await sw.isChecked()));
    await sw.click(); await sleep(300);
    const calls = await memCalls(p);
    check(`${tag} settings: turning it on saves autoPruneResults`, calls.some((c) => c.action === 'memory.settings' && c.settings?.autoPruneResults === true), JSON.stringify(calls.slice(-2)));
    if (process.env.SHOT !== '0') { await tab(p, 'summary'); await p.screenshot({ path: `${SHOTS}/memory-goals-${w}.png`, fullPage: true }); }
    check(`${tag} no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testFeatureGate, testSummaryAndIndicator, testStatusStates, testHistoryRevert, testTurnsResults, testSettings, testEmptyAndInjection, testLayout, testPhase7States, testPhase7Layout, testCompareAndContext, testGoalsAndAudit };
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} ran`, false, e.stack?.split('\n').slice(0, 3).join(' | ')); }
  }
  await browser.close();
  console.log(results.join('\n'));
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`memory: ${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
