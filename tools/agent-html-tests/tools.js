// The UI's own file reads and its tool calls. The persona editor, the file
// canvas and file previews read workspace files through the real
// bridge/workspace-files.ts (NativeKit.agent.workspace, workspace-real.js):
// whole files streamed by the app, any type, never through the model's 50 KB
// read_file tool. A read_file mock that follows tool_runner.rs records any UI
// call to it, and every invokeTool call the page makes runs through the
// engine's validator (tool-schemas.js). Covers the persona editor (whole 120 KB
// Bangla AGENTS.md, a missing file, a file that cannot be read), the memory
// panel, the canvas, a 16 MB text file, images, audio, video, PDF, DOCX, an
// unknown binary, "too large" and "changed while reading". Mock NativeKit
// only; no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const { overflow } = require('./feat.js');
const { schemaGuard } = require('./tool-schemas.js');
const { realWorkspaceScript } = require('./workspace-real.js');
const { zipSync, strToU8 } = require(path.resolve(__dirname, '../../node_modules/fflate'));
const EXE = process.env.EXE || (() => { const b = path.join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = fs.existsSync(b) ? fs.readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? path.join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${path.resolve(__dirname, '../../www/agent.html')}`;
const mock = fs.readFileSync(path.join(__dirname, 'mock3.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

// 120 KB persona: Bangla (3-byte letters), emoji (4 bytes) and ASCII, so the
// 50,000-byte chunk ends land inside characters.
const line = 'তুমি একজন সহায়ক সহকারী। Answer briefly 🙂 and kindly.\n';
const PERSONA = `# Persona: Akib's helper\n${line.repeat(Math.ceil(120000 / Buffer.byteLength(line)))}END-OF-PERSONA`;
const BIG = `# Big notes\n${'লম্বা লেখা, long text. '.repeat(14000)}TAIL`; // ~400 KB+, over the 400 KB preview cap
const MID = `# Mid\n${'মাঝারি ফাইল. '.repeat(9000)}MID-TAIL`; // ~180 KB, opens whole
// 16 MB text (Bangla and ASCII lines): opens whole in the preview.
const hugeLine = 'লগ লাইন: সব ঠিক আছে, all good. 0123456789\n';
const HUGE = `HUGE-START\n${hugeLine.repeat(Math.ceil(16 * 1024 * 1024 / Buffer.byteLength(hugeLine)))}HUGE-TAIL`;
const b64 = (u8) => Buffer.from(u8).toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DOCX = b64(zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>প্রতিবেদন: Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>DOCX-SECOND-PARAGRAPH</w:t></w:r></w:p></w:body></w:document>'),
}));

