// Context tree panel (58-context-tree.js): the checklist the model is given, shown
// to the person using the app, plus the one thing the model cannot see — why an
// item left the window.
//
// What this checks, in the order it matters:
//   1. the panel does not exist unless the engine advertises "contextTree";
//   2. every row comes from an event or a tool result — nothing is invented, and an
//      empty state says so instead of showing a blank box;
//   3. the five symbols mean exactly what the engine's states mean;
//   4. "why did this leave" is rendered from the reason, in words;
//   5. item text is escaped: an item title is data, never markup;
//   6. junk payloads never throw and never blank the panel;
//   7. the checklist: unticking asks the engine (ctx.set), a refusal is said;
//      a chat summary is listed as an item;
//   8. the panel is a sheet that opens from the composer chip, sits above the
//      message box (not in the message list), scrolls inside, closes on Escape,
//      and a 320 px screen has no horizontal overflow.
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

async function open(browser, { w = 390, feature = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
  await ctx.addInitScript(`window.__CT_FEATURE = ${feature ? 'true' : 'false'};`);
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'load' });
  // The engine normally publishes its feature list; the panel reads that list, so
  // the test publishes it the same way before installing.
  await page.evaluate((on) => {
    if (on) window.__features = ['contextTree'];
    try { window.__contextTree.install(null); } catch (e) { /* install is defensive by design */ }
  }, feature);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    // ------------------------------------------------ every stored chat
    // The checklist is grouped by conversation: each stored chat is a row with its
    // name, opens into its own turns / tool calls / range summaries (read with
    // its own sessionKey), its items toggle in that chat's tree, and its button
    // opens the chat.
    {
      const { ctx, page } = await open(browser, { feature: true });
      const r = await page.evaluate(async () => {
        const CT = window.__contextTree;
        const sent = [];
        let switched = null;
        const msgs = (n) => Array.from({ length: n }, (_, i) => [{ role: 'user', content: [{ type: 'text', text: `q${i + 1}` }] }, { role: 'assistant', content: [{ type: 'text', text: `a${i + 1}` }] }]).flat();
        const chat = {
          mainId: 'chat-a',
          mainItem: { title: 'Alpha' },
          main: { messages: msgs(1) },
          runtimes: new Map([['chat-b', { messages: msgs(2) }]]),
          threads: (st) => (st === 'regular' ? [{ id: 'chat-a', title: 'Alpha', lastMessageAt: 2 }, { id: 'chat-b', title: 'Beta', lastMessageAt: 1 }, { id: 'subagent:x', title: 'sub' }] : []),
          switchToThread: (k) => { switched = k; },
          on() {},
          _onEvent() {},
        };
        const treeB = { counts: { in: 2, out: 0 }, tokens: { selected: 300, window: 128000 }, items: [
          { id: 'turn/t1', state: 'in', title: 'q1', tokens: 100 },
          { id: 'turn/t2', state: 'in', title: 'q2', tokens: 100 },
          { id: 'turn/t2/call/1', kind: 'turnPart', state: 'in', title: 'search', tokens: 100 },
        ] };
        window.__runtime = { action: async (name, payload) => {
          sent.push({ name, key: payload && payload.sessionKey, ops: payload && payload.ops });
          if (name === 'ctx.tree') return payload && payload.sessionKey === 'chat-b' ? treeB : { items: [{ id: 'turn/t1', state: 'in', title: 'q1', tokens: 50 }] };
          if (name === 'ctx.settings') return { settings: { enabled: true } };
          return {};
        } };
        CT.install({ chat });
        CT.onEvent('context.tree', { counts: { in: 1, out: 0 }, tokens: { selected: 50, window: 128000 }, items: [{ id: 'turn/t1', state: 'in', title: 'q1', tokens: 50 }] });
        CT.open(null, 'items');
        await new Promise((res) => setTimeout(res, 80));
        const root = document.querySelector('.cc-card') || document.querySelector('.ct-panel');
        const rows = [...root.querySelectorAll('[data-conv]')].map((e) => e.dataset.conv);
        const curOpen = !!root.querySelector('[data-conv="chat-a"] .cc-kids [data-turn], [data-conv="chat-a"] .cc-kids .ct-item');
        // Reading a closed chat starts from its twisty.
        const tw = root.querySelector('[data-tw="conv/chat-b"]');
        if (tw) tw.click();
        await new Promise((res) => setTimeout(res, 150));
        const asked = sent.filter((x) => x.name === 'ctx.tree' && x.key === 'chat-b').length;
        const bRows = root.querySelectorAll('[data-conv="chat-b"] .ct-check').length;
        const box = root.querySelector('[data-conv="chat-b"] .ct-check[data-key="chat-b"]');
        if (box) { box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); }
        await new Promise((res) => setTimeout(res, 80));
        const setB = sent.find((x) => x.name === 'ctx.set');
        const openBtn = root.querySelector('[data-open-conv="chat-b"]');
        if (openBtn) openBtn.click();
        return { rows, curOpen, asked, bRows, setKey: setB && setB.key, setOps: setB && setB.ops, switched, here: !!root.querySelector('[data-conv="chat-a"] .cc-here') };
      });
      check('each stored chat is a row, sub-agents left out, open chat first', JSON.stringify(r.rows) === '["chat-a","chat-b"]', JSON.stringify(r));
      check('the open chat is marked and expanded with its turns', r.here && r.curOpen, JSON.stringify(r));
      check('opening another chat reads its own tree', r.asked >= 1, JSON.stringify(r));
      check('another chat shows its turns and tool calls with boxes', r.bRows >= 2, JSON.stringify(r));
      check("a box in another chat changes that chat's tree", r.setKey === 'chat-b' && Array.isArray(r.setOps) && r.setOps[0].action === 'exclude', JSON.stringify(r));
      check('the open button switches to that chat', r.switched === 'chat-b', JSON.stringify(r));
      await ctx.close();
    }

    // ------------------------------------------------------- the switch
    {
      const { ctx, page } = await open(browser, { feature: true });
      // Off: the panel must say so, not show an empty tree that looks broken.
      const off = await page.evaluate(() => {
        window.__contextTree.applySettings({ enabled: false });
        const body = document.querySelector('.ct-panel .ct-body');
        return {
          text: body ? body.textContent : '',
          items: document.querySelectorAll('.ct-item').length,
          button: !!document.querySelector('.ct-on'),
        };
      });
      check('off says off in words', /\boff\b/i.test(off.text), off.text.slice(0, 80));
      check('off shows no items', off.items === 0, off.items);
      check('off offers the button that turns it on', off.button);

      // On: the engine's answer is what is shown, and the tree comes back.
      const on = await page.evaluate(async () => {
        let asked = null;
        window.__runtime = {
          action: async (name, payload) => {
            // The panel reads the tree back after a switch; the first call is the switch.
            if (!asked) asked = { name, payload };
            if (name === 'ctx.tree') return {};
            return { settings: { enabled: true, thresholdPercent: 70 }, saved: true };
          },
        };
        window.__contextTree.onEvent('context.tree', { counts: { in: 2, out: 1 }, tokens: { selected: 900, window: 128000 }, items: [{ id: 'turn/t1', state: 'in', title: 'hello', tokens: 400 }] });
        document.querySelector('.ct-on').click();
        await new Promise((r) => setTimeout(r, 60));
        const root = document.querySelector('.ct-panel .ct-body');
        return {
          asked,
          enabled: window.__contextTree.settings().enabled,
          threshold: window.__contextTree.settings().thresholdPercent,
          stillOff: !!document.querySelector('.ct-on'),
          items: document.querySelectorAll('.ct-item').length,
          head: root ? root.textContent.slice(0, 60) : '',
        };
      });
      check('the button asks the engine, not the panel', on.asked && on.asked.name === 'ctx.settings' && on.asked.payload.settings.enabled === true, JSON.stringify(on.asked));
      check('the panel shows the stored answer', on.enabled === true && on.threshold === 70, JSON.stringify(on));
      check('the off card is gone once it is on', on.stillOff === false);
      check('the tree is back after turning it on', on.items > 0, on.items);

      // A `ctx` answer that carries settings moves the panel too.
      const viaResult = await page.evaluate(() => {
        const took = window.__contextTree.onToolResult('ctx', { settings: { enabled: false } });
        const text = document.querySelector('.ct-panel .ct-body').textContent;
        return { took, off: !!document.querySelector('.ct-on'), text: text.slice(0, 40) };
      });
      check('a ctx answer with settings turns the panel off', viaResult.took === true && viaResult.off === true, JSON.stringify(viaResult));

      // Junk is ignored, never applied.
      const junk = await page.evaluate(() => {
        window.__contextTree.applySettings({ enabled: true });
        const before = window.__contextTree.settings().enabled;
        const took = window.__contextTree.applySettings({ enabled: 'yes' });
        return { before, took, after: window.__contextTree.settings().enabled };
      });
      check('a junk switch value is ignored', junk.took === false && junk.before === true && junk.after === true, JSON.stringify(junk));
      await ctx.close();
    }

    // ------------------------------------------- a failing engine is said, not hidden
    // The bug users hit: the bridge rejected 'ctx.settings', the read failed in
    // silence and the panel showed an empty tree with only an "Off" button, so the
    // tree could never be turned on. A failure must be shown with a retry, and the
    // "Turn it on" button must still be offered.
    {
      const { ctx, page } = await open(browser, { feature: true });
      const r = await page.evaluate(async () => {
        let fail = true;
        let stored = false;
        window.NativeKit = { agent: { subagents: async (req) => {
          if (fail) throw new Error('subagents: unknown action "' + req.action + '"');
          if (req.action === 'ctx.settings') {
            if (req.settings && typeof req.settings.enabled === 'boolean') stored = req.settings.enabled;
            return { settings: { enabled: stored, thresholdPercent: 70 }, saved: !!req.settings };
          }
          return { items: [], counts: { in: 0, note: 0, out: 0 } };
        } } };
        window.__contextTree.install({ chat: { mainId: 'chat-a', _onEvent: () => {}, on() {} } });
        const toggle = document.querySelector('.ct-toggle');
        if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
        await new Promise((res) => setTimeout(res, 80));
        const body = document.querySelector('.ct-body');
        const html1 = body ? body.innerHTML : '';
        const alert = !!(body && body.querySelector('.ct-error[role="alert"]'));
        const hasOn = !!(body && body.querySelector('.ct-on'));
        fail = false;
        const res = await window.__contextTree.setEnabled(true);
        await new Promise((r2) => setTimeout(r2, 80));
        const html2 = body ? body.innerHTML : '';
        return { html1, alert, hasOn, res, err: window.__contextTree.error(), on: window.__contextTree.settings(), html2 };
      });
      check('a failed read is shown in the panel as an alert', r.alert && /unknown action/.test(r.html1), r.html1);
      check('a failed read still offers "Turn it on"', r.hasOn, r.html1);
      check('turning on after the failure works and clears the error', r.res.enabled === true && r.on && r.on.enabled === true && r.err === null && !/ct-error/.test(r.html2), JSON.stringify({ res: r.res, err: r.err, on: r.on, html2: r.html2.slice(0, 300) }));
      await ctx.close();
    }

    // ------------------------------------------- the real bridge and events
    // In the app the engine answers through nativeKit().agent.subagents and its
    // events arrive on app.chat._onEvent with the name in `eventType`. This drives
    // that exact shape: the switch must reach the engine, the panel must load the
    // tree with `ctx.tree`, and an event for another chat must not overwrite it.
    {
      const { ctx, page } = await open(browser, { feature: true });
      const r = await page.evaluate(async () => {
        const calls = [];
        const tree = {
          sessionKey: 'chat-a', enabled: true, rev: 4, stage: 'compact',
          counts: { in: 1, note: 0, out: 1, temp: 0 },
          tokens: { window: 128000, selected: 500, sent: 500, selectable: 90000 },
          items: [
            { id: 'turn/t1', title: 'old turn', state: 'out', pin: 'none', tokens: 1200, kind: 'turn' },
            { id: 'turn/t2', title: 'new turn', state: 'in', pin: 'none', tokens: 500, kind: 'turn' },
          ],
          log: [{ actor: 'policy', reason: 'budget', ops: JSON.stringify([{ id: 'turn/t1', action: 'out' }]), tokensBefore: 1700, tokensAfter: 500 }],
        };
        window.NativeKit = { agent: { subagents: async (req) => {
          calls.push(req);
          if (req.action === 'ctx.tree') return { resultJson: JSON.stringify(tree) };
          if (req.action === 'ctx.settings') return { resultJson: JSON.stringify({ settings: { enabled: req.settings ? req.settings.enabled : true, thresholdPercent: 70 } }) };
          return { resultJson: '{}' };
        } } };
        const handled = [];
        const fakeApp = { chat: { mainId: 'chat-a', _onEvent: (e) => { handled.push(e.eventType); return 'base'; }, on() {} } };
        window.__contextTree.install(fakeApp);
        await new Promise((res) => setTimeout(res, 80));
        const loaded = window.__contextTree.state().items.length;
        const ret = fakeApp.chat._onEvent({ eventType: 'context.tree', payloadJson: JSON.stringify({ ...tree, sessionKey: 'chat-b', items: [] }) });
        const afterOther = window.__contextTree.state().items.length;
        fakeApp.chat._onEvent({ eventType: 'context.tree', payloadJson: JSON.stringify({ ...tree, items: [tree.items[1]] }) });
        const afterOwn = window.__contextTree.state().items.length;
        calls.length = 0;
        await window.__contextTree.setEnabled(false);
        await new Promise((res) => setTimeout(res, 50));
        return { loaded, afterOther, afterOwn, ret, handled, calls };
      });
      check('the panel loads the tree from the engine (ctx.tree)', r.loaded === 2, JSON.stringify(r));
      check('an event for another chat does not overwrite the panel', r.afterOther === 2, r.afterOther);
      check('an eventType event for this chat updates the panel', r.afterOwn === 1, r.afterOwn);
      check('events still reach the app', r.ret === 'base' && r.handled.length === 2, JSON.stringify(r.handled));
      const sw = r.calls.find((c) => c.action === 'ctx.settings' && c.settings);
      check('the switch reaches the engine through agent.subagents', !!sw && sw.settings.enabled === false && sw.sessionKey === 'chat-a', JSON.stringify(r.calls));
      await ctx.close();
    }

    // ---------------------------------------------------------------- gating
    {
      const { ctx, page } = await open(browser, { feature: false });
      const exists = await page.evaluate(() => typeof window.__contextTree === 'object');
      check('module is loaded even when the feature is off', exists);
      const panels = await page.evaluate(() => document.querySelectorAll('.ct-panel').length);
      check('no panel is mounted while the engine does not advertise the feature', panels === 0, panels);
      const safe = await page.evaluate(() => {
        try { window.__contextTree.onEvent('context.tree', { counts: { in: 1 } }); return true; } catch (e) { return String(e); }
      });
      check('an event with the feature off does not throw', safe === true, safe);
      await ctx.close();
    }

    // ---------------------------------------------------------------- content
    const { ctx, page } = await open(browser, { w: 390 });
    const state = await page.evaluate(() => {
      const CT = window.__contextTree;
      CT.onEvent('context.tree', {
        rev: 12,
        model: 'gpt-x',
        stage: 'compact',
        counts: { in: 3, note: 1, temp: 1, out: 40 },
        tokens: { sent: 4200, selectable: 9000, free: 4800 },
        items: [
          { id: 'sys/core', title: 'Rules', state: 'in', pin: 'locked', tokens: 800, cat: 'sys' },
          { id: 'turn/t9', title: 'the build failed', state: 'in', pin: 'none', tokens: 1200, cat: 'turns' },
          { id: 'turn/t8', title: 'gradle setup', state: 'note', pin: 'ai', tokens: 900, cat: 'turns' },
          { id: 'tmp/s1', title: 'summary of 1-7', state: 'temp', pin: 'ai', tokens: 200, cat: 'turns' },
          { id: 'turn/t2', title: 'old turn', state: 'out', pin: 'none', tokens: 700, cat: 'turns' },
        ],
        log: [
          { actor: 'policy', at: Date.now(), ops: '[{"id":"turn/t2","action":"exclude"}]', reason: 'budget', tokensBefore: 4900, tokensAfter: 4200 },
          { actor: 'model', at: Date.now(), ops: '[{"id":"sys/core","action":"exclude","ok":false}]', reason: null },
        ],
      });
      // The card's tabs: the checklist (rules group opened), the log, settings.
      CT.expand('grp/rules');
      CT.setTab('items');
      const items = CT.render();
      CT.setTab('log');
      const log = CT.render();
      CT.setTab('settings');
      const settings = CT.render();
      CT.setTab('items');
      return { html: items + log + settings, items, log, settings, state: CT.state() };
    });
    const html = state.html;
    check('the checklist head shows the model, the counts and the tokens', /gpt-x/.test(state.items) && /4\.2k/.test(state.items) && /3 in · 40 out/.test(state.items), state.items.slice(0, 400));
    check('token use is one coloured bar in the checklist, not a separate view', /data-slot="context-meter"/.test(state.items) && /cc-seg cc-g-rules/.test(state.items) && /cc-seg cc-g-turns/.test(state.items), state.items.slice(0, 600));
    check('the locked rules row uses the lock symbol', /⚿/.test(state.items) && /Rules/.test(state.items));
    check('in / note / temp / out each mark their row', ['in', 'note', 'temp', 'out'].every((st) => state.items.includes('ct-state-' + st)), state.items.slice(0, 400));
    check('the card has no introduction text, only (i) buttons', !/Nothing is deleted/.test(state.items) && /class="cc-i"/.test(state.items), state.items.slice(0, 400));
    check('a compacted window explains itself', /least valuable items were taken out/i.test(html), html.slice(0, 300));
    check('why an item left is rendered in words', /over its budget/i.test(html), html.slice(0, 600));
    check('an actor is named, not a code', /Engine policy/.test(html));
    check('tokens before and after are shown for the log row', /4\.9k → 4\.2k tokens/.test(html), html.slice(0, 800));
    check('a refused op is marked as refused', /refused/.test(html));
    const tipText = await page.evaluate(() => { const b = document.querySelector('.ct-panel .cc-i[data-info="items"], .ct-panel .cc-i'); if (!b) return ''; b.click(); return document.querySelector('.ct-panel .cc-tip')?.textContent || ''; });
    check('an (i) button explains on tap', /nothing is deleted|tokens/i.test(tipText), tipText);
    check('state is folded, not replaced, by a second partial event', state.state.rev === 12);

    // ---------------------------------------------------------------- reset tree
    check('the Settings tab offers the Reset tree button', /class="ct-reset-btn/.test(state.settings) && /Reset tree/.test(state.settings), state.settings.slice(-400));
    const reset = await page.evaluate(async () => {
      const calls = [];
      window.__runtime = {
        action: async (name, payload) => {
          calls.push(name);
          if (name === 'ctx.reset') return { reset: true, removed: { nodes: 5, notes: 1 } };
          return {};
        },
      };
      // Cancelled: nothing is asked of the engine.
      window.confirm = () => false;
      const cancelled = await window.__contextTree.resetTree();
      const afterCancel = calls.slice();
      // Confirmed: the engine resets and the panel empties.
      window.confirm = () => true;
      const done = await window.__contextTree.resetTree();
      await new Promise((r) => setTimeout(r, 30));
      const html = window.__contextTree.render();
      return { cancelled, afterCancel, done, calls, items: window.__contextTree.state().items.length, html };
    });
    check('a cancelled reset asks nothing of the engine', reset.cancelled.cancelled === true && reset.afterCancel.length === 0, JSON.stringify(reset.afterCancel));
    check('a confirmed reset calls ctx.reset', reset.done.reset === true && reset.calls[0] === 'ctx.reset', JSON.stringify(reset.calls));
    check('after a reset the panel shows no items and says what went', reset.items === 0 && /5 items and 1 notes removed/.test(reset.html), reset.html.slice(-500));
    await page.evaluate(() => {
      window.__runtime = { action: async () => ({}) };
      window.__contextTree.onEvent('context.tree', {
        rev: 12, model: 'gpt-x', stage: 'compact', counts: { in: 3, note: 1, temp: 1, out: 40 }, tokens: { sent: 4200, selectable: 9000, free: 4800 },
        items: [{ id: 'turn/t9', title: 'the build failed', state: 'in', pin: 'none', tokens: 1200, cat: 'turns' }],
      });
    });

    // ---------------------------------------------------------------- escaping
    const hostile = await page.evaluate(() => {
      const CT = window.__contextTree;
      CT.onEvent('context.tree', { items: [{ id: 'turn/t1', title: '<img src=x onerror="window.__pwned=1">', state: 'in', tokens: 10, cat: 'turns' }] });
      const host = document.createElement('div');
      host.innerHTML = CT.render();
      document.body.appendChild(host);
      return {
        pwned: window.__pwned === 1,
        imgTags: host.querySelectorAll('img').length,
        text: host.textContent.includes('<img src=x'),
      };
    });
    check('an item title cannot inject markup', hostile.pwned === false && hostile.imgTags === 0 && hostile.text === true, JSON.stringify(hostile));

    // ---------------------------------------------------------------- robustness
    const junk = await page.evaluate(() => {
      const CT = window.__contextTree;
      const before = CT.render().length;
      const tries = [
        () => CT.onEvent('context.tree', 'not json at all'),
        () => CT.onEvent('context.tree', null),
        () => CT.onEvent('context.tree', { items: 'nope', counts: 5, log: 7 }),
        () => CT.onEvent('context.unknown', { x: 1 }),
        () => CT.onToolResult('ctx', 'garbage'),
        () => CT.onToolResult('read_file', { rev: 9 }),
        () => CT.onToolResult('ctx', { rev: 13, counts: { in: 1, out: 0 } }),
      ];
      let threw = null;
      for (const fn of tries) { try { fn(); } catch (e) { threw = String(e); } }
      return { threw, after: CT.render().length, rev: CT.state().rev, before };
    });
    check('junk events never throw', junk.threw === null, junk.threw);
    check('a junk event does not blank the panel', junk.after > 40, junk.after);
    check('a ctx tool result updates the revision the panel shows', junk.rev === 13, junk.rev);

    // ------------------------------------------------------- the checklist
    // Unticking an item asks the engine (`ctx.set`, actor user); the state shown is
    // the engine's, and a refusal is said and undone.
    const list = await page.evaluate(async () => {
      const CT = window.__contextTree;
      const sent = [];
      window.__runtime = {
        action: async (name, payload) => {
          sent.push({ name, payload });
          if (name === 'ctx.set') {
            const op = payload.ops[0];
            if (op.id === 'turn/t2') return { ok: false, results: [{ id: op.id, ok: false, message: 'turn/t2 is locked' }] };
            return { ok: true, results: [{ id: op.id, ok: true, state: op.action === 'exclude' ? 'out' : 'in' }] };
          }
          if (name === 'ctx.tree') return {};
          return { settings: { enabled: true, thresholdPercent: 70 } };
        },
      };
      CT.applySettings({ enabled: true });
      CT.onEvent('context.tree', { rev: 20, items: [
        { id: 'sum/1-4', kind: 'summary', title: 'Summary of turns 1-4', state: 'in', pin: 'policy', tokens: 300, parent: 'turns' },
        { id: 'turn/t5', kind: 'turn', title: 'the build failed', state: 'in', pin: 'none', tokens: 1200, parent: 'turns' },
        { id: 'turn/t2', kind: 'turn', title: 'locked one', state: 'in', pin: 'none', tokens: 100, parent: 'turns' },
      ] });
      const boxes = [...document.querySelectorAll('.ct-panel .ct-check')].map((b) => b.dataset.id);
      const summaryRow = document.querySelector('.ct-panel .ct-kind-summary');
      const ok = await CT.setItem('turn/t5', false);
      const t5 = CT.state().items.find((x) => x.id === 'turn/t5').state;
      const refused = await CT.setItem('turn/t2', false);
      const err = (document.querySelector('.ct-panel .ct-error') || {}).textContent || '';
      const t2 = CT.state().items.find((x) => x.id === 'turn/t2').state;
      return { boxes, summary: summaryRow ? summaryRow.textContent : '', ok, t5, refused, err, t2, sent: sent.filter((x) => x.name === 'ctx.set') };
    });
    check('the summary is listed as an item of the window', /Summary of turns 1-4/.test(list.summary), list.summary);
    check('the engine-pinned summary has no checkbox; turns do', !list.boxes.includes('sum/1-4') && list.boxes.includes('turn/t5'), JSON.stringify(list.boxes));
    check('unticking asks the engine with ctx.set exclude', list.ok === true && list.sent[0] && list.sent[0].payload.ops[0].action === 'exclude' && list.t5 === 'out', JSON.stringify(list));
    check('a refused change is said and the item keeps its state', list.refused === false && /locked/.test(list.err) && list.t2 === 'in', JSON.stringify(list));

    // ---------------------------------------------------------------- layout
    // The context card belongs to the composer: it opens beside the message box
    // from the token chip / Context chip, never in the message list, and never
    // goes outside the screen.
    for (const w of [320, 375]) {
      await page.setViewportSize({ width: w, height: 700 });
      const layout = await page.evaluate(() => {
        const CT = window.__contextTree;
        CT.close();
        const toggle = document.querySelector('.aui-composer-root .ct-toggle, .aui-composer-root [data-slot="token-meter"]:not([hidden])');
        if (toggle) toggle.click(); else CT.open();
        const root = document.querySelector('.ct-panel');
        if (!root) return { mounted: false };
        const r = root.getBoundingClientRect();
        // The card is fixed on the page beside the composer (never inside the
        // message list) and opens on the side with more room.
        const shell = document.querySelector('.aui-composer-root .aui-composer-shell');
        const input = shell && shell.querySelector('.aui-composer-input');
        const sr = shell ? shell.getBoundingClientRect() : null;
        const tabs = root.querySelector('[role="tablist"]');
        const body = root.querySelector('.ct-body');
        const out = {
          mounted: true,
          viaChip: !!toggle,
          open: CT.isOpen() && !root.hidden,
          inComposer: root.dataset.place === 'composer' && getComputedStyle(root).position === 'fixed' && !!sr,
          inMessages: !!root.closest('.aui-message-root, .aui-thread-messages, [data-role="message"], .aui-thread-viewport'),
          side: root.dataset.side,
          clearOfInput: input ? (root.dataset.side === 'below' ? r.top >= input.getBoundingClientRect().bottom - 1 : r.bottom <= input.getBoundingClientRect().top + 1) : null,
          onScreen: r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
          titleVisible: !!tabs && tabs.getBoundingClientRect().height > 0 && tabs.querySelectorAll('[role="tab"]').length >= 3,
          bodyScrolls: body ? getComputedStyle(body).overflowY : '',
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide: [...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth || e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible'&&e.getBoundingClientRect().right>innerWidth-30).slice(0,6).map(e=>e.tagName+'.'+String(e.className).slice(0,40)+':'+Math.round(e.getBoundingClientRect().right)),
          itemsVisible: root.querySelectorAll('.ct-item').length,
          dialog: root.getAttribute('role') === 'dialog' && !!(root.getAttribute('aria-labelledby') || root.getAttribute('aria-label')),
        };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        out.escCloses = !CT.isOpen() && root.hidden;
        return out;
      });
      check(`${w}px: the panel opens from the composer chip`, layout.mounted && layout.viaChip && layout.open, JSON.stringify(layout));
      check(`${w}px: it sits with the composer, not in the message list`, layout.inComposer && !layout.inMessages && layout.clearOfInput !== false, JSON.stringify(layout));
      check(`${w}px: it is fully on screen with its tabs visible`, layout.onScreen && layout.titleVisible, JSON.stringify(layout));
      check(`${w}px: the list scrolls inside the sheet`, layout.bodyScrolls === 'auto', layout.bodyScrolls);
      check(`${w}px: no horizontal overflow`, (layout.overflow ?? 0) <= 1, JSON.stringify([layout.overflow, layout.wide]));
      check(`${w}px: rows are rendered`, (layout.itemsVisible ?? 0) > 0, layout.itemsVisible);
      check(`${w}px: it is a labelled dialog and Escape closes it`, layout.dialog && layout.escCloses, JSON.stringify(layout));
    }
    await ctx.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r.startsWith('FAIL'));
  for (const r of results) console.log(r);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('context-tree suite crashed:', e);
  process.exit(1);
});
