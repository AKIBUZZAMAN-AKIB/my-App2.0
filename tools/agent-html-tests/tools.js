// UI-side tool calls against the engine's real schemas. Every invokeTool call
// the page makes runs through the engine's validator (tool-schemas.js) and a
// read_file mock that follows tool_runner.rs byte for byte: 50 KB per call at
// most, chunks that end on a UTF-8 character boundary, fileBytes, modifiedMs,
// nextOffsetBytes, the 10 MB refusal and the real error texts. Covers the
// persona editor (whole 120 KB Bangla AGENTS.md, a missing file, a file that
// cannot be read), the memory panel (limit within 50, the capped hint), the
// file canvas, file previews of big files, "too large" and "changed while
// reading". Mock NativeKit only; no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const { overflow } = require('./feat.js');
const { schemaGuard } = require('./tool-schemas.js');
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
  const sizes = { 'huge.log': 12000000 };
  const mtimes = {};
  window.__ws = { files, mtimes, reads: [], writes: [] };
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
    window.__ws.reads.push({ path: p, offset, limit, end });
    if (window.__ws.changeAfterFirstRead === p) { mtimes[p] = (mtimes[p] || 1) + 1; window.__ws.changeAfterFirstRead = null; return { content, fileBytes: size, modifiedMs: 1, offsetBytes: offset, nextOffsetBytes: next < size ? next : null, truncated: next < size }; }
    return { content, fileBytes: size, modifiedMs: mtimes[p] || 1, offsetBytes: offset, nextOffsetBytes: next < size ? next : null, truncated: next < size };
  };
  const ws = {
    '.': [{ name: 'AGENTS.md', type: 'file', size: fileBytes('AGENTS.md') || 0, modified: 1 }, { name: 'notes', type: 'directory' }, { name: 'huge.log', type: 'file', size: 12000000, modified: 1 }],
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
  const reads = await p.evaluate(() => window.__ws.reads.filter((r) => r.path === 'AGENTS.md'));
  ck(`${tag} it is read in chunks of 50,000 bytes at most; a chunk that would split a letter stops before it`, reads.length >= 3 && reads.every((r) => r.limit <= 50000) && reads.slice(0, -1).some((r) => r.end < r.limit) && reads.every((r, i) => i === 0 || r.offset === reads[i - 1].offset + reads[i - 1].end), JSON.stringify(reads.map((r) => [r.offset, r.end])));
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
  // Whole reads.
  const mid = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/mid.md'));
  ck('a 180 KB Bangla file reads whole and unchanged', mid.content === MID && mid.truncated === false && mid.fileBytes === Buffer.byteLength(MID), `${mid.content.length}`);
  const short = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/short.md'));
  ck('a short file reads in one call', short.content === '# Short\nশুভ সকাল');
  const huge = await p.evaluate(() => window.__agentWorkspace.readTextFile('huge.log').then(() => 'read', (e) => e.message));
  ck('a file over 10 MB fails with the engine\'s clear limit message', /10000000 byte tool limit/.test(huge), huge);
  const big = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/big.md', { maxBytes: 100000 }).then(() => 'read', (e) => `${e.name}: ${e.message}`));
  ck('a file over the caller\'s limit says it is too large, with both sizes', /FileTooLargeError: notes\/big\.md is \d+ KB, larger than the 100 KB/.test(big), big);
  const part = await p.evaluate(() => window.__agentWorkspace.readTextFile('notes/big.md', { maxBytes: 120000, partial: true }));
  ck('a partial read returns the start, flagged truncated, on a character boundary', part.truncated && part.content.length > 1000 && BIGSTART(part.content), `${part.content.length}`);
  const missing = await p.evaluate(() => window.__agentWorkspace.readTextFile('nope.md').then(() => 'read', (e) => e.message));
  ck('a missing file fails with the engine\'s message', /No such file/.test(missing), missing);
  const changed = await p.evaluate(() => { window.__ws.changeAfterFirstRead = 'notes/mid.md'; return window.__agentWorkspace.readTextFile('notes/mid.md').then(() => 'read', (e) => e.message); });
  ck('a file that changes between chunks fails instead of mixing versions', /changed while it was being read/.test(changed), changed);
  // The canvas opens a 180 KB file whole (it used to ask for limit_bytes 1e7 and fail).
  await p.evaluate(() => window.__agentWorkspace.openWorkspaceFile('notes/mid.md'));
  await p.waitForSelector('.aui-canvas', { timeout: 4000 });
  await p.locator('.aui-canvas-tab[data-view=edit]').click().catch(() => {});
  await sleep(300);
  const cv = await p.evaluate(() => document.querySelector('.aui-canvas-editor')?.value);
  ck('the file canvas opens a 180 KB file whole', cv === MID, String(cv?.length));
  await p.keyboard.press('Escape');
  await sleep(300);
  // Files manager preview of a file over the 400 KB preview cap.
  const t = await p.$('[aria-label="Toggle sidebar"]');
  if (t && await t.isVisible()) { await t.click(); await sleep(300); }
  for (const b of await p.$$('.fm-open')) if (await b.isVisible()) { await b.click(); break; }
  await p.waitForSelector('.fm-dialog .fm-row', { timeout: 6000 });
  await sleep(300);
  for (const r of await p.$$('.fm-dialog .fm-row')) if ((await r.$eval('.fm-name', (e) => e.textContent)) === 'big.md') { await (await r.$('.fm-row-main')).click(); break; }
  await p.waitForSelector('.fm-preview-dialog .fm-preview-body, .fm-preview-dialog .fm-note', { timeout: 4000 });
  await sleep(300);
  const pv = await p.evaluate(() => {
    const d = document.querySelector('.fm-preview-dialog');
    const btn = (label) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    return { note: d.querySelector('[data-role=fm-truncated]')?.textContent || '', attach: btn('Attach')?.disabled, copy: btn('Copy')?.disabled, download: btn('Download')?.disabled, error: [...d.querySelectorAll('.fm-note')].map((n) => n.textContent).join(' | ') };
  });
  ck('a file over 400 KB previews its start and says so; copy, download and attach are off', /only its first/.test(pv.note) && pv.attach && pv.copy && pv.download, JSON.stringify(pv).slice(0, 300));
  const v = await violations(p);
  ck('every invokeTool call in these checks passed the engine\'s schemas', v.list.length === 0 && v.checked > 10, `${v.checked} checked ${JSON.stringify(v.list).slice(0, 300)}`);
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
