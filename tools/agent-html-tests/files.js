// Files manager checks: listing (workspace + uploads in saved chats + library + agent-created),
// search / filter / sort with the custom dropdown, previews (text, code, markdown, image, CSV),
// delete (workspace file via invokeTool('delete_file'); upload via purgeAttachment when the engine
// lists it), and the composer's Recent / Browse picker that re-attaches without uploading.
// Mock NativeKit only; no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep, overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = require('path').join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = require('fs').existsSync(b) ? require('fs').readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? require('path').join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${require('path').resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/impl/shots-fm';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync('/home/sprite/impl/test/mock3.js', 'utf8');
const { schemaGuard } = require('./tool-schemas.js');
// Previews and the attach picker read workspace files through the app's own
// reader (bridge/workspace-files.ts), not the model's read_file tool.
const { realWorkspaceScript } = require('./workspace-real.js');
const mockV2 = fs.readFileSync('/home/sprite/impl/test/mock-v2.js', 'utf8');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Workspace, saved chats with attachments, and purgeAttachment, on top of the shared mock.
const mockFiles = (purge) => `(() => {
  const a = window.NativeKit.agent;
  const rec = (name, args) => window.__mock.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
  const now = Date.now();
  const ws = {
    '.': [{ name: 'notes.md', type: 'file', size: 812, modified: now - 7200e3 }, { name: 'src', type: 'directory' }, { name: 'data', type: 'directory' }, { name: '.git', type: 'directory' }],
    'src': [{ name: 'app.ts', type: 'file', size: 2048, modified: now - 600e3 }],
    'data': [{ name: 'marks.csv', type: 'file', size: 64, modified: now - 172800e3 }],
  };
  const content = {
    'notes.md': '# Notes\\n\\n- **Routine** for CSE 201\\n- Lab report due Thursday\\n\\n| Day | Room |\\n|---|---|\\n| Sun | 304 |',
    'src/app.ts': 'export function greet(name: string): string {\\n  return \\'Hello \\' + name;\\n}\\n',
    'data/marks.csv': 'Name,Marks,Grade\\nAkib,91,A+\\nRafi,72,B\\n"Mim, K",88,A',
  };
  window.__ws = window.__ws || {};
  window.__ws.files = Object.assign(window.__ws.files || {}, Object.fromEntries(Object.entries(content).map(([k, v]) => [k, new TextEncoder().encode(v)])));
  const fp = '<attached-file name="routine.txt">\\nSun 9:00 CSE 201\\nMon 11:00 MAT 203\\n</attached-file>';
  const sessions = [
    { sessionKey: 'chat-files-1', provider: 'auto', model: 'kilo-auto/free', updatedAt: now - 1800e3 },
    { sessionKey: 'chat-files-2', provider: 'auto', model: 'kilo-auto/free', updatedAt: now - 90000e3 },
  ];
  const stored = {
    'chat-files-1': [
      { role: 'user', content: [{ type: 'text', text: 'Read this ' + fp }, { type: 'image', media_type: 'image/png', data: '${PNG}' }], createdAt: now - 1800e3 },
      { role: 'assistant', content: 'Saved it.', tool_calls: [{ id: 't1', name: 'write_file', input: { path: 'notes.md', content: 'x' } }], createdAt: now - 1790e3 },
    ],
    'chat-files-2': [{ role: 'user', content: 'Again ' + fp, createdAt: now - 90000e3 }, { role: 'assistant', content: 'OK' }],
  };
  const listS = a.listSessions, loadS = a.loadSession, inv = a.invokeTool;
  a.listSessions = async (x) => { const r = await listS(x); const base = JSON.parse(r.sessionsJson); return { sessionsJson: JSON.stringify([...sessions, ...base]) }; };
  a.loadSession = async (k, x) => stored[k] ? (rec('agent.loadSession', [k, x]), { messagesJson: JSON.stringify(stored[k]) }) : loadS(k, x);
  a.invokeTool = async (n, x) => {
    const args = typeof x === 'string' ? JSON.parse(x) : x;
    if (n === 'list_files') { rec('agent.invokeTool', [n, x]); const p = (args && args.path) || '.'; return { resultJson: JSON.stringify({ path: p, entries: ws[p] || [] }) }; }
    if (n === 'read_file' && content[args.path] != null) { rec('agent.invokeTool', [n, x]); return { resultJson: JSON.stringify({ path: args.path, content: content[args.path], size: content[args.path].length }) }; }
    if (n === 'delete_file') {
      rec('agent.invokeTool', [n, x]);
      const parts = args.path.split('/'); const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      ws[dir] = (ws[dir] || []).filter((e) => e.name !== parts[parts.length - 1]);
      return { resultJson: JSON.stringify({ deleted: args.path, deletedBytes: 10 }) };
    }
    return inv(n, x);
  };
  if (${purge}) {
    const gf = a.getEngineFeatures;
    a.getEngineFeatures = async () => { const r = await gf(); return { ...r, features: [...r.features, 'purgeAttachment'] }; };
    a.purgeAttachment = async (spec) => {
      rec('agent.purgeAttachment', spec);
      const keys = spec.sessionKeys || Object.keys(stored);
      const hit = [];
      for (const k of keys) {
        const msgs = stored[k]; if (!msgs) continue;
        let n = 0;
        for (const m of msgs) {
          if (m.role !== 'user') continue;
          if (spec.name) {
            const fix = (t) => { const o = '<attached-file name="' + spec.name + '">'; let i; while ((i = t.indexOf(o)) >= 0) { const j = t.indexOf('</attached-file>', i); if (j < 0) break; t = t.slice(0, i) + '[file deleted by the user]' + t.slice(j + 16); n++; } return t; };
            if (typeof m.content === 'string') m.content = fix(m.content); else m.content = m.content.map((b) => b.type === 'text' ? { ...b, text: fix(b.text) } : b);
          }
          if (spec.imageSha256 && Array.isArray(m.content)) { const before = m.content.length; m.content = m.content.filter((b) => b.type !== 'image'); n += before - m.content.length; }
        }
        if (n) hit.push(k);
      }
      return { sessions: hit, messages: hit.length };
    };
  }
})();`;

