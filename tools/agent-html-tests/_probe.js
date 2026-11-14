// Rendering quality: one rich reply with every block type, streamed in small chunks.
// Checks layout jumps while streaming, final == streamed result, clipping, page overflow, and takes screenshots.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep, send, emit, overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = require('path').join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = require('fs').existsSync(b) ? require('fs').readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? require('path').join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${require('path').resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/impl/shots6/render';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync('/home/sprite/impl/test/mock3.js', 'utf8');
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

const RICH = `# Weekly study report

This week you studied **14.5 hours**, with *most* time on \`CSE-1101\`. See [the course page](https://example.edu/courses/cse-1101-structured-programming) for details.

## Plan

1. Revise pointers
   - Read chapter 7
   - Solve problems 7.1 to 7.12
     - Focus on \`malloc\` and \`free\`
2. Calculus practice
3. Physics lab report

- [x] Submit assignment 2
- [ ] Prepare for CT-3
- [ ] Email the CR about the lab schedule

> **Tip:** short daily sessions beat one long night before the exam.
> Keep each session under 50 minutes.

### Marks so far

| Course | Title | CT-1 | CT-2 | Assignment | Average | Remarks |
|:---|:---|---:|---:|:---:|---:|:---|
| CSE-1101 | Structured Programming Language | 18 | 19.5 | A | 18.75 | Strong on loops, weaker on pointers |
| MAT-1103 | Differential and Integral Calculus | 12 | 15 | B+ | 13.5 | Needs more practice with integration by parts |
| PHY-1105 | Physics Lab | 16 | 17 | A- | 16.5 | Lab report due Thursday |

### Code

\`\`\`javascript
// average.js
const marks = [18, 19.5, 12, 15, 16, 17];
const average = marks.reduce((sum, mark) => sum + mark, 0) / marks.length; // this comment is long on purpose so the line has to scroll sideways inside its own box
console.log(\`Average: \${average.toFixed(2)}\`);
\`\`\`

### Math

The mean is $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$ and the variance is $\\sigma^2$.

$$
f(x) = \\int_{-\\infty}^{\\infty} \\hat{f}(\\xi)\\, e^{2\\pi i \\xi x} \\, d\\xi = \\sum_{k=0}^{\\infty} \\frac{f^{(k)}(a)}{k!}(x-a)^k + \\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n \\cdot \\prod_{j=1}^{m} \\frac{\\alpha_j + \\beta_j}{\\gamma_j}
$$

### Diagram

\`\`\`mermaid
flowchart LR
  A[Read chapter] --> B[Solve problems] --> C[Check answers] --> D[Ask the CR] --> E[Revise mistakes] --> F[Take a mock CT]
\`\`\`

Sources: [routine notice](https://example.edu/notices/routine-changes-for-the-spring-semester-2026).
`;

async function open(browser, w, hgt, mobile, dark) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(250);
  return { p, ctx, errs };
}