const workspaceMock = (persona) => `(() => {
  const a = window.NativeKit.agent;
  const rec = (name, args) => window.__mock.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
  const enc = new TextEncoder();
  const files = {
    ${persona === 'missing' ? '' : `'AGENTS.md': enc.encode(${JSON.stringify(PERSONA)}),`}
    'notes/big.md': enc.encode(${JSON.stringify(BIG)}),
    'notes/mid.md': enc.encode(${JSON.stringify(MID)}),
    'notes/short.md': enc.encode('# Short\\nশুভ সকাল'),
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  files['huge.log'] = enc.encode('HUGE-START\\n' + ${JSON.stringify(hugeLine)}.repeat(${Math.ceil(16 * 1024 * 1024 / Buffer.byteLength(hugeLine))}) + 'HUGE-TAIL');
  files['pics/dot.png'] = fromB64(${JSON.stringify(PNG)});
  files['media/clip.mp4'] = enc.encode('not really a video');
  files['media/voice.mp3'] = enc.encode('not really audio');
  files['docs/report.pdf'] = enc.encode('%PDF-1.4\\n%fake\\n');
  files['docs/report.docx'] = fromB64(${JSON.stringify(DOCX)});
  files['data/blob.bin'] = new Uint8Array([0, 1, 2, 3, 255, 254, 0, 9]);
  files['data/giant.txt'] = enc.encode('pretend this is 80 MB');
  const sizes = { 'data/giant.txt': 80 * 1024 * 1024 };
  const mtimes = {};
  window.__ws = { files, mtimes, sizes, reads: [], writes: [], statError: ${persona === 'locked' ? "{ 'AGENTS.md': 'Permission denied (os error 13)' }" : '{}'} };
  const fileBytes = (p) => sizes[p] ?? files[p]?.length;
  const readFile = (args) => {
    const p = args.path;
    if (p === 'AGENTS.md' && ${JSON.stringify(persona)} === 'locked') return { error: 'Failed to read file: Permission denied (os error 13)' };
    const size = fileBytes(p);
    if (size === undefined) return { error: 'Failed to read file: No such file or directory (os error 2)' };
    if (size > 10000000) return { error: 'Failed to read file: File exceeds the 10000000 byte tool limit' };
    const bytes = files[p];
    const offset = args.offset_bytes ?? 0;
    if (offset > size) return { error: 'offset_bytes ' + offset + ' exceeds file size ' + size };
    if (offset < size && (bytes[offset] & 0xc0) === 0x80) return { error: 'offset_bytes must be a UTF-8 character boundary' };
    const limit = Math.min(Math.max(args.limit_bytes ?? 50000, 1), 50000);
    const chunk = bytes.subarray(offset, offset + limit + 4);
    let end = Math.min(limit, chunk.length);
    if (end < chunk.length) {
      while (end > 0 && (chunk[end] & 0xc0) === 0x80) end--;
      if (end === 0) { const f = chunk[0]; end = Math.min(f < 0x80 ? 1 : f < 0xe0 ? 2 : f < 0xf0 ? 3 : 4, chunk.length); }
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, end));
    const next = offset + end;
    // One read of mid.md changes the file under the reader.
    if (p === 'notes/changing.md') {}
    window.__ws.toolReads = (window.__ws.toolReads || 0) + 1;
    if (window.__ws.changeAfterFirstRead === p) { mtimes[p] = (mtimes[p] || 1) + 1; window.__ws.changeAfterFirstRead = null; return { content, fileBytes: size, modifiedMs: 1, offsetBytes: offset, nextOffsetBytes: next < size ? next : null, truncated: next < size }; }
    return { content, fileBytes: size, modifiedMs: mtimes[p] || 1, offsetBytes: offset, nextOffsetBytes: next < size ? next : null, truncated: next < size };
  };
  const ws = {
    '.': [{ name: 'AGENTS.md', type: 'file', size: fileBytes('AGENTS.md') || 0, modified: 1 }, { name: 'notes', type: 'directory' }, { name: 'pics', type: 'directory' }, { name: 'media', type: 'directory' }, { name: 'docs', type: 'directory' }, { name: 'data', type: 'directory' }, { name: 'huge.log', type: 'file', size: files['huge.log'].length, modified: 1 }],
    'pics': [{ name: 'dot.png', type: 'file', size: files['pics/dot.png'].length, modified: 5 }],
    'media': [{ name: 'clip.mp4', type: 'file', size: 18, modified: 6 }, { name: 'voice.mp3', type: 'file', size: 16, modified: 6 }],
    'docs': [{ name: 'report.pdf', type: 'file', size: 16, modified: 7 }, { name: 'report.docx', type: 'file', size: files['docs/report.docx'].length, modified: 7 }],
    'data': [{ name: 'blob.bin', type: 'file', size: 8, modified: 8 }, { name: 'giant.txt', type: 'file', size: 80 * 1024 * 1024, modified: 8 }],
    'notes': [{ name: 'big.md', type: 'file', size: files['notes/big.md'].length, modified: 2 }, { name: 'mid.md', type: 'file', size: files['notes/mid.md'].length, modified: 3 }, { name: 'short.md', type: 'file', size: 20, modified: 4 }],
  };
  const inner = a.invokeTool;
  a.invokeTool = async (n, x) => {
    const args = typeof x === 'string' ? JSON.parse(x) : (x || {});
    if (n === 'read_file') { rec('agent.invokeTool', [n, args]); return { resultJson: JSON.stringify(readFile(args)) }; }
    if (n === 'write_file') { rec('agent.invokeTool', [n, { path: args.path, bytes: args.content.length }]); window.__ws.writes.push(args); files[args.path] = enc.encode(args.content); return { resultJson: JSON.stringify({ path: args.path, bytesWritten: files[args.path].length }) }; }
    if (n === 'list_files') { rec('agent.invokeTool', [n, args]); return { resultJson: JSON.stringify({ path: args.path || '.', entries: ws[args.path || '.'] || [] }) }; }
    if (n === 'memory_list') { rec('agent.invokeTool', [n, args]); const all = Array.from({ length: 80 }, (_, i) => ({ key: 'note.' + i, text: 'Memory ' + i })); return { resultJson: JSON.stringify(all.slice(0, args.limit ?? 20)) }; }
    return inner(n, x);
  };
})();`;

