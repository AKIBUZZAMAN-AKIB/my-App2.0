// Topology groups: several topologies at once in one chat (subagents/groups.rs). The user's example: main, a, b, c, d
// in the spawn tree; a, d, e, f in a mesh; a, e, g, h on a bus. Checks the mock's permission rules, the Swarm tab's
// group editor (create, edit, delete, members, hub, warnings), the Team tab's group line, and the Explorer drawing
// the real graph (tree plus each group's links, a bus node, a legend) instead of a tree. SHOTS=<dir> saves screenshots.
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');

const EXE = (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = 'file://' + path.resolve(__dirname, '../../www/agent.html');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`); };
const FEATURES = ['subagentQueue', 'subagentData', 'subagentReuse', 'crossSession', 'subagentGraph', 'subagentTeam', 'subagentChatAllow', 'subagentAdvanced', 'subagentSwarm'];
const SHOTS = process.env.SHOTS || '';
const shot = async (p, name, el) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await (el ? p.locator(el).first().screenshot({ path: path.join(SHOTS, name) }) : p.screenshot({ path: path.join(SHOTS, name) })); };

async function open(browser, { width = 390, height = 844, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript((f) => { window.__SA_CFG = { s1features: f }; window.__MEM_CFG = { goals: true }; }, FEATURES);
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

/** main -> a, b, c, d; a -> e, f; d -> g, h (the spawn tree). */
async function seedTeam(p) {
  return p.evaluate(() => {
    const k = window.__app.chat.mainId; const t0 = Date.now() - 120000; const ids = {};
    const mk = (name, parent, i) => {
      const s = window.__sa.make({ name, task: `Task for ${name}`, status: i % 3 === 2 ? 'finished' : 'running', depth: parent ? 2 : 1, createdAt: t0 + i * 1000 });
      Object.assign(s, { parentId: null, parentSessionKey: k, rootSessionKey: k, startedAt: t0 + i * 1000, model: 'claude-sonnet-4.5', totalTokens: 1000 + i * 300, steps: 2 + i });
      s.title = `Agent ${name.toUpperCase()}`;
      if (parent) { const pr = window.__sa.subs.get(ids[parent]); s.parentId = pr.id; s.parentSessionKey = pr.sessionKey; }
      window.__sa.emit('subagent.started', { ...s });
      ids[name] = s.id; return s;
    };
    ['a', 'b', 'c', 'd'].forEach((n, i) => mk(n, null, i));
    mk('e', 'a', 4); mk('f', 'a', 5); mk('g', 'd', 6); mk('h', 'd', 7);
    return ids;
  });
}
const swarm = (p, req) => p.evaluate(async (r) => { const x = await window.NativeKit.agent.subagents(r); return x && typeof x.resultJson === 'string' ? JSON.parse(x.resultJson) : x; }, req);
const EXAMPLE = [{ name: 'Research', topology: 'mesh', members: ['a', 'd', 'e', 'f'] }, { name: 'Ops bus', topology: 'bus', members: ['a', 'e', 'g', 'h'] }];

async function testEngineRules(browser) {
  const { p, ctx, errs } = await open(browser, { width: 1280, height: 900 });
  const ids = await seedTeam(p);
  let st = await swarm(p, { action: 'swarmState', sessionKey: 'chat' });
  const pairs = (s) => new Set(s.topologyEdges.map((e) => `${e.from}>${e.to}`));
  check('no groups: a single Tree topology, a and d cannot talk', st.groups.length === 0 && !pairs(st).has(`${ids.a}>${ids.d}`), JSON.stringify(st.groups));
  const res = await swarm(p, { action: 'setCommsConfig', sessionKey: 'chat', patch: { groups: EXAMPLE } });
  check('groups save with ids', res.effective.groups.length === 2 && res.effective.groups.every((g) => /^tg_/.test(g.id)), JSON.stringify(res.effective.groups));
  st = await swarm(p, { action: 'swarmState', sessionKey: 'chat' });
  const P = pairs(st);
  check('mesh: a, d, e, f all reach each other', ['a', 'd', 'e', 'f'].every((x) => ['a', 'd', 'e', 'f'].every((y) => x === y || P.has(`${ids[x]}>${ids[y]}`))));
  check('bus: g and h get no direct line', !P.has(`${ids.g}>${ids.h}`) && !P.has(`${ids.h}>${ids.g}`));
  check('the tree still counts: d and g (parent and child)', P.has(`${ids.d}>${ids.g}`) && P.has(`${ids.g}>${ids.d}`));
  check('b and c (in no group) stay apart', !P.has(`${ids.b}>${ids.c}`));
  check('swarmState lists each group with its members matched to agents', st.groups[1].memberIds.join() === [ids.a, ids.e, ids.g, ids.h].join(), JSON.stringify(st.groups[1]));
  const bad = await swarm(p, { action: 'setCommsConfig', sessionKey: 'chat', patch: { groups: [{ name: 'X', topology: 'mesh' }, { name: 'x', topology: 'bus' }] } }).catch((e) => ({ error: String(e.message || e) }));
  check('two groups with one name are rejected', !!bad.error, JSON.stringify(bad).slice(0, 200));
  check('engine: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function openSwarmTab(p) {
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'swarm' }));
  await p.waitForSelector('[data-slot=swarm-groups]', { timeout: 5000 }).catch(() => {});
  await sleep(400);
}

async function testEditor(browser) {
  const { p, ctx, errs } = await open(browser);
  const ids = await seedTeam(p);
  await openSwarmTab(p);
  check('the Swarm overview has a Topology groups card with an (i) button', await p.locator('[data-slot=swarm-groups] .info-tip, [data-slot=swarm-groups] [data-slot=info-tip], [data-slot=swarm-groups] button[aria-label*="About"], [data-slot=swarm-groups] button[aria-label*="Topology groups"]').count() > 0);
  check('empty state names the chat\u2019s topology', /follows the chat\u2019s Tree topology/.test(await p.locator('[data-slot=swarm-groups-empty]').innerText().catch(() => '')));
  // Create the mesh through the dialog.
  await p.locator('[data-slot=swarm-group-new]').click(); await sleep(300);
  await p.fill('[data-slot=group-name]', 'Research');
  await p.selectOption('[data-slot=group-topology]', 'mesh');
  for (const n of ['a', 'd', 'e', 'f']) await p.locator(`[data-slot=group-members] input[data-id="${ids[n]}"]`).check();
  check('the dialog counts members (no cap)', /4 of 8 agents/.test(await p.locator('[data-slot=group-count]').innerText()), await p.locator('[data-slot=group-count]').innerText());
  check('the dialog explains the type', /Every member may message every other/.test(await p.locator('[data-slot=group-rule]').innerText()));
  await shot(p, '02-group-editor-mesh.png');
  await p.locator('[data-slot=group-save]').click(); await sleep(500);
  let cfg = await p.evaluate(() => window.__swarm.configs.chat.groups);
  check('Create saves the group through setCommsConfig', cfg?.length === 1 && cfg[0].topology === 'mesh' && cfg[0].members.length === 4, JSON.stringify(cfg));
  // A star with no hub shows the warning, then picking a hub clears it.
  await p.locator('[data-slot=swarm-group-new]').click(); await sleep(300);
  await p.fill('[data-slot=group-name]', 'Leads');
  await p.selectOption('[data-slot=group-topology]', 'star');
  for (const n of ['b', 'c']) await p.locator(`[data-slot=group-members] input[data-id="${ids[n]}"]`).check();
  check('Star with no hub warns in the dialog', /Star needs a Hub/.test(await p.locator('[data-slot=group-warnings]').innerText()));
  await p.selectOption('[data-slot=group-hub]', ids.b); await sleep(100);
  check('picking a hub clears the warning', !/Star needs a Hub/.test(await p.locator('[data-slot=group-warnings]').innerText()));
  await p.locator('[data-slot=group-save]').click(); await sleep(500);
  cfg = await p.evaluate(() => window.__swarm.configs.chat.groups);
  check('the star keeps its hub', cfg[1].hub === ids.b, JSON.stringify(cfg[1]));
  // Bus.
  await p.locator('[data-slot=swarm-group-new]').click(); await sleep(300);
  await p.fill('[data-slot=group-name]', 'Research');
  await p.locator('[data-slot=group-save]').click(); await sleep(200);
  check('a duplicate name is refused in the dialog', /Another group is named Research/.test(await p.locator('[data-slot=group-error]').innerText()));
  await p.fill('[data-slot=group-name]', 'Ops bus');
  await p.selectOption('[data-slot=group-topology]', 'bus');
  for (const n of ['a', 'e', 'g', 'h']) await p.locator(`[data-slot=group-members] input[data-id="${ids[n]}"]`).check();
  await p.locator('[data-slot=group-save]').click(); await sleep(600);
  const rows = await p.$$eval('[data-slot=swarm-group]', (els) => els.map((e) => `${e.dataset.topology}:${e.querySelector('[data-slot=swarm-group-members]').textContent}`));
  check('the list shows all three groups with their members', rows.join('|') === 'mesh:a, d, e, f|star:b, c|bus:a, e, g, h', rows.join('|'));
  // Edit: remove the star's hub -> the list warns.
  await p.locator('[data-slot=swarm-group]').nth(1).locator('[data-slot=swarm-group-edit]').click(); await sleep(300);
  check('Edit opens with the saved members checked', await p.locator(`[data-slot=group-members] input[data-id="${ids.b}"]`).isChecked());
  await p.selectOption('[data-slot=group-hub]', ''); await p.locator('[data-slot=group-save]').click(); await sleep(500);
  check('the list warns about a Star with no Hub', /Star needs a Hub/.test(await p.locator('[data-slot=swarm-group]').nth(1).innerText()));
  // Delete the star.
  await p.locator('[data-slot=swarm-group]').nth(1).locator('[data-slot=swarm-group-delete]').click(); await sleep(300);
  await p.locator('[role=alertdialog] button:has-text("Delete"), .dialog button:has-text("Delete")').last().click(); await sleep(500);
  cfg = await p.evaluate(() => window.__swarm.configs.chat.groups);
  check('Delete removes just that group', cfg.length === 2 && cfg.map((g) => g.name).join() === 'Research,Ops bus', JSON.stringify(cfg?.map((g) => g.name)));
  await shot(p, '01-swarm-groups-list.png', '[data-slot=swarm-groups]');
  check('editor: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testExplorer(browser) {
  const { p, ctx, errs } = await open(browser);
  const ids = await seedTeam(p);
  await p.evaluate(() => localStorage.removeItem('agent.subagents.explorer.v1'));
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' }));
  await p.waitForSelector('[data-slot=subagent-explorer] [data-node]', { timeout: 5000 }).catch(() => {});
  await sleep(600);
  const st = () => p.evaluate(() => {
    const root = document.querySelector('[data-slot=subagent-explorer]');
    const q = (s) => [...root.querySelectorAll(s)];
    return {
      links: q('.sa-x-glink').map((e) => `${e.closest('[data-group]').dataset.topology}:${e.dataset.from}>${e.dataset.to || ''}`),
      buses: q('[data-slot=explorer-bus]').length, legend: root.querySelector('[data-slot=explorer-group-legend]'),
      legendText: root.querySelector('[data-slot=explorer-group-legend]')?.innerText || '', legendHidden: root.querySelector('[data-slot=explorer-group-legend]')?.hidden,
      shapeHidden: root.querySelector('[data-slot=explorer-shape]')?.hidden, shapeLabel: root.querySelector('[data-slot=explorer-shape]')?.getAttribute('aria-label'),
      orientHidden: root.querySelector('[data-slot=explorer-orient]')?.hidden,
      pips: q('[data-slot=explorer-group-pips] circle').length,
      pos: Object.fromEntries(q('[data-node]').map((n) => [n.dataset.node, n.getAttribute('transform')])),
    };
  });
  let s = await st();
  check('no groups: no group lines, no legend, no shape button', !s.links.length && s.legendHidden && s.shapeHidden);
  await swarm(p, { action: 'setCommsConfig', sessionKey: 'chat', patch: { groups: EXAMPLE } });
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'swarm' })); await sleep(300); await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' })); await sleep(1200);
  s = await st();
  const mesh = s.links.filter((l) => l.startsWith('mesh:'));
  check('mesh draws every pair of its four members (6 lines)', mesh.length === 6, mesh.join());
  check('bus draws one node with a line to each of its four members', s.buses === 1 && s.links.filter((l) => l.startsWith('bus:')).length === 4, `${s.buses} ${s.links.join()}`);
  check('the legend lists the spawn tree and both groups', !s.legendHidden && /Spawn tree/.test(s.legendText) && /Research · Mesh/.test(s.legendText) && /Ops bus · Bus/.test(s.legendText), s.legendText);
  check('nodes carry a dot per group (a: 2, d: 1, e: 2, f: 1, g: 1, h: 1 = 8)', s.pips === 8, String(s.pips));
  check('the whole graph shows (not a tree): the shape button offers the tree, direction is hidden', !s.shapeHidden && /tree/i.test(s.shapeLabel) && s.orientHidden, `${s.shapeLabel} ${s.orientHidden}`);
  const overlaps = await p.evaluate(() => {
    const R = [...document.querySelectorAll('[data-slot=subagent-explorer] .sa-x-node .sa-x-box, [data-slot=explorer-bus] rect')].map((e) => e.getBoundingClientRect());
    let n = 0; for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const a = R[i], b = R[j]; if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) n++; } return n;
  });
  check('no two nodes (or the bus) overlap', overlaps === 0, String(overlaps));
  await shot(p, '03-explorer-graph.png');
  if (SHOTS) { await p.setViewportSize({ width: 390, height: 1100 }); await sleep(300); await p.locator('[data-slot=explorer-fit]').click().catch(() => {}); await sleep(500); await shot(p, '03b-explorer-canvas.png', '[data-slot=subagent-explorer] .sa-x-canvaswrap'); await p.setViewportSize({ width: 390, height: 844 }); }
  await p.locator('[data-slot=explorer-fit]').click().catch(() => {}); await sleep(400);
  const netPos = s.pos;
  await p.locator('[data-slot=explorer-shape]').click(); await sleep(600);
  let t = await st();
  check('Show as tree goes back to the tidy tree, groups still drawn over it', t.shapeLabel === 'Show the whole graph' && t.links.length === 10 && !t.orientHidden && JSON.stringify(t.pos) !== JSON.stringify(netPos), `${t.shapeLabel} ${t.links.length}`);
  await p.locator('[data-slot=explorer-shape]').click(); await sleep(600);
  t = await st();
  check('and back to the whole graph, at the same places (deterministic)', JSON.stringify(t.pos) === JSON.stringify(netPos));
  // A ring draws in order with arrows; a star through its hub.
  await swarm(p, { action: 'setCommsConfig', sessionKey: 'chat', patch: { groups: [{ name: 'R', topology: 'ring', members: ['b', 'c', 'd'] }, { name: 'S', topology: 'star', members: ['a', 'e', 'f'], hub: 'a' }] } });
  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'swarm' })); await sleep(300); await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' })); await sleep(1200);
  t = await st();
  check('ring: b>c, c>d, d>b', ['b>c', 'c>d', 'd>b'].every((x) => { const [f, to] = x.split('>'); return t.links.includes(`ring:${ids[f]}>${ids[to]}`); }) && t.links.filter((l) => l.startsWith('ring:')).length === 3, t.links.join());
  check('star: two spokes from the hub', t.links.filter((l) => l.startsWith('star:')).length === 2 && t.links.includes(`star:${ids.a}>${ids.e}`));
  check('explorer: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testTeamLine(browser) {
  const { p, ctx, errs } = await open(browser);
  const ids = await seedTeam(p);
  await swarm(p, { action: 'setCommsConfig', sessionKey: 'chat', patch: { groups: EXAMPLE } });
  await p.evaluate((i) => window.__subagents.open(window.__app, { id: i, agentTab: 'team' }), ids.a);
  await sleep(900);
  const txt = await p.evaluate(() => document.querySelector('[data-slot=team-swarm-role]')?.innerText || '');
  check('the agent\u2019s Team tab says which groups it is in', /Research \(Mesh\)/.test(txt) && /Ops bus \(Bus\)/.test(txt), txt.slice(0, 200));
  check('and shows them as chips', /Research · Mesh/.test(await p.locator('[data-slot=team-swarm-groups]').innerText().catch(() => '')));
  await shot(p, '04-team-tab-groups.png');
  check('team: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  for (const t of [testEngineRules, testEditor, testExplorer, testTeamLine]) {
    try { await t(browser); } catch (e) { check(`${t.name} ran`, false, String(e.stack || e).slice(0, 400)); }
  }
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`topology-groups: ${ok}/${results.length} passed`);
  process.exit(ok === results.length ? 0 : 1);
})();
