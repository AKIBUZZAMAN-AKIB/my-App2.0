// Per-agent view (PARITY_PLAN.md phase 2): tab bar + Overview, Chat, Tools, Activity
// for agents at depth 1, 2 and 3, at 390 px and 1280 px.
// Run: node tools/agent-html-tests/agent-view.js   (URL_=file://... to test another build)
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const { sleep } = require('./feat.js');
const { open, makeChain, subCalls, EXE } = require('./subagent-graph-fixes.js');

const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + extra : ''}`); return ok; };
const textOf = (p, sel) => p.evaluate((s) => document.querySelector(s)?.innerText || '', sel);
const nullTexts = (p) => p.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest('script,style,code,pre,textarea')) continue;
    if (/(^|[^A-Za-z_])(null|undefined|NaN)(?![A-Za-z_])/.test(n.textContent)) out.push(n.textContent.trim().slice(0, 50));
  }
  return out;
});
const overflowX = (p) => p.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('[data-slot^="agent-tab"] *, [data-slot="agent-view-tabs"]')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > w + 1 || r.left < -1) && !el.closest('.sa-vtabs')) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return { pageScroll: document.documentElement.scrollWidth > w + 1, bad: bad.slice(0, 5) };
});
const pickTab = async (p, t) => { await p.click(`[data-slot="agent-view-tabs"] [data-tab="${t}"]`); await sleep(350); };

// A log with every kind the Activity tab sorts into.
const seedLog = (p, id, toolName) => p.evaluate(({ id: x, toolName: tn }) => {
  const t0 = Date.now() - 60000;
  (window.__sa.logs ||= {})[x] = [
    { at: t0, event: 'subagent.started' },
    { at: t0 + 1000, event: 'subagent.tool_call', tool: tn },
    { at: t0 + 2000, event: 'subagent.tool_result', tool: tn, isError: true, text: 'ENOENT: no such file' },
    { at: t0 + 3000, event: 'subagent.tool_call', tool: tn },
    { at: t0 + 3500, event: 'subagent.tool_result', tool: tn, text: 'ok' },
    { at: t0 + 4000, event: 'subagent.approval_needed', approvalTool: 'write_file' },
    { at: t0 + 5000, event: 'subagent.peer_message', toName: 'sibling', text: 'here are the sources' },
    { at: t0 + 6000, event: 'subagent.compaction', compaction: { kind: 'trim_tool_results', tokensBefore: 9000, tokensAfter: 4000 } },
    { at: t0 + 7000, event: 'subagent.error', text: 'model timed out' },
  ];
}, { id, toolName });

async function suite(browser, w) {
  const { p, ctx, errs } = await open(browser, { w, hgt: 844 });
  const ids = await makeChain(p, { finish: false });
  await p.evaluate((x) => { for (const id of [x.c, x.b]) window.__sa.finish(id, 'report from ' + id); }, ids);
  // Give level 2 a tool list so Tools has rows of both kinds.
  await p.evaluate((x) => { const s = window.__sa.subs.get(x.b); s.tools = ['read_file', 'list_dir', 'web_fetch']; s.costUsd = 0; }, ids);
  await seedLog(p, ids.b, 'read_file');

  for (const [label, id] of [['L1', ids.a], ['L2', ids.b], ['L3', ids.c]]) {
    await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), id);
    await sleep(450);
    const tabs = await p.$$eval('[data-slot="agent-view-tabs"] [role="tab"]', (els) => els.map((e) => [e.dataset.tab, e.getAttribute('aria-selected')]));
    check(`${w}px ${label}: tab bar with Overview selected`, tabs.length >= 4 && tabs[0][0] === 'overview' && tabs[0][1] === 'true', JSON.stringify(tabs));
    for (const t of ['chat', 'tools', 'activity']) {
      await pickTab(p, t);
      const ok = await p.$(`[data-slot="agent-tab-${t}"]`);
      const sel = await p.$eval(`[data-tab="${t}"]`, (e) => e.getAttribute('aria-selected'));
      check(`${w}px ${label}: ${t} tab renders and is selected`, !!ok && sel === 'true');
      const nul = await nullTexts(p);
      check(`${w}px ${label}: ${t} has no null/undefined/NaN text`, !nul.length, nul.join(' | '));
      if (w <= 400) {
        const o = await overflowX(p);
        check(`${w}px ${label}: ${t} fits the screen`, !o.pageScroll && !o.bad.length, JSON.stringify(o));
      }
    }
    await pickTab(p, 'overview');
    check(`${w}px ${label}: back to Overview shows the full detail`, !!(await p.$('[data-slot="subagent-hierarchy"], .sa-detail-name')));
  }

  // Keyboard: ArrowRight / End / Home move the selection and focus.
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), ids.b);
  await sleep(400);
  await p.focus('[data-tab="overview"]');
  await p.keyboard.press('ArrowRight'); await sleep(350);
  let focused = await p.evaluate(() => document.activeElement?.dataset?.tab);
  check(`${w}px keyboard ArrowRight selects Chat`, focused === 'chat' && (await p.$eval('[data-tab="chat"]', (e) => e.getAttribute('aria-selected'))) === 'true', focused);
  await p.keyboard.press('End'); await sleep(350);
  focused = await p.evaluate(() => document.activeElement?.dataset?.tab);
  check(`${w}px keyboard End selects the last tab`, focused === 'activity', focused);
  await p.keyboard.press('Home'); await sleep(350);
  focused = await p.evaluate(() => document.activeElement?.dataset?.tab);
  check(`${w}px keyboard Home selects Overview`, focused === 'overview', focused);

  // Opening with agentTab lands on that tab; switching agent resets to Overview.
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'activity' }), ids.b);
  await sleep(450);
  check(`${w}px open({agentTab}) lands on Activity`, !!(await p.$('[data-slot="agent-tab-activity"]')));
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x }), ids.a);
  await sleep(450);
  check(`${w}px another agent opens on Overview`, (await p.$eval('[data-tab="overview"]', (e) => e.getAttribute('aria-selected'))) === 'true');

  // Activity: counts, filter, newest first, error text shown.
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'activity' }), ids.b);
  await sleep(600);
  const n = await p.$$eval('.sa-vevent', (els) => els.length);
  check(`${w}px Activity lists all 9 seeded events`, n === 9, String(n));
  const first = await p.$eval('.sa-vevent .sa-vevent-title', (e) => e.innerText);
  check(`${w}px Activity is newest first`, /Error/.test(first), first);
  const chipN = await p.$eval('.sa-vchip[data-kind="errors"] .sa-vchip-n', (e) => e.innerText);
  check(`${w}px Activity counts 2 errors (tool + run)`, chipN === '2', chipN);
  await p.click('.sa-vchip[data-kind="tools"]'); await sleep(400);
  const kinds = await p.$$eval('.sa-vevent', (els) => els.map((e) => e.dataset.kind));
  check(`${w}px Activity filter Tools shows only tool events`, kinds.length === 4 && kinds.every((k) => k === 'tools' || k === 'errors'), JSON.stringify(kinds));
  await p.click('.sa-vchip[data-kind="context"]'); await sleep(400);
  const ctxText = await textOf(p, '.sa-vevents');
  check(`${w}px Activity shows the compaction with tokens`, /trim_tool_results/.test(ctxText) && /9000 → 4000/.test(ctxText), ctxText.slice(0, 120));
  await p.click('.sa-vchip[data-kind="all"]'); await sleep(300);

  // Tools: stats from the log, Always allow (agent scope) round trip, switch off a tool.
  await pickTab(p, 'tools');
  await sleep(400);
  const stats = await p.$eval('.sa-vtool[data-tool="read_file"] .sa-vtool-stats', (e) => e.innerText).catch(() => '');
  check(`${w}px Tools shows read_file: 2 calls, 1 failed`, /2 calls/.test(stats) && /1 failed/.test(stats), stats);
  const before = (await subCalls(p)).length;
  await p.click('.sa-vtool[data-tool="read_file"] [data-slot="agent-tool-allow"]');
  await sleep(700);
  const calls = (await subCalls(p)).slice(before);
  const allow = calls.find((c) => c.action === 'allowTool');
  const key = await p.evaluate((x) => window.__subagents.records.get(x)?.sessionKey, ids.b);
  check(`${w}px Always allow sends allowTool scope=agent for this agent`, allow && allow.scope === 'agent' && allow.toolName === 'read_file' && allow.sessionKey === key, JSON.stringify(allow));
  const st = await p.$eval('.sa-vtool[data-tool="read_file"]', (e) => e.dataset.allow);
  check(`${w}px read_file now shows Always allowed (this agent)`, st === 'agent', st);
  // Level 3 inherits it.
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'tools' }), ids.c);
  await sleep(700);
  const inh = await p.$eval('[data-slot="agent-tools-allows"]', (e) => e.innerText).catch(() => '');
  check(`${w}px level 3 lists read_file as allowed from a parent`, /From parents\s*read_file/.test(inh), inh.replace(/\s+/g, ' ').slice(0, 160));
  await p.evaluate((x) => window.__subagents.open(window.__app, { id: x, agentTab: 'tools' }), ids.b);
  await sleep(700);
  await p.click('.sa-vtool[data-tool="read_file"] [data-slot="agent-tool-revoke"]');
  await sleep(700);
  const rv = (await subCalls(p)).filter((c) => c.action === 'revokeTool').pop();
  check(`${w}px Ask first sends revokeTool scope=agent`, rv && rv.scope === 'agent' && rv.toolName === 'read_file', JSON.stringify(rv));
  check(`${w}px read_file back to Asks first`, (await p.$eval('.sa-vtool[data-tool="read_file"]', (e) => e.dataset.allow)) === 'ask');
  const b2 = (await subCalls(p)).length;
  await p.click('.sa-vtool[data-tool="web_fetch"] input[role="switch"]');
  await sleep(700);
  const cf = (await subCalls(p)).slice(b2).find((c) => c.action === 'configure');
  check(`${w}px switching web_fetch off sends configure without it`, cf && JSON.stringify(cf.tools) === JSON.stringify(['read_file', 'list_dir']), JSON.stringify(cf));
  const rec = await p.evaluate((x) => window.__subagents.records.get(x)?.tools, ids.b);
  check(`${w}px the record now has 2 tools`, Array.isArray(rec) && rec.length === 2, JSON.stringify(rec));

  // Chat tab: thread + composer present and Open full-screen chat works.
  await pickTab(p, 'chat');
  check(`${w}px Chat tab has the composer`, !!(await p.$('[data-slot="agent-tab-chat"] textarea, [data-slot="agent-tab-chat"] [data-slot="subagent-composer"]')));
  const fs = await p.$('[data-slot="agent-tab-open-chat"]');
  if (fs) {
    await fs.click(); await sleep(600);
    const inChat = await p.evaluate(() => !!document.querySelector('[data-slot="subagent-chat-header"], .sa-chat-header, [data-subagent-chat]'));
    check(`${w}px Open full-screen chat opens the sub-agent chat`, inChat);
  } else check(`${w}px Open full-screen chat button present`, false);

  check(`${w}px no page errors`, !errs.length, errs.join(' / '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  for (const w of (process.env.WIDTHS || '390,1280').split(',').map(Number)) {
    try { await suite(browser, w); } catch (e) { check(`${w}px crashed`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\nagent-view: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
