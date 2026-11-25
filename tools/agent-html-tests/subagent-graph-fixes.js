// Regression checks for the sub-agent / delegation-graph fixes (2026-11-16).
// Each check failed on 63fd8bf and passes after the fix:
//   graph survives a reload (read from the engine's persisted log), nested agents hang
//   under their real parent, permission requests stay in their own chat, a sub-agent's
//   card still answers after the main agent finished, no phantom "running"/Stop,
//   "Always allow" scoped to the chat, title/description/hierarchy in the detail,
//   per-agent setup (configure), topology controls, a graph card in the spawning
//   message, and the non-modal side panel with one tab per opened sub-agent.
// Run: node tools/agent-html-tests/subagent-graph-fixes.js   (URL_=file://... to test another build)
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const dir = __dirname;
const mock = fs.readFileSync(`${dir}/mock3.js`, 'utf8');
const mockV2 = fs.readFileSync(`${dir}/mock-v2.js`, 'utf8');
const mockSA = fs.readFileSync(`${dir}/mock-subagents.js`, 'utf8');
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + extra : ''}`); return ok; };

// The engine's on-disk side, as subagents.rs keeps it (registry.json + per-agent logs),
// held in sessionStorage so it survives a page reload like the real files do.
const engineDisk = `(() => {
  const a = window.NativeKit.agent;
  const gf = a.getEngineFeatures;
  a.getEngineFeatures = async () => { const r = await gf(); return { ...r, features: [...r.features, 'subagentGraph', 'subagentChatAllow', 'subagentTeam'] }; };
  const KEY = '__engineDisk';
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || { records: [], events: [], allows: {} }; } catch { return { records: [], events: [], allows: {} }; } };
  const save = (d) => sessionStorage.setItem(KEY, JSON.stringify(d));
  window.__disk = {
    load, save,
    record(r) { const d = load(); d.records = d.records.filter((x) => x.id !== r.id).concat([r]); save(d); },
    event(e) { const d = load(); d.events.push({ at: Date.now(), ...e }); save(d); },
  };
  const base = a.subagents;
  a.subagents = async (req) => {
    const d = load();
    const rootOf = (k) => { const r = d.records.find((x) => x.sessionKey === k); return r ? r.rootSessionKey : k; };
    if (req?.action === 'graph') {
      window.__mock.calls.push({ name: 'agent.subagents', args: JSON.parse(JSON.stringify(req)) });
      const nodes = d.records.filter((r) => r.rootSessionKey === req.sessionKey);
      const ids = new Set(nodes.map((n) => n.id));
      const events = d.events.filter((e) => ids.has(e.id)).sort((x, y) => x.at - y.at);
      return { resultJson: JSON.stringify({ sessionKey: req.sessionKey, nodes, edges: nodes.map((n) => ({ from: n.parentId || null, to: n.id })), events }) };
    }
    if (req?.action === 'allowTool' && req.scope !== 'agent') {
      window.__mock.calls.push({ name: 'agent.subagents', args: JSON.parse(JSON.stringify(req)) });
      const k = rootOf(req.sessionKey); d.allows[k] = [...new Set([...(d.allows[k] || []), req.toolName])]; save(d);
      return { resultJson: JSON.stringify({ sessionKey: k, tools: d.allows[k] }) };
    }
    if (req?.action === 'configure') {
      window.__mock.calls.push({ name: 'agent.subagents', args: JSON.parse(JSON.stringify(req)) });
      const s = window.__sa.subs.get(req.id);
      if (!s) throw new Error('No sub-agent with id ' + req.id);
      for (const k of ['model', 'provider', 'tools', 'hidden', 'hiddenFrom', 'canMessage', 'temperature', 'systemPrompt', 'maxChildDepth', 'compaction', 'memoryMode', 'timeoutSeconds', 'tokenBudget', 'maxSteps', 'peerRateLimit']) if (k in req) s[k] = req[k];
      return { resultJson: JSON.stringify({ subagent: { ...s } }) };
    }
    if (req?.action === 'list') {
      // After a restart the engine still lists what registry.json holds.
      for (const r of d.records) if (!window.__sa.subs.has(r.id)) window.__sa.subs.set(r.id, { ...r }), window.__sa.transcripts.set(r.id, []);
    }
    return base(req);
  };
})();`;

async function open(browser, { ctx: ctxIn, w = 390, hgt = 844 } = {}) {
  const ctx = ctxIn || await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: true, isMobile: w < 800 });
  if (!ctxIn) { await ctx.addInitScript('window.__SA_CFG = {};'); await ctx.addInitScript(mock); await ctx.addInitScript(mockV2); await ctx.addInitScript(mockSA); await ctx.addInitScript(engineDisk); }
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => { if (window.__sa) window.__sa.mainKey = window.__app.chat.mainId; });
  await sleep(200);
  return { p, ctx, errs };
}
const subCalls = (p) => p.evaluate(() => window.__mock.calls.filter((c) => c.name === 'agent.subagents').map((c) => c.args));
const bridgeCalls = (p, re) => p.evaluate((src) => window.__mock.calls.filter((c) => new RegExp(src).test(c.name)).map((c) => ({ name: c.name, args: c.args })), re.source);
const state = (p) => p.evaluate(() => {
  const rt = window.__app.chat.main;
  const cancel = document.querySelector('.aui-composer-cancel');
  const threadCards = [...document.querySelectorAll('.aui-thread-viewport [data-slot="approval-card"]')].filter((c) => !c.closest('[data-slot="approvals-tray"]'));
  return {
    running: !!rt.isRunning,
    stop: !!cancel && !cancel.hidden && getComputedStyle(cancel).display !== 'none',
    threadCards: threadCards.length,
    trayCards: document.querySelectorAll('[data-slot="approvals-tray"] [data-slot="approval-card"]').length,
    otherChats: document.querySelector('[data-slot="approvals-other-chats"]')?.textContent || '',
  };
});

// A level-1 -> level-2 -> level-3 chain in the open chat, as the engine would have it.
async function makeChain(p, { finish = true } = {}) {
  return p.evaluate((fin) => {
    const k = window.__app.chat.mainId;
    const t0 = Date.now() - 60000;
    const mk = (n, parent, depth, i) => {
      const s = window.__sa.make({ name: n, task: `task of ${n}`, status: 'running', depth, createdAt: t0 + i * 1000 });
      Object.assign(s, { parentId: parent ? parent.id : null, parentSessionKey: parent ? parent.sessionKey : k, rootSessionKey: k, title: `Title ${n}`, description: `Description of ${n}`, spawnToolCallId: parent ? `call-${parent.name}` : 'call-main' });
      window.__sa.emit('subagent.started', { ...s });
      window.__disk.record({ ...s });
      window.__disk.event({ at: t0 + i * 1000, event: 'subagent.started', id: s.id, status: 'running', depth });
      return s;
    };
    const a = mk('alpha', null, 1, 0);
    const b = mk('beta', a, 2, 1);
    const c = mk('gamma', b, 3, 2);
    if (fin) {
      for (const [s, i] of [[c, 3], [b, 4], [a, 5]]) {
        window.__sa.finish(s.id, `report from ${s.name}`);
        const done = { ...window.__sa.subs.get(s.id), status: 'finished', finishedAt: t0 + i * 1000 };
        window.__disk.record(done);
        window.__disk.event({ at: t0 + i * 1000, event: 'subagent.finished', id: s.id, status: 'finished', report: `report from ${s.name}` });
      }
    }
    return { a: a.id, b: b.id, c: c.id, k };
  }, finish);
}
// Older builds have no diagramSources(); their treeSource()/sequenceSource() draw the same thing.
const sources = (p) => p.evaluate(() => (window.__subagents.diagramSources ? window.__subagents.diagramSources() : { tree: window.__subagents.treeSource(), sequence: window.__subagents.sequenceSource() }));

async function testParentEdges(browser) {
  const { p, ctx, errs } = await open(browser);
  const ids = await makeChain(p, { finish: true });
  await sleep(300);
  const s = await sources(p);
  const tree = s.tree || '';
  const seq = s.sequence || '';
  check('tree: level 1 hangs under Main', /main --> a0/.test(tree), tree);
  check('tree: level 2 hangs under level 1 (not Main)', /a0 --> a1/.test(tree) && !/main --> a1/.test(tree), tree);
  check('tree: level 3 hangs under level 2 (not Main)', /a1 --> a2/.test(tree) && !/main --> a2/.test(tree), tree);
  const lines = seq.split('\n');
  const alias = (label) => (lines.find((l) => l.includes(`as ${label}`)) || '').trim().split(/\s+/)[1];
  const [A, B, C] = ['Title alpha', 'Title beta', 'Title gamma'].map(alias);
  check('sequence: participants named by title', !!(A && B && C), seq);
  check('sequence: beta is started by alpha, not Main', lines.some((l) => l.trim().startsWith(`${A}->>+${B}:`)) && !lines.some((l) => l.trim().startsWith(`M->>+${B}:`)), seq);
  check('sequence: gamma is started by beta, not Main', lines.some((l) => l.trim().startsWith(`${B}->>+${C}:`)) && !lines.some((l) => l.trim().startsWith(`M->>+${C}:`)), seq);
  check('sequence: gamma reports to beta', lines.some((l) => l.trim().startsWith(`${C}-->>-${B}: report`)), seq);
  check('sequence: alpha reports to Main', lines.some((l) => l.trim().startsWith(`${A}-->>-M: report`)), seq);
  // The Diagram tab draws a native tree (Mermaid source is still offered via "Copy as Mermaid").
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' }));
  await sleep(300);
  const drawn = await p.evaluate(() => ({ nodes: document.querySelectorAll('.sa-dialog .at-tree .at-node').length, nested: !!document.querySelector('.sa-dialog .at-group .at-group .at-node') }));
  check('both diagrams render without a Mermaid error', drawn.nodes >= 4 && drawn.nested, JSON.stringify(drawn));
  check('parent edges: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
  return ids;
}

async function testReloadPersistence(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript('window.__SA_CFG = {};'); await ctx.addInitScript(mock); await ctx.addInitScript(mockV2); await ctx.addInitScript(mockSA); await ctx.addInitScript(engineDisk);
  const { p, errs } = await open(browser, { ctx });
  await makeChain(p, { finish: true });
  await sleep(300);
  const before = (await sources(p)).sequence;
  check('before reload: delegation drawn', !/No delegation yet/.test(before), before);
  await p.reload();
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' }));
  await sleep(1500);
  const after = (await sources(p)).sequence;
  check('after reload: the diagram is not empty', !/No delegation yet/.test(after), after);
  check('after reload: all three starts and reports come back', (after.match(/->>\+/g) || []).length === 3 && (after.match(/: report/g) || []).length === 3, after);
  check('after reload: nested start still comes from the real parent', /S\d->>\+S\d: task of gamma/.test(after) && !/M->>\+S\d: task of gamma/.test(after), after);
  const asked = (await subCalls(p)).filter((c) => c.action === 'graph');
  const mainKey = await p.evaluate(() => window.__app.chat.mainId);
  check('after reload: the app read the graph from the engine', asked.some((c) => c.sessionKey === mainKey), JSON.stringify({ asked, mainKey }));
  check('reload: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testStaleRunning(browser) {
  // Main agent idle; a background sub-agent asks for approval, runs the tool, finishes.
  const { p, ctx, errs } = await open(browser);
  const id = await p.evaluate(() => { const s = window.__sa.make({ name: 'writer', task: 'write notes', status: 'running' }); s.rootSessionKey = window.__app.chat.mainId; window.__sa.emit('subagent.started', { ...s }); return s.id; });
  await p.evaluate((sid) => window.__mock.emit('approval_request', { toolCallId: 'ap-x', toolName: 'write_file', args: { path: 'n.md' }, subagent: { id: sid, name: 'writer' }, sessionKey: window.__app.chat.mainId }), id);
  await sleep(400);
  let st = await state(p);
  check('idle chat: a sub-agent request does not start a phantom run', !st.running && !st.stop, JSON.stringify(st));
  check('idle chat: the request is shown (in the tray) and answerable', st.trayCards === 1, JSON.stringify(st));
  await p.locator('[data-slot="approvals-tray"] [data-slot="approval-card-allow-once"]').first().click();
  await sleep(400);
  const sent = await bridgeCalls(p, /respondToApproval/);
  check('idle chat: Allow once reaches the engine', sent.some((c) => JSON.stringify(c.args).includes('ap-x')), JSON.stringify(sent));
  await p.evaluate((sid) => window.__sa.finish(sid, 'done'), id);
  await sleep(800);
  st = await state(p);
  check('after the sub-agent finished: not running, no Stop button', !st.running && !st.stop && st.trayCards === 0, JSON.stringify(st));
  check('stale running: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testStuckAfterMainFinished(browser) {
  const { p, ctx, errs } = await open(browser);
  const k = await p.evaluate(() => window.__app.chat.mainId);
  await p.evaluate((key) => window.__mock.emit('agent.started', { sessionKey: key }), k);
  await sleep(150);
  await p.evaluate((key) => window.__mock.emit('approval_request', { toolCallId: 'ap-y', toolName: 'write_file', args: { path: 'n.md' }, subagent: { id: 'sa_z', name: 'bg' }, sessionKey: key }), k);
  await sleep(300);
  let st = await state(p);
  check('while main runs: the card is in the message', st.threadCards === 1, JSON.stringify(st));
  await p.evaluate((key) => window.__mock.emit('agent.completed', { sessionKey: key, finalText: 'main done' }), k);
  await sleep(700);
  st = await state(p);
  check('main finished first: the request is still answerable (tray)', st.trayCards === 1 && !st.running, JSON.stringify(st));
  const n0 = (await bridgeCalls(p, /respondToApproval/)).length;
  await p.locator('[data-slot="approvals-tray"] [data-slot="approval-card-allow-once"]').first().click();
  await sleep(400);
  const after = await bridgeCalls(p, /respondToApproval/);
  check('main finished first: tapping Allow once sends the answer to the engine', after.length - n0 === 1 && JSON.stringify(after[after.length - 1].args).includes('ap-y') && JSON.stringify(after[after.length - 1].args).includes('true'), JSON.stringify(after));
  // The old card in the finished message, if any is tapped, also answers through the engine once.
  st = await state(p);
  check('after answering: tray empty', st.trayCards === 0, JSON.stringify(st));
  check('stuck: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testOtherChat(browser) {
  const { p, ctx, errs } = await open(browser);
  await p.evaluate(() => window.__mock.emit('approval_request', { toolCallId: 'ap-w', toolName: 'write_file', args: { path: 'n.md' }, subagent: { id: 'sa_q', name: 'other' }, sessionKey: 'some-other-chat' }));
  await p.evaluate(() => window.__mock.emit('approval_request', { toolCallId: 'ap-v', toolName: 'execute_command', args: { command: 'ls' }, sessionKey: 'some-other-chat' }));
  await sleep(400);
  const st = await state(p);
  check('another chat\u2019s requests are not shown in the open chat', st.threadCards === 0 && st.trayCards === 0, JSON.stringify(st));
  check('the open chat says another chat is waiting', /2 approvals waiting in other chats|needs your approval/.test(st.otherChats), JSON.stringify(st));
  check('the open chat does not start a run for them', !st.running && !st.stop, JSON.stringify(st));
  const pend = await p.evaluate(() => window.__approvals.list('some-other-chat').map((r) => r.id));
  check('they wait for their own chat', pend.includes('ap-w') && pend.includes('ap-v'), JSON.stringify(pend));
  // Answered from the tray API (as when that chat is opened): goes to the engine.
  await p.evaluate(() => window.__approvals.answer('ap-w', { approved: false }));
  await sleep(200);
  const sent = await bridgeCalls(p, /respondToApproval/);
  check('answering another chat\u2019s request reaches the engine', sent.some((c) => JSON.stringify(c.args).includes('ap-w')), JSON.stringify(sent));
  check('other chat: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testAlwaysAllowScope(browser) {
  const { p, ctx, errs } = await open(browser);
  const k = await p.evaluate(() => window.__app.chat.mainId);
  await p.evaluate((key) => window.__mock.emit('agent.started', { sessionKey: key }), k);
  await sleep(150);
  await p.evaluate((key) => window.__mock.emit('approval_request', { toolCallId: 'ap-e', toolName: 'write_file', args: { path: 'n.md' }, subagent: { id: 'sa_e', name: 'writer' }, subagentSessionKey: 'sub:sa_e', sessionKey: key }), k);
  await sleep(300);
  await p.locator('[data-slot="approval-card"] [data-slot="approval-card-always-allow"]').first().click();
  await sleep(400);
  const perm = await bridgeCalls(p, /setToolPermission/);
  const allow = (await subCalls(p)).filter((c) => c.action === 'allowTool');
  check('Always allow (default scope) is saved for this chat, not every chat', perm.length === 0 && allow.length === 1 && allow[0].toolName === 'write_file', JSON.stringify({ perm, allow }));
  const resp = await bridgeCalls(p, /respondToApproval/);
  check('Always allow also approves this request', resp.some((c) => JSON.stringify(c.args).includes('ap-e')), JSON.stringify(resp));
  // Scope "Every chat" keeps the old behaviour.
  await p.evaluate(() => window.__agentEngine && window.__subagents.settings && Object.assign(window.__subagents.settings, { alwaysAllowScope: 'global' }));
  await p.evaluate((key) => window.__mock.emit('approval_request', { toolCallId: 'ap-g', toolName: 'read_file', args: { path: 'a' }, subagent: { id: 'sa_e', name: 'writer' }, sessionKey: key }), k);
  await sleep(300);
  const dbg = await p.evaluate(() => [...document.querySelectorAll('[data-slot="approval-card-always-allow"]')].map((b) => ({ dis: b.disabled, vis: !!b.offsetParent })));
  await p.locator('[data-slot="approval-card-always-allow"]:enabled').last().click({ timeout: 3000 }).catch((e) => results.push('INFO ' + e.message.split('\n')[0] + JSON.stringify(dbg)));
  await sleep(400);
  const perm2 = await bridgeCalls(p, /setToolPermission/);
  check('scope "Every chat": the tool\u2019s permission is saved globally', perm2.some((c) => JSON.stringify(c.args).includes('read_file')), JSON.stringify(perm2));
  check('always allow: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testDetailAndSetup(browser) {
  const { p, ctx, errs } = await open(browser);
  const ids = await makeChain(p, { finish: true });
  await sleep(200);
  await p.evaluate((id) => window.__subagents.open(window.__app, { id }), ids.c);
  await sleep(500);
  const d = await p.evaluate(() => {
    const panel = document.querySelector('.sa-dialog');
    return {
      title: panel?.querySelector('[data-slot="subagent-title"]')?.textContent || '',
      desc: panel?.querySelector('[data-slot="subagent-description"]')?.textContent || '',
      hier: panel?.querySelector('[data-slot="subagent-hierarchy"]')?.innerText || '',
      spawned: !!panel?.querySelector('[data-slot="subagent-spawned-from"]'),
      setup: !!panel?.querySelector('[data-slot="subagent-setup"]'),
      rows: [...document.querySelectorAll('.sa-dialog [role="tablist"]')].filter((e) => e.getClientRects().length).length,
      docked: panel?.classList.contains('sa-docked'),
      appInert: !!document.getElementById('app')?.inert,
      modal: panel?.getAttribute('aria-modal'),
    };
  });
  check('detail shows the title', d.title === 'Title gamma', JSON.stringify(d));
  check('detail shows the description', d.desc === 'Description of gamma', JSON.stringify(d));
  check('detail shows who started it (its real parent)', /Started by\s*Title beta/.test(d.hier), d.hier);
  check('detail shows its level', /Level\s*3( of|\s*\(limit is now \d+\))/.test(d.hier), d.hier);
  check('detail links to the spawning call', d.spawned, JSON.stringify(d));
  d.crumbs = await pathMenu(p);
  check('opened sub-agent: its path menu leads back through its parents, one row of sections', JSON.stringify(d.crumbs) === '["All agents","Title alpha","Title beta","Title gamma"]' && d.rows === 1, JSON.stringify(d));
  check('Agents opens as a side panel; the chat stays usable', d.docked && !d.appInert && d.modal === 'false', JSON.stringify(d));
  // Jump to the parent from the hierarchy; the breadcrumb follows.
  await p.locator('[data-slot="subagent-hierarchy"] .sa-link[data-id]').first().click();
  await sleep(400);
  const tabs = { name: await p.textContent('.sa-detail-name'), crumbs: await pathMenu(p) };
  check('parent opens; its path now ends at itself', tabs.name === 'beta' && JSON.stringify(tabs.crumbs) === '["All agents","Title alpha","Title beta"]', JSON.stringify(tabs));
  // ‹ goes up one level: to the parent.
  const backHint = await p.getAttribute('[data-slot="agent-back"]', 'aria-label');
  await p.click('[data-slot="agent-back"]');
  await sleep(400);
  check('‹ goes up one level to the parent', backHint === 'Back to Title alpha' && (await p.textContent('.sa-detail-name')) === 'alpha', backHint);
  // A parent in the path menu opens that agent.
  await p.evaluate((id) => window.__subagents.open(window.__app, { id }), ids.c);
  await sleep(400);
  await p.click('[data-slot="agent-switcher"]');
  await p.click('[data-slot="agent-path-item"][data-path="1"]');
  await sleep(400);
  check('a parent in the path menu opens that agent', (await p.textContent('.sa-detail-name')) === 'alpha');
  await p.evaluate((id) => window.__subagents.open(window.__app, { id, agentTab: 'settings' }), ids.b);
  await sleep(400);
  // Per-agent setup: model, tools, hidden, hidden from, can message -> configure.
  await p.locator('[data-slot="subagent-setup"] > summary').click();
  const inputs = p.locator('[data-slot="subagent-setup"] input[type="text"]');
  await inputs.nth(0).fill('llama-3');
  await inputs.nth(2).fill('read_file, web_fetch');
  await inputs.nth(3).fill('alpha');
  await inputs.nth(4).fill('gamma');
  await p.locator('[data-slot="subagent-setup"] input[type="checkbox"]').check();
  await p.locator('[data-slot="subagent-setup-save"]').click();
  await sleep(400);
  const cfg = (await subCalls(p)).filter((c) => c.action === 'configure').pop();
  check('Setup saves model, tools, hidden, hiddenFrom and canMessage to the engine', cfg && cfg.id === ids.b && cfg.model === 'llama-3' && JSON.stringify(cfg.tools) === '["read_file","web_fetch"]' && cfg.hidden === true && JSON.stringify(cfg.hiddenFrom) === '["alpha"]' && JSON.stringify(cfg.canMessage) === '["gamma"]', JSON.stringify(cfg));
  check('detail: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testTopologySettings(browser) {
  const { p, ctx, errs } = await open(browser);
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'settings' }));
  await sleep(400);
  const sec = p.locator('[data-slot="subagent-topology"]');
  check('Limits has a topology section', await sec.count() === 1);
  const opts = () => p.evaluate(() => [...document.querySelectorAll('[data-slot="subagent-topology"] select option')].map((o) => o.value));
  let o = await opts();
  check('picker offers tree and star by default', JSON.stringify(o) === '["tree","star"]', JSON.stringify(o));
  await sec.locator('input[aria-label="Show mesh and ring"]').check();
  o = await opts();
  check('mesh and ring appear when turned on', JSON.stringify(o) === '["tree","star","mesh","ring"]', JSON.stringify(o));
  await sec.locator('select').selectOption('mesh');
  await sec.locator('input[aria-label="Sub-agents can ask the agent that started them"]').uncheck();
  await p.locator('.sa-dialog select[aria-label="Always allow covers"]').selectOption('global').catch(() => {});
  await p.locator('.sa-dialog button:has-text("Save limits"), .sa-dialog button:has-text("Save")').last().click();
  await sleep(400);
  const st = (await subCalls(p)).filter((c) => c.action === 'settings' && c.settings).pop();
  check('topology, ask-parent and Always-allow scope are sent to the engine', st && st.settings.topology === 'mesh' && st.settings.allowAskParent === false && st.settings.showAdvancedTopologies === true && st.settings.alwaysAllowScope === 'global', JSON.stringify(st));
  check('topology: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testMiniGraph(browser) {
  const { p, ctx, errs } = await open(browser);
  await p.evaluate(() => { window.__mock.emit('agent.started', {}); window.__mock.emit('tool_use', { toolCallId: 'call-main', toolName: 'spawn_subagent', args: { name: 'alpha', task: 'task of alpha' } }); });
  const ids = await makeChain(p, { finish: false });
  await sleep(500);
  const g = await p.evaluate(() => {
    const card = document.querySelector('[data-slot="subagent-card"]');
    return { title: card?.querySelector('.sa-card-title p')?.textContent || '', nodes: [...(card?.querySelectorAll('[data-slot="subagent-mini-graph"] .sa-mini-node') || [])].map((n) => ({ id: n.dataset.id, lvl: n.style.getPropertyValue('--lvl') })) };
  });
  check('spawning message card is matched by tool call id and shows the title', g.title === 'Title alpha', JSON.stringify(g));
  check('card has a small graph of the agents it started, nested', JSON.stringify(g.nodes.map((n) => n.lvl)) === '["0","1","2"]' && g.nodes[1].id === ids.b && g.nodes[2].id === ids.c, JSON.stringify(g));
  check('mini graph: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

/** Opens the name's switcher and reads the Path section (labels only), then closes it. */
async function pathMenu(p) {
  await p.click('[data-slot="agent-switcher"]');
  await sleep(200);
  const out = await p.evaluate(() => [...document.querySelectorAll('[role="menu"] [data-slot="agent-switch-all"], [role="menu"] [data-slot="agent-path-item"], [role="menu"] [data-slot="agent-path-here"]')]
    .map((e) => e.querySelector('.truncate').textContent.trim()));
  await p.keyboard.press('Escape');
  await sleep(150);
  return out;
}

async function testSubagentChatParity(browser) {
  // A sub-agent opened in the main chat surface: same thread, composer, Stop, retry, edit, approvals.
  const { p, ctx, errs } = await open(browser);
  const ids = await makeChain(p, { finish: true });
  const mainKey = await p.evaluate(() => window.__app.chat.mainId);
  await p.evaluate((id) => window.__app.chat.openSubagent(id), ids.b);
  await sleep(500);
  let v = await p.evaluate(() => ({
    key: window.__app.chat.mainId, sub: window.__app.chat.main.subagentId,
    head: !document.querySelector('[data-slot="subagent-chat-header"]')?.hidden,
    title: document.querySelector('[data-slot="subagent-chat-title"]')?.textContent || '',
    desc: document.querySelector('[data-slot="subagent-chat-desc"]')?.textContent || '',
    msgs: [...document.querySelectorAll('.aui-thread-viewport .aui-md, .aui-thread-viewport .aui-user-message-content')].map((m) => m.textContent.trim()).filter(Boolean),
    composer: !!document.querySelector('.aui-composer-input'), bar: !!document.querySelector('.aui-assistant-action-bar-root'),
  }));
  check('sub-agent opens in the main chat surface (its own session)', v.sub === ids.b && v.key !== mainKey, JSON.stringify(v));
  await p.click('[data-slot="subagent-chat-path"]');
  await sleep(200);
  v.crumbs = await p.evaluate(() => [...document.querySelectorAll('[role="menu"] [data-slot^="subagent-chat-path"]')].map((e) => e.querySelector('.truncate').textContent.trim()).join(' › '));
  await p.keyboard.press('Escape');
  check('chat header: title, description and the chain it came from (path menu)', v.head && v.title === 'Title beta' && v.desc === 'Description of beta' && /^Main agent › alpha.* › beta/.test(v.crumbs), JSON.stringify(v));
  check('its saved chat is shown with the main agent\u2019s renderer and controls', v.msgs.some((m) => m.includes('task of beta')) && v.msgs.some((m) => m.includes('report from beta')) && v.composer && v.bar, JSON.stringify(v));
  // Send from the same composer: goes to the sub-agent, not to the main chat.
  await p.fill('.aui-composer-input', 'also list the deadlines');
  await p.click('.aui-composer-send');
  await sleep(500);
  const sub = await subCalls(p);
  const sent = sub.filter((c) => c.action === 'message').pop();
  const mainSends = await bridgeCalls(p, /agent\.(sendMessage|followUp)$/);
  check('composer sends to the sub-agent (message action)', sent && sent.id === ids.b && sent.message === 'also list the deadlines', JSON.stringify(sent));
  check('nothing is sent to the main agent', mainSends.length === 0, JSON.stringify(mainSends));
  // While it works: running + Stop, and Stop reaches the engine.
  v = await state(p);
  check('while it works the chat shows it running with Stop', v.running && v.stop, JSON.stringify(v));
  // Its own approval goes into its open chat.
  await p.evaluate((sid) => window.__mock.emit('approval_request', { toolCallId: 'ap-sub', toolName: 'write_file', args: { path: 'd.md' }, subagent: { id: sid, name: 'beta' }, sessionKey: window.__sa.mainKey }), ids.b);
  await sleep(300);
  v = await state(p);
  check('its approval shows in its own chat', v.threadCards === 1, JSON.stringify(v));
  await p.click('.aui-composer-cancel');
  await sleep(300);
  const stop = (await subCalls(p)).filter((c) => c.action === 'interrupt').pop();
  check('the composer square interrupts the sub-agent (the current step only)', stop && stop.id === ids.b, JSON.stringify(stop));
  // Retry and edit work like the main chat (regenerate / edit with the turn).
  await p.evaluate(() => { const rt = window.__app.chat.main; rt._run = null; const a = [...rt.messages].reverse().find((m) => m.role === 'assistant'); if (a) rt.retry(a.id); });
  await sleep(300);
  const regen = (await subCalls(p)).filter((c) => c.action === 'regenerate').pop();
  check('Retry regenerates the sub-agent\u2019s reply', regen && regen.id === ids.b && Number.isInteger(regen.turn), JSON.stringify(regen));
  await p.evaluate(() => { const rt = window.__app.chat.main; rt._run = null; const u = rt.messages.find((m) => m.role === 'user'); if (u) rt.editUser(u.id, 'edited task'); });
  await sleep(300);
  const edit = (await subCalls(p)).filter((c) => c.action === 'edit').pop();
  check('Edit resends the edited message to the sub-agent', edit && edit.id === ids.b && edit.message === 'edited task' && edit.turn === 0, JSON.stringify(edit));
  // Breadcrumb back to its parent, then to the main chat.
  await p.evaluate(() => { window.__app.chat.main._run = null; });
  await p.click('[data-slot="subagent-chat-back"]');
  await sleep(400);
  v = await p.evaluate(() => ({ sub: window.__app.chat.main.subagentId, title: document.querySelector('[data-slot="subagent-chat-title"]')?.textContent }));
  check('Back opens the agent that started it', v.sub === ids.a && v.title === 'Title alpha', JSON.stringify(v));
  await p.click('[data-slot="subagent-chat-back"]');
  await sleep(500);
  v = await p.evaluate(() => ({ key: window.__app.chat.mainId, sub: window.__app.chat.main.subagentId || null, head: !document.querySelector('[data-slot="subagent-chat-header"]')?.hidden }));
  check('Back from level 1 returns to the main chat', v.key === mainKey && !v.sub && !v.head, JSON.stringify(v));
  check('sub-agent chat: no page errors', !errs.length, errs.join(' / '));
  await ctx.close();
}

module.exports = { open, makeChain, subCalls, bridgeCalls, sources, check, results, EXE, URL_ };
if (require.main === module) (async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const tests = { testParentEdges, testReloadPersistence, testStaleRunning, testStuckAfterMainFinished, testOtherChat, testAlwaysAllowScope, testDetailAndSetup, testTopologySettings, testMiniGraph, testSubagentChatParity };
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\nsubagent-graph-fixes: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
