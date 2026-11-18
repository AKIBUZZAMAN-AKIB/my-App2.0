// The sub-agent view, second pass (docs/subagents/SUBAGENT_UI_REDESIGN.md, "Second pass"):
// a one-line header (name + status + Stop + Open as chat + ···) at 320/390/1280 px, light
// and dark; a read-only Overview ("Last message", no composer, no Stop, no Pick parts);
// long-press, mouse and keyboard multi-select in the Chat tab and in "Open as chat";
// Interrupt vs Stop; usage shown once; every engine control reachable from the ··· menu;
// one tab row; no overlaps.
// Run: node tools/agent-html-tests/subagent-view.js   (URL_=file://... to test another build)
const { chromium } = require('./pw.js');
const { sleep } = require('./feat.js');
const { open, makeChain, subCalls, EXE } = require('./subagent-graph-fixes.js');

const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + extra : ''}`); return ok; };

const seedChat = (p, id) => p.evaluate((x) => {
  window.__sa.transcripts.set(x, [
    { role: 'user', content: 'Find the three best sources on solar storage.' },
    { role: 'assistant', content: [{ type: 'text', text: 'First source: the NREL battery cost report.' }] },
    { role: 'user', content: 'Now compare their numbers.' },
    { role: 'assistant', content: [{ type: 'text', text: 'NREL says $250 per kWh; IEA says $280 per kWh.\n\nThe gap is cell prices.' }] },
  ]);
}, id);

// Boxes of the header line: every piece on one line, none overlapping, none outside.
const headerBoxes = (p, rowSel) => p.evaluate((sel) => {
  const row = document.querySelector(sel);
  if (!row) return null;
  const vw = document.documentElement.clientWidth;
  const rr = row.getBoundingClientRect();
  const parts = [...row.querySelectorAll('h3, .sa-chat-head-title, .sa-status, .chip, .sa-hbtn, .sa-crumb-switch, .sa-chat-back, [data-slot="subagent-chat-back"]')]
    .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    .map((e) => { const r = e.getBoundingClientRect(); return { k: e.dataset.slot || e.className.split(' ')[0] || e.tagName, l: r.left, r: r.right, t: r.top, b: r.bottom, cy: (r.top + r.bottom) / 2, w: r.width, txt: (e.innerText || '').trim().slice(0, 20) }; });
  const overlaps = [];
  for (let i = 0; i < parts.length; i += 1) for (let j = i + 1; j < parts.length; j += 1) {
    const a = parts[i]; const b = parts[j];
    if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) overlaps.push(`${a.k}~${b.k}`);
  }
  const cys = parts.map((x) => x.cy);
  return { h: rr.height, spread: Math.max(...cys) - Math.min(...cys), overlaps, out: parts.filter((x) => x.r > vw + 1 || x.l < -1).map((x) => x.k), parts, rowRight: rr.right, vw };
}, rowSel);

// Holds the mouse on a visible point of the message (a docked panel can cover part of the chat).
const press = async (p, sel, ms = 650) => {
  const loc = p.locator(sel).first();
  await loc.scrollIntoViewIfNeeded();
  const pt = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (let y = r.top + 8; y < r.bottom; y += 12) for (let x = r.left + 8; x < r.right; x += 16) { const t = document.elementFromPoint(x, y); if (t && el.contains(t) && !t.closest('button, a, input')) return { x, y }; }
    return null;
  });
  if (!pt) throw new Error(`no visible point on ${sel}`);
  await p.mouse.move(pt.x, pt.y);
  await p.mouse.down();
  await sleep(ms);
  await p.mouse.up();
  await sleep(150);
};
// A touch long-press, as a phone sends it (pointerType touch, then a contextmenu).
const touchPress = (p, sel) => p.evaluate(async (s) => {
  const el = document.querySelector(s);
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.left + 20, clientY: r.top + 10 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  await new Promise((f) => setTimeout(f, 600));
  const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  el.dispatchEvent(cm);
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return { menuBlocked: cm.defaultPrevented };
}, sel);
const selState = (p, scope) => p.evaluate((sc) => {
  const root = document.querySelector(sc);
  const bar = root?.querySelector('[data-slot="msel-bar"]') || document.querySelector('[data-slot="msel-bar"]:not([hidden])');
  const items = [...(root || document).querySelectorAll('[data-sel-key]')];
  return {
    bar: !!bar && !bar.hidden,
    count: bar?.querySelector('[data-slot="msel-count"]')?.textContent || '',
    checked: items.filter((e) => e.dataset.selected === 'true').length,
    boxes: items.filter((e) => e.querySelector(':scope > .msel-check')).length,
    items: items.length,
  };
}, scope);
const pickTab = async (p, t, ms = 350) => {
  const hidden = await p.$eval(`[data-slot="agent-view-tabs"] [data-tab="${t}"]`, (e) => e.hidden);
  if (hidden) { await p.click('[data-slot="agent-view-more"]'); await p.click(`.sa-more-menu [data-tab="${t}"]`); } else await p.click(`[data-slot="agent-view-tabs"] [data-tab="${t}"]`);
  await sleep(ms);
};
const lastCall = async (p, action) => (await subCalls(p)).filter((c) => c.action === action).pop();

async function suite(browser, w, dark) {
  const tag = `${w}px ${dark ? 'dark' : 'light'}`;
  const { p, ctx, errs } = await open(browser, { w, hgt: 844 });
  if (dark) await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.evaluate(() => { window.__copied = []; try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } }); } catch { /* fine */ } });
  const ids = await makeChain(p, { finish: false });
  await seedChat(p, ids.b);
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), ids.b);
  await sleep(500);

  // ---- Header: one line ----
  const hb = await headerBoxes(p, '[data-slot="agent-header-row"]');
  const slots = (hb?.parts || []).map((x) => x.k);
  check(`${tag}: header has name, status, Stop, Open as chat and ··· on one line`, !!hb && ['subagent-stop', 'subagent-open-chat', 'subagent-more'].every((s) => slots.includes(s)) && hb.parts.some((x) => /Running/i.test(x.txt)) && hb.spread <= 4 && hb.h <= 44, JSON.stringify({ h: hb?.h, spread: hb?.spread, slots }));
  check(`${tag}: header pieces do not overlap and stay on screen`, !!hb && !hb.overlaps.length && !hb.out.length, JSON.stringify({ o: hb?.overlaps, out: hb?.out }));
  const btns = await p.evaluate(() => [...document.querySelectorAll('[data-slot="agent-actions"] .sa-hbtn')].map((b) => ({ s: b.dataset.slot, label: b.getAttribute('aria-label'), tip: b.dataset.tooltip, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), text: getComputedStyle(b.querySelector('.sa-hbtn-label') || b).display !== 'none' })));
  check(`${tag}: header buttons are 32px tall with a name and a tooltip`, btns.length === 3 && btns.every((b) => b.h === 32 && b.label && b.tip), JSON.stringify(btns));
  check(`${tag}: ${w < 560 ? 'narrow: buttons are icon-only' : 'wide: Stop and Open as chat keep their labels'}`, w < 560 ? btns.every((b) => !b.text && b.w === 32) : btns.filter((b) => b.s !== 'subagent-more').every((b) => b.text), JSON.stringify(btns));
  check(`${tag}: usage is not in the header (Overview has it once)`, await p.evaluate(() => !/tokens|steps/i.test(document.querySelector('[data-slot="agent-header"]')?.innerText || '') && document.querySelectorAll('[data-slot="agent-tab-overview"] .sa-usage').length <= 1));
  check(`${tag}: one row of sections (no stacked tab rows)`, await p.evaluate(() => { const t = document.querySelector('[data-slot="agent-view-tabs"]'); if (!t || getComputedStyle(t).flexDirection === 'column') return true; const tops = new Set([...t.querySelectorAll('[role="tab"]')].filter((x) => !x.hidden && x.getClientRects().length).map((x) => Math.round(x.getBoundingClientRect().top))); return tops.size === 1; }));

  // ---- Overview: read-only ----
  const ov = await p.evaluate(() => {
    const o = document.querySelector('[data-slot="agent-tab-overview"]');
    const card = o?.querySelector('[data-slot="subagent-last-message"]');
    return {
      card: !!card, ro: card?.dataset.readonly === 'true', text: card?.innerText || '',
      composer: !!o?.querySelector('textarea, [data-slot="subagent-composer"], [data-slot="subagent-send"]'),
      stops: [...(o?.querySelectorAll('button') || [])].filter((b) => /^(Stop|Interrupt|Steer|Send|Pick parts)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())).length,
      pick: /Pick parts/i.test(document.body.innerText),
      thread: !!o?.querySelector('.sa-chat'),
    };
  });
  check(`${tag}: Overview shows a read-only Last message (prompt + latest reply)`, ov.card && ov.ro && /compare their numbers/.test(ov.text) && /NREL says/.test(ov.text), ov.text.slice(0, 160));
  check(`${tag}: Overview has no composer, Send, Steer, Stop or Interrupt, and no full thread`, !ov.composer && !ov.stops && !ov.thread, JSON.stringify(ov));
  check(`${tag}: "Pick parts" is gone`, !ov.pick);
  await p.click('[data-slot="subagent-last-message"] .sa-last-body');
  await sleep(400);
  check(`${tag}: tapping the preview opens the Chat tab`, await p.evaluate(() => document.querySelector('[data-slot="agent-view-tabs"] [data-tab="chat"]')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('[data-slot="agent-tab-chat"] .sa-chat')));

  // ---- Chat: Interrupt vs Stop ----
  const names = await p.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim()));
  check(`${tag}: exactly one button is called Stop; the composer's is Interrupt`, names.filter((n) => n === 'Stop').length === 1 && names.includes('Interrupt'), JSON.stringify(names.filter((n) => /stop|interrupt/i.test(n))));
  await p.click('[data-slot="subagent-interrupt"]');
  await sleep(400);
  const ic = await lastCall(p, 'interrupt');
  check(`${tag}: Interrupt sends interrupt (not stop) for this agent`, ic?.id === ids.b && !(await lastCall(p, 'stop')), JSON.stringify(ic));
  await sleep(300);
  check(`${tag}: after Interrupt it reads as stopped and offers Continue`, await p.evaluate(() => /Stopped/.test(document.querySelector('[data-slot="agent-header"]')?.innerText || '') && !!document.querySelector('[data-slot="subagent-continue"]:not([hidden])')));

  // ---- Long-press multi-select (mouse hold) ----
  const SCOPE = '[data-slot="subagent-chat-section"]';
  await press(p, `${SCOPE} .sa-chat > li[data-sel-key]:nth-of-type(2)`);
  let s = await selState(p, SCOPE);
  check(`${tag}: long-press selects that message and shows the bar`, s.bar && s.checked === 1 && /1 selected/.test(s.count) && s.boxes === s.items && s.items === 4, JSON.stringify(s));
  check(`${tag}: the composer gives way to the selection bar`, await p.evaluate(() => document.querySelector('[data-slot="subagent-composer"]')?.hidden === true));
  await p.click(`${SCOPE} .sa-chat > li[data-sel-key]:nth-of-type(4)`);
  await sleep(150);
  s = await selState(p, SCOPE);
  check(`${tag}: a tap adds another`, s.checked === 2 && /2 selected/.test(s.count), JSON.stringify(s));
  await p.click(`${SCOPE} .sa-chat > li[data-sel-key]:nth-of-type(1)`, { modifiers: ['Shift'] });
  await sleep(150);
  s = await selState(p, SCOPE);
  check(`${tag}: Shift-click selects the range from the last one tapped`, s.checked === 4, JSON.stringify(s));
  await p.click(`${SCOPE} .sa-chat > li[data-sel-key]:nth-of-type(1)`);
  await sleep(100);
  const bar = await p.evaluate((sc) => { const b = document.querySelector(`${sc} [data-slot="msel-bar"]`); const r = b.getBoundingClientRect(); const vw = document.documentElement.clientWidth; return { role: b.getAttribute('role'), acts: [...b.querySelectorAll('button')].map((x) => x.dataset.slot), out: r.right > vw + 1 || r.left < -1, h: Math.round(r.height), labelled: [...b.querySelectorAll('button')].every((x) => x.getAttribute('aria-label')) }; }, SCOPE);
  check(`${tag}: the bar has Cancel, Select all, Copy, Quote, Send to parent, Send to main chat`, bar.role === 'toolbar' && ['msel-cancel', 'msel-all', 'msel-copy', 'msel-quote', 'msel-parent', 'msel-main'].every((x) => bar.acts.includes(x)) && bar.labelled && !bar.out && bar.h <= 48, JSON.stringify(bar));
  await p.click(`${SCOPE} [data-slot="msel-copy"]`);
  await sleep(250);
  const copied = await p.evaluate(() => window.__copied.slice(-1)[0] || '');
  check(`${tag}: Copy joins the chosen messages with who said each`, /\*\*beta:\*\*[\s\S]*First source[\s\S]*\*\*You:\*\*[\s\S]*compare their numbers[\s\S]*NREL says/.test(copied), copied.slice(0, 200));
  s = await selState(p, SCOPE);
  check(`${tag}: after an action the selection ends and the composer is back`, !s.bar && !s.checked && !s.boxes && await p.evaluate(() => document.querySelector('[data-slot="subagent-composer"]')?.hidden === false), JSON.stringify(s));

  // Touch long-press: the phone's own menu is held back.
  const tp = await touchPress(p, `${SCOPE} .sa-chat > li[data-sel-key]:nth-of-type(4)`);
  await sleep(150);
  s = await selState(p, SCOPE);
  check(`${tag}: a touch long-press selects without the system menu, and its click does not undo it`, s.bar && s.checked === 1 && tp.menuBlocked, JSON.stringify({ s, tp }));
  await p.click(`${SCOPE} [data-slot="msel-quote"]`);
  await sleep(250);
  const draft = await p.evaluate(() => document.querySelector('[data-slot="subagent-composer"] textarea')?.value || '');
  check(`${tag}: Quote puts the message in the composer as a quote`, /^> NREL says/.test(draft), draft.slice(0, 80));
  await p.evaluate(() => { const t = document.querySelector('[data-slot="subagent-composer"] textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); });

  // Keyboard: Space, Shift+Arrow, Ctrl+A, Esc.
  await p.focus(`${SCOPE} .sa-chat > li[data-sel-key]:nth-of-type(4)`);
  await p.keyboard.press('Space');
  await sleep(120);
  s = await selState(p, SCOPE);
  check(`${tag}: keyboard Space on a message starts selecting`, s.bar && s.checked === 1, JSON.stringify(s));
  await p.keyboard.press('Shift+ArrowUp');
  await sleep(120);
  s = await selState(p, SCOPE);
  check(`${tag}: Shift+ArrowUp extends the selection`, s.checked === 2, JSON.stringify(s));
  await p.keyboard.press('Control+a');
  await sleep(120);
  s = await selState(p, SCOPE);
  check(`${tag}: Ctrl+A selects every message`, s.checked === 4 && /4 selected/.test(s.count), JSON.stringify(s));
  const live = await p.evaluate(() => [...document.querySelectorAll('[data-slot="msel-live"]')].map((x) => x.textContent).join(' | '));
  check(`${tag}: a live region announces the count`, /4 selected|All 4/.test(live), live);
  await p.keyboard.press('Escape');
  await sleep(120);
  s = await selState(p, SCOPE);
  check(`${tag}: Esc leaves selection`, !s.bar && !s.checked, JSON.stringify(s));
  const tabs = await p.evaluate((sc) => [...document.querySelectorAll(`${sc} [data-sel-key]`)].map((e) => e.getAttribute('tabindex')), SCOPE);
  check(`${tag}: messages are reachable by Tab with one stop (roving focus)`, tabs.length === 4 && tabs.filter((t) => t === '0').length === 1, JSON.stringify({ tabs, url: await p.evaluate(() => document.querySelector('[data-slot="agent-view-tabs"] [aria-selected="true"]')?.dataset.tab) }));

  // Send to main chat: lands in the main chat's message box.
  await press(p, `${SCOPE} .sa-chat > li[data-sel-key]:nth-of-type(4)`);
  await p.click(`${SCOPE} [data-slot="msel-main"]`);
  await sleep(500);
  const mainDraft = await p.evaluate(() => document.querySelector('.aui-composer-input, .aui-composer-root textarea')?.value || '');
  check(`${tag}: Send to main chat adds it to your message in the main chat`, /NREL says/.test(mainDraft), mainDraft.slice(0, 120));

  // ---- The ··· menu: every control ----
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), ids.a);
  await sleep(400);
  await p.click('[data-slot="subagent-more"]');
  await sleep(250);
  const menu = await p.evaluate(() => { const m = document.querySelector('.sa-more-menu'); if (!m) return null; const r = m.getBoundingClientRect(); return { slots: [...m.querySelectorAll('[data-slot]')].map((e) => e.dataset.slot), heads: m.innerText, out: r.right > document.documentElement.clientWidth + 1 || r.left < -1, role: m.getAttribute('role') }; });
  const want = ['subagent-menu-interrupt', 'subagent-menu-pause', 'subagent-menu-stop-tree', 'subagent-rerun', 'subagent-menu-open-chat', 'subagent-menu-select', 'subagent-menu-copy-last', 'subagent-attach', 'subagent-menu-export', 'subagent-menu-rename', 'subagent-menu-settings', 'subagent-menu-tools', 'subagent-menu-context', 'subagent-menu-memory', 'subagent-menu-team', 'subagent-save-preset', 'subagent-menu-copy-id', 'subagent-delete-data'];
  const missing = want.filter((x) => !(menu?.slots || []).includes(x));
  check(`${tag}: the ··· menu has every control for a running agent`, menu && !missing.length, `missing ${missing.join(', ')}`);
  check(`${tag}: the menu is grouped (Run / Chat / Agent) and on screen`, menu && /Run[\s\S]*Chat[\s\S]*Agent/.test(menu.heads) && !menu.out, JSON.stringify({ out: menu?.out }));
  await p.click('[data-slot="subagent-menu-pause"]');
  await sleep(400);
  check(`${tag}: Pause sends pause`, (await lastCall(p, 'pause'))?.id === ids.a);
  check(`${tag}: a paused agent's primary header action is Resume`, await p.evaluate(() => !!document.querySelector('[data-slot="agent-actions"] [data-slot="subagent-resume"]') && /Paused/.test(document.querySelector('[data-slot="agent-header"]').innerText)));
  await p.click('[data-slot="subagent-resume"]');
  await sleep(400);
  check(`${tag}: Resume sends resume`, (await lastCall(p, 'resume'))?.id === ids.a);
  await p.click('[data-slot="subagent-more"]');
  await sleep(200);
  await p.click('[data-slot="subagent-menu-rename"]');
  await sleep(250);
  await p.fill('[data-slot="subagent-rename-input"]', 'Lead researcher');
  await p.click('[data-slot="subagent-rename-save"]');
  await sleep(400);
  const cf = await lastCall(p, 'configure');
  check(`${tag}: Edit title sends configure with the title`, cf?.id === ids.a && cf.title === 'Lead researcher', JSON.stringify(cf));
  await p.click('[data-slot="subagent-more"]');
  await sleep(200);
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 3000 }).catch(() => null), p.click('[data-slot="subagent-menu-export"]').catch(() => null)]);
  check(`${tag}: Export chat downloads a Markdown file`, !!dl && /\.md$/.test(dl.suggestedFilename()), dl ? dl.suggestedFilename() : 'no download');
  await p.click('[data-slot="subagent-more"]');
  await sleep(200);
  await p.click('[data-slot="subagent-menu-settings"]');
  await sleep(350);
  check(`${tag}: Model and limits opens Settings`, await p.evaluate(() => document.querySelector('[data-slot="agent-view-tabs"] [data-tab="settings"]')?.getAttribute('aria-selected') === 'true'));
  await p.click('[data-slot="subagent-more"]');
  await sleep(200);
  await p.click('[data-slot="subagent-menu-select"]');
  await sleep(350);
  s = await selState(p, SCOPE);
  check(`${tag}: ··· → Select messages opens the chat in selection mode`, s.bar, JSON.stringify(s));
  await p.keyboard.press('Escape');
  await sleep(150);
  await p.click('[data-slot="subagent-more"]');
  await sleep(200);
  await p.click('[data-slot="subagent-menu-stop-tree"]');
  await sleep(250);
  await p.click('.dialog-footer .btn-destructive, [role="alertdialog"] .btn-destructive, [role="dialog"] .btn-destructive').catch(() => null);
  await sleep(400);
  check(`${tag}: Stop it and the agents below sends stopTree after a confirm`, (await lastCall(p, 'stopTree'))?.id === ids.a);
  await sleep(300);
  check(`${tag}: a stopped agent's primary header action is Try again`, await p.evaluate(() => !!document.querySelector('[data-slot="agent-actions"] [data-slot="subagent-retry"]')));

  // ---- Open as chat: one-line header + multi-select ----
  await p.click('[data-slot="agent-header"] [data-slot="subagent-open-chat"]');
  await sleep(700);
  const fh = await headerBoxes(p, '[data-slot="subagent-chat-head-row"]');
  check(`${tag}: Open as chat: back, name, status, action and ··· on one line`, !!fh && fh.spread <= 4 && fh.h <= 44 && !fh.overlaps.length && !fh.out.length && fh.parts.some((x) => x.k === 'subagent-chat-more'), JSON.stringify({ h: fh?.h, spread: fh?.spread, o: fh?.overlaps, out: fh?.out, k: fh?.parts.map((x) => x.k) }));
  const fullMsg = '.aui-thread-viewport .aui-message[data-message-id]';
  const nMsgs = await p.locator(fullMsg).count();
  if (nMsgs) {
    const visible = await p.evaluate((sel) => [...document.querySelectorAll(sel)].findIndex((el) => { const r = el.getBoundingClientRect(); for (let y = r.top + 8; y < r.bottom; y += 12) for (let x = r.left + 8; x < r.right; x += 16) { const t = document.elementFromPoint(x, y); if (t && el.contains(t)) return true; } return false; }), fullMsg);
    await press(p, `${fullMsg} >> nth=${Math.max(0, visible)}`);
    s = await selState(p, '.aui-thread-root, body');
    check(`${tag}: Open as chat: long-press selects a message and shows the bar`, s.bar && s.checked === 1, JSON.stringify(s));
    check(`${tag}: Open as chat: the composer gives way to the bar`, await p.evaluate(() => document.querySelector('.aui-composer-root')?.hidden === true));
    await p.keyboard.press('Escape');
    await sleep(150);
    s = await selState(p, '.aui-thread-root, body');
    check(`${tag}: Open as chat: Esc leaves selection`, !s.bar && !s.checked, JSON.stringify(s));
  } else check(`${tag}: Open as chat shows its messages`, false, 'no messages');
  await p.click('[data-slot="subagent-chat-back"]');
  await sleep(400);
  check(`${tag}: the main chat has no selection checkboxes`, await p.evaluate(() => !document.querySelector('.aui-thread-viewport .msel-check') && document.querySelector('[data-slot="msel-bar"]:not([hidden])') === null));

  check(`${tag}: no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE || undefined });
  for (const w of (process.env.W ? [+process.env.W] : [320, 390, 1280])) for (const dark of (process.env.W ? [false] : [false, true])) {
    try { await suite(browser, w, dark); } catch (e) { check(`${w}px ${dark ? 'dark' : 'light'} crashed`, false, String(e.message || e).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  console.log(results.join('\n'));
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\nsubagent-view: ${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
