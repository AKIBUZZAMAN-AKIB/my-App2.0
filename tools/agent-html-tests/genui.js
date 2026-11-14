// Generative UI checks (render_spec, present, edit_widget, preview_widget, read_me, set_theme,
// device-tool cards, notepad) in real headless Chromium. Mock NativeKit only; outside requests are
// answered locally (map tiles get a 1x1 PNG), so nothing leaves the machine.
//   node tools/agent-html-tests/genui.js          (ONLY=spec,update SIZES=320,1366 to narrow)
const path = require('path');
const fs = require('fs');
const PW = process.env.PW || '/tmp/pw/node_modules/playwright-core';
const { chromium } = require(PW);
const EXE = process.env.EXE || (() => {
  const base = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright');
  const dir = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop() : null;
  return dir ? path.join(base, dir, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined;
})();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/tmp/genui-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync(path.join(__dirname, 'mock3.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'mock-v2.js'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` :: ${extra}` : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const SIZES = (process.env.SIZES || '320,375,768,1366').split(',').map(Number);

async function open(browser, w, dark) {
  const mobile = w < 700;
  const ctx = await browser.newContext({ viewport: { width: w, height: mobile ? 780 : 900 }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'system'); } catch { /* blocked */ } });
  const p = await ctx.newPage();
  const errs = []; const net = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 3).join(' <- ')}`));
  await p.route(/^https?:\/\//, (route) => {
    const u = route.request().url();
    net.push(u);
    if (/basemaps\.cartocdn\.com|upload\.wikimedia\.org/.test(u)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.fulfill({ status: 404, body: '' });
  });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 10000 });
  await p.waitForFunction(() => window.__mock?.uiTools?.has('render_spec'), null, { timeout: 5000 }).catch(() => {});
  await sleep(200);
  return { p, ctx, errs, net };
}

const overflow = (p) => p.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('.gu-root *, .aui-thread-viewport *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === 'hidden') continue;
    let a = el.parentElement; let clipped = false;
    while (a && a !== document.body) { const o = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(o.overflowX)) { clipped = true; break; } a = a.parentElement; }
    if (!clipped && (r.right > w + 1 || r.left < -1)) bad.push(`${el.tagName}.${String(el.className.baseVal ?? el.className)}`.slice(0, 70) + ` ${Math.round(r.left)}-${Math.round(r.right)}`);
  }
  return { ok: document.documentElement.scrollWidth <= w && !bad.length, w, sw: document.documentElement.scrollWidth, bad: bad.slice(0, 4) };
});

async function newTurn(p, text) {
  await p.locator('.aui-composer-input').first().fill(text);
  await p.locator('.aui-composer-send').first().click();
  await sleep(250);
  return p.evaluate(() => {
    const c = window.__mock.calls;
    return [...c].reverse().find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey || [...c].reverse().find((x) => x.name === 'agent.sendMessage')?.args?.sessionKey || 'main';
  });
}

/** Runs a UI tool the way the engine does: the tool call event, execute(), then the result event. */
async function callTool(p, k, id, name, args, { complete = false } = {}) {
  await p.evaluate(([k, id, name, args]) => window.__mock.emit('tool_use', { sessionKey: k, toolCallId: id, toolName: `ui__${name}`, args }), [k, id, name, args]);
  const out = await p.evaluate(async ([k, id, name, args]) => {
    const t = window.__mock.uiTools.get(name);
    if (!t) return { error: `no tool ${name}` };
    try { const r = await t.execute(args, { toolCallId: id, sessionKey: k, signal: new AbortController().signal }); return { ok: true, text: typeof r === 'string' ? r : JSON.stringify(r) }; } catch (e) { return { ok: false, text: String(e?.message || e) }; }
  }, [k, id, name, args]);
  await p.evaluate(([k, id, out]) => window.__mock.emit('tool_result', { sessionKey: k, toolCallId: id, result: { output: out.text, isError: !out.ok } }), [k, id, out]);
  if (complete) await p.evaluate((k) => window.__mock.emit('agent.completed', { sessionKey: k }), k);
  await sleep(350);
  return out;
}
const done = (p, k) => p.evaluate((k) => window.__mock.emit('agent.completed', { sessionKey: k }), k).then(() => sleep(300));
const lines = (...ops) => ops.map((o) => JSON.stringify(o)).join('\n');
const add = (path, value) => ({ op: 'add', path, value });

const BUDGET = lines(
  add('/root', 'main'),
  add('/state', { people: 4, nights: 3, rate: 2500, food: 900, items: [{ name: 'Bus tickets', cost: 1200 }, { name: 'Museum', cost: 300 }], name: '', mode: 'budget', tab: 0 }),
  add('/elements/main', { type: 'Stack', props: { gap: 'md' }, children: ['hdr', 'tabs'] }),
  add('/elements/hdr', { type: 'Header', props: { eyebrow: 'Trip planner', title: 'Cox\u2019s Bazar weekend', subtitle: 'Adjust the sliders; totals update live.', icon: '\uD83C\uDFD6\uFE0F' } }),
  add('/elements/tabs', { type: 'Tabs', props: { tabs: ['Plan', 'Costs'], value: { $bindState: '/tab' } }, children: ['plan', 'costs'] }),
  add('/elements/plan', { type: 'Stack', props: { gap: 'sm' }, children: ['who', 'people', 'nights', 'mode', 'grid', 'go'] }),
  add('/elements/who', { type: 'Input', props: { label: 'Trip name', placeholder: 'e.g. Family trip', value: { $bindState: '/name' } } }),
  add('/elements/people', { type: 'Stepper', props: { label: 'People', value: { $bindState: '/people' }, min: 1, max: 12 } }),
  add('/elements/nights', { type: 'Slider', props: { label: 'Nights', value: { $bindState: '/nights' }, min: 1, max: 10, unit: 'nights' } }),
  add('/elements/mode', { type: 'ChoiceChips', props: { options: [{ value: 'budget', label: 'Budget' }, { value: 'comfort', label: 'Comfort' }], value: { $bindState: '/mode' } } }),
  add('/elements/grid', { type: 'Grid', props: { columns: 2 }, children: ['s1', 's2'] }),
  add('/elements/s1', { type: 'Stat', props: { label: 'Hotel', value: { $calc: "currency(${/nights} * ${/rate} * (${/mode} == 'comfort' ? 1.6 : 1), 'BDT')" } } }),
  add('/elements/s2', { type: 'Stat', props: { label: 'Total', value: { $calc: "currency(${/nights} * ${/rate} * (${/mode} == 'comfort' ? 1.6 : 1) + ${/people} * ${/food} * ${/nights} + sum(${/items}, '/cost'), 'BDT')" }, delta: { $template: '${/people} people' } } }),
  add('/elements/go', { type: 'Button', props: { label: 'Book this plan' }, on: { press: { action: 'sendMessage', params: { text: { $template: 'Book ${/nights} nights for ${/people} people' } } } } }),
  add('/elements/costs', { type: 'Stack', props: { gap: 'sm' }, children: ['row'], repeat: { path: '/items', key: 'name' } }),
  add('/elements/row', { type: 'Card', props: { variant: 'outline', title: { $item: '/name' }, subtitle: { $calc: "currency(${$item/cost}, 'BDT')" } } }),
);

const PRESENT_TREE = { type: 'Stack', children: [
  { type: 'Header', props: { eyebrow: 'Rajshahi', title: 'Mango season report', subtitle: 'Prices and arrivals at the Baneshwar market' } },
  { type: 'Grid', props: { columns: 3 }, children: [
    { type: 'Stat', props: { label: 'Avg price', value: '\u09F385/kg', delta: '+12%', trend: 'up', good: 'down' } },
    { type: 'Stat', props: { label: 'Arrivals', value: '1,240 t', delta: '-4%', trend: 'down' } },
    { type: 'Stat', props: { label: 'Varieties', value: '9' } }] },
  { type: 'Chart', props: { type: 'line', title: 'Daily price', unit: '\u09F3/kg', labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], series: [{ name: 'Himsagar', values: [80, 82, 85, 84, 88, 90, 89] }, { name: 'Langra', values: [70, 71, 75, 74, 73, 78, 80] }] } },
  { type: 'Chart', props: { type: 'bar', title: 'Arrivals by variety', data: [{ label: 'Himsagar', value: 420 }, { label: 'Langra', value: 310 }, { label: 'Fazli', value: 280 }, { label: 'Amrapali', value: 230 }] } },
  { type: 'Chart', props: { type: 'donut', title: 'Market share', data: [{ label: 'Himsagar', value: 34 }, { label: 'Langra', value: 25 }, { label: 'Fazli', value: 23 }, { label: 'Other', value: 18 }] } },
  { type: 'Table', props: { caption: 'Top sellers', columns: [{ key: 'v', label: 'Variety' }, { key: 'p', label: 'Price', format: 'currency' }, { key: 's', label: 'Share', format: 'percent' }], currency: 'BDT', rows: [{ v: 'Himsagar', p: 89, s: 0.34 }, { v: 'Langra', p: 80, s: 0.25 }, { v: 'A very long variety name that wraps', p: 75, s: 0.23 }] } },
  { type: 'Facts', props: { items: [{ label: 'Season', value: 'May \u2013 July' }, { label: 'Peak', value: 'June' }] } },
  { type: 'Alert', props: { tone: 'warning', title: 'Heat advisory', text: 'Afternoon temperatures may pass 38\u00B0C.' } },
  { type: 'Timeline', props: { items: [{ time: '6 AM', title: 'Market opens' }, { time: '9 AM', title: 'Peak trading', tone: 'accent' }, { time: '1 PM', title: 'Closes' }] } },
  { type: 'Steps', props: { current: 1, items: ['Pick', 'Sort', 'Pack', 'Ship'] } },
  { type: 'Progress', props: { label: 'Season done', value: 62 } },
  { type: 'List', props: { variant: 'check', items: [{ text: 'Buy crates', done: true }, { text: 'Hire truck', done: false }] } },
  { type: 'Map', props: { latitude: 24.3745, longitude: 88.6042, zoom: 13, label: 'Rajshahi', markers: [{ latitude: 24.369, longitude: 88.59, label: 'Baneshwar' }] } },
  { type: 'Carousel', props: { items: [{ title: 'Himsagar', subtitle: 'Sweet, fibreless', image: 'https://upload.wikimedia.org/a.jpg' }, { title: 'Langra', subtitle: 'Green when ripe' }, { title: 'Fazli', subtitle: 'Large, late' }] } },
  { type: 'Citations', props: { items: [{ title: 'DAE mango report', url: 'https://dae.gov.bd/report', snippet: 'Production estimates for 2026.' }, { url: 'https://en.wikipedia.org/wiki/Mango' }] } },
  { type: 'Code', props: { language: 'js', code: 'const total = prices.reduce((a, b) => a + b, 0);' } },
  { type: 'Weather', props: { data: { id: 'wx_test', location: { name: 'Rajshahi', country: 'Bangladesh' }, units: { temperature: '\u00B0C', wind: 'km/h' }, current: { temperature: 27.4, apparent_temperature: 29, relative_humidity: 64, wind_speed: 9, weather_code: 2 }, daily: [{ date: '2026-11-14', max: 29, min: 18, weather_code: 2, precipitation_probability: 5 }, { date: '2026-11-15', max: 28, min: 17, weather_code: 0, precipitation_probability: 0 }, { date: '2026-11-16', max: 27, min: 17, weather_code: 61, precipitation_probability: 60 }] } } },
] };

const S = {};

S.spec = async (p, tag) => {
  const k = await newTurn(p, 'Plan my trip');
  const r = await callTool(p, k, 'rs1', 'render_spec', { title: 'trip_budget', patches: BUDGET });
  ck(`${tag} render_spec answers without issues`, r.ok && /version 1/.test(r.text) && !/error/i.test(r.text), r.text);
  const info = await p.evaluate(() => {
    const root = document.querySelector('.gu-root[data-genui="trip_budget"]');
    return root && { text: root.innerText, stats: [...root.querySelectorAll('.gu-stat-value')].map((e) => e.textContent), tabs: root.querySelectorAll('[role=tab]').length, cards: root.querySelectorAll('.gu-card').length };
  });
  ck(`${tag} card drawn in the thread`, !!info && info.tabs === 2, JSON.stringify(info));
  ck(`${tag} $calc totals`, info && /7,500/.test(info.stats[0]) && /19,800/.test(info.stats[1].replace(/\s/g, '')), JSON.stringify(info?.stats));
  // interact: stepper +, slider, chips
  await p.locator('.gu-root[data-genui="trip_budget"] [aria-label="Increase People"]').click();
  await p.locator('.gu-root[data-genui="trip_budget"] .gu-chip', { hasText: 'Comfort' }).click();
  await sleep(150);
  const after = await p.evaluate(() => [...document.querySelectorAll('.gu-root[data-genui="trip_budget"] .gu-stat-value')].map((e) => e.textContent));
  ck(`${tag} controls update state and totals`, /12,000/.test(after[0]) && /27,000/.test(after[1].replace(/\s/g, '')), JSON.stringify(after));
  // typing keeps focus
  const input = p.locator('.gu-root[data-genui="trip_budget"] input.input');
  await input.click();
  await p.keyboard.type('Family trip', { delay: 30 });
  await sleep(500);
  const typed = await p.evaluate(() => ({ v: document.querySelector('.gu-root[data-genui="trip_budget"] input.input')?.value, focus: document.activeElement?.matches?.('.gu-root input.input') }));
  ck(`${tag} typing keeps the text and focus`, typed.v === 'Family trip' && typed.focus, JSON.stringify(typed));
  // keyboard tabs
  await p.locator('.gu-root[data-genui="trip_budget"] [role=tab]').first().focus();
  await p.keyboard.press('ArrowRight');
  await sleep(150);
  const tabState = await p.evaluate(() => ({ sel: document.querySelector('.gu-root[data-genui="trip_budget"] [role=tab][aria-selected=true]')?.textContent, focus: document.activeElement?.textContent, cards: document.querySelectorAll('.gu-root[data-genui="trip_budget"] .gu-card').length }));
  ck(`${tag} arrow keys switch tabs and repeat draws rows`, tabState.sel === 'Costs' && tabState.focus === 'Costs' && tabState.cards === 2, JSON.stringify(tabState));
  await p.keyboard.press('ArrowLeft');
  await done(p, k);
  return k;
};

S.update = async (p, tag) => {
  const k = await S.spec(p, `${tag} (setup)`);
  const k2 = await newTurn(p, 'Make it 5 nights and add a boat trip');
  const r = await callTool(p, k2, 'rs2', 'render_spec', { title: 'trip_budget', patches: lines({ op: 'replace', path: '/state/nights', value: 5 }, add('/state/items/-', { name: 'Boat trip', cost: 800 }), { op: 'replace', path: '/elements/hdr/props/title', value: 'Cox\u2019s Bazar, 5 nights' }) });
  await done(p, k2);
  ck(`${tag} same title gives version 2 and reports the user's values`, r.ok && /version 2/.test(r.text) && /Family trip/.test(r.text), r.text);
  const st = await p.evaluate(() => {
    const roots = [...document.querySelectorAll('.gu-root[data-genui="trip_budget"]')];
    const last = roots[roots.length - 1];
    return { n: roots.length, oldMarked: roots[0].classList.contains('gu-old'), bar: roots[0].querySelector('.gu-old-bar')?.innerText, title: last.querySelector('.gu-header-title')?.textContent, name: last.querySelector('input.input')?.value, people: last.querySelector('.gu-stepper-value')?.textContent, nights: last.querySelector('.gu-slider')?.value, mode: last.querySelector('.gu-chip[aria-pressed=true]')?.textContent, oldHidden: getComputedStyle(roots[0].querySelector('.gu-body')).display === 'none' };
  });
  ck(`${tag} old card says Updated below and folds`, st.n === 2 && st.oldMarked && /updated below/i.test(st.bar) && st.oldHidden, JSON.stringify(st));
  ck(`${tag} new version keeps typed name, people and mode`, st.name === 'Family trip' && st.people.startsWith('5') && /Comfort/.test(st.mode) && st.nights === '5' && /5 nights/.test(st.title), JSON.stringify(st));
  await p.locator('.gu-old-toggle').first().click();
  const shown = await p.evaluate(() => getComputedStyle(document.querySelector('.gu-old .gu-body')).display);
  ck(`${tag} older version can be opened`, shown === 'block', shown);
  // A tap on the button sends the message (trusted click only)
  const before = await p.evaluate(() => window.__mock.calls.length);
  const btns = p.locator('.gu-root[data-genui="trip_budget"]:not(.gu-old) .gu-btn', { hasText: 'Book this plan' });
  await btns.last().click();
  await sleep(300);
  const sent = await p.evaluate((n) => window.__mock.calls.slice(n).find((x) => x.name === 'agent.sendMessage' || x.name === 'agent.followUp'), before);
  const prompt = typeof sent?.args === 'string' ? sent.args : sent?.args?.prompt ?? sent?.args?.message;
  ck(`${tag} sendMessage action sends the filled text`, /Book 5 nights for 5 people/.test(prompt || ''), JSON.stringify(sent));
};

