// Engine v2 checks: real edit/regenerate/branch, approval with edited args, images,
// UI tools, MCP Apps and the sandboxed HTML widget. Mock NativeKit only, no network.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep, send, emit, overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = require('path').join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = require('fs').existsSync(b) ? require('fs').readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? require('path').join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${require('path').resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/impl/shots-v2';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync('/home/sprite/impl/test/mock3.js', 'utf8');
const mockV2 = fs.readFileSync('/home/sprite/impl/test/mock-v2.js', 'utf8');
const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
const calls = (p) => p.evaluate(() => window.__mock.calls);
const named = async (p, n) => (await calls(p)).filter((c) => c.name === n);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function open(browser, w, hgt, mobile, dark, v2 = true) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(mock);
  if (v2) await ctx.addInitScript(mockV2);
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) errs.push('NETWORK: ' + u); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await sleep(400);
  return { p, ctx, errs };
}

const S = {};
S.features = async (p, tag) => {
  const f = await p.evaluate(() => window.__agentEngine?.info?.features || []);
  ck(`${tag} engine features are read`, f.includes('rewindSession') && f.includes('uiTools'), JSON.stringify(f));
  const reg = (await named(p, 'agent.registerUiTool')).map((c) => c.args);
  ck(`${tag} UI tools registered once`, JSON.stringify(reg) === JSON.stringify(['show_widget', 'show_html', 'render_spec', 'present', 'edit_widget', 'preview_widget', 'read_me', 'set_theme']), JSON.stringify(reg));
};

