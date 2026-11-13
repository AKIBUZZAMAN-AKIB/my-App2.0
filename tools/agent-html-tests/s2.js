// S2 hard checks: token budget setting (in tokens) and the live token meter. Mock NativeKit only.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const H = require('./s1.js');
const { open, calls, sa, toastText, closeDialogs, check, results, EXE, SHOTS, sleep, overflow } = H;

const ev = (p, type, payload) => p.evaluate(([t, pl]) => window.__app.chat._onEvent({ eventType: t, payloadJson: JSON.stringify(pl) }), [type, payload]);
const meter = (p) => p.evaluate(() => { const b = document.querySelector('[data-slot="token-meter"]'); return b ? { hidden: b.hidden, text: b.querySelector('.tk-text')?.textContent, level: b.dataset.level, label: b.getAttribute('aria-label'), pct: b.style.getPropertyValue('--tk-pct') } : null; });

async function openAgentSettings(p) {
  await p.evaluate(() => window.__app.openSettings ? window.__app.openSettings('agent') : null);
  await sleep(300);
  if (!(await p.$('.dialog'))) { await p.click('button[aria-label="Settings"]').catch(() => {}); await sleep(300); }
  const tab = p.locator('.dialog [role="tab"]:has-text("Agent"), .dialog button:has-text("Agent")').first();
  if (await tab.count()) await tab.click();
  await sleep(500);
}

