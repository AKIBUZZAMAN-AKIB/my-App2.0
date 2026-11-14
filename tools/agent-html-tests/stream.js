// Live rendering while a reply streams, and no layout jumps from heavy blocks.
// - Big Mermaid diagrams (a 700-edge flowchart, a 300-message sequence diagram)
//   draw while they stream, keep the last good drawing (no flicker, no error
//   while partial), and draw for good once finished; a really invalid diagram
//   shows its error with the code.
// - ```widget blocks draw from partial JSON as it grows; ```html-widget streams
//   into one sandboxed frame without running its script, which runs once at
//   the end.
// - UI tool calls (ui__show_widget, ui__show_html, ui__render_spec,
//   ui__present) draw from streamed argument deltas (tool_call_delta) before
//   the call ends, and a skeleton card shows at once otherwise.
// - A long history of code and Mermaid blocks: blocks far from the screen are
//   not highlighted or drawn, and nothing the reader is looking at moves while
//   blocks render or change height above it.
// At 320, 375, 768 and 1366 px, light and dark. Mock NativeKit only; no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const mock = fs.readFileSync(path.resolve(__dirname, 'mock3.js'), 'utf8');
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = process.env.QUICK ? [[375, 812, true]] : process.env.SIZES ? process.env.SIZES.split(',').map((s) => { const m = /^(\d+)x(\d+)(m?)$/.exec(s); return [+m[1], +m[2], !!m[3]]; }) : [[320, 640, true], [375, 812, true], [768, 1024, true], [1366, 900, false]];

const FLOW = (() => { const l = ['flowchart TD']; for (let i = 0; i < 700; i++) l.push(`  N${i % 260}[Step ${i % 260}] --> N${(i * 7 + 3) % 260}[Step ${(i * 7 + 3) % 260}]`); return l.join('\n'); })();
const SEQ = (() => { const l = ['sequenceDiagram', '  participant U as User', '  participant A as App', '  participant S as Server']; for (let i = 0; i < 300; i++) l.push(i % 3 === 0 ? `  U->>A: request ${i}` : i % 3 === 1 ? `  A->>S: call ${i}` : `  S-->>U: reply ${i}`); return l.join('\n'); })();
const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';
const WIDGET = JSON.stringify({ type: 'todo', title: 'Study plan', items: Array.from({ length: 12 }, (_, i) => ({ text: `Task number ${i + 1}: read chapter ${i + 1}`, done: i % 3 === 0 })) }, null, 1);
const HTMLW = '<!-- title: Live counter -->\n<style>body{font:14px sans-serif}.row{padding:6px;border-bottom:1px solid #ccc}</style>\n' + Array.from({ length: 30 }, (_, i) => `<div class="row">Row ${i + 1}</div>`).join('\n') + '\n<script>parent.postMessage({__auiTest:"script-ran"},"*")</script>\n<div class="row" id="end">END</div>';

async function open(browser, w, hgt, mobile, dark) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(() => { window.__scriptRuns = 0; addEventListener('message', (e) => { if (e.data && e.data.__auiTest === 'script-ran') window.__scriptRuns++; }); });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(200);
  return { p, ctx, errs };
}
const emit = (p, events) => p.evaluate((ev) => { for (const [n, d] of ev) window.__mock.emit(n, d); }, events);
async function send(p, text) {
  await p.locator('.aui-composer-input').first().fill(text);
  await p.locator('.aui-composer-send').first().click();
  await sleep(250);
  const c = await p.evaluate(() => window.__mock.calls);
  return [...c].reverse().find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey || [...c].reverse().find((x) => x.name === 'agent.sendMessage')?.args?.sessionKey;
}
/** Streams text in pieces of `size` characters, `per` pieces per event batch, waiting `ms` between batches. */
async function stream(p, k, text, { size = 40, per = 4, ms = 30, until } = {}) {
  const parts = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'));
  let seen = null;
  for (let i = 0; i < parts.length; i += per) {
    await emit(p, parts.slice(i, i + per).map((d) => ['text_delta', { sessionKey: k, delta: d }]));
    await sleep(ms);
    if (until && seen == null && await p.evaluate(until)) seen = i / parts.length;
  }
  return seen;
}
const watchJumps = (p) => p.evaluate(() => {
  const m = [...document.querySelectorAll('[data-role=assistant]')].pop();
  window.__jumps = []; let last = 0;
  window.__ro = new ResizeObserver(() => { const hh = m.getBoundingClientRect().height; if (hh < last - 24) window.__jumps.push([Math.round(last), Math.round(hh)]); last = Math.max(last, hh); });
  window.__ro.observe(m);
});
const jumps = (p) => p.evaluate(() => { window.__ro?.disconnect(); return window.__jumps; });

