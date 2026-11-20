// Provider errors and the Sections sheet: a mid-stream gateway failure never
// leaves the chat on "Thinking…", the error reads in plain words, a transient
// failure gets exactly one automatic retry, and the sheet takes no space.
// Mock NativeKit only; no network. Run: node provider-errors.js
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const mock = fs.readFileSync(path.join(__dirname, 'mock3.js'), 'utf8');
const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GATEWAY = "API error (502): JSON error injected into SSE stream (provider 'kilo', model 'kilo-auto/free')";

async function open(browser, dark) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(250);
  return { p, ctx, errs };
}
async function send(p, text) {
  await p.locator('.aui-composer-input').first().fill(text);
  await p.locator('.aui-composer-send').first().click();
  await sleep(300);
  const c = await p.evaluate(() => window.__mock.calls);
  const last = [...c].reverse().find((x) => x.name === 'agent.sendMessage' || x.name === 'agent.followUp');
  return { sessionKey: last?.args?.sessionKey || [...c].reverse().find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey, count: c.filter((x) => x.name === 'agent.sendMessage' || x.name === 'agent.followUp').length };
}
const emit = (p, events) => p.evaluate((ev) => { for (const [n, d] of ev) window.__mock.emit(n, d); }, events);
const sends = (p) => p.evaluate(() => window.__mock.calls.filter((x) => x.name === 'agent.sendMessage' || x.name === 'agent.followUp').length);
const thread = (p) => p.evaluate(() => document.querySelector('.aui-thread-viewport')?.innerText || '');
const thinking = (p) => p.evaluate(() => /Thinking/.test(document.querySelector('.aui-thread-viewport')?.innerText || '') || !!document.querySelector('.aui-thread-viewport [data-status="running"]'));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  try {
    for (const dark of [false, true]) {
      const tag = dark ? 'dark' : 'light';
      const { p, ctx, errs } = await open(browser, dark);

      // -- the sheet takes no space, opens from the top bar, lists real screens
      const closed = await p.evaluate(() => ({ sh: document.documentElement.scrollHeight, vh: innerHeight, shell: getComputedStyle(document.querySelector('.as-sheet')).display, trigger: !!document.querySelector('.topbar .as-trigger'), note: /Pick a screen from the bar/.test(document.body.innerText) }));
      check(`${tag} sheet closed: page is one screen tall`, closed.sh <= closed.vh && closed.shell === 'none', JSON.stringify(closed));
      check(`${tag} no placeholder note above the chat`, !closed.note);
      check(`${tag} Sections button is in the top bar`, closed.trigger);
      await p.locator('.topbar .as-trigger').click();
      await sleep(250);
      const opened = await p.evaluate(() => ({ items: [...document.querySelectorAll('.as-item-label')].map((e) => e.textContent), bg: getComputedStyle(document.querySelector('.as-sheet')).backgroundColor, body: getComputedStyle(document.body).backgroundColor }));
      check(`${tag} sheet lists Agents, Files, Vault, Settings`, ['Agents', 'Files', 'Vault', 'Settings'].every((x) => opened.items.includes(x)), opened.items.join(','));
      check(`${tag} sheet follows the theme`, dark ? opened.bg !== 'rgb(255, 255, 255)' : true, opened.bg);
      await p.locator('.as-item[data-go="swarm"]').click();
      await sleep(200);
      const swarm = await p.evaluate(() => ({ title: document.querySelector('.as-title')?.textContent, empty: !!document.querySelector('.as-empty') }));
      check(`${tag} a panel opens inside the sheet with its own title`, swarm.title === 'Swarm' && swarm.empty, JSON.stringify(swarm));
      await p.keyboard.press('Escape');
      await sleep(200);
      check(`${tag} Escape closes the sheet`, await p.evaluate(() => document.querySelector('.as-sheet').hidden));
      await p.locator('.topbar .as-trigger').click();
      await sleep(150);
      await p.locator('.as-item[data-go="settings"]').click();
      await sleep(400);
      check(`${tag} Settings row opens the real settings screen`, await p.evaluate(() => document.querySelector('.as-sheet').hidden && !!document.getElementById('settings-panel')));
      await p.keyboard.press('Escape');
      await sleep(300);

      // -- reasoning streamed, then the gateway's mid-stream 502 -------------
      const a = await send(p, 'Hi .. what you can do... What\'s your power');
      const k = a.sessionKey;
      await emit(p, [['agent.thinking', { sessionKey: k, delta: 'Let me think' }]]);
      await sleep(150);
      check(`${tag} shows Thinking while the model reasons`, await thinking(p));
      // the engine retries in place: stream.reset drops the void partial
      await emit(p, [['stream.reset', { sessionKey: k, reason: 'retry' }], ['retry', { sessionKey: k, attempt: 1, delayMs: 1000 }]]);
      await sleep(150);
      // ...and then gives up with the gateway error
      const before = await sends(p);
      await emit(p, [['agent.error', { sessionKey: k, error: GATEWAY }]]);
      await sleep(300);
      const t1 = await thread(p);
      check(`${tag} error ends the Thinking state`, !(await thinking(p)), t1.slice(-200));
      check(`${tag} error is explained in plain words`, /temporary failure/i.test(t1) && /kilo/.test(t1), t1.slice(-300));
      await sleep(1800);
      const after = await sends(p);
      check(`${tag} one automatic retry for an empty transient failure`, after === before + 1, `${before} -> ${after}`);
      // the retry fails the same way: no second automatic retry
      await emit(p, [['agent.error', { sessionKey: k, error: GATEWAY }]]);
      await sleep(1900);
      check(`${tag} never a second automatic retry for the same turn`, (await sends(p)) === after);
      check(`${tag} Retry button offered`, await p.evaluate(() => !!document.querySelector('.aui-retry, [aria-label="Retry"]')));
      check(`${tag} still not stuck on Thinking`, !(await thinking(p)));

      // -- a late duplicate error with no live run adds no ghost message -----
      const n0 = await p.evaluate(() => document.querySelectorAll('.aui-thread-viewport [data-role="assistant"], .aui-assistant-message-root').length);
      await emit(p, [['agent.error', { sessionKey: k, error: GATEWAY }]]);
      await sleep(300);
      const n1 = await p.evaluate(() => document.querySelectorAll('.aui-thread-viewport [data-role="assistant"], .aui-assistant-message-root').length);
      check(`${tag} a duplicate error adds no empty message`, n1 === n0, `${n0} -> ${n1}`);

      // -- a non-transient error (bad key) is not retried ---------------------
      const b = await send(p, 'again');
      const s0 = await sends(p);
      await emit(p, [['agent.error', { sessionKey: b.sessionKey, error: "API error (401): invalid api key (provider 'openai', model 'gpt-5')" }]]);
      await sleep(1900);
      const t2 = await thread(p);
      check(`${tag} 401 tells the user to check the key`, /rejected the API key/.test(t2), t2.slice(-200));
      check(`${tag} 401 is not retried automatically`, (await sends(p)) === s0);

      if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/provider-error-${tag}.png` });
      check(`${tag} no console errors`, !errs.length, errs.slice(0, 3).join(' | '));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => r.startsWith('FAIL'));
  results.forEach((r) => console.log(r));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('provider-errors suite crashed:', e); process.exit(1); });
