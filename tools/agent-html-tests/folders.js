// Shared folders: the Folders control sheet and the folder_* tool rows, in real
// headless Chromium at 320/375/768/1366 px, light and dark. A fake
// window.NativeKit.folders stands in for the native plugin (Android SAF / iOS
// bookmarks), so this checks the UI contract: add, list, mode switch, remove,
// revoked and read-only states, and the chat rows naming the folder they touch.
const path = require('path');
const fs = require('fs');
const PW = process.env.PW || '/tmp/pw/node_modules/playwright-core';
const { chromium } = require(PW);
const HERE = __dirname;
const APP = process.env.AGENT_HTML || path.resolve(HERE, '../../www/agent.html');
const URL = 'file://' + APP;
const MOCK = fs.readFileSync(process.env.MOCK_JS || path.join(HERE, 'mock3.js'), 'utf8') + '\n' + fs.readFileSync(path.join(HERE, 'mock-v2.js'), 'utf8');
const EXE = process.env.EXE || process.env.CHROMIUM || (() => {
  const base = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright');
  const dir = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop() : null;
  return dir ? path.join(base, dir, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined;
})();

const FOLDER_MOCK = `
(() => {
  const state = window.__fo = {
    folders: [
      { id: 'f1', name: 'Documents', mode: 'readwrite', canWrite: true, available: true, location: 'Internal storage \u203a Documents' },
      { id: 'f2', name: 'Camera', mode: 'read', canWrite: true, available: true, location: 'Internal storage \u203a DCIM \u203a Camera' },
      { id: 'f3', name: 'Old SD card folder with a really long name that must wrap nicely', mode: 'read', canWrite: true, available: false, reason: 'Android no longer grants access to it', location: 'SD card (1A2B-3C4D) \u203a Backup' },
      { id: 'f4', name: 'Drive', mode: 'read', canWrite: false, available: true, location: 'Google Drive' },
    ],
    calls: [],
    nextAdd: { id: 'f9', name: 'Agent', mode: 'read', canWrite: true, available: true, location: 'Internal storage \u203a Download \u203a Agent' },
    cancelNext: false,
  };
  const folders = {
    supported: () => true,
    list: async () => { state.calls.push(['list']); return { folders: state.folders.map((f) => ({ ...f })) }; },
    add: async (o) => {
      state.calls.push(['add', o]);
      if (state.cancelNext) { state.cancelNext = false; throw Object.assign(new Error('No folder was picked'), { code: 'CANCELLED' }); }
      const f = { ...state.nextAdd, mode: o?.mode || 'read' };
      state.folders.push(f);
      return { folder: f };
    },
    setMode: async (id, mode) => { state.calls.push(['setMode', id, mode]); const f = state.folders.find((x) => x.id === id); f.mode = mode; return { mode }; },
    remove: async (id) => { state.calls.push(['remove', id]); state.folders = state.folders.filter((x) => x.id !== id); return { removed: true }; },
  };
  const install = () => { if (window.NativeKit) window.NativeKit.folders = folders; };
  install();
  const t = setInterval(install, 5);
  setTimeout(() => clearInterval(t), 3000);
})();
`;

let pass = 0, fail = 0;
const failures = [];
const check = (ok, label) => { if (ok) pass += 1; else { fail += 1; failures.push(label); console.log('FAIL', label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, width, scheme) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme, hasTouch: width < 800 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.addInitScript(MOCK);
  await p.addInitScript(FOLDER_MOCK);
  await p.goto(URL);
  await p.waitForFunction(() => !!window.__app && !!window.__folders, null, { timeout: 15000 });
  await p.evaluate((s) => { try { window.__app.setTheme?.(s); } catch { /* optional */ } document.documentElement.classList.toggle('dark', s === 'dark'); }, scheme);
  await sleep(150);
  return { ctx, p, errors };
}

async function openFolders(p) {
  const btn = p.locator('.fo-open').first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  else await p.evaluate(() => window.__folders.open(window.__app));
  await p.waitForSelector('.fo-dialog .fo-item', { timeout: 5000 });
}

async function noOverflow(p) {
  return p.evaluate(() => {
    const panel = document.querySelector('.fo-dialog');
    const over = document.documentElement.scrollWidth > window.innerWidth + 1;
    const panelOver = panel ? panel.scrollWidth > panel.clientWidth + 1 : false;
    return !over && !panelOver;
  });
}

// WCAG contrast of an element's text against the nearest opaque background.
async function contrast(p, sel) {
  return p.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    // Paint each colour on a canvas: computed colours may be oklch()/color(), which a regex misreads.
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const parse = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const toRgb = (c) => c;
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let bgEl = el, bg;
    while (bgEl) { const c = parse(toRgb(getComputedStyle(bgEl).backgroundColor)); if ((c[3] ?? 1) > 0.9 && getComputedStyle(bgEl).backgroundColor !== 'rgba(0, 0, 0, 0)') { bg = c; break; } bgEl = bgEl.parentElement; }
    bg = bg || [255, 255, 255];
    const fg = parse(toRgb(getComputedStyle(el).color));
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }, sel);
}

