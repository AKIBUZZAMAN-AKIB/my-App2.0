// UI/UX screenshots at a phone viewport (390x844) against the mock NativeKit.
// Chat with generative UI written as raw JSON / js fences, the map, the agent panel tabs
// and the header with the brain (context) button.
//   node tools/agent-html-tests/shots-uiux.js        (OUT=/tmp/uiux-shots DARK=1)
const path = require('path');
const fs = require('fs');
const PW = process.env.PW || require.resolve('./pw.js');
const { chromium } = require(PW);
const EXE = process.env.EXE || (() => {
  const base = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright');
  const dir = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop() : null;
  return dir ? path.join(base, dir, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined;
})();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const OUT = process.env.OUT || '/tmp/uiux-shots';
const TILES = process.env.TILES === '1'; // 1: let real OSM tiles load (needs network)
fs.mkdirSync(OUT, { recursive: true });
const mock = fs.readFileSync(path.join(__dirname, 'mock3.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'mock-v2.js'), 'utf8')
  // The engine the app runs on advertises the context tree; so does this mock.
  + `\n{ const a = window.NativeKit.agent; const g = a.getEngineFeatures; a.getEngineFeatures = async () => { const r = await g(); return { ...r, features: [...r.features, 'contextTree', 'countTokens'] }; };
     a.subagents = async (req) => (req && req.action === 'ctx.tree' ? {} : { ok: true }); }`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` :: ${extra}` : ''}`);

async function open(browser, dark) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 3).join(' <- ')}`));
  if (!TILES) {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await p.route(/^https?:\/\//, (route) => (/tile|\.png/.test(route.request().url()) ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : route.fulfill({ status: 404, body: '' })));
  }
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 15000 });
  await sleep(300);
  return { p, ctx, errs };
}

async function newTurn(p, text) {
  await p.locator('.aui-composer-input').first().fill(text);
  await p.locator('.aui-composer-send').first().click();
  await sleep(250);
  return p.evaluate(() => {
    const c = window.__mock.calls;
    return [...c].reverse().find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey || [...c].reverse().find((x) => x.name === 'agent.sendMessage')?.args?.sessionKey || 'main';
  });
}
const emit = (p, list) => p.evaluate((list) => { for (const [t, d] of list) window.__mock.emit(t, d); }, list);
async function reply(p, k, text) {
  const chunks = text.match(/[\s\S]{1,40}/g);
  for (let i = 0; i < chunks.length; i += 4) { await emit(p, chunks.slice(i, i + 4).map((d) => ['text_delta', { sessionKey: k, delta: d }])); await sleep(15); }
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await sleep(700);
}
async function weatherTool(p, k) {
  const data = { id: 'wx-rajshahi', source: 'Open-Meteo.com (CC BY 4.0)', location: { name: 'Rajshahi', admin1: 'Rajshahi Division', country: 'Bangladesh', latitude: 24.374, longitude: 88.60114, timezone: 'Asia/Dhaka' }, units: { temperature: '\u00B0C', wind: 'km/h', precipitation: 'mm' }, current: { time: '2026-11-25T16:00', temperature: 24.6, apparent_temperature: 25.1, relative_humidity: 58, wind_speed: 7.2, wind_direction: 300, precipitation: 0, weather_code: 1, is_day: true }, daily: [0, 1, 2, 3, 4].map((i) => ({ date: `2026-11-2${5 + i}`, weather_code: [1, 2, 3, 61, 0][i], max: [27, 26, 25, 24, 26][i], min: [15, 15, 16, 17, 15][i], precipitation_probability: [0, 5, 20, 60, 0][i], precipitation: [0, 0, 0, 3.1, 0][i] })) };
  const output = `<untrusted_tool_result>\nWeather for Rajshahi, Bangladesh.\nShow it to the user as a Weather card whose id is wx-rajshahi.\n${JSON.stringify(data)}\n</untrusted_tool_result>`;
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'wx1', toolName: 'get_weather', args: { location: 'Rajshahi' } }]]);
  await emit(p, [['tool_result', { sessionKey: k, toolCallId: 'wx1', result: { output } }]]);
  await sleep(200);
}

