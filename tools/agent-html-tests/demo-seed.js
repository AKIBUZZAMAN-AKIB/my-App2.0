// A realistic sub-agent team in the mock engine, for screenshots and visual checks.
/** A realistic team for the screenshots: a race, a pipeline with a nested fact-checker, a review loop, a failure and a pause. */
async function seedDemo(p) {
  return p.evaluate(() => {
    const k = window.__app.chat.mainId;
    const now = Date.now(); const t0 = now - 260000;
    const ids = {};
    const mk = (name, x) => {
      const s = window.__sa.make({ name, task: x.task, status: x.status || 'running', depth: x.depth || 1, createdAt: t0 + (x.c || 0) * 1000 });
      const started = t0 + (x.s ?? x.c ?? 0) * 1000;
      const fin = x.d != null && x.status !== 'running' ? started + x.d * 1000 : null;
      const tokens = x.tok || 0;
      Object.assign(s, { parentId: null, parentSessionKey: k, rootSessionKey: k, model: x.model || 'claude-sonnet-4.5', startedAt: x.status === 'queued' ? null : started, finishedAt: fin,
        durationMs: x.status === 'running' ? now - started : x.d != null ? x.d * 1000 : 0, inputTokens: Math.round(tokens * 0.78), outputTokens: Math.round(tokens * 0.22), totalTokens: tokens, steps: x.steps || 0, toolCalls: x.tools || 0 }, x.extra || {});
      s.title = x.title; s.description = x.desc || null;
      if (x.result) s.result = x.result;
      if (x.error) s.error = x.error;
      if (x.parent) { const pr = window.__sa.subs.get(ids[x.parent]); s.parentId = pr.id; s.parentSessionKey = pr.sessionKey; }
      window.__sa.emit(x.status === 'queued' ? 'subagent.queued' : 'subagent.started', { ...s });
      window.__sa.comms.events.push({ at: started, event: 'subagent.started', id: s.id, status: 'running', depth: s.depth });
      if (fin) window.__sa.comms.events.push({ at: fin, event: x.status === 'error' ? 'subagent.failed' : 'subagent.finished', id: s.id, status: x.status });
      ids[name] = s.id;
      return s;
    };
    mk('web-scout', { task: 'Find the three most-cited 2026 benchmarks for on-device LLMs', title: 'Benchmark scout (web)', c: 0, d: 41, status: 'finished', tok: 18240, steps: 9, tools: 7, extra: { groupId: 'g-race', groupMode: 'race', groupIndex: 0, groupWinner: true },
      result: 'Top three, by citations since January:\n1. MLPerf Mobile v5 - latency and energy on phone NPUs.\n2. llama-bench (llama.cpp) - tokens/s across quantisations.\n3. MMLU-Pro on-device subset - accuracy after 4-bit quantisation.\nSources and dates are in the notes file.' });
    mk('docs-scout', { task: 'Find the three most-cited 2026 benchmarks for on-device LLMs (docs only)', title: 'Benchmark scout (docs)', c: 0, d: 39, status: 'cancelled', tok: 11020, steps: 6, tools: 4, extra: { groupId: 'g-race', groupMode: 'race', groupIndex: 1 },
      result: 'Stopped: web-scout finished first.' });
    mk('outline', { task: 'Outline a 1,500-word explainer from the benchmark notes', title: 'Outline the explainer', c: 44, d: 28, status: 'finished', tok: 9400, steps: 4, tools: 1, extra: { groupId: 'g-pipe', groupMode: 'pipeline', groupIndex: 0 } });
    mk('draft', { task: 'Write the explainer from the outline', title: 'Draft the explainer', desc: 'Forked with the last 6 turns of this chat.', c: 44, s: 73, status: 'running', tok: 22870, steps: 11, tools: 5, extra: { groupId: 'g-pipe', groupMode: 'pipeline', groupIndex: 1, contextMode: 'fork', dependsOn: [] } });
    window.__sa.subs.get(ids.draft).dependsOn = [ids.outline];
    mk('polish', { task: 'Edit the draft for tone and length', title: 'Polish and fit to 1,500 words', c: 44, status: 'queued', extra: { groupId: 'g-pipe', groupMode: 'pipeline', groupIndex: 2, dependsOn: [ids.draft] } });
    mk('fact-checker', { task: 'Check every number in the draft against its source', title: 'Fact-check the draft', depth: 2, parent: 'draft', c: 150, d: null, status: 'running', tok: 6310, steps: 5, tools: 6, model: 'claude-haiku-4.5' });
    mk('writer', { task: 'Write the release-notes intro', title: 'Release notes: intro', c: 90, d: 52, status: 'finished', tok: 7420, steps: 3, extra: { groupId: 'g-rev', groupMode: 'review', groupIndex: 0 },
      result: 'Version 2.4 brings sub-agents that can run in parallel, in a pipeline, or race each other - and a live graph of who is doing what.' });
    mk('reviewer', { task: 'Review the intro for accuracy and tone', title: 'Release notes: review', c: 90, s: 142, d: 19, status: 'finished', tok: 3150, steps: 2, extra: { groupId: 'g-rev', groupMode: 'review', groupIndex: 1, groupWinner: true },
      result: 'Clear and accurate; the claim about races matches the feature. One nit fixed in round 2.\nAPPROVED' });
    mk('pricing-lookup', { task: 'Look up current API prices for the comparison table', title: 'Pricing lookup', c: 160, d: 12, status: 'error', tok: 1980, steps: 2, tools: 2, error: 'Provider rate limit (429). Retry after 30 s.' });
    mk('monitor', { task: 'Watch the CI run and report when it finishes', title: 'Watch CI', c: 200, status: 'running', tok: 840, steps: 1, tools: 1, extra: { paused: true } });
    for (let i = 0; i < 3; i++) window.__sa.comms.events.push({ at: t0 + 170000 + i * 9000, event: 'subagent.peer_message', id: ids.draft, to: ids['fact-checker'] });
    window.__sa.comms.events.push({ at: t0 + 230000, event: 'subagent.peer_message', id: ids['fact-checker'], to: ids.draft });
    window.__sa.comms.events.sort((a, b) => a.at - b.at);
    // the writer's chat and two kept versions (as the engine saves them on edit / retry)
    const txt = (t) => [{ type: 'text', text: t }];
    window.__sa.transcripts.set(ids.writer, [
      { role: 'user', content: 'Write a two-sentence intro for the v2.4 release notes. Audience: developers. Mention parallel, pipeline and race sub-agents and the live graph.' },
      { role: 'assistant', content: txt('Version 2.4 brings sub-agents that can run in parallel, in a pipeline, or race each other - and a live graph of who is doing what.\n\nEvery agent gets its own chat, tools and memory, so you can steer, pause or retry any one of them without stopping the rest.') },
      { role: 'user', content: 'Reviewer feedback (round 1): say what a race does in a few words.' },
      { role: 'assistant', content: txt('Version 2.4 brings sub-agents that run in parallel, in a pipeline, or as a race where the first good answer wins - plus a live graph of who is doing what.') },
    ]);
    window.__sa.branches.set(ids.writer, [
      { id: 'v1', turn: 0, reason: 'edit', createdAt: now - 180000, messages: [{ role: 'user', content: 'Write a short intro for the release notes.' }, { role: 'assistant', content: txt('This release adds sub-agents.') }] },
      { id: 'v2', turn: 2, reason: 'regenerate', createdAt: now - 95000, messages: [{ role: 'user', content: 'Reviewer feedback (round 1): say what a race does in a few words.' }, { role: 'assistant', content: txt('...a race, where agents compete and the fastest wins...') }] },
    ]);
    return { k, ids };
  });
}
module.exports = { seedDemo };