async function open(browser, { w, h, mobile, dark, persona = 'ok' }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(workspaceMock(persona));
  await ctx.addInitScript(realWorkspaceScript());
  await ctx.addInitScript(schemaGuard);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(250);
  return { p, ctx, errs };
}

const openMemoryTab = async (p) => {
  await p.locator('button[aria-label="Settings"]:visible').first().click();
  await sleep(400);
  await p.locator('#settings-tab-memory').click();
  await p.waitForSelector('textarea[placeholder^="How the agent should behave"], [data-role=persona-error]', { timeout: 6000 });
  await sleep(300);
};
const personaState = (p) => p.evaluate(() => {
  const t = document.querySelector('textarea[placeholder^="How the agent should behave"]');
  const save = [...t.closest('.settings-section').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save');
  return { value: t.value, disabled: t.disabled, saveDisabled: !!save?.disabled, error: document.querySelector('[data-role=persona-error]')?.textContent || '' };
});
const violations = (p) => p.evaluate(() => ({ list: window.__schemaViolations, checked: window.__toolCallsChecked }));

async function sized(browser, size, dark) {
  const tag = `[${size.w}${dark ? ' dark' : ''}]`;
  const { p, ctx, errs } = await open(browser, { ...size, dark });
  await openMemoryTab(p);
  const s = await personaState(p);
  ck(`${tag} the whole 120 KB AGENTS.md loads into the persona editor`, s.value === PERSONA && !s.disabled && !s.saveDisabled && !s.error, `${s.value.length} of ${PERSONA.length} chars`);
  const reads = await p.evaluate(() => ({ app: window.__ws.reads.filter((r) => r.path === 'AGENTS.md').map((r) => r.op), tool: window.__ws.toolReads || 0 }));
  ck(`${tag} it is read whole by the app in one read, never through the model's read_file tool`, reads.app.length >= 1 && reads.app.every((o) => o === 'read') && reads.tool === 0, JSON.stringify(reads));
  const t = p.locator('textarea[placeholder^="How the agent should behave"]');
  await t.fill(PERSONA + '\nনতুন লাইন');
  await p.locator('.settings-section button:has-text("Save")').first().click();
  await sleep(400);
  const w = await p.evaluate(() => window.__ws.writes.filter((x) => x.path === 'AGENTS.md').pop()?.content);
  ck(`${tag} Save writes the whole edited persona back`, w === PERSONA + '\nনতুন লাইন', String(w?.length));
  const mem = await p.evaluate(() => ({ calls: window.__mock.calls.filter((c) => c.name === 'agent.invokeTool' && c.args[0] === 'memory_list').map((c) => c.args[1].limit), capped: document.querySelector('[data-role=memory-capped]')?.textContent || '' }));
  ck(`${tag} the memory list asks for 50 at most and says when there are more`, mem.calls.length > 0 && mem.calls.every((l) => l <= 50) && /first 50/.test(mem.capped), JSON.stringify(mem));
  const mErr = await p.locator('.settings-section .note[data-tone=error], .settings-section [role=alert]').count();
  ck(`${tag} the memory tab shows no error`, mErr === 0, String(mErr));
  const of = await overflow(p);
  ck(`${tag} no sideways overflow in the memory tab`, of.ok, JSON.stringify(of).slice(0, 200));
  const v = await violations(p);
  ck(`${tag} every invokeTool call passed the engine's schemas`, v.list.length === 0 && v.checked > 0, `${v.checked} checked ${JSON.stringify(v.list).slice(0, 300)}`);
  ck(`${tag} no page errors or network`, errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
}

async function once(browser) {
  const size = { w: 375, h: 760, mobile: true };
  // Missing AGENTS.md is a blank persona, editable.
  {
    const { p, ctx } = await open(browser, { ...size, persona: 'missing' });
    await openMemoryTab(p);
    const s = await personaState(p);
    ck('a missing AGENTS.md opens a blank, editable persona', s.value === '' && !s.disabled && !s.saveDisabled && !s.error, JSON.stringify(s).slice(0, 200));
    await ctx.close();
  }
  // A read failure is shown, and editing and Save are off so nothing overwrites the file.
  {
    const { p, ctx } = await open(browser, { ...size, persona: 'locked' });
    await openMemoryTab(p);
    const s = await personaState(p);
    ck('an unreadable AGENTS.md shows the error and turns editing and Save off', s.disabled && s.saveDisabled && /Permission denied/.test(s.error), JSON.stringify(s).slice(0, 200));
    const writes = await p.evaluate(() => window.__ws.writes.length);
    ck('nothing is written after a failed load', writes === 0, String(writes));
    await ctx.close();
  }
  const { p, ctx, errs } = await open(browser, size);
  // Whole reads, by the app.
  const mid = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/mid.md'));
  ck('a 180 KB Bangla file reads whole and unchanged', mid.content === MID && mid.truncated === false && mid.fileBytes === Buffer.byteLength(MID), `${mid.content.length}`);
  const short = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/short.md'));
  ck('a short file reads whole', short.content === '# Short\nশুভ সকাল');
  const huge = await p.evaluate(async () => { const t = performance.now(); const r = await window.__agentWorkspace.readTextFile('huge.log'); return { len: r.content.length, start: r.content.slice(0, 10), tail: r.content.slice(-9), bytes: r.fileBytes, truncated: r.truncated, ms: performance.now() - t }; });
  ck('a 16 MB text file reads whole (it used to be refused over 10 MB)', huge.start === 'HUGE-START' && huge.tail === 'HUGE-TAIL' && huge.bytes === Buffer.byteLength(HUGE) && !huge.truncated, JSON.stringify(huge));
  const giant = await p.evaluate(() => window.__agentWorkspace.readTextFile('data/giant.txt').then(() => 'read', (e) => `${e.name}: ${e.message}`));
  ck('a file over the 64 MB limit says it is too large, with both sizes', /FileTooLargeError: data\/giant\.txt is 80 MB, larger than the 64 MB/.test(giant), giant);
  const big = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/big.md', { maxBytes: 100000 }).then(() => 'read', (e) => `${e.name}: ${e.message}`));
  ck('a file over the caller\'s limit says it is too large, with both sizes', /FileTooLargeError: notes\/big\.md is \d+ KB, larger than the 98 KB/.test(big), big);
  const part = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/big.md', { maxBytes: 120000, partial: true }));
  ck('a partial read returns the start, flagged truncated, without a broken letter', part.truncated && part.content.length > 1000 && BIGSTART(part.content), `${part.content.length}`);
  const missing = await p.evaluate(() => window.__agentWorkspace.readTextFile('nope.md').then(() => 'read', (e) => e.message));
  ck('a missing file fails with a clear message', /No such file/.test(missing), missing);
  const changed = await p.evaluate(() => { window.__ws.growOnRead = 'notes/mid.md'; return window.__agentWorkspace.readTextFile('notes/mid.md').then(() => 'read', (e) => e.message); });
  ck('a file that changes while it is read fails instead of mixing versions', /changed while it was being read/.test(changed), changed);
  const fallback = await p.evaluate(async () => { window.__ws.fetchFails = true; try { const r = await window.__agentWorkspace.readTextFile('notes/mid.md'); return r.content.length; } finally { window.__ws.fetchFails = false; } });
  ck('when the local file server cannot be reached, the file is read through the Filesystem plugin instead', fallback === MID.length, String(fallback));
  const binText = await p.evaluate(() => window.__agentWorkspace.readTextFile('data/blob.bin').then(() => 'read', (e) => e.message));
  ck('reading a binary file as text says it is not a text file', /not a text file/.test(binText), binText);
  const bad = await p.evaluate(() => window.NativeKit.agent.workspace.read('../secrets.txt').then(() => 'read', (e) => e.code));
  ck('a path that leaves the workspace is refused', bad === 'bad_path', bad);
  const toolReads = await p.evaluate(() => window.__ws.toolReads || 0);
  ck('none of these reads went through the model\'s read_file tool', toolReads === 0, String(toolReads));
  // The canvas opens a 180 KB file whole.
  await p.evaluate(() => window.__agentWorkspace.openWorkspaceFile('notes/mid.md'));
  await p.waitForSelector('.aui-canvas', { timeout: 4000 });
  await p.locator('.aui-canvas-tab[data-view=edit]').click().catch(() => {});
  await sleep(300);
  const cv = await p.evaluate(() => document.querySelector('.aui-canvas-editor')?.value);
  ck('the file canvas opens a 180 KB file whole', cv === MID, String(cv?.length));
  await p.keyboard.press('Escape');
  await sleep(300);
  // Files manager previews of every kind.
  const t = await p.$('[aria-label="Toggle sidebar"]');
  if (t && await t.isVisible()) { await t.click(); await sleep(300); }
  for (const b of await p.$$('.fm-open')) if (await b.isVisible()) { await b.click(); break; }
  await p.waitForSelector('.fm-dialog .fm-row', { timeout: 6000 });
  await sleep(500);
  const preview = async (name) => {
    for (const r of await p.$$('.fm-dialog .fm-row')) if ((await r.$eval('.fm-name', (e) => e.textContent)) === name) { await (await r.$('.fm-row-main')).click(); break; }
    await p.waitForSelector('.fm-preview-dialog .fm-preview-body, .fm-preview-dialog .fm-note, .fm-preview-dialog .fm-file-card', { timeout: 15000 });
    await sleep(400);
    const out = await p.evaluate(() => {
      const d = document.querySelector('.fm-preview-dialog');
      const btn = (label) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
      const body = d.querySelector('.fm-preview-body');
      return { kind: body?.dataset.kind || (d.querySelector('.fm-file-card') ? 'card' : ''), big: body?.dataset.big === 'true', text: body?.textContent.length || 0, head: (body?.textContent || '').slice(0, 40), tail: (body?.textContent || '').slice(-12), notes: [...d.querySelectorAll('.fm-note')].map((n) => n.dataset.role + ':' + n.textContent).join(' | '), card: d.querySelector('.fm-file-card')?.textContent || '', media: d.querySelector('video,audio,img,iframe')?.tagName || '', src: d.querySelector('video,audio,img,iframe')?.getAttribute('src') || '', attach: btn('Attach')?.disabled, copy: btn('Copy')?.disabled, download: btn('Download')?.disabled, share: !!d.querySelector('[data-action=fm-share]') };
    });
    return out;
  };
  const closePreview = async () => { await p.keyboard.press('Escape'); await sleep(350); };
  const pv = await preview('big.md');
  ck('a 420 KB file previews whole as plain text; copy and download on, attach off (too big to attach)', pv.big && pv.tail.endsWith('TAIL') && /fm-big/.test(pv.notes) && !pv.copy && !pv.download && pv.attach, JSON.stringify(pv).slice(0, 300));
  await closePreview();
  const t0 = Date.now();
  const hv = await preview('huge.log');
  const hugeMs = Date.now() - t0;
  ck('a 16 MB log previews whole: first and last line are there', hv.big && hv.head.startsWith('HUGE-START') && hv.tail.endsWith('HUGE-TAIL') && hv.text === HUGE.length, `${hv.text} of ${HUGE.length} chars, ${hugeMs} ms`);
  ck('the 16 MB preview opens in under 8 seconds', hugeMs < 8000, `${hugeMs} ms`);
  const scrolled = await p.evaluate(async () => { const b = document.querySelector('.fm-preview-dialog .fm-preview-body'); const t = performance.now(); b.scrollTop = b.scrollHeight; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { ms: performance.now() - t, segs: b.querySelectorAll('pre.fm-seg').length }; });
  ck('scrolling to the end of the 16 MB preview stays responsive (segments render lazily)', scrolled.ms < 1500 && scrolled.segs > 100, JSON.stringify(scrolled));
  await closePreview();
  const img = await preview('dot.png');
  ck('an image previews from the app\'s file URL, not copied into the page', img.kind === 'image' && img.media === 'IMG' && /^blob:/.test(img.src) && !img.download, JSON.stringify(img).slice(0, 200));
  await closePreview();
  const vid = await preview('clip.mp4');
  ck('a video previews in a player, or a card with Open or share when the format can\'t play', (vid.kind === 'video' && vid.media === 'VIDEO') || (vid.kind === 'card' && vid.share), JSON.stringify(vid).slice(0, 200));
  await closePreview();
  const aud = await preview('voice.mp3');
  ck('audio previews in a player, or a card with Open or share', (aud.kind === 'audio' && aud.media === 'AUDIO') || (aud.kind === 'card' && aud.share), JSON.stringify(aud).slice(0, 200));
  await closePreview();
  const pdf = await preview('report.pdf');
  ck('a PDF previews inline where the WebView can, else a card with Open or share', (pdf.kind === 'pdf' && pdf.media === 'IFRAME') || (pdf.kind === 'card' && pdf.share && /application\/pdf/.test(pdf.card)), JSON.stringify(pdf).slice(0, 200));
  await closePreview();
  const docx = await preview('report.docx');
  ck('a DOCX previews its text (Bangla too) and says formatting is not shown', /প্রতিবেদন: Quarterly report/.test(docx.head + docx.card) && /fm-document/.test(docx.notes) && !docx.copy, JSON.stringify(docx).slice(0, 300));
  await closePreview();
  const bin = await preview('blob.bin');
  ck('an unknown binary shows its type and size, with Open or share and Download', bin.kind === 'card' && bin.share && /application\/octet-stream/.test(bin.card) && /8 B/.test(bin.card) && !bin.download, JSON.stringify(bin).slice(0, 300));
  await p.locator('.fm-preview-dialog [data-action=fm-share]').click();
  await sleep(300);
  const shared = await p.evaluate(() => window.__ws.shared || []);
  ck('Open or share hands the file to the system share sheet', shared.length === 1 && shared[0].name === 'blob.bin' && /agent\/workspace\/data\/blob\.bin$/.test(shared[0].uri), JSON.stringify(shared));
  await closePreview();
  const gi = await preview('giant.txt');
  ck('a text file over 64 MB says it is too large, with both sizes, and offers Open or share', /fm-too-large:.*80 MB.*64 MB/.test(gi.notes) && gi.share, JSON.stringify(gi).slice(0, 300));
  await closePreview();
  const toolReads2 = await p.evaluate(() => window.__ws.toolReads || 0);
  ck('no preview called the model\'s read_file tool', toolReads2 === 0, String(toolReads2));
  const v = await violations(p);
  ck('every invokeTool call in these checks passed the engine\'s schemas', v.list.length === 0 && v.checked > 3, `${v.checked} checked ${JSON.stringify(v.list).slice(0, 300)}`);
  ck('no page errors or network (single-size checks)', errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
}
function BIGSTART(s) { return s.startsWith('# Big notes') && !/\uFFFD/.test(s); }

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    await once(browser);
    for (const size of [{ w: 320, h: 640, mobile: true }, { w: 375, h: 760, mobile: true }, { w: 768, h: 1000, mobile: true }, { w: 1366, h: 860, mobile: false }]) {
      for (const dark of [false, true]) await sized(browser, size, dark);
    }
  } catch (e) {
    ck('suite ran to the end', false, (e.stack || e.message).split('\n').slice(0, 4).join(' <- '));
  } finally {
    await browser.close();
  }
  for (const r of results) console.log(r);
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
