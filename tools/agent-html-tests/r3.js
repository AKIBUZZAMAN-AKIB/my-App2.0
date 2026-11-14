// Round 3 checks: welcome screen, follow-up suggestions, universal HTML widget, link / gallery / steps
// widgets and tool-result extras, image attachments with zoom, full Mermaid build, guide template.
// Mock NativeKit only; no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep, send, emit, overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = require('path').join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = require('fs').existsSync(b) ? require('fs').readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? require('path').join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${require('path').resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/impl/shots7';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync('/home/sprite/impl/test/mock3.js', 'utf8');
const { schemaGuard } = require('./tool-schemas.js');
const mockV2 = fs.readFileSync('/home/sprite/impl/test/mock-v2.js', 'utf8');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
const W = (o) => '```widget\n' + JSON.stringify(o) + '\n```';

async function open(browser, w, hgt, mobile, dark, v2) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  if (v2) await ctx.addInitScript(mockV2);
  await ctx.addInitScript(schemaGuard);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u) && u !== 'https://example.edu/og.png') errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(250);
  return { p, ctx, errs };
}
const calls = (p) => p.evaluate(() => window.__mock.calls);
const lastSend = async (p) => { const c = await calls(p); return [...c].reverse().find((x) => /^agent\.(sendMessage|followUp)/.test(x.name)); };
const promptOf = (c) => (typeof c?.args === 'string' ? c.args : c?.args?.prompt ?? c?.args?.message ?? JSON.stringify(c?.args));
const sendCount = async (p) => (await calls(p)).filter((x) => /^agent\.(sendMessage|followUp)/.test(x.name)).length;
const inView = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length).every((e) => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1; }), sel);

const S = {};

/* 1. Welcome screen: greeting, starter cards, editing them in Settings, tapping one sends it. */
S.welcome = async (p, tag, env) => {
  await p.keyboard.press('Control+Shift+O');
  await sleep(400);
  const w = await p.evaluate(() => {
    const root = document.querySelector('.aui-thread-welcome-root');
    return { shown: !!root && root.getClientRects().length > 0, greet: root?.querySelector('.aui-thread-welcome-message')?.textContent, cards: [...document.querySelectorAll('.aui-thread-welcome-suggestion')].filter((b) => b.getClientRects().length).length };
  });
  ck(`${tag} empty chat shows the welcome screen`, w.shown && /help/i.test(w.greet || '') && w.cards >= 2, JSON.stringify(w));
  ck(`${tag} starter cards stay on screen`, await inView(p, '.aui-thread-welcome-suggestion'));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/welcome-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('button[aria-label="Settings"]:visible').first().click(); await sleep(400);
  await p.locator('#settings-tab-general').click(); await sleep(300);
  const has = await p.locator('[data-setting=welcome-greeting]').count();
  ck(`${tag} Settings has the welcome editor`, has === 1, String(has));
  if (!has) return;
  await p.locator('[data-setting=welcome-greeting]').fill('Hi Akib, what are we doing?');
  await p.locator('[data-setting=welcome-starters]').fill('Routine | today\'s classes | Show my class routine for today\nCT prep | quiz me on CSE-1101');
  await p.locator('[data-action=welcome-save]').click(); await sleep(200);
  await p.keyboard.press('Escape'); await sleep(400);
  const w2 = await p.evaluate(() => {
    const root = document.querySelector('.aui-thread-welcome-root');
    return { greet: root?.querySelector('.aui-thread-welcome-message')?.textContent, cards: [...document.querySelectorAll('.aui-thread-welcome-suggestion')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()) };
  });
  ck(`${tag} edited greeting and starters show`, w2.greet === 'Hi Akib, what are we doing?' && w2.cards.length === 2 && /Routine/.test(w2.cards[0]) && /CT prep/.test(w2.cards[1]), JSON.stringify(w2));
  const saved = await p.evaluate(() => localStorage.getItem('aui.welcomeScreen'));
  ck(`${tag} welcome screen is saved`, /Show my class routine/.test(saved || ''), String(saved).slice(0, 80));
  await p.locator('.aui-thread-welcome-suggestion').first().click(); await sleep(400);
  const c = await lastSend(p);
  ck(`${tag} tapping a starter sends its prompt`, promptOf(c) === 'Show my class routine for today', promptOf(c));
};

