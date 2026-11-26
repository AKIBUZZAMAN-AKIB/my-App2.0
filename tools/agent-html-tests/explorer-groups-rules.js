#!/usr/bin/env node
// Explorer: drawn rules are saved right (one rule per pair, deny never left behind, edit and remove from the
// canvas), and topology groups are made and edited on the canvas (Make Mesh / Star / Bus..., custom links).
// SHOT=1 also writes screenshots to tools/agent-html-tests/shots/explorer-*.png.
const fs = require('fs');
const path = require('path');
const { chromium } = require('./pw.js');
const { open, seed, rule, openExplorer, state, sleep } = require('./subagent-swarm-explorer.js');

const EXE = (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const SHOTS = process.env.SHOT === '1' ? path.join(__dirname, 'shots') : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !info ? '' : `  -- ${info}`}`); };
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `explorer-${name}.png`) }); };
const fit = async (p) => { await p.locator('[data-slot=explorer-fit]').click().catch(() => {}); await sleep(400); };
// Screenshots: the panel full size, so the canvas reads.
const openX = async (p) => { await openExplorer(p); if (SHOTS && await p.locator('[data-slot=sa-dock-expand]').isVisible().catch(() => false)) { await p.locator('[data-slot=sa-dock-expand]').click(); await sleep(500); await fit(p); } };
const node = (p, id) => p.locator(`[data-slot=subagent-explorer] [data-node="${id}"]`);
const edges = (p) => p.evaluate(() => window.__swarm.configs.chat?.edges || []);
const groups = (p) => p.evaluate(() => window.__swarm.configs.chat?.groups || []);
const openDlg = (p) => p.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter((x) => !x.hidden && x.getClientRects().length).pop(); return d ? d.innerText : ''; });
const clickRule = (p, from, to) => p.evaluate(([f, t]) => { const g = document.querySelector(`[data-edge=rule][data-from="${f}"][data-to="${t}"]`); if (!g) return false; const r = g.querySelector('path').getBoundingClientRect(); const c = g.closest('svg').parentElement; const o = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, button: 0, isPrimary: true }; const hit = g.querySelector('.sa-x-hit'); hit.dispatchEvent(new PointerEvent('pointerdown', o)); hit.dispatchEvent(new PointerEvent('pointerup', o)); void c; return true; }, [from, to]);

async function testRules(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  // an old deny written by id and an allow written by name on the same pair: deny wins in the engine
  await rule(p, ids.polish, ids.writer, false); await rule(p, 'polish', 'writer', true);
  await openX(p);
  let s = await state(p);
  check('two rules on one pair draw as one edge with the engine\u2019s verdict (deny wins)', s.rules.filter((r) => r.includes(`${ids.polish}>${ids.writer}`)).length === 1 && s.rules.includes(`deny:${ids.polish}>${ids.writer}`), s.rules.join());
  await shot(p, '01-normal');
  // draw allow on the same pair: every old rule on it goes
  await p.locator('[data-slot=explorer-draw-rule]').click(); await sleep(200);
  await node(p, ids.polish).click(); await sleep(200);
  await shot(p, '02-draw-rule-pick');
  await node(p, ids.writer).click(); await sleep(400);
  check('the dialog says the pair\u2019s rules disagree', /disagree/.test(await openDlg(p)), (await openDlg(p)).slice(0, 200));
  await p.locator('[data-slot=explorer-rule-allow]').check();
  await shot(p, '03-draw-rule-allow');
  await p.locator('[data-slot=explorer-rule-save]').click(); await sleep(800);
  let e = await edges(p);
  check('saving an allow replaces the id-named deny too, so it really gets through', e.length === 1 && e[0].allow === true && e[0].from === 'polish', JSON.stringify(e));
  s = await state(p);
  check('the explorer shows the allow', s.rules.includes(`allow:${ids.polish}>${ids.writer}`), s.rules.join());
  // a both-ways rule, then a one-way deny back: the both-ways rule keeps its forward half
  await p.locator('[data-slot=explorer-draw-rule]').click(); await sleep(200);
  await node(p, ids.outline).click(); await sleep(150); await node(p, ids.reviewer).click(); await sleep(400);
  await p.locator('[data-slot=explorer-rule-allow]').check(); await p.locator('[data-slot=explorer-rule-both]').check();
  await p.locator('[data-slot=explorer-rule-save]').click(); await sleep(800);
  await p.locator('[data-slot=explorer-draw-rule]').click(); await sleep(200);
  await node(p, ids.reviewer).click(); await sleep(150); await node(p, ids.outline).click(); await sleep(400);
  await p.locator('[data-slot=explorer-rule-deny]').check(); await p.locator('[data-slot=explorer-rule-both]').uncheck();
  await shot(p, '04-draw-rule-deny');
  await p.locator('[data-slot=explorer-rule-save]').click(); await sleep(800);
  e = (await edges(p)).filter((x) => /outline|reviewer/.test(x.from + x.to));
  check('a one-way deny back splits the both-ways allow: outline -> reviewer allow stays, reviewer -> outline deny', e.length === 2 && e.some((x) => x.from === 'outline' && x.to === 'reviewer' && x.allow && !x.both) && e.some((x) => x.from === 'reviewer' && x.to === 'outline' && !x.allow), JSON.stringify(e));
  s = await state(p);
  check('both directions show, each with its own verdict', s.rules.includes(`allow:${ids.outline}>${ids.reviewer}`) && s.rules.includes(`deny:${ids.reviewer}>${ids.outline}`), s.rules.join());
  // click a rule on the canvas: edit / remove
  check('a rule edge on the canvas opens Edit rule', await clickRule(p, ids.polish, ids.writer) && /Edit rule/.test(await (sleep(400).then(() => openDlg(p)))), await openDlg(p));
  await shot(p, '05-edit-rule');
  await p.locator('[data-slot=explorer-rule-remove]').click(); await sleep(800);
  e = await edges(p);
  s = await state(p);
  check('Remove rule takes it out of the engine config and off the canvas', !e.some((x) => x.from === 'polish' && x.to === 'writer') && !s.rules.some((r) => r.includes(`${ids.polish}>${ids.writer}`)), JSON.stringify(e));
  check('rules: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function testGroups(browser) {
  const { p, ctx, errs } = await open(browser);
  const { ids } = await seed(p);
  await openX(p);
  const btn = p.locator('[data-slot=explorer-groups]');
  check('with the swarm feature the Groups button shows', await btn.isVisible());
  await btn.click(); await sleep(250); await fit(p);
  const bar = () => p.evaluate(() => document.querySelector('[data-slot=explorer-groupbar]')?.innerText || '');
  check('Groups mode asks to pick agents; Make buttons wait for two', /pick them for a group/i.test(await bar()) && await p.locator('[data-slot=explorer-make-mesh]').isDisabled(), await bar());
  for (const n of ['web-scout', 'outline', 'draft']) { await node(p, ids[n]).click(); await sleep(120); }
  check('picked agents are marked and numbered', (await p.$$eval('[data-node][data-gpick=true]', (x) => x.length)) === 3 && (await p.$$eval('[data-slot=explorer-pick-number]', (x) => x.length)) === 3);
  await shot(p, '06-groups-pick');
  await p.locator('[data-slot=explorer-make-mesh]').click(); await sleep(900);
  let g = await groups(p);
  check('Make Mesh saves a mesh group of the picked agents at once', g.length === 1 && g[0].topology === 'mesh' && g[0].name === 'Mesh 1' && g[0].members.length === 3, JSON.stringify(g));
  let s = await p.evaluate(() => document.querySelectorAll('[data-slot=subagent-explorer] [data-edge=group], [data-slot=subagent-explorer] .sa-x-group').length);
  check('the new group shows on the canvas', s > 0, String(s));
  await shot(p, '07-mesh-created');
  // star: first picked is the hub
  await btn.click(); await sleep(200); await fit(p);
  for (const n of ['polish', 'writer', 'reviewer']) { await node(p, ids[n]).click(); await sleep(120); }
  await p.locator('[data-slot=explorer-make-star]').click(); await sleep(900);
  g = await groups(p);
  const star = g.find((x) => x.topology === 'star');
  check('Make Star uses the first picked agent as the hub', !!star && star.hub === ids.polish && star.name === 'Star 1', JSON.stringify(star));
  await shot(p, '08-star-created');
  await btn.click(); await sleep(200); await fit(p);
  for (const n of ['fact-checker', 'writer']) { await node(p, ids[n]).click(); await sleep(120); }
  await p.locator('[data-slot=explorer-make-bus]').click(); await sleep(900);
  g = await groups(p);
  check('Make Bus saves a bus group', g.some((x) => x.topology === 'bus' && x.members.length === 2), JSON.stringify(g.map((x) => x.name)));
  await shot(p, '09-bus-created');
  // custom: Make Custom goes straight to Draw links
  await btn.click(); await sleep(200); await fit(p);
  for (const n of ['outline', 'reviewer', 'polish']) { await node(p, ids[n]).click(); await sleep(120); }
  await p.locator('[data-slot=explorer-make-custom]').click(); await sleep(900);
  const lbar = () => p.evaluate(() => { const b = document.querySelector('[data-slot=explorer-linkbar]'); return b && !b.hidden ? b.innerText : ''; });
  check('Make Custom opens Draw links for the new group', /Draw links in Custom 1/.test(await lbar()), await lbar());
  await node(p, ids.outline).click(); await sleep(200);
  await shot(p, '10-custom-link-pick');
  await node(p, ids.reviewer).click(); await sleep(800);
  await node(p, ids.reviewer).click(); await sleep(200); await node(p, ids.polish).click(); await sleep(800);
  g = await groups(p);
  let cu = g.find((x) => x.topology === 'custom');
  check('two drawn links are saved in the custom group, by agent id', cu && (cu.links || []).length === 2 && cu.links.some((l) => l.from === ids.outline && l.to === ids.reviewer), JSON.stringify(cu));
  await shot(p, '11-custom-links');
  // tap a linked pair again to unlink
  await node(p, ids.reviewer).click(); await sleep(200); await node(p, ids.outline).click(); await sleep(800);
  cu = (await groups(p)).find((x) => x.topology === 'custom');
  check('tapping a linked pair again removes the link', (cu.links || []).length === 1, JSON.stringify(cu));
  await p.locator('[data-slot=explorer-link-done]').click(); await sleep(200);
  // edit panel for a group
  await btn.click(); await sleep(250);
  check('Groups mode lists the chat\u2019s groups to edit', (await p.$$eval('[data-slot=explorer-group-select] option', (o) => o.length)) === 4);
  await shot(p, '12-groups-edit-row');
  await p.locator('[data-slot=explorer-group-select]').selectOption('Mesh 1'); await sleep(150);
  await p.locator('[data-slot=explorer-group-edit]').click(); await sleep(500);
  check('Edit opens the group form for that group', /Edit Mesh 1/.test(await openDlg(p)), (await openDlg(p)).slice(0, 120));
  await shot(p, '13-group-edit-dialog');
  await p.keyboard.press('Escape'); await sleep(300);
  // More... opens the full form filled in with the picked agents
  if (!(await p.locator('[data-slot=explorer-groupbar]').isVisible())) { await btn.click(); await sleep(200); }
  await fit(p);
  for (const n of ['writer', 'draft']) { await node(p, ids[n]).click(); await sleep(120); }
  await p.locator('[data-slot=explorer-make-more]').click(); await sleep(500);
  check('More\u2026 opens New topology group with the picked agents', /New topology group/.test(await openDlg(p)), (await openDlg(p)).slice(0, 120));
  await shot(p, '14-new-group-dialog');
  await p.keyboard.press('Escape'); await sleep(300);
  // delete
  if (!(await p.locator('[data-slot=explorer-groupbar]').isVisible())) { await btn.click(); await sleep(200); }
  await fit(p);
  await p.locator('[data-slot=explorer-group-select]').selectOption('Bus 1'); await sleep(150);
  await p.locator('[data-slot=explorer-group-delete]').click(); await sleep(300);
  await p.locator('[role=dialog] .btn-destructive').last().click(); await sleep(800);
  check('Delete removes the group', !(await groups(p)).some((x) => x.name === 'Bus 1'), JSON.stringify((await groups(p)).map((x) => x.name)));
  await p.keyboard.press('Escape'); await sleep(200);
  check('Esc leaves Groups mode', !(await p.locator('[data-slot=explorer-groupbar]').isVisible()));
  check('groups: no page errors', !errs.length, errs.join(' | ').slice(0, 300));
  if (SHOTS) {
    for (const [w, dark, name] of [[390, false, '15-mobile-groups'], [1280, true, '16-dark-groups']]) {
      const o = await open(browser, { width: w, height: w < 600 ? 844 : 900, dark });
      const r = await seed(o.p); await openX(o.p);
      await o.p.locator('[data-slot=explorer-groups]').click(); await sleep(200); await fit(o.p);
      for (const n of ['outline', 'draft', 'writer']) { await node(o.p, r.ids[n]).click(); await sleep(120); }
      await shot(o.p, name);
      await o.ctx.close();
    }
  }
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  for (const [name, fn] of [['rules', testRules], ['groups', testGroups]]) {
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
