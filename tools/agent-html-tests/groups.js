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
  window.__agents = [
    { id: 'a', name: 'researcher', title: 'Researcher', shareable: true, rootSessionKey: 'chat2' },
    { id: 'b', name: 'writer', title: '<b>Writer</b>', rootSessionKey: 'chat1' },
    { id: 'c', name: 'critic', title: 'Critic', rootSessionKey: 'chat1' },
    { id: 'd', name: 'dee', rootSessionKey: 'chat2' },
    { id: 'e', name: 'editor', title: 'Editor', rootSessionKey: 'chat1' },
  ];
  window.__groupsBridge = async (action, req) => {
    calls.push({ action, req });
    const g = groups[0];
    switch (action) {
      case 'groups.list': return { groups };
      case 'list': return { subagents: window.__agents };
      case 'configure': {
        const a = window.__agents.find((x) => x.id === req.id);
        if (a && req.shareable != null) a.shareable = !!req.shareable;
        return a ? { subagent: a } : { error: 'No sub-agent with id ' + req.id + '.' };
      }
      case 'groups.create': {
        // As the real engine (ws/groups.rs create): without a home every
        // member is "cross-chat", and a non-shareable one is refused.
        const roots = req.members.map((id) => (window.__agents.find((x) => x.id === id) || {}).rootSessionKey);
        const home = req.homeRoot || (roots.every((r) => r && r === roots[0]) ? roots[0] : null);
        for (const id of req.members) {
          const a = window.__agents.find((x) => x.id === id);
          if (!a) return { error: id + ' cannot join: the agent was deleted.' };
          if ((!home || a.rootSessionKey !== home) && !a.shareable) return { error: (a.title || a.name) + ' cannot join: from another chat and not shareable.' };
        }
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
      case 'groups.rules.validate': return (req.rules || []).some((r) => r.kind === 'rate' && !(r.params.wakes_per_10min > 0)) ? { ok: false, errors: ['Wake limit must be above 0.'], warnings: [] } : { ok: true, errors: [], warnings: (req.rules || []).length > 2 ? ['3 rules: check the order.'] : [] };
      case 'groups.rules.set': window.__savedRules = req.rules; return { saved: true, validation: { ok: true, errors: [], warnings: [] } };
      case 'groups.rules.history': return { history: [{ at: Date.UTC(2026, 10, 20), actor: 'user', action: 'rules.preset', detail: { preset: 'round_table' } }] };
      case 'groups.context.list': return { policy: window.__aiPolicy || 'user', items: [{ id: 'i1', kind: 'note', title: 'Spec', context: { state: 'in', actor: 'agent:b', reason: 'answers the question', locked: !!window.__ctxLock } }] };
      case 'groups.context.set': window.__ctxLock = !!req.lock; return { state: req.state, locked: !!req.lock };
      case 'groups.settings': window.__aiPolicy = req.settings.aiContext; return { group: g, members, rules: [], pins: [] };
      case 'items.policy.get': return { policies: [] };
      case 'groups.modes': return { enabled: true, modes: [{ name: 'social', title: 'Open room', description: 'Members answer when it makes sense.', rules: 'social', playbook: null }, { name: 'vote', title: 'Vote', description: 'Every member casts one ballot.', rules: 'everyone', playbook: 'vote' }, { name: 'market', title: '<i>Market</i>', description: 'Members bid.', rules: 'everyone', playbook: 'auction' }] };
      case 'groups.playbook': {
        if (req.op === 'start') { window.__pb = { id: 'pb1', kind: req.kind, state: 'running', status: '0 of 3 ballots in.', next: [{ pid: 'agent:a' }, { pid: 'agent:b' }] }; return { playbook: window.__pb }; }
        if (req.op === 'cancel') { window.__pb = null; return { cancelled: 'pb1' }; }
        return { active: window.__pb || null, recent: [] };
      }
      case 'groups.rules.preset': window.__preset = req.preset; return { group: g, members, rules: [], pins: [] };
      case 'groups.notes': return { members: [{ pid: 'agent:b', name: '<i>Writer</i>', left: false, notes: [{ id: 'n1', key: 'plan', text: 'deploy on friday', updatedAt: 1 }] }] };
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
    await page.waitForTimeout(100);
    check('empty list says so', /No groups yet/.test(await page.textContent('.gr-sheet')));

    await page.click('[data-gr=new]');
    await page.waitForTimeout(100);
    check('agent title is escaped', (await page.innerHTML('.gr-sheet')).includes('&lt;b&gt;Writer&lt;/b&gt;'));
    check('create disabled under three', await page.isDisabled('[data-gr=create]'));
    const order = await page.evaluate(() => [...document.querySelectorAll('.gr-sheet [data-agent]')].map((e) => e.getAttribute('data-agent')).join());
    check("this chat's agents listed first", order === 'b,c,e,a,d', order);
    check('cross-chat non-shareable agent cannot be picked', !(await page.$('[data-gr=pick][data-v=d]')) && /from another chat and not shareable/.test(await page.textContent('[data-agent=d]')));
    const listReq = await page.evaluate(() => window.__calls.find((c) => c.action === 'list'));
    check('agent list is not limited to this chat', listReq && listReq.req.parentSessionKey == null, JSON.stringify(listReq));
    await page.click('[data-gr=make-shareable][data-v=d]');
    await page.waitForTimeout(100);
    const conf = await page.evaluate(() => window.__calls.find((c) => c.action === 'configure'));
    check('Make shareable uses the team setting', conf && conf.req.id === 'd' && conf.req.shareable === true, JSON.stringify(conf));
    check('shared agent can be picked', !!(await page.$('[data-gr=pick][data-v=d]')));
    await page.fill('.gr-new-name', 'launch');
    for (const id of ['a', 'b', 'c']) await page.click(`[data-gr=pick][data-v=${id}]`);
    check('create enabled at three', !(await page.isDisabled('[data-gr=create]')));
    await page.click('input[name=gr-preset][value=round_table]');
    await page.click('[data-gr=create]');
    await page.waitForTimeout(150);
    const create = await page.evaluate(() => window.__calls.find((c) => c.action === 'groups.create'));
    check('create request carries fields', create && create.req.name === 'launch' && create.req.preset === 'round_table' && create.req.members.join() === 'a,b,c', JSON.stringify(create));
    check('create request carries this chat as homeRoot', create && create.req.homeRoot === 'chat1' && create.req.parentSessionKey === 'chat1', JSON.stringify(create));
    check('group opened', /#launch/.test(await page.textContent('.gr-head')));

    await page.fill('.gr-input', '@Writer draft it');
    await page.waitForTimeout(400);
    check('preview names who is woken', /Will wake: Writer/.test(await page.textContent('.gr-preview-slot')), await page.textContent('.gr-preview-slot'));
    await page.click('[data-gr=send]');
    await page.waitForTimeout(200);
    check('posted message shown', /draft it/.test(await page.textContent('.gr-body')));
    await page.click('[data-gr=why]');
    await page.waitForTimeout(100);
    check('why shows engine sentences', /Wait your turn \(2 of 3 unanswered\)/.test(await page.textContent('.gr-why')));
    await page.click('[data-gr=why-close]');

    await page.fill('.gr-input', '@all ideas?');
    await page.waitForTimeout(400);
    await page.click('[data-gr=send]');
    await page.waitForTimeout(100);
    check('confirm above threshold', /wakes 5 agents/.test(await page.textContent('.gr-sheet')));
    const posts = await page.evaluate(() => window.__calls.filter((c) => c.action === 'groups.post').length);
    check('nothing posted before confirm', posts === 1, posts);
    await page.click('[data-gr=send-anyway]');
    await page.waitForTimeout(200);
    check('posted after confirm', (await page.evaluate(() => window.__calls.filter((c) => c.action === 'groups.post').length)) === 2);

    await page.click('[data-gr=tab][data-v=rules]');
    await page.waitForTimeout(50);
    check('rules tab lists presets and rules', /Round table/.test(await page.textContent('.gr-sheet')) && /respond/.test(await page.textContent('.gr-sheet')));
    // Rules editor (Phase 5).
    await page.waitForTimeout(150);
    check('rules history shown', /preset round_table/.test(await page.textContent('.gr-hist')));
    check('shared context shows the AI reason', /AI set it: answers the question/.test(await page.textContent('.gr-ai')));
    await page.selectOption('[data-gr=rule-add]', 'rate');
    await page.waitForTimeout(50);
    check('added rule has plain controls', (await page.$$('input[data-gr=rule-param][data-k=wakes_per_10min]')).length === 1);
    await page.fill('input[data-gr=rule-param][data-k=wakes_per_10min]', '0');
    await page.waitForTimeout(400);
    check('live validation shows the error', /Wake limit must be above 0/.test(await page.textContent('.gr-sheet')));
    check('save disabled while invalid', await page.isDisabled('[data-gr=rules-save]'));
    await page.fill('input[data-gr=rule-param][data-k=wakes_per_10min]', '6');
    await page.waitForTimeout(400);
    check('save enabled when valid', !(await page.isDisabled('[data-gr=rules-save]')));
    await page.click('[data-gr=rule-up][data-i="1"]');
    await page.waitForTimeout(50);
    await page.click('[data-gr=rules-save]');
    await page.waitForTimeout(200);
    const saved = await page.evaluate(() => window.__savedRules);
    check('reorder and params are saved', saved && saved[0].kind === 'rate' && saved[0].params.wakes_per_10min === 6 && saved[1].kind === 'respond', JSON.stringify(saved));
    await page.fill('.gr-test-input', '@Writer draft it');
    await page.waitForTimeout(500);
    check('test box shows the previewed dispatch', /Wakes (b|Writer)\b/.test(await page.textContent('.gr-test-out')) && /8000|4000/.test(await page.textContent('.gr-test-out')), await page.textContent('.gr-test'));
    await page.selectOption('[data-gr=ai-context]', 'model');
    await page.waitForTimeout(200);
    check('AI context setting saved', (await page.evaluate(() => window.__calls.some((c) => c.action === 'groups.settings' && c.req.settings.aiContext === 'model'))));
    await page.check('[data-gr=ctx-lock][data-v=i1]');
    await page.waitForTimeout(150);
    check('user lock sent', await page.evaluate(() => window.__calls.some((c) => c.action === 'groups.context.set' && c.req.lock === true && c.req.itemId === 'i1')));
    // Members' notes (plan.md 3.6): each member's group notes, escaped.
    await page.click('[data-gr=tab][data-v=members]');
    await page.waitForTimeout(150);
    check('members tab asks for notes', await page.evaluate(() => window.__calls.some((c) => c.action === 'groups.notes')));
    check('members notes shown', /Members\u2019 notes/.test(await page.textContent('.gr-body')) && /1 note/.test(await page.textContent('.gr-notes summary')), await page.textContent('.gr-body'));
    await page.click('.gr-notes summary');
    check('note text shown', /deploy on friday/.test(await page.textContent('.gr-notes')));
    check('note member name escaped', (await page.innerHTML('.gr-notes')).includes('&lt;i&gt;Writer&lt;/i&gt;'));
    // Mode tab (unified plan, Phase 5): one catalog, start and cancel a playbook.
    await page.click('[data-gr=tab][data-v=mode]');
    await page.waitForTimeout(150);
    check('mode tab lists the catalog', /Open room/.test(await page.textContent('.gr-body')) && /Vote/.test(await page.textContent('.gr-body')), await page.textContent('.gr-body'));
    check('mode title escaped', (await page.innerHTML('.gr-body')).includes('&lt;i&gt;Market&lt;/i&gt;'));
    check('no playbook running says so', /No playbook running/.test(await page.textContent('.gr-body')));
    await page.click('[data-gr=pb-start][data-v=vote]');
    await page.waitForTimeout(150);
    const pbStart = await page.evaluate(() => window.__calls.find((c) => c.action === 'groups.playbook' && c.req.op === 'start'));
    check('start sends the playbook kind', pbStart && pbStart.req.kind === 'vote' && pbStart.req.group === 'g1' && pbStart.req.options.length === 2, JSON.stringify(pbStart));
    check('running playbook shown with who is next', /Running: vote/.test(await page.textContent('.gr-body')) && /Next: agent:a, agent:b/.test(await page.textContent('.gr-body')), await page.textContent('.gr-body'));
    check('other protocols disabled while one runs', await page.isDisabled('[data-gr=pb-start][data-v=market]'));
    await page.click('[data-gr=pb-cancel]');
    await page.waitForTimeout(150);
    check('cancel clears the running playbook', /No playbook running/.test(await page.textContent('.gr-body')));
    await page.click('[data-gr=pb-start][data-v=social]');
    await page.waitForTimeout(150);
    check('a room mode sets the wake-rule preset', await page.evaluate(() => window.__preset === 'social'));
    const overflow = await page.evaluate(() => document.querySelector('.gr-sheet').scrollWidth > window.innerWidth + 1);
    check('no horizontal overflow at 320 px', !overflow);
    await page.keyboard.press('Escape');
    check('Escape closes', await page.evaluate(() => document.querySelector('.gr-sheet').hidden));
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
