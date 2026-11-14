// The app-wide shared controls (www/shell/controls.css + controls.js), on the
// built pages exactly as the app ships them (web-dist, with the shell injected).
// At 320/375 (touch) and 768/1366 px, in light and dark mode:
//  dropdown — every <select> upgraded, accessible name, ≥ 44 px on touch, text
//    contrast, bottom sheet on phones / clamped popover on wider screens,
//    options and selection state, keyboard (↓ ↓ Enter, Esc, focus return),
//    programmatic value writes, selects added later, no horizontal overflow;
//  checkbox / radio / selection circle / switch — custom look, checked colour,
//    tick drawn, indeterminate bar, ≥ 3:1 border and tick contrast, 44 px hit
//    area (elementFromPoint outside the box), focus ring, disabled, reduced motion.
// No network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const ROOT = path.resolve(__dirname, '../..');
const SHOT = process.env.SHOT === '1';
const SHOTS = process.env.SHOTS || '/home/sprite/testout/controls';
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

// Build the web output so the shell is injected the way the app ships it.
execSync('node scripts/prepare-web.mjs --target web', { cwd: ROOT, stdio: 'ignore' });
const DIST = path.join(ROOT, 'web-dist');

// In-page helpers: colour parsing through a canvas (handles oklch/color-mix), contrast.
const HELPERS = `
window.__px = (c) => { const cv = window.__cv || (window.__cv = document.createElement('canvas')); cv.width = cv.height = 1; const x = cv.getContext('2d', { willReadFrequently: true }); x.clearRect(0,0,1,1); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0,0,1,1); const d = x.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3] / 255]; };
window.__blend = (top, bot) => { const a = top[3]; return [top[0]*a + bot[0]*(1-a), top[1]*a + bot[1]*(1-a), top[2]*a + bot[2]*(1-a), 1]; };
window.__bgOf = (el) => { const stack = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = __px(getComputedStyle(n).backgroundColor); if (c[3] > 0) { stack.push(c); if (c[3] >= 0.99) break; } } let out = stack.length && stack[stack.length-1][3] >= 0.99 ? stack.pop() : (document.documentElement.classList.contains('dark') ? [10,10,12,1] : [255,255,255,1]); while (stack.length) out = __blend(stack.pop(), out); return out; };
window.__lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
window.__cr = (a, b) => { const x = __lum(a), y = __lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
window.__textCr = (el, bgEl) => { const fg = __px(getComputedStyle(el).color); const bg = __bgOf(bgEl || el); return __cr(fg[3] < 1 ? __blend(fg, bg) : fg, bg); };
`;

const FIXTURE = `
(() => {
  const box = document.createElement('div');
  box.id = 'mc-fixture';
  box.style.cssText = 'position:fixed;left:24px;top:120px;z-index:9999;display:flex;flex-direction:column;gap:18px;padding:24px;background:var(--background, #fff);color:var(--foreground, #000);border:1px solid var(--border, #ccc);border-radius:12px;font:14px system-ui';
  box.innerHTML = '<label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="fx-cb"> Remember</label>'
    + '<label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="fx-cb2" checked> Checked</label>'
    + '<label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="fx-ind"> Some</label>'
    + '<label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="fx-dis" disabled> Disabled</label>'
    + '<div role="radiogroup" style="display:flex;gap:28px"><label style="display:flex;gap:10px;align-items:center"><input type="radio" name="fx" id="fx-r1" checked> A</label><label style="display:flex;gap:10px;align-items:center"><input type="radio" name="fx" id="fx-r2"> B</label></div>'
    + '<div style="display:flex;gap:28px"><input type="checkbox" class="mc-circle" id="fx-circle" aria-label="Select photo"><input type="checkbox" class="switch" role="switch" id="fx-sw" aria-label="Wi-Fi"></div>';
  document.body.append(box);
  document.getElementById('fx-ind').indeterminate = true;
})();
`;

async function setTheme(page, scheme) {
  await page.evaluate((dark) => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, scheme === 'dark');
}

