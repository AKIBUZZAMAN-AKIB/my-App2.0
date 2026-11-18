// Swarm state for the demo team (demo-seed.js): roles, a coordinator, topics with a compacted history, a
// blackboard with fresh and faded marks, a handoff, and one of each decision. Needs mock-swarm.js.
/** Seeds window.__swarm from the demo agents' ids. Returns nothing. */
async function seedSwarm(p, ids, { many = true } = {}) {
  await p.evaluate(({ ids: x, many: m }) => {
    const S = window.__swarm; const sub = (n) => window.__sa.subs.get(x[n]);
    const now = Date.now(); const min = 60000;
    S.configs.chat = { topology: 'hierarchical', compactKeep: 6, compactAt: 10 };
    sub('draft').commsRole = 'lead'; sub('outline').commsRole = 'lead'; sub('web-scout').commsRole = 'hub'; sub('fact-checker').topology = 'mesh';
    for (const n of ['draft', 'outline', 'web-scout', 'fact-checker']) { const r = sub(n); window.__sa.emit('subagent.updated', { id: r.id, commsRole: r.commsRole || 'member', topology: r.topology || null }); }
    S.coordinator = x.draft; S.coordinatorName = 'draft'; S.term = 2;
    const posts = ['MLPerf Mobile v5 numbers are in the notes', 'llama-bench table pasted to findings/bench', 'outline v1 ready for review', 'section 2 needs a source for the 4-bit claim', 'found it: MMLU-Pro on-device subset, Table 3', 'draft hits 1,620 words; trimming', 'fact-check: 2 of 14 numbers off, fixed', 'tone pass done on the intro', 'polish waiting on draft', 'pricing-lookup hit a 429; retry later', 'monitor: CI green on main', 'draft at 1,512 words'];
    if (m) posts.forEach((t, i) => S.agentPost('research', [x['web-scout'], x.outline, x.draft, x['fact-checker']][i % 4], t, now - (posts.length - i) * 2 * min));
    S.agentPost('release-notes', x.writer, 'Intro approved by reviewer in round 2.', now - 9 * min);
    S.agentPost('release-notes', x.reviewer, 'APPROVED. One nit fixed.', now - 8 * min);
    S.agentWrite('findings/bench', x['web-scout'], 'MLPerf Mobile v5; llama-bench; MMLU-Pro on-device subset (4-bit).', { at: now - 3 * min, tags: ['benchmarks'] });
    S.agentWrite('findings/bench', x['fact-checker'], 'MLPerf Mobile v5; llama-bench; MMLU-Pro on-device subset (4-bit). Verified against sources.', { at: now - 2 * min, tags: ['benchmarks', 'verified'] });
    S.agentWrite('draft/wordcount', x.draft, '1512', { at: now - min });
    S.agentWrite('pricing/api', x['pricing-lookup'], 'Rate-limited; no prices yet.', { at: now - 150 * min, tags: ['blocked'] });
    S.handoff(x.outline, x.draft, 'Outline done; write the draft from it.', now - 20 * min);
    S.handoff(x.draft, x['fact-checker'], 'Check every number.', now - 6 * min);
    S.auctions.push({ id: 'au_1', task: 'Make the comparison chart', status: 'awarded', announcerId: x.draft, announcerName: 'draft', policy: 'cheapest', criteria: 'Under 2k tokens, SVG', createdAt: now - 14 * min, closedAt: now - 12 * min, winnerId: x.outline, winnerName: 'outline', invited: [x.outline, x.polish, x.writer],
      bids: [{ bidderId: x.outline, bidderName: 'outline', cost: 1400, confidence: 0.8, proposal: 'Reuse the bench table; one SVG bar chart.' }, { bidderId: x.writer, bidderName: 'writer', cost: 2600, confidence: 0.9, proposal: 'Hand-drawn style chart with notes.' }, { bidderId: x.polish, bidderName: 'polish', declined: true }] });
    S.auctions.push({ id: 'au_2', task: 'Translate the summary to Bengali', status: 'open', announcerId: x.draft, announcerName: 'draft', policy: 'best', createdAt: now - min, invited: [x.writer, x.reviewer], bids: [] });
    S.votes.push({ id: 'vo_1', question: 'Ship the explainer at 1,500 words or 2,000?', status: 'open', callerId: x.draft, callerName: 'draft', rule: 'majority', quorum: 50, options: ['1,500 words', '2,000 words'], tally: { '1,500 words': 2, '2,000 words': 1 }, voters: [x.draft, x.outline, x['fact-checker'], x.polish], createdAt: now - 4 * min,
      ballots: [{ voterId: x.draft, voterName: 'draft', option: '1,500 words', reason: 'The brief says 1,500.' }, { voterId: x.outline, voterName: 'outline', option: '1,500 words' }, { voterId: x['fact-checker'], voterName: 'fact-checker', option: '2,000 words', reason: 'Room for sources.' }] });
    S.debates.push({ id: 'de_1', topic: 'Lead with energy use or with latency?', status: 'converged', moderatorId: x.draft, moderatorName: 'draft', participants: [x.outline, x['fact-checker']], rounds: 3, round: 2, createdAt: now - 18 * min, closedAt: now - 15 * min,
      turns: [{ round: 1, agentId: x.outline, agentName: 'outline', stance: 'propose', position: 'Latency first: readers feel it.' }, { round: 1, agentId: x['fact-checker'], agentName: 'fact-checker', stance: 'disagree', position: 'Energy is the 2026 story.' }, { round: 2, agentId: x.outline, agentName: 'outline', stance: 'agree', position: 'Lead with energy, latency second.' }, { round: 2, agentId: x['fact-checker'], agentName: 'fact-checker', stance: 'agree', position: 'Agreed.' }] });
    S.elections.push({ id: 'el_1', term: 1, winnerId: x.outline, winnerName: 'outline', method: 'rank', at: now - 30 * min, candidates: [x.outline, x.draft], reason: 'Highest rank: started first.' });
    S.elections.push({ id: 'el_2', term: 2, winnerId: x.draft, winnerName: 'draft', method: 'vote', at: now - 10 * min, candidates: [x.draft, x.outline, x['fact-checker']], reason: '2 of 3 votes.' });
    S.messageCount += 23;
  }, { ids, many });
}
module.exports = { seedSwarm };
