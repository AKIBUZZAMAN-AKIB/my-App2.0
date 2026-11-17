// UI audit for the sub-agent screens (not a pass/fail suite): text contrast (WCAG AA), tap targets under 32px on phones, unnamed controls, text under 11px. Run: node audit-subagents.js
const { chromium } = require('./pw.js');
const fs = require('fs');
const path = require('path');
const { open } = require('./subagent-advanced.js'); const { seedDemo: seed } = require('./demo-seed.js');
const EXE = (() => { const b = path.join(process.env.HOME, '.cache/ms-playwright'); const d = fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop(); return path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell'); })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function audit(p, scopeSel, tag) {
  return p.evaluate(([sel, tag]) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true }); const cache = {};
    const lum = (c) => { if (cache[c] !== undefined) return cache[c]; if (!c || c === 'transparent') return null; cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; const m = [d[0], d[1], d[2], d[3] / 255]; const [r, g, b] = m.slice(0, 3).map((v) => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return (cache[c] = { L: 0.2126 * r + 0.7152 * g + 0.0722 * b, a: m[3] }); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; const l = lum(c); if (l && l.a > 0.5) return l.L; } return lum(getComputedStyle(document.body).backgroundColor)?.L ?? 1; };
    const out = [];
    const roots = [...document.querySelectorAll(sel)].filter((r) => r.getClientRects().length);
    for (const root of roots) {
      const els = [...root.querySelectorAll('*')].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      for (const e of els) {
        const cs = getComputedStyle(e);
        const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const id = (e.getAttribute('data-slot') || e.className?.baseVal || e.className || e.tagName).toString().slice(0, 40) + ' "' + (e.textContent || '').trim().slice(0, 24) + '"';
        if (own && e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE') {
          const fs = parseFloat(cs.fontSize);
          if (fs < 11) out.push(`${tag} small-text ${fs}px ${id}`);
          if (!(e instanceof SVGElement)) { const fg = lum(cs.color); if (fg && fg.a > 0.5) { const b = bgOf(e); const ratio = (Math.max(fg.L, b) + 0.05) / (Math.min(fg.L, b) + 0.05); const need = fs >= 18 || (fs >= 14 && +cs.fontWeight >= 700) ? 3 : 4.5; if (ratio < need) out.push(`${tag} contrast ${ratio.toFixed(2)} ${id}`); } }
          if (cs.overflow === 'hidden' && cs.textOverflow !== 'ellipsis' && e.scrollWidth > e.clientWidth + 2) out.push(`${tag} clipped ${id}`);
        }
        const interactive = e.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio], [role=switch], [tabindex="0"]');
        if (interactive) {
          const r = e.getBoundingClientRect();
          const name = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || e.textContent.trim() || e.labels?.[0]?.textContent || e.placeholder;
          if (!name) out.push(`${tag} no-name ${id}`);
          if (innerWidth <= 420 && (r.width < 32 || r.height < 32) && !e.matches('input[type=checkbox], input[type=radio], input[type=range]')) out.push(`${tag} small-target ${Math.round(r.width)}x${Math.round(r.height)} ${id}`);
        }
      }
    }
    return [...new Set(out)];
  }, [scopeSel, tag]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const all = [];
  for (const env of [{ width: 1280, height: 860 }, { width: 1280, height: 860, dark: true }, { width: 390, height: 844 }, { width: 390, height: 844, dark: true }]) {
    const tag = `${env.width}${env.dark ? 'd' : 'l'}`;
    const { p, ctx } = await open(browser, env);
    const { ids } = await seed(p);
    await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' })); await sleep(700);
    all.push(...await audit(p, '[data-slot=subagent-explorer]', tag + ' explorer'));
    await p.locator(`[data-slot=subagent-explorer] [data-node="${ids.draft}"]`).click(); await sleep(400);
    all.push(...await audit(p, '[data-slot=explorer-inspector]', tag + ' inspector'));
    await p.evaluate(() => window.__subagents.open(window.__app)); await sleep(500);
    all.push(...await audit(p, '[role=dialog], .sa-panel, [data-slot=subagents-panel]', tag + ' panel'));
    for (const t of ['overview', 'settings', 'goals', 'memory', 'team', 'activity', 'tools', 'context']) { await p.evaluate(([i, t]) => window.__subagents.open(window.__app, { id: i, agentTab: t }), [ids.draft, t]); await sleep(400); all.push(...await audit(p, '[role=dialog], .sa-panel, [data-slot=subagents-panel]', `${tag} tab-${t}`)); }
    await p.evaluate(() => window.__subagents.open(window.__app, { tab: 'explorer' })); await sleep(500);
    await p.locator('[data-slot=explorer-new-batch]').click(); await sleep(400);
    all.push(...await audit(p, '[data-slot=batch-dialog]', tag + ' batch'));
    await ctx.close();
  }
  await browser.close();
  console.log(all.join('\n'));
  console.log('TOTAL', all.length);
})();
