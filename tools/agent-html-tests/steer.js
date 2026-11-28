// Steer and Update beside the composer (docs/steer/PLAN.bn.md, step 0).
// Checks, at 320/375/768/1366 px in light and dark:
//  - idle: no Steer/Update buttons; while a reply runs with text typed: both show, beside Queue;
//  - Enter while running still queues (no steer call);
//  - Steer calls NativeKit.agent.steer({ text, id, mode: 'steer' }), clears the input, and shows a
//    bubble that goes pending -> applied on the engine's steer.accepted / steer.applied events;
//  - Update sends mode 'update';
//  - steer.unapplied (turn ended first) offers Send as message, which sends it as a normal message;
//  - after completion, a steer message in the transcript is styled as a steer, its engine header hidden;
//  - the steer inbox (unapplied after a restart) is shown on start;
//  - no horizontal overflow, no page errors.
// Mock NativeKit only; no network.
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { schemaGuard } = require('./tool-schemas.js');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const mock = fs.readFileSync(path.join(__dirname, 'mock3.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

const extraMock = `(() => {
  const a = window.NativeKit.agent;
  window.__steers = [];
  a.steer = async (o) => { window.__steers.push(JSON.parse(JSON.stringify(o))); return o && o.id ? o.id : null; };
  const innerSub = a.subagents;
  a.subagents = async (req) => {
    if (req && req.action === 'steer.inbox') return { json: JSON.stringify({ steers: [{ id: 'st-old000000001', sessionKey: 'x', text: 'left from last time', at: 1, status: 'unapplied' }] }) };
    if (req && typeof req.action === 'string' && req.action.startsWith('steer.')) { (window.__steerActions = window.__steerActions || []).push(req); return { json: '{"ok":true}' }; }
    return innerSub ? innerSub(req) : { json: '{}' };
  };
})();`;

async function open(browser, { w, h, mobile, dark }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(extraMock);
  await ctx.addInitScript(schemaGuard);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(900);
  return { p, ctx, errs };
}

const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.getBoundingClientRect().width > 0; }, sel);
const bubble = (p, id) => p.evaluate((i) => { const e = document.querySelector(`.st-bubble[data-steer-id="${i}"]`); return e ? { status: e.dataset.status, mode: e.dataset.mode, text: e.innerText } : null; }, id);

