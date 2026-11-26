/* Swarm protocol + shell: the parts a user can feel. Real Chromium, plain page. */
const path = require('path');
const { chromium } = require('./pw.js');
const FILE = 'file://' + path.join(__dirname, '..', '..', 'www', 'agent.html');
const results = [];
const check = (name, ok, extra) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + (extra ?? '')}`);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 720 } });
    await page.goto(FILE);
    // The protocol model is test-only (it is not shipped in agent.html).
    await page.addScriptTag({ path: path.join(__dirname, 'swarm-protocol.js') });

    // -- the envelope is checked, not assumed --------------------------------
    const env = await page.evaluate(() => {
      const S = window.__swarmProtocol;
      const noFrom = S.send({ to: 'b', text: 'x' });
      const noTo = S.send({ from: 'a', text: 'x' });
      const self = S.send({ from: 'a', to: 'a', text: 'x' });
      const noText = S.send({ from: 'a', to: 'b', text: '   ' });
      const ok = S.send({ from: 'a', to: 'b', text: 'need the schema' });
      return { noFrom: noFrom.error, noTo: noTo.error, self: self.error, noText: noText.error, ok: ok.ok, kind: ok.message.kind, ttl: ok.message.ttlMs };
    });
    check('a message without a sender is refused', /from is required/.test(env.noFrom || ''), env.noFrom);
    check('a message without a recipient is refused', /to is required/.test(env.noTo || ''), env.noTo);
    check('an agent cannot message itself', /same agent/.test(env.self || ''), env.self);
    check('empty text is refused', /text is required/.test(env.noText || ''), env.noText);
    check('a complete envelope is accepted with a kind and a ttl', env.ok === true && env.kind === 'message' && env.ttl > 0, JSON.stringify(env));

    // -- expiry and receipts -------------------------------------------------
    const life = await page.evaluate(() => {
      const S = window.__swarmProtocol;
      const m = S.send({ from: 'a', to: 'b', text: 'expires fast', ttlMs: 0 }).message;
      const expiredDeliver = S.deliver(m.id);
      const m2 = S.send({ from: 'a', to: 'b', text: 'stays' }).message;
      const d = S.deliver(m2.id);
      const again = S.deliver(m2.id);
      return { expired: expiredDeliver.ok, why: expiredDeliver.error, ok: d.ok, receipt: d.receipt && d.receipt.kind, replyTo: d.receipt && d.receipt.replyTo, twice: again.already, inbox: S.inbox('b').map((x) => x.text), thread: S.thread(m2.id).length };
    });
    check('an expired message cannot be delivered', life.expired === false && /expired/.test(life.why || ''), life.why);
    check('delivery writes a real receipt addressed back', life.ok === true && life.receipt === 'receipt' && typeof life.replyTo === 'string', JSON.stringify(life).slice(0, 120));
    check('delivering twice says already, and adds no second receipt', life.twice === true, life.twice);
    check('the inbox holds only live, addressed messages', life.inbox.includes ? life.inbox.includes('stays') : false, JSON.stringify(life.inbox));

    // -- topology decides reach ---------------------------------------------
    const topo = await page.evaluate(() => {
      const S = window.__swarmProtocol;
      // The sender is not in the member list, so "everyone but the sender" is all four.
      const members = ['hub', 'b', 'c', 'd'];
      const r = {};
      for (const t of S.TOPOLOGY) {
        const m = S.send({ from: 'a', to: 'b', text: 'hello', topology: t }).message;
        r[t] = S.recipients(m, members);
      }
      return r;
    });
    check('ring reaches one', topo.ring.length === 1, JSON.stringify(topo.ring));
    check('chain reaches one', topo.chain.length === 1, JSON.stringify(topo.chain));
    check('star reaches the hub only', topo.star.length === 1 && topo.star[0] === 'hub', JSON.stringify(topo.star));
    check('mesh reaches every member but the sender', topo.mesh.length === 4 && !topo.mesh.includes('a'), JSON.stringify(topo.mesh));
    check('bus reaches every member but the sender', topo.bus.length === 4 && !topo.bus.includes('a'), JSON.stringify(topo.bus));

    // -- sendAndShow records the message ----------------------------------------
    // The agent shell (sections panel) that used to show it was removed on purpose
    // in 0e1ecb8 (everything moved into the context card), so sendAndShow must work
    // without it: the message lands in the protocol's own log and a missing shell
    // throws nothing.
    const shown = await page.evaluate(async () => {
      const P = window.__swarmProtocol;
      const res = await P.sendAndShow({ from: 'builder', to: 'reviewer', text: 'build 42 is signed' });
      const last = P.log().slice(-1)[0] || {};
      return { ok: res.ok, shell: typeof window.__agentShell, last: { from: last.from, to: last.to, text: last.text }, summary: P.summary(), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    check('sendAndShow works with no agent shell', shown.ok === true && shown.shell === 'undefined', JSON.stringify(shown));
    check('a sent message lands in the log', shown.last.from === 'builder' && shown.last.to === 'reviewer' && /build 42/.test(shown.last.text || ''), JSON.stringify(shown.last));
    check('the summary counts live, expired and receipts separately', typeof shown.summary.live === 'number' && shown.summary.receipts >= 1, JSON.stringify(shown.summary));
    check('375px: no horizontal overflow', (shown.overflow ?? 0) <= 1, shown.overflow);
    await page.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => r.startsWith('FAIL'));
  results.forEach((r) => console.log(r));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('swarm suite crashed:', e); process.exit(1); });
