/* ==========================================================================
   TEST-ONLY model, not shipped in www/agent.html: the engine (channels.rs
   may_message / may_broadcast) is the source of truth for who a message reaches.
   Swarm protocol (client half) + the social store.

   An agent-to-agent message is a record, not a broadcast. The envelope is
   fixed, because a message that cannot be replayed cannot be trusted:

     { id, from, to, kind, text, at, ttlMs, hops, topology, replyTo }

   Rules (measured against what the engine can already do — see
   docs/subagents/SUBAGENT_UI_REDESIGN.md and subagents.rs::message):
     * a message needs a sender, a recipient and text; anything else is refused
       loudly instead of drawn as an empty row;
     * `ttlMs` runs from the moment of sending; an expired message is kept in the
       log but marked `expired` and never handed to a reader;
     * a delivery receipt is its own record (`kind: "receipt"`), so "delivered"
       is evidence, not a guess;
     * topology decides who a *broadcast* reaches: ring = next one round,
       star = the hub only, mesh = everyone but the sender, chain = the next,
       bus = everyone. A direct message ignores topology.
   ========================================================================== */
const SwarmProtocol = (() => {
  const TOPOLOGY = ['ring', 'star', 'mesh', 'chain', 'bus'];
  const MAX_TEXT = 8_000;
  let seq = 0;
  const log = []; // newest last, like the engine's own append-only record
  const now = () => Date.now();

  const bad = (why) => ({ ok: false, error: why });

  /** Refuse anything that is not a complete envelope. */
  function send(input) {
    const m = input || {};
    const from = String(m.from || '').trim();
    const to = String(m.to || '').trim();
    const text = String(m.text || '').trim();
    if (!from) return bad('from is required: an anonymous message cannot be traced back');
    if (!to) return bad('to is required: a message without a recipient is a broadcast, say so with topology');
    if (from === to) return bad('from and to are the same agent');
    if (!text) return bad('text is required');
    if (text.length > MAX_TEXT) return bad(`text is ${text.length} characters, the limit is ${MAX_TEXT}`);
    const kind = m.kind && ['message', 'ask', 'answer', 'receipt', 'handoff'].includes(m.kind) ? m.kind : 'message';
    const topology = TOPOLOGY.includes(m.topology) ? m.topology : null;
    const ttlMs = Number.isFinite(m.ttlMs) ? Math.max(0, Math.min(m.ttlMs, 24 * 3600 * 1000)) : 3600 * 1000;
    const rec = {
      id: m.id || `msg${++seq}`,
      from, to, kind, text,
      at: m.at || now(),
      ttlMs,
      hops: Number.isFinite(m.hops) ? m.hops : 0,
      topology,
      replyTo: m.replyTo || null,
      read: false,
    };
    log.push(rec);
    if (log.length > 500) log.shift();
    return { ok: true, message: rec };
  }

  /** Still worth reading? Expiry is computed, never stored as a mutable flag. */
  function live(rec, at) {
    if (!rec || rec.kind === 'receipt') return false;
    // Strictly less: a message with `ttlMs: 0` is expired the moment it is written,
    // which is what "expires immediately" has to mean for the caller who asked.
    return (at == null ? now() : at) - rec.at < rec.ttlMs;
  }

  /** Who a broadcast reaches. A direct message returns its recipient only. */
  function recipients(rec, members) {
    const all = Array.isArray(members) ? members.filter((x) => x && x !== rec.from) : [];
    switch (rec.topology) {
      case 'ring': return all.slice(0, 1);
      case 'chain': return all.slice(0, 1);
      case 'star': return all.filter((x) => /^(hub|main|root)$/i.test(x)).slice(0, 1);
      case 'mesh': return all;
      case 'bus': return all;
      default: return [rec.to];
    }
  }

  /** A receipt is written when the reader actually took the message. */
  function deliver(id) {
    const rec = log.find((m) => m.id === id);
    if (!rec) return bad(`${id} is not in the log`);
    if (rec.kind === 'receipt') return bad('a receipt does not need a receipt');
    if (!live(rec)) return bad(`${id} expired ${Math.round((now() - rec.at - rec.ttlMs) / 1000)}s ago`);
    if (rec.read) return { ok: true, already: true, message: rec };
    rec.read = true;
    const receipt = { ...send({ from: rec.to, to: rec.from, kind: 'receipt', text: `read ${rec.id}`, replyTo: rec.id }).message };
    return { ok: true, message: rec, receipt };
  }

  /** The thread for one item: the message and every reply to it, in order. */
  function thread(id) {
    const root = log.find((m) => m.id === id);
    if (!root) return [];
    return log.filter((m) => m === root || m.replyTo === id);
  }

  /** What a reader is shown: live, addressed to it, oldest first. */
  function inbox(agent, at) {
    return log.filter((m) => m.to === agent && m.kind !== 'receipt' && live(m, at));
  }

  function summary() {
    const liveCount = log.filter((m) => live(m)).length;
    const receipts = log.filter((m) => m.kind === 'receipt').length;
    return { total: log.length, live: liveCount, expired: log.length - liveCount - receipts, receipts };
  }

  async function callBridge(action, payload) {
    const rt = (typeof window !== 'undefined' && (window.__runtime || window.__agentRuntime)) || null;
    if (rt && typeof rt.action === 'function') return rt.action(action, payload);
    if (typeof Engine !== 'undefined' && Engine && typeof Engine.action === 'function') return Engine.action(action, payload);
    return null;
  }

  /** Send, and tell the panel about it — the panel is a view, not the store. */
  async function sendAndShow(input) {
    const res = send(input);
    if (!res.ok) return res;
    // The agent shell (sections panel) was removed in 0e1ecb8; push only if a host still has one.
    if (typeof window !== 'undefined' && window.__agentShell) {
      try { window.__agentShell.pushMessage({ from: res.message.from, to: res.message.to, kind: res.message.kind, text: res.message.text, delivered: true }); } catch (e) { console.warn('swarm', e); }
    }
    await callBridge('agents.message', { message: res.message }).catch(() => null);
    return res;
  }

  const out = { TOPOLOGY, MAX_TEXT, send, deliver, thread, inbox, live, recipients, summary, sendAndShow, log: () => log.slice() };
  // Not window.__swarm: that name is the swarm engine's state (mock-swarm.js in the
  // browser tests). Taking it replaced the state the swarm screens and suites read.
  if (typeof window !== 'undefined') window.__swarmProtocol = out;
  return out;
})();