const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

async function open(browser, w, hgt, mobile, dark, purge = true) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(mockV2);
  await ctx.addInitScript(mockFiles(purge));
  await ctx.addInitScript(realWorkspaceScript());
  await ctx.addInitScript(schemaGuard);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await p.evaluate(() => window.__agentEngine.load(true));
  await sleep(250);
  return { p, ctx, errs };
}
const calls = (p) => p.evaluate(() => window.__mock.calls);
const rowNames = (p) => p.evaluate(() => [...document.querySelectorAll('.fm-dialog .fm-row .fm-name')].map((e) => e.textContent));
const inView = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length).every((e) => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }), sel);
const noPageScrollX = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1);

async function openManager(p, mobile) {
  if (mobile) {
    const t = await p.$('[aria-label="Toggle sidebar"]');
    if (t && await t.isVisible()) { await t.click(); await sleep(300); }
  }
  const btn = (await p.$$('.fm-open')).find(Boolean);
  let clicked = false;
  for (const b of await p.$$('.fm-open')) if (await b.isVisible()) { await b.click(); clicked = true; break; }
  
  await p.waitForSelector('.fm-dialog .fm-row', { timeout: 6000 });
  await sleep(200);
  return clicked || !!btn;
}
async function pickDropdown(p, label, optionText) {
  const trig = await p.$(`.fm-dialog .dd-trigger[aria-label^="${label}"]`);
  if (!trig) return false;
  await trig.click();
  await sleep(250);
  const opt = (await p.$$('.dd-option, [role="option"]')).filter(Boolean);
  for (const o of opt) { if ((await o.textContent()).trim().startsWith(optionText) && await o.isVisible()) { await o.click(); await sleep(250); return true; } }
  await p.keyboard.press('Escape');
  return false;
}

