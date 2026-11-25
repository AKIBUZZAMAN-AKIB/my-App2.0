// groups-rules.js (Phase 5 rules editor). Derived from groups.js' mock.
// Groups sheet (59-groups.js), against a mock engine bridge.
//   1. the list says when there are no groups, and lists groups with presence;
//   2. creating needs three agents; the request carries name, preset, members;
//   3. the composer previews who will be woken (from groups.preview);
//   4. "Who was woken?" shows the engine's sentences;
//   5. a confirm step appears above the threshold;
//   6. text is escaped; a 320 px screen has no horizontal overflow.
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
  const groups = [];
  const members = [{ pid: 'user', name: 'You', role: 'owner', membership: 'joined', presence: 'owner' }];
  const msgs = [];
  window.__calls = calls;
  window.__groupsBridge = async (action, req) => {
    calls.push({ action, req });
    const g = groups[0];
    switch (action) {
      case 'groups.list': return { groups };
      // Same chat as the panel (install below): the picker greys out other chats' non-shareable agents (Phase 1).
      case 'list': return { subagents: [{ id: 'a', name: 'researcher', title: 'Researcher', shareable: true, rootSessionKey: 'chat2' }, { id: 'b', name: 'writer', title: '<b>Writer</b>', rootSessionKey: 'chat1' }, { id: 'c', name: 'critic', title: 'Critic', rootSessionKey: 'chat1' }, { id: 'd', name: 'dee', rootSessionKey: 'chat1' }] };
      case 'groups.create': {
        const ng = { id: 'g1', name: req.name, state: 'active', preset: req.preset, presetLabel: 'Social', members: 3, presence: [{ pid: 'agent:a', presence: 'idle' }], unread: 0 };
        groups.push(ng);
        req.members.forEach((id) => members.push({ pid: 'agent:' + id, name: id, role: 'member', membership: 'joined', presence: 'idle', rules: [] }));
        return { group: ng };
      }
      case 'groups.get': return { group: g, members, rules: [{ id: 'r1', scope: 'group', kind: 'respond', params: { mode: 'mention_only' }, enabled: true }], pins: [], tokensToday: 0, silence: null };
      case 'groups.read': return { group: g, messages: msgs };
      case 'groups.read_cursor': return { ok: true };
      case 'groups.preview': {
        const all = /@all/.test(req.text);
        const wake = all ? ['agent:a', 'agent:b', 'agent:c', 'agent:d', 'agent:e'] : /@Writer/i.test(req.text) ? ['agent:b'] : [];
        return { wake: wake.map((pid) => ({ pid, reason: 'mention', estTokens: 4000 })), deliver: [], skip: [], queue: [], coalesce: [], estTokens: wake.length * 4000, names: { 'agent:b': 'Writer' }, needsConfirm: all ? { agents: 5, estTokens: 20000 } : null };
      }
      case 'groups.post': msgs.push({ id: 'm' + (msgs.length + 1), from: 'user', fromName: 'You', text: req.text, kind: 'message', state: 'sent' }); return { message: 'm' + msgs.length };
      case 'groups.dispatch': return { rows: [{ pid: 'agent:b', decision: 'wake', text: 'Writer: woken, you mentioned it' }, { pid: 'agent:c', decision: 'deliver', text: 'Critic: not woken, Wait your turn (2 of 3 unanswered)' }] };
      case 'groups.rules.validate': if (!(req.rules || []).some((r) => r.kind === 'rate' && !(r.params.wakes_per_10min > 0)) && (req.rules || []).some((r) => r.kind === 'unanswered_threshold' && r.scope !== 'group' && r.enabled)) return { ok: true, errors: [], warnings: ['Wait your turn for one member conflicts with respond mention_only for the group: that member is still woken by mentions.'] }; return (req.rules || []).some((r) => r.kind === 'rate' && !(r.params.wakes_per_10min > 0)) ? { ok: false, errors: ['Wake limit must be above 0.'], warnings: [] } : { ok: true, errors: [], warnings: (req.rules || []).length > 2 ? ['3 rules: check the order.'] : [] };
      case 'groups.rules.set': window.__savedRules = req.rules; window.__hist = (window.__hist || []).concat([{ at: Date.UTC(2026, 10, 21), actor: 'user', action: 'rules.set', detail: { rules: req.rules } }]); return { saved: true, validation: { ok: true, errors: [], warnings: [] } };
      case 'groups.rules.history': return { history: [...(window.__hist || []).slice().reverse(), { at: Date.UTC(2026, 10, 20), actor: 'user', action: 'rules.preset', detail: { preset: 'round_table' } }] };
      case 'groups.context.list': return { policy: window.__aiPolicy || 'user', items: [{ id: 'i1', kind: 'note', title: 'Spec', context: { state: 'in', actor: 'agent:b', reason: 'answers the question', locked: !!window.__ctxLock } }] };
      case 'groups.context.set': window.__ctxLock = !!req.lock; return { state: req.state, locked: !!req.lock };
      case 'groups.settings': window.__aiPolicy = req.settings.aiContext; return { group: g, members, rules: [], pins: [] };
      case 'items.policy.get': return { policies: [] };
      default: return { error: 'unexpected ' + action };
    }
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 700 } });
    await ctx.addInitScript(`(${mock.toString()})();`);
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'load' });
    await page.evaluate(() => window.__groups.install({ chat: { mainId: 'chat1' } }));
    await page.evaluate(() => window.__groups.open());

    await page.click('[data-gr=new]');
    await page.waitForTimeout(100);
    await page.fill('.gr-new-name', 'launch');
    for (const id of ['a', 'b', 'c']) await page.click(`[data-gr=pick][data-v=${id}]`);
    await page.click('[data-gr=create]');
    await page.waitForTimeout(150);
    await page.click('[data-gr=tab][data-v=rules]');
    await page.waitForTimeout(200);
    const sheet = await page.textContent('.gr-sheet');
    check('preset picker lists all presets', ['Social', 'Everyone answers', 'Round table', 'Wait your turn', 'Moderated'].every((p) => sheet.includes(p)), sheet.slice(0, 400));
    await page.click('[data-gr=preset][data-v=wait_your_turn]');
    await page.waitForTimeout(200);
    check('switching preset calls the engine', await page.evaluate(() => window.__calls.some((c) => c.action === 'groups.rules.preset' && c.req.preset === 'wait_your_turn')));
    // Member-scoped Wait your turn from the member's row.
    await page.click('[data-gr=tab][data-v=members]').catch(() => {});
    await page.waitForTimeout(100);
    const memberRules = await page.$('[data-gr=member-rules]');
    check('member row has Rules', !!memberRules);
    if (memberRules) { await memberRules.click(); await page.waitForTimeout(200); }
    check('member rules view is scoped', /Rules for /.test(await page.textContent('.gr-sheet')));
    await page.selectOption('[data-gr=rule-add]', 'unanswered_threshold');
    await page.waitForTimeout(450);
    const added = await page.evaluate(() => [...document.querySelectorAll('[data-gr=rule-scope]')].map((s) => s.value));
    check('new rule is scoped to that member', added.some((v) => v.startsWith('agent:')), JSON.stringify(added));
    check('conflict warning shown', /conflicts/.test(await page.textContent('.gr-sheet')));
    check('count choice in plain words', /Count since this member last spoke/.test(await page.textContent('.gr-sheet')));
    await page.click('[data-gr=rule-scope-all]');
    await page.waitForTimeout(50);
    // Invalid value blocks save.
    await page.selectOption('[data-gr=rule-add]', 'rate');
    await page.waitForTimeout(50);
    await page.fill('input[data-gr=rule-param][data-k=wakes_per_10min]', '0');
    await page.waitForTimeout(450);
    check('invalid value shows the error', /Wake limit must be above 0/.test(await page.textContent('.gr-sheet')));
    check('invalid value blocks save', await page.isDisabled('[data-gr=rules-save]'));
    await page.fill('input[data-gr=rule-param][data-k=wakes_per_10min]', '6');
    await page.waitForTimeout(450);
    check('valid again enables save', !(await page.isDisabled('[data-gr=rules-save]')));
    await page.click('[data-gr=rules-save]');
    await page.waitForTimeout(300);
    const saved = await page.evaluate(() => window.__savedRules || []);
    check('saved rules carry the member scope', saved.some((r) => r.kind === 'unanswered_threshold' && r.scope.startsWith('agent:')), JSON.stringify(saved));
    // Test box.
    await page.fill('.gr-test-input', '@Writer draft it');
    await page.waitForTimeout(500);
    const out = await page.textContent('.gr-test-out');
    check('test box shows wake list and estimate', /Wakes (b|Writer)\b/.test(out) && /4000/.test(out), out);
    check('test box does not post', await page.evaluate(() => !window.__calls.some((c) => c.action === 'groups.post')));
    check('history lists the change', /rules saved/.test(await page.textContent('.gr-hist')));
    const overflow = await page.evaluate(() => document.querySelector('.gr-sheet').scrollWidth > window.innerWidth + 1);
    check('no horizontal overflow at 320 px', !overflow);
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
