// Workspace bulk actions (65-workspace-bulk.js), against a mock engine bridge.
//   1. Select adds checkboxes; the action bar counts the selection;
//   2. Delete always shows the engine's dry run first (Trash with its date,
//      permanent, detached) and runs nothing until confirmed;
//   3. a blocked dry run offers no confirm button;
//   4. the per-action override re-runs the dry run with that policy;
//   5. the target picker has Sub-agents / Groups / Sessions; sessions multi-select;
//      share sends targets, mode, permission;
//   6. permissions editor: holders with mode/perm, Revoke, main memory's
//      implicit read-only rows and pin status, history;
//   7. Trash: removal date or "until you empty it", Restore, Empty Trash (count), filters;
//   8. Deleting settings: global mode, per-kind override, "When I delete from here";
//   9. text is escaped; 320 px has no horizontal overflow; Escape closes.
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
  const DAY = 86400000;
  const items = {
    memory: [{ id: 'm1', kind: 'memory_longterm', title: 'Prefers metric', owner: 'agent:main', state: 'live' }],
    notes: [{ id: 'n1', kind: 'note', title: '<img src=x onerror=alert(1)>', owner: 'session:s1', state: 'live' }, { id: 'n2', kind: 'note', title: 'Shared spec', owner: 'session:s1', state: 'live' }],
    files: [{ id: 'f1', kind: 'file', title: 'plan.md', owner: 'session:s1', state: 'live' }, { id: 'v1', kind: 'file', title: 'view-only.txt', owner: 'agent:z', state: 'live', ref: { perm: 'view' } }],
  };
  let policies = [{ scope: 'global', mode: 'timed', retainSecs: 30 * 86400 }];
  let trash = [{ id: 't1', kind: 'note', title: 'Old note', owner: 'session:s1', restoreOwner: 'session:s1', purgeAfter: Date.now() + 3 * DAY }, { id: 't2', kind: 'file', title: 'keep.txt', owner: 'agent:a', restoreOwner: 'agent:a', purgeAfter: null }];
  const dry = (req) => {
    const results = [];
    const blocked = [];
    for (const id of req.ids) {
      if (id === 'v1') { blocked.push({ id, title: 'view-only.txt', reason: req.op === 'delete' ? "can't be deleted because you only have view" : "can't be moved because you only have view" }); continue; }
      if (req.op === 'delete') {
        if (id === 'n2') results.push({ id, title: 'Shared spec', action: 'detach' });
        else if (req.policy && req.policy.mode === 'direct') results.push({ id, title: id, action: 'delete', permanent: true });
        else if (id === 'f1') results.push({ id, title: 'plan.md', action: 'delete', permanent: true });
        else results.push({ id, title: id, action: 'delete', trash: true, purgeAfter: req.policy && req.policy.retainSecs === null ? null : Date.UTC(2030, 0, 15, 12) });
      } else results.push({ id, title: id, action: req.op, as: 'owner' });
    }
    const perm = results.filter((r) => r.permanent).length;
    const trashed = results.filter((r) => r.trash).length;
    const det = results.filter((r) => r.action === 'detach').length;
    const parts = [];
    if (det) parts.push(`${det} shared item will be detached (kept for its other holders)`);
    if (trashed) parts.push(`${trashed} trashed`);
    if (perm) parts.push(`${perm} removed permanently`);
    let summary = parts.join(', ');
    if (blocked.length) summary += `${summary ? '; ' : ''}1 item can't be ${req.op === 'delete' ? 'deleted' : 'moved'}: ${blocked[0].reason}`;
    return { dryRun: !!req.dryRun, ok: !blocked.length, op: req.op, count: req.ids.length, summary, counts: { permanent: perm, trashed, detached: det }, results, blocked };
  };
  window.__wsBulkBridge = async (action, req) => {
    calls.push({ action, req: JSON.parse(JSON.stringify(req)) });
    switch (action) {
      case 'items.tree': return { sections: items };
      case 'items.bulk': return dry(req);
      case 'principals.list': return { principals: [{ pid: 'agent:a', name: 'Researcher' }, { pid: 'agent:b', name: 'Writer' }, { pid: 'group:g1', name: '#launch' }, { pid: 'session:s2', name: 'Trip' }, { pid: 'session:s3', name: 'Budget' }, { pid: 'agent:main', name: 'Main' }] };
      case 'items.holders': return req.itemId === 'm1'
        ? { refs: [{ id: 'r0', holder: 'agent:main', holderName: 'Main', mode: 'owner', perm: 'manage', state: 'live' }, { id: 'r1', holder: 'group:g1', holderName: '#launch', mode: 'mount', perm: 'use', state: 'live' }], pinned: true, implicit: [{ holder: 'agent:a', holderName: 'Researcher', perm: 'view', via: 'memory mode: Shared', implicit: true }] }
        : { refs: [] };
      case 'items.audit': return { rows: [{ at: Date.UTC(2026, 10, 20), actor: 'user', action: 'share', holder: 'group:g1' }] };
      case 'items.read': return req.id === 'm1' ? { id: 'm1', content: { text: 'Prefers metric <units>' } } : { text: '' };
      case 'items.edit': return req.text.length > 20000 ? { error: 'too long' } : { id: req.id, edited: true };
      case 'items.revoke': case 'items.setPerm': case 'items.setMode': return { ok: true };
      case 'items.trashList': return { items: trash };
      case 'items.restore': trash = trash.filter((t) => t.id !== req.id); return { ok: true };
      case 'items.purge': trash = trash.filter((t) => t.id !== req.id); return { ok: true };
      case 'items.emptyTrash': trash = []; return { purged: 2 };
      case 'items.policy.get': return { policies };
      case 'items.policy.set': policies = policies.filter((p) => p.scope !== req.scope).concat([{ scope: req.scope, mode: req.mode, retainSecs: req.retainSecs }]); return { policy: { scope: req.scope, mode: req.mode, retainSecs: req.retainSecs }, moved: 0, purged: 0 };
      case 'items.policy.clear': policies = policies.filter((p) => p.scope !== req.scope); return { ok: true };
      case 'items.contextUse.set': return { holder: req.holder, items: req.ids.map((id) => ({ itemId: id, state: req.state })) };
      default: return { error: 'unexpected ' + action };
    }
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 760 } });
    await ctx.addInitScript(`(${mock.toString()})();`);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => { errors.push('dialog ' + d.message()); d.dismiss(); });
    await page.goto(URL_, { waitUntil: 'load' });
    await page.evaluate(() => window.__wsBulk.open('items'));
    await page.waitForTimeout(150);
    const calls = () => page.evaluate(() => window.__calls);
    check('items listed by section', (await page.$$('.wb-row[data-item-id]')).length === 5 && /Memory/.test(await page.textContent('.wb-panel')));
    check('title is escaped', (await page.innerHTML('.wb-panel')).includes('&lt;img src=x'));
    check('no checkboxes before Select', (await page.$$('[data-wb=pick]')).length === 0);
    await page.click('[data-wb=select]');
    check('Select adds a checkbox to every row', (await page.$$('[data-wb=pick]')).length === 5);
    check('action bar shows', /0 selected/.test(await page.textContent('.wb-bar')) && await page.isDisabled('.wb-bar [data-wb=delete]'));
    for (const id of ['n1', 'n2', 'f1']) await page.check(`[data-wb=pick][data-v=${id}]`);
    check('bar counts the selection', /3 selected/.test(await page.textContent('.wb-bar')));
    const bar = await page.textContent('.wb-bar');
    check('bar has every action', ['Move to', 'Share with', 'Remove', 'Delete', 'Permissions', 'Use in context'].every((w) => bar.includes(w)), bar);

    await page.click('.wb-bar [data-wb=delete]');
    await page.waitForTimeout(150);
    let cs = await calls();
    const bulk = cs.filter((c) => c.action === 'items.bulk');
    check('delete runs a dry run first', bulk.length === 1 && bulk[0].req.dryRun === true && bulk[0].req.op === 'delete' && bulk[0].req.ids.join() === 'n1,n2,f1', JSON.stringify(bulk));
    const sheet = await page.textContent('.wb-confirm');
    check('dry run shows summary', /1 shared item will be detached/.test(sheet) && /1 trashed/.test(sheet) && /1 removed permanently/.test(sheet), sheet);
    check('dry run shows Trash with its date', /to Trash, removed .*2030/.test(sheet), sheet);
    check('dry run shows permanent and detach', /removed permanently/.test(sheet) && /detached: kept for the holders/.test(sheet));
    check('confirm names the permanent count', /Delete 3 \(1 permanently\)/.test(await page.textContent('.wb-confirm [data-wb=confirm-go]')));
    await page.selectOption('.wb-override', 'forever');
    await page.waitForTimeout(150);
    cs = await calls();
    const ov = cs.filter((c) => c.action === 'items.bulk').pop();
    check('override re-runs the dry run with it', ov.req.dryRun === true && ov.req.policy && ov.req.policy.mode === 'timed' && ov.req.policy.retainSecs === null, JSON.stringify(ov));
    check('override shown in the preview', /until you empty it/.test(await page.textContent('.wb-confirm')));
    await page.click('[data-wb=confirm-go]');
    await page.waitForTimeout(150);
    cs = await calls();
    const commit = cs.filter((c) => c.action === 'items.bulk').pop();
    check('confirm commits the same request', commit.req.dryRun === false && commit.req.policy && commit.req.policy.retainSecs === null && commit.req.ids.join() === 'n1,n2,f1', JSON.stringify(commit));

    // Blocked: a view-only item.
    await page.click('[data-wb=select]');
    await page.click('[data-wb=select]');
    await page.check('[data-wb=pick][data-v=n1]');
    await page.check('[data-wb=pick][data-v=v1]');
    await page.click('.wb-bar [data-wb=delete]');
    await page.waitForTimeout(150);
    check('blocked dry run names the item', /you only have view/.test(await page.textContent('.wb-confirm')));
    check('blocked dry run has no confirm', (await page.$$('.wb-confirm [data-wb=confirm-go]')).length === 0);
    const commits = (await calls()).filter((c) => c.action === 'items.bulk' && c.req.dryRun === false).length;
    check('nothing committed while blocked', commits === 1, commits);
    await page.click('[data-wb=confirm-cancel]');

    // Share via the picker: sessions multi-select.
    await page.uncheck('[data-wb=pick][data-v=v1]');
    await page.click('.wb-bar [data-wb=share]');
    await page.waitForTimeout(150);
    const tabs = await page.textContent('.wb-sheet .wb-nav');
    check('picker has three tabs', /Sub-agents/.test(tabs) && /Groups/.test(tabs) && /Sessions/.test(tabs), tabs);
    check('picker hides the main agent', !/Main/.test(await page.textContent('.wb-targets')));
    await page.click('.wb-sheet [data-wb=tab][data-v=sessions]');
    await page.check('[data-wb=target][data-v="session:s2"]');
    await page.check('[data-wb=target][data-v="session:s3"]');
    check('sessions multi-select', (await page.$$('[data-wb=target]:checked')).length === 2);
    await page.selectOption('.wb-perm-sel', 'use');
    await page.selectOption('.wb-mode-sel', 'mount');
    await page.click('[data-wb=picker-go]');
    await page.waitForTimeout(150);
    const sh = (await calls()).filter((c) => c.action === 'items.bulk').pop();
    check('share previews with targets, mode, perm', sh.req.op === 'share' && sh.req.dryRun === true && sh.req.targets.join() === 'session:s2,session:s3' && sh.req.perm === 'use' && sh.req.mode === 'mount', JSON.stringify(sh));
    await page.click('[data-wb=confirm-go]');
    await page.waitForTimeout(150);
    check('share committed', (await calls()).filter((c) => c.action === 'items.bulk').pop().req.dryRun === false);

    // Use in context.
    await page.check('[data-wb=pick][data-v=n1]').catch(() => {});
    await page.click('.wb-bar [data-wb=context]');
    await page.waitForTimeout(150);
    await page.check('[data-wb=target][data-v="group:g1"]');
    await page.selectOption('.wb-ctx-sel', 'out');
    await page.click('[data-wb=picker-go]');
    await page.waitForTimeout(150);
    const cu = (await calls()).filter((c) => c.action === 'items.contextUse.set').pop();
    check('use in context sets the holder state', cu && cu.req.holder === 'group:g1' && cu.req.state === 'out' && cu.req.ids.includes('n1'), JSON.stringify(cu));

    // Permissions for main memory.
    await page.click('[data-wb=permissions][data-v=m1]');
    await page.waitForTimeout(150);
    const perms = await page.textContent('.wb-perms');
    check('permissions shows owner and holders', /Owner: Main/.test(perms) && /#launch/.test(perms), perms);
    check('main memory shows implicit read-only rows', /Researcher/.test(perms) && /memory mode: Shared \(read-only\)/.test(perms), perms);
    check('main memory shows pin status', /Protected from automatic removal/.test(perms));
    check('history from the audit log', /share/.test(await page.textContent('.wb-hist')));
    await page.selectOption('.wb-ref-perm[data-ref=r1]', 'edit');
    await page.waitForTimeout(100);
    await page.click('[data-wb=revoke][data-v=r1]');
    await page.waitForTimeout(100);
    cs = await calls();
    check('perm change and revoke sent', cs.some((c) => c.action === 'items.setPerm' && c.req.refId === 'r1' && c.req.perm === 'edit') && cs.some((c) => c.action === 'items.revoke' && c.req.refId === 'r1'));

    // Edit in place (items.edit): one copy, seen by every holder.
    check('editable item offers Edit text', (await page.$$('[data-wb=edit][data-v=m1]')).length === 1);
    await page.click('[data-wb=edit][data-v=m1]');
    await page.waitForTimeout(150);
    check('edit box holds the current text', (await page.inputValue('.wb-edit-text')) === 'Prefers metric <units>');
    await page.fill('.wb-edit-text', '   ');
    await page.click('[data-wb=edit-save]');
    await page.waitForTimeout(100);
    check('empty text is refused before sending', /The text is empty/.test(await page.textContent('.wb-err')) && !(await calls()).some((c) => c.action === 'items.edit'));
    await page.fill('.wb-edit-text', 'Prefers metric units');
    await page.click('[data-wb=edit-save]');
    await page.waitForTimeout(150);
    const ed = (await calls()).filter((c) => c.action === 'items.edit').pop();
    check('edit sends id and new text', ed && ed.req.id === 'm1' && ed.req.text === 'Prefers metric units' && ed.req.via === 'workspace', JSON.stringify(ed));
    check('edit closes and says saved', (await page.$$('.wb-edit-text')).length === 0 && /Saved/.test(await page.textContent('.wb-note')));
    await page.click('[data-wb=go][data-v=items]');
    await page.waitForTimeout(150);
    await page.click('[data-wb=permissions][data-v=v1]');
    await page.waitForTimeout(150);
    check('view-only item has no Edit text', (await page.$$('[data-wb=edit]')).length === 0);

    // Trash.
    await page.click('[data-wb=go][data-v=trash]');
    await page.waitForTimeout(150);
    const tr = await page.textContent('.wb-trash');
    check('Trash shows removal date and until-emptied', /removed /.test(tr) && /until you empty it/.test(tr), tr);
    check('Empty Trash shows the count', /Empty Trash \(2\)/.test(await page.textContent('[data-wb=empty]')));
    await page.selectOption('.wb-trash-kind', 'file');
    check('kind filter', (await page.$$('.wb-trash .wb-row')).length === 1);
    await page.selectOption('.wb-trash-kind', '');
    await page.selectOption('.wb-trash-origin', 'agent:a');
    check('origin filter', (await page.$$('.wb-trash .wb-row')).length === 1);
    await page.selectOption('.wb-trash-origin', '');
    await page.click('[data-wb=restore][data-v=t1]');
    await page.waitForTimeout(150);
    check('restore removes it from Trash', (await page.$$('.wb-trash .wb-row')).length === 1 && (await calls()).some((c) => c.action === 'items.restore' && c.req.id === 't1'));
    await page.click('[data-wb=empty]');
    await page.waitForTimeout(150);
    check('Empty Trash empties it', /Trash is empty/.test(await page.textContent('.wb-trash')));

    // Deleting settings.
    await page.click('[data-wb=go][data-v=deleting]');
    await page.waitForTimeout(150);
    check('global policy shown', (await page.inputValue('.wb-global-mode')) === 'timed' && (await page.inputValue('.wb-global-retain')) === String(30 * 86400));
    await page.selectOption('.wb-kind-policy[data-kind=file]', 'direct');
    await page.waitForTimeout(150);
    let ps = (await calls()).filter((c) => c.action === 'items.policy.set').pop();
    check('per-kind override saved', ps && ps.req.scope === 'kind:file' && ps.req.mode === 'direct', JSON.stringify(ps));
    await page.selectOption('.wb-global-mode', 'direct');
    await page.waitForTimeout(150);
    ps = (await calls()).filter((c) => c.action === 'items.policy.set').pop();
    check('global Direct saved', ps.req.scope === 'global' && ps.req.mode === 'direct' && ps.req.retainSecs === null, JSON.stringify(ps));
    const line = await page.evaluate(() => window.__wsBulk.deleteLineHtml('session:s1', [{ scope: 'holder:session:s1', mode: 'timed', retainSecs: 7 * 86400 }]));
    check('"When I delete from here" line', /When I delete from here/.test(line) && /value="604800" selected/.test(line), line);

    const overflow = await page.evaluate(() => document.querySelector('.wb-panel').scrollWidth > window.innerWidth + 1);
    check('no horizontal overflow at 320 px', !overflow);
    await page.focus('[data-wb=close]');
    await page.keyboard.press('Escape');
    check('Escape closes', await page.evaluate(() => document.querySelector('.wb-panel').hidden));
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