async function run(browser, size, dark) {
  const tag = `[${size.w}${dark ? ' dark' : ''}]`;
  const { p, ctx, errs } = await open(browser, { ...size, dark });
  const inbox = await bubble(p, 'st-old000000001');
  ck(`${tag} an unapplied steer from before a restart is shown`, !!inbox && inbox.status === 'unapplied' && /left from last time/.test(inbox.text), JSON.stringify(inbox));
  await p.locator('.st-bubble[data-steer-id="st-old000000001"] [data-action="steer-dismiss"]').click();
  await sleep(100);
  const dismissed = await p.evaluate(() => (window.__steerActions || []).some((r) => r.action === 'steer.dismiss' && r.id === 'st-old000000001'));
  ck(`${tag} dismissing it tells the engine (steer.dismiss)`, dismissed && !(await bubble(p, 'st-old000000001')));

  await p.evaluate(() => window.__app.startNewChat?.());
  await sleep(200);
  await p.locator('.aui-composer-input').fill('Write the report');
  ck(`${tag} idle: no Steer button`, !(await visible(p, '.aui-composer-steer')));
  await p.locator('.aui-composer-send').click();
  await sleep(300);
  const k = await p.evaluate(() => { const c = [...window.__mock.calls].reverse(); return c.find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey || c.find((x) => x.name === 'agent.sendMessage')?.args?.sessionKey || 'main'; });
  await p.evaluate((k) => window.__mock.emit('agent.started', { sessionKey: k }), k);
  await p.evaluate((k) => window.__mock.emit('text_delta', { sessionKey: k, text: 'Working on it' }), k);
  await sleep(150);
  ck(`${tag} running, empty input: no Steer button`, !(await visible(p, '.aui-composer-steer')));
  await p.locator('.aui-composer-input').fill('also add the date');
  await sleep(80);
  const both = (await visible(p, '.aui-composer-steer')) && (await visible(p, '.aui-composer-update')) && (await visible(p, '.aui-composer-queue'));
  ck(`${tag} running with text: Steer and Update show beside Queue`, both);
  const order = await p.evaluate(() => { const end = document.querySelector('.aui-composer-action-end'); return [...end.children].filter((e) => !e.hidden).map((e) => e.className.match(/aui-composer-(steer|update|queue)\b/)?.[1]); });
  ck(`${tag} order is Steer, Update, Queue`, order.indexOf('steer') >= 0 && order.indexOf('steer') < order.indexOf('update') && order.indexOf('update') < order.indexOf('queue'), order.join(','));
  const fit = await p.evaluate(() => [...document.querySelectorAll('.aui-composer-steer, .aui-composer-update, .aui-composer-queue')].every((b) => { const r = b.getBoundingClientRect(); return r.right <= innerWidth + 0.5 && r.width >= 28; }));
  ck(`${tag} the buttons fit on screen`, fit);

  // Enter still queues.
  await p.locator('.aui-composer-input').press('Enter');
  await sleep(150);
  const afterEnter = await p.evaluate(() => ({ steers: window.__steers.length, queued: document.querySelectorAll('.aui-queue [role="listitem"], .aui-queue > *').length }));
  ck(`${tag} Enter while running queues, it does not steer`, afterEnter.steers === 0 && afterEnter.queued >= 1, JSON.stringify(afterEnter));

  // Steer.
  await p.locator('.aui-composer-input').fill('use metric units');
  await sleep(60);
  await p.locator('.aui-composer-steer').click();
  await sleep(150);
  const sent = await p.evaluate(() => window.__steers[0] || null);
  ck(`${tag} Steer calls NK.agent.steer with text, id and mode steer`, !!sent && sent.text === 'use metric units' && sent.mode === 'steer' && /^st-/.test(sent.id), JSON.stringify(sent));
  ck(`${tag} the input is cleared`, (await p.locator('.aui-composer-input').inputValue()) === '');
  let b = sent && (await bubble(p, sent.id));
  ck(`${tag} the bubble is pending`, !!b && b.status === 'pending' && /use metric units/.test(b.text), JSON.stringify(b));
  await p.evaluate(([k, id]) => window.__mock.emit('steer.accepted', { sessionKey: k, id }), [k, sent?.id]);
  await sleep(80);
  b = await bubble(p, sent?.id);
  ck(`${tag} accepted: waiting for a safe point`, b?.status === 'accepted', JSON.stringify(b));
  await p.evaluate(([k, id]) => window.__mock.emit('steer.applied', { sessionKey: k, id, point: 'SP2' }), [k, sent?.id]);
  await sleep(80);
  b = await bubble(p, sent?.id);
  ck(`${tag} applied`, b?.status === 'applied' && /Applied/.test(b.text), JSON.stringify(b));
  await p.evaluate(([k, id]) => window.__mock.emit('steer.accepted', { sessionKey: k, id }), [k, sent?.id]);
  await sleep(50);
  ck(`${tag} applied never moves back to pending`, (await bubble(p, sent?.id))?.status === 'applied');

  // Update.
  await p.locator('.aui-composer-input').fill('make it a table instead');
  await sleep(60);
  await p.locator('.aui-composer-update').click();
  await sleep(150);
  const upd = await p.evaluate(() => window.__steers[1] || null);
  ck(`${tag} Update sends mode update`, !!upd && upd.mode === 'update' && upd.text === 'make it a table instead', JSON.stringify(upd));
  await p.evaluate(([k, id]) => window.__mock.emit('steer.unapplied', { sessionKey: k, id, text: 'make it a table instead', reason: 'turn_ended' }), [k, upd?.id]);
  await sleep(80);
  b = await bubble(p, upd?.id);
  ck(`${tag} unapplied offers Send as message`, b?.status === 'unapplied' && /Send as message/.test(b.text), JSON.stringify(b));

  // Turn ends with a steer message in the stored transcript.
  const T0 = Date.now() - 10e3;
  const display = [
    { role: 'user', content: 'Write the report', createdAt: T0 },
    { role: 'assistant', content: 'Drafting.', createdAt: T0 + 1000 },
    { role: 'user', content: `[steer ${sent?.id}] The user sent this while you were working. It belongs to the current task, not a new one.\n\nuse metric units`, createdAt: T0 + 2000 },
    { role: 'user', content: `[steer ${sent?.id} patch] How the engine read the user's steer above:\nintent: Amend`, createdAt: T0 + 2100 },
    { role: 'assistant', content: 'Here is the report, in metric units.', createdAt: T0 + 3000 },
  ];
  await p.evaluate(([k, list]) => window.__mock.emit('agent.completed', { sessionKey: k, displayMessagesJson: JSON.stringify(list) }), [k, display]);
  await sleep(500);
  const tr = await p.evaluate(() => {
    const st = [...document.querySelectorAll('.aui-user-message-root[data-steer]')];
    const all = document.querySelector('.aui-thread-viewport, main')?.innerText || document.body.innerText;
    return { n: st.length, text: st.map((e) => e.innerText).join('|'), header: /\[steer |while you were working|How the engine read/.test(all), label: st[0] ? getComputedStyle(st[0], '::before').content : '' };
  });
  ck(`${tag} the steer shows in the transcript as a steer`, tr.n === 1 && /use metric units/.test(tr.text) && /Steer/.test(tr.label), JSON.stringify(tr));
  ck(`${tag} the engine header and patch note are hidden`, !tr.header, JSON.stringify(tr));
  ck(`${tag} the applied bubble leaves after the turn`, !(await bubble(p, sent?.id)));

  // Send as message.
  await p.locator(`.st-bubble[data-steer-id="${upd?.id}"] [data-action="steer-resend"]`).click();
  await sleep(250);
  // The queued Enter message started a new reply when the turn ended, so the re-sent steer
  // either went out or waits in the queue as a normal message, never as a steer.
  const resent = await p.evaluate(() => ({
    sent: window.__mock.calls.some((c) => /^agent\.(sendMessage|followUp|resumeSession)$/.test(c.name) && JSON.stringify(c.args).includes('make it a table instead')),
    queued: [...document.querySelectorAll('.aui-queue')].some((q) => q.innerText.includes('make it a table instead')),
    steered: window.__steers.filter((x) => x.text === 'make it a table instead').length,
    bubble: !!document.querySelector('.st-bubble[data-status="unapplied"]'),
  }));
  ck(`${tag} Send as message sends it as a normal message`, (resent.sent || resent.queued) && resent.steered === 1 && !resent.bubble, JSON.stringify(resent));

  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  ck(`${tag} no horizontal overflow`, !overflow);
  ck(`${tag} no page errors`, errs.length === 0, errs.slice(0, 3).join(' || '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  const sizes = [{ w: 320, h: 640, mobile: true }, { w: 375, h: 760, mobile: true }, { w: 768, h: 1000, mobile: false }, { w: 1366, h: 860, mobile: false }];
  try {
    for (const s of sizes) await run(browser, s, false);
    await run(browser, sizes[1], true);
  } catch (e) {
    results.push('FAIL crashed :: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' <- '));
  }
  await browser.close();
  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
