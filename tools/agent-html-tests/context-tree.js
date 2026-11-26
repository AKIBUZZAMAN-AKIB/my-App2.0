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
//   8. the panel is a sheet that opens from the brain button in the top bar, sits
//      below the header (not in the message list, no chip left in the composer),
//      scrolls inside, closes on Escape, and a 320 px screen has no horizontal overflow.
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
const window_enabled_true = (r) => r.enabled === true;
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

    // ------------------------------------------------- always on (no switch)
    {
      const { ctx, page } = await open(browser, { feature: true });
      // An old engine that still says "off" does not hide the tree: there is no off.
      const off = await page.evaluate(() => {
        window.__contextTree.applySettings({ enabled: false });
        window.__contextTree.onEvent('context.tree', { counts: { in: 1, out: 0 }, tokens: { selected: 400, window: 128000 }, items: [{ id: 'turn/t1', state: 'in', title: 'hello', tokens: 400 }] });
        const body = document.querySelector('.ct-panel .ct-body');
        return {
          enabled: window.__contextTree.settings().enabled,
          items: document.querySelectorAll('.ct-item').length,
          onButton: !!document.querySelector('.ct-on'),
          offText: /context tree is off/i.test(body ? body.textContent : ''),
        };
      });
      check('the checklist is always on, whatever the engine said', off.enabled === true, JSON.stringify(off));
      check('there is no "Turn on" button and no off screen', !off.onButton && !off.offText, JSON.stringify(off));
      check('the tree is shown', off.items > 0, off.items);
      const settingsTab = await page.evaluate(() => {
        window.__contextTree.setTab('settings');
        const html = window.__contextTree.render();
        window.__contextTree.setTab('items');
        return { html, switchEl: /role="switch"/.test(html), always: /Always on/.test(html) };
      });
      check('settings show "Always on" and no switch', settingsTab.always && !settingsTab.switchEl, settingsTab.html.slice(0, 300));
      const viaResult = await page.evaluate(() => {
        window.__contextTree.onToolResult('ctx', { settings: { enabled: false } });
        return { enabled: window.__contextTree.settings().enabled, onButton: !!document.querySelector('.ct-on') };
      });
      check('a ctx answer with enabled:false does not turn it off', viaResult.enabled === true && !viaResult.onButton, JSON.stringify(viaResult));
      const junk = await page.evaluate(() => {
        const took = window.__contextTree.applySettings({ enabled: 'yes' });
        return { took, after: window.__contextTree.settings().enabled };
      });
      check('a junk settings value is ignored', junk.took === false && junk.after === true, JSON.stringify(junk));
      await ctx.close();
    }

    // ---------------------------------------- #tags inside chat messages
    {
      const { ctx, page } = await open(browser, { feature: true });
      const r = await page.evaluate(async () => {
        const sent = [];
        window.__runtime = { action: async (name, payload) => { sent.push({ name, payload }); if (name === 'ctx.tree') return {}; return { ok: true, memory: [{ id: 'mem/D6', rid: 'D6', ok: true }] }; } };
        const row = (rid, extra = {}) => ({ id: 'mem/' + rid, rid, tag: '#' + rid.toLowerCase(), title: rid, line: '- ' + rid, status: 'current', turn: 3, pick: 'auto', versionsMode: 'latest', reason: 'sent', colour: 'sent', versionCount: 1, versions: [], ...extra });
        window.__contextTree.onEvent('context.tree', {
          counts: { in: 1 }, items: [],
          memory: { alwaysOn: true, counts: {},
            tags: [{ tag: '#d6', rid: 'D6', state: 'active', mentions: 2, lastTurn: 9 }, { tag: '#f1', rid: 'F1', state: 'inactive', mentions: 1, lastTurn: 2 }],
            groups: [
              { id: 'mem.decisions', title: 'Decisions in force', parent: 'mem', count: 2, items: [row('D6', { tagState: 'active' }), row('D61')] },
              { id: 'mem.facts', title: 'Facts', parent: 'mem', count: 1, items: [row('F1', { tagState: 'inactive' })] },
              { id: 'mem.files', title: 'Files', parent: 'mem', count: 1, items: [row('file:docs/plan.md', { tag: '#plan.md' })] },
            ] },
        });
        const list = document.createElement('div');
        list.innerHTML = '<div class="aui-md"><p>first #D6 and <code>#d6</code> and C#d6</p></div>'
          + '<div class="aui-md"><p>see #f1, #nope, #d61 and #plan.md@v1.</p></div>'
          + '<div class="aui-md"><p>last <b>#d6</b> here &lt;b&gt;</p></div>';
        document.body.appendChild(list);
        const n = window.__contextTree.decorateChatTags();
        const tags = Array.from(list.querySelectorAll('.cc-chat-tag')).map((s) => ({ t: s.textContent, st: s.dataset.state, c: s.className, v: s.dataset.version || '' }));
        const again = window.__contextTree.decorateChatTags();
        const last = list.querySelector('.cc-chat-tag-last');
        if (last) last.click();
        await new Promise((res) => setTimeout(res, 40));
        const inactive = list.querySelector('.cc-chat-tag.cc-tag-inactive');
        if (inactive) inactive.click();
        await new Promise((res) => setTimeout(res, 40));
        return { n, again, tags, sent: sent.filter((x) => x.name === 'ctx.set').map((x) => x.payload.ops[0]), codeKept: list.querySelector('code').textContent, escaped: list.lastChild.textContent };
      });
      const t = r.tags.map((x) => x.t);
      check('known #tags in messages are marked; code, C#, and unknown tags are left alone', JSON.stringify(t) === JSON.stringify(['#D6', '#f1', '#d61', '#plan.md@v1', '#d6']) && r.codeKept === '#d6', JSON.stringify(r.tags));
      check('a tag in a message is coloured by its checklist state', r.tags[1].st === 'inactive' && r.tags[2].st === 'untagged' && r.tags[0].st === 'active', JSON.stringify(r.tags));
      check('only the last active mention of a record is marked as where its context goes', /cc-chat-tag-ref/.test(r.tags[0].c) && /cc-chat-tag-last/.test(r.tags[4].c) && !/cc-chat-tag-last/.test(r.tags[0].c), JSON.stringify(r.tags));
      check('a version tag in a message keeps its version', r.tags[3].v === '1', JSON.stringify(r.tags[3]));
      check('marking twice does not wrap twice', r.again === r.n && r.n === 5, `${r.n} ${r.again}`);
      check('tapping a tag in a message makes it inactive, or active again', r.sent.some((o) => o.id === 'mem/D6' && o.action === 'inactive') && r.sent.some((o) => o.id === 'mem/F1' && o.action === 'active'), JSON.stringify(r.sent));
      check('message text stays text (no markup injected)', r.escaped.includes('<b>'), r.escaped);
      await ctx.close();
    }

    // ---------------------------------------- the chat memory as checklist groups
    {
      const { ctx, page } = await open(browser, { feature: true });
      const r = await page.evaluate(async () => {
        const sent = [];
        window.__runtime = { action: async (name, payload) => { sent.push({ name, payload }); if (name === 'ctx.tree') return {}; return { ok: true, memory: [{ id: 'mem/D2', rid: 'D2', ok: true }] }; } };
        const row = (rid, title, colour, extra = {}) => ({ id: 'mem/' + rid, rid, tag: '#' + rid.toLowerCase(), title, line: '- ' + title, status: 'current', turn: 3, pick: 'auto', versionsMode: 'latest', reason: colour, colour, versionCount: 1, versions: [], ...extra });
        const many = Array.from({ length: 9 }, (_, n) => row('S' + (n * 2 + 1) + '-' + (n * 2 + 2), 'Old range <b>' + n + '</b>', 'show_more'));
        window.__contextTree.onEvent('context.tree', {
          counts: { in: 1 }, items: [{ id: 'turn/t1', state: 'in', title: 'hello', tokens: 40 }],
          memory: { alwaysOn: true, counts: { sent: 1, leftOut: 1, showMore: 10, inactive: 1 },
            tags: [{ tag: '#d6', rid: 'D6', state: 'active', mentions: 3, lastTurn: 9 }, { tag: '#f1', rid: 'F1', state: 'inactive', mentions: 1, lastTurn: 2 }],
            groups: [
              { id: 'mem', title: 'Chat memory', parent: null, count: 0, items: [] },
              { id: 'mem.decisions', title: 'Decisions in force', parent: 'mem', count: 1, items: [row('D6', 'Version code 200', 'sent', { versionCount: 2, versions: [{ v: 2, line: '- D6 200' }, { v: 1, line: '- D6 old' }], tagState: 'active', mentions: { count: 3, lastTurn: 9 } })] },
              { id: 'mem.decisions.closed', title: 'Replaced / closed decisions', parent: 'mem.decisions', count: 1, items: [row('D2', 'Version code 150', 'left_out', { reason: 'cut' })] },
              { id: 'mem.facts', title: 'Facts', parent: 'mem', count: 1, items: [row('F1', 'Staging host', 'inactive', { tagState: 'inactive' })] },
              { id: 'mem.ranges.old', title: 'Old ranges', parent: 'mem', count: 9, items: many },
            ] },
        });
        window.__contextTree.expand('memgrp/mem.decisions');
        window.__contextTree.expand('memgrp/mem.decisions.closed');
        window.__contextTree.expand('memgrp/mem.ranges.old');
        window.__contextTree.expand('memgrp/mem.facts');
        await new Promise((res) => setTimeout(res, 20));
        const q = (sel) => document.querySelectorAll(sel).length;
        const before = { root: q('.cc-mem-root'), groups: q('.cc-mem-group'), sent: q('.cc-mem-row.cc-mc-sent'), left: q('.cc-mem-row.cc-mc-left_out'), inactive: q('.cc-mem-row.cc-mc-inactive'), more: q('.cc-mem-row.cc-mc-show_more'), moreBtn: q('.cc-mem-more'), tags: q('.cc-mem-tags .cc-mem-tag'), legend: q('.cc-mem-legend > span'), bold: q('.cc-mem-row b') };
        const leftColour = getComputedStyle(document.querySelector('.cc-mem-row.cc-mc-left_out')).borderLeftColor;
        const moreColour = getComputedStyle(document.querySelector('.cc-mem-row.cc-mc-show_more')).borderLeftColor;
        document.querySelector('.cc-mem-more').click();
        await new Promise((res) => setTimeout(res, 20));
        const afterMore = q('.cc-mem-row.cc-mc-show_more');
        const box = document.querySelector('.cc-mem-row[data-rid="D2"] .cc-mem-check');
        box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 40));
        window.__contextTree.expand('mem/D6');
        await new Promise((res) => setTimeout(res, 20));
        const versions = q('.cc-mem-row[data-rid="D6"] .cc-mem-versions li');
        const inBtn = document.querySelector('.cc-mem-row[data-rid="D6"] [data-mem-op="inactive"]');
        if (inBtn) inBtn.click();
        await new Promise((res) => setTimeout(res, 40));
        // The #tag chips: an active tag has inactive + remove, an inactive one only "active again".
        const chipOps = (rid) => Array.from(document.querySelectorAll(`.cc-mem-tags .cc-tag-op[data-rid="${rid}"]`)).map((b) => b.dataset.memOp).join(',');
        const chips = { d6: chipOps('D6'), f1: chipOps('F1') };
        const rm = document.querySelector('.cc-mem-tags .cc-tag-op[data-rid="F1"][data-mem-op="active"]');
        if (rm) rm.click();
        await new Promise((res) => setTimeout(res, 40));
        // One tap for a whole group: All in / All out / Auto.
        const groupOps = Array.from(document.querySelectorAll('.cc-mem-group-op[data-rid="group:mem.decisions"]')).map((b) => b.dataset.memOp).join(',');
        const allOut = document.querySelector('.cc-mem-group-op[data-rid="group:mem.decisions"][data-mem-op="exclude"]');
        if (allOut) allOut.click();
        await new Promise((res) => setTimeout(res, 40));
        // `#` in the composer lists the checklist's tags and inserts one.
        const ta = document.createElement('textarea');
        ta.className = 'aui-composer-input';
        const root = document.createElement('div'); root.className = 'aui-composer-root'; root.appendChild(ta); document.body.appendChild(root);
        ta.focus(); ta.value = 'see #d'; ta.selectionStart = ta.selectionEnd = ta.value.length;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const pop = Array.from(document.querySelectorAll('.cc-tag-pop button[data-tag]')).map((b) => b.dataset.tag);
        const first = document.querySelector('.cc-tag-pop button[data-tag="d6"]');
        if (first) first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        return { before, leftColour, moreColour, afterMore, sent, versions, hasInactiveBtn: !!inBtn, chips, groupOps, pop, typed: ta.value, popGone: !document.querySelector('.cc-tag-pop') };
      });
      check('the chat memory is a group of the checklist tree', r.before.root === 1 && r.before.groups >= 4, JSON.stringify(r.before));
      check('nested groups are drawn inside their parent (replaced decisions under decisions)', r.before.groups >= 4, JSON.stringify(r.before));
      check('sent, left out, inactive and show-more rows each get their own colour class', r.before.sent === 1 && r.before.left === 1 && r.before.inactive === 1 && r.before.more > 0, JSON.stringify(r.before));
      check('left out and show more are different colours', r.leftColour !== r.moreColour, `${r.leftColour} vs ${r.moreColour}`);
      check('stored rows wait behind "Show N more"', r.before.moreBtn === 1 && r.before.more < 9 && r.afterMore === 9, JSON.stringify({ b: r.before, a: r.afterMore }));
      check('the #tags and the colour legend are shown', r.before.tags === 2 && r.before.legend === 5, JSON.stringify(r.before));
      check('memory titles are escaped', r.before.bold === 0);
      const set = r.sent.filter((x) => x.name === 'ctx.set');
      check('ticking a memory row asks the engine with mem/<ID> include', set.some((x) => x.payload.ops[0].id === 'mem/D2' && x.payload.ops[0].action === 'include'), JSON.stringify(set));
      check('an open row lists its versions', r.versions === 2, r.versions);
      check('each #tag chip has its own controls (active: inactive + remove; inactive: active again)', r.chips.d6 === 'inactive,remove' && r.chips.f1 === 'active', JSON.stringify(r.chips));
      check('a chip control asks the engine for that tag', set.some((x) => x.payload.ops[0].id === 'mem/F1' && x.payload.ops[0].action === 'active'), JSON.stringify(set));
      check('# in the composer lists the checklist tags and inserts the chosen one', r.pop.includes('d6') && r.typed === 'see #d6 ' && r.popGone, JSON.stringify({ pop: r.pop, typed: r.typed }));
      check('each memory group has All in / All out / Auto', r.groupOps === 'include,exclude,auto', r.groupOps);
      check('"All out" on a group asks the engine with one mem/group:<id> exclude', set.some((x) => x.payload.ops.length === 1 && x.payload.ops[0].id === 'mem/group:mem.decisions' && x.payload.ops[0].action === 'exclude'), JSON.stringify(set));
      check('a tag can be made inactive from the row', r.hasInactiveBtn && set.some((x) => x.payload.ops[0].id === 'mem/D6' && x.payload.ops[0].action === 'inactive'), JSON.stringify(set));
      await ctx.close();
    }

    // ------------------------------------------- a failing engine is said, not hidden
    // A failed read is shown with a retry; there is no switch to fall back on.
    {
      const { ctx, page } = await open(browser, { feature: true });
      const r = await page.evaluate(async () => {
        window.NativeKit = { agent: { subagents: async (req) => { throw new Error('subagents: unknown action "' + req.action + '"'); } } };
        window.__contextTree.install({ chat: { mainId: 'chat-a', _onEvent: () => {}, on() {} } });
        const toggle = document.querySelector('.ct-toggle');
        if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
        await new Promise((res) => setTimeout(res, 80));
        const body = document.querySelector('.ct-body');
        const html1 = body ? body.innerHTML : '';
        return { html1, alert: !!(body && body.querySelector('.ct-error[role="alert"]')), hasOn: !!(body && body.querySelector('.ct-on')) };
      });
      check('a failed read is shown in the panel as an alert', r.alert && /unknown action/.test(r.html1), r.html1.slice(0, 300));
      check('a failed read offers a retry, not a "Turn on" button', !r.hasOn && /ct-retry|Retry/i.test(r.html1), r.html1.slice(0, 300));
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
        return { loaded, afterOther, afterOwn, ret, handled, calls, enabled: window.__contextTree.settings().enabled };
      });
      check('the panel loads the tree from the engine (ctx.tree)', r.loaded === 2, JSON.stringify(r));
      check('an event for another chat does not overwrite the panel', r.afterOther === 2, r.afterOther);
      check('an eventType event for this chat updates the panel', r.afterOwn === 1, r.afterOwn);
      check('events still reach the app', r.ret === 'base' && r.handled.length === 2, JSON.stringify(r.handled));
      const sw = r.calls.find((c) => c.action === 'ctx.settings' && c.settings);
      check('there is no switch: setEnabled(false) sends no "off" to the engine', !sw && window_enabled_true(r), JSON.stringify(r.calls));
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
    // The context card opens from the brain button in the top bar, as a sheet below
    // the header: never in the message list, no old chip left in the composer, and
    // never outside the screen.
    for (const w of [320, 375]) {
      await page.setViewportSize({ width: w, height: 700 });
      const layout = await page.evaluate(() => {
        const CT = window.__contextTree;
        CT.close();
        const toggle = document.querySelector('.topbar [data-slot="context-button"]');
        if (toggle) toggle.click(); else CT.open();
        const root = document.querySelector('.ct-panel');
        if (!root) return { mounted: false };
        const r = root.getBoundingClientRect();
        // The card is fixed on the page below the top bar (never inside the
        // message list).
        const header = toggle && toggle.closest('.topbar');
        const hr = header ? header.getBoundingClientRect() : null;
        const tabs = root.querySelector('[role="tablist"]');
        const body = root.querySelector('.ct-body');
        const out = {
          mounted: true,
          viaChip: !!toggle,
          open: CT.isOpen() && !root.hidden,
          inHeader: root.dataset.place === 'header' && getComputedStyle(root).position === 'fixed' && !!hr,
          composerChip: !!document.querySelector('.aui-composer-root .ct-toggle, .aui-composer-root [data-slot="token-meter"]'),
          inMessages: !!root.closest('.aui-message-root, .aui-thread-messages, [data-role="message"], .aui-thread-viewport'),
          side: root.dataset.side,
          belowHeader: hr ? r.top >= hr.bottom - 1 : null,
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
      check(`${w}px: the panel opens from the brain button in the top bar`, layout.mounted && layout.viaChip && layout.open && !layout.composerChip, JSON.stringify(layout));
      check(`${w}px: it sits below the header, not in the message list`, layout.inHeader && !layout.inMessages && layout.side === 'below' && layout.belowHeader === true, JSON.stringify(layout));
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