/* 2. Follow-up suggestions: hidden block, chips under the last reply, tap sends. */
S.followups = async (p, tag, env) => {
  const a = await send(p, 'Explain recursion');
  const k = a.sessionKey;
  const reply = 'Recursion is when a function calls itself.\n\n```suggestions\n["Show a Python example", "How is it different from a loop?", "What is a base case?"]\n```';
  await emit(p, [['text_delta', { sessionKey: k, delta: reply.slice(0, 60) }]]);
  await sleep(200);
  const during = await p.locator('.aui-followup:visible').count();
  ck(`${tag} no chips while the reply streams`, during === 0, String(during));
  await emit(p, [['text_delta', { sessionKey: k, delta: reply.slice(60) }], ['agent.completed', { sessionKey: k }]]);
  await sleep(600);
  const f = await p.evaluate(() => {
    const m = [...document.querySelectorAll('[data-role=assistant]')].pop();
    const box = document.querySelector('.aui-followups');
    return { chips: [...document.querySelectorAll('.aui-followup')].filter((b) => b.getClientRects().length).map((b) => b.innerText.trim()), raw: /suggestions|\["Show/.test(m.innerText), after: box && m.closest('.aui-thread-viewport') && box.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 2 };
  });
  ck(`${tag} three follow-up chips`, f.chips.length === 3 && f.chips[0] === 'Show a Python example', JSON.stringify(f.chips));
  ck(`${tag} suggestions block is hidden from the reply`, !f.raw);
  ck(`${tag} chips sit under the latest reply`, !!f.after);
  ck(`${tag} chips stay on screen`, await inView(p, '.aui-followup'));
  const copied = await p.evaluate(async () => {
    let got = null;
    const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { got = t; }, write: async () => {} } }); } catch {}
    const m = [...document.querySelectorAll('[data-role=assistant]')].pop();
    m.querySelector('.aui-assistant-action-bar-root [aria-label="Copy"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    return got;
  });
  ck(`${tag} Copy leaves the suggestions out`, typeof copied === 'string' && /calls itself/.test(copied) && !/suggestions|Python example/.test(copied), JSON.stringify(copied));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/followups-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('.aui-followup', { hasText: 'What is a base case?' }).click();
  await sleep(400);
  ck(`${tag} tapping a chip sends it`, promptOf(await lastSend(p)) === 'What is a base case?', promptOf(await lastSend(p)));
  const left = await p.locator('.aui-followup:visible').count();
  ck(`${tag} chips go away once sent`, left === 0, String(left));
};

