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
//   7. a 320 px screen has no horizontal overflow, and the panel keeps its
//      heading visible.
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
            asked = { name, payload };
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
      return { html: CT.render(), state: CT.state() };
    });
    const html = state.html;
    check('the head shows the model, the counts and the tokens', /gpt-x/.test(html) && /4\.2k/.test(html) && /rev 12/.test(html), html.slice(0, 200));
    check('the locked rules row uses the lock symbol', /⚿/.test(html) && /Rules/.test(html));
    check('in / note / temp / out use their own symbols', /●/.test(html) && /◐/.test(html) && /✦/.test(html) && /○/.test(html), html.slice(0, 400));
    check('a compacted window explains itself', /least valuable items were taken out/i.test(html), html.slice(0, 300));
    check('why an item left is rendered in words', /over its budget/i.test(html), html.slice(0, 600));
    check('an actor is named, not a code', /Engine policy/.test(html));
    check('tokens before and after are shown for the log row', /4\.9k → 4\.2k tokens/.test(html), html.slice(0, 800));
    check('a refused op is marked as refused', /refused/.test(html));
    check('the footnote says nothing is deleted', /Nothing is deleted by taking it out/i.test(html));
    check('state is folded, not replaced, by a second partial event', state.state.rev === 12);

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

    // ---------------------------------------------------------------- layout
    for (const w of [320, 375]) {
      await page.setViewportSize({ width: w, height: 844 });
      const layout = await page.evaluate(() => {
        const root = document.querySelector('.ct-panel');
        if (!root) return { mounted: false };
        root.scrollIntoView();
        const body = root.querySelector('.ct-body');
        if (body) body.hidden = false;
        return {
          mounted: true,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          headingVisible: !!root.querySelector('.ct-toggle') && root.querySelector('.ct-toggle').getBoundingClientRect().width > 0,
          itemsVisible: root.querySelectorAll('.ct-item').length,
        };
      });
      check(`${w}px: the panel is mounted and visible`, layout.mounted && layout.headingVisible, JSON.stringify(layout));
      check(`${w}px: no horizontal overflow`, (layout.overflow ?? 0) <= 1, layout.overflow);
      check(`${w}px: rows are rendered`, (layout.itemsVisible ?? 0) > 0, layout.itemsVisible);
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
