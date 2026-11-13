// S3 hard checks: the tool permissions page. Mock NativeKit only.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const H = require('./s1.js');
const { open, calls, sa, toastText, closeDialogs, check, results, EXE, SHOTS, sleep, overflow } = H;

// A stateful permission table so saves can be read back.
const stateful = () => {
  const a = window.NativeKit.agent;
  window.__perm = new Map([['read_file', { toolName: 'read_file', permission: 'always_allow', enabled: true }], ['write_file', { toolName: 'write_file', permission: 'always_ask', enabled: true }]]);
  const rec = (n, args) => window.__mock.calls.push({ name: n, args });
  a.listToolPermissions = async () => { rec('agent.listToolPermissions', null); if (window.__permFail) throw new Error('table locked sk-ABCDEFGHIJKLMNOP'); return { permissionsJson: JSON.stringify([...window.__perm.values()]) }; };
  a.setToolPermission = async (toolName, permission, enabled) => { rec('agent.setToolPermission', [toolName, permission, enabled]); if (window.__setFail === toolName) throw new Error('write failed'); window.__perm.set(toolName, { toolName, permission, enabled }); return {}; };
  a.seedToolPermissions = async (list) => { rec('agent.seedToolPermissions', list); for (const p of list) if (!window.__perm.has(p.toolName)) window.__perm.set(p.toolName, { ...p }); return {}; };
  a.resetToolPermissions = async () => { rec('agent.resetToolPermissions', null); window.__perm.clear(); return {}; };
  // A connected MCP server with device tools and one remote tool.
  const conn = window.__app.chat.native.mcp || (window.__app.chat.native.mcp = {});
  conn.connection = { ...(conn.connection || {}), tools: [{ name: 'device__torch', description: 'Turn the torch on or off' }, { name: 'device__camera_take_photo', description: 'Take a photo' }, { name: 'notion_search', description: 'Search Notion pages' }] };
};
async function openPerms(p) {
  await p.evaluate(() => window.__app.openSettings ? window.__app.openSettings('agent') : null);
  await sleep(300);
  if (!(await p.$('.dialog'))) { await p.click('button[aria-label="Settings"]').catch(() => {}); await sleep(300); }
  const tab = p.locator('.dialog [role="tab"]:has-text("Agent"), .dialog button:has-text("Agent")').first();
  if (await tab.count()) await tab.click();
  await p.waitForSelector('[data-slot="tool-permissions"]', { timeout: 6000 });
  await sleep(200);
}
const rowChoice = (p, name) => p.evaluate((n) => document.querySelector(`.pr-row[data-tool="${n}"] .pd-btn`)?.dataset.value, name);
async function choose(p, name, label) {
  await p.click(`.pr-row[data-tool="${name}"] .pd-btn`);
  await p.click(`.pr-row[data-tool="${name}"] .pd-list [role="option"]:has-text("${label}")`);
  await sleep(250);
}

