// Context Policies (59-context-policy.js) and the context card's Policy tab.
//
// What this checks:
//   1. nothing is shown unless the engine advertises "contextPolicy";
//   2. the mode, the pin, the presets, the rules, the active task and the token
//      numbers all come from the engine's policy.get answer;
//   3. the mode buttons and the pin call the engine (ctx.settings / policy.pin);
//   4. the rule builder validates through the engine and only adds a valid rule;
//      the advanced editor cannot save until it validates;
//   5. protected items (system, essentials) cannot be excluded;
//   6. an engine error is shown with a retry;
//   7. text is escaped; a context.policy event updates the live numbers;
//   8. the workspace opens as a labelled modal, Escape closes it, and 320 px
//      has no horizontal overflow;
//   9. an engine/bridge that does not know policy.* (the phone's
//      'load: subagents: unknown action "policy.get"') shows a clear
//      "needs an app update" message, never an endless "Loading…".
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
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + String(extra).slice(0, 400) : ''}`);
  return ok;
};

// A fake engine behind window.__runtime.action, answering policy.* like the bridge.
const ENGINE = `
  window.__sent = [];
  window.__failNext = null;
  window.__state = {
    registry: [
      { id: 'T1', name: 'current_task_only', description: 'Only the running task.', keeps: ['request', 'task results'], drops: ['older turns'], defaults: { recent_turns: 0 } },
      { id: 'T7', name: 'full_context', description: 'Everything, as today.', keeps: ['everything'], drops: [], defaults: {} },
    ],
    rules: { version: 1, rules: [{ id: 'R_DEVICE', enabled: true, priority: 100, if: { all: ['tool.category == "device"'] }, then: { policy: 'T1' } }], exclusions: { always_exclude: { categories: [], groups: [], turn_ids: [], item_ids: [] } } },
    fields: [{ field: 'tool.category', type: 'string', operators: ['==', '!=', 'in'] }, { field: 'request.needs_history', type: 'bool', operators: ['=='] }],
    settings: { policy_mode: 'auto', policy_max_retries: 2, policy_recent_turns: 2 },
    pin: null,
    activeTask: { taskId: 'task-1', policy: 'T1', source: 'ai', status: 'active', retries: 0, escalations: 0, goal: { user_request: 'Turn on the torch <b>now</b>' }, checklist: { items: ['user/newest', 'res/R1'] } },
    recentTasks: [],
    events: [{ seq: 1, taskId: 'task-1', kind: 'step', policy: 'T1', inputTokens: 1200, t7Tokens: 9000, latencyMs: 40 }],
    proposals: [],
  };
  window.__runtime = { action: async (action, p) => {
    window.__sent.push({ action, p });
    if (window.__failNext === action) { window.__failNext = null; return { error: 'disk is full' }; }
    if (window.__noPolicy && action.startsWith('policy.')) throw new Error('subagents: unknown action "' + action + '"');
    const s = window.__state;
    if (action === 'policy.get') return JSON.parse(JSON.stringify(s));
    if (action === 'ctx.settings') { Object.assign(s.settings, p.settings || {}); return { ok: true }; }
    if (action === 'policy.pin') { s.pin = { policy: p.policy, params: {}, at: 1 }; return { ok: true }; }
    if (action === 'policy.unpin') { s.pin = null; return { ok: true }; }
    if (action === 'policy.validate') {
      const bad = (p.rules.rules || []).filter((r) => !r.id || (r.if && JSON.stringify(r.if).includes('nope')));
      return bad.length ? { valid: false, errors: [{ path: 'rules[0].if', message: 'unknown field' }] } : { valid: true, errors: [], rules: (p.rules.rules || []).length };
    }
    if (action === 'policy.save') { s.rules = p.rules; return { saved: true }; }
    if (action === 'policy.preview') return { valid: true, policy: 'T1', policyName: 'current_task_only', source: 'rule', rule: 'R_DEVICE', checklist: { items: ['user/newest'] } };
    return {};
  } };