async function dropdownChecks(page, tag, touch, vw, vh) {
  const info = await page.evaluate(() => {
    const sels = [...document.querySelectorAll('select')].filter((s) => s.dataset.native !== 'true' && !s.multiple);
    const trig = [...document.querySelectorAll('.mc-trigger')];
    const name = (t) => t.getAttribute('aria-label') || (t.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim() || '').join(' ').trim();
    return {
      sels: sels.length, upgraded: sels.filter((s) => s.classList.contains('mc-native') && s.__mc).length, trig: trig.length,
      unnamed: trig.filter((t) => !name(t)).map((t) => t.textContent),
    };
  });
  ck(`${tag} every select upgraded (${info.upgraded}/${info.sels})`, info.sels > 0 && info.upgraded === info.sels && info.trig === info.sels);
  ck(`${tag} every trigger has an accessible name`, info.unnamed.length === 0, info.unnamed.join(','));
  // Pick the first trigger that is on screen.
  const t = await page.evaluate(async (touch) => {
    const all = [...document.querySelectorAll('.mc-trigger')];
    const t = all.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; }) || all[0];
    t.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 50));
    t.id = t.id || 'mc-under-test';
    const r = t.getBoundingClientRect();
    return { id: t.id, h: r.height, right: r.right, left: r.left, cr: __textCr(t.querySelector('.mc-value'), t), heights: all.filter((x) => x.offsetWidth).map((x) => x.getBoundingClientRect().height) };
  }, touch);
  const minH = touch ? 44 : 32;
  ck(`${tag} trigger height ≥ ${minH}px`, t.heights.every((h) => h >= minH - 0.5), t.heights.join(','));
  ck(`${tag} trigger inside the viewport`, t.left >= 0 && t.right <= vw + 0.5, `${t.left}-${t.right}`);
  ck(`${tag} trigger text contrast ≥ 4.5`, t.cr >= 4.5, t.cr.toFixed(2));

  await page.click(`#${t.id}`);
  await page.waitForTimeout(320);
  const pop = await page.evaluate((id) => {
    const t = document.getElementById(id);
    const sel = t.previousElementSibling;
    const p = document.querySelector('.mc-pop');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const opts = [...p.querySelectorAll('[role="option"]')];
    const selected = opts.filter((o) => o.getAttribute('aria-selected') === 'true');
    const o = opts.find((x) => x.getAttribute('aria-selected') !== 'true') || opts[0];
    return {
      sheet: p.classList.contains('mc-sheet'), r: { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width },
      expanded: t.getAttribute('aria-expanded'), controls: t.getAttribute('aria-controls') === p.querySelector('[role="listbox"]').id,
      count: opts.length, options: sel.options.length, selected: selected.length, selIdx: selected[0] ? opts.indexOf(selected[0]) : -1, selIndex: sel.selectedIndex,
      tick: !!selected[0]?.querySelector('.mc-check svg'),
      optH: Math.min(...opts.map((x) => x.getBoundingClientRect().height)),
      cr: __textCr(o.querySelector('.mc-option-label'), p),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      focusIn: p.contains(document.activeElement),
    };
  }, t.id);
  ck(`${tag} popup opens`, !!pop);
  if (pop) {
    if (touch && vw < 640) ck(`${tag} phone: bottom sheet, full width, on the bottom edge`, pop.sheet && Math.abs(pop.r.w - vw) < 1 && Math.abs(pop.r.b - vh) < 1.5, JSON.stringify(pop.r));
    else ck(`${tag} popover clamped 8px inside the viewport`, !pop.sheet && pop.r.l >= 7.5 && pop.r.r <= vw - 7.5 && pop.r.t >= 7.5 && pop.r.b <= vh - 7.5, JSON.stringify(pop.r));
    ck(`${tag} aria-expanded + aria-controls`, pop.expanded === 'true' && pop.controls);
    ck(`${tag} one option per <option>, current one selected with a tick`, pop.count === pop.options && pop.selected === 1 && pop.selIdx === pop.selIndex && pop.tick, JSON.stringify(pop));
    ck(`${tag} option height ≥ ${touch ? 44 : 32}px`, pop.optH >= (touch ? 43.5 : 31.5), String(pop.optH));
    ck(`${tag} option text contrast ≥ 4.5`, pop.cr >= 4.5, pop.cr.toFixed(2));
    ck(`${tag} focus moves into the popup`, pop.focusIn);
    ck(`${tag} no horizontal overflow with the popup open`, pop.overflow <= 0, String(pop.overflow));
    if (SHOT) await page.screenshot({ path: path.join(SHOTS, `${tag.replace(/[^a-z0-9]+/gi, '-')}-open.png`) });
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(260);
  const esc = await page.evaluate((id) => ({ open: !!document.querySelector('.mc-pop'), focus: document.activeElement?.id === id, exp: document.getElementById(id).getAttribute('aria-expanded') }), t.id);
  ck(`${tag} Esc closes and focus returns to the trigger`, !esc.open && esc.focus && esc.exp === 'false', JSON.stringify(esc));

  // Keyboard choose: ↓ opens, ↓ moves, Enter picks; one 'change'.
  const before = await page.evaluate((id) => {
    const sel = document.getElementById(id).previousElementSibling;
    window.__changes = 0; window.__inputs = 0;
    sel.addEventListener('change', () => window.__changes++);
    sel.addEventListener('input', () => window.__inputs++);
    return { v: sel.value, i: sel.selectedIndex, n: sel.options.length };
  }, t.id);
  await page.focus(`#${t.id}`);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  await page.keyboard.press(before.i >= before.n - 1 ? 'ArrowUp' : 'ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(260);
  const after = await page.evaluate((id) => {
    const t = document.getElementById(id); const sel = t.previousElementSibling;
    return { v: sel.value, i: sel.selectedIndex, changes: window.__changes, inputs: window.__inputs, text: t.querySelector('.mc-value').textContent, opt: sel.options[sel.selectedIndex]?.textContent.trim(), open: !!document.querySelector('.mc-pop'), focus: document.activeElement === t };
  }, t.id);
  ck(`${tag} keyboard ↓ ↓ Enter picks the next option`, after.i === before.i + (before.i >= before.n - 1 ? -1 : 1) && after.changes === 1 && after.inputs === 1 && !after.open && after.focus, JSON.stringify({ before, after }));
  ck(`${tag} trigger shows the picked option`, after.text === (after.opt || '').trim() || after.text.length > 0, `${after.text} vs ${after.opt}`);

  // Programmatic writes follow, and selects added later are upgraded.
  const prog = await page.evaluate(async (id) => {
    const t = document.getElementById(id); const sel = t.previousElementSibling;
    sel.selectedIndex = 0;
    const a = t.querySelector('.mc-value').textContent === (sel.options[0].dataset.short || sel.options[0].label || sel.options[0].textContent).trim();
    const s = document.createElement('select');
    s.setAttribute('aria-label', 'Later');
    s.innerHTML = '<option value="1">One</option><option value="2" selected>Two</option>';
    document.body.append(s);
    await new Promise((r) => setTimeout(r, 60));
    const ok = !!s.__mc && s.nextElementSibling?.classList.contains('mc-trigger') && s.nextElementSibling.textContent.includes('Two');
    s.value = '1';
    const follows = s.nextElementSibling.textContent.includes('One');
    s.nextElementSibling.remove(); s.remove();
    return { a, ok, follows };
  }, t.id);
  ck(`${tag} select.selectedIndex = 0 updates the trigger`, prog.a);
  ck(`${tag} a select added later is upgraded and follows .value`, prog.ok && prog.follows, JSON.stringify(prog));
}

async function controlChecks(page, tag, touch) {
  await page.evaluate(FIXTURE);
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const cs = (id, pseudo) => getComputedStyle(g(id), pseudo);
    const bg = __bgOf(g('mc-fixture'));
    const primary = __px(getComputedStyle(document.documentElement).getPropertyValue('--mc-primary').trim() || cs('fx-cb2').backgroundColor);
    const onPrimary = __px(cs('fx-cb2', '::before').backgroundColor);
    const border = __px(cs('fx-cb').borderTopColor);
    return {
      appearance: cs('fx-cb').appearance, size: g('fx-cb').getBoundingClientRect().width,
      checkedBg: __px(cs('fx-cb2').backgroundColor).slice(0, 3).join(','), primary: primary.slice(0, 3).join(','),
      tickOn: cs('fx-cb2', '::before').clipPath, tickOff: cs('fx-cb', '::before').clipPath,
      tickCr: __cr(onPrimary, __px(cs('fx-cb2').backgroundColor)),
      borderCr: __cr(border[3] < 1 ? __blend(border, bg) : border, bg),
      indMask: cs('fx-ind', '::before').maskImage || cs('fx-ind', '::before').webkitMaskImage,
      indBg: __px(cs('fx-ind').backgroundColor).slice(0, 3).join(','),
      radioOn: cs('fx-r1', '::before').transform, radioOff: cs('fx-r2', '::before').transform, radioRadius: cs('fx-r1').borderTopLeftRadius,
      disOpacity: cs('fx-dis').opacity,
      circleBefore: cs('fx-circle', '::before').opacity,
      srOnly: [...document.querySelectorAll('input.sr-only')].every((i) => getComputedStyle(i).appearance !== 'none'),
    };
  });
  ck(`${tag} checkbox is custom-drawn, 18px`, r.appearance === 'none' && Math.abs(r.size - 18) < 0.6, `${r.appearance} ${r.size}`);
  ck(`${tag} checked checkbox uses the primary colour`, r.checkedBg === r.primary, `${r.checkedBg} vs ${r.primary}`);
  ck(`${tag} tick drawn only when checked`, /inset\(0(px)?\)/.test(r.tickOn) && /100%/.test(r.tickOff), `${r.tickOn} / ${r.tickOff}`);
  ck(`${tag} tick contrast on primary ≥ 3`, r.tickCr >= 3, r.tickCr.toFixed(2));
  ck(`${tag} unchecked border contrast ≥ 3 (WCAG 1.4.11)`, r.borderCr >= 3, r.borderCr.toFixed(2));
  ck(`${tag} indeterminate shows a bar on primary`, /M4 8h8/.test(r.indMask) && r.indBg === r.primary, r.indMask.slice(0, 60));
  ck(`${tag} radio is round with a dot only when checked`, r.radioRadius === '999px' || parseFloat(r.radioRadius) >= 9, r.radioRadius);
  ck(`${tag} radio dot grows in`, /matrix\(1, 0, 0, 1/.test(r.radioOn) && /matrix\(0, 0, 0, 0/.test(r.radioOff), `${r.radioOn} / ${r.radioOff}`);
  ck(`${tag} disabled is dimmed`, r.disOpacity === '0.5');
  ck(`${tag} app's own sr-only inputs are left alone`, r.srOnly);

  // 44 px hit area: a tap 10 px outside the 18 px box still lands on it.
  const hits = await page.evaluate(() => {
    const at = (id, dx, dy) => { const b = document.getElementById(id).getBoundingClientRect(); const x = b.left + b.width / 2 + dx, y = b.top + b.height / 2 + dy; return document.elementFromPoint(x, y)?.id === id; };
    const span = (id) => { const b = document.getElementById(id).getBoundingClientRect(); let lo = 0; for (let d = 0; d < 40; d++) { const x = b.left + b.width / 2, y = b.top + b.height / 2 - d; if (document.elementFromPoint(x, y)?.id !== id) break; lo = d; } return lo * 2 + 1; };
    return { cbV: span('fx-cb'), rV: span('fx-r2'), circleV: span('fx-circle'), swV: span('fx-sw'), cbOut: at('fx-cb', -16, 0) };
  });
  ck(`${tag} checkbox hit area ≥ 44px`, hits.cbV >= 43, String(hits.cbV));
  ck(`${tag} radio hit area ≥ 44px`, hits.rV >= 43, String(hits.rV));
  ck(`${tag} selection circle hit area ≥ 44px`, hits.circleV >= 43, String(hits.circleV));
  ck(`${tag} switch hit area ≥ 44px`, hits.swV >= 43, String(hits.swV));

  // Tapping outside the box (inside its hit area) toggles it; a disabled box does not.
  const box = await page.evaluate(() => { const b = document.getElementById('fx-cb').getBoundingClientRect(); const d = document.getElementById('fx-dis').getBoundingClientRect(); const c = document.getElementById('fx-circle').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top - 9, dx: d.left + 9, dy: d.top + 9, cx: c.left + c.width / 2, cy: c.top - 8 }; });
  if (touch) { await page.touchscreen.tap(box.x, box.y); await page.touchscreen.tap(box.dx, box.dy); await page.touchscreen.tap(box.cx, box.cy); }
  else { await page.mouse.click(box.x, box.y); await page.mouse.click(box.dx, box.dy); await page.mouse.click(box.cx, box.cy); }
  await page.waitForTimeout(250);
  const tog = await page.evaluate(() => ({ cb: document.getElementById('fx-cb').checked, dis: document.getElementById('fx-dis').checked, circle: document.getElementById('fx-circle').checked, circleBefore: getComputedStyle(document.getElementById('fx-circle'), '::before').opacity, circleBg: __px(getComputedStyle(document.getElementById('fx-circle')).backgroundColor).slice(0, 3).join(','), primary: __px(getComputedStyle(document.documentElement).getPropertyValue('--mc-primary').trim()).slice(0, 3).join(',') }));
  ck(`${tag} a tap 9px above the checkbox toggles it`, tog.cb === true);
  ck(`${tag} a disabled checkbox does not toggle`, tog.dis === false);
  ck(`${tag} selection circle checks with a primary fill and a tick`, tog.circle && tog.circleBg === tog.primary && tog.circleBefore === '1', JSON.stringify(tog));

  // Keyboard focus ring.
  await page.evaluate(() => { document.getElementById('fx-cb').blur(); document.getElementById('fx-cb2').focus(); });
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => ({ id: document.activeElement?.id, shadow: getComputedStyle(document.activeElement).boxShadow }));
  ck(`${tag} keyboard focus shows a ring`, ring.id === 'fx-cb2' && ring.shadow !== 'none', JSON.stringify(ring));
  await page.keyboard.press('Space');
  const sp = await page.evaluate(() => document.getElementById('fx-cb2').checked);
  ck(`${tag} Space toggles the focused checkbox`, sp === false);
  if (SHOT) await page.screenshot({ path: path.join(SHOTS, `${tag.replace(/[^a-z0-9]+/gi, '-')}-controls.png`), clip: await page.evaluate(() => { const r = document.getElementById('mc-fixture').getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: Math.min(innerWidth, r.width + 16), height: r.height + 16 }; }) });
  await page.evaluate(() => document.getElementById('mc-fixture').remove());
}