/* 3. Universal HTML widget: sandbox, CSP, auto size, dark mode, postMessage back, canvas, code view. */
const HTML_WIDGET = `<!-- title: Quick quiz -->
<style>.q{padding:12px;border:1px solid var(--aui-border);border-radius:10px;background:var(--aui-card)}button{margin:4px;padding:8px 12px;border-radius:8px;border:1px solid var(--aui-border);background:var(--aui-bg)}.tall{height:180px}</style>
<div class="q"><p id="t">2 + 5 = ?</p><div class="tall"></div><button id="b6">6</button><button id="b7">7</button><a id="ext" href="https://example.com/docs">docs</a></div>
<script>document.getElementById('b7').onclick=()=>aui.send('My answer is 7');document.getElementById('b6').onclick=()=>aui.result({answer:6});document.getElementById('t').dataset.dark=document.documentElement.classList.contains('dark');addEventListener('aui-theme',()=>{document.getElementById('t').dataset.dark=document.documentElement.classList.contains('dark')});</script>`;
S.htmlwidget = async (p, tag, env) => {
  const a = await send(p, 'Quiz me');
  const k = a.sessionKey;
  const reply = 'Here you go:\n\n```html-widget\n' + HTML_WIDGET + '\n```\n\nAnd a broken one:\n\n```html-widget\n<p>x</p><script>throw new Error("boom")</script>\n```\n\nAnd one that calls the internet:\n\n```html-widget\n<p>net</p><script>fetch("https://example.com/x").catch(()=>{});</script>\n```';
  await emit(p, [['text_delta', { sessionKey: k, delta: reply.slice(0, 50) }]]);
  await sleep(500);
  const building = await p.locator('.aui-widget-building').count();
  await emit(p, [['text_delta', { sessionKey: k, delta: reply.slice(50) }], ['agent.completed', { sessionKey: k }]]);
  await sleep(1800);
  ck(`${tag} html-widget shows "Building" while streaming`, building >= 1, String(building));
  const info = await p.evaluate(() => [...document.querySelectorAll('iframe[data-kind=html-widget]')].map((f) => {
    const card = f.closest('.aui-html-widget');
    return { sandbox: f.getAttribute('sandbox'), csp: /default-src 'none'/.test(f.srcdoc), h: Math.round(f.getBoundingClientRect().height), w: Math.round(f.getBoundingClientRect().width), state: card.dataset.state, note: card.querySelector('.aui-html-widget-note')?.hidden ? '' : card.querySelector('.aui-html-widget-note')?.textContent, title: card.querySelector('.aui-html-widget-title')?.textContent, vw: document.documentElement.clientWidth };
  }));
  ck(`${tag} three widgets in sandboxed frames`, info.length === 3 && info.every((x) => x.sandbox === 'allow-scripts' && x.csp), JSON.stringify(info.map((x) => x.sandbox)));
  ck(`${tag} widget starts and takes its title`, info[0]?.state === 'ready' && info[0]?.title === 'Quick quiz', JSON.stringify(info[0]));
  ck(`${tag} widget sizes itself to its content`, info[0]?.h >= 230 && info[0]?.h <= 420 && info[0]?.w <= info[0]?.vw, JSON.stringify([info[0]?.h, info[0]?.w]));
  ck(`${tag} script error is reported on the card`, info[1]?.state === 'error' && /boom/.test(info[1]?.note || ''), JSON.stringify(info[1]));
  ck(`${tag} network request is blocked and explained`, /blocked/i.test(info[2]?.note || ''), JSON.stringify(info[2]));
  const fr = p.frames().find((f) => f !== p.mainFrame() && /2 \+ 5/.test(f.url() === 'about:srcdoc' ? 'x' : '') === false && f.name() === '' );
  let frame = null;
  for (const f of p.frames()) { if (f === p.mainFrame()) continue; try { if (await f.$('#b7')) { frame = f; break; } } catch {} }
  ck(`${tag} widget frame reachable`, !!frame);
  if (!frame) return;
  const iso = await frame.evaluate(() => { try { return !!parent.document; } catch { return 'blocked'; } });
  ck(`${tag} widget can't reach the app (no same-origin)`, iso === 'blocked', String(iso));
  const dk = await frame.evaluate(() => document.getElementById('t').dataset.dark);
  ck(`${tag} dark mode passed into the widget`, dk === String(!!env.dark), String(dk));
  // a send without a tap is refused
  const before = await sendCount(p);
  await sleep(3200);
  await frame.evaluate(() => aui.send('sneaky'));
  await sleep(300);
  ck(`${tag} widget can't send without a tap`, (await sendCount(p)) === before);
  const tapIn = async (sel) => {
    await p.locator('.aui-html-widget iframe').first().evaluate((f) => f.scrollIntoView({ block: 'center' }));
    await sleep(200);
    await frame.click(sel);
  };
  await tapIn('#b7');
  await sleep(500);
  ck(`${tag} tap in widget sends to the chat`, promptOf(await lastSend(p)) === 'My answer is 7', promptOf(await lastSend(p)) + ' | ' + await p.evaluate(() => [document.activeElement.tagName, document.querySelector('.aui-html-widget-note')?.textContent, document.querySelector('.aui-composer-input')?.value, JSON.stringify(window.__mock.calls.slice(-3).map((c) => c.name))].join(' / ')));
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Correct!' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(900);
  await tapIn('#b6');
  await sleep(500);
  ck(`${tag} aui.result sends JSON`, /result:[\s\S]*"answer":6/.test(promptOf(await lastSend(p))), promptOf(await lastSend(p)));
  if (env.shot) { await p.locator('.aui-html-widget').first().scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/html-widget-${env.w}${env.dark ? '-dark' : ''}.png` }); }
  const card = p.locator('.aui-html-widget').first();
  await card.locator('[data-action=widget-code]').click(); await sleep(200);
  const cv = await p.evaluate(() => { const c = document.querySelector('.aui-html-widget'); return { view: c.dataset.view, code: !c.querySelector('.aui-html-widget-code').hidden && /Quick quiz/.test(c.querySelector('.aui-html-widget-code').textContent), frameHidden: c.querySelector('iframe').hidden }; });
  ck(`${tag} Code view shows the source`, cv.view === 'code' && cv.code && cv.frameHidden, JSON.stringify(cv));
  await card.locator('[data-action=widget-code]').click(); await sleep(200);
  await card.locator('[data-action=widget-canvas]').click(); await sleep(500);
  const pv = await p.evaluate(() => { const f = document.querySelector('.aui-canvas iframe'); return f ? [f.getAttribute('sandbox'), /window\.aui=/.test(f.srcdoc)] : null; });
  ck(`${tag} canvas previews the widget with a stub bridge`, pv && !/allow-same-origin/.test(pv[0]) && pv[1], JSON.stringify(pv));
  await p.locator('.aui-canvas [data-view=edit]').first().click().catch(() => {}); await sleep(200);
  const canvas = await p.evaluate(() => { const c = document.querySelector('.aui-canvas'); return c ? { vis: c.getClientRects().length > 0, has: /Quick quiz/.test(c.innerText + [...c.querySelectorAll('textarea')].map((t) => t.value).join('')) } : null; });
  ck(`${tag} Open in canvas opens the widget source`, canvas?.vis && canvas?.has, JSON.stringify(canvas));
  await p.keyboard.press('Escape'); await sleep(300);
};

/* 4. Link previews, image gallery with zoom, step progress, from widget JSON and from tool results. */
const OG_PAGE = '<!doctype html><html><head><title>Fallback</title><meta property="og:title" content="Rajshahi University Notice Board"><meta property="og:description" content="Exam schedule for the first year, updated weekly."><meta property="og:site_name" content="RU"><meta property="og:image" content="https://example.edu/og.png"><script>window.x=1</script></head><body>hi</body></html>';
S.extras = async (p, tag, env) => {
  const a = await send(p, 'Show me things');
  const k = a.sessionKey;
  const img = `data:image/png;base64,${PNG}`;
  await emit(p, [
    ['tool_use', { sessionKey: k, toolCallId: 'f1', toolName: 'web_fetch', args: { url: 'https://example.edu/notices', method: 'GET' } }],
    ['tool_result', { sessionKey: k, toolCallId: 'f1', result: { output: JSON.stringify({ status: 200, body: OG_PAGE }) } }],
    ['tool_use', { sessionKey: k, toolCallId: 'g1', toolName: 'mcp__photos__search', args: { q: 'campus' } }],
    ['tool_result', { sessionKey: k, toolCallId: 'g1', result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'image', data: PNG, mimeType: 'image/png' }] } }],
  ]);
  await sleep(300);
  const reply = ['Sources:', W({ type: 'links', title: 'Read more', items: [{ url: 'https://example.com/a', title: 'Recursion explained with a very long title that has to wrap on small phones', description: 'A friendly guide.', siteName: 'Example' }, 'https://developer.mozilla.org/en-US/docs/Glossary/Recursion'] }),
    'Pictures:', W({ type: 'gallery', title: 'Campus', images: [{ src: img, alt: 'Library', caption: 'Library' }, { src: img, alt: 'Hall' }, { src: img, alt: 'Field' }] }),
    'Plan:', W({ type: 'steps', title: 'Study plan', steps: [{ title: 'Read chapter 3', status: 'done' }, { title: 'Solve 10 problems', description: 'From the CT sheet', status: 'running' }, { title: 'Mock CT', status: 'pending' }, { title: 'Ask the CR for notes', status: 'error' }] })].join('\n\n');
  await emit(p, [['text_delta', { sessionKey: k, delta: reply }], ['agent.completed', { sessionKey: k }]]);
  await sleep(800);
  const r = await p.evaluate(() => {
    const m = [...document.querySelectorAll('[data-role=assistant]')].pop();
    const linkCards = [...m.querySelectorAll('.aui-widget .aui-link-card')];
    const fetchExtra = m.querySelector('.aui-tool-extra[data-extra=link] .aui-link-card');
    const galExtra = m.querySelectorAll('.aui-tool-extra[data-extra=gallery] .aui-gallery-thumb').length;
    const steps = [...m.querySelectorAll('.aui-step')].map((s) => s.dataset.state);
    return {
      links: linkCards.map((a) => [a.tagName, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
      fetch: fetchExtra ? [fetchExtra.getAttribute('href'), fetchExtra.querySelector('.aui-link-card-title')?.textContent, fetchExtra.querySelector('.aui-link-card-desc')?.textContent] : null,
      ran: window.x === 1, galExtra, thumbs: m.querySelectorAll('.aui-widget .aui-gallery-thumb').length,
      steps, count: m.querySelector('.aui-steps-count')?.textContent, bar: m.querySelector('.aui-steps-bar > span')?.style.width,
      running: !!m.querySelector('.aui-step[data-state=running] .spin, .aui-step[data-state=running] .icon'),
    };
  });
  ck(`${tag} link preview cards open safely in a new tab`, r.links.length === 2 && r.links.every(([t, h, tg, rel]) => t === 'A' && /^https:/.test(h) && tg === '_blank' && /noopener/.test(rel)), JSON.stringify(r.links));
  ck(`${tag} web_fetch result gets a link preview from its page tags`, r.fetch && r.fetch[0] === 'https://example.edu/notices' && r.fetch[1] === 'Rajshahi University Notice Board' && /Exam schedule/.test(r.fetch[2]) && !r.ran, JSON.stringify(r.fetch));
  ck(`${tag} image tool result shows as a gallery`, r.galExtra === 2, String(r.galExtra));
  ck(`${tag} gallery widget shows its images`, r.thumbs === 3, String(r.thumbs));
  ck(`${tag} step list shows each state`, JSON.stringify(r.steps) === '["done","running","pending","error"]' && r.count === '1 of 4 done' && r.bar === '25%' && r.running, JSON.stringify(r));
  ck(`${tag} cards stay on screen`, await inView(p, '.aui-link-card, .aui-gallery, .aui-steps'));
  if (env.shot) { await p.locator('.aui-widget .aui-link-list').first().scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/extras-${env.w}${env.dark ? '-dark' : ''}.png` }); }
  await p.locator('.aui-widget .aui-gallery-thumb').nth(1).click({ timeout: 5000 }).catch((e) => ck(`${tag} gallery thumb tappable`, false, e.message.split('\n')[0])); await sleep(400);
  const z = await p.evaluate(() => { const d = document.querySelector('.dialog[data-kind=image]'); return d ? { count: d.querySelector('.aui-zoom-count')?.textContent, alt: d.querySelector('.aui-zoom img')?.alt } : null; });
  ck(`${tag} tapping an image opens the zoom viewer`, z && z.count === '2 / 3' && z.alt === 'Hall', JSON.stringify(z));
  if (z) {
    await p.locator('[data-action=zoom-next]').click({ timeout: 5000 }).catch((e) => ck(`${tag} zoom next`, false, e.message.split('\n').slice(0, 6).join(' ')));
    await sleep(150);
    await p.locator('[data-action=zoom-in]').click({ timeout: 5000 }).catch((e) => ck(`${tag} zoom in`, false, e.message.split('\n').slice(0, 6).join(' ')));
    await sleep(250);
    const z2 = await p.evaluate(() => { const d = document.querySelector('.dialog[data-kind=image]'); return { count: d.querySelector('.aui-zoom-count')?.textContent, zoomed: d.querySelector('.aui-zoom').dataset.zoomed, sw: d.querySelector('.aui-zoom').scrollWidth > d.querySelector('.aui-zoom').clientWidth }; });
    ck(`${tag} zoom viewer pages and zooms`, z2.count === '3 / 3' && z2.zoomed === 'true' && z2.sw, JSON.stringify(z2));
    await p.keyboard.press('Escape'); await sleep(300);
  }
};