`;

async function open(browser, { w = 390, feature = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
  await ctx.addInitScript(ENGINE);
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'load' });
  await page.evaluate((on) => { window.__features = on ? ['contextTree', 'contextPolicy'] : ['contextTree']; }, feature);
  return { ctx, page };
}
const settle = (page) => page.waitForTimeout(80);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    {
      const { ctx, page } = await open(browser, { feature: false });
      const r = await page.evaluate(() => ({ html: window.__contextPolicies.render(), tab: window.__contextPolicies.renderTab(), open: window.__contextPolicies.open(), screen: window.__screens.has('contextPolicies') }));
      check('without the contextPolicy feature nothing is shown', r.html === '' && r.tab === '' && r.open === null && r.screen === false, JSON.stringify(r));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser);
      await page.evaluate(() => window.__contextPolicies.open());
      await page.waitForSelector('.cp-dialog .cp-sec');
      await settle(page);
      const r = await page.evaluate(() => {
        const d = document.querySelector('.cp-dialog');
        return {
          labelled: d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true' && !!document.getElementById(d.getAttribute('aria-labelledby')),
          mode: document.querySelector('.cp-seg-btn[aria-checked="true"]')?.dataset.mode,
          presets: [...document.querySelectorAll('.cp-preset')].map((x) => x.dataset.policy),
          t7Locked: document.querySelector('.cp-preset[data-policy="T7"] [data-cp="use"]')?.disabled,
          rules: [...document.querySelectorAll('.cp-rule[data-rule]')].map((x) => x.dataset.rule),
          req: document.querySelector('.cp-req')?.innerHTML || '',
          items: [...document.querySelectorAll('.cp-item')].map((x) => x.textContent),
          stats: document.querySelector('.cp-stats')?.textContent || '',
          screen: window.__screens.has('contextPolicies'),
        };
      });
      check('the workspace is a labelled modal dialog', r.labelled, JSON.stringify(r));
      check('the mode comes from the engine', r.mode === 'auto', r.mode);
      check('presets come from the registry and T7 is locked', r.presets.join() === 'T1,T7' && r.t7Locked === true, JSON.stringify(r));
      check('saved rules are listed', r.rules.join() === 'R_DEVICE', r.rules);
      check('the active task shows its request escaped and its checklist', r.req.includes('&lt;b&gt;now&lt;/b&gt;') && r.items.join() === 'user/newest,res/R1', r.req);
      check('token numbers come from the step event (1,200 of 9,000, 87% saved)', /1,200/.test(r.stats) && /9,000/.test(r.stats) && /87%/.test(r.stats), r.stats);
      check('the screens registry hosts Context Policies', r.screen);

      await page.click('.cp-dialog .cp-seg-btn[data-mode="manual"]');
      await settle(page);
      const m = await page.evaluate(() => ({ sent: window.__sent.find((x) => x.action === 'ctx.settings'), now: document.querySelector('.cp-dialog .cp-seg-btn[aria-checked="true"]')?.dataset.mode }));
      check('a mode button saves policy_mode through ctx.settings', m.sent && m.sent.p.settings.policy_mode === 'manual' && m.now === 'manual', JSON.stringify(m));

      await page.selectOption('.cp-dialog [data-cp-in="pin"]', 'T1');
      await page.click('.cp-dialog [data-cp="pin"]');
      await settle(page);
      const pin = await page.evaluate(() => ({ sent: window.__sent.find((x) => x.action === 'policy.pin'), chip: !!document.querySelector('.cp-dialog .cp-chip-pin'), unpin: !!document.querySelector('.cp-dialog [data-cp="unpin"]') }));
      check('Pin calls policy.pin and the pin is shown', pin.sent && pin.sent.p.policy === 'T1' && pin.chip && pin.unpin, JSON.stringify(pin));

      // Rule builder: an empty id is refused, a valid rule goes into the draft.
      await page.click('.cp-dialog [data-cp="b-add-rule"]');
      await settle(page);
      const noId = await page.evaluate(() => document.querySelector('.cp-builder .cp-bad')?.textContent || '');
      check('the builder refuses a rule without an id', /required/.test(noId), noId);
      await page.fill('.cp-dialog [data-cp-in="b-id"]', 'R_TORCH');
      await page.fill('.cp-dialog [data-cp-in="b-value"]', 'device');
      await page.click('.cp-dialog [data-cp="b-add-rule"]');
      await settle(page);
      const added = await page.evaluate(() => ({ rules: [...document.querySelectorAll('.cp-rule[data-rule]')].map((x) => x.dataset.rule), dirty: !!document.querySelector('.cp-dirty'), validated: window.__sent.filter((x) => x.action === 'policy.validate').length }));
      check('a valid builder rule is validated by the engine and added as an unsaved change', added.rules.includes('R_TORCH') && added.dirty && added.validated >= 1, JSON.stringify(added));
      await page.evaluate(() => { window.confirm = () => true; });
      await page.click('.cp-dialog [data-cp="rules-save"]');
      await settle(page);
      const saved = await page.evaluate(() => ({ s: window.__state.rules.rules.map((r) => r.id), cond: JSON.stringify(window.__state.rules.rules[1] && window.__state.rules.rules[1].if), dirty: !!document.querySelector('.cp-dirty') }));
      check('Save rules writes the whole document through policy.save', saved.s.join() === 'R_DEVICE,R_TORCH' && /tool.category == \\"device\\"/.test(saved.cond) && !saved.dirty, JSON.stringify(saved));

      // Preview
      await page.fill('.cp-dialog [data-cp-in="b-sample"]', 'Turn on the torch');
      await page.click('.cp-dialog [data-cp="b-preview"]');
      await settle(page);
      const pv = await page.evaluate(() => document.querySelector('.cp-preview')?.textContent || '');
      check('Preview shows the engine\'s pick', /T1/.test(pv) && /R_DEVICE/.test(pv), pv);

      // Advanced editor
      await page.evaluate(() => { document.querySelector('.cp-adv').open = true; });
      const disabledFirst = await page.evaluate(() => document.querySelector('[data-cp="json-save"]').disabled);
      await page.fill('.cp-json', '{"version":1,"rules":[{"id":"R_X","if":{"all":["nope == 1"]},"then":{"policy":"T1"}}]}');
      await page.click('[data-cp="json-validate"]');
      await settle(page);
      const adv = await page.evaluate(() => ({ errs: document.querySelector('.cp-errs')?.textContent || '', disabled: document.querySelector('[data-cp="json-save"]').disabled }));
      check('the advanced editor cannot save until it validates, and shows the errors', disabledFirst && adv.disabled && /unknown field/.test(adv.errs), JSON.stringify(adv));

      // Exclusions: protected categories are locked.
      const ex = await page.evaluate(() => ({ sys: document.querySelector('[data-cp-in="ex"][data-id="sys"]')?.disabled, ess: document.querySelector('[data-cp-in="ex"][data-id="ess"]')?.disabled, turns: document.querySelector('[data-cp-in="ex"][data-id="turns"]')?.disabled }));
      check('system and essentials cannot be excluded; others can', ex.sys === true && ex.ess === true && ex.turns === false, JSON.stringify(ex));
      await page.click('[data-cp-in="ex"][data-id="turns"]');
      await settle(page);
      const exd = await page.evaluate(() => !!document.querySelector('.cp-dirty'));
      check('ticking an exclusion is an unsaved change', exd);
      await page.click('[data-cp="rules-revert"]');

      // Live event
      await page.evaluate(() => window.__contextPolicies.onEvent('context.policy', { policy: 'T1', taskId: 'task-1', tokens: 500, t7Tokens: 10000 }));
      await settle(page);
      const live = await page.evaluate(() => document.querySelector('.cp-dialog .cp-stats')?.textContent || '');
      check('a context.policy event updates the numbers (95% saved)', /500/.test(live) && /95%/.test(live), live);
      const junk = await page.evaluate(() => { try { window.__contextPolicies.onEvent('context.policy', null); window.__contextPolicies.onEvent('context.policy', [1]); window.__contextPolicies.onEvent('context.policy', 'x'); return true; } catch (e) { return String(e); } });
      check('junk events never throw', junk === true, junk);

      // Error + retry
      await page.evaluate(() => { window.__failNext = 'policy.get'; return window.__contextPolicies.refresh(); });
      await settle(page);
      const err = await page.evaluate(() => document.querySelector('.cp-dialog .cp-err')?.textContent || '');
      check('an engine error is shown with a retry', /disk is full/.test(err) && /Retry/.test(err), err);
      await page.click('.cp-dialog [data-cp="retry"]');
      await settle(page);
      check('Retry clears the error', await page.evaluate(() => !document.querySelector('.cp-dialog .cp-err')));

      await page.keyboard.press('Escape');
      check('Escape closes the workspace', await page.evaluate(() => !window.__contextPolicies.isOpen()));
      await ctx.close();
    }
    // The context card's Policy tab.
    {
      const { ctx, page } = await open(browser);
      const r = await page.evaluate(async () => {
        window.__contextTree.install({ chat: { mainId: 'chat-a', on() {}, _onEvent() {} } });
        const btn = document.querySelector('.topbar [data-ct-open], .ct-open, .ct-brain');
        window.__contextTree.open(btn || document.body);
        window.__contextTree.setTab('policy');
        await new Promise((res) => setTimeout(res, 120));
        return {
          tabs: [...document.querySelectorAll('.cc-tab')].map((b) => b.dataset.tab),
          tab: window.__contextTree.tab(),
          mode: !!document.querySelector('.cc-body .cp-seg'),
          openBtn: !!document.querySelector('.cc-body [data-cp="open"]'),
          key: window.__sent.find((x) => x.action === 'policy.get')?.p?.sessionKey,
        };
      });
      check('the context card has a Policy tab with the mode and an Open button', r.tabs.includes('policy') && r.tab === 'policy' && r.mode && r.openBtn, JSON.stringify(r));
      check('policy.get is asked for the open chat', r.key === 'chat-a', r.key);
      await ctx.close();
    }
    // An engine (or bridge) without policy.*: a clear message, no endless Loading.
    {
      const { ctx, page } = await open(browser);
      await page.evaluate(() => { window.__noPolicy = true; });
      const r = await page.evaluate(async () => {
        window.__contextTree.install({ chat: { mainId: 'chat-a', on() {}, _onEvent() {} } });
        const btn = document.querySelector('.topbar [data-ct-open], .ct-open, .ct-brain');
        window.__contextTree.open(btn || document.body);
        window.__contextTree.setTab('policy');
        await new Promise((res) => setTimeout(res, 150));
        const body = document.querySelector('.cc-body');
        return {
          text: body ? body.textContent : '',
          unsupported: !!document.querySelector('.cc-body [data-cp-unsupported]'),
          flag: window.__contextPolicies.unsupported(),
        };
      });
      check('an engine without policy.* shows "needs an app update", not Loading…',
        r.unsupported && r.flag === true && /app update/i.test(r.text) && !/Loading…/.test(r.text), JSON.stringify(r));
      // Once the engine answers, the tab works again.
      const back = await page.evaluate(async () => {
        window.__noPolicy = false;
        await window.__contextPolicies.refresh();
        await new Promise((res) => setTimeout(res, 80));
        return { flag: window.__contextPolicies.unsupported(), mode: !!document.querySelector('.cc-body .cp-seg') };
      });
      check('after an engine update the Policy tab loads normally', back.flag === false && back.mode, JSON.stringify(back));
      await ctx.close();
    }
    // Small screens.    // Small screens.
    for (const w of [320, 768]) {
      const { ctx, page } = await open(browser, { w });
      await page.evaluate(() => window.__contextPolicies.open());
      await page.waitForSelector('.cp-dialog .cp-sec');
      await settle(page);
      const lay = await page.evaluate(() => {
        const d = document.querySelector('.cp-dialog');
        const b = d.querySelector('.cp-dialog-body');
        const r = d.getBoundingClientRect();
        return { inside: r.left >= 0 && r.right <= window.innerWidth + 0.5, noX: b.scrollWidth <= b.clientWidth + 1, docX: document.documentElement.scrollWidth <= window.innerWidth + 1 };
      });
      check(`${w}px: the workspace fits with no horizontal overflow`, lay.inside && lay.noX && lay.docX, JSON.stringify(lay));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => r.startsWith('FAIL'));
  for (const r of results) console.log(r);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('context-policy suite crashed:', e);
  process.exit(1);
});