async function run(browser, size, dark) {
  const [wh, m] = [size.replace('m', ''), size.endsWith('m')];
  const [w, hgt] = wh.split('x').map(Number);
  const tag = `[${w}${m ? ' mobile' : ''}${dark ? ' dark' : ''}]`;
  const shot = process.env.SHOT && w === 390;
  const { p, ctx, errs } = await open(browser, w, hgt, m, dark);
  await p.evaluate(() => { window.__app = window.__app || null; });
  // Remember a file the user attaches from the device (goes into the library and Recent).
  await p.setInputFiles('.aui-composer-root input[type=file]', { name: 'lab-report.md', mimeType: 'text/markdown', buffer: Buffer.from('# Lab report\n\nTitration of HCl.\n') });
  await sleep(500);
  const tiles = await p.$$eval('.aui-composer-attachments .aui-attachment-tile, .aui-attachment-tile', (els) => els.length);
  ck(`${tag} device upload still attaches`, tiles >= 1, String(tiles));
  // clear it
  await p.evaluate(() => { const c = document.querySelector('.aui-composer-root'); });
  for (const x of await p.$$('.aui-attachment-tile-remove')) await x.click().catch(() => {});

  const viaButton = await openManager(p, m);
  ck(`${tag} Files opens from the sidebar`, viaButton);
  let names = await rowNames(p);
  const want = ['notes.md', 'app.ts', 'marks.csv', 'routine.txt', 'lab-report.md'];
  ck(`${tag} lists workspace, chat uploads and library files`, want.every((n) => names.includes(n)) && names.some((n) => /^image-.*\.png$/.test(n)), JSON.stringify(names));
  ck(`${tag} hidden folders are skipped`, !(await calls(p)).some((c) => c.name === 'agent.invokeTool' && JSON.stringify(c.args).includes('.git')));
  const routine = await p.evaluate(() => [...document.querySelectorAll('.fm-dialog .fm-name')].filter((e) => e.textContent === 'routine.txt').length);
  ck(`${tag} the same upload in two chats shows once`, routine === 1, String(routine));
  const meta = await p.evaluate(() => { const r = [...document.querySelectorAll('.fm-dialog .fm-row')].find((x) => x.querySelector('.fm-name').textContent === 'notes.md'); return r && r.querySelector('.fm-meta').textContent; });
  ck(`${tag} rows show type, size, date and source`, /MD/.test(meta) && /812 B|0\.8 KB|812/.test(meta) && /Workspace/.test(meta) && /By agent/.test(meta), meta);
  ck(`${tag} manager has no page sideways scroll`, await noPageScrollX(p));
  ck(`${tag} rows stay on screen`, await inView(p, '.fm-dialog .fm-row'));
  const dd = await p.$$eval('.fm-dialog .dd-trigger', (e) => e.length);
  ck(`${tag} filters use the custom dropdown`, dd === 3, String(dd));
  if (shot) await p.screenshot({ path: `${SHOTS}/files-manager-${w}${dark ? '-dark' : ''}.png` });

  // search
  await p.fill('.fm-dialog .fm-search input', 'mark');
  await sleep(200);
  names = await rowNames(p);
  ck(`${tag} search filters by name`, names.length === 1 && names[0] === 'marks.csv', JSON.stringify(names));
  await p.fill('.fm-dialog .fm-search input', '');
  await sleep(150);
  // filter by type and source
  ck(`${tag} type filter opens`, await pickDropdown(p, 'Filter by type', 'Images'));
  names = await rowNames(p);
  ck(`${tag} type filter shows only images`, names.length === 1 && /\.png$/.test(names[0]), JSON.stringify(names));
  await pickDropdown(p, 'Filter by type', 'All types');
  ck(`${tag} source filter opens`, await pickDropdown(p, 'Filter by source', 'Uploaded'));
  names = await rowNames(p);
  ck(`${tag} source filter shows only uploads`, names.length === 3 && names.includes('routine.txt') && !names.includes('app.ts'), JSON.stringify(names));
  await pickDropdown(p, 'Filter by source', 'All sources');
  await pickDropdown(p, 'Sort files', 'Largest');
  names = await rowNames(p);
  ck(`${tag} sort by size`, names[0] === 'app.ts', JSON.stringify(names));
  await pickDropdown(p, 'Sort files', 'Name A');
  names = await rowNames(p);
  ck(`${tag} sort by name`, JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))), JSON.stringify(names));
  await pickDropdown(p, 'Sort files', 'Newest');

  const openRow = async (name) => {
    const rows = await p.$$('.fm-dialog .fm-row');
    for (const r of rows) if ((await r.$eval('.fm-name', (e) => e.textContent)) === name) { await (await r.$('.fm-row-main')).click(); break; }
    await p.waitForSelector('.fm-preview-dialog .fm-preview-body, .fm-preview-dialog .fm-note', { timeout: 4000 });
    await sleep(250);
  };
  const closeTop = async () => { await p.keyboard.press('Escape'); await sleep(250); };
  // previews
  await openRow('marks.csv');
  const csv = await p.evaluate(() => { const t = document.querySelector('.fm-preview-dialog .fm-csv'); return t && { th: [...t.querySelectorAll('th')].map((e) => e.textContent), rows: t.querySelectorAll('tbody tr').length, quoted: [...t.querySelectorAll('td')].some((e) => e.textContent === 'Mim, K'), num: !!t.querySelector('td.fm-num') }; });
  ck(`${tag} CSV previews as a table`, csv && csv.rows === 3 && csv.th.includes('Grade') && csv.quoted && csv.num, JSON.stringify(csv));
  ck(`${tag} preview has no page sideways scroll`, await noPageScrollX(p));
  if (shot) await p.screenshot({ path: `${SHOTS}/files-preview-csv-${w}${dark ? '-dark' : ''}.png` });
  await closeTop();
  await openRow('app.ts');
  const code = await p.evaluate(() => { const b = document.querySelector('.fm-preview-dialog .fm-preview-body'); return b && { kind: b.dataset.kind, lang: b.dataset.lang, spans: b.querySelectorAll('pre code span').length, text: b.textContent.includes('greet') }; });
  ck(`${tag} code previews with highlighting`, code && code.kind === 'code' && code.spans > 2 && code.text, JSON.stringify(code));
  if (shot) await p.screenshot({ path: `${SHOTS}/files-preview-code-${w}${dark ? '-dark' : ''}.png` });
  await closeTop();
  await openRow('notes.md');
  const md = await p.evaluate(() => { const b = document.querySelector('.fm-preview-dialog .fm-preview-body'); return b && { kind: b.dataset.kind, h1: !!b.querySelector('h1'), strong: !!b.querySelector('strong'), table: !!b.querySelector('table') }; });
  ck(`${tag} markdown previews rendered`, md && md.kind === 'markdown' && md.h1 && md.strong && md.table, JSON.stringify(md));
  await closeTop();
  await openRow('routine.txt');
  const txt = await p.evaluate(() => { const b = document.querySelector('.fm-preview-dialog .fm-preview-body'); return b && { kind: b.dataset.kind, text: b.textContent }; });
  ck(`${tag} text previews as plain text`, txt && txt.kind === 'text' && txt.text.includes('MAT 203'), JSON.stringify(txt));
  await closeTop();
  const imgName = (await rowNames(p)).find((n) => /\.png$/.test(n));
  await openRow(imgName);
  const img = await p.evaluate(() => { const i = document.querySelector('.fm-preview-dialog .fm-preview-body img'); return i && { src: i.src.slice(0, 22), w: i.naturalWidth }; });
  ck(`${tag} image previews`, img && img.src.startsWith('data:image/png') && img.w === 1, JSON.stringify(img));
  await closeTop();

  // delete an upload: purgeAttachment with every chat that holds it
  {
    const rows = await p.$$('.fm-dialog .fm-row');
    for (const r of rows) if ((await r.$eval('.fm-name', (e) => e.textContent)) === 'routine.txt') { await (await r.$('button[aria-label^="More for"]')).click(); break; }
    await sleep(250);
    const items = await p.$$('.menu-item');
    for (const it of items) if ((await it.textContent()).includes('Delete')) { await it.click(); break; }
    await sleep(300);
    const desc = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.textContent || '');
    ck(`${tag} delete asks first and names the chats`, /2 saved chats/.test(desc), desc.slice(0, 160));
    const del = (await p.$$('.dialog .btn-destructive')).pop();
    await del.click();
    await p.waitForFunction(() => ![...document.querySelectorAll('.fm-dialog .fm-name')].some((e) => e.textContent === 'routine.txt'), null, { timeout: 5000 }).catch(() => {});
    await sleep(300);
    const purge = (await calls(p)).filter((c) => c.name === 'agent.purgeAttachment');
    ck(`${tag} deleting an upload calls purgeAttachment for its chats`, purge.length === 1 && purge[0].args.name === 'routine.txt' && purge[0].args.sessionKeys.length === 2, JSON.stringify(purge));
    ck(`${tag} deleted upload leaves the list`, !(await rowNames(p)).includes('routine.txt'));
  }
  // delete the image: purge by sha256
  {
    const rows = await p.$$('.fm-dialog .fm-row');
    for (const r of rows) if (/\.png$/.test(await r.$eval('.fm-name', (e) => e.textContent))) { await (await r.$('button[aria-label^="More for"]')).click(); break; }
    await sleep(250);
    for (const it of await p.$$('.menu-item')) if ((await it.textContent()).includes('Delete')) { await it.click(); break; }
    await sleep(300);
    await (await p.$$('.dialog .btn-destructive')).pop().click();
    await sleep(800);
    const purge = (await calls(p)).filter((c) => c.name === 'agent.purgeAttachment' && c.args.imageSha256);
    const sha = await p.evaluate(async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b)))].map((x) => x.toString(16).padStart(2, '0')).join(''), PNG);
    ck(`${tag} deleting an image purges it by SHA-256`, purge.length === 1 && purge[0].args.imageSha256 === sha, JSON.stringify(purge).slice(0, 200));
  }
  // delete a workspace file through the existing tool
  {
    await openRow('app.ts');
    await (await p.$('.fm-preview-dialog .fm-delete')).click();
    await sleep(300);
    const desc = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.textContent || '');
    ck(`${tag} workspace delete names the path`, desc.includes('src/app.ts'), desc.slice(0, 120));
    await (await p.$$('.dialog .btn-destructive')).pop().click();
    await sleep(800);
    const del = (await calls(p)).filter((c) => c.name === 'agent.invokeTool' && c.args[0] === 'delete_file');
    const delPath = del[0] && (typeof del[0].args[1] === 'string' ? JSON.parse(del[0].args[1]).path : del[0].args[1].path);
    ck(`${tag} workspace file deleted via invokeTool('delete_file')`, del.length === 1 && delPath === 'src/app.ts', JSON.stringify(del));
    ck(`${tag} list refreshes after a workspace delete`, !(await rowNames(p)).includes('app.ts'));
  }
  await closeTop();
  await sleep(200);

  // Recent / Browse picker from the composer's + button
  const sendsBefore = (await calls(p)).filter((c) => /sendMessage|followUp/.test(c.name)).length;
  await p.click('.aui-composer-add-attachment');
  await sleep(300);
  const menu = await p.evaluate(() => { const m = document.querySelector('[role="menu"]'); return m && { items: [...m.querySelectorAll('.menu-item')].map((e) => e.textContent.trim()), label: [...m.querySelectorAll('.menu-label')].map((e) => e.textContent) }; });
  ck(`${tag} + opens Upload / Recent / Browse`, menu && menu.items[0].startsWith('Upload from device') && menu.label.includes('Recent files') && menu.items.some((t) => t.startsWith('lab-report.md')) && menu.items.some((t) => t.startsWith('Browse all files')), JSON.stringify(menu));
  ck(`${tag} attach menu stays on screen`, await inView(p, '[role="menu"]'));
  if (shot) await p.screenshot({ path: `${SHOTS}/files-recent-${w}${dark ? '-dark' : ''}.png` });
  for (const it of await p.$$('[role="menu"] .menu-item')) if ((await it.textContent()).trim().startsWith('lab-report.md')) { await it.click(); break; }
  await sleep(400);
  const att = await p.evaluate(() => window.__appComposerAttachments?.() ?? null);
  const tileNames = await p.$$eval('.aui-attachment-tile', (els) => els.map((e) => e.dataset.tooltip || e.textContent));
  ck(`${tag} Recent re-attaches the file`, tileNames.some((t) => t.includes('lab-report')), JSON.stringify(tileNames));
  // Browse all: multi-select two files, attach
  await p.click('.aui-composer-add-attachment');
  await sleep(300);
  for (const it of await p.$$('[role="menu"] .menu-item')) if ((await it.textContent()).includes('Browse all files')) { await it.click(); break; }
  await p.waitForSelector('.fm-dialog .fm-row', { timeout: 6000 });
  await sleep(300);
  for (const n of ['marks.csv', 'notes.md']) {
    for (const r of await p.$$('.fm-dialog .fm-row')) if ((await r.$eval('.fm-name', (e) => e.textContent)) === n) { await (await r.$('.fm-row-main')).click(); break; }
    await sleep(150);
  }
  const btnText = await p.evaluate(() => [...document.querySelectorAll('.fm-dialog .dialog-footer .btn')].pop()?.textContent.trim());
  ck(`${tag} picker counts the selection`, btnText === 'Attach 2', btnText);
  if (shot) await p.screenshot({ path: `${SHOTS}/files-picker-${w}${dark ? '-dark' : ''}.png` });
  ck(`${tag} picker has no page sideways scroll`, await noPageScrollX(p));
  await (await p.$$('.fm-dialog .dialog-footer .btn')).pop().click();
  await sleep(800);
  const tiles2 = await p.$$eval('.aui-attachment-tile', (els) => els.map((e) => e.dataset.tooltip || e.textContent));
  ck(`${tag} picker attaches both files`, tiles2.some((t) => t.includes('marks')) && tiles2.some((t) => t.includes('notes')), JSON.stringify(tiles2));
  // Send: the attachment content goes to the engine, and nothing was uploaded again
  await p.fill('.aui-composer-input', 'Use these');
  await p.keyboard.press('Enter');
  await sleep(700);
  const sent = (await calls(p)).filter((c) => /sendMessage|followUp/.test(c.name));
  const lastSent = JSON.stringify(sent[sent.length - 1]?.args || '');
  ck(`${tag} re-attached files reach the engine`, sent.length > sendsBefore && lastSent.includes('Titration') && lastSent.includes('Akib,91') && lastSent.includes('Routine'), lastSent.slice(0, 200));

  const errors = errs.filter((e) => !/favicon/.test(e));
  ck(`${tag} no console errors or network requests`, errors.length === 0, errors.slice(0, 4).join(' | '));
  await ctx.close();
}