S.present = async (p, tag, env) => {
  const k = await newTurn(p, 'Mango report');
  const r = await callTool(p, k, 'pr1', 'present', { tree: PRESENT_TREE }, { complete: true });
  ck(`${tag} present answers`, r.ok && /Shown to the user/.test(r.text), r.text);
  const info = await p.evaluate(() => {
    const root = [...document.querySelectorAll('.gu-root[data-tool=present]')].pop();
    const q = (s) => root.querySelectorAll(s).length;
    return { charts: q('.gu-chart svg'), bars: q('.gu-chart-svg rect.gu-s0'), slices: q('.gu-pie path'), table: q('.gu-table tbody tr'), tiles: q('.gu-map-tiles img'), pins: q('.gu-map-pin'), weather: root.querySelector('.gu-weather-temp')?.textContent, days: q('.gu-weather-days li'), notices: [...root.querySelectorAll('.gu-notice')].map((n) => n.textContent), steps: [...root.querySelectorAll('.gu-steps li')].map((l) => l.dataset.status).join(','), srTable: q('.gu-chart table.sr-only') };
  });
  ck(`${tag} every display component drawn`, info.charts === 3 && info.slices === 4 && info.table === 3 && info.pins === 2 && info.days === 3 && !info.notices.length && info.steps === 'done,current,pending,pending', JSON.stringify(info));
  ck(`${tag} charts carry a data table for screen readers`, info.srTable === 3, String(info.srTable));
  ck(`${tag} map tiles load from CARTO`, info.tiles > 0 && env.net.some((u) => /basemaps\.cartocdn\.com\/(light|dark)_all/.test(u)), `${info.tiles}`);
  const dark = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  ck(`${tag} map uses ${dark ? 'dark' : 'light'} tiles`, env.net.some((u) => u.includes(dark ? 'dark_all' : 'light_all')));
  ck(`${tag} weather card from data`, /27/.test(info.weather || ''), info.weather);
  // zoom
  const z0 = await p.evaluate(() => [...document.querySelectorAll('.gu-map-tiles img')].pop()?.src.match(/_all\/(\d+)\//)?.[1]);
  await p.locator('.gu-map [aria-label="Zoom in"]').last().click();
  await sleep(150);
  const z1 = await p.evaluate(() => [...document.querySelectorAll('.gu-map-tiles img')].pop()?.src.match(/_all\/(\d+)\//)?.[1]);
  ck(`${tag} map zoom works`, Number(z1) === Number(z0) + 1, `${z0}->${z1}`);
};

S.errors = async (p, tag) => {
  const k = await newTurn(p, 'Broken UI');
  const bad = await callTool(p, k, 'bad1', 'render_spec', { title: 'broken', patches: '{"op":"add","path":"/root","value":"m"}\nnot json\n{"op":"add","path":"/elements/m","value":{"type":"Column","children":["x"]}}' });
  ck(`${tag} bad lines and wrong component reported with fixes`, /line 2/.test(bad.text) && /Stack/.test(bad.text), bad.text);
  const none = await callTool(p, k, 'bad2', 'render_spec', { title: 'empty', patches: '{"op":"add","path":"/state","value":{}}' });
  ck(`${tag} a spec with no root is an error`, !none.ok && /root/i.test(none.text), none.text);
  const missing = await callTool(p, k, 'bad3', 'render_spec', {});
  ck(`${tag} missing title is an error`, !missing.ok && /title/.test(missing.text), missing.text);
  await done(p, k);
  const visible = await p.evaluate(() => document.querySelector('.gu-root[data-genui="broken"]')?.innerText || '');
  ck(`${tag} broken element shows a calm notice`, /Unknown component|could not/i.test(visible), visible.slice(0, 120));
};

const COUNTER = '<div class="box"><h2 id="t">Count: 0</h2><button id="b" style="min-height:44px">Add one</button></div>\n<style>.box{padding:12px;border:1px solid var(--aui-border);border-radius:12px}</style>\n<script>let n=0;b.onclick=()=>{t.textContent="Count: "+(++n)}</script>';

S.edit = async (p, tag) => {
  const k = await newTurn(p, 'Counter please');
  const sh = await callTool(p, k, 'h1', 'show_html', { title: 'counter', html: COUNTER });
  ck(`${tag} show_html names its title for edit_widget`, sh.ok && /"counter"/.test(sh.text) && /edit_widget/.test(sh.text), sh.text);
  const e1 = await callTool(p, k, 'e1', 'edit_widget', { title: 'counter', edits: [{ old_string: 'Count: 0', new_string: 'Clicks: 0' }, { old_string: '"Count: "', new_string: '"Clicks: "' }] });
  ck(`${tag} edit_widget applies ordered edits and render-checks them`, e1.ok && /Applied 2 edits/.test(e1.text) && /version 2/.test(e1.text) && /Render check at 320 px: no errors/.test(e1.text), e1.text);
  const st = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.wt-html[data-title="counter"]')];
    const last = cards[cards.length - 1];
    return { n: cards.length, oldFolded: cards[0]?.classList.contains('gu-old'), bar: cards[0]?.querySelector('.gu-old-bar')?.innerText || '', lastOld: last?.classList.contains('gu-old'), src: last?.querySelector('iframe')?.srcdoc || '' };
  });
  ck(`${tag} edited widget drawn below, older one folds to updated below`, st.n === 2 && st.oldFolded && /updated below/i.test(st.bar) && !st.lastOld && /Clicks: 0/.test(st.src) && !/Count: 0/.test(st.src), JSON.stringify({ ...st, src: st.src.length }));
  const amb = await callTool(p, k, 'e2', 'edit_widget', { title: 'counter', edits: [{ old_string: 'Clicks', new_string: 'Taps' }] });
  ck(`${tag} ambiguous old_string fails and changes nothing`, !amb.ok && /(more than once|2 places|ambiguous|matches \d)/i.test(amb.text) && /Nothing was changed/.test(amb.text), amb.text);
  const part = await callTool(p, k, 'e3', 'edit_widget', { title: 'counter', edits: [{ old_string: 'Add one', new_string: 'Plus one' }, { old_string: 'not in the code', new_string: 'x' }] });
  ck(`${tag} one missing edit rolls back the whole call`, !part.ok && /(not found|does not occur|no match)/i.test(part.text), part.text);
  const nf = await callTool(p, k, 'e4', 'edit_widget', { title: 'nope', edits: [{ old_string: 'a', new_string: 'b' }] });
  ck(`${tag} unknown title lists what is shown`, !nf.ok && /"counter"/.test(nf.text), nf.text);
  const n = await p.evaluate(() => document.querySelectorAll('.wt-html[data-title="counter"]').length);
  ck(`${tag} failed edits draw nothing new`, n === 2, String(n));
  const e5 = await callTool(p, k, 'e5', 'edit_widget', { title: 'counter', edits: [{ old_string: 'Add one', new_string: 'Plus one' }] });
  const after = await p.evaluate(() => { const c = [...document.querySelectorAll('.wt-html[data-title="counter"]')]; return { n: c.length, folded: c.slice(0, -1).every((x) => x.classList.contains('gu-old')), src: c[c.length - 1].querySelector('iframe')?.srcdoc || '' }; });
  ck(`${tag} later edit builds on the last good version`, e5.ok && /version 3/.test(e5.text) && after.n === 3 && after.folded && /Plus one/.test(after.src) && /Clicks: 0/.test(after.src), e5.text + JSON.stringify({ ...after, src: after.src.length }));
  // A render_spec UI: its code is the spec JSON; typed values carry over.
  await callTool(p, k, 'rs1', 'render_spec', { title: 'trip_budget', patches: BUDGET });
  await done(p, k);
  await p.locator('.gu-root[data-genui="trip_budget"] input[type="text"], .gu-root[data-genui="trip_budget"] input:not([type])').first().fill('Family trip');
  await sleep(200);
  const k2 = await newTurn(p, 'Rename hotel');
  const e6 = await callTool(p, k2, 'e6', 'edit_widget', { title: 'trip_budget', edits: [{ old_string: '"label": "Hotel"', new_string: '"label": "Hotel stay"' }] });
  await done(p, k2);
  const sp = await p.evaluate(() => { const r = [...document.querySelectorAll('.gu-root[data-genui="trip_budget"]')]; const last = r[r.length - 1]; return { n: r.length, oldFolded: r[0].classList.contains('gu-old'), labels: [...last.querySelectorAll('.gu-stat-label')].map((e) => e.textContent), name: last.querySelector('input:not([type]), input[type="text"]')?.value }; });
  ck(`${tag} edit_widget on a spec gives version 2 and keeps typed values`, e6.ok && /Applied 1 edit\. Rendered "trip_budget" version 2/.test(e6.text) && /Family trip/.test(e6.text) && sp.n === 2 && sp.oldFolded && sp.labels.includes('Hotel stay') && sp.name === 'Family trip', e6.text + JSON.stringify(sp));
  const bad = await callTool(p, k2, 'e7', 'edit_widget', { title: 'trip_budget', edits: [{ old_string: '"root": "main"', new_string: '"root": "main' }] });
  ck(`${tag} an edit that breaks the JSON is refused`, !bad.ok && /not valid JSON/.test(bad.text), bad.text);
};

const BROKEN_HTML = '<div style="width:900px;background:#eee">Too wide</div><img src="https://example.com/x.png" alt="x"><script>undefinedFn()</script>';

S.preview = async (p, tag) => {
  const k = await newTurn(p, 'Check widgets');
  const good = await callTool(p, k, 'p1', 'preview_widget', { html: COUNTER });
  ck(`${tag} preview of good HTML: no problems, height and text`, good.ok && /No problems/.test(good.text) && /Height: \d+ px/.test(good.text) && /Count: 0/.test(good.text) && /Add one/.test(good.text), good.text);
  const bad = await callTool(p, k, 'p2', 'preview_widget', { html: BROKEN_HTML, width: 375 });
  ck(`${tag} preview reports the script error with its line`, bad.ok && /Script error: .*undefinedFn/.test(bad.text) && /line 1 of your HTML/.test(bad.text), bad.text);
  ck(`${tag} preview reports the blocked request`, /Blocked by the sandbox \(img-src\): https:\/\/example\.com\/x\.png/.test(bad.text), bad.text);
  ck(`${tag} preview reports sideways overflow at the width`, /Sideways overflow: the content is 9\d\d px wide in a 375 px frame/.test(bad.text) && /too wide: div/.test(bad.text), bad.text);
  const blank = await callTool(p, k, 'p3', 'preview_widget', { html: '<div style="height:40px"></div>' });
  ck(`${tag} preview reports blank output`, /Blank: nothing visible/.test(blank.text), blank.text);
  const sp = await callTool(p, k, 'p5', 'preview_widget', { patches: BUDGET, width: 320 });
  ck(`${tag} preview of a spec: drawn offscreen with its text`, sp.ok && /No problems/.test(sp.text) && /Hotel/.test(sp.text) && /7,500/.test(sp.text), sp.text);
  const spb = await callTool(p, k, 'p6', 'preview_widget', { patches: '{"op":"add","path":"/root","value":"m"}\n{"op":"add","path":"/elements/m","value":{"type":"Column","children":[]}}' });
  ck(`${tag} preview of a broken spec reports the fix`, spb.ok && /problem/.test(spb.text) && /Stack/.test(spb.text), spb.text);
  await callTool(p, k, 'rs1', 'render_spec', { title: 'trip_budget', patches: BUDGET });
  const sh = await callTool(p, k, 'p7', 'preview_widget', { title: 'trip_budget', patches: lines({ op: 'replace', path: '/state/nights', value: 4 }), appearance: 'dark' });
  ck(`${tag} preview of patches on a shown UI, dark`, sh.ok && /dark theme/.test(sh.text) && /10,000/.test(sh.text), sh.text);
  const rm = await callTool(p, k, 'p8', 'read_me', { modules: ['spec'] });
  const list = await callTool(p, k, 'p9', 'read_me', {});
  ck(`${tag} read_me returns guidance modules`, rm.ok && rm.text.length > 400 && list.ok && /spec/.test(list.text), `${rm.text.slice(0, 120)} | ${list.text.slice(0, 160)}`);
  await done(p, k);
  const ui = await p.evaluate(() => ({ checks: [...document.querySelectorAll('.wt-check')].map((e) => `${e.dataset.state}:${e.innerText}`), hosts: document.querySelectorAll('.wt-preview-host').length, gu: document.querySelectorAll('.gu-root').length }));
  ck(`${tag} previews show only a quiet status line, nothing left behind`, ui.hosts === 0 && ui.checks.some((c) => /^issues:Checked the HTML widget: \d+ problems? found/.test(c)) && ui.checks.some((c) => /^ok:Checked/.test(c)) && ui.checks.some((c) => /Read the UI guide: spec/.test(c)) && ui.gu === 1, JSON.stringify(ui));
};

S.theme = async (p, tag) => {
  const k = await newTurn(p, 'Make it dark');
  const start = await p.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), setting: localStorage.getItem('theme') }));
  const target = start.dark ? 'light' : 'dark';
  const other = start.dark ? 'dark' : 'light';
  // execute() waits for the tap, so run it without awaiting.
  await p.evaluate(([k, target]) => { window.__mock.emit('tool_use', { sessionKey: k, toolCallId: 'th1', toolName: 'ui__set_theme', args: { theme: target, reason: 'Easier on the eyes.' } }); window.__th1 = window.__mock.uiTools.get('set_theme').execute({ theme: target, reason: 'Easier on the eyes.' }, { toolCallId: 'th1', sessionKey: k, signal: new AbortController().signal }); }, [k, target]);
  await sleep(400);
  const card = await p.evaluate(() => { const c = document.querySelector('[data-slot="ask-card"]'); return c && { state: c.dataset.state, text: c.innerText, buttons: [...c.querySelectorAll('button')].map((b) => b.innerText) }; });
  ck(`${tag} set_theme shows a confirmation card`, card?.state === 'request' && new RegExp(`Switch to ${target} theme\\?`).test(card.text) && /Easier on the eyes/.test(card.text) && card.buttons.includes(`Switch to ${target}`), JSON.stringify(card));
  const still = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  ck(`${tag} nothing changes before the tap`, still === start.dark, String(still));
  await p.locator('[data-slot="ask-card-confirm"]').click();
  const out = await p.evaluate(() => window.__th1);
  await p.evaluate(([k, out]) => window.__mock.emit('tool_result', { sessionKey: k, toolCallId: 'th1', result: { output: out, isError: false } }), [k, out]);
  await sleep(350);
  const after = await p.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), setting: JSON.parse(localStorage.getItem('settings') || '{}').theme ?? null, receipt: document.querySelector('[data-slot="ask-card"]')?.innerText || '', undo: !!document.querySelector('[data-slot="ask-card-undo"]') }));
  ck(`${tag} confirm switches the app theme and reports it`, after.dark === (target === 'dark') && new RegExp(`^Switched to ${target} theme`).test(out) && new RegExp(`Switched to ${target} theme`).test(after.receipt) && after.undo, JSON.stringify({ out, ...after }));
  await p.locator('[data-slot="ask-card-undo"]').click();
  await sleep(200);
  const undone = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  ck(`${tag} Undo puts the old theme back`, undone === start.dark, String(undone));
  // Keep: nothing changes
  const r2 = p.evaluate(([k, target]) => { window.__mock.emit('tool_use', { sessionKey: k, toolCallId: 'th2', toolName: 'ui__set_theme', args: { theme: target } }); return window.__mock.uiTools.get('set_theme').execute({ theme: target }, { toolCallId: 'th2', sessionKey: k, signal: new AbortController().signal }); }, [k, target]);
  await sleep(400);
  await p.locator('[data-slot="ask-card-keep"]').click();
  const kept = await r2;
  const keptDark = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  ck(`${tag} Keep leaves the theme and tells the agent not to ask again`, /^The user kept the/.test(kept) && /Do not ask again/.test(kept) && keptDark === start.dark, kept);
  const same = await callTool(p, k, 'th3', 'set_theme', { theme: 'system' });
  ck(`${tag} asking for the current theme does not bother the user`, same.ok && /^Already system/.test(same.text), same.text);
  const bad = await callTool(p, k, 'th4', 'set_theme', { theme: 'purple' });
  ck(`${tag} an unknown theme is an error`, !bad.ok && /light.*dark.*system/.test(bad.text), bad.text);
  void other;
  // device__ask_user: the bridge's DOM event becomes a card; a tap answers it.
  await p.evaluate((k) => {
    window.__answers = [];
    window.addEventListener('nativekit:agent-ask-response', (e) => window.__answers.push(e.detail));
    window.__mock.emit('tool_use', { sessionKey: k, toolCallId: 'ask1', toolName: 'device__ask_user', args: { question: 'Which city should I check?', options: ['Rajshahi', 'Dhaka', 'Chittagong'] } });
    window.dispatchEvent(new CustomEvent('nativekit:agent-ask', { detail: { requestId: 'req-1', question: 'Which city should I check?', options: ['Rajshahi', 'Dhaka', 'Chittagong'] } }));
  }, k);
  await sleep(400);
  const opts = await p.evaluate(() => [...document.querySelectorAll('[data-slot="ask-option"]')].map((b) => b.innerText));
  ck(`${tag} ask_user question card shows its options`, opts.join('|') === 'Rajshahi|Dhaka|Chittagong', JSON.stringify(opts));
  await p.locator('[data-slot="ask-option"]', { hasText: 'Dhaka' }).click();
  await sleep(200);
  const ans = await p.evaluate(() => window.__answers);
  ck(`${tag} tapping an answer goes back to the bridge`, ans.length === 1 && ans[0].requestId === 'req-1' && ans[0].answer.answer === 'Dhaka' && ans[0].answer.index === 1, JSON.stringify(ans));
  await p.evaluate((k) => window.__mock.emit('tool_result', { sessionKey: k, toolCallId: 'ask1', result: { output: 'The user chose: Dhaka', isError: false } }), k);
  await done(p, k);
  const rec = await p.evaluate(() => [...document.querySelectorAll('[data-slot="ask-card"]')].pop()?.innerText || '');
  ck(`${tag} the card keeps the answer`, /You chose: Dhaka/.test(rec), rec);
};