async function shot(p, name, sel) {
  const file = path.join(OUT, `${name}.png`);
  if (sel) await p.locator(sel).first().screenshot({ path: file });
  else await p.screenshot({ path: file });
  return file;
}

async function hOverflow(p) {
  return p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const dark = process.env.DARK === '1';
  const { p, errs } = await open(browser, dark);
  const sfx = dark ? '-dark' : '';
  await shot(p, `01-header-welcome${sfx}`);

  // 1) Weather + card trees written as raw JSON / a js fence in the reply text.
  let k = await newTurn(p, 'What is the weather in Rajshahi?');
  await weatherTool(p, k);
  await reply(p, k, 'Here is the weather for Rajshahi:\n\n{"props":{"id":"wx-rajshahi"},"type":"Weather"}\n\n{"children":[{"props":{"text":"Good day for a walk"},"type":"Heading"},{"props":{"text":"Light wind, no rain until Saturday."},"type":"Text"}],"props":{"title":"Today"},"type":"Card"}\n\nEnjoy your day.');
  const rendered = await p.evaluate(() => {
    const last = [...document.querySelectorAll('.aui-assistant-message-content')].pop();
    return { gu: last ? last.querySelectorAll('.gu-root').length : 0, raw: last ? /"type":"Weather"/.test(last.textContent) : true };
  });
  ck('raw JSON specs in text render as UI', rendered.gu >= 2 && !rendered.raw, JSON.stringify(rendered));
  await p.evaluate(() => { const v = document.querySelector('.aui-thread-viewport'); v.scrollTop = v.scrollHeight; });
  await sleep(400);
  await shot(p, `02-chat-weather-card${sfx}`);

  // 2) A flat {root, elements} spec inside a ```js fence.
  k = await newTurn(p, 'Plan my day');
  await reply(p, k, 'Your plan:\n\n```js\n{"root":"main","elements":{"main":{"type":"Stack","props":{"gap":"md"},"children":["head","facts"]},"head":{"type":"Header","props":{"title":"Wednesday plan","subtitle":"Rajshahi"}},"facts":{"type":"Facts","props":{"items":[{"label":"Class","value":"10:00 AM"},{"label":"Lab","value":"2:00 PM"},{"label":"Gym","value":"6:30 PM"}]}}},"state":{}}\n```\n');
  const flat = await p.evaluate(() => {
    const last = [...document.querySelectorAll('.aui-assistant-message-content')].pop();
    return { gu: last ? last.querySelectorAll('.gu-root').length : 0, code: last ? last.querySelectorAll('.aui-code-block:not([hidden])').length : 0 };
  });
  ck('flat spec in a js fence renders as UI', flat.gu >= 1, JSON.stringify(flat));
  await p.evaluate(() => { const v = document.querySelector('.aui-thread-viewport'); v.scrollTop = v.scrollHeight; });
  await sleep(300);
  await shot(p, `03-chat-flat-spec${sfx}`);

  // 3) Map: keyless OpenStreetMap tiles.
  k = await newTurn(p, 'Show Rajshahi University on a map');
  await reply(p, k, 'Here it is:\n\n```json\n{"type":"Map","props":{"label":"University of Rajshahi","latitude":24.3636,"longitude":88.6241,"zoom":14}}\n```');
  const map = await p.evaluate(() => {
    const last = [...document.querySelectorAll('.aui-assistant-message-content')].pop();
    const m = last?.querySelector('.gu-map');
    const tiles = [...(last?.querySelectorAll('.gu-map img') || [])].map((i) => i.src);
    return { map: !!m, tiles: tiles.length, osm: tiles.every((s) => /tile\.openstreetmap\.org/.test(s)), keyAsk: /api key/i.test(last?.textContent || '') };
  });
  ck('map renders with keyless OSM tiles', map.map && map.tiles > 0 && map.osm && !map.keyAsk, JSON.stringify(map));
  await sleep(TILES ? 2500 : 300);
  await p.evaluate(() => { const v = document.querySelector('.aui-thread-viewport'); v.scrollTop = v.scrollHeight; });
  await sleep(300);
  await shot(p, `04-chat-map${sfx}`);

  // 4) Header: brain button opens the context view; no context pill in the composer.
  const head = await p.evaluate(() => ({
    brain: !!document.querySelector('[data-action="open-context"]'),
    pill: !!document.querySelector('.aui-composer-root .tk-meter:not([hidden])'),
  }));
  ck('brain button in header, no context pill in composer', head.brain && !head.pill, JSON.stringify(head));
  await shot(p, `05-header${sfx}`, '.aui-header, header');
  // Context data for the context view (what the engine sends as context.tree).
  await p.evaluate(() => {
    window.__runtime = window.__runtime || { action: async () => ({ ok: true }) };
    const row = (rid, title, colour, extra = {}) => ({ id: 'mem/' + rid, rid, tag: '#' + rid.toLowerCase(), title, line: '- ' + title, status: 'current', turn: 3, pick: 'auto', versionsMode: 'latest', reason: colour, colour, versionCount: 1, versions: [], ...extra });
    window.__contextTree?.onEvent('context.tree', {
      counts: { in: 5, out: 1 }, tokens: { selected: 26200, window: 128000 },
      items: [
        { id: 'turn/t1', state: 'in', title: 'What is the weather in Rajshahi?', tokens: 5400 },
        { id: 'turn/t2', state: 'in', title: 'Plan my day with class, lab and gym times', tokens: 7300 },
        { id: 'turn/t3', state: 'in', title: 'Show Rajshahi University on a map', tokens: 6100 },
        { id: 'tool/t3/wx1', state: 'in', title: 'get_weather \u00b7 Rajshahi, Bangladesh (Open-Meteo forecast for five days)', tokens: 3900 },
        { id: 'turn/t0', state: 'out', title: 'An older long conversation about the build pipeline and release numbering', tokens: 9100, reason: 'budget' },
      ],
      memory: { alwaysOn: true, counts: { sent: 2, leftOut: 1, showMore: 0, inactive: 1 },
        tags: [{ tag: '#d1', rid: 'D1', state: 'active', mentions: 3, lastTurn: 3 }, { tag: '#f1', rid: 'F1', state: 'inactive', mentions: 1, lastTurn: 1 }],
        groups: [
          { id: 'mem', title: 'Chat memory', parent: null, count: 0, items: [] },
          { id: 'mem.decisions', title: 'Decisions in force', parent: 'mem', count: 1, items: [row('D1', 'Use OpenStreetMap tiles for maps, no API key', 'sent', { tagState: 'active' })] },
          { id: 'mem.facts', title: 'Facts', parent: 'mem', count: 2, items: [row('F1', 'Home city is Rajshahi, Bangladesh', 'inactive', { tagState: 'inactive' }), row('F2', 'Prefers short, minimal answers', 'sent')] },
        ] },
    });
  });
  if (head.brain) {
    await p.locator('[data-action="open-context"]').first().click();
    await sleep(600);
    await shot(p, `06-context-view${sfx}`);
    await p.keyboard.press('Escape');
    await sleep(300);
  }

  // 5) The agent panel (Checklist / Summary / Log / Settings) is the context card: open it from the brain button.
  if (head.brain) {
    await p.locator('[data-action="open-context"]').first().click();
    await sleep(500);
    const tabs = await p.$$eval('.ct-panel [role="tab"]', (ts) => ts.map((t) => t.textContent.trim()));
    for (let i = 0; i < tabs.length; i++) {
      await p.locator('.ct-panel [role="tab"]').nth(i).click();
      await sleep(400);
      const name = tabs[i].toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '') || `tab${i}`;
      await shot(p, `07-agent-panel-${name}${sfx}`);
      const fit = await p.evaluate(() => {
        const root = document.querySelector('.ct-panel');
        const r = root.getBoundingClientRect();
        const cut = [...root.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > r.right + 1 || b.left < r.left - 1); }).map((e) => e.className).slice(0, 5);
        return { onScreen: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, cut, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 };
      });
      ck(`agent panel ${tabs[i]}: on screen, nothing cut on the right`, fit.onScreen && !fit.cut.length && fit.page, JSON.stringify(fit));
    }
    await p.keyboard.press('Escape');
  }
  ck('no console errors', !errs.length, errs.slice(0, 5).join(' | '));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
