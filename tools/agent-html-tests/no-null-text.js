// Regression guard for the "nullnullnull" bug (2026-11-16).
// The DOM's own el.append(null) / el.prepend(null) inserts the text "null"; that is how
// "nullnullnullnull" reached the spawn card's mini graph and "null" lines reached the
// sub-agent detail. This file renders every sub-agent surface with records whose optional
// parts are missing (no title, no description, no files, no result, no parent, no model)
// and fails if any visible text node reads "null" or "undefined".
// It FAILS on the 63fd8bf build and passes after the appendKids/prependKids/setChildren fix.
// Run: node tools/agent-html-tests/no-null-text.js   (URL_=file://... to test another build)
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const { sleep } = require('./feat.js');
const { open, makeChain, EXE } = require('./subagent-graph-fixes.js');

const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + extra : ''}`); return ok; };

// Every text node (outside <script>/<style>/<code>) whose own text has a standalone
// null/undefined word, with the element it sits in.
const nullTexts = (p) => p.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest('script,style,code,pre,textarea')) continue;
    if (/(^|[^A-Za-z_])(null|undefined)(?![A-Za-z_])/i.test(n.textContent)) {
      out.push(`${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}: "${n.textContent.trim().slice(0, 60)}"`);
    }
  }
  return out;
});

// Strip the optional parts from every record, the way an older engine or a fresh spawn sends them.
const bareRecords = (p) => p.evaluate(() => {
  for (const s of window.__sa.subs.values()) {
    for (const k of ['title', 'description', 'files', 'result', 'model', 'provider', 'role', 'template', 'error']) delete s[k];
    const r = window.__subagents.records.get(s.id);
    if (r) for (const k of ['title', 'description', 'files', 'result', 'model', 'provider', 'role', 'template', 'error']) r[k] = null;
  }
});

async function testSurfaces(browser, w) {
  const { p, ctx, errs } = await open(browser, { w, hgt: 844 });
  await p.evaluate(() => { window.__mock.emit('agent.started', {}); window.__mock.emit('tool_use', { toolCallId: 'call-main', toolName: 'spawn_subagent', args: { name: 'alpha', task: 'task of alpha' } }); });
  const ids = await makeChain(p, { finish: false });
  await bareRecords(p);
  await sleep(500);
  let bad = await nullTexts(p);
  check(`${w}px spawn card + mini graph: no "null" text`, !bad.length, bad.join(' | '));

  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'agents' }));
  await sleep(400);
  bad = await nullTexts(p);
  check(`${w}px Agents list: no "null" text`, !bad.length, bad.join(' | '));

  for (const [label, id] of [['level 1', ids.a], ['level 2', ids.b], ['level 3', ids.c]]) {
    await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), id);
    await sleep(450);
    bad = await nullTexts(p);
    check(`${w}px ${label} detail: no "null" text`, !bad.length, bad.join(' | '));
  }

  await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'diagram' }));
  await sleep(1200);
  bad = await nullTexts(p);
  check(`${w}px Diagram tab: no "null" text`, !bad.length, bad.join(' | '));

  // Finished agents with no report, then the sub-agent opened as a chat.
  await p.evaluate((x) => { for (const id of [x.c, x.b, x.a]) window.__sa.finish(id, ''); }, ids);
  await bareRecords(p);
  await sleep(300);
  if (await p.evaluate(() => typeof window.__app.chat.openSubagent === 'function')) {
    await p.evaluate((id) => window.__app.chat.openSubagent(id), ids.b);
    await sleep(500);
    bad = await nullTexts(p);
    check(`${w}px sub-agent chat: no "null" text`, !bad.length, bad.join(' | '));
  }
  check(`${w}px no page errors`, !errs.length, errs.join(' / '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const sizes = (process.env.WIDTHS || '390,1280').split(',').map(Number);
  for (const w of sizes) {
    try { await testSurfaces(browser, w); } catch (e) { check(`${w}px crashed`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\nno-null-text: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
