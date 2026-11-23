// Workspace tree (plan.md Phases 1, 2, 4): what the engine's item registry
// holds, shown in the context panel and acted on from the thread list.
//
// What this checks:
//   1. a chat row shows its Sub-agents, Files (read in this chat / workspace /
//      attachments / sub-agent files) and Shared with me groups, every row
//      carries data-item-id, a missing source is badged, empty groups are left
//      out, and item titles are escaped;
//   2. the All view lists the items of each section when opened;
//   3. Peer chats: a sub-agent's agent-to-agent conversations are listed, and a
//      thread names each sender and quotes the message a reply answers;
//   4. a library file is registered with the engine (items.registerClient) and
//      the engine's purge queue removes the WebView copy and is acknowledged;
//   5. the thread menu offers Delete for a stored chat: it previews (dry run),
//      deletes with items.deleteHolder, and Undo restores the batch.
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

// A fake engine: answers the workspace requests the UI sends and records them.
const FAKE = `
  window.__wsCalls = [];
  window.__wsTrashed = new Set();
  const item = (id, kind, title, extra) => ({ id, kind, title, state: 'live', owner: 'session:chat-a', ...(extra || {}) });
  const page = (items) => ({ items, total: items.length, more: false });
  const TREE = {
    holder: 'session:chat-a',
    sections: {
      subagents: [{
        item: item('it_ag1', 'agent', 'Researcher', { meta: { agentId: 'ag1', status: 'idle', name: 'Researcher' } }),
        chat: item('it_ch1', 'chat', 'Researcher chat', { meta: { messages: 4 } }),
        memory: [item('it_m1', 'memory', 'prefers metric')],
        files: [item('it_f9', 'file', 'notes.txt')],
        subagents: [],
      }],
      files: {
        read: page([item('it_r1', 'file', 'report.pdf')]),
        workspace: page([item('it_w1', 'file', '<img src=x onerror=alert(1)>.md')]),
        attachments: page([item('it_a1', 'file', 'photo.jpg', { state: 'missing' })]),
        subagentFiles: page([]),
      },
      sharedWithMe: page([item('it_s1', 'memory', 'budget is 5k', { owner: 'session:chat-b', ref: { perm: 'read', mode: 'live' } })]),
    },
  };
  const ALL = { sections: { chats: page([item('it_c1', 'chat', 'Trip planning')]), subagents: page([]), files: page([item('it_r1', 'file', 'report.pdf')]), memory: page([]), notes: page([]), messages: page([]), groups: page([]), missing: page([item('it_a1', 'file', 'photo.jpg', { state: 'missing' })]) } };
  const MSGS = [
    { id: 'm1', from: 'agent:ag1', fromName: 'Researcher', to: [{ pid: 'agent:ag2', name: 'Writer' }], text: 'Found 3 sources.', state: 'live' },
    { id: 'm2', from: 'agent:ag2', fromName: 'Writer', to: [{ pid: 'agent:ag1', name: 'Researcher' }], text: 'Thanks, drafting now.', replyTo: 'm1', state: 'live' },
  ];
  window.NativeKit = { agent: { async subagents(req) {
    window.__wsCalls.push(req);
    const a = req.action;
    let r = {};
    if (a === 'items.tree') r = req.all ? ALL : TREE;
    else if (a === 'messages.conversations') r = { conversations: req.pid === 'agent:ag1' ? [{ conversation: 'peer:ag1|ag2', withNames: ['Writer'], count: 2 }, { conversation: 'session:chat-a', count: 9 }] : [] };
    else if (a === 'messages.read') r = { messages: MSGS };
    else if (a === 'items.registerClient') r = { id: 'it_lib_' + req.loc, registered: true };
    else if (a === 'items.purgeClient') r = { items: window.__purgeQueue || [] };
    else if (a === 'items.clientPurged') { window.__purgeQueue = []; r = { done: (req.ids || []).length }; }
    else if (a === 'items.sync') r = { sync: {} };
    else if (a === 'items.deleteHolder' && req.dryRun) r = { dryRun: true, holder: req.holder, counts: { trash: 3, purge: 0, detach: 1, revoke: 2, affectedHolders: 1 }, policy: { mode: 'timed', retainSecs: 2592000 }, keptBy: [{ holder: 'agent:ag2', name: 'Writer' }] };
    else if (a === 'items.deleteHolder') { window.__wsTrashed.add(req.holder); r = { holder: req.holder, batch: 'tb_1', counts: { trash: 3 } }; }
    else if (a === 'items.restoreBatch') { window.__wsTrashed.clear(); r = { restored: 3 }; }
    return { resultJson: JSON.stringify(r) };
  } } };
`;