/* 5. Images: picker, paste, drop, thumbnails, removal, sent with attachments, shown, zoomable. */
const dropFile = (p, how) => p.evaluate(async ([how, b64]) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bin], `${how}.png`, { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.querySelector('.aui-composer-input');
  if (how === 'paste') input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  else {
    const target = document.querySelector('.aui-composer-root') || input;
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }
}, [how, PNG]);
S.images = async (p, tag, env) => {
  const input = p.locator('input[type=file]').first();
  await input.setInputFiles({ name: 'picked.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await sleep(400);
  await dropFile(p, 'paste'); await sleep(400);
  await dropFile(p, 'drop'); await sleep(400);
  const tiles = () => p.evaluate(() => [...document.querySelectorAll('.aui-composer-root .aui-attachment-root, .aui-composer-attachments .aui-attachment-root')].map((t) => [t.querySelector('img') ? 'img' : 'no-img', t.innerText.replace(/\s+/g, ' ').trim().slice(0, 30)]));
  const t1 = await tiles();
  ck(`${tag} picker, paste and drop each add an image with a thumbnail`, t1.length === 3 && t1.every((x) => x[0] === 'img'), JSON.stringify(t1));
  ck(`${tag} thumbnails stay on screen`, await inView(p, '.aui-composer-root .aui-attachment-root'));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/images-composer-${env.w}${env.dark ? '-dark' : ''}.png` });
  const rm = p.locator('.aui-composer-root .aui-attachment-root').nth(1).locator('[aria-label*="Remove" i], .aui-attachment-tile-remove, [data-action=remove]').first();
  await rm.click({ force: true }); await sleep(300);
  const t2 = await tiles();
  ck(`${tag} an image can be removed before sending`, t2.length === 2, JSON.stringify(t2));
  await p.locator('.aui-composer-input').first().fill('Compare these two');
  await p.locator('.aui-composer-send').first().click();
  await sleep(700);
  const c = [...(await calls(p))].reverse().find((x) => x.name === 'agent.sendMessageWith' || x.name === 'agent.followUpWith');
  ck(`${tag} images go to the engine as attachments`, c && c.args.n === 2 && /Compare these two/.test(c.args.prompt), JSON.stringify(c?.args));
  const shown = await p.locator('[data-role=user] img').count();
  ck(`${tag} images show in the sent message`, shown === 2, String(shown));
  await p.locator('[data-role=user] img').first().click(); await sleep(400);
  const z = await p.evaluate(() => !!document.querySelector('.dialog[data-kind=image] .aui-zoom img'));
  ck(`${tag} tapping a sent image zooms it`, z);
  await p.keyboard.press('Escape'); await sleep(300);
};
S.noimages = async (p, tag) => {
  await dropFile(p, 'paste'); await sleep(500);
  const r = await p.evaluate(() => ({ tiles: document.querySelectorAll('.aui-composer-root .aui-attachment-root').length, toast: [...document.querySelectorAll('[data-sonner-toast], .toast, [role=status], [role=alert]')].map((t) => t.textContent).join(' | ') }));
  ck(`${tag} old engine: image is refused with a clear note`, r.tiles === 0 && /not supported by this engine|aren't supported by this engine/i.test(r.toast), JSON.stringify(r).slice(0, 220));
};

/* 6. Full Mermaid build: every diagram type, light and dark, scroll/zoom, code fallback on error. */
const DIAGRAMS = {
  flowchart: 'flowchart LR\n  A[Start] --> B{Login?}\n  B -->|yes| C[Dashboard]\n  B -->|no| D[Sign up]',
  sequence: 'sequenceDiagram\n  App->>Server: GET /routine\n  Server-->>App: 200 OK',
  class: 'classDiagram\n  class Student {\n    +String name\n    +enroll()\n  }\n  Student <|-- CR',
  state: 'stateDiagram-v2\n  [*] --> Pending\n  Pending --> Paid\n  Paid --> [*]',
  er: 'erDiagram\n  STUDENT ||--o{ ENROLLMENT : has\n  COURSE ||--o{ ENROLLMENT : includes',
  journey: 'journey\n  title Exam day\n  section Morning\n    Wake up: 3: Me\n    Revise: 4: Me',
  gantt: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Study\n  Chapter 1 :a1, 2026-11-14, 3d\n  Chapter 2 :after a1, 2d',
  pie: 'pie title Marks\n  "Akib" : 91\n  "Rafi" : 72',
  quadrant: 'quadrantChart\n  title Tasks\n  x-axis Low effort --> High effort\n  y-axis Low value --> High value\n  CT prep: [0.3, 0.8]',
  requirement: 'requirementDiagram\n  requirement login {\n    id: 1\n    text: users can log in\n    risk: low\n    verifymethod: test\n  }\n  element app {\n    type: system\n  }\n  app - satisfies -> login',
  gitgraph: 'gitGraph\n  commit\n  branch feature\n  checkout feature\n  commit\n  checkout main\n  merge feature',
  c4: 'C4Context\n  title System\n  Person(s, "Student")\n  System(a, "Super app")\n  Rel(s, a, "Uses")',
  mindmap: 'mindmap\n  root((Super app))\n    Academic\n      Routine\n      Exams\n    Calendar',
  timeline: 'timeline\n  title Semester\n  Week 1 : Classes start\n  Week 8 : Midterm',
  sankey: 'sankey-beta\nBudget,Food,40\nBudget,Books,30\nBudget,Travel,30',
  xychart: 'xychart-beta\n  title "Steps"\n  x-axis [Mon, Tue, Wed]\n  y-axis "Steps" 0 --> 10000\n  bar [3000, 7000, 5000]\n  line [3000, 7000, 5000]',
  block: 'block-beta\n  columns 3\n  a["App"] b["API"] c["DB"]',
  packet: 'packet-beta\n  0-15: "Source Port"\n  16-31: "Destination Port"',
  kanban: 'kanban\n  todo[To do]\n    t1[Lab report]\n  doing[Doing]\n    t2[CT prep]',
  architecture: 'architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service server(server)[Server] in api\n  db:L -- R:server',
  radar: 'radar-beta\n  axis m["Maths"], p["Physics"], c["Chemistry"]\n  curve a["Akib"]{80, 70, 60}',
  treemap: 'treemap-beta\n"Budget"\n    "Food": 40\n    "Books": 30',
};
const WIDE = 'flowchart LR\n' + Array.from({ length: 18 }, (_, i) => `  N${i}[Step number ${i}] --> N${i + 1}[Step number ${i + 1}]`).join('\n');
S.mermaid = async (p, tag, env) => {
  const a = await send(p, 'All diagrams');
  const k = a.sessionKey;
  const names = Object.keys(DIAGRAMS);
  const reply = names.map((n) => `${n}:\n\n\`\`\`mermaid\n${DIAGRAMS[n]}\n\`\`\``).join('\n\n') + `\n\nwide:\n\n\`\`\`mermaid\n${WIDE}\n\`\`\`\n\nbroken:\n\n\`\`\`mermaid\nflowchart LR\n  A --> \n  ((( nope\n\`\`\``;
  await emit(p, [['text_delta', { sessionKey: k, delta: reply }], ['agent.completed', { sessionKey: k }]]);
  await p.waitForFunction((n) => [...document.querySelectorAll('.aui-mermaid')].filter((b) => b.dataset.state === 'done' || b.dataset.state === 'error').length >= n, names.length + 2, { timeout: 150000 }).catch(() => {});
  await sleep(300);
  const st = await p.evaluate(() => [...document.querySelectorAll('[data-role=assistant] .aui-mermaid')].map((b) => {
    const svg = b.querySelector('.aui-mermaid-svg svg');
    const r = svg?.getBoundingClientRect();
    return { state: b.dataset.state, svg: !!svg, kids: svg ? svg.querySelectorAll('g, path, rect, text, circle, polygon').length : 0, h: r ? Math.round(r.height) : 0, err: /error|syntax/i.test(svg?.textContent || '') && !!svg?.querySelector('.error-icon'), code: !!b.querySelector('.aui-code-block') && b.dataset.view };
  }));
  names.forEach((n, i) => {
    const x = st[i] || {};
    ck(`${tag} mermaid ${n} renders`, x.state === 'done' && x.svg && x.kids >= 3 && x.h > 10 && !x.err, JSON.stringify(x));
  });
  const wide = st[names.length] || {};
  const sc = await p.evaluate(() => { const b = [...document.querySelectorAll('[data-role=assistant] .aui-mermaid')].at(-2); const host = b?.querySelector('.aui-mermaid-svg'); const r = b?.getBoundingClientRect(); return host ? { scroll: host.scrollWidth > host.clientWidth + 2, ox: getComputedStyle(host).overflowX, zoom: !!b.querySelector('[aria-label*="Zoom" i], [data-action*=zoom], [aria-label*="Full" i], [aria-label*="Expand" i]'), right: r.right, vw: document.documentElement.clientWidth } : null; });
  ck(`${tag} wide diagram swipes sideways inside its box`, wide.state === 'done' && sc && (sc.scroll || sc.zoom) && /(auto|scroll)/.test(sc.ox) && sc.right <= sc.vw + 1, JSON.stringify(sc));
  const broken = st[names.length + 1] || {};
  ck(`${tag} broken diagram falls back to its code`, broken.state === 'error' && broken.code === 'code', JSON.stringify(broken));
  if (env.dark) {
    const dark = await p.evaluate(() => { const svg = document.querySelector('[data-role=assistant] .aui-mermaid-svg svg'); const t = svg?.querySelector('.nodeLabel, text, span'); const c = t ? getComputedStyle(t).color : ''; const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? (+m[1] + +m[2] + +m[3]) / 3 : -1; });
    ck(`${tag} diagrams use light text in dark mode`, dark > 140, String(dark));
  }
  if (env.shot) {
    for (const n of ['mindmap', 'architecture', 'kanban', 'radar']) {
      const i = names.indexOf(n);
      const el = p.locator('[data-role=assistant] .aui-mermaid').nth(i);
      await el.scrollIntoViewIfNeeded(); await sleep(100);
      await el.screenshot({ path: `${SHOTS}/mermaid-${n}-${env.w}${env.dark ? '-dark' : ''}.png` });
    }
  }
};

/* 7. Skills template and persona guide carry the widget + suggestions formats. */
S.guide = async (p, tag) => {
  await p.locator('button[aria-label="Settings"]:visible').first().click(); await sleep(400);
  await p.locator('#settings-tab-automations').click(); await sleep(500);
  await p.locator('details.advanced summary', { hasText: 'New skill' }).first().click({ timeout: 4000 });
  await sleep(200);
  const t = await p.locator('.aui-skill-templates [data-template="Widgets & suggestions guide"]').count() === 1;
  if (t) {
    await p.locator('.aui-skill-templates [data-template="Widgets & suggestions guide"]').click(); await sleep(150);
    const v = await p.evaluate(() => { const d = document.querySelector('.aui-skill-templates').closest('.advanced-body'); return [...d.querySelectorAll('textarea')].map((e) => e.value).join(''); });
    ck(`${tag} guide template fills the skill prompt`, v.includes('`html-widget`') && v.includes('`suggestions`'), String(v.length));
  }
  ck(`${tag} Skills templates include the widgets & suggestions guide`, t);
  await p.locator('#settings-tab-memory').click(); await sleep(500);
  if (await p.locator('[data-action=add-widget-guide]').count()) {
    await p.locator('[data-action=add-widget-guide]').click(); await sleep(150);
    const val = await p.evaluate(() => [...document.querySelectorAll('textarea')].map((x) => x.value).find((v) => v.includes('Interactive widgets')) || '');
    ck(`${tag} persona guide covers html-widget, suggestions, links, gallery, steps`, ['`html-widget`', '`suggestions`', '"type":"links"', '"type":"gallery"', '"type":"steps"', 'aui.send'].every((x) => val.includes(x)), val.length + '');
  } else ck(`${tag} persona guide button`, false);
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const sizes = (process.env.SIZES || '320x640m,360x740m,390x844m,1280x800').split(',').map((s) => { const m = /^(\d+)x(\d+)(m?)$/.exec(s); return [+m[1], +m[2], !!m[3]]; });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const darks = process.env.DARK === '0' ? [false] : process.env.DARK === '1' ? [true] : [false, true];
  for (const [w, hgt, mobile] of sizes) {
    for (const dark of darks) {
      for (const [name, fn] of Object.entries(S)) {
        if (only && !only.includes(name)) continue;
        const tag = `${w}x${hgt}${dark ? ' dark' : ''} ${name}`;
        const { p, ctx, errs } = await open(browser, w, hgt, mobile, dark, name === 'images');
        const shot = !!process.env.SHOT && w === 390;
        try { await fn(p, tag, { w, dark, shot }); } catch (e) { ck(`${tag} ran`, false, e.message.split('\n')[0]); }
        const ov = await overflow(p);
        ck(`${tag} no page sideways scroll`, ov.ok, JSON.stringify(ov));
        const own = name === 'htmlwidget' ? errs.filter((e) => !/about:srcdoc|example\.com\/x/.test(e)) : errs;
        ck(`${tag} no console errors / network`, !own.length, own.slice(0, 3).join(' | '));
        await ctx.close();
      }
    }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(fails.join('\n'));
  console.log(`${results.length - fails.length}/${results.length} passed`);
})();