S.edit = async (p, tag, env) => {
  const a = await send(p, 'What is 2+2?');
  const k = a.sessionKey;
  await emit(p, [['text_delta', { sessionKey: k, delta: 'It is 4.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  await p.locator('[data-role=user] [data-action=edit-message]').last().click();
  await sleep(150);
  await p.locator('.aui-edit-composer-input').fill('What is 3+3?');
  await p.locator('[data-action=edit-send]').click();
  await sleep(500);
  const rw = (await named(p, 'agent.rewindSession')).pop();
  ck(`${tag} edit rewinds the native session to before the message`, rw && rw.args[0] === k && rw.args[1] === 1 && rw.args[2]?.expectedPrompt === 'What is 2+2?', JSON.stringify(rw?.args));
  const fu = (await named(p, 'agent.followUp')).pop();
  ck(`${tag} edited text is sent as is, with no "I edited" note`, fu && fu.args === 'What is 3+3?', JSON.stringify(fu?.args));
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Six.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  const picker = await p.evaluate(() => [...document.querySelectorAll('[data-role=user] .aui-branch-picker-state')].map((e) => e.textContent).pop());
  ck(`${tag} versions still shown`, picker === '2 / 2', String(picker));
  // regenerate
  await p.locator('[data-role=assistant] [data-action=regenerate]').last().click();
  await sleep(500);
  const rw2 = (await named(p, 'agent.rewindSession')).pop();
  const fu2 = (await named(p, 'agent.followUp')).pop();
  ck(`${tag} regenerate rewinds and resends the same prompt`, rw2 && rw2.args[1] === 1 && rw2.args[2]?.expectedPrompt === 'What is 3+3?' && fu2?.args === 'What is 3+3?', JSON.stringify([rw2?.args, fu2?.args]));
  await emit(p, [['text_delta', { sessionKey: k, delta: 'It is six.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(300);
  // fallback when the native history no longer matches
  await p.evaluate(() => { window.__mock.rewindFails = true; });
  await p.locator('[data-role=assistant] [data-action=regenerate]').last().click();
  await sleep(500);
  const fu3 = (await named(p, 'agent.followUp')).pop();
  ck(`${tag} a refused rewind falls back to the note prompt`, /answer this earlier message of mine again/.test(fu3?.args || ''), String(fu3?.args).slice(0, 100));
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Six again.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(300);
  if (env.shot) await p.screenshot({ path: `${SHOTS}/edit-${env.w}${env.dark ? '-dark' : ''}.png` });
};

S.fork = async (p, tag) => {
  const a = await send(p, 'Plan my week');
  const k = a.sessionKey;
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Mon: maths. Tue: physics.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  await p.locator('[data-role=assistant] [aria-label="More"]').last().click();
  await sleep(150);
  await p.getByRole('menuitem', { name: 'Fork from here' }).click();
  await sleep(700);
  const fk = (await named(p, 'agent.forkSession')).pop();
  ck(`${tag} fork copies the native session`, fk && fk.args[0] === k && fk.args[1].keepUserTurns === 2 && /^chat-\d+$/.test(fk.args[1].newSessionKey) && fk.args[1].expectedPrompt === 'Plan my week', JSON.stringify(fk?.args));
  const opened = (await named(p, 'agent.loadSession')).pop();
  ck(`${tag} the branch opens as its own chat`, opened && opened.args[0] === fk?.args[1]?.newSessionKey, JSON.stringify(opened?.args));
  const chip = await p.evaluate(() => document.querySelector('.aui-context-chip')?.textContent || '');
  ck(`${tag} no pasted-context chip (history is real)`, !chip, chip);
  await p.locator('.aui-composer-input').first().fill('Add chemistry on Wed');
  await p.locator('.aui-composer-send').first().click();
  await sleep(400);
  const c = [...(await calls(p))].reverse().find((x) => x.name === 'agent.sendMessage' || x.name === 'agent.followUp');
  const pr = typeof c?.args === 'string' ? c.args : c?.args?.prompt;
  ck(`${tag} first message in the branch is sent plain`, pr === 'Add chemistry on Wed', String(pr).slice(0, 120));
};

S.approval = async (p, tag, env) => {
  const a = await send(p, 'Delete the build folder');
  const k = a.sessionKey;
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'x1', toolName: 'execute_command', args: { command: 'rm -rf build', cwd: 'app' } }], ['approval_request', { sessionKey: k, approvalId: 'x1', toolCallId: 'x1', toolName: 'execute_command', args: { command: 'rm -rf build', cwd: 'app' } }]]);
  await sleep(400);
  await p.locator('[data-slot=approval-card-edit]').click();
  await sleep(150);
  const label = await p.locator('[data-slot=approval-card-send-edits]').innerText();
  ck(`${tag} edit button says it runs the change`, /Run with changes/.test(label), label);
  await p.locator('.aui-approval-edit [data-arg=command]').fill('rm -rf build/tmp');
  if (env.shot) await p.screenshot({ path: `${SHOTS}/approval-edit-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('[data-slot=approval-card-send-edits]').click();
  await sleep(500);
  const c = (await named(p, 'agent.respondToApprovalWithArgs')).pop();
  ck(`${tag} approval sends the edited args to the tool`, c && c.args[0] === 'x1' && c.args[1] === true && c.args[3]?.command === 'rm -rf build/tmp' && c.args[3]?.cwd === 'app', JSON.stringify(c?.args));
  const old = await named(p, 'agent.respondToApproval');
  ck(`${tag} no deny-with-reason round trip`, old.length === 0, JSON.stringify(old));
};

S.image = async (p, tag, env) => {
  const input = p.locator('input[type=file]').first();
  const accept = await input.getAttribute('accept');
  ck(`${tag} file picker accepts images`, /image\/png/.test(accept || ''), String(accept));
  await input.setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await sleep(500);
  const tiles = await p.locator('.aui-composer-attachments [data-attachment-type=image], .aui-attachment-root').count();
  ck(`${tag} image shows in the composer`, tiles >= 1, String(tiles));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/image-composer-${env.w}${env.dark ? '-dark' : ''}.png` });
  await p.locator('.aui-composer-input').first().fill('What is in this diagram?');
  await p.locator('.aui-composer-send').first().click();
  await sleep(600);
  const c = [...(await calls(p))].reverse().find((x) => x.name === 'agent.sendMessageWith' || x.name === 'agent.followUpWith');
  ck(`${tag} image goes to the engine as an attachment`, c && c.args.n === 1 && /What is in this diagram\?/.test(c.args.prompt), JSON.stringify(c?.args));
  const shown = await p.evaluate(() => !![...document.querySelectorAll('[data-role=user] img')].length);
  ck(`${tag} sent image appears in the bubble`, shown);
};

S.uitool = async (p, tag, env) => {
  const a = await send(p, 'Help me choose');
  const k = a.sessionKey;
  const spec = { type: 'options', question: 'Which subject first?', options: ['Maths', 'Physics'] };
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'u1', toolName: 'ui__show_widget', args: { spec } }]]);
  // the engine routes the call to the page's handler
  const pending = p.evaluate(async (s) => {
    const t = window.__mock.uiTools.get('show_widget');
    const ctl = new AbortController();
    return t.execute({ spec: s }, { toolCallId: 'u1', signal: ctl.signal });
  }, spec);
  await sleep(500);
  const opts = await p.locator('[data-ui-tool=ui__show_widget] button', { hasText: 'Physics' }).count();
  ck(`${tag} UI tool draws the widget in its tool card`, opts >= 1, String(opts));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/ui-tool-${env.w}${env.dark ? '-dark' : ''}.png` });
  const before = (await calls(p)).filter((c) => c.name === 'agent.followUp').length;
  if (opts) {
    await p.locator('[data-ui-tool=ui__show_widget] button', { hasText: 'Physics' }).first().click();
    await sleep(150);
    await p.locator('[data-ui-tool=ui__show_widget] [data-action=widget-submit]').first().click();
  }
  const res = await Promise.race([pending, sleep(3000).then(() => 'TIMEOUT')]);
  ck(`${tag} the tap answers the tool call`, /Physics/.test(String(res)), String(res));
  const after = (await calls(p)).filter((c) => c.name === 'agent.followUp').length;
  ck(`${tag} the answer is not also sent as a chat message`, after === before, `${before} -> ${after}`);
  await emit(p, [['tool_result', { sessionKey: k, toolCallId: 'u1', result: { output: String(res) } }], ['text_delta', { sessionKey: k, delta: 'Physics first, then.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
};

S.mcpapp = async (p, tag, env) => {
  const a = await send(p, 'Show the chart');
  const k = a.sessionKey;
  await emit(p, [['tool_use', { sessionKey: k, toolCallId: 'm1', toolName: 'docs__show_chart', args: { q: 1 } }]]);
  await sleep(1200);
  const frame = p.frameLocator('[data-mcp-app=docs__show_chart] iframe');
  const txt = await frame.locator('#out').innerText({ timeout: 3000 }).catch((e) => 'ERR ' + e.message.split('\n')[0]);
  ck(`${tag} MCP App opens in a sandbox and gets the tool input`, txt === 'input:{"q":1}', txt);
  const sb = await p.locator('[data-mcp-app=docs__show_chart] iframe').getAttribute('sandbox');
  ck(`${tag} MCP App frame is sandboxed without same-origin`, sb === 'allow-scripts allow-forms', String(sb));
  await frame.locator('#b').click();
  await sleep(500);
  const txt2 = await frame.locator('#out').innerText();
  const call = (await named(p, 'mcp.callAppTool')).pop();
  ck(`${tag} the app can call its server's tool`, txt2 === 'tool:chart 2' && call?.args[1] === 'show_chart', `${txt2} ${JSON.stringify(call?.args)}`);
  await emit(p, [['tool_result', { sessionKey: k, toolCallId: 'm1', result: { output: 'drawn' } }], ['agent.completed', { sessionKey: k }]]);
  await sleep(300);
  if (env.shot) await p.screenshot({ path: `${SHOTS}/mcp-app-${env.w}${env.dark ? '-dark' : ''}.png` });
};