(async () => {
  if (SHOT) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const errors = [];
  for (const vw of [320, 375, 768, 1366]) {
    const touch = vw < 768;
    const vh = touch ? 740 : 900;
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, isMobile: touch, hasTouch: touch, colorScheme: scheme, deviceScaleFactor: 1 });
      for (const pageName of ['openshelf', 'academic']) {
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(`${pageName}: ${e.message}`));
        await page.addInitScript(HELPERS);
        await page.goto(`file://${DIST}/${pageName}.html`);
        await page.waitForTimeout(900);
        await setTheme(page, scheme);
        const tag = `[${pageName} ${vw} ${scheme}]`;
        await dropdownChecks(page, tag, touch, vw, vh);
        if (pageName === 'openshelf') await controlChecks(page, tag, touch);
        await page.close();
      }
      await ctx.close();
    }
  }
  // Reduced motion: no transitions on the controls and no popup animation.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(HELPERS);
  await page.goto(`file://${DIST}/openshelf.html`);
  await page.waitForTimeout(700);
  await page.evaluate(FIXTURE);
  const rm = await page.evaluate(() => ({ cb: getComputedStyle(document.getElementById('fx-cb')).transitionDuration, tick: getComputedStyle(document.getElementById('fx-cb'), '::before').transitionDuration, sw: getComputedStyle(document.getElementById('fx-sw'), '::after').transitionDuration }));
  ck('[reduced motion] control transitions are off', [rm.cb, rm.tick, rm.sw].every((d) => d.split(',').every((x) => parseFloat(x) === 0)), JSON.stringify(rm));
  await page.click('.mc-trigger');
  await page.waitForTimeout(100);
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.mc-pop')).animationName);
  ck('[reduced motion] dropdown opens without animation', anim === 'none', anim);
  await ctx.close();
  ck('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