async function diagrams(browser, w, hh, mobile, dark, tag) {
  const { p, ctx, errs } = await open(browser, w, hh, mobile, dark);
  const k = await send(p, 'Draw the system');
  await watchJumps(p);
  const flowLive = await stream(p, k, `Here is the flow:\n\n${fence('mermaid', FLOW)}\n\nAnd the calls:\n\n`, { size: 60, per: 4, ms: 40, until: () => !!document.querySelector('.aui-mermaid[data-state=live] .aui-mermaid-svg svg') });
  ck(`${tag} a 700-edge flowchart draws while it streams`, flowLive != null && flowLive < 0.98, String(flowLive));
  const midErr = await p.evaluate(() => [...document.querySelectorAll('.aui-mermaid')].map((b) => b.dataset.state));
  const seqLive = await stream(p, k, `${fence('mermaid', SEQ)}\n\nDone.`, { size: 60, per: 4, ms: 40, until: () => { const b = [...document.querySelectorAll('.aui-mermaid')][1]; return !!b && !!b.querySelector('.aui-mermaid-svg svg') && b.dataset.state === 'live'; } });
  ck(`${tag} a 300-message sequence diagram draws while it streams`, seqLive != null && seqLive < 0.98, String(seqLive));
  ck(`${tag} no error while a diagram is still partial`, !midErr.includes('error'), JSON.stringify(midErr));
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await p.waitForFunction(() => [...document.querySelectorAll('.aui-mermaid')].every((b) => b.dataset.state === 'done'), null, { timeout: 30000 }).catch(() => {});
  const fin = await p.evaluate(() => [...document.querySelectorAll('.aui-mermaid')].map((b) => ({ st: b.dataset.state, view: b.dataset.view, svg: !!b.querySelector('.aui-mermaid-svg svg'), nodes: b.querySelectorAll('.aui-mermaid-svg svg .node, .aui-mermaid-svg svg .actor').length })));
  ck(`${tag} both big diagrams are drawn in full once finished`, fin.length === 2 && fin.every((f) => f.st === 'done' && f.svg && f.view === 'diagram') && fin[0].nodes >= 200, JSON.stringify(fin));
  const j = await jumps(p);
  ck(`${tag} no layout jumps while big diagrams stream`, j.length === 0, JSON.stringify(j));
  // A diagram that really is invalid.
  const k2 = await send(p, 'Broken one');
  await stream(p, k2, `${fence('mermaid', 'flowchart TD\n  A --> B\n  B --> ((( oops\n  C -->')}\n\nend`, { size: 30 });
  await emit(p, [['agent.completed', { sessionKey: k2 }]]);
  await p.waitForFunction(() => [...document.querySelectorAll('.aui-mermaid')].pop()?.dataset.state === 'error', null, { timeout: 15000 }).catch(() => {});
  const bad = await p.evaluate(() => { const b = [...document.querySelectorAll('.aui-mermaid')].pop(); return { st: b.dataset.state, view: b.dataset.view, note: b.querySelector('.aui-mermaid-note')?.textContent || '', code: /oops/.test(b.querySelector('code')?.textContent || ''), codeShown: getComputedStyle(b.querySelector('.aui-code-block')).display !== 'none', svg: !!b.querySelector('.aui-mermaid-svg') }; });
  ck(`${tag} an invalid diagram shows its error with the code`, bad.st === 'error' && bad.code && bad.codeShown && !bad.svg && bad.note.length > 10, JSON.stringify(bad));
  ck(`${tag} no page errors (diagrams)`, errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function widgets(browser, w, hh, mobile, dark, tag) {
  const { p, ctx, errs } = await open(browser, w, hh, mobile, dark);
  const k = await send(p, 'Make me widgets');
  await watchJumps(p);
  const wLive = await stream(p, k, `Your plan:\n\n${fence('widget', WIDGET)}\n\n`, { size: 24, per: 2, ms: 40, until: () => !!document.querySelector('.aui-widget[data-state=live] .aui-widget-live [data-widget=todo]') });
  ck(`${tag} a widget block draws from partial JSON while it streams`, wLive != null && wLive < 0.9, String(wLive));
  const grows = await p.evaluate(() => document.querySelector('.aui-widget[data-state=live]')?.dataset.liveDrawn || document.querySelector('.aui-widget')?.dataset.state);
  const hLive = await stream(p, k, `${fence('html-widget', HTMLW)}\n\nThat's all.`, { size: 40, per: 2, ms: 40, until: () => !!document.querySelector('.aui-widget[data-state=live] iframe[data-live]') });
  ck(`${tag} an html-widget block shows its frame while it streams`, hLive != null && hLive < 0.9, String(hLive));
  const midRuns = await p.evaluate(() => window.__scriptRuns);
  ck(`${tag} the widget's script does not run while it streams`, midRuns === 0, String(midRuns));
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await p.waitForFunction(() => document.querySelectorAll('.aui-widget[data-state=done]').length === 2, null, { timeout: 10000 }).catch(() => {});
  await sleep(1200);
  const fin = await p.evaluate(() => ({ todo: document.querySelectorAll('[data-widget=todo] .aui-widget-todo-item, [data-widget=todo] li').length, live: document.querySelectorAll('.aui-widget-live, .aui-widget-building').length, html: !!document.querySelector('.aui-widget[data-state=done] iframe.aui-html-frame:not([data-live])'), runs: window.__scriptRuns }));
  ck(`${tag} once finished the real widgets replace the live ones and the script runs once`, fin.todo >= 12 && fin.live === 0 && fin.html && fin.runs === 1, JSON.stringify(fin) + ` drawn=${grows}`);
  const j = await jumps(p);
  ck(`${tag} no layout jumps while widgets stream`, j.length === 0, JSON.stringify(j));
  ck(`${tag} no page errors (widgets)`, errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

const SPEC = [
  { op: 'add', path: '/root', value: 'main' },
  { op: 'add', path: '/elements/main', value: { type: 'Stack', props: { gap: 'md' }, children: ['h', 't1', 't2', 't3'] } },
  { op: 'add', path: '/elements/h', value: { type: 'Heading', props: { text: 'Revision' } } },
  { op: 'add', path: '/elements/t1', value: { type: 'Text', props: { text: 'Line one' } } },
  { op: 'add', path: '/elements/t2', value: { type: 'Text', props: { text: 'Line two' } } },
  { op: 'add', path: '/elements/t3', value: { type: 'Text', props: { text: 'Line three' } } },
].map((x) => JSON.stringify(x));
async function toolCalls(browser, w, hh, mobile, dark, tag) {
  const { p, ctx, errs } = await open(browser, w, hh, mobile, dark);
  const k = await send(p, 'Show me things');
  const calls = [
    ['ui__show_widget', JSON.stringify({ spec: JSON.parse(WIDGET) }), '[data-widget=todo]'],
    ['ui__show_html', JSON.stringify({ title: 'Live table', html: HTMLW.replace(/<script[\s\S]*?<\/script>/, '') }), 'iframe.aui-html-frame'],
    ['ui__present', JSON.stringify({ title: 'plan', tree: { _type: 'Stack', gap: 'md', children: [{ _type: 'Heading', text: 'Week one' }, ...Array.from({ length: 8 }, (_, i) => ({ _type: 'Text', text: `Day ${i + 1}: study chapter ${i + 1} and review the notes from class.` }))] } }), '.gu-root'],
  ];
  for (const [name, args, sel] of calls) {
    const id = `tc-${name}`;
    await emit(p, [['tool_call_start', { sessionKey: k, toolCallId: id, toolName: name }]]);
    await sleep(120);
    const skeleton = await p.evaluate((id) => !!document.querySelector(`[data-tool-call-id="${id}"] .aui-ui-skeleton, [data-tool-call-id="${id}"][data-ui-live]`), id);
    ck(`${tag} ${name}: a placeholder shows at once when the call starts`, skeleton);
    const parts = args.match(/[\s\S]{1,30}/g);
    let seen = null;
    for (let i = 0; i < parts.length; i++) {
      await emit(p, [['tool_call_delta', { sessionKey: k, toolCallId: id, toolName: name, delta: parts[i] }]]);
      if (i % 4 === 3) { await sleep(60); if (seen == null && await p.evaluate(([id, sel]) => !!document.querySelector(`[data-tool-call-id="${id}"]`)?.querySelector(sel), [id, sel])) seen = i / parts.length; }
    }
    ck(`${tag} ${name}: draws from streamed arguments before the call ends`, seen != null && seen < 0.95, String(seen));
    await emit(p, [['tool_use', { sessionKey: k, toolCallId: id, toolName: name, args: JSON.parse(args) }]]);
    await sleep(250);
    await emit(p, [['tool_result', { sessionKey: k, toolCallId: id, result: { output: JSON.stringify({ ok: true, shown: true }) } }]]);
    await sleep(300);
  }
  // render_spec: JSONL patches, line by line.
  const id = 'tc-spec';
  await emit(p, [['tool_call_start', { sessionKey: k, toolCallId: id, toolName: 'ui__render_spec' }]]);
  const specArgs = JSON.stringify({ title: 'revision', patches: SPEC.join('\n') + '\n' });
  const pieces = specArgs.match(/[\s\S]{1,12}/g);
  let first = null;
  for (let i = 0; i < pieces.length; i++) {
    await emit(p, [['tool_call_delta', { sessionKey: k, toolCallId: id, toolName: 'ui__render_spec', delta: pieces[i] }]]);
    if (i % 3 === 2) { await sleep(60); const n = await p.evaluate((id) => document.querySelector(`[data-tool-call-id="${id}"]`)?.querySelector('[data-ui-live-body]')?.textContent || '', id); if (first == null && /Line one/.test(n)) first = i / pieces.length; }
  }
  ck(`${tag} ui__render_spec: patches draw line by line while the arguments stream`, first != null && first < 0.95, String(first));
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: id, toolName: 'ui__render_spec', args: JSON.parse(specArgs) }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  ck(`${tag} no page errors (tool calls)`, errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function history(browser, w, hh, mobile, dark, tag) {
  const { p, ctx, errs } = await open(browser, w, hh, mobile, dark);
  const k = await send(p, 'Long code history');
  const code = (i) => fence(['js', 'python', 'rust', 'ts'][i % 4], Array.from({ length: 40 }, (_, j) => `const value_${i}_${j} = compute(${j}, "text ${j}"); // line ${j}`).join('\n'));
  const parts = [];
  for (let i = 0; i < 30; i++) { parts.push(`### Part ${i}`, `Paragraph ${i}. `.repeat(8), code(i)); if (i % 3 === 1) parts.push(fence('mermaid', `flowchart LR\n  A${i}[Start ${i}] --> B${i}[Middle] --> C${i}[End]\n  B${i} --> D${i}[Side]`)); }
  await emit(p, [['text_delta', { sessionKey: k, delta: parts.join('\n\n') }], ['agent.completed', { sessionKey: k }]]);
  await sleep(800);
  const lazy = await p.evaluate(() => {
    const vp = document.querySelector('.aui-thread-viewport');
    const r = vp.getBoundingClientRect();
    const far = (el) => { const b = el.getBoundingClientRect(); return b.bottom < r.top - 1200 || b.top > r.bottom + 1200; };
    const blocks = [...document.querySelectorAll('.aui-code-block[data-cv]')];
    const mm = [...document.querySelectorAll('.aui-mermaid')];
    return { blocks: blocks.length, farPlain: blocks.filter(far).filter((b) => b.hasAttribute('data-lazy-hl')).length, far: blocks.filter(far).length, nearDone: blocks.filter((b) => !far(b)).filter((b) => b.dataset.hl === 'done').length, mmFarPending: mm.filter(far).filter((b) => b.dataset.state === 'pending' && !b.querySelector('.aui-mermaid-svg')).length, mmFar: mm.filter(far).length };
  });
  ck(`${tag} code and diagrams far from the screen are not rendered yet`, lazy.blocks === 30 && lazy.far > 5 && lazy.farPlain === lazy.far && lazy.mmFarPending === lazy.mmFar && lazy.nearDone >= 1, JSON.stringify(lazy));
  // Scroll to the middle, pick the heading at the top of the screen, and watch it while everything renders.
  // A wheel event is the reader steering: the thread stops holding the new turn in place.
  await p.evaluate(() => { const vp = document.querySelector('.aui-thread-viewport'); vp.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 })); vp.scrollTo({ top: vp.scrollHeight * 0.5, behavior: 'instant' }); });
  await sleep(60);
  const drift = await p.evaluate(async () => {
    const vp = document.querySelector('.aui-thread-viewport');
    const top = vp.getBoundingClientRect().top;
    const anchor = [...vp.querySelectorAll('.aui-md h3')].find((e) => e.getBoundingClientRect().top > top + 40);
    const y0 = anchor.getBoundingClientRect().top;
    let max = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 3500) { await new Promise((r) => requestAnimationFrame(r)); max = Math.max(max, Math.abs(anchor.getBoundingClientRect().top - y0)); }
    return { max: Math.round(max), name: anchor.textContent, drawn: document.querySelectorAll('.aui-mermaid[data-state=done]').length, hl: document.querySelectorAll('.aui-code-block[data-hl=done]').length };
  });
  ck(`${tag} what the reader looks at stays still while blocks render around it`, drift.max <= 2 && drift.hl >= 1, JSON.stringify(drift));
  // Scrolling up through the history renders the blocks there, without moving the screen.
  // Measured where the browser paints: after layout and after ResizeObservers (the app's own
  // scroll compensation runs in one; a ResizeObserver made later runs after it), and once more
  // after each step settles. A rAF reading would also see the in-between layout no frame shows.
  const up = await p.evaluate(async () => {
    const vp = document.querySelector('.aui-thread-viewport');
    let anchor = null; let y0 = 0; let max = 0;
    const look = () => { if (anchor) max = Math.max(max, Math.abs(anchor.getBoundingClientRect().top - y0)); };
    const ro = new ResizeObserver(look);
    document.querySelectorAll('.aui-md > *').forEach((e) => ro.observe(e));
    for (let s = 0; s < 6; s++) {
      anchor = null;
      vp.scrollBy({ top: -700, behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const top = vp.getBoundingClientRect().top;
      anchor = [...vp.querySelectorAll('.aui-md h3')].find((e) => e.getBoundingClientRect().top > top);
      if (!anchor) continue;
      y0 = anchor.getBoundingClientRect().top;
      await new Promise((r) => setTimeout(r, 600));
      look();
    }
    ro.disconnect();
    return { max: Math.round(max), hl: document.querySelectorAll('.aui-code-block[data-hl=done]').length, drawn: document.querySelectorAll('.aui-mermaid[data-state=done]').length };
  });
  ck(`${tag} scrolling up renders older blocks without moving the screen`, up.max <= 2, JSON.stringify(up));
  ck(`${tag} no page errors (history)`, errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [w, hh, mobile] of SIZES) {
    for (const dark of [false, true]) {
      const tag = `${w}${dark ? ' dark' : ''}`;
      for (const [name, fn] of [['diagrams', diagrams], ['widgets', widgets], ['tools', toolCalls], ['history', history]]) {
        if (only && !only.includes(name)) continue;
        try { await fn(browser, w, hh, mobile, dark, tag); } catch (e) { ck(`${tag} ${name} ran`, false, String(e.stack || e).slice(0, 300)); }
      }
    }
  }
  await browser.close();
  for (const r of results) console.log(r);
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