async function testMeter(browser) {
  const { p, ctx, errs } = await open(browser);
  const key = await p.evaluate(() => window.__app.chat.mainId);
  check('meter: present in the composer and hidden before any usage', (await meter(p))?.hidden === true, JSON.stringify(await meter(p)));
  await ev(p, 'context.limit_resolved', { sessionKey: key, contextLimitTokens: 128000, contextBudgetTokens: 128000, configuredBudgetTokens: 0, reservedInputTokens: 2000, estimatedContextTokens: 8000, maxOutputTokens: 4096 });
  await sleep(100);
  let m = await meter(p);
  check('meter: limit_resolved shows the estimate against the window', m && !m.hidden && m.text === '10k / 128k', JSON.stringify(m));
  await ev(p, 'context.usage', { sessionKey: key, inputTokens: 12000, outputTokens: 500, contextLimitTokens: 128000, contextBudgetTokens: 128000, reservedOutputTokens: 4096, tokenizer: { encoding: 'o200k_base', exact: true }, provider: 'openai', model: 'gpt-4o' });
  await sleep(100);
  m = await meter(p);
  check('meter: usage event shows input + output', m.text === '12.5k / 128k', JSON.stringify(m));
  check('meter: aria-label gives the full numbers and percent', /12,500 of 128,000 tokens \(10%\)/.test(m.label || ''), m.label);
  check('meter: level ok under 80%', m.level === 'ok');
  // Another chat's usage does not change this chat's meter.
  await ev(p, 'context.usage', { sessionKey: 'chat-other', inputTokens: 99000, outputTokens: 1, contextLimitTokens: 100000 });
  await sleep(100);
  check('meter: another chat\'s usage is kept apart', (await meter(p)).text === '12.5k / 128k');
  // Budget lower than the window wins.
  await ev(p, 'context.usage', { sessionKey: key, inputTokens: 26000, outputTokens: 1000, contextLimitTokens: 128000, contextBudgetTokens: 32000 });
  await sleep(100);
  m = await meter(p);
  check('meter: a lower budget is the limit shown', m.text === '27k / 32k', JSON.stringify(m));
  check('meter: level warn at 80%+', m.level === 'warn', JSON.stringify(m));
  await ev(p, 'context.usage', { sessionKey: key, inputTokens: 31000, outputTokens: 500, contextBudgetTokens: 32000 });
  await sleep(100);
  check('meter: level danger at 95%+', (await meter(p)).level === 'danger');
  // Details popover.
  await p.click('[data-slot="token-meter"]');
  await sleep(150);
  const pop = await p.evaluate(() => { const d = document.querySelector('[data-slot="token-details"]'); return d ? { text: d.innerText, focus: d.contains(document.activeElement) || document.activeElement === d, meter: d.querySelector('[role="meter"]')?.getAttribute('aria-valuenow') } : null; });
  check('details: opens with the model, window, budget, tokenizer', pop && /gpt-4o/.test(pop.text) && /128,000 tokens/.test(pop.text) && /32,000 tokens/.test(pop.text) && /o200k_base/.test(pop.text), pop?.text);
  check('details: warns when almost full', /Almost full/.test(pop?.text || ''));
  check('details: has a meter role with the value and gets focus', pop?.meter === '31500' && pop.focus, JSON.stringify(pop));
  check('details: expanded state on the button', (await p.getAttribute('[data-slot="token-meter"]', 'aria-expanded')) === 'true');
  if (process.env.SHOT !== '0') await p.screenshot({ path: `${SHOTS}/s2-token-meter-390.png` });
  // Live update while open.
  await ev(p, 'context.usage', { sessionKey: key, inputTokens: 1000, outputTokens: 0, contextBudgetTokens: 32000 });
  await sleep(100);
  check('details: updates live while open', /1,000 tokens/.test(await p.evaluate(() => document.querySelector('[data-slot="token-details"]')?.innerText || '')));
  await p.keyboard.press('Escape');
  await sleep(100);
  check('details: Escape closes and returns focus to the meter', !(await p.$('[data-slot="token-details"]')) && await p.evaluate(() => document.activeElement?.dataset.slot === 'token-meter'));
  check('details: Escape does not close anything else (no dialog open)', !(await p.$('.dialog')));
  await p.click('[data-slot="token-meter"]');
  await sleep(120);
  await p.mouse.click(Math.round((await p.viewportSize()).width / 2), 120);
  await sleep(100);
  check('details: tapping outside closes', !(await p.$('[data-slot="token-details"]')));
  // Draft counting with countTokens (exact) and debounce.
  await sa(p, () => { window.__app.settings.set({ provider: 'openai', model: 'gpt-4o' }); });
  const input = p.locator('.aui-composer-input').first();
  await input.pressSequentially('hello world here', { delay: 10 });
  await sleep(800);
  const cc = await calls(p, 'agent.countTokens');
  const prov = await p.evaluate(() => window.__app.settings.get('provider'));
  if (prov === 'openai') {
    check('draft: countTokens called once after typing stops (debounced)', cc.length === 1 && cc[0][2] === 'hello world here' && cc[0][3]?.online === false, JSON.stringify(cc));
    check('draft: draft tokens added to the meter', /6 in your draft|about 6 in your draft/.test((await meter(p)).label || ''), (await meter(p)).label);
  } else {
    check('draft: auto provider uses the estimate', /in your draft/.test((await meter(p)).label || ''), (await meter(p)).label);
  }
  // countTokens error falls back to the estimate.
  await sa(p, () => { window.__countFail = true; });
  await input.fill('x'.repeat(40));
  await input.dispatchEvent('input');
  await sleep(800);
  check('draft: count error falls back to about chars/4', /about 10 in your draft/.test((await meter(p)).label || ''), (await meter(p)).label);
  await input.fill('');
  await input.dispatchEvent('input');
  await sleep(700);
  check('draft: clearing the draft removes it', !/draft/.test((await meter(p)).label || ''));
  // Junk payloads.
  await p.evaluate(() => { window.__app.chat._onEvent({ eventType: 'context.usage', payloadJson: '{bad' }); window.__app.chat._onEvent({ eventType: 'context.usage', payloadJson: JSON.stringify({ inputTokens: -5, outputTokens: 'x' }) }); });
  await sleep(100);
  check('meter: junk payloads do not crash', !errs.some((e) => /pageerror/.test(e)), errs.join(' / '));
  // Switching chats: meter for a chat with no usage is hidden.
  await p.evaluate(() => { window.__app.chat.mainId = 'brand-new'; window.__app.chat.emit('main'); });
  await sleep(200);
  check('meter: a chat with no usage hides the meter', (await meter(p))?.hidden === true, JSON.stringify(await meter(p)));
  await p.evaluate((k) => { window.__app.chat.mainId = k; window.__app.chat.emit('main'); }, key);
  await sleep(200);
  check('meter: switching back shows that chat\'s numbers', /1k \/ 32k/.test((await meter(p))?.text || ''), JSON.stringify(await meter(p)));
  check('meter: no console errors', !errs.filter((e) => !/count failed/.test(e)).length, errs.join(' / '));
  await ctx.close();
}

