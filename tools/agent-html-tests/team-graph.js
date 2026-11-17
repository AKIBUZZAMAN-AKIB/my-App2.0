// Team, Graph and Main-agent view (PARITY_PLAN.md phase 4), at 390 px and 1280 px.
// Run: node tools/agent-html-tests/team-graph.js   (URL_=file://... to test another build)
const { chromium } = require('./pw.js');
const { sleep } = require('./feat.js');
const { open, makeChain, subCalls, EXE } = require('./subagent-graph-fixes.js');

const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + extra : ''}`); return ok; };
const nullTexts = (p) => p.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest('script,style,code,pre,textarea,svg')) continue;
    if (/(^|[^A-Za-z_])(null|undefined|NaN)(?![A-Za-z_])/.test(n.textContent)) out.push(n.textContent.trim().slice(0, 50));
  }
  return out;
});
const overflowX = (p) => p.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('[data-slot^="agent-tab"] *')) {
    if (el.closest('.sa-vtabs, .sa-diagram, svg, .sa-diagram-wrap')) continue;
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > w + 1 || r.left < -1)) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return { pageScroll: document.documentElement.scrollWidth > w + 1, bad: bad.slice(0, 5) };
});
const pickTab = async (p, t) => { await p.click(`[data-slot="agent-view-tabs"] [data-tab="${t}"]`); await sleep(450); };
const openAgent = async (p, id, tab) => { await p.evaluate(([x, t]) => window.__subagents.open(window.__app, { id: x, agentTab: t }), [id, tab]); await sleep(600); };
const callsSince = async (p, n) => (await subCalls(p)).slice(n);
const confirm = async (p) => { const b = await p.$('[role="alertdialog"] .btn-destructive, [role="alertdialog"] [data-slot="confirm"], .dialog [data-action="confirm"]'); if (b) await b.click(); else await p.click('text=Stop all'); await sleep(500); };

async function suite(browser, w) {
  const { p, errs } = await open(browser, { w, hgt: 844 });
  const ids = await makeChain(p, { finish: false });
  // beta and gamma finished, alpha still running; a peer message and tool calls to draw.
  await p.evaluate((x) => {
    window.__sa.finish(x.c, 'report from gamma');
    window.__sa.finish(x.b, 'report from beta');
    const t0 = Date.now() - 30000;
    window.__sa.comms.messages.push(
      { at: t0, kind: 'peer', fromId: x.b, fromName: 'beta', toId: x.c, toName: 'gamma', text: 'here are the sources', status: 'sent' },
      { at: t0 + 1000, kind: 'ask_parent', fromId: x.c, fromName: 'gamma', toId: x.b, toName: 'beta', text: 'which year?', status: 'asked' },
      { at: t0 + 2000, kind: 'peer', fromId: x.a, fromName: 'alpha', toId: x.a, toName: 'alpha', text: 'self note', status: 'sent' });
    (window.__sa.logs ||= {})[x.b] = [{ at: t0, event: 'subagent.tool_call', tool: 'read_file' }, { at: t0 + 1, event: 'subagent.tool_call', tool: 'read_file' }, { at: t0 + 2, event: 'subagent.tool_call', tool: 'web_fetch' }];
  }, ids);

  // ---- Main-agent row ----
  await p.evaluate(() => window.__subagents.open(window.__app));
  await sleep(600);
  const row = await p.$('[data-slot="main-agent-row"]');
  check(`${w}px Agents list starts with the Main agent row`, !!row);
  const rowText = row ? await row.innerText() : '';
  check(`${w}px Main row counts 3 sub-agents, 1 started directly`, /3 sub-agents/.test(rowText) && /1 started directly/.test(rowText), rowText);
  await row?.click(); await sleep(600);
  const mainTabs = await p.$$eval('[data-slot="agent-view-tabs"] [role="tab"]', (els) => els.map((e) => e.dataset.tab));
  check(`${w}px Main agent has the tab bar incl. Team and Graph`, mainTabs.includes('team') && mainTabs.includes('graph') && mainTabs.includes('settings'), JSON.stringify(mainTabs));
  const ov = await p.$eval('[data-slot="main-overview-counts"]', (e) => e.innerText).catch(() => '');
  check(`${w}px Main Overview: 3 sub-agents, 1 running, deepest level 3`, /Sub-agents\s*3/.test(ov) && /Running\s*1/.test(ov) && /Deepest level\s*3/.test(ov), ov.replace(/\n/g, ' '));

  // Main Team: rules, validation, save.
  await pickTab(p, 'team');
  check(`${w}px Main Team shows rules, broadcast, matrix and timeline`, await p.$$eval('[data-slot="team-rules"],[data-slot="agent-team-message"],[data-slot="team-matrix"],[data-slot="team-timeline"]', (e) => e.length) === 4);
  let n0 = (await subCalls(p)).length;
  await p.fill('[data-slot="team-rate"]', '9999');
  await p.click('[data-slot="team-rules-save"]'); await sleep(300);
  const rateErr = await p.$eval('[data-slot="team-rules-error"]', (e) => !e.hidden && e.innerText).catch(() => false);
  check(`${w}px rate 9999 is refused in the form, nothing sent`, !!rateErr && !(await callsSince(p, n0)).some((c) => c.action === 'settings' && c.settings), String(rateErr));
  await p.fill('[data-slot="team-rate"]', '30');
  await p.selectOption('[data-slot="team-topology"]', 'mesh');
  await p.click('[data-slot="team-rules-save"]'); await sleep(600);
  const setCall = (await callsSince(p, n0)).find((c) => c.action === 'settings' && c.settings);
  check(`${w}px Team rules save sends topology mesh + rate 30`, setCall && setCall.settings.topology === 'mesh' && setCall.settings.peerRateLimitPerMin === 30, JSON.stringify(setCall));
  const topoNow = await p.$eval('[data-slot="team-topology"]', (e) => e.value).catch(() => '');
  check(`${w}px after save the Team tab shows mesh`, topoNow === 'mesh', topoNow);
  // Broadcast from the main agent.
  n0 = (await subCalls(p)).length;
  await p.fill('[data-slot="team-message-text"]', 'Stop and report what you have.');
  await p.click('[data-slot="team-message-send"]'); await sleep(600);
  const bc = (await callsSince(p, n0)).find((c) => c.action === 'broadcast');
  check(`${w}px Main broadcast goes to the whole chat`, bc && bc.message === 'Stop and report what you have.' && !bc.ids, JSON.stringify(bc));
  const tl = await p.$eval('[data-slot="team-timeline"]', (e) => e.innerText).catch(() => '');
  check(`${w}px timeline shows the broadcast to all 3 agents`, (tl.match(/Stop and report/g) || []).length === 3, tl.slice(0, 200));

  // Main Graph: the team diagram with the real parent edges.
  await pickTab(p, 'graph');
  const team = await p.$eval('[data-slot="agent-graph-team"]', (e) => e.dataset.source).catch(() => '');
  check(`${w}px team diagram: main→alpha→beta→gamma`, /main --> a0/.test(team) && /a0 --> a1/.test(team) && /a1 --> a2/.test(team) && !/main --> a1|main --> a2/.test(team), team.split('\n').filter((l) => l.includes('-->')).join(' | '));
  check(`${w}px team diagram draws the beta→gamma message`, /a1 -\.->\|1 msg\| a2/.test(team), team.split('\n').filter((l) => l.includes('-.->')).join(' | '));

  // Main Settings: compaction for everyone.
  await pickTab(p, 'settings');
  n0 = (await subCalls(p)).length;
  await p.fill('[data-setting="compactThresholdPercent"]', '5');
  await p.click('[data-slot="main-settings-save"]'); await sleep(300);
  check(`${w}px Main settings refuse threshold 5%`, !(await callsSince(p, n0)).some((c) => c.action === 'settings' && c.settings));
  await p.fill('[data-setting="compactThresholdPercent"]', '80');
  await p.click('[data-setting="autoCompact"]');
  await p.click('[data-slot="main-settings-save"]'); await sleep(500);
  const ms = (await callsSince(p, n0)).find((c) => c.action === 'settings' && c.settings);
  check(`${w}px Main settings save threshold 80 + auto off`, ms && ms.settings.compactThresholdPercent === 80 && ms.settings.autoCompact === false, JSON.stringify(ms));
  await pickTab(p, 'context');
  const mc = await p.$eval('[data-slot="agent-tab-context-main"]', (e) => e.innerText).catch(() => '');
  check(`${w}px Main Context lists every sub-agent`, /Title alpha/.test(mc) && /Title beta/.test(mc) && /Title gamma/.test(mc), mc.slice(0, 160));
  await pickTab(p, 'activity');
  check(`${w}px Main Activity renders`, !!(await p.$('[data-slot="main-activity"]')));
  for (const t of ['overview', 'team', 'graph', 'settings', 'context', 'activity', 'tools', 'chat']) {
    await pickTab(p, t);
    const nt = await nullTexts(p);
    check(`${w}px Main ${t}: no null/undefined text`, !nt.length, JSON.stringify(nt));
    if (w === 390) { const o = await overflowX(p); check(`${w}px Main ${t}: nothing wider than the screen`, !o.pageScroll && !o.bad.length, JSON.stringify(o)); }
  }
  // reset to tree for the per-agent checks
  await p.evaluate(() => { window.__sa.settings.topology = 'tree'; window.__sa.settings.commsPaused = false; });

  // ---- one agent's Team tab (beta, level 2) ----
  await openAgent(p, ids.b, 'team');
  const cells = await p.$$eval('[data-slot="agent-team-matrix"] .sa-team-cell', (els) => els.map((e) => [e.dataset.to, e.dataset.allowed]));
  check(`${w}px beta may message alpha (parent) and gamma (child) under tree`, cells.length === 2 && cells.every(([, a]) => a === 'true'), JSON.stringify(cells));
  // timeline filter
  const own = await p.$$eval('[data-slot="agent-team-timeline-list"] .sa-vevent', (els) => els.length);
  check(`${w}px beta's timeline: its 2 messages + the broadcast to it`, own === 3, String(own));
  await p.click('[data-slot="agent-team-timeline"] [data-scope="team"]'); await sleep(250);
  const allN = await p.$$eval('[data-slot="agent-team-timeline-list"] .sa-vevent', (els) => els.length);
  check(`${w}px Whole team shows all 6 messages`, allN === 6, String(allN));
  // draft survives a live repaint, then message beta
  await p.fill('[data-slot="team-message-text"]', 'draft that must survive');
  await p.evaluate((x) => { window.__sa.comms.messages.push({ at: Date.now(), kind: 'peer', fromId: x.c, fromName: 'gamma', toId: x.b, toName: 'beta', text: 'live one', status: 'sent' }); window.__sa.emit('subagent.peer_message', { id: x.c }); }, ids);
  await sleep(900);
  const live = await p.$eval('[data-slot="agent-team-timeline-list"]', (e) => e.innerText).catch(() => '');
  check(`${w}px a new message appears live`, /live one/.test(live), live.slice(0, 120));
  const draft = await p.$eval('[data-slot="team-message-text"]', (e) => e.value);
  check(`${w}px the typed draft survives the live update`, draft === 'draft that must survive', draft);
  n0 = (await subCalls(p)).length;
  await p.click('[data-slot="team-message-send"]'); await sleep(500);
  const msg = (await callsSince(p, n0)).find((c) => c.action === 'message');
  check(`${w}px Send messages beta itself`, msg && msg.id === ids.b && msg.message === 'draft that must survive', JSON.stringify(msg));
  // broadcast to beta and the agents below it
  n0 = (await subCalls(p)).length;
  await p.selectOption('[data-slot="team-message-to"]', 'tree');
  await p.fill('[data-slot="team-message-text"]', 'sub-tree note');
  await p.click('[data-slot="team-message-wake"]');
  await p.click('[data-slot="team-message-send"]'); await sleep(500);
  const tb = (await callsSince(p, n0)).find((c) => c.action === 'broadcast');
  check(`${w}px sub-tree broadcast sends ids [beta, gamma] + wake`, tb && JSON.stringify(tb.ids) === JSON.stringify([ids.b, ids.c]) && tb.wake === true, JSON.stringify(tb));
  // canMessage + hiddenFrom
  n0 = (await subCalls(p)).length;
  await p.selectOption('[data-slot="team-can-mode"]', 'list');
  await p.check('[data-slot="team-can-picks"] [data-id="' + ids.c + '"] input');
  await p.check('[data-slot="team-hidden-from"] [data-id="' + ids.a + '"] input');
  await p.click('[data-slot="team-perms-save"]'); await sleep(700);
  const cfg = (await callsSince(p, n0)).find((c) => c.action === 'configure');
  check(`${w}px perms save canMessage [gamma] + hiddenFrom [alpha]`, cfg && JSON.stringify(cfg.canMessage) === '["gamma"]' && JSON.stringify(cfg.hiddenFrom) === '["alpha"]', JSON.stringify(cfg));
  const cells2 = await p.$$eval('[data-slot="agent-team-matrix"] .sa-team-cell', (els) => els.map((e) => [e.dataset.to, e.dataset.allowed]));
  check(`${w}px matrix now: alpha no, gamma yes`, JSON.stringify(cells2) === JSON.stringify([[ids.a, 'false'], [ids.c, 'true']]), JSON.stringify(cells2));
  const reason = await p.$eval(`[data-slot="agent-team-matrix"] [data-to="${ids.a}"] .field-hint`, (e) => e.innerText).catch(() => '');
  check(`${w}px the "no" carries the engine's reason`, /may message only: gamma/.test(reason), reason);

  // reparent: refuse moving alpha under gamma; move gamma under main
  await openAgent(p, ids.a, 'team');
  const opts = await p.$$eval('[data-slot="team-reparent-select"] option', (els) => els.map((e) => e.value));
  check(`${w}px alpha's parent list offers only Main (its sub-tree is left out)`, JSON.stringify(opts) === '[""]', JSON.stringify(opts));
  await openAgent(p, ids.c, 'team');
  n0 = (await subCalls(p)).length;
  await p.selectOption('[data-slot="team-reparent-select"]', '');
  await p.click('[data-slot="team-reparent"]'); await sleep(700);
  const rp = (await callsSince(p, n0)).find((c) => c.action === 'reparent');
  check(`${w}px gamma moves under the main agent`, rp && rp.id === ids.c && rp.parentId === null, JSON.stringify(rp));
  await pickTab(p, 'graph');
  const g2 = await p.$eval('[data-slot="agent-graph-team"]', (e) => e.dataset.source).catch(() => '');
  check(`${w}px after the move the team diagram has main→gamma`, /main --> a2/.test(g2) && !/a1 --> a2/.test(g2), g2.split('\n').filter((l) => l.includes('-->')).join(' | '));
  // move it back so the rest holds
  await p.evaluate((x) => { const s = window.__sa.subs.get(x.c); s.parentId = x.b; s.depth = 3; window.__sa.emit('subagent.reparented', { ...s }); }, ids);
  await sleep(300);

  // pause / resume / stop tree on alpha (running, with beta and gamma restarted)
  await p.evaluate((x) => { for (const id of [x.b, x.c]) { const s = window.__sa.subs.get(id); s.status = 'running'; s.runs = (s.runs || 1) + 1; window.__sa.emit('subagent.started', { ...s }); } }, ids);
  await openAgent(p, ids.b, 'team');
  n0 = (await subCalls(p)).length;
  await p.click('[data-slot="team-pause"]'); await sleep(600);
  check(`${w}px Pause sends pause for beta`, (await callsSince(p, n0)).some((c) => c.action === 'pause' && c.id === ids.b));
  check(`${w}px after Pause the Resume button shows`, !!(await p.$('[data-slot="team-resume"]')));
  await p.click('[data-slot="team-resume"]'); await sleep(600);
  check(`${w}px Resume sends resume`, (await callsSince(p, n0)).some((c) => c.action === 'resume' && c.id === ids.b));
  await openAgent(p, ids.a, 'team');
  const st = await p.$eval('[data-slot="team-stop-tree"]', (e) => e.innerText).catch(() => '');
  check(`${w}px Stop-tree names the 2 agents below`, /2 below/.test(st), st);
  n0 = (await subCalls(p)).length;
  await p.click('[data-slot="team-stop-tree"]'); await sleep(400);
  await confirm(p);
  const stt = (await callsSince(p, n0)).find((c) => c.action === 'stopTree');
  check(`${w}px stopTree sent for alpha after confirming`, stt && stt.id === ids.a, JSON.stringify(stt));
  const stAfter = await p.evaluate((x) => [x.a, x.b, x.c].map((id) => window.__sa.subs.get(id).status), ids);
  check(`${w}px all three stopped`, stAfter.every((s) => s === 'cancelled'), JSON.stringify(stAfter));

  // ---- one agent's Graph (beta) ----
  await openAgent(p, ids.b, 'graph');
  const g = await p.$eval('[data-slot="agent-graph-own"]', (e) => e.dataset.source).catch(() => '');
  check(`${w}px beta's diagram: parent alpha → beta → gamma`, /n0\["Title alpha/.test(g) && /n0 --> n1/.test(g) && /n1 --> n2/.test(g) && !/main\(/.test(g), g.split('\n').filter((l) => l.includes('-->') || l.includes('["')).slice(0, 6).join(' | '));
  check(`${w}px beta's diagram shows its message to gamma`, /n1 -\.->\|1 msg\| n2/.test(g), g.split('\n').filter((l) => l.includes('-.->')).join(' | '));
  check(`${w}px beta's diagram shows read_file ×2 and web_fetch ×1`, /read_file ×2/.test(g) && /web_fetch ×1/.test(g), g.split('\n').filter((l) => l.includes('×')).join(' | '));
  check(`${w}px beta's Graph also shows the whole team`, !!(await p.$('[data-slot="agent-graph-team"]')));
  const gl = await p.$eval('[data-slot="agent-graph-own"] svg, [data-slot="agent-graph-own"] .sa-diagram', () => true).catch(() => false);
  check(`${w}px the diagram renders`, gl);
  await openAgent(p, ids.a, 'graph');
  const ga = await p.$eval('[data-slot="agent-graph-own"]', (e) => e.dataset.source).catch(() => '');
  check(`${w}px alpha's diagram starts at the Main agent`, /main\(\["Main agent"\]\)/.test(ga) && /main --> n0/.test(ga), ga.split('\n').slice(0, 3).join(' | '));
  for (const t of ['team', 'graph']) for (const [label, id] of [['L1', ids.a], ['L2', ids.b], ['L3', ids.c]]) {
    await openAgent(p, id, t);
    const nt = await nullTexts(p);
    check(`${w}px ${label} ${t}: no null/undefined text`, !nt.length, JSON.stringify(nt));
    if (w === 390) { const o = await overflowX(p); check(`${w}px ${label} ${t}: nothing wider than the screen`, !o.pageScroll && !o.bad.length, JSON.stringify(o)); }
  }
  check(`${w}px no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
  await p.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try { for (const w of [390, 1280]) await suite(browser, w); } catch (e) { results.push(`FAIL crashed: ${e.stack || e}`); }
  await browser.close();
  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nteam-graph: ${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
