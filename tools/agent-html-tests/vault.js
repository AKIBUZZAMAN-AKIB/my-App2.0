// Secure vault (stage D): hard checks. The central property: a secret value never appears in
// the DOM (attributes, text or input values once saved), local/session storage, the event log,
// preferences, console output, the recorded NativeKit call log, toasts, or the agent's prompt.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const fs = require('fs');
const { sleep, overflow } = require('./feat.js');
const EXE = process.env.EXE || (() => { const b = require('path').join(process.env.HOME || '/home/sprite', '.cache/ms-playwright'); const d = require('fs').existsSync(b) ? require('fs').readdirSync(b).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null; return d ? require('path').join(b, d, 'chrome-headless-shell-linux64/chrome-headless-shell') : undefined; })();
const URL_ = process.env.URL_ || `file://${require('path').resolve(__dirname, '../../www/agent.html')}`;
const SHOTS = process.env.SHOTS || '/home/sprite/safe/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const mock = fs.readFileSync(`${__dirname}/mock3.js`, 'utf8');
const mockV2 = fs.readFileSync(`${__dirname}/mock-v2.js`, 'utf8');
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' :: ' + String(extra).slice(0, 600) : ''}`); return ok; };
const SECRET = 'S3cr3t-VALUE-9f8e7d6c5b4a-zz';
const SECRET2 = 'R3placed-VALUE-1234567890-yy';
const PROVIDER_KEY = 'pk-live-ABCDEFGH12345678-provider';
const MCP_TOKEN = 'mcp-token-QWERTY-0987654321';

async function open(browser, { w = 390, hgt = 844, mobile = true, dark = false, init = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await ctx.addInitScript(mock);
  await ctx.addInitScript(mockV2);
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  const errs = [];
  const consoleAll = [];
  p.on('console', (m) => { consoleAll.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
  p.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) errs.push('NETWORK: ' + r.url()); });
  p.on('dialog', (d) => { errs.push('NATIVE DIALOG: ' + d.message()); d.dismiss(); });
  await p.goto(URL_);
  await p.waitForFunction(() => document.querySelector('.native-badge')?.dataset.phase === 'ready', null, { timeout: 8000 });
  return { p, ctx, errs, consoleAll };
}
const openVault = async (p) => { await p.evaluate(() => window.__vault.open(window.__app)); await p.waitForSelector('.vault-dialog .vault-list'); await sleep(250); };
const toasts = (p) => p.evaluate(() => [...document.querySelectorAll('.toast, [data-sonner-toast], .aui-toast, [role="status"]')].map((t) => t.textContent).join(' | '));
/** Every place a secret could leak to from the page. */
async function leakScan(p, consoleAll, secrets) {
  const where = await p.evaluate((list) => {
    const hits = [];
    const html = document.documentElement.outerHTML;
    const values = [...document.querySelectorAll('input, textarea')].map((i) => i.value).join('\n');
    const ls = JSON.stringify({ ...localStorage });
    const ss = JSON.stringify({ ...sessionStorage });
    const prefs = JSON.stringify(window.__mock.prefs);
    // agent.connectMcp hands the MCP token to the native side by design (it makes the HTTP request).
    const calls = JSON.stringify(window.__mock.calls.filter((c) => c.name !== 'agent.connectMcp'));
    const prompt = JSON.stringify(window.__app?.chat?.native || {});
    for (const s of list) {
      if (html.includes(s)) hits.push(`DOM:${s}`);
      if (values.includes(s)) hits.push(`input value:${s}`);
      if (ls.includes(s)) hits.push(`localStorage:${s}`);
      if (ss.includes(s)) hits.push(`sessionStorage:${s}`);
      if (prefs.includes(s)) hits.push(`preferences:${s}`);
      if (calls.includes(s)) hits.push(`call log:${s}`);
      if (prompt.includes(s)) hits.push(`agent state:${s}`);
    }
    return hits;
  }, secrets);
  for (const s of secrets) if (consoleAll.some((c) => c.includes(s))) where.push(`console:${s}`);
  return where;
}

async function testOwnSecrets(browser) {
  const { p, ctx, errs, consoleAll } = await open(browser);
  check('Vault button in the sidebar', await p.evaluate(() => document.querySelectorAll('.vault-open').length > 0));
  await openVault(p);
  check('empty state for own secrets', /No secrets yet/.test(await p.innerText('.vault-dialog')));
  check('provider rows show only the masked key from the engine', /sk-…a1b2/.test(await p.innerText('.vault-dialog')));
  check('MCP server listed with a masked token', await p.evaluate(() => [...document.querySelectorAll('.vault-row[data-kind="mcp"]')].some((r) => /docs/.test(r.textContent) && /•{12}/.test(r.textContent) && !/tok_123/.test(r.textContent))));
  // Validation.
  await p.click('.vault-dialog button:has-text("Add secret")');
  await p.waitForSelector('.vault-form');
  const save = '.dialog:last-of-type button:has-text("Save")';
  await p.fill('.vault-form input[aria-label="Name"]', '1bad name');
  await p.fill('.vault-form input[aria-label="Value"]', SECRET);
  await p.click(save);
  await sleep(150);
  check('invalid name rejected', (await p.getAttribute('.vault-form input[aria-label="Name"]', 'aria-invalid')) === 'true' && !(await p.evaluate(() => Object.keys(window.__mock.secure).some((k) => k.startsWith('agent.vault.secret.')))));
  await p.fill('.vault-form input[aria-label="Name"]', 'github_token');
  await p.fill('.vault-form input[aria-label="Value"]', '   ');
  await p.click(save);
  await sleep(150);
  check('blank value rejected', (await p.getAttribute('.vault-form input[aria-label="Value"]', 'aria-invalid')) === 'true');
  check('value field is a password field with autofill off', await p.evaluate(() => { const i = document.querySelector('.vault-form input[aria-label="Value"]'); return i.type === 'password' && i.autocomplete === 'new-password'; }));
  await p.fill('.vault-form input[aria-label="Value"]', SECRET);
  await p.fill('.vault-form input[aria-label="Label"]', 'GitHub token');
  await p.click(save); await p.click(save, { force: true, timeout: 500 }).catch(() => {});
  await sleep(400);
  const stored = await p.evaluate(() => ({ secure: window.__mock.secure['agent.vault.secret.github_token'], index: window.__mock.prefs['agent.vault.index.v1'], sets: window.__mock.calls.filter((c) => c.name === 'secureStorage.set' && c.args === 'agent.vault.secret.github_token').length }));
  check('value stored in secure storage under the vault prefix', stored.secure === SECRET);
  check('double tap on Save writes once', stored.sets === 1, JSON.stringify(stored.sets));
  check('index in preferences holds only name/kind/label/dates', Array.isArray(stored.index) && stored.index.length === 1 && stored.index[0].name === 'github_token' && !('length' in stored.index[0]) && !JSON.stringify(stored.index).includes(SECRET), JSON.stringify(stored.index));
  check('row shows a fixed mask and the label', await p.evaluate(() => { const r = [...document.querySelectorAll('.vault-row[data-kind="own"]')][0]; return r && /GitHub token/.test(r.textContent) && /•{12}/.test(r.textContent); }));
  let leaks = await leakScan(p, consoleAll, [SECRET]);
  check('saved secret is nowhere in DOM, inputs, storage, prefs, logs, call log or agent state', !leaks.length, leaks.join(', '));
  // Duplicate name (any case).
  await p.click('.vault-dialog button:has-text("Add secret")');
  await p.fill('.vault-form input[aria-label="Name"]', 'GITHUB_TOKEN');
  await p.fill('.vault-form input[aria-label="Value"]', 'x1');
  await p.click(save);
  await sleep(150);
  check('duplicate name rejected', /already exists/.test(await p.innerText('.vault-form')));
  await p.keyboard.press('Escape');
  await sleep(200);
  check('Escape on the form clears the typed value', !(await leakScan(p, consoleAll, ['x1'])).some((l) => l.startsWith('input')));
  // Copy: biometric gate then clipboard.
  await p.click('.vault-row[data-kind="own"] button[aria-label="Copy github_token"]');
  await sleep(300);
  const clip = await p.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
  check('Copy puts the value on the clipboard', clip === SECRET, clip === SECRET ? '' : 'clipboard differs');
  check('Copy asked for biometric first', await p.evaluate(() => window.__mock.calls.some((c) => c.name === 'biometric.verify')));
  check('copy toast does not contain the value', !(await toasts(p)).includes(SECRET));
  leaks = await leakScan(p, consoleAll, [SECRET]);
  check('after copy the value is still nowhere in the page', !leaks.length, leaks.join(', '));
  // Biometric failure: fails closed.
  await p.evaluate(() => { window.NativeKit.biometric.verify = async () => ({ verified: false }); });
  await p.evaluate(() => navigator.clipboard.writeText('unchanged'));
  await p.click('.vault-row[data-kind="own"] button[aria-label="Copy github_token"]');
  await sleep(300);
  check('failed biometric copies nothing', (await p.evaluate(() => navigator.clipboard.readText())) === 'unchanged' && /Not verified/.test(await toasts(p)));
  await p.evaluate(() => { window.NativeKit.biometric.verify = async () => { throw new Error('no sensor'); }; });
  await p.click('.vault-row[data-kind="own"] button[aria-label="Copy github_token"]');
  await sleep(300);
  check('biometric error fails closed', (await p.evaluate(() => navigator.clipboard.readText())) === 'unchanged');
  await p.evaluate(() => { window.NativeKit.biometric.verify = async () => ({ verified: true }); });
  // Replace.
  await p.click('.vault-row[data-kind="own"] button[aria-label="Replace github_token"]');
  await p.waitForSelector('.vault-form');
  check('replace keeps the name locked', await p.evaluate(() => document.querySelector('.vault-form input[aria-label="Name"]').disabled));
  check('replace never pre-fills the old value', (await p.inputValue('.vault-form input[aria-label="Value"]')) === '');
  await p.fill('.vault-form input[aria-label="Value"]', SECRET2);
  await p.click(save);
  await sleep(400);
  check('replace writes the new value', (await p.evaluate(() => window.__mock.secure['agent.vault.secret.github_token'])) === SECRET2);
  // secureStorage.set rejects: error shown, index not changed, value cleared from field only after success.
  await p.evaluate(() => { window.__realSet = window.NativeKit.secureStorage.set; window.NativeKit.secureStorage.set = async () => { throw new Error('Keystore locked (test)'); }; });
  await p.click('.vault-dialog button:has-text("Add secret")');
  await p.fill('.vault-form input[aria-label="Name"]', 'second');
  await p.fill('.vault-form input[aria-label="Value"]', 'zz-second-value-zz');
  await p.click(save);
  await sleep(300);
  const idx = await p.evaluate(() => window.__mock.prefs['agent.vault.index.v1'].map((e) => e.name));
  check('a failed secure write shows the error and adds nothing to the index', /Keystore locked \(test\)/.test(await p.innerText('.vault-form')) && JSON.stringify(idx) === '["github_token"]', JSON.stringify(idx));
  await p.keyboard.press('Escape');
  await p.evaluate(() => { window.NativeKit.secureStorage.set = window.__realSet; });
  // Delete with confirm; cancel first.
  await p.click('.vault-row[data-kind="own"] button[aria-label="Delete github_token"]');
  await p.waitForSelector('.dialog >> text=Delete github_token?');
  await p.keyboard.press('Escape');
  await sleep(200);
  check('cancelled delete keeps the secret', !!(await p.evaluate(() => window.__mock.secure['agent.vault.secret.github_token'])));
  await p.click('.vault-row[data-kind="own"] button[aria-label="Delete github_token"]');
  await p.click('.dialog button:has-text("Delete") >> nth=-1');
  await sleep(400);
  check('delete removes value and index entry', await p.evaluate(() => !window.__mock.secure['agent.vault.secret.github_token'] && window.__mock.prefs['agent.vault.index.v1'].length === 0));
  leaks = await leakScan(p, consoleAll, [SECRET, SECRET2, 'zz-second-value-zz']);
  check('no secret leaked anywhere after the whole flow', !leaks.length, leaks.join(', '));
  check('no console errors (own secrets)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testProviderAndMcp(browser) {
  const { p, ctx, errs, consoleAll } = await open(browser);
  await openVault(p);
  const rows = await p.evaluate(() => [...document.querySelectorAll('.vault-row[data-kind="provider"]')].map((r) => r.textContent));
  check('every key provider has a row', rows.length >= 3, JSON.stringify(rows.length));
  check('provider keys have no Copy button (engine never returns them)', !(await p.$('.vault-row[data-kind="provider"] button[aria-label^="Copy"]')));
  const addBtn = p.locator('.vault-row[data-kind="provider"] button[aria-label^="Add"]').first();
  const label = await addBtn.getAttribute('aria-label');
  await addBtn.click();
  await p.waitForSelector('.vault-form input[type="password"]');
  await p.fill('.vault-form input[type="password"]', 'has space');
  await p.click('.dialog button:has-text("Save key")');
  await sleep(150);
  check('provider key with a space rejected', /can.t contain spaces/.test(await p.innerText('.vault-form')) && !(await p.evaluate(() => window.__mock.calls.some((c) => c.name === 'agent.setAuthKey'))));
  await p.fill('.vault-form input[type="password"]', PROVIDER_KEY);
  await p.click('.dialog button:has-text("Save key")');
  await sleep(400);
  check(`${label}: saved through setAuthKey`, await p.evaluate(() => window.__mock.calls.some((c) => c.name === 'agent.setAuthKey' && c.args[0] === '<key>')));
  // Remove the openai key.
  await p.click('.vault-row[data-kind="provider"] button[aria-label^="Remove"]');
  await p.click('.dialog button:has-text("Remove") >> nth=-1');
  await sleep(400);
  check('remove key calls deleteAuth after confirm', await p.evaluate(() => window.__mock.calls.some((c) => c.name === 'agent.deleteAuth' && c.args === 'openai')));
  // deleteAuth rejects.
  await p.evaluate(() => { window.NativeKit.agent.deleteAuth = async () => { throw new Error('engine offline (test)'); }; window.NativeKit.agent.getAuthStatus = async () => ({ hasKey: true, masked: 'sk-…zz' }); });
  await p.keyboard.press('Escape'); await sleep(150);
  await openVault(p);
  await p.click('.vault-row[data-kind="provider"] button[aria-label^="Remove"] >> nth=0');
  await p.click('.dialog button:has-text("Remove") >> nth=-1');
  await sleep(400);
  check('a rejected deleteAuth shows its error', /engine offline \(test\)/.test(await toasts(p)), await toasts(p));
  // MCP token: copy existing, replace, remove.
  await p.click('.vault-row[data-kind="mcp"] button[aria-label="Copy docs token"]');
  await sleep(300);
  check('MCP token copies after biometric', (await p.evaluate(() => navigator.clipboard.readText())) === 'tok_123');
  await p.click('.vault-row[data-kind="mcp"] button[aria-label="Replace docs token"]');
  await p.fill('.vault-form input[type="password"]', 'bad\ntoken');
  await p.click('.dialog button:has-text("Save token")');
  await sleep(150);
  check('MCP token with a line break rejected', (await p.evaluate(() => window.__mock.secure['nativekit.agent.mcp.token.docs'])) === 'tok_123');
  await p.fill('.vault-form input[type="password"]', MCP_TOKEN);
  await p.click('.dialog button:has-text("Save token")');
  await sleep(400);
  check('MCP token saved under the existing MCP key (backward compatible)', (await p.evaluate(() => window.__mock.secure['nativekit.agent.mcp.token.docs'])) === MCP_TOKEN);
  await p.click('.vault-row[data-kind="mcp"] button[aria-label="Remove docs token"]');
  await p.click('.dialog button:has-text("Remove") >> nth=-1');
  await sleep(400);
  check('MCP token removed; the server stays', await p.evaluate(() => !window.__mock.secure['nativekit.agent.mcp.token.docs'] && window.__mock.prefs['nativekit.agent.mcp.servers.v1'].length === 1));
  const leaks = await leakScan(p, consoleAll, [PROVIDER_KEY, MCP_TOKEN, 'tok_123']);
  check('provider key and MCP tokens never leak into the page, logs or storage', !leaks.length, leaks.join(', '));
  check('no console errors (provider + MCP)', !errs.length, errs.filter((e) => !/engine offline/.test(e)).join(' / ') || '');
  await ctx.close();
}

async function testNoSecureStorage(browser) {
  const { p, ctx, errs } = await open(browser, { init: 'Object.defineProperty(window, "__noSecure", { value: 1 }); document.addEventListener("DOMContentLoaded", () => { delete window.NativeKit.secureStorage; });' });
  await p.evaluate(() => { delete window.NativeKit.secureStorage; });
  await openVault(p);
  check('without secure storage, Add secret is disabled and explained', await p.evaluate(() => document.querySelector('.vault-dialog button')?.closest('.sa-section') && [...document.querySelectorAll('.vault-dialog button')].find((b) => /Add secret/.test(b.textContent))?.disabled === true) && /not available/.test(await p.innerText('.vault-dialog')));
  check('no console errors (no secure storage)', !errs.length, errs.join(' / '));
  await ctx.close();
}

async function testPromptAndLayout(browser) {
  // The engine's prompt no longer promises {{VAULT:...}} substitution (checked by a Rust test too).
  const wsAll = fs.readFileSync(require('path').resolve(__dirname, '../../plugins/native-agent/rust/native-agent-ffi/src/workspace.rs'), 'utf8');
  const ws = wsAll.slice(wsAll.indexOf('const VAULT_ALIAS_PROMPT'), wsAll.indexOf('"#;', wsAll.indexOf('const VAULT_ALIAS_PROMPT')));
  check('engine prompt has no Vault Aliases promise', !/automatically resolve/.test(ws) && /nothing replaces placeholders/.test(ws));
  for (const [w, hgt, mobile] of [[320, 640, true], [360, 740, true], [390, 844, true], [1280, 800, false]]) for (const dark of [false, true]) {
    const tag = `${w}${dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, { w, hgt, mobile, dark });
    await p.evaluate(() => { const list = []; for (let i = 0; i < 60; i++) list.push({ name: `secret_${i}_${'x'.repeat(i % 3 ? 4 : 36)}`, kind: 'api_key', label: i % 4 ? '' : 'A really long label for a secret that should truncate nicely', createdAt: 1, updatedAt: 1 }); window.__mock.prefs['agent.vault.index.v1'] = list; });
    await openVault(p);
    check(`[${tag}] 60 secrets listed`, (await p.locator('.vault-row[data-kind="own"]').count()) === 60);
    const o = await overflow(p);
    check(`[${tag}] vault: no page sideways scroll`, o.ok, JSON.stringify(o));
    // Keyboard: tab reaches a Copy button, Enter opens the form for Add.
    await p.focus('.vault-dialog button:has-text("Add secret")');
    await p.keyboard.press('Enter');
    await p.waitForSelector('.vault-form');
    check(`[${tag}] Add secret opens by keyboard with focus in Name`, (await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Name');
    const o2 = await overflow(p);
    check(`[${tag}] add form: no page sideways scroll`, o2.ok, JSON.stringify(o2));
    if (w === 390) await p.screenshot({ path: `${SHOTS}/vault-form-390${dark ? '-dark' : ''}.png` });
    await p.keyboard.press('Escape');
    await sleep(200);
    if (w === 390) await p.screenshot({ path: `${SHOTS}/vault-390${dark ? '-dark' : ''}.png` });
    check(`[${tag}] no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [name, fn] of Object.entries({ testOwnSecrets, testProviderAndMcp, testNoSecureStorage, testPromptAndLayout })) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 4).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\nvault: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
