// Chat memory UI (57-memory.js): indicator, status (summarized / summarizing / pending), summary with
// current and superseded decisions, version history with repair evidence and a confirmed Revert,
// archived turns, stored results with unavailable ones, settings, events, errors, keyboard,
// and layout at 320/375/768/1366 px in light and dark: overflow, contrast, 44 px tap targets on touch.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/safe/shots';
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
const ind = (p) => p.evaluate(() => { const b = document.querySelector('[data-slot="memory-indicator"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { hidden: b.hidden || r.width === 0, state: b.dataset.state, label: b.getAttribute('aria-label'), count: b.querySelector('.cm-ind-count')?.textContent, w: r.width, h: r.height }; });

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
  const vals = await p.evaluate(() => [...document.querySelectorAll('.cm-num')].map((i) => ({ v: i.value, label: document.querySelector(`label[for="${i.id}"]`)?.textContent, desc: !!document.getElementById(i.getAttribute('aria-describedby')) })));
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

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testFeatureGate, testSummaryAndIndicator, testStatusStates, testHistoryRevert, testTurnsResults, testSettings, testEmptyAndInjection, testLayout };
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