const ORDER = ['spec', 'update', 'present', 'errors', 'edit', 'preview', 'theme'];
const EVERY_SIZE = new Set(['present', 'update', 'edit', 'preview', 'theme']);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  for (const dark of [false, true]) {
    for (const w of SIZES) {
      const tagBase = `${w}px ${dark ? 'dark' : 'light'}`;
      for (const name of ORDER) {
        if (ONLY && !ONLY.includes(name)) continue;
        if (!EVERY_SIZE.has(name) && w !== SIZES[0] && w !== SIZES[SIZES.length - 1]) continue;
        const env = await open(browser, w, dark);
        try {
          await S[name](env.p, `${tagBase} ${name}:`, env);
          await sleep(300);
          const of = await overflow(env.p);
          ck(`${tagBase} ${name}: no sideways scroll`, of.ok, JSON.stringify(of));
          await env.p.screenshot({ path: path.join(SHOTS, `${name}-${w}-${dark ? 'dark' : 'light'}.png`), fullPage: false });
          const roots = env.p.locator('.gu-root:not(.gu-old)');
          const n = await roots.count();
          if (n) await roots.last().screenshot({ path: path.join(SHOTS, `${name}-${w}-${dark ? 'dark' : 'light'}-card.png`) }).catch(() => {});
        } catch (e) {
          ck(`${tagBase} ${name}: ran`, false, String(e?.stack || e).split('\n').slice(0, 3).join(' | '));
        }
        // The preview scenario checks deliberately broken widgets: their own errors stay in their frame.
        const errs = env.errs.filter((e) => !/favicon|ERR_|Failed to load resource/.test(e) && !(name === 'preview' && /about:srcdoc|example\.com\/x\.png/.test(e)));
        ck(`${tagBase} ${name}: no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
        await env.ctx.close();
      }
    }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