async function run(browser, w, hgt, mobile, dark) {
  const tag = `${w}x${hgt}${dark ? ' dark' : ''}`;
  const { p, ctx, errs } = await open(browser, w, hgt, mobile, dark);
  const a = await send(p, 'Give me my weekly report');
  const k = a.sessionKey;
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'wf', toolName: 'web_fetch', args: { url: 'https://example.edu/courses/cse-1101-structured-programming', method: 'GET' } }]]);
  await sleep(300);
  await emit(p, [['tool_result', { sessionKey: k, toolCallId: 'wf', result: { output: JSON.stringify({ status: 200, body: '<html>course</html>' }) } }]]);
  // watch the reply for shrinking (layout jumps) and flicker while streaming
  await p.evaluate(() => {
    window.__jumps = []; window.__flick = 0;
    const m = [...document.querySelectorAll('[data-role=assistant]')].pop();
    let last = 0; window.__snap = [];
    const snap = () => [...m.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().height > 8 && e.closest('[data-role=assistant]') === m).slice(0, 40).map((e) => e.tagName + '.' + String(e.className.baseVal ?? e.className).slice(0, 30) + ':' + Math.round(e.getBoundingClientRect().height)).join(' | '); window.__ro = new ResizeObserver(() => { const hgt = m.getBoundingClientRect().height; if (hgt < last - 24) window.__jumps.push(['PREV', window.__prev, 'NOW', snap()]); window.__prev = snap(); if (hgt < last - 24) window.__jumps.push([last, hgt, [...m.querySelectorAll('.aui-md > *')].slice(-3).map((e) => e.tagName + '.' + e.className + ':' + (e.dataset.state || '') + ':' + Math.round(e.getBoundingClientRect().height)).join(' | ')]); last = Math.max(last, hgt); });
    window.__ro.observe(m);
    window.__mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.removedNodes) if (n.nodeType === 1 && /aui-(md-table-wrapper|katex|mermaid)/.test(n.className || '') && n.isConnected === false) window.__flick++; });
    window.__mo.observe(m, { childList: true, subtree: true });
  });
  const chunks = RICH.match(/[\s\S]{1,23}/g);
  for (let i = 0; i < chunks.length; i += 3) {
    await emit(p, chunks.slice(i, i + 3).map((d) => ['text_delta', { sessionKey: k, delta: d }]));
    await sleep(25);
  }
  await sleep(+(process.env.WAIT||1200));
  const streamed = await p.evaluate(() => { const m = [...document.querySelectorAll('[data-role=assistant]')].pop(); return m.querySelector('.aui-md')?.innerText; });
  await emit(p, [['agent.completed', { sessionKey: k }]]);
  await sleep(1800);
  const jumps = await p.evaluate(() => { window.__ro.disconnect(); window.__mo.disconnect(); return { jumps: window.__jumps, flick: window.__flick }; });
  ck(`${tag} no layout jumps while streaming`, jumps.jumps.length === 0, JSON.stringify(jumps));
  const fin = await p.evaluate(() => { const m = [...document.querySelectorAll('[data-role=assistant]')].pop(); return m.querySelector('.aui-md')?.innerText; });
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  if (process.env.DIFF) { fs.writeFileSync('/tmp/streamed.txt', streamed); fs.writeFileSync('/tmp/final.txt', fin); }
  ck(`${tag} final text matches the streamed text`, norm(fin) === norm(streamed), `${norm(streamed).length} vs ${norm(fin).length}`);

  const info = await p.evaluate(() => {
    const m = [...document.querySelectorAll('[data-role=assistant]')].pop();
    const q = (s) => m.querySelector(s);
    const box = (el) => el && el.getBoundingClientRect();
    const scrolls = (el) => el && el.scrollWidth > el.clientWidth + 1;
    const ovx = (el) => el && /(auto|scroll)/.test(getComputedStyle(el).overflowX);
    const content = box(q('.aui-md'));
    // anything wider than the message column that is not inside a sideways-scrolling box
    const clipped = [];
    for (const el of m.querySelectorAll('.aui-md *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right <= content.right + 1) continue;
      let p = el.parentElement; let inScroll = false;
      while (p && p !== m) { if (ovx(p) && p.getBoundingClientRect().right <= content.right + 1) { inScroll = true; break; } p = p.parentElement; }
      if (!inScroll) clipped.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${Math.round(r.right - content.right)}px`);
    }
    const tw = q('.aui-md-table-wrapper');
    const th = [...m.querySelectorAll('.aui-md table th')].map((t) => getComputedStyle(t).textAlign);
    const td = [...(m.querySelector('.aui-md table tbody tr')?.children || [])].map((t) => getComputedStyle(t).textAlign);
    const cells = [...m.querySelectorAll('.aui-md table td, .aui-md table th')].filter((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflow !== 'visible').length;
    const code = q('.aui-code-block pre');
    const kd = q('.katex-display');
    const kdBox = kd && (kd.closest('.aui-katex-display, .aui-math-display') || kd);
    const mm = q('.aui-mermaid');
    const svg = mm?.querySelector('svg');
    const nested = m.querySelectorAll('.aui-md ul ul ul li, .aui-md ol ul ul li').length;
    const tasks = [...m.querySelectorAll('.aui-md input[type=checkbox]')].map((c) => c.checked);
    const bq = q('.aui-md blockquote');
    const inline = q('.aui-md :not(pre) > code');
    const hl = m.querySelectorAll('.aui-code-block pre [class^="hl-"], .aui-code-block pre [class*=" hl-"], .aui-code-block pre span[class]').length;
    const footer = { src: box(q('.aui-sources')), bar: box(q('.aui-assistant-action-bar-root')), tookH: box(q('.aui-message-took'))?.height };
    const toolCard = box(q('.aui-tool-card, [data-tool-name], .aui-tool-root'));
    return {
      clipped: clipped.slice(0, 6),
      table: { scrolls: scrolls(tw), ovx: ovx(tw), fade: getComputedStyle(tw).maskImage || getComputedStyle(tw).webkitMaskImage, th, td, cells },
      code: { scrolls: scrolls(code) || scrolls(code?.parentElement), ovx: ovx(code) || ovx(code?.parentElement), hl, copy: !!q('[data-action=copy-code]') },
      katex: { inline: m.querySelectorAll('.katex').length, display: !!kd, ovx: kdBox ? (ovx(kdBox) || ovx(kdBox.parentElement)) : false, raw: /\$\$|\\frac/.test(q('.aui-md').innerText), color: kd ? getComputedStyle(kd).color : '' },
      mermaid: { state: mm?.dataset.state, svg: !!svg, w: svg ? box(svg).width : 0, boxW: mm ? box(mm).width : 0, ovx: mm ? [...mm.querySelectorAll('*')].some((e) => ovx(e)) || ovx(mm) : false, text: svg ? getComputedStyle(svg.querySelector('.nodeLabel, text, foreignObject div') || svg).color : '' },
      md: { h1: !!q('.aui-md h1'), h2: !!q('.aui-md h2'), h3: m.querySelectorAll('.aui-md h3').length, nested, tasks, bq: !!bq, inline: !!inline, link: q('.aui-md a[href^="https://example.edu/courses"]')?.getAttribute('target') },
      footer, toolCard: !!toolCard,
    };
  });
  ck(`${tag} nothing sticks out of the message column`, !info.clipped.length, JSON.stringify(info.clipped));
  ck(`${tag} headings, nested list, task list, quote, inline code, link`, info.md.h1 && info.md.h2 && info.md.h3 >= 4 && info.md.nested >= 1 && JSON.stringify(info.md.tasks) === '[true,false,false]' && info.md.bq && info.md.inline && !!info.md.link, JSON.stringify(info.md));
  ck(`${tag} table: column alignment follows the Markdown`, JSON.stringify(info.table.th) === JSON.stringify(['left', 'left', 'right', 'right', 'center', 'right', 'left']) || JSON.stringify(info.table.th) === JSON.stringify(['start', 'start', 'right', 'right', 'center', 'right', 'start']), JSON.stringify(info.table.th));
  ck(`${tag} table: body cells aligned too`, JSON.stringify(info.table.td.map((x) => x.replace('start', 'left'))) === JSON.stringify(['left', 'left', 'right', 'right', 'center', 'right', 'left']), JSON.stringify(info.table.td));
  ck(`${tag} table: scrolls sideways in its box with an edge fade, no clipped cells`, info.table.ovx && (w > 700 || (info.table.scrolls && /gradient/.test(info.table.fade || ''))) && info.table.cells === 0, JSON.stringify(info.table));
  ck(`${tag} code: highlighted, long line scrolls in its box, copy button`, info.code.ovx && info.code.scrolls && info.code.hl > 3 && info.code.copy, JSON.stringify(info.code));
  ck(`${tag} KaTeX: inline and display rendered, display scrolls in its box`, info.katex.inline >= 3 && info.katex.display && info.katex.ovx && !info.katex.raw, JSON.stringify(info.katex));
  ck(`${tag} Mermaid: rendered, fits or scrolls in its box`, info.mermaid.state === 'done' && info.mermaid.svg && (info.mermaid.w <= info.mermaid.boxW + 1 || info.mermaid.ovx), JSON.stringify(info.mermaid));
  ck(`${tag} footer: sources above action row, time on one line`, info.footer.src && info.footer.bar && info.footer.src.bottom <= info.footer.bar.top + 0.5 && info.footer.tookH <= 32, JSON.stringify(info.footer));
  const ov = await overflow(p);
  ck(`${tag} no page sideways scroll`, ov.ok, JSON.stringify(ov));

  // swipe the table and code sideways: the page stays put
  const sw = await p.evaluate(() => { const m = [...document.querySelectorAll('[data-role=assistant]')].pop(); const out = {}; for (const [k, s] of [['table', '.aui-md-table-wrapper'], ['code', '.aui-code-block pre']]) { const el = m.querySelector(s); el.scrollLeft = 9999; out[k] = el.scrollLeft > 0; } out.page = document.scrollingElement.scrollLeft; return out; });
  ck(`${tag} table and code swipe on their own, the page does not`, (w > 700 || (sw.table && sw.code)) && sw.page === 0, JSON.stringify(sw));
  await p.evaluate(() => { const m = [...document.querySelectorAll('[data-role=assistant]')].pop(); for (const s of ['.aui-md-table-wrapper', '.aui-code-block pre']) m.querySelector(s).scrollLeft = 0; });

  if (process.env.SHOT) {
    const name = `${w}${dark ? '-dark' : ''}`;
    const parts = [['top', 'h1'], ['table', '.aui-md-table-wrapper'], ['code', '.aui-code-block'], ['math', '.katex-display'], ['mermaid', '.aui-mermaid'], ['footer', '.aui-assistant-message-footer']];
    for (const [n, s] of parts) {
      await p.evaluate((sel) => { const m = [...document.querySelectorAll('[data-role=assistant]')].pop(); m.querySelector(sel)?.scrollIntoView({ block: sel.includes('footer') ? 'end' : 'center' }); }, s);
      await sleep(250);
      if (w > 700 && n !== 'top' && n !== 'footer') continue;
      await p.screenshot({ path: `${SHOTS}/${name}-${n}.png` });
    }
  }
  ck(`${tag} no console errors / network`, !errs.length, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const sizes = (process.env.SIZES || '320x640m,360x740m,390x844m,1280x800').split(',').map((s) => { const m = /^(\d+)x(\d+)(m?)$/.exec(s); return [+m[1], +m[2], !!m[3]]; });
  for (const [w, hgt, mobile] of sizes) for (const dark of [false, true]) {
    try { await run(browser, w, hgt, mobile, dark); } catch (e) { ck(`${w} ${dark} ran`, false, e.message.split('\n')[0]); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(fails.join('\n'));
  console.log(`${results.length - fails.length}/${results.length} passed`);
})();