async function testPage(browser) {
  const { p, ctx, errs } = await open(browser);
  await p.evaluate(stateful);
  await openPerms(p);
  const info = await p.evaluate(() => ({ tools: [...document.querySelectorAll('.pr-row')].map((r) => r.dataset.tool), groups: [...document.querySelectorAll('.pr-group')].map((g) => g.dataset.group), count: document.querySelector('[data-slot="perm-count"]').textContent, nativeSelects: document.querySelectorAll('.pr-row select').length }));
  for (const t of ['read_file', 'execute_command', 'web_fetch', 'device__torch', 'notion_search', 'ui__show_widget', 'ui__show_html', 'spawn_subagent', 'ask_session', 'list_sessions'])
    check(`page: lists ${t}`, info.tools.includes(t), info.tools.join(','));
  check('page: groups device, MCP, widgets, sub-agents separately', ['device', 'mcp', 'ui', 'agents', 'files', 'git'].every((g) => info.groups.includes(g)), info.groups.join(','));
  check('page: device tools are not counted as MCP', await p.evaluate(() => !!document.querySelector('.pr-group[data-group="device"] .pr-row[data-tool="device__torch"]') && !!document.querySelector('.pr-group[data-group="mcp"] .pr-row[data-tool="notion_search"]')));
  check('page: custom dropdowns, no native selects in rows', info.nativeSelects === 0 && (await p.locator('.pr-row .pd-btn').count()) === info.tools.length);
  check('page: count shows all tools', new RegExp(`^${info.tools.length} of ${info.tools.length} tools$`).test(info.count), info.count);
  check('page: stored choice shown (read_file Always allow)', (await rowChoice(p, 'read_file')) === 'always_allow');
  check('page: unsaved tools say Default, not saved yet', await p.evaluate(() => !!document.querySelector('.pr-row[data-tool="device__torch"] [data-slot="perm-unsaved"]') && !document.querySelector('.pr-row[data-tool="read_file"] [data-slot="perm-unsaved"]')));
  check('page: MCP descriptions shown', /Search Notion pages/.test(await p.evaluate(() => document.querySelector('.pr-row[data-tool="notion_search"]')?.innerText || '')));
  if (process.env.SHOT !== '0') { await p.locator('[data-slot="tool-permissions"]').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/s3-permissions-390.png` }); }
  // Dropdown a11y.
  await p.click('.pr-row[data-tool="write_file"] .pd-btn');
  const lb = await p.evaluate(() => { const l = document.querySelector('.pr-row[data-tool="write_file"] .pd-list'); const b = document.querySelector('.pr-row[data-tool="write_file"] .pd-btn'); return l ? { role: l.getAttribute('role'), opts: [...l.querySelectorAll('[role="option"]')].map((o) => o.textContent), sel: l.querySelector('[aria-selected="true"]')?.dataset.value, focus: document.activeElement === l, exp: b.getAttribute('aria-expanded'), ctl: b.getAttribute('aria-controls') === l.id } : null; });
  check('dropdown: listbox with 4 options, current one selected, focused', lb && lb.role === 'listbox' && lb.opts.length === 4 && lb.sel === 'always_ask' && lb.focus && lb.exp === 'true' && lb.ctl, JSON.stringify(lb));
  check('dropdown: options are Always allow / Always ask / Ask + fingerprint / Never', /Always allow/.test(lb?.opts[0]) && /Always ask/.test(lb?.opts[1]) && /fingerprint/.test(lb?.opts[2]) && /Never/.test(lb?.opts[3]));
  if (process.env.SHOT !== '0') await p.screenshot({ path: `${SHOTS}/s3-permissions-dropdown-390.png` });
  await p.keyboard.press('Escape');
  await sleep(100);
  check('dropdown: Escape closes it, keeps settings open, focus back on the button', !(await p.$('.pd-list')) && !!(await p.$('.dialog')) && await p.evaluate(() => document.activeElement?.classList.contains('pd-btn')));
  // Keyboard choose: ArrowDown opens, ArrowDown x2, Enter.
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  await sleep(300);
  let sc = (await calls(p, 'agent.setToolPermission')).at(-1);
  check('dropdown: keyboard picks Ask + fingerprint and saves it', JSON.stringify(sc) === JSON.stringify(['write_file', 'always_ask_biometric', true]), JSON.stringify(sc));
  // Never = enabled false, keeping the permission.
  await choose(p, 'execute_command', 'Never');
  sc = (await calls(p, 'agent.setToolPermission')).at(-1);
  check('Never: saves enabled=false', sc?.[0] === 'execute_command' && sc?.[2] === false, JSON.stringify(sc));
  check('Never: row shows it as off', await p.evaluate(() => document.querySelector('.pr-row[data-tool="execute_command"] .pd-btn').dataset.value === 'never'));
  await choose(p, 'execute_command', 'Always allow');
  sc = (await calls(p, 'agent.setToolPermission')).at(-1);
  check('back on: Always allow saves enabled=true', JSON.stringify(sc) === JSON.stringify(['execute_command', 'always_allow', true]), JSON.stringify(sc));
  // Device and MCP tools save too.
  await choose(p, 'device__torch', 'Always allow');
  check('device tool saves through setToolPermission', (await calls(p, 'agent.setToolPermission')).at(-1)?.[0] === 'device__torch');
  // Save error reverts the dropdown.
  await sa(p, () => { window.__setFail = 'git_push'; });
  const before = await rowChoice(p, 'git_push');
  if (before) {
    await choose(p, 'git_push', 'Always allow');
    await sleep(200);
    check('save error: toast and the dropdown goes back', /write failed/.test(await toastText(p)) && (await rowChoice(p, 'git_push')) === before);
  } else {
    await sa(p, () => { window.__setFail = 'web_fetch'; });
    const b2 = await rowChoice(p, 'web_fetch');
    await choose(p, 'web_fetch', 'Always allow');
    await sleep(200);
    check('save error: toast and the dropdown goes back', /write failed/.test(await toastText(p)) && (await rowChoice(p, 'web_fetch')) === b2);
  }
  await sa(p, () => { window.__setFail = null; });
  // Search.
  await p.fill('[data-slot="perm-search"]', 'git_');
  await sleep(300);
  let vis = await p.evaluate(() => [...document.querySelectorAll('.pr-row')].map((r) => r.dataset.tool));
  check('search: filters by name', vis.length > 0 && vis.every((t) => t.includes('git_')), vis.join(','));
  await p.fill('[data-slot="perm-search"]', 'torch');
  await sleep(300);
  vis = await p.evaluate(() => [...document.querySelectorAll('.pr-row')].map((r) => r.dataset.tool));
  check('search: matches descriptions too', vis.includes('device__torch'), vis.join(','));
  await p.fill('[data-slot="perm-search"]', 'zzzz-nothing');
  await sleep(300);
  check('search: no match says so', /No tool matches/.test(await p.evaluate(() => document.querySelector('[data-slot="perm-empty"]')?.textContent || '')));
  await p.fill('[data-slot="perm-search"]', '');
  await sleep(300);
  // Category filter.
  await p.selectOption('[data-slot="perm-group"]', 'device');
  await sleep(150);
  vis = await p.evaluate(() => [...document.querySelectorAll('.pr-row')].map((r) => r.dataset.tool));
  check('category: shows only device tools', vis.length === 2 && vis.every((t) => t.startsWith('device__')), vis.join(','));
  // Bulk: select all shown, set to Always ask.
  await p.check('[data-slot="perm-select-all"]');
  await sleep(100);
  check('bulk: counter shows 2 selected', /2 selected/.test(await p.evaluate(() => document.querySelector('[data-slot="perm-bulk"]').innerText)));
  const n0 = (await calls(p, 'agent.setToolPermission')).length;
  await p.click('[data-slot="perm-bulk-dropdown"]');
  await p.click('[data-slot="perm-bulk"] [role="option"]:has-text("Never")');
  await sleep(500);
  const bulk = (await calls(p, 'agent.setToolPermission')).slice(n0);
  check('bulk: sets every selected tool', bulk.length === 2 && bulk.every((c) => c[0].startsWith('device__') && c[2] === false), JSON.stringify(bulk));
  check('bulk: toast confirms and selection clears', /2 tools set to Never/.test(await toastText(p)) && /Select/.test(await p.evaluate(() => document.querySelector('[data-slot="perm-bulk"]').innerText)));
  check('bulk: rows repaint as Never', await p.evaluate(() => [...document.querySelectorAll('.pr-row .pd-btn')].every((b) => b.dataset.value === 'never')));
  check('bulk: dropdown disabled with nothing selected', await p.evaluate(() => document.querySelector('[data-slot="perm-bulk-dropdown"]').disabled));
  await p.selectOption('[data-slot="perm-group"]', 'all');
  await sleep(150);
  // Collapse a group.
  await p.click('.pr-group[data-group="git"] [data-slot="perm-group-head"]');
  await sleep(100);
  check('groups: collapsing hides its rows (aria-expanded false)', await p.evaluate(() => !document.querySelector('.pr-group[data-group="git"] .pr-row') && document.querySelector('.pr-group[data-group="git"] [data-slot="perm-group-head"]').getAttribute('aria-expanded') === 'false'));
  await p.click('.pr-group[data-group="git"] [data-slot="perm-group-head"]');
  // Pattern rules.
  const rb = p.locator('.pr-row[data-tool="execute_command"] [data-slot="rules-toggle"]');
  check('rules: Patterns button on tools that match an argument', (await rb.count()) === 1 && !(await p.$('.pr-row[data-tool="git_status"] [data-slot="rules-toggle"]')));
  await rb.click();
  await sleep(100);
  check('rules: editor names the subject', /match the tool’s command/.test(await p.evaluate(() => document.querySelector('[data-slot="tool-rules"]').innerText)));
  await p.fill('[aria-label="Allowed command patterns for execute_command"]', 'git status*\nls *\nls *\n  ');
  await p.fill('[aria-label="Blocked command patterns for execute_command"]', 'rm -rf *');
  if (process.env.SHOT !== '0') { await p.locator('[data-slot="tool-rules"]').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/s3-permissions-patterns-390.png` }); }
  await p.click('[data-slot="tool-rules"] [data-slot="rules-save"]');
  await sleep(300);
  const sr = (await calls(p, 'agent.setToolRules')).at(-1);
  check('rules: saves trimmed, de-duplicated lists (bridge signature)', JSON.stringify(sr) === JSON.stringify(['execute_command', { allow: ['git status*', 'ls *'], deny: ['rm -rf *'] }]), JSON.stringify(sr));
  check('rules: count badge updates', (await p.evaluate(() => document.querySelector('.pr-row[data-tool="execute_command"] .pr-rules-n').textContent)) === '3');
  await p.fill('[aria-label="Allowed command patterns for execute_command"]', 'x'.repeat(600));
  const nr = (await calls(p, 'agent.setToolRules')).length;
  await p.click('[data-slot="tool-rules"] [data-slot="rules-save"]');
  await sleep(200);
  check('rules: a pattern over 500 characters is refused', (await calls(p, 'agent.setToolRules')).length === nr && /at most 500/.test(await p.evaluate(() => document.querySelector('[data-slot="tool-rules"] [role="alert"]').textContent)));
  await p.fill('[aria-label="Allowed command patterns for execute_command"]', '');
  await p.fill('[aria-label="Blocked command patterns for execute_command"]', '');
  await p.click('[data-slot="tool-rules"] [data-slot="rules-save"]');
  await sleep(300);
  check('rules: empty lists remove the rules', JSON.stringify((await calls(p, 'agent.setToolRules')).at(-1)) === JSON.stringify(['execute_command', { allow: [], deny: [] }]) && /Rules removed/.test(await toastText(p)));
  // Reset to defaults: confirm, reset then seed.
  await p.click('[data-slot="perm-reset"]');
  await p.waitForSelector('.dialog >> text=Reset tool permissions to the defaults?');
  await p.click('.dialog button:has-text("Reset") >> nth=-1');
  await sleep(700);
  const order = (await p.evaluate(() => window.__mock.calls.map((c) => c.name))).filter((n) => /resetToolPermissions|seedToolPermissions/.test(n));
  check('reset: resets then seeds the defaults', order.slice(-2).join(',') === 'agent.resetToolPermissions,agent.seedToolPermissions', order.join(','));
  await p.waitForSelector('[data-slot="tool-permissions"]');
  check('reset: execute_command is back to its default (Always ask)', (await rowChoice(p, 'execute_command')) === 'always_ask');
  check('page: no console errors', !errs.length, errs.join(' / '));
  await closeDialogs(p);
  await ctx.close();

  // Failure paths: the table can't be read; no toolRules feature; old engine without subagents/crossSession.
  const o = await open(browser, { cfg: { toolRules: false, s1: false } });
  await o.p.evaluate(stateful);
  await o.p.evaluate(() => { window.__permFail = true; });
  await openPerms(o.p);
  const fe = await o.p.evaluate(() => document.querySelector('[data-slot="perm-error"]')?.textContent || '');
  check('read error: says so and shows the defaults', /Couldn’t read the saved permissions/.test(fe) && (await o.p.locator('.pr-row').count()) > 10, fe);
  check('read error: secrets in the message are hidden', !/sk-ABCDEFGHIJKLMNOP/.test(fe));
  check('no toolRules: no Patterns buttons', !(await o.p.$('[data-slot="rules-toggle"]')));
  check('no crossSession: ask_session not listed', !(await o.p.$('.pr-row[data-tool="ask_session"]')));
  check('read error: no console errors', !o.errs.length, o.errs.join(' / '));
  await o.ctx.close();
}