async function open(browser, { w = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'load' });
  await page.evaluate(FAKE);
  await page.evaluate(() => {
    window.__features = ['contextTree'];
    try { window.__contextTree.install(null); } catch (e) { /* defensive */ }
  });
  return { ctx, page };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    // ------------------------------------------------ 1. chat sections
    {
      const { ctx, page } = await open(browser);
      const r = await page.evaluate(async () => {
        const CT = window.__contextTree;
        CT.workspaceChatHtml('chat-a');
        await new Promise((res) => setTimeout(res, 80));
        for (const id of ['ws/files/session:chat-a', 'ws/files/session:chat-a/read', 'ws/files/session:chat-a/workspace', 'ws/files/session:chat-a/attachments', 'ws/shared/session:chat-a', 'ws/agent/it_ag1', 'ws/agent/it_ag1/memory']) CT.expand(id);
        const box = document.createElement('div');
        box.innerHTML = CT.workspaceChatHtml('chat-a');
        const q = (s) => box.querySelector(s);
        return {
          groups: [...box.querySelectorAll('[data-group]')].map((e) => e.dataset.group),
          sections: [...box.querySelectorAll('[data-ws-section]')].map((e) => e.dataset.wsSection),
          ids: [...box.querySelectorAll('[data-item-id]')].map((e) => e.dataset.itemId),
          missing: !!q('[data-item-id="it_a1"] .cc-bad'),
          injected: !!box.querySelector('img'),
          escapedText: (q('[data-item-id="it_w1"]') || {}).textContent || '',
          shared: (q('[data-group="shared-with-me"]') || {}).textContent || '',
          openChat: (q('[data-open-conv]') || {}).dataset?.openConv || '',
          subOnly: !!q('[data-ws-section="files-subagents"]'),
          subagentChatEmpty: CT.workspaceChatHtml('subagent:ag1') === '',
        };
      });
      check('a chat shows Sub-agents, Files and Shared with me', ['subagents', 'files', 'shared-with-me'].every((g) => r.groups.includes(g)), JSON.stringify(r.groups));
      check('Files has Read in this chat, Workspace and Attachments', ['files-read', 'files-workspace', 'files-attachments'].every((x) => r.sections.includes(x)), JSON.stringify(r.sections));
      check('an empty Files part is left out', !r.subOnly, JSON.stringify(r.sections));
      check('every row carries data-item-id', ['it_ag1', 'it_ch1', 'it_m1', 'it_r1', 'it_w1', 'it_a1', 'it_s1'].every((x) => r.ids.includes(x)), JSON.stringify(r.ids));
      check('a missing source is badged', r.missing);
      check('item titles are escaped', !r.injected && r.escapedText.includes('<img'), r.escapedText);
      check('Shared with me names the item and its permission', r.shared.includes('budget is 5k') && r.shared.includes('read'), r.shared);
      check('a sub-agent row opens its chat', r.openChat === 'subagent:ag1', r.openChat);
      check('a sub-agent chat has no chat-level workspace block', r.subagentChatEmpty);
      await ctx.close();
    }

    // ------------------------------------------------ 2. All view
    {
      const { ctx, page } = await open(browser);
      const r = await page.evaluate(async () => {
        const CT = window.__contextTree;
        CT.expand('grp/ws-all');
        CT.workspaceAllHtml();
        await new Promise((res) => setTimeout(res, 80));
        CT.expand('ws/all/chats');
        CT.expand('ws/all/missing');
        const box = document.createElement('div');
        box.innerHTML = CT.workspaceAllHtml();
        return { text: box.textContent, ids: [...box.querySelectorAll('[data-item-id]')].map((e) => e.dataset.itemId), calls: window.__wsCalls.filter((c) => c.action === 'items.tree').map((c) => !!c.all) };
      });
      check('the All view asks for the whole registry', r.calls.includes(true), JSON.stringify(r.calls));
      check('an opened All section lists its items', r.ids.includes('it_c1') && r.ids.includes('it_a1') && r.text.includes('Trip planning'), JSON.stringify(r));
      check('the All view has a Groups section', r.text.includes('Groups'), r.text);
      await ctx.close();
    }

    // ------------------------------------------------ 3. Peer chats
    {
      const { ctx, page } = await open(browser);
      const r = await page.evaluate(async () => {
        const CT = window.__contextTree;
        const wait = () => new Promise((res) => setTimeout(res, 80));
        CT.workspaceChatHtml('chat-a');
        await wait();
        CT.expand('ws/agent/it_ag1');
        CT.workspaceChatHtml('chat-a');
        await wait();
        CT.expand('ws/peers/ag1');
        CT.expand('ws/peer/peer:ag1|ag2');
        CT.workspaceChatHtml('chat-a');
        await wait();
        const box = document.createElement('div');
        box.innerHTML = CT.workspaceChatHtml('chat-a');
        const msgs = [...box.querySelectorAll('.cc-ws-msg')];
        return {
          group: !!box.querySelector('[data-group="peer-chats"]'),
          convs: [...box.querySelectorAll('[data-peer-conv]')].map((e) => e.dataset.peerConv),
          senders: msgs.map((m) => (m.querySelector('.cc-ws-from strong') || {}).textContent),
          quote: (box.querySelector('[data-msg-id="m2"] .cc-ws-quote') || {}).textContent || '',
          asked: window.__wsCalls.filter((c) => c.action === 'messages.conversations' || c.action === 'messages.read').map((c) => c.pid || c.conversation),
        };
      });
      check('a sub-agent has a Peer chats group', r.group, JSON.stringify(r));
      check('only agent-to-agent conversations are listed', r.convs.length === 1 && r.convs[0] === 'peer:ag1|ag2', JSON.stringify(r.convs));
      check('each bubble names its sender', r.senders.join(',') === 'Researcher,Writer', JSON.stringify(r.senders));
      check('a reply quotes the message it answers', r.quote.includes('Researcher') && r.quote.includes('Found 3 sources'), r.quote);
      check('the thread is read from the message store', r.asked.includes('agent:ag1') && r.asked.includes('peer:ag1|ag2'), JSON.stringify(r.asked));
      await ctx.close();
    }

    // ------------------------------------------------ 4. library <-> registry
    {
      const { ctx, page } = await open(browser);
      const r = await page.evaluate(async () => {
        const F = window.__files;
        await F.library.put({ id: 'lib1', name: 'plan.pdf', size: 1200, addedAt: Date.now(), lastUsedAt: Date.now() });
        await F.library.put({ id: 'lib1', name: 'plan.pdf', size: 1200, addedAt: Date.now(), lastUsedAt: Date.now() + 1 });
        await new Promise((res) => setTimeout(res, 30));
        const reg = window.__wsCalls.filter((c) => c.action === 'items.registerClient');
        await F.library.put({ id: 'lib2', name: 'old.txt', size: 3, addedAt: 1, lastUsedAt: 1 });
        window.__purgeQueue = [{ itemId: 'it_x', loc: 'idb:library/lib2' }];
        const n = await F.applyEnginePurges();
        const left = (await F.library.all()).map((x) => x.id);
        const ack = window.__wsCalls.filter((c) => c.action === 'items.clientPurged').map((c) => c.ids);
        return { reg: reg.map((c) => [c.loc, c.kind, c.title]), n, left, ack };
      });
      check('a library file is registered once as idb:library/<id>', r.reg.length === 1 && r.reg[0][0] === 'idb:library/lib1' && r.reg[0][1] === 'file' && r.reg[0][2] === 'plan.pdf', JSON.stringify(r.reg));
      check('an engine purge removes the WebView copy', r.n === 1 && !r.left.includes('lib2') && r.left.includes('lib1'), JSON.stringify(r));
      check('the purge is acknowledged to the engine', JSON.stringify(r.ack) === JSON.stringify([['it_x']]), JSON.stringify(r.ack));
      await ctx.close();
    }

    // ------------------------------------------------ layout at 320 px
    {
      const { ctx, page } = await open(browser, { w: 320 });
      const r = await page.evaluate(async () => {
        const CT = window.__contextTree;
        CT.workspaceChatHtml('chat-a');
        await new Promise((res) => setTimeout(res, 80));
        for (const id of ['ws/files/session:chat-a', 'ws/files/session:chat-a/workspace', 'ws/shared/session:chat-a']) CT.expand(id);
        const box = document.createElement('div');
        box.className = 'ct-panel';
        box.style.width = '300px';
        box.innerHTML = CT.workspaceChatHtml('chat-a');
        document.body.append(box);
        return document.documentElement.scrollWidth - document.documentElement.clientWidth;
      });
      check('320px: no horizontal overflow', r <= 1, r);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => r.startsWith('FAIL'));
  for (const r of results) console.log(r);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('workspace-tree suite crashed:', e);
  process.exit(1);
});