S.htmlwidget = async (p, tag, env) => {
  const a = await send(p, 'Draw a progress ring');
  const k = a.sessionKey;
  const body = '<div style="display:flex;gap:12px;align-items:center"><svg width="64" height="64" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="#ddd" stroke-width="4"/><circle cx="18" cy="18" r="15" fill="none" stroke="#4f46e5" stroke-width="4" stroke-dasharray="66 100" transform="rotate(-90 18 18)"/></svg><b id="pct">70%</b></div><script>document.getElementById("pct").textContent="70% done";fetch("https://example.com").catch(()=>{document.body.dataset.blocked=1})</script>';
  await emit(p, [['text_delta', { sessionKey: k, delta: 'Here it is:\n\n```widget\n' + JSON.stringify({ type: 'html', title: 'Weekly progress', html: body }) + '\n```\n' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(1200);
  const f = p.frameLocator('[data-widget=html] iframe');
  const t = await f.locator('#pct').innerText({ timeout: 3000 }).catch((e) => 'ERR ' + e.message.split('\n')[0]);
  ck(`${tag} HTML widget runs its script in the sandbox`, t === '70% done', t);
  const blocked = await f.locator('body').getAttribute('data-blocked').catch(() => null);
  ck(`${tag} HTML widget cannot reach the network`, blocked === '1', String(blocked));
  const hgt = await p.evaluate(() => document.querySelector('[data-widget=html] iframe')?.getBoundingClientRect().height);
  ck(`${tag} HTML widget sizes itself to its content`, hgt >= 60 && hgt < 300, String(hgt));
  if (env.shot) await p.screenshot({ path: `${SHOTS}/html-widget-${env.w}${env.dark ? '-dark' : ''}.png` });
};

// Old app build: no getEngineFeatures. Everything must take the old paths.
S.oldEngine = async (p, tag) => {
  const f = await p.evaluate(() => window.__agentEngine?.info?.features || []);
  ck(`${tag} old build reports no features`, f.length === 0, JSON.stringify(f));
  const reg = await named(p, 'agent.registerUiTool');
  ck(`${tag} old build registers no UI tools`, reg.length === 0);
  const accept = await p.locator('input[type=file]').first().getAttribute('accept');
  ck(`${tag} old build does not offer images`, !/image\//.test(accept || ''), String(accept));
  const a = await send(p, 'What is 2+2?');
  const k = a.sessionKey;
  await emit(p, [['text_delta', { sessionKey: k, delta: 'It is 4.' }], ['agent.completed', { sessionKey: k }]]);
  await sleep(400);
  await p.locator('[data-role=user] [data-action=edit-message]').last().click();
  await sleep(150);
  await p.locator('.aui-edit-composer-input').fill('What is 3+3?');
  await p.locator('[data-action=edit-send]').click();
  await sleep(500);
  const fu = (await named(p, 'agent.followUp')).pop();
  ck(`${tag} old build edits with the note prompt`, /edited my earlier message/.test(fu?.args || ''), String(fu?.args).slice(0, 80));
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const sizes = (process.env.SIZES || '320x640m,360x740m,390x844m,1280x800').split(',').map((s) => { const m = /^(\d+)x(\d+)(m?)$/.exec(s); return [+m[1], +m[2], !!m[3]]; });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [w, hgt, mobile] of sizes) {
    for (const dark of [false, true]) {
      for (const [name, fn] of Object.entries(S)) {
        if (only && !only.includes(name)) continue;
        const tag = `${w}x${hgt}${dark ? ' dark' : ''} ${name}`;
        const { p, ctx, errs } = await open(browser, w, hgt, mobile, dark, name !== 'oldEngine');
        const shot = !!process.env.SHOT && (w === 360 || w === 390);
        try { await fn(p, tag, { w, dark, shot }); } catch (e) { ck(`${tag} ran`, false, e.message.split('\n')[0]); }
        const ov = await overflow(p);
        ck(`${tag} no page sideways scroll`, ov.ok, JSON.stringify(ov));
        // The HTML widget check makes a fetch on purpose; the frame's CSP blocking it is the expected result.
        const real = errs.filter((e) => !(name === 'htmlwidget' && /Content Security Policy/.test(e)));
        ck(`${tag} no console errors / network`, !real.length, real.slice(0, 3).join(' | '));
        await ctx.close();
      }
    }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(fails.join('\n'));
  console.log(`${results.length - fails.length}/${results.length} passed`);
})();