async function testLayout(browser) {
  for (const [w, hgt, mobile] of [[320, 640, true], [360, 740, true], [390, 844, true], [1280, 800, false]]) for (const dark of [false, true]) {
    const tag = `${w}${dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, { w, hgt, mobile, dark });
    await p.evaluate(stateful);
    await p.evaluate(() => { window.__app.chat.native.mcp.connection.tools.push({ name: 'a_really_long_mcp_tool_name_' + 'x'.repeat(60), description: 'D'.repeat(400) }); });
    await openPerms(p);
    let o = await overflow(p);
    check(`[${tag}] page: no page sideways scroll`, o.ok, JSON.stringify(o));
    const fits = await p.evaluate(() => [...document.querySelectorAll('.pr-row')].every((r) => { const b = r.querySelector('.pd-btn').getBoundingClientRect(); const rr = r.getBoundingClientRect(); return b.right <= rr.right + 1; }));
    check(`[${tag}] every dropdown fits in its row`, fits);
    await p.click('.pr-row[data-tool="read_file"] .pd-btn');
    await sleep(100);
    const lst = await p.evaluate(() => { const r = document.querySelector('.pd-list').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
    check(`[${tag}] open dropdown stays on screen`, lst.l >= 0 && lst.r <= lst.w + 1, JSON.stringify(lst));
    await p.keyboard.press('Escape');
    await p.click('.pr-row[data-tool="execute_command"] [data-slot="rules-toggle"]');
    await sleep(100);
    o = await overflow(p);
    check(`[${tag}] patterns editor: no page sideways scroll`, o.ok, JSON.stringify(o));
    check(`[${tag}] no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [name, fn] of Object.entries({ testPage, testLayout })) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 6).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\ns3: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