async function runNoPurge(browser) {
  const { p, ctx, errs } = await open(browser, 360, 740, true, false, false);
  await openManager(p, true);
  const rows = await p.$$('.fm-dialog .fm-row');
  for (const r of rows) if ((await r.$eval('.fm-name', (e) => e.textContent)) === 'routine.txt') { await (await r.$('button[aria-label^="More for"]')).click(); break; }
  await sleep(250);
  for (const it of await p.$$('.menu-item')) if ((await it.textContent()).includes('Delete')) { await it.click(); break; }
  await sleep(300);
  const desc = await p.evaluate(() => [...document.querySelectorAll('.dialog')].pop()?.textContent || '');
  ck('[360 old engine] delete says saved chats keep the file', /still contain/.test(desc), desc.slice(0, 160));
  await (await p.$$('.dialog .btn-destructive')).pop().click();
  await sleep(500);
  ck('[360 old engine] no purgeAttachment call without the feature', !(await calls(p)).some((c) => c.name === 'agent.purgeAttachment'));
  ck('[360 old engine] no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const sizes = (process.env.SIZES || '320x640m,360x740m,390x844m,1280x800').split(',');
  const darks = process.env.DARK ? [process.env.DARK === '1'] : [false, true];
  for (const s of sizes) for (const d of darks) {
    try { await run(browser, s, d); } catch (e) { ck(`[${s}${d ? ' dark' : ''}] run`, false, (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')); }
  }
  if (!process.env.SKIP_OLD) { try { await runNoPurge(browser); } catch (e) { ck('[old engine] run', false, e.message); } }
  await browser.close();
  console.log(results.join('\n'));
  const fail = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();
