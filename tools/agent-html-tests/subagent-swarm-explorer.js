// Explorer swarm layer: topic pills linked to subscribers, curved handoff arrows with counts, allow / deny rule
// edges, who-may-talk lines (dense topologies fold into one label), the coordinator's crown and role badges, the
// live message flow (reduced motion: edge highlight only) and "Draw rule" (pick, pick, allow/deny, saved through
// AgentSwarm.addEdge -> setCommsConfig). Layout at 1280/390, light and dark. Runs on the mock engine.
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { seedDemo } = require('./demo-seed.js');
const { seedSwarm } = require('./swarm-seed.js');
const { layoutAudit } = require('./layout-audit.js');

const EXE = (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = 'file://' + path.resolve(__dirname, '../../www/agent.html');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`); };
const BASE = ['subagentQueue', 'subagentData', 'subagentReuse', 'crossSession', 'subagentGraph', 'subagentTeam', 'subagentChatAllow', 'subagentAdvanced'];
const SHOTS = process.env.SHOTS || '';

async function open(browser, { width = 1280, height = 900, dark = false, swarm = true, reduced = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript((f) => { window.__SA_CFG = { s1features: f }; window.__MEM_CFG = { goals: true }; }, swarm ? [...BASE, 'subagentSwarm'] : BASE);
  for (const f of ['mock3.js', 'mock-v2.js', 'mock-subagents.js', 'mock-memory.js', 'mock-swarm.js']) await ctx.addInitScript({ content: read(f) });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  if (dark) await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => { window.__sa.mainKey = window.__app.chat.mainId; });
  await sleep(300);
  return { p, ctx, errs };
}
async function seed(p, opts) { const { ids, k } = await seedDemo(p); await seedSwarm(p, ids, opts); return { ids, k }; }
async function rule(p, from, to, allow, both = false) {
  await p.evaluate(([f, t, a, b]) => { const S = window.__swarm; S.configs.chat = { ...(S.configs.chat || {}), edges: [...((S.configs.chat || {}).edges || []), { from: f, to: t, allow: a, both: b }] }; }, [from, to, allow, both]);
}
async function openExplorer(p) {
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' }));
  await p.waitForSelector('[data-slot=subagent-explorer] [data-node]', { timeout: 5000 }).catch(() => {});
  await sleep(700);
}
const X = (p, fn, arg) => p.evaluate(fn, arg);
const state = (p) => X(p, () => {
  const root = document.querySelector('[data-slot=subagent-explorer]');
  const q = (s) => [...(root?.querySelectorAll(s) || [])];
  return {
    swarm: root?.dataset.swarm, flows: Number(root?.dataset.flows || 0),
    topics: q('.sa-x-topic').map((t) => t.dataset.topic), topicLinks: q('.sa-x-topiclink').length,
    handoffs: q('[data-edge=handoff]').map((e) => `${e.dataset.from}>${e.dataset.to}:${e.dataset.count}`),
    rules: q('[data-edge=rule]').map((e) => `${e.dataset.rule}:${e.dataset.from}>${e.dataset.to}${e.dataset.both ? ':both' : ''}`),
    ban: q('[data-edge=rule][data-rule=deny] .sa-x-ban').length,
    topo: q('.sa-x-topo').length, tag: root?.querySelector('[data-slot=explorer-swarm-tag]')?.hidden === false ? root.querySelector('[data-slot=explorer-swarm-tag]').textContent : '',
    crown: q('[data-coordinator=true]').map((n) => n.dataset.node), crownIcon: q('[data-slot=explorer-crown]').length,
    roles: q('[data-node][data-role]').map((n) => `${n.dataset.node}:${n.dataset.role}`),
    chips: q('[data-slot=explorer-layers]').filter((c) => !c.hidden).map((c) => c.dataset.slot),
    draw: !root?.querySelector('[data-slot=explorer-draw-rule]')?.hidden,
    summary: root?.querySelector('.sa-x-summary')?.textContent || '',
  };
});
module.exports = { open, seed, rule, openExplorer, state, sleep };
const subCalls = (p, action) => p.evaluate((a) => window.__mock.calls.filter((c) => c.name === 'agent.subagents').map((c) => c.args || {}).filter((x) => !a || x.action === a), action);
const node = (p, id) => p.locator(`[data-slot=subagent-explorer] [data-node="${id}"]`);
const inspector = (p) => p.evaluate(() => document.querySelector('[data-slot=explorer-inspector]')?.innerText || '');
async function refresh(p) { await p.evaluate(() => window.__subagents?.refreshGraph?.()); await p.locator('[data-slot=explorer-fit]').click().catch(() => {}); await sleep(700); }
/** Re-mounts the Explorer so it reads the graph again (what the app does when the chat changes). */
async function reopen(p) { await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'overview' })).catch(() => {}); await sleep(200); await openExplorer(p); }
const audit = (p) => p.evaluate(`(${layoutAudit.toString()})()`);
const swarmOverlaps = (p) => p.evaluate(() => {
  const root = document.querySelector('[data-slot=subagent-explorer]');
  const R = (e) => e.getBoundingClientRect();
  const ov = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  const nodes = [...root.querySelectorAll('.sa-x-node .sa-x-box')].map(R);
  const topics = [...root.querySelectorAll('.sa-x-topic rect')].map(R);
  const marks = [...root.querySelectorAll('[data-edge=handoff] .sa-x-count circle, .sa-x-ban circle')].map(R);
  const out = [];
  topics.forEach((t, i) => { nodes.forEach((n) => { if (ov(t, n)) out.push(`topic ${i} over a node`); }); topics.forEach((u, j) => { if (i < j && ov(t, u)) out.push('topics overlap'); }); });
  marks.forEach((c, i) => nodes.forEach((n) => { if (ov(c, n)) out.push(`edge label ${i} over a node`); }));
  for (const t of root.querySelectorAll('.sa-x-topic-name')) if (/\u2026$/.test(t.textContent) && t.textContent.length < 8) out.push(`topic name cut to "${t.textContent}"`);
  return out;
});

async function testGating(browser) {
  for (const swarm of [false, true]) {
    const { p, ctx, errs } = await open(browser, { swarm });
    await seed(p); await openExplorer(p);
    const s = await state(p);
    if (!swarm) check('without the swarm feature: no swarm layer, no Swarm or Draw rule controls', !s.topics.length && !s.crownIcon && !s.handoffs.length && !s.draw && !s.chips.length && s.swarm === 'false', JSON.stringify(s));
    else check('with the swarm feature: the swarm layer, the Swarm layers menu and Draw rule show', s.topics.length === 2 && s.crownIcon === 1 && s.draw && s.chips.length === 1 && s.swarm === 'true', JSON.stringify(s));
    const rows = await p.evaluate(() => [...document.querySelectorAll('[role=tablist]')].filter((t) => t.offsetParent).length);
    check(`${swarm ? 'with' : 'without'} swarm: never stacked tab rows`, rows <= 1, String(rows));
    check(`${swarm ? 'with' : 'without'} swarm: no page errors`, !errs.length, errs.join(' | ').slice(0, 300));
    await ctx.close();
  }
}

async function testLayer(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await rule(p, 'polish', 'web-scout', false); await rule(p, 'writer', 'draft', true, true);
  await openExplorer(p);
  const s = await state(p);
  check('topic pills: one per topic, linked to their subscribers', s.topics.join() === 'research,release-notes' && s.topicLinks >= 6, `${s.topics} links=${s.topicLinks}`);
  const pill = await p.$eval('.sa-x-topic[data-topic=research]', (g) => ({ label: g.getAttribute('aria-label'), count: g.querySelector('.sa-x-topic-count').textContent }));
  check('a topic pill names its subscribers and posts for screen readers, and shows the post count', /Topic research: 4 subscribers, 12 posts/.test(pill.label) && pill.count === '12', JSON.stringify(pill));
  check('handoff arrows: outline to draft and draft to fact-checker, each with its count', s.handoffs.includes(`${ids.outline}>${ids.draft}:1`) && s.handoffs.includes(`${ids.draft}>${ids['fact-checker']}:1`) && s.handoffs.length === 2, s.handoffs.join());
  const curved = await p.$$eval('[data-edge=handoff] path', (ps) => ps.every((x) => /Q/.test(x.getAttribute('d'))));
  check('handoff arrows are curves, set apart from the straight "started" lines', curved);
  check('rules: allow (both ways) and deny edges, deny with its no-entry mark', s.rules.includes(`allow:${ids.writer}>${ids.draft}:both`) && s.rules.includes(`deny:${ids.polish}>${ids['web-scout']}`) && s.ban === 1, s.rules.join());
  const colors = await p.evaluate(() => { const c = (sel) => getComputedStyle(document.querySelector(sel)).stroke; return { allow: c('[data-rule=allow] path'), deny: c('[data-rule=deny] path'), handoff: c('[data-edge=handoff] path'), spawn: c('[data-edge=spawn] path') }; });
  check('allow, deny, handoff and started edges each have their own colour', new Set(Object.values(colors)).size === 4, JSON.stringify(colors));
  const both = await p.$eval('[data-rule=allow] path', (x) => !!x.getAttribute('marker-start') && !!x.getAttribute('marker-end'));
  check('a both-ways rule has an arrowhead at each end', both);
  check('the coordinator (draft) wears the crown; lead and hub roles show as badges', s.crown.join() === ids.draft && s.roles.includes(`${ids.draft}:lead`) && s.roles.includes(`${ids['web-scout']}:hub`), JSON.stringify([s.crown, s.roles]));
  const lbl = await node(p, ids.draft).getAttribute('aria-label');
  check('the coordinator and its role are in the node\u2019s accessible name', /coordinator \(term 2\)/.test(lbl) && /lead/.test(lbl), lbl);
  check('the summary names the chat\u2019s topology', /Hierarchical/.test(s.summary), s.summary);
  check('sparse topology: who-may-talk lines are drawn, with no "lines hidden" label', s.topo > 0 && !s.tag, `${s.topo} ${s.tag}`);
  await node(p, ids.draft).click(); await sleep(400);
  const insp = await inspector(p);
  check('the inspector lists the agent\u2019s swarm facts: role, topics, handoffs, rules', /Lead · coordinator, term 2/.test(insp) && /#research/.test(insp) && /1 out · 1 in/.test(insp) && /1 allow/.test(insp), insp.replace(/\n/g, ' | ').slice(0, 400));
  check('swarm labels and pills sit clear of every node', !(await swarmOverlaps(p)).length, (await swarmOverlaps(p)).join());
  // more handoffs on the same pair add up on one arrow
  await p.evaluate(([a, b]) => { window.__swarm.handoff(a, b, 'Again', Date.now()); window.__swarm.handoff(a, b, 'And again', Date.now()); }, [ids.outline, ids.draft]);
  await reopen(p);
  check('repeat handoffs add up on one arrow (count 3)', (await state(p)).handoffs.includes(`${ids.outline}>${ids.draft}:3`), (await state(p)).handoffs.join());
  check('layer: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testLayersMenu(browser) {
  const { p, ctx, errs } = await open(browser);
  await seed(p); await openExplorer(p);
  const btn = p.locator('[data-slot=explorer-layers]');
  check('the Swarm layers button says how many layers show', /4 of 4/.test(await btn.getAttribute('aria-label')) && (await btn.getAttribute('aria-haspopup')) === 'menu', await btn.getAttribute('aria-label'));
  await btn.click(); await sleep(250);
  const items = await p.$$eval('.sa-x-layers-menu [role=menuitemcheckbox]', (els) => els.map((e) => `${e.dataset.edgeToggle}:${e.getAttribute('aria-checked')}`));
  check('the menu has four checkbox items, all on', items.join() === 'handoff:true,rule:true,topic:true,topology:true', items.join());
  check('the menu opens with focus on its first item and aria-expanded on the button', (await p.evaluate(() => document.activeElement?.dataset.edgeToggle)) === 'handoff' && (await btn.getAttribute('aria-expanded')) === 'true');
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await sleep(400);
  let s = await state(p);
  check('turning Topics off from the keyboard hides the pills and their links', !s.topics.length && !s.topicLinks, JSON.stringify(s.topics));
  check('the button count follows (3 of 4) and focus returns to it', /3 of 4/.test(await btn.getAttribute('aria-label')) && (await p.evaluate(() => document.activeElement?.dataset.slot)) === 'explorer-layers', await btn.getAttribute('aria-label'));
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('agent.subagents.explorer.v1') || '{}').edges?.topic);
  check('the choice is remembered', saved === false, String(saved));
  await btn.click(); await sleep(200);
  check('the menu shows Topics unchecked', (await p.getAttribute('.sa-x-layers-menu [data-edge-toggle=topic]', 'aria-checked')) === 'false');
  await p.locator('.sa-x-layers-menu [data-edge-toggle=topic]').click(); await sleep(400);
  s = await state(p);
  check('turning Topics back on brings the pills back', s.topics.length === 2);
  for (const k of ['handoff', 'rule']) { await btn.click(); await sleep(200); await p.locator(`.sa-x-layers-menu [data-edge-toggle=${k}]`).click(); await sleep(300); }
  s = await state(p);
  check('Handoffs and Rules turn off on their own', !s.handoffs.length && !s.rules.length && s.topics.length === 2);
  check('layers menu: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await p.evaluate(() => localStorage.removeItem('agent.subagents.explorer.v1'));
  await ctx.close();
}

async function testDense(browser) {
  const { p, ctx, errs } = await open(browser);
  await seed(p);
  await p.evaluate(() => { window.__swarm.configs.chat.topology = 'mesh'; });
  await openExplorer(p);
  let s = await state(p);
  check('a dense topology (mesh) draws no who-may-talk lines and says so in one label', s.topo === 0 && /Mesh: \d+ links/.test(s.tag) && /lines hidden/.test(s.tag), `${s.topo} "${s.tag}"`);
  const tag = await p.$eval('[data-slot=explorer-swarm-tag]', (e) => ({ title: e.title, r: e.getBoundingClientRect().toJSON(), z: e.closest('.sa-x-canvaswrap').querySelector('[data-slot=explorer-controls]').getBoundingClientRect().toJSON() }));
  check('the label explains itself and does not cover the zoom controls', /pairs of agents may message each other/.test(tag.title) && (tag.r.right <= tag.z.left || tag.r.bottom <= tag.z.top || tag.r.top >= tag.z.bottom), JSON.stringify(tag).slice(0, 200));
  await p.locator('[data-slot=explorer-layers]').click(); await sleep(200); await p.locator('.sa-x-layers-menu [data-edge-toggle=topology]').click(); await sleep(300);
  s = await state(p);
  check('turning "Can talk" off removes the label too', !s.tag);
  await p.locator('[data-slot=explorer-layers]').click(); await sleep(200); await p.locator('.sa-x-layers-menu [data-edge-toggle=topology]').click(); await sleep(200);
  await p.evaluate(() => { window.__swarm.configs.chat.topology = 'chain'; delete window.__sa.subs.get([...window.__sa.subs.keys()].find((k) => window.__sa.subs.get(k).name === 'fact-checker')).topology; });
  await reopen(p);
  s = await state(p);
  check('a sparse topology (chain) draws its lines again', s.topo > 0 && !s.tag && /Chain/.test(s.summary), `${s.topo} ${s.summary}`);
  check('dense: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testFlow(browser) {
  for (const reduced of [false, true]) {
    const { p, ctx, errs } = await open(browser, { reduced });
    const { ids } = await seed(p);
    await openExplorer(p);
    const before = (await state(p)).flows;
    await p.evaluate(([a, b]) => { window.__mock.emit('subagent.peer_message', { ...window.__sa.subs.get(a), id: a, to: b, toName: 'fact-checker', text: 'Numbers checked?' }); }, [ids.draft, ids['fact-checker']]);
    await sleep(150);
    const s = await p.evaluate(([a, b]) => ({ flows: Number(document.querySelector('[data-slot=subagent-explorer]').dataset.flows || 0), dots: document.querySelectorAll('.sa-x-flowdot').length, flash: !!document.querySelector(`[data-edge=message][data-from="${a}"][data-to="${b}"][data-flash=true]`) }), [ids.draft, ids['fact-checker']]);
    if (!reduced) check('a new message runs a dot along its edge, and the edge lights up', s.flows === before + 1 && s.dots === 1 && s.flash, JSON.stringify(s));
    else check('reduced motion: no moving dot, the edge only lights up', s.flows === before + 1 && s.dots === 0 && s.flash, JSON.stringify(s));
    await sleep(2000);
    const after = await p.evaluate(() => ({ dots: document.querySelectorAll('.sa-x-flowdot').length, flash: document.querySelectorAll('[data-flash=true]').length }));
    check(`${reduced ? 'reduced motion: ' : ''}the dot and the highlight clear afterwards`, !after.dots && !after.flash, JSON.stringify(after));
    if (!reduced) {
      await p.evaluate(([a, b]) => { window.__swarm.handoff(a, b, 'Polish it', Date.now()); window.__mock.emit('subagent.handoff', { ...window.__sa.subs.get(a), id: a, to: b, toName: 'polish', text: 'Polish it' }); }, [ids['fact-checker'], ids.polish]);
      await sleep(900);
      const h = await state(p);
      check('a live handoff runs along a new handoff arrow', h.flows === before + 2 && h.handoffs.includes(`${ids['fact-checker']}>${ids.polish}:1`), JSON.stringify([h.flows, h.handoffs]));
    }
    check(`flow${reduced ? ' (reduced motion)' : ''}: no page errors`, !errs.length, errs.join(' | ').slice(0, 300));
    await ctx.close();
  }
}

async function testDrawRule(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await openExplorer(p);
  const draw = p.locator('[data-slot=explorer-draw-rule]');
  await draw.click(); await sleep(300);
  const bar = () => p.evaluate(() => { const b = document.querySelector('[data-slot=explorer-drawbar]'); return b && !b.hidden ? b.innerText : ''; });
  check('Draw rule turns the mode on and says what to do', (await draw.getAttribute('aria-pressed')) === 'true' && /pick the agent the messages come from/i.test(await bar()), await bar());
  check('the first sub-agent gets focus for keyboard users', (await p.evaluate(() => document.activeElement?.closest('[data-node]')?.dataset.node)) === ids['web-scout'] || !!(await p.evaluate(() => document.activeElement?.closest('[data-node]:not([data-main])'))));
  await p.keyboard.press('Escape'); await sleep(250);
  check('Esc leaves the mode and returns focus to the button', (await draw.getAttribute('aria-pressed')) === 'false' && !(await bar()) && (await p.evaluate(() => document.activeElement?.dataset.slot)) === 'explorer-draw-rule');
  await draw.click(); await sleep(250);
  await node(p, '__main__').click(); await sleep(250);
  check('the main agent cannot be picked, with a reason', /between sub-agents/i.test(await bar()), await bar());
  await node(p, ids.polish).click(); await sleep(300);
  check('picking the first agent marks it and asks for the second', /From polish/.test(await bar()) && (await node(p, ids.polish).getAttribute('data-draw-from')) === 'true', await bar());
  await node(p, ids.polish).click(); await sleep(200);
  check('the same agent twice is refused', /other than polish/.test(await bar()), await bar());
  // second pick from the keyboard
  await node(p, ids.writer).focus(); await p.keyboard.press('Enter'); await sleep(400);
  const dlg = await p.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); return d ? { text: d.innerText, checked: d.querySelector('input[type=radio]:checked')?.value, focus: document.activeElement?.type } : null; });
  check('the second pick opens "New rule": the pair, Allow / Deny (Deny picked), both-ways', dlg && /polish/.test(dlg.text) && /writer/.test(dlg.text) && /Deny always wins/.test(dlg.text) && dlg.checked === 'deny' && dlg.focus === 'radio', JSON.stringify(dlg).slice(0, 300));
  await p.locator('[data-slot=explorer-rule-allow]').check(); await p.locator('[data-slot=explorer-rule-both]').check();
  await p.locator('[data-slot=explorer-rule-save]').click(); await sleep(900);
  const set = (await subCalls(p, 'setCommsConfig')).pop();
  const e = (set?.patch?.edges || []).find((x) => x.from === 'polish' && x.to === 'writer');
  check('Save writes the rule through setCommsConfig, naming the agents as the settings do', !!e && e.allow === true && e.both === true, JSON.stringify(set?.patch));
  const s = await state(p);
  check('the new rule shows at once, both ways, and the mode ends', s.rules.includes(`allow:${ids.polish}>${ids.writer}:both`) && (await draw.getAttribute('aria-pressed')) === 'false', s.rules.join());
  check('a toast confirms the rule', /Rule saved: allow polish/.test(await p.evaluate(() => document.querySelector('[data-sonner-toast], .toast, [role=status].toast')?.innerText || document.body.innerText.match(/Rule saved[^\n]*/)?.[0] || '')));
  // the settings sheet sees the same rule
  const cfg = await p.evaluate(() => window.__swarm.configs.chat.edges);
  check('the chat\u2019s config holds the rule (the Swarm settings sheet shows it)', cfg.some((x) => x.from === 'polish' && x.to === 'writer' && x.allow && x.both), JSON.stringify(cfg));
  // an error keeps the dialog open with the message
  await draw.click(); await sleep(200); await node(p, ids.outline).click(); await sleep(150); await node(p, ids.reviewer).click(); await sleep(400);
  await p.evaluate(() => window.__swarm.failNext.set('setCommsConfig', 'config is locked'));
  await p.locator('[data-slot=explorer-rule-save]').click(); await sleep(700);
  const err = await p.evaluate(() => [...document.querySelectorAll('[role=dialog] [role=alert]')].map((x) => x.hidden ? '' : x.innerText).join(''));
  check('a failed save keeps the dialog open and shows why', /config is locked/.test(err) && await p.locator('[data-slot=explorer-rule-save]').isEnabled(), err);
  await p.locator('[data-slot=explorer-rule-cancel]').click(); await sleep(300);
  check('Cancel goes back to picking, still in the mode', /pick the agent the messages come from/i.test(await bar()) && (await draw.getAttribute('aria-pressed')) === 'true', await bar());
  await draw.click(); await sleep(200);
  check('draw rule: no unexpected page errors', !errs.filter((x) => !/config is locked/.test(x)).length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testLayout(browser) {
  for (const [w, dark] of [[1280, false], [1280, true], [390, false], [390, true]]) {
    const { p, ctx, errs } = await open(browser, { width: w, height: w < 600 ? 844 : 900, dark });
    await seed(p); await rule(p, 'polish', 'web-scout', false); await rule(p, 'writer', 'draft', true, true);
    await openExplorer(p);
    if (w >= 1000 && await p.locator('[data-slot=sa-dock-expand]').isVisible().catch(() => false)) { await p.locator('[data-slot=sa-dock-expand]').click(); await sleep(600); }
    await p.locator('[data-slot=explorer-fit]').click(); await sleep(500);
    const tag = `${w}px ${dark ? 'dark' : 'light'}`;
    const a = await audit(p);
    check(`${tag}: layout audit clean`, !a.length, a.join(' | ').slice(0, 400));
    const o = await swarmOverlaps(p);
    check(`${tag}: topic pills and edge labels clear of nodes`, !o.length, o.join());
    const rows = await p.evaluate(() => { const r = document.querySelectorAll('[data-slot=subagent-explorer] .sa-x-toolbar > .sa-x-row')[1]; return Math.round(r.getBoundingClientRect().height / 34); });
    check(`${tag}: the edge chips and swarm tools take at most two lines`, rows <= 2, String(rows));
    const contrast = await p.evaluate(() => {
      const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
      const bg = getComputedStyle(document.querySelector('.sa-x-canvaswrap')).backgroundColor;
      const rgb = (el, prop) => { const d = document.createElement('div'); d.style.color = getComputedStyle(el)[prop]; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const bgc = /rgba?\(0, 0, 0, 0\)|transparent/.test(bg) ? getComputedStyle(document.body).backgroundColor : bg;
      return { hash: ratio(rgb(document.querySelector('.sa-x-topic-hash'), 'fill'), bgc), count: ratio(rgb(document.querySelector('[data-edge=handoff] .sa-x-count text'), 'fill'), bgc) };
    });
    check(`${tag}: topic and handoff label colours have at least 3:1 contrast`, contrast.hash >= 3 && contrast.count >= 3, JSON.stringify(contrast));
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `explorer-swarm-${w}-${dark ? 'dark' : 'light'}.png`) }); }
    check(`${tag}: no page errors`, !errs.length, errs.join(' | ').slice(0, 300));
    await ctx.close();
  }
}

// Real engine: the answers the Rust engine gave in swarm_tests::real_engine_swarm_snapshot_feeds_the_explorer
// (written with SWARM_UI_FIXTURE=tools/agent-html-tests/fixtures-real-swarm.json), served as they are.
async function testRealEngine(browser) {
  const file = path.join(__dirname, 'fixtures-real-swarm.json');
  if (!fs.existsSync(file)) { check('real-engine fixture present (cargo test real_engine_swarm_snapshot with SWARM_UI_FIXTURE)', false, file); return; }
  const fx = fs.readFileSync(file, 'utf8');
  const { p, ctx, errs } = await open(browser);
  await p.evaluate((raw) => {
    const key = window.__app.chat.mainId;
    const d = JSON.parse(raw.split('"chat-1"').join(JSON.stringify(key)));
    window.__sa.subs.clear();
    const prev = window.NativeKit.agent.subagents;
    window.NativeKit.agent.subagents = async (req) => {
      const a = req?.action || 'list';
      if (a in d) return { resultJson: JSON.stringify(d[a]) };
      return prev(req);
    };
  }, fx);
  await p.evaluate(() => window.__agentEngine.load(true)); await sleep(300);
  await openExplorer(p);
  const d = JSON.parse(fx); const id = (n) => d.list.subagents.find((x) => x.name === n).id;
  const s = await state(p);
  check('real engine: all five agents render from the engine\u2019s own list and graph', (await p.$$eval('[data-slot=subagent-explorer] [data-node]:not([data-main])', (n) => n.length)) === 5);
  check('real engine: the topic pill (research) links its three subscribers', s.topics.join() === 'research' && s.topicLinks === 3, `${s.topics} ${s.topicLinks}`);
  check('real engine: the handoff arrow triage \u2192 writer with count 1', s.handoffs.join() === `${id('triage')}>${id('writer')}:1`, s.handoffs.join());
  check('real engine: rules named by agent name resolve to the deny and both-ways allow edges', s.rules.includes(`deny:${id('scout')}>${id('editor')}`) && s.rules.includes(`allow:${id('writer')}>${id('checker')}:both`), s.rules.join());
  check('real engine: the elected coordinator (writer, term 1) wears the crown; hub and lead badges', s.crown.join() === id('writer') && s.roles.includes(`${id('writer')}:lead`) && s.roles.includes(`${id('scout')}:hub`), JSON.stringify([s.crown, s.roles]));
  const pairs = new Set(d.graph.swarm.topologyEdges.map((e) => [e.from, e.to].sort().join('|'))).size;
  check(`real engine: ${d.graph.swarm.topologyEdges.length} directed who-may-talk edges fold into ${pairs} drawn pairs (sparse enough, no label)`, s.topo === pairs && !s.tag && /Hierarchical/.test(s.summary), `${s.topo} ${s.tag} | ${s.summary}`);
  const a = await audit(p);
  check('real engine: layout audit clean', !a.length, a.join(' | ').slice(0, 300));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'explorer-real-engine-1280-light.png') });
  // The Swarm sections of the agent view, on the same real-engine answers.
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'swarm' }), id('writer')); await sleep(700);
  const ov = await p.evaluate(() => document.querySelector('[data-slot=swarm-overview]')?.innerText || '');
  check('real engine: the Swarm overview shows the topology, the coordinator and the topic', /Hierarchical/i.test(ov) && /writer/.test(ov) && /coordinator/i.test(ov), ov.replace(/\n/g, ' | ').slice(0, 300));
  const a2 = await audit(p);
  check('real engine: Swarm overview layout audit clean', !a2.length, a2.join(' | ').slice(0, 300));
  // Blackboard strength is the engine's raw weight (each write adds 1): a reinforced mark (2.0)
  // fills the meter, a single write (1.0) half of it, and neither reads as faded.
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'board' }), id('writer')); await sleep(700);
  const bb = await p.$$eval('[data-slot=board-list] .sw-entry', (els) => els.map((e) => ({ key: e.dataset.key, faded: e.dataset.faded || '', now: e.querySelector('[role=meter]')?.getAttribute('aria-valuenow'), max: e.querySelector('[role=meter]')?.getAttribute('aria-valuemax'), w: e.querySelector('[role=meter] i')?.style.width })));
  const plan = bb.find((e) => e.key === 'plan'); const src = bb.find((e) => e.key === 'sources');
  check('real engine: a reinforced mark (strength 2) fills the meter, a single write fills half', plan && src && plan.now === '2' && plan.max === '2' && plan.w === '100%' && src.now === '1' && src.w === '50%' && !plan.faded && !src.faded, JSON.stringify(bb));
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'topics' }), id('writer')); await sleep(700);
  const posts = await p.evaluate(() => document.querySelector('.sw-posts')?.innerText || '');
  check('real engine: the topic post shows its author from fromName (scout)', /scout/.test(posts) && /three sources found/.test(posts), posts.replace(/\n/g, ' | ').slice(0, 200));
  check('real engine: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

// The mock the other suites run on must answer like the engine: same built-in presets, default
// patterns and limits as the real fixture, and no field the engine never sends.
async function testMockMatchesEngine(browser) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-real-swarm.json'), 'utf8'));
  const { p, ctx } = await open(browser);
  const cfg0 = await p.evaluate(async () => JSON.parse((await window.NativeKit.agent.subagents({ action: 'commsConfig', sessionKey: window.__app.chat.mainId })).resultJson));
  const { ids } = await seed(p);
  const r = await p.evaluate(async (ids) => {
    const call = async (action, req = {}) => { try { return JSON.parse((await window.NativeKit.agent.subagents({ action, sessionKey: window.__app.chat.mainId, ...req })).resultJson); } catch (e) { return { error: e.message }; } };
    const S = window.__swarm; const [a, b] = Object.values(ids);
    S.handoff(a, b, 'over to you');
    const out = { cfg: await call('commsConfig'), created: await call('topicCreate', { topic: 'Audit Topic' }), dup: await call('topicCreate', { topic: '#audit-topic' }) };
    out.sub = await call('topicSubscribe', { topic: 'audit-topic', id: a });
    out.pub = await call('topicPublish', { topic: 'audit-topic', message: 'hello' });
    out.write = await call('blackboardWrite', { key: 'audit', value: 'v1' });
    out.write2 = await call('blackboardWrite', { key: 'audit', value: 'v2', expectedVersion: 1 });
    out.conflict = await call('blackboardWrite', { key: 'audit', value: 'v3', expectedVersion: 1 });
    out.role = await call('setCommsRole', { id: a, role: 'observer' });
    out.state = await call('swarmState');
    out.del = await call('blackboardDelete', { key: 'audit', expectedVersion: 2 });
    out.tdel = await call('topicDelete', { topic: 'audit-topic' });
    out.stop = await call('commsStopAll');
    out.after = await call('swarmState');
    out.gone = await call('swarmGraph');
    return out;
  }, ids);
  const pick = (ps) => JSON.stringify(ps.filter((x) => x.builtin).map(({ name, title, description, config }) => ({ name, title, description, config })));
  check('mock: built-in presets are the engine\u2019s (names, titles, descriptions, configs)', pick(r.cfg.presets) === pick(d.commsConfig.presets), pick(r.cfg.presets).slice(0, 200));
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().map((k) => [k, canon(v[k])]) : v);
  const sortObj = (o) => JSON.stringify(canon(o));
  check('mock: default patterns per topology are the engine\u2019s', sortObj(r.cfg.defaultPatterns) === sortObj(d.commsConfig.defaultPatterns), sortObj(r.cfg.defaultPatterns));
  const lim = (e) => { const { topology, edges, patterns, paused, ...rest } = e; return sortObj(rest); };
  check('mock: default limits and policies are the engine\u2019s', lim(cfg0.effective) === lim(d.commsConfig.effective), `${lim(cfg0.effective)} vs ${lim(d.commsConfig.effective)}`);
  const extra = (mine, engine) => Object.keys(mine || {}).filter((k) => !Object.keys(engine || {}).includes(k));
  const es = d.swarmState;
  const post = r.state.topics.find((t) => t.name === 'audit-topic')?.posts[0];
  const checks = [['swarmState', r.state, es], ['topic', r.state.topics[0], es.topics[0]], ['post', post, es.topics[0].posts[0]], ['handoff', r.state.handoffs.at(-1), es.handoffs[0]], ['blackboard entry', r.state.blackboard.find((e) => e.key === 'audit'), es.blackboard[0]], ['compaction', r.state.compaction, es.compaction]];
  for (const [n, mine, engine] of checks) check(`mock: every ${n} field is one the engine sends`, mine && !extra(mine, engine).length, mine ? extra(mine, engine).join() : 'missing');
  // Answers, as channels.rs builds them.
  check('mock: topicCreate answers {topic, created}, a duplicate is created:false (not an error)', r.created.topic === 'audit-topic' && r.created.created === true && r.dup.topic === 'audit-topic' && r.dup.created === false, JSON.stringify([r.created, r.dup]));
  check('mock: topicSubscribe/topicPublish/topicDelete answer like the engine', sortObj(r.sub) === sortObj({ topic: 'audit-topic', subscribers: r.sub.subscribers }) && Object.keys(r.pub).sort().join() === 'delivered,topic' && Object.keys(r.tdel).join() === 'topic', JSON.stringify([r.sub, r.pub, r.tdel]));
  check('mock: blackboard write/delete answer {op, version, key}; a stale version is a Conflict', r.write.op === 'written' && r.write.version === 1 && r.write2.version === 2 && /^Conflict: audit is at version 2/.test(r.conflict.error || '') && r.del.op === 'deleted' && r.del.version === 2, JSON.stringify([r.write, r.write2, r.conflict, r.del]));
  check('mock: a reinforced mark has strength above 1, as in the engine', (r.state.blackboard.find((e) => e.key === 'audit')?.weight || 0) > 1.5, JSON.stringify(r.state.blackboard.find((e) => e.key === 'audit')));
  check('mock: an unknown role is refused', /`role` must be one of member, lead, hub/.test(r.role.error || ''), JSON.stringify(r.role));
  check('mock: commsStopAll answers {stopped} and closes open auctions and votes', Object.keys(r.stop).join() === 'stopped' && ![...r.after.auctions, ...r.after.votes].some((x) => x.status === 'open'), JSON.stringify(r.stop));
  check('mock: actions the engine does not have are unknown (swarmGraph)', /unknown action/.test(r.gone.error || ''), JSON.stringify(r.gone).slice(0, 120));
  await ctx.close();
}

if (require.main === module && !process.env.PROBE) (async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testGating, testLayer, testLayersMenu, testDense, testFlow, testDrawRule, testLayout, testRealEngine, testMockMatchesEngine };
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();

if (require.main === module && process.env.PROBE) (async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const [w, dark] = process.env.PROBE.split(',');
  const { p, errs } = await open(browser, { width: Number(w), height: Number(w) < 600 ? 844 : 900, dark: dark === 'dark' });
  const { ids } = await seed(p);
  await rule(p, 'polish', 'web-scout', false); await rule(p, 'writer', 'draft', true, true);
  await openExplorer(p);
  console.log(JSON.stringify(await state(p), null, 1), errs);
  await p.screenshot({ path: `/tmp/x-${w}-${dark || 'light'}.png` });
  await browser.close();
})();
