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
  const parts = [...row.querySelectorAll('h3, .sa-chat-head-title, .sa-status, .chip, .sa-hbtn, .sa-hnav, .sa-dhead-avatar, .sa-crumb-switch, .sa-chat-back, [data-slot="subagent-chat-back"]')]
    .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    .map((e) => { const r = e.getBoundingClientRect(); return { k: e.dataset.slot || e.className.split(' ')[0] || e.tagName, l: r.left, r: r.right, t: r.top, b: r.bottom, cy: (r.top + r.bottom) / 2, w: r.width, txt: (e.innerText || '').trim().slice(0, 20) }; });
  const overlaps = [];
  for (let i = 0; i < parts.length; i += 1) for (let j = i + 1; j < parts.length; j += 1) {
    const a = parts[i]; const b = parts[j];
    if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) overlaps.push(`${a.k}~${b.k}`);
  }
  const cys = parts.map((x) => x.cy);
  return { h: rr.height, w: rr.width, spread: Math.max(...cys) - Math.min(...cys), overlaps, out: parts.filter((x) => x.r > vw + 1 || x.l < -1 || x.r > rr.right + 1 || x.l < rr.left - 1).map((x) => x.k), parts, rowRight: rr.right, vw, scroll: row.scrollWidth - row.clientWidth };
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

  // ---- Header: ONE line, nothing above it ----
  const hb = await headerBoxes(p, '[data-slot="agent-header-row"]');
  const slots = (hb?.parts || []).map((x) => x.k);
  check(`${tag}: header has back, name, switcher, status, Stop, Open as chat, ··· and close on one line`, !!hb && ['agent-back', 'agent-switcher', 'subagent-stop', 'subagent-open-chat', 'subagent-more', 'agent-close'].every((s) => slots.includes(s)) && slots.includes('agent-status') && hb.spread <= 4 && hb.h <= 44, JSON.stringify({ h: hb?.h, spread: hb?.spread, slots }));
  check(`${tag}: header pieces do not overlap, stay inside the line and on screen`, !!hb && !hb.overlaps.length && !hb.out.length && hb.scroll <= 1, JSON.stringify({ o: hb?.overlaps, out: hb?.out, scroll: hb?.scroll }));
  const top = await p.evaluate(() => {
    const panel = document.querySelector('.dialog.sa-dialog');
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const row = document.querySelector('[data-slot="agent-header-row"]').getBoundingClientRect();
    const tabs = document.querySelector('[data-slot="agent-view-tabs"]')?.getBoundingClientRect();
    const headed = [...panel.querySelectorAll('h1, h2, h3, .dialog-title')].filter(vis).map((e) => e.textContent.trim());
    return { title: vis(panel.querySelector(':scope > .dialog-header')), agentsHeading: headed.includes('Agents'), crumbRow: vis(panel.querySelector('[data-slot="agent-breadcrumb"], .sa-crumbs')),
      strayClose: vis(panel.querySelector(':scope > .dialog-close')), strayExpand: vis(panel.querySelector(':scope > .sa-dock-expand')),
      rowFromTop: Math.round(row.top - panel.getBoundingClientRect().top), gapToTabs: tabs ? Math.round(tabs.top - row.bottom) : 99,
      linesAboveTabs: new Set([...panel.querySelectorAll('button, h3, .chip, .sa-status')].filter(vis).filter((e) => tabs && e.getBoundingClientRect().bottom <= tabs.top + 1).map((e) => Math.round((e.getBoundingClientRect().top + e.getBoundingClientRect().bottom) / 4))).size };
  });
  check(`${tag}: no "Agents" title row and no breadcrumb row above the header`, !top.title && !top.agentsHeading && !top.crumbRow && !top.strayClose && !top.strayExpand, JSON.stringify(top));
  check(`${tag}: the header is the panel's first line and the tabs sit right under it`, top.rowFromTop <= 28 && top.gapToTabs >= 0 && top.gapToTabs <= 12 && top.linesAboveTabs <= 2, JSON.stringify(top));
  const btns = await p.evaluate(() => [...document.querySelectorAll('[data-slot="agent-header-row"] .sa-hbtn, [data-slot="agent-header-row"] .sa-hnav, [data-slot="agent-header-row"] .sa-crumb-switch')].filter((b) => b.getClientRects().length).map((b) => ({ s: b.dataset.slot, label: b.getAttribute('aria-label'), tip: b.dataset.tooltip, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), text: !!b.querySelector('.sa-hbtn-label') && getComputedStyle(b.querySelector('.sa-hbtn-label')).display !== 'none' })));
  check(`${tag}: every header button has a name and a tooltip, 28-32px`, btns.length >= 6 && btns.every((b) => b.label && b.tip && b.h >= 28 && b.h <= 32), JSON.stringify(btns));
  const labelled = hb && hb.w >= 520;
  check(`${tag}: ${labelled ? 'wide line: Stop and Open as chat keep their labels' : 'tight line: buttons are icon-only'}`, labelled ? btns.filter((b) => ['subagent-stop', 'subagent-open-chat'].includes(b.s)).every((b) => b.text) : btns.filter((b) => b.s && b.s !== 'agent-switcher').every((b) => !b.text && b.w === 32), JSON.stringify({ w: hb?.w, btns }));
  const st = await p.evaluate(() => { const c = document.querySelector('[data-slot="agent-header-row"] [data-slot="agent-status"]'); return { text: c?.textContent, title: c?.title }; });
  check(`${tag}: the status keeps its word (as text or tooltip) for readers`, /Running/.test(st.text || '') && /Running/.test(st.title || ''), JSON.stringify(st));
  // Everything still reachable: the graph (on the line or in the Graph tab), the whole path, back, expand, close.
  const graphOnLine = slots.includes('agent-graph');
  await p.click('[data-slot="subagent-more"]');
  await sleep(200);
  const graphInMenu = await p.evaluate(() => !!document.querySelector('[role="menu"] [data-slot="subagent-menu-graph"]'));
  await p.keyboard.press('Escape');
  await sleep(150);
  const graphTab = await p.evaluate(() => !!document.querySelector('[data-slot="agent-view-tabs"] [data-tab="graph"]'));
  check(`${tag}: the team graph has one home (${graphOnLine ? 'on the line' : 'the Graph tab'}), never repeated in ···`, !graphInMenu && (graphOnLine || graphTab), JSON.stringify({ graphOnLine, graphInMenu, graphTab, w: hb?.w }));
  await p.click('[data-slot="agent-switcher"]');
  await sleep(200);
  const path = await p.evaluate(() => [...document.querySelectorAll('[role="menu"] [data-slot="agent-switch-all"], [role="menu"] [data-slot="agent-path-item"], [role="menu"] [data-slot="agent-path-here"]')].map((e) => e.querySelector('.truncate').textContent.trim()));
  check(`${tag}: the switcher menu holds the whole path (All agents › parent › here)`, JSON.stringify(path) === '["All agents","Title alpha","Title beta"]', JSON.stringify(path));
  await p.click('[role="menu"] [data-slot="agent-switch-all"]');
  await sleep(400);
  const list = await p.evaluate(() => ({ title: !!document.querySelector('.dialog.sa-dialog > .dialog-header')?.getClientRects().length, header: !!document.querySelector('[data-slot="agent-header-row"]')?.getClientRects().length }));
  check(`${tag}: All agents opens the list (which keeps its own title)`, list.title && !list.header, JSON.stringify(list));
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), ids.b);
  await sleep(400);
  const back = await p.getAttribute('[data-slot="agent-back"]', 'aria-label');
  await p.click('[data-slot="agent-back"]');
  await sleep(400);
  check(`${tag}: ‹ goes up one level to the parent`, back === 'Back to Title alpha' && (await p.textContent('.sa-detail-name')) === 'alpha', back);
  const back2 = await p.getAttribute('[data-slot="agent-back"]', 'aria-label');
  check(`${tag}: at the top level ‹ goes to All agents`, back2 === 'Back to all agents', back2);
  if (w > 640) {
    const before = await p.evaluate(() => Math.round(document.querySelector('.dialog.sa-dialog').getBoundingClientRect().width));
    await p.click('[data-slot="agent-header-row"] [data-slot="agent-expand"]');
    await sleep(300);
    const after = await p.evaluate(() => ({ w: Math.round(document.querySelector('.dialog.sa-dialog').getBoundingClientRect().width), pressed: document.querySelector('[data-slot="agent-header-row"] [data-slot="agent-expand"]').getAttribute('aria-pressed') }));
    const hbw = await headerBoxes(p, '[data-slot="agent-header-row"]');
    check(`${tag}: expand on the line widens the panel; the line still fits`, after.w > before && after.pressed === 'true' && !hbw.overlaps.length && !hbw.out.length, JSON.stringify({ before, after, o: hbw.overlaps, out: hbw.out }));
    await p.click('[data-slot="agent-header-row"] [data-slot="agent-expand"]');
    await sleep(300);
  } else {
    check(`${tag}: no expand on a full-screen panel`, await p.evaluate(() => !document.querySelector('[data-slot="agent-header-row"] [data-slot="agent-expand"]')?.getClientRects().length));
  }
  await p.click('[data-slot="agent-close"]');
  await sleep(400);
  check(`${tag}: × on the line closes the panel`, await p.evaluate(() => !document.querySelector('.dialog.sa-dialog')));
  // A long name truncates with an ellipsis; the line still fits.
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), ids.b);
  await sleep(500);
  const longName = await p.evaluate(() => { const n = document.querySelector('[data-slot="agent-header-row"] h3'); n.textContent = 'A very long sub-agent name that cannot possibly fit on one line here'; return { cut: n.scrollWidth > n.clientWidth, ell: getComputedStyle(n).textOverflow }; });
  const hbl = await headerBoxes(p, '[data-slot="agent-header-row"]');
  check(`${tag}: a long name truncates with an ellipsis and the line still fits`, longName.cut && longName.ell === 'ellipsis' && !hbl.overlaps.length && !hbl.out.length && hbl.spread <= 4 && hbl.scroll <= 1, JSON.stringify({ longName, o: hbl.overlaps, out: hbl.out }));
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'overview' }), ids.a);
  await sleep(200);
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'overview' }), ids.b);
  await sleep(400);
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
  const want = ['subagent-menu-interrupt', 'subagent-menu-pause', 'subagent-menu-stop-tree', 'subagent-rerun', 'subagent-menu-select', 'subagent-attach', 'subagent-menu-export', 'subagent-save-preset', 'subagent-menu-copy-id', 'subagent-delete-data'];
  const missing = want.filter((x) => !(menu?.slots || []).includes(x));
  check(`${tag}: the ··· menu has every control with no other home (running agent)`, menu && !missing.length, `missing ${missing.join(', ')}`);
  // One home per action: nothing the header line, a tab or a chat reply already has.
  const dupes = ['subagent-menu-retry', 'subagent-menu-resume', 'subagent-menu-open-chat', 'subagent-menu-copy-last', 'subagent-menu-rename', 'subagent-menu-settings', 'subagent-menu-tools', 'subagent-menu-context', 'subagent-menu-memory', 'subagent-menu-team', 'subagent-menu-swarm', 'subagent-menu-priority', 'subagent-menu-graph'].filter((x) => (menu?.slots || []).includes(x));
  check(`${tag}: the ··· menu repeats nothing from the header, the tabs or the chat`, menu && !dupes.length, `duplicates ${dupes.join(', ')}`);
  check(`${tag}: the ··· menu is short (≤ 10 items for a running agent)`, menu && menu.slots.length <= 10, String(menu?.slots.length));
  check(`${tag}: the menu is grouped (Run / Chat / Agent) and on screen`, menu && /Run[\s\S]*Chat[\s\S]*Agent/.test(menu.heads) && !menu.out, JSON.stringify({ out: menu?.out }));
  await p.click('[data-slot="subagent-menu-pause"]');
  await sleep(400);
  check(`${tag}: Pause sends pause`, (await lastCall(p, 'pause'))?.id === ids.a);
  check(`${tag}: a paused agent's primary header action is Resume`, await p.evaluate(() => !!document.querySelector('[data-slot="agent-actions"] [data-slot="subagent-resume"]') && /Paused/.test(document.querySelector('[data-slot="agent-header"]').innerText)));
  await p.click('[data-slot="subagent-resume"]');
  await sleep(400);
  check(`${tag}: Resume sends resume`, (await lastCall(p, 'resume'))?.id === ids.a);
  await pickTab(p, 'settings');
  const setTab = await p.evaluate(() => ({ title: !!document.querySelector('[data-slot="agent-settings-identity"] [data-key="title"]'), model: !!document.querySelector('[data-slot="agent-content"] [data-key="model"]'), setup: !!document.querySelector('[data-slot="subagent-setup"]') }));
  check(`${tag}: Settings is the one home for title and model (no second Setup block)`, setTab.title && setTab.model && !setTab.setup, JSON.stringify(setTab));
  await pickTab(p, 'overview');
  await p.click('[data-slot="subagent-more"]');
  await sleep(200);
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 3000 }).catch(() => null), p.click('[data-slot="subagent-menu-export"]').catch(() => null)]);
  check(`${tag}: Export chat downloads a Markdown file`, !!dl && /\.md$/.test(dl.suggestedFilename()), dl ? dl.suggestedFilename() : 'no download');
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
  check(`${tag}: Open as chat: back, name, path, status, action and ··· on one line`, !!fh && fh.spread <= 4 && fh.h <= 44 && !fh.overlaps.length && !fh.out.length && fh.scroll <= 1 && ['subagent-chat-back', 'subagent-chat-path', 'subagent-chat-more'].every((k) => fh.parts.some((x) => x.k === k)), JSON.stringify({ h: fh?.h, spread: fh?.spread, o: fh?.overlaps, out: fh?.out, k: fh?.parts.map((x) => x.k) }));
  const chatTop = await p.evaluate(() => ({ crumbs: !!document.querySelector('[data-slot="subagent-chat-crumbs"]'), rows: document.querySelector('[data-slot="subagent-chat-header"]')?.children.length, h: Math.round(document.querySelector('[data-slot="subagent-chat-header"]')?.getBoundingClientRect().height || 0) }));
  check(`${tag}: Open as chat: no path row above the header`, !chatTop.crumbs && chatTop.h <= 56, JSON.stringify(chatTop));
  // On a wide screen the docked panel stays open beside the chat and covers its right edge; close it first.
  if (await p.evaluate(() => !!document.querySelector('.dialog.sa-dialog'))) { await p.keyboard.press('Escape'); await sleep(400); }
  await p.click('[data-slot="subagent-chat-path"]');
  await sleep(200);
  const cpath = await p.evaluate(() => [...document.querySelectorAll('[role="menu"] [data-slot^="subagent-chat-path"]')].map((e) => e.querySelector('.truncate').textContent.trim()));
  await p.keyboard.press('Escape');
  await sleep(150);
  const opened = await p.evaluate(() => window.__app.chat.main.subagentId);
  check(`${tag}: Open as chat: the path menu runs from Main agent down to this agent`, JSON.stringify(cpath) === (opened === ids.b ? '["Main agent","alpha","beta"]' : '["Main agent","alpha"]'), JSON.stringify({ cpath, opened }));
  const cgLine = fh.parts.some((x) => x.k === 'subagent-chat-graph-btn');
  await p.click('[data-slot="subagent-chat-more"]');
  await sleep(200);
  const cgMenu = await p.evaluate(() => !!document.querySelector('[role="menu"] [data-slot="subagent-chat-graph"]'));
  await p.keyboard.press('Escape');
  await sleep(150);
  check(`${tag}: Open as chat: the team graph is on the line or in ···, never both`, cgLine !== cgMenu, JSON.stringify({ cgLine, cgMenu }));
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