async function emit(p, events) {
  await p.evaluate((evs) => { for (const e of evs) window.__emit?.(e); }, events);
  await sleep(80);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  for (const width of [320, 375, 768, 1366]) {
    for (const scheme of ['light', 'dark']) {
      const tag = `${width}/${scheme}`;
      const { ctx, p, errors } = await open(browser, width, scheme);

      // Sidebar entry exists.
      check(await p.locator('.fo-open').count() > 0, `${tag} sidebar has a Folders button`);
      await openFolders(p);
      const items = await p.locator('.fo-dialog .fo-item').count();
      check(items === 4, `${tag} lists the 4 granted folders (got ${items})`);
      check(await noOverflow(p), `${tag} no sideways scrolling in the sheet`);

      // States.
      const lost = p.locator('.fo-item[data-id="f3"]');
      check((await lost.getAttribute('data-available')) === 'false', `${tag} lost folder is marked unavailable`);
      check(/Access lost/.test(await lost.locator('.fo-status').innerText()), `${tag} lost folder says access is lost`);
      check(await lost.locator('input[value="readwrite"]').isDisabled(), `${tag} lost folder mode is disabled`);
      const drive = p.locator('.fo-item[data-id="f4"]');
      check(await drive.locator('input[value="readwrite"]').isDisabled(), `${tag} read-only OS grant cannot be switched to write`);
      check(/read-only/.test(await drive.locator('.fo-status').innerText()), `${tag} read-only OS grant explains why`);
      check(await p.locator('.fo-item[data-id="f1"] input[value="readwrite"]').isChecked(), `${tag} Documents shows Read & write`);
      check(await p.locator('.fo-item[data-id="f2"] input[value="read"]').isChecked(), `${tag} Camera shows Read-only`);
      check(/Internal storage/.test(await p.locator('.fo-item[data-id="f1"] .fo-where').innerText()), `${tag} location is shown`);

      // Tap targets and contrast.
      const sizes = await p.evaluate(() => [...document.querySelectorAll('.fo-dialog .fo-remove, .fo-dialog .fo-seg-opt, .fo-dialog .fo-add, .fo-dialog .fo-limits summary')]
        .map((el) => { const r = el.getBoundingClientRect(); return [el.className, Math.round(r.width), Math.round(r.height)]; }));
      check(sizes.length >= 11 && sizes.every(([, w, hgt]) => hgt >= 40 && w >= 40), `${tag} controls are at least 40 px (${JSON.stringify(sizes.filter(([, w, hgt]) => hgt < 40 || w < 40))})`);
      const cName = await contrast(p, '.fo-item[data-id="f1"] .fo-name');
      const cWhere = await contrast(p, '.fo-item[data-id="f1"] .fo-where');
      const cSeg = await contrast(p, '.fo-item[data-id="f1"] .fo-seg-opt:has(input:checked)');
      check(cName >= 4.5 && cWhere >= 4.5 && cSeg >= 4.5, `${tag} text contrast >= 4.5 (name ${cName.toFixed(2)}, location ${cWhere.toFixed(2)}, selected mode ${cSeg.toFixed(2)})`);
      const named = await p.evaluate(() => [...document.querySelectorAll('.fo-dialog button')].every((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().length > 0));
      check(named, `${tag} every button has an accessible name`);
      check(await p.locator('.fo-item[data-id="f2"] [role="radiogroup"]').getAttribute('aria-label') === 'Access to Camera', `${tag} mode group is labelled`);

      // Switch Camera to Read & write.
      await p.locator('.fo-item[data-id="f2"] .fo-seg-opt').nth(1).click();
      await sleep(150);
      const setCall = await p.evaluate(() => window.__fo.calls.find((c) => c[0] === 'setMode'));
      check(JSON.stringify(setCall) === JSON.stringify(['setMode', 'f2', 'readwrite']), `${tag} mode switch calls setMode(f2, readwrite)`);
      check(await p.locator('.fo-item[data-id="f2"] input[value="readwrite"]').isChecked(), `${tag} Camera now shows Read & write`);
      check(/asks you first/.test(await p.locator('.fo-item[data-id="f2"] .fo-status').innerText()), `${tag} write mode says changes ask first`);

      // Keyboard: arrow keys move within the radio group.
      await p.locator('.fo-item[data-id="f2"] input[value="readwrite"]').focus();
      await p.keyboard.press('ArrowLeft');
      await sleep(150);
      check(await p.locator('.fo-item[data-id="f2"] input[value="read"]').isChecked(), `${tag} arrow key switches back to Read-only`);

      // Add: cancelled picker changes nothing, a picked folder appears.
      await p.evaluate(() => { window.__fo.cancelNext = true; });
      await p.locator('.fo-add').click();
      await sleep(150);
      check(await p.locator('.fo-dialog .fo-item').count() === 4, `${tag} cancelled picker adds nothing`);
      await p.locator('.fo-add').click();
      await p.waitForSelector('.fo-item[data-id="f9"]', { timeout: 3000 }).catch(() => {});
      check(await p.locator('.fo-item[data-id="f9"]').count() === 1, `${tag} picked folder is listed`);
      const addCall = await p.evaluate(() => window.__fo.calls.filter((c) => c[0] === 'add').pop());
      check(addCall && addCall[1].mode === 'read', `${tag} new folders start read-only`);

      // Remove asks, then revokes.
      await p.locator('.fo-item[data-id="f9"] .fo-remove').click();
      const confirm = p.locator('[role="alertdialog"], [role="dialog"]').filter({ hasText: 'Stop sharing Agent?' }).last();
      await confirm.waitFor({ timeout: 3000 }).catch(() => {});
      check(await confirm.isVisible().catch(() => false), `${tag} remove asks for confirmation`);
      check(await p.evaluate(() => !window.__fo.calls.some((c) => c[0] === 'remove')), `${tag} nothing removed before confirming`);
      await confirm.getByRole('button', { name: 'Remove' }).click();
      await sleep(250);
      check(await p.evaluate(() => JSON.stringify(window.__fo.calls.find((c) => c[0] === 'remove')) === '["remove","f9"]'), `${tag} confirming calls remove(f9)`);
      check(await p.locator('.fo-item[data-id="f9"]').count() === 0, `${tag} removed folder disappears`);
      check(await noOverflow(p), `${tag} still no sideways scrolling`);

      // Limits explainer.
      await p.locator('.fo-limits summary').click();
      check(/Android\/data/.test(await p.locator('.fo-limits').innerText()), `${tag} explains the Android 11 picker limits`);

      // Close and check the tool rows in chat.
      await p.keyboard.press('Escape');
      await sleep(150);
      await p.evaluate(() => window.__app.startNewChat?.());
      await sleep(150);
      // One agent turn through the mock bridge, the way genui.js drives it.
      await p.locator('.aui-composer-input').first().fill('Tidy my Documents folder');
      await p.locator('.aui-composer-send').first().click();
      await sleep(250);
      const k = await p.evaluate(() => {
        const c = window.__mock.calls;
        return [...c].reverse().find((x) => x.name === 'agent.resumeSession')?.args?.sessionKey || [...c].reverse().find((x) => x.name === 'agent.sendMessage')?.args?.sessionKey || 'main';
      });
      const R = (id, name, args, output, isError = false) => [
        ['tool_use', { toolCallId: id, toolName: name, args }],
        ['tool_result', { toolCallId: id, result: { output, isError } }],
      ];
      const evs = [
        ...R('t1', 'device__list_folders', {}, 'Shared folders (2):\n- "Documents" (id f1): read & write (changes ask the user first)\n- "Camera" (id f2): read-only'),
        ...R('t2', 'device__folder_list', { folder: 'Documents', path: 'notes' }, 'Documents/notes: 2 items\n<untrusted_folder_listing>\ndrafts/\ntodo.md  1.2 KB  2026-11-14\n</untrusted_folder_listing>'),
        ...R('t3', 'device__folder_read', { folder: 'Documents', path: 'notes/todo.md' }, 'Documents/notes/todo.md (1.2 KB):\n<untrusted_folder_file>\n# Todo\n- milk\n</untrusted_folder_file>'),
        ...R('t4', 'device__folder_delete', { folder: 'Documents', path: 'old/draft.txt' }, 'Deleted "Documents/old/draft.txt".'),
        ...R('t5', 'device__folder_copy', { folder: 'Camera', direction: 'to_workspace', path: 'IMG_1.jpg', workspace_path: 'imports/IMG_1.jpg' }, 'Copied'),
        ...R('t6', 'device__folder_write', { folder: 'Camera', path: 'x.txt', content: 'x' }, '"Camera" is read-only.', true),
      ];
      // A long copy still running: progress and Cancel on its row.
      await p.evaluate(([k, evs]) => {
        for (const [name, payload] of evs) window.__mock.emit(name, { sessionKey: k, ...payload });
        window.__cancelled = [];
        window.NativeKit.agent.cancelToolCall = (id) => { window.__cancelled.push(id); return true; };
        window.__mock.emit('tool_use', { sessionKey: k, toolCallId: 't7', toolName: 'device__folder_copy', args: { folder: 'Camera', direction: 'to_workspace', path: 'VID_2.mp4', workspace_path: 'VID_2.mp4' } });
      }, [k, evs]);
      await sleep(250);
      await p.evaluate(() => window.dispatchEvent(new CustomEvent('nativekit:tool-progress', { detail: { toolCallId: 't7', progress: 52428800, total: 209715200 } })));
      await sleep(150);
      const prog = await p.evaluate(() => {
        const w = document.querySelector('[data-slot="tool-progress"][data-tool-call-id="t7"]');
        if (!w) return null;
        const b = w.querySelector('[data-slot="tool-cancel"]').getBoundingClientRect();
        return { text: w.querySelector('.aui-tool-progress-text').textContent, now: w.querySelector('[role=progressbar]').getAttribute('aria-valuenow'), fill: w.querySelector('.aui-tool-progress-fill').style.width, h: b.height, inView: b.right <= window.innerWidth + 1 };
      });
      check(!!prog && /52\.4 MB of 209\.7 MB|50(\.0)? MB of 200(\.0)? MB/.test(prog.text) && prog.now === '25' && prog.fill === '25%', `${tag} a running copy shows its progress (${JSON.stringify(prog)})`);
      check(!!prog && prog.h >= 44 && prog.inView, `${tag} its Cancel button is 44 px tall and on screen`);
      check(await contrast(p, '.aui-tool-progress-text') >= 4.5, `${tag} progress text has readable contrast`);
      check(await noOverflow(p), `${tag} no sideways scrolling with the progress row`);
      await p.locator('[data-tool-call-id="t7"] [data-slot="tool-cancel"]').click();
      await sleep(100);
      const after = await p.evaluate(() => ({ calls: window.__cancelled, text: document.querySelector('[data-tool-call-id="t7"] .aui-tool-progress-text')?.textContent, disabled: document.querySelector('[data-tool-call-id="t7"] [data-slot="tool-cancel"]')?.disabled }));
      check(after.calls.join() === 't7' && /Stopping/.test(after.text) && after.disabled, `${tag} Cancel stops just that tool call (${JSON.stringify(after)})`);
      await p.evaluate((k) => {
        window.__mock.emit('tool_result', { sessionKey: k, toolCallId: 't7', result: { output: 'The copy was stopped because the user cancelled it. the workspace file "VID_2.mp4" was not created or changed (the partial copy was deleted).', isError: true } });
        window.__mock.emit('agent.completed', { sessionKey: k });
      }, k);
      await sleep(300);
      check(await p.locator('[data-slot="tool-progress"]').count() === 0, `${tag} the progress row goes away when the copy ends`);
      const rows = await p.evaluate(() => [...document.querySelectorAll('.aui-tool-fallback-root, [data-slot="tool"], [data-tool-name]')].map((el) => { const c = el.cloneNode(true); c.querySelectorAll('.aui-tool-raw').forEach((r) => r.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); }));
      const all = rows.join(' | ');
      check(/Checked shared folders/.test(all), `${tag} list_folders row (${rows.length} rows)`);
      check(/Listed Documents\/notes/.test(all), `${tag} folder_list row names the folder`);
      check(/Read Documents\/notes\/todo\.md/.test(all), `${tag} folder_read row names the file`);
      check(/Deleted Documents\/old\/draft\.txt/.test(all), `${tag} folder_delete row names the file`);
      check(/Copied Camera\/IMG_1\.jpg \u2192 workspace\/imports\/IMG_1\.jpg/.test(all), `${tag} folder_copy row shows both ends`);
      check(/Could not write Camera\/x\.txt/.test(all), `${tag} failed write row says it failed`);
      check(!/untrusted_folder/.test(all) && !/"structuredContent"|\{"content"/.test(all), `${tag} no raw JSON or wrapper tags in rows`);
      check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag} chat has no sideways scrolling`);
      check(errors.length === 0, `${tag} no page errors (${errors.slice(0, 2).join(' / ')})`);
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`folders: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
