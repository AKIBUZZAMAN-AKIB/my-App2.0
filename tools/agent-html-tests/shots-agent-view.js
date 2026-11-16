// 390 px screenshots of the per-agent view tabs (mock data). Writes PNGs to OUT (default /home/sprite/parity-shots).
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep } = require('./feat.js');
const { open, makeChain, EXE } = require('./subagent-graph-fixes.js');
const OUT = process.env.OUT || '/home/sprite/parity-shots';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE });
  const { p, ctx, errs } = await open(browser, { w: 390, hgt: 844 });
  const ids = await makeChain(p, { finish: false });
  await p.evaluate((x) => {
    for (const id of [x.c, x.b]) window.__sa.finish(id, id === x.b ? 'Found 4 primary sources; summary written to sources.md.' : 'LEVEL3-OK written to deep3.txt');
    const s = window.__sa.subs.get(x.b); s.tools = ['read_file', 'list_dir', 'web_fetch', 'write_file']; s.costUsd = 0;
    Object.assign(s, { model: 'Meta-Llama-3_3-70B-Instruct', provider: 'ovh', temperature: 0.4, maxSteps: 40, compactions: 1, compaction: { enabled: true, thresholdPercent: 80 }, contextStatus: { estimatedTokens: 6900, budgetTokens: 10000, compactAtTokens: 8000, thresholdPercent: 80, autoCompact: true } });
    Object.assign(window.__subagents.records.get(x.b), s);
    const t0 = Date.now() - 90000;
    window.__sa.logs = { [x.b]: [
      { at: t0, event: 'subagent.started' },
      { at: t0 + 4000, event: 'subagent.tool_call', tool: 'web_fetch' },
      { at: t0 + 9000, event: 'subagent.tool_result', tool: 'web_fetch', text: '200 OK, 14 KB' },
      { at: t0 + 12000, event: 'subagent.tool_call', tool: 'read_file' },
      { at: t0 + 13000, event: 'subagent.tool_result', tool: 'read_file', isError: true, text: 'ENOENT: notes/old.md' },
      { at: t0 + 20000, event: 'subagent.approval_needed', approvalTool: 'write_file' },
      { at: t0 + 31000, event: 'subagent.peer_message', toName: 'summariser', text: 'Sources are in sources.md' },
      { at: t0 + 40000, event: 'subagent.compaction', compaction: { kind: 'tool_results_compacted', phase: 'done', tokensBefore: 9120, tokensAfter: 4210, trigger: 'threshold' } },
      { at: t0 + 52000, event: 'subagent.tool_call', tool: 'write_file' },
      { at: t0 + 53000, event: 'subagent.tool_result', tool: 'write_file', text: 'wrote sources.md' },
      { at: t0 + 60000, event: 'subagent.finished' },
    ] };
    window.__sa.allows = { chat: ['list_dir'], agent: {} };
  }, ids);
  const shot = async (name, tab, id = ids.b) => {
    await p.evaluate(({ x, t }) => window.__subagents.open(window.__app, { id: x, agentTab: t }), { x: id, t: tab });
    await sleep(900);
    await p.screenshot({ path: `${OUT}/${name}.png` });
    console.log('wrote', name);
  };
  await shot('p2-1-overview', 'overview');
  await shot('p2-2-chat', 'chat');
  await p.evaluate((x) => { const r = window.__subagents.records.get(x); window.__sa.allows.agent[r.sessionKey] = ['web_fetch']; }, ids.b);
  await shot('p2-3-tools', 'tools');
  await shot('p2-4-activity', 'activity');
  await shot('p3-1-settings', 'settings');
  await p.evaluate(() => { const f = document.querySelector('[data-slot="agent-settings-compaction"]'); f?.scrollIntoView({ block: 'center' }); });
  await sleep(300); await p.screenshot({ path: `${OUT}/p3-2-settings-compaction.png` }); console.log('wrote p3-2-settings-compaction');
  await shot('p3-3-context', 'context');
  console.log('errors:', errs.length ? errs.join(' / ') : 'none');
  await ctx.close(); await browser.close();
})();
