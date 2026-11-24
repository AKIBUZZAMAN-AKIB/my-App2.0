// Delete settings and Trash (65-workspace-bulk.js), plan.md Phase 5 item 5,
// against a mock engine that resolves the delete policy like the engine does
// (holder override > kind override > global):
//   1. set Direct globally in Deleting; the request carries mode and no retention;
//   2. a chat's item page has "When I delete from here"; setting 7 days saves
//      a holder:session:<key> override;
//   3. delete in that chat goes to Trash with the date 7 days out;
//   4. delete elsewhere shows the permanent warning and runs nothing until confirmed;
//   5. "Apply to items in Trash" asks first and shows the due count; confirm re-sends with confirm;
//   6. Trash: Restore and Empty Trash (with count) and their requests;
//   7. 375 px: no horizontal overflow; no page errors.
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const EXE = process.env.EXE || (() => {
  const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright');
  const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null;
  return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined;
})();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + String(extra).slice(0, 400) : ''}`); return ok; };

function mock() {
  const calls = [];
  window.__calls = calls;
  const DAY = 86400;
  const NOW = Date.UTC(2026, 10, 24, 12);
  window.__NOW = NOW;
  const items = {
    chats: [{ id: 'c2', kind: 'chat', title: 'Trip', loc: 'db:sessions/s2', owner: 'session:s2', state: 'live' }, { id: 'c1', kind: 'chat', title: 'Work', loc: 'db:sessions/s1', owner: 'session:s1', state: 'live' }],
    notes: [{ id: 'n2', kind: 'note', title: 'Packing list', owner: 'session:s2', state: 'live' }, { id: 'n1', kind: 'note', title: 'Standup', owner: 'session:s1', state: 'live' }],
  };
  const all = () => Object.values(items).flat();
  let policies = [{ scope: 'global', mode: 'timed', retainSecs: 30 * DAY }];
  let trash = [
    { id: 't1', kind: 'note', title: 'Old note', owner: 'session:s1', restoreOwner: 'session:s1', purgeAfter: NOW + 3 * DAY * 1000 },
    { id: 't2', kind: 'file', title: 'keep.txt', owner: 'agent:a', restoreOwner: 'agent:a', purgeAfter: null },
    { id: 't3', kind: 'note', title: 'Stale', owner: 'session:s1', restoreOwner: 'session:s1', purgeAfter: NOW - DAY * 1000 },
  ];
  const resolve = (it, override) => {
    if (override) return override;
    return policies.find((p) => p.scope === `holder:${it.owner}`) || policies.find((p) => p.scope === `kind:${it.kind}`) || policies.find((p) => p.scope === 'global');
  };
  const dry = (req) => {
    const res = req.ids.map((id) => {
      const it = all().find((i) => i.id === id);
      const p = resolve(it, req.policy);
      return p.mode === 'direct' ? { id, title: it.title, action: 'delete', permanent: true } : { id, title: it.title, action: 'delete', trash: true, purgeAfter: p.retainSecs == null ? null : NOW + p.retainSecs * 1000 };
    });
    const perm = res.filter((r) => r.permanent).length;
    const trashed = res.filter((r) => r.trash).length;
    const parts = [];
    if (trashed) parts.push(`${trashed} trashed`);
    if (perm) parts.push(`${perm} removed permanently`);
    return { dryRun: !!req.dryRun, ok: true, op: 'delete', count: req.ids.length, summary: parts.join(', '), counts: { permanent: perm, trashed, detached: 0 }, results: res, blocked: [] };
  };
  window.__wsBulkBridge = async (action, req) => {
    calls.push({ action, req: JSON.parse(JSON.stringify(req || {})) });
    switch (action) {
      case 'items.tree': return { sections: items };
      case 'items.bulk': return dry(req);
      case 'items.holders': return { refs: [{ id: 'o', mode: 'owner', holder: 'user', holderName: 'You', perm: 'manage', state: 'live' }], implicit: [] };
      case 'items.audit': return { rows: [] };
      case 'items.trashList': return { items: trash };
      case 'items.restore': trash = trash.filter((t) => t.id !== req.id); return { ok: true };
      case 'items.purge': trash = trash.filter((t) => t.id !== req.id); return { ok: true };
      case 'items.emptyTrash': { const n = trash.length; trash = []; return { purged: n }; }
      case 'items.policy.get': return { policies };
      case 'items.policy.set': {
        const due = trash.filter((t) => t.purgeAfter != null && t.purgeAfter < NOW).length;
        if (req.applyToExisting && due && !req.confirm) return { needsConfirm: true, due, moved: 1, message: `This removes ${due} item${due === 1 ? '' : 's'} from Trash now.` };
        if (req.applyToExisting) trash = trash.filter((t) => !(t.purgeAfter != null && t.purgeAfter < NOW));
        policies = policies.filter((p) => p.scope !== req.scope).concat([{ scope: req.scope, mode: req.mode, retainSecs: req.retainSecs }]);
        return { policy: { scope: req.scope, mode: req.mode, retainSecs: req.retainSecs }, moved: req.applyToExisting ? 1 : 0, purged: req.applyToExisting ? due : 0 };
      }
      case 'items.policy.clear': policies = policies.filter((p) => p.scope !== req.scope); return { ok: true };
      default: return { error: 'unexpected ' + action };
    }
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 760 } });
    await ctx.addInitScript(`(${mock.toString()})();`);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => { errors.push('dialog ' + d.message()); d.dismiss(); });
    await page.goto(URL_, { waitUntil: 'load' });
    const calls = () => page.evaluate(() => window.__calls);
    const lastSet = async () => (await calls()).filter((c) => c.action === 'items.policy.set').pop();
    const overflow = () => page.evaluate(() => document.querySelector('.wb-panel').scrollWidth > window.innerWidth + 1);

    // 1. Direct globally.
    await page.evaluate(() => window.__wsBulk.open('deleting'));
    await page.waitForTimeout(150);
    check('Deleting shows the global default', (await page.inputValue('.wb-global-mode')) === 'timed');
    await page.selectOption('.wb-global-mode', 'direct');
    await page.waitForTimeout(150);
    let ps = await lastSet();
    check('global Direct saved', ps && ps.req.scope === 'global' && ps.req.mode === 'direct' && ps.req.retainSecs === null, JSON.stringify(ps));
    check('retention is off under Direct', await page.isDisabled('.wb-global-retain'));
    check('Deleting layout fits 375 px', !(await overflow()));

    // 2. The chat's own line: 7 days.
    await page.click('[data-wb=go][data-v=items]');
    await page.waitForTimeout(150);
    await page.click('[data-wb=permissions][data-v=c2]');
    await page.waitForTimeout(150);
    check('chat item page has "When I delete from here"', /When I delete from here/.test(await page.textContent('.wb-perms')) && (await page.inputValue('.wb-holder-policy')) === 'inherit');
    await page.selectOption('.wb-holder-policy[data-holder="session:s2"]', String(7 * 86400));
    await page.waitForTimeout(150);
    ps = await lastSet();
    check('chat override saved', ps && ps.req.scope === 'holder:session:s2' && ps.req.mode === 'timed' && ps.req.retainSecs === 7 * 86400, JSON.stringify(ps));
    check('line shows the saved value', (await page.inputValue('.wb-holder-policy')) === String(7 * 86400));
    check('a note item has no holder line', await (async () => {
      await page.click('[data-wb=go][data-v=items]');
      await page.waitForTimeout(100);
      await page.click('[data-wb=permissions][data-v=n1]');
      await page.waitForTimeout(100);
      return (await page.$$('.wb-holder-policy')).length === 0;
    })());
    await page.click('[data-wb=go][data-v=deleting]');
    await page.waitForTimeout(150);
    check('Deleting lists the chat override', /session:s2/.test(await page.textContent('.wb-deleting')) && /Trash, 7 days/.test(await page.textContent('.wb-deleting')));

    // 3. Delete in that chat: to Trash, 7 days out.
    await page.click('[data-wb=go][data-v=items]');
    await page.waitForTimeout(150);
    await page.click('[data-wb=select]');
    await page.check('[data-wb=pick][data-v=n2]');
    await page.click('.wb-bar [data-wb=delete]');
    await page.waitForTimeout(150);
    const due7 = await page.evaluate(() => new Date(window.__NOW + 7 * 86400000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
    let conf = await page.textContent('.wb-confirm');
    check('delete in the chat goes to Trash with the right date', conf.includes(`to Trash, removed ${due7}`) && !/removed permanently/.test(conf), conf);
    check('nothing runs before confirm', !(await calls()).some((c) => c.action === 'items.bulk' && c.req.dryRun === false));
    await page.click('[data-wb=confirm-go]');
    await page.waitForTimeout(150);
    const commit = (await calls()).filter((c) => c.action === 'items.bulk' && c.req.dryRun === false).pop();
    check('confirm commits that item', commit && commit.req.ids.join() === 'n2' && commit.req.op === 'delete', JSON.stringify(commit));

    // 4. Delete elsewhere: permanent, asks first.
    await page.click('[data-wb=select]');
    await page.click('[data-wb=select]');
    await page.check('[data-wb=pick][data-v=n1]');
    await page.click('.wb-bar [data-wb=delete]');
    await page.waitForTimeout(150);
    conf = await page.textContent('.wb-confirm');
    check('delete elsewhere warns it is permanent', /removed permanently/.test(conf) && /Delete 1 \(1 permanently\)/.test(await page.textContent('.wb-confirm [data-wb=confirm-go]')), conf);
    const before = (await calls()).filter((c) => c.action === 'items.bulk' && c.req.dryRun === false).length;
    await page.click('[data-wb=confirm-cancel]');
    await page.waitForTimeout(100);
    check('cancel runs nothing', (await calls()).filter((c) => c.action === 'items.bulk' && c.req.dryRun === false).length === before && (await page.$$('.wb-confirm')).length === 0);

    // 5. Apply to items in Trash: due count first.
    await page.click('[data-wb=go][data-v=deleting]');
    await page.waitForTimeout(150);
    await page.selectOption('.wb-global-mode', 'timed');
    await page.waitForTimeout(150);
    await page.check('.wb-apply-existing');
    await page.selectOption('.wb-global-retain', String(7 * 86400));
    await page.waitForTimeout(150);
    conf = await page.textContent('.wb-confirm');
    check('apply to Trash shows the due count', /1 item in Trash is due and will be removed permanently now/.test(conf) && /Remove 1 now/.test(conf), conf);
    ps = await lastSet();
    check('first request asks without confirm', ps.req.applyToExisting === true && ps.req.confirm === false && ps.req.retainSecs === 7 * 86400, JSON.stringify(ps));
    await page.click('[data-wb=confirm-go]');
    await page.waitForTimeout(150);
    ps = await lastSet();
    check('confirm re-sends with confirm and apply', ps.req.confirm === true && ps.req.applyToExisting === true && ps.req.scope === 'global' && ps.req.mode === 'timed', JSON.stringify(ps));
    check('saved note names the removed count', /1 removed/.test(await page.textContent('.wb-note')), await page.textContent('.wb-panel'));

    // 6. Trash: Restore and Empty Trash.
    await page.click('[data-wb=go][data-v=trash]');
    await page.waitForTimeout(150);
    check('Trash shows the date and until-emptied', /removed /.test(await page.textContent('.wb-trash')) && /until you empty it/.test(await page.textContent('.wb-trash')));
    check('Empty Trash shows the count', /Empty Trash \(2\)/.test(await page.textContent('[data-wb=empty]')));
    await page.click('[data-wb=restore][data-v=t1]');
    await page.waitForTimeout(150);
    check('Restore sent and the row leaves', (await calls()).some((c) => c.action === 'items.restore' && c.req.id === 't1') && (await page.$$('.wb-trash .wb-row')).length === 1 && /Restored/.test(await page.textContent('.wb-note')));
    await page.click('[data-wb=empty]');
    await page.waitForTimeout(150);
    check('Empty Trash sent and Trash is empty', (await calls()).some((c) => c.action === 'items.emptyTrash') && /Trash is empty/.test(await page.textContent('.wb-trash')) && await page.isDisabled('[data-wb=empty]'));

    // 7. Layout.
    check('no horizontal overflow at 375 px', !(await overflow()));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('no exception', false, e && e.stack);
  } finally {
    await browser.close();
  }
  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