async function testSettings(browser) {
  const { p, ctx, errs } = await open(browser);
  await ev(p, 'context.usage', { sessionKey: await p.evaluate(() => window.__app.chat.mainId), inputTokens: 10, outputTokens: 1, contextLimitTokens: 200000, provider: 'openai', model: 'gpt-4o' });
  await sa(p, () => { window.__app.settings.set({ provider: 'openai', model: 'gpt-4o' }); });
  await openAgentSettings(p);
  const f = await p.evaluate(() => { const i = document.querySelector('[data-slot="token-budget"]'); const hint = document.querySelector('[data-slot="token-budget-hint"]'); return { has: !!i, value: i?.value, min: i?.min, max: i?.max, ph: i?.placeholder, hint: hint?.textContent || '', chars: [...document.querySelectorAll('.field-label')].map((l) => l.textContent) }; });
  check('settings: Token budget field replaces the character budget', f.has && f.chars.includes('Token budget') && !f.chars.includes('Context budget (characters)'), JSON.stringify(f));
  check('settings: empty by default (model window)', f.value === '' && f.min === '4096' && f.max === '10000000', JSON.stringify(f));
  check('settings: hint names the model and its real window', /gpt-4o: 200,000 tokens/.test(f.hint) && /200,000/.test(f.ph), JSON.stringify(f));
  check('settings: fallback character budget still available', f.chars.includes('Fallback budget (characters)'));
  if (process.env.SHOT !== '0') { await p.locator('[data-slot="token-budget"]').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/s2-token-budget-390.png` }); }
  const saveBtn = p.locator('.dialog button:has-text("Save")').first();
  // Empty -> 0.
  await saveBtn.click();
  await sleep(300);
  let rc = (await calls(p, 'agent.setRuntimeConfig')).at(-1)?.[0] || (await calls(p, 'agent.setRuntimeConfig')).at(-1);
  check('settings: empty saves contextTokenBudget 0', rc && rc.contextTokenBudget === 0 && rc.contextCharBudget === 120000, JSON.stringify(rc));
  // Too low -> error, no save.
  const n0 = (await calls(p, 'agent.setRuntimeConfig')).length;
  await p.fill('[data-slot="token-budget"]', '1000');
  await saveBtn.click();
  await sleep(300);
  check('settings: below 4096 is refused with a message', (await calls(p, 'agent.setRuntimeConfig')).length === n0 && /Token budget must be between 4096 and 10000000/.test(await toastText(p)) && (await p.getAttribute('[data-slot="token-budget"]', 'aria-invalid')) === 'true');
  await p.fill('[data-slot="token-budget"]', '64000');
  await saveBtn.click();
  await sleep(300);
  rc = (await calls(p, 'agent.setRuntimeConfig')).at(-1)?.[0] || (await calls(p, 'agent.setRuntimeConfig')).at(-1);
  check('settings: a valid number saves as contextTokenBudget', rc?.contextTokenBudget === 64000, JSON.stringify(rc));
  check('settings: no console errors', !errs.length, errs.join(' / '));
  await closeDialogs(p);
  await ctx.close();
  // Saved budget shows on reopen.
  const o = await open(browser);
  await sa(o.p, () => { window.__tokenBudget = 50000; });
  await openAgentSettings(o.p);
  check('settings: saved budget shows when reopened', (await o.p.inputValue('[data-slot="token-budget"]')) === '50000');
  await o.ctx.close();
  // Older engine: character field unchanged.
  const old = await open(browser, { cfg: { tokens: false } });
  await openAgentSettings(old.p);
  const of = await old.p.evaluate(() => ({ tok: !!document.querySelector('[data-slot="token-budget"]'), labels: [...document.querySelectorAll('.field-label')].map((l) => l.textContent) }));
  check('old engine: keeps the Context budget (characters) field', !of.tok && of.labels.includes('Context budget (characters)'), JSON.stringify(of));
  await old.p.locator('.dialog button:has-text("Save")').first().click();
  await sleep(300);
  const orc = (await calls(old.p, 'agent.setRuntimeConfig')).at(-1)?.[0] || (await calls(old.p, 'agent.setRuntimeConfig')).at(-1);
  check('old engine: never sends contextTokenBudget', orc && !('contextTokenBudget' in orc) && orc.contextCharBudget === 120000, JSON.stringify(orc));
  check('old engine: no console errors', !old.errs.length, old.errs.join(' / '));
  await old.ctx.close();
}

async function testLayout(browser) {
  for (const [w, hgt, mobile] of [[320, 640, true], [360, 740, true], [390, 844, true], [1280, 800, false]]) for (const dark of [false, true]) {
    const tag = `${w}${dark ? ' dark' : ''}`;
    const { p, ctx, errs } = await open(browser, { w, hgt, mobile, dark });
    await ev(p, 'context.usage', { sessionKey: await p.evaluate(() => window.__app.chat.mainId), inputTokens: 9876543, outputTokens: 12345, contextLimitTokens: 10000000, tokenizer: { encoding: 'a-very-long-tokenizer-name-'.repeat(4), exact: false }, model: 'm'.repeat(120), provider: 'x' });
    await sleep(150);
    const box = await p.evaluate(() => { const b = document.querySelector('[data-slot="token-meter"]'); const r = b.getBoundingClientRect(); const s = b.closest('.aui-composer-shell').getBoundingClientRect(); return { inside: r.right <= s.right + 1 && r.left >= s.left - 1, h: Math.round(r.height) }; });
    check(`[${tag}] meter fits inside the composer`, box.inside, JSON.stringify(box));
    await p.click('[data-slot="token-meter"]');
    await sleep(150);
    const o = await overflow(p);
    check(`[${tag}] details: no page sideways scroll`, o.ok, JSON.stringify(o));
    const inView = await p.evaluate(() => { const r = document.querySelector('[data-slot="token-details"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0; });
    check(`[${tag}] details: fully on screen`, inView);
    check(`[${tag}] no console errors`, !errs.length, errs.join(' / '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [name, fn] of Object.entries({ testMeter, testSettings, testLayout })) {
    if (only && !only.includes(name)) continue;
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, (e.stack || e.message).split('\n').slice(0, 6).join(' <- ')); }
  }
  await browser.close();
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\ns2: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
