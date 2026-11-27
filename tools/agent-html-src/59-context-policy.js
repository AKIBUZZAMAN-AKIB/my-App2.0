// Context Policies (TCPE): the workspace where a person picks the mode, pins a
// policy for a chat, reads the T1–T7 presets, builds and checks the automatic
// rules, sets exclusions, and follows the running task. The context card's
// Policy tab (58-context-tree.js) paints a compact view through `paintTab`.
//
// Every value comes from the engine (`policy.*` actions over the same bridge
// as `ctx.*`); nothing is invented. Without the engine's `contextPolicy`
// feature nothing is shown.
const ContextPolicy = (() => {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const POLICIES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const MODES = ['off', 'manual', 'auto'];
  const CATEGORIES = [['sys', 'System prompt'], ['ess', 'Essentials'], ['turns', 'Conversation'], ['files', 'Files'], ['results', 'Tool output'], ['notes', 'Notebook'], ['strategy', 'Strategy']];
  const GROUPS = ['mem', 'mem.goals', 'mem.goals.closed', 'mem.goal_history', 'mem.topics', 'mem.decisions', 'mem.decisions.closed', 'mem.facts', 'mem.prefs', 'mem.replaced', 'mem.files', 'mem.tasks', 'mem.tasks.closed', 'mem.ranges', 'mem.ranges.old', 'mem.versions', 'mem.longterm'];
  const SOURCES = { ai: 'AI', auto: 'Auto', pin: 'Pin', rule: 'Rule', fallback: 'Fallback', manual: 'Manual' };

  const LABEL = {
    en: {
      title: 'Context Policies', open: 'Open Context Policies', close: 'Close', note: 'Tools and rules always go in full; only older parts of the chat get shorter.',
      mode: 'Mode', off: 'Off', manual: 'Manual', auto: 'Auto', defaultPolicy: 'Default policy', locked: 'Locked',
      pin: 'Pin for this chat', pinBtn: 'Pin', unpin: 'Unpin', noPin: 'No pin', presets: 'Presets', keeps: 'Keeps', drops: 'Leaves out', defaults: 'Defaults', lifecycle: 'Starts at first tool call · ends when the task completes · on error retries, then T7',
      rules: 'Automatic rules', noRules: 'No rules yet. Build one below.', enabled: 'Enabled', priority: 'Priority', edit: 'Edit', del: 'Delete', proposals: 'Suggested by the model', approve: 'Approve', reject: 'Reject',
      builder: 'Rule builder', ruleId: 'Rule ID', addCond: 'Add condition', remove: 'Remove', then: 'Then use', all: 'AND (all)', any: 'OR (any)', sample: 'Sample request', preview: 'Preview', validate: 'Validate', addRule: 'Add rule', saveRules: 'Save rules', revert: 'Discard changes',
      advanced: 'Advanced editor (JSON)', valid: 'Valid', invalid: 'Not valid', save: 'Save',
      exclusions: 'Exclusions', categories: 'Categories', groups: 'Memory groups', items: 'Items', protectedNote: 'Protected items (system, essentials, tools, task block) are always sent.',
      task: 'Active task', noTask: 'No task is running. A task starts with the first tool call of a turn.', request: 'Request', checklist: 'Temp checklist', source: 'Picked by', step: 'Steps', retries: 'Retries', escalations: 'Escalations',
      timeline: 'Timeline', tokens: 'Tokens', sent: 'Sent', ifT7: 'With T7', saved: 'Saved', fallbacks: 'Fallbacks', recent: 'Recent tasks',
      overall: 'Overall', requests: 'Requests', tokensSent: 'Tokens sent', tokensSaved: 'Tokens saved', avgLatency: 'Avg latency', tasksDone: 'Tasks done', retriesShort: 'Retries', byPolicy: 'By policy', pickedBy: 'Picked by', lastTask: 'Last task',
      chkOff: 'Policies are off: every request sends the full context (T7). Nothing is shortened or measured.', chkNone: 'No request has gone out under a policy in this chat yet. Numbers appear after the first tool call of a turn.',
      chkWorking: '{n} of the last {m} requests went out smaller than the full context (T7), saving {t} tokens.', chkFull: 'The last {m} requests all went out at full size (T7): the picked policy kept everything, or a safeguard sent T7.', chkFallback: '{f} fell back to T7 for safety.', verified: 'Working', notSaving: 'Full size',
      perRequest: '{n} req', noMetrics: 'No totals from the engine yet.', events: 'Why', retry: 'Retry', loading: 'Loading…', unsupported: 'This app\u2019s engine does not answer Context Policies (policy.*) yet. Update the app to a build whose native engine includes them; the rest of the context card works as before.', unsupportedTitle: 'Needs an app update', confirmDel: 'Delete rule', confirmSave: 'Replace the whole rule set with this one?', unsaved: 'Unsaved changes',
    },
    bn: {
      title: 'Context Policies', open: 'Context Policies খুলুন', close: 'বন্ধ', note: 'Tool ও rules সবসময় পুরো যায়; শুধু chat-এর পুরনো অংশ ছোট হয়।',
      mode: 'Mode', off: 'বন্ধ', manual: 'Manual', auto: 'Auto', defaultPolicy: 'Default policy', locked: 'তালাবদ্ধ',
      pin: 'এই chat-এর pin', pinBtn: 'Pin', unpin: 'Pin সরান', noPin: 'Pin নেই', presets: 'Preset', keeps: 'থাকে', drops: 'বাদ যায়', defaults: 'Default', lifecycle: 'প্রথম tool call-এ শুরু · task শেষে শেষ · ব্যর্থ হলে আবার চেষ্টা, তারপর T7',
      rules: 'Automatic rules', noRules: 'এখনো rule নেই। নিচে বানান।', enabled: 'চালু', priority: 'Priority', edit: 'সম্পাদনা', del: 'মুছুন', proposals: 'Model-এর প্রস্তাব', approve: 'Approve', reject: 'Reject',
      builder: 'Rule Builder', ruleId: 'Rule ID', addCond: 'Condition যোগ', remove: 'সরান', then: 'তাহলে', all: 'AND (সব)', any: 'OR (যেকোনো)', sample: 'নমুনা request', preview: 'Preview', validate: 'যাচাই', addRule: 'Rule যোগ', saveRules: 'Rules সংরক্ষণ', revert: 'বাতিল',
      advanced: 'Advanced editor (JSON)', valid: 'বৈধ', invalid: 'বৈধ নয়', save: 'সংরক্ষণ',
      exclusions: 'Exclusions', categories: 'Category', groups: 'Memory group', items: 'Item', protectedNote: 'Protected item (system, essentials, tool, task block) সবসময় যায়।',
      task: 'চলমান task', noTask: 'কোনো task চলছে না। Turn-এর প্রথম tool call-এ task শুরু হয়।', request: 'Request', checklist: 'Temp checklist', source: 'কে বাছাই করেছে', step: 'ধাপ', retries: 'Retry', escalations: 'Escalation',
      timeline: 'Timeline', tokens: 'Token', sent: 'পাঠানো', ifT7: 'T7 হলে', saved: 'বাঁচল', fallbacks: 'Fallback', recent: 'সাম্প্রতিক task',
      overall: 'সার্বিক', requests: 'Request', tokensSent: 'পাঠানো token', tokensSaved: 'বাঁচানো token', avgLatency: 'গড় latency', tasksDone: 'শেষ হওয়া task', retriesShort: 'Retry', byPolicy: 'Policy অনুযায়ী', pickedBy: 'কে বাছাই করেছে', lastTask: 'শেষ task',
      chkOff: 'Policy বন্ধ: প্রতিটি request পুরো context (T7) পাঠায়। কিছু ছোট হয় না, মাপাও হয় না।', chkNone: 'এই chat-এ এখনো কোনো request policy দিয়ে যায়নি। Turn-এর প্রথম tool call-এর পর সংখ্যা দেখা যাবে।',
      chkWorking: 'শেষ {m}টি request-এর {n}টি পুরো context (T7)-এর চেয়ে ছোট গেছে, {t} token বেঁচেছে।', chkFull: 'শেষ {m}টি request সবই পুরো আকারে (T7) গেছে: বাছাই করা policy সব রেখেছে, অথবা safeguard T7 পাঠিয়েছে।', chkFallback: '{f}টি নিরাপত্তার জন্য T7-এ ফিরে গেছে।', verified: 'কাজ করছে', notSaving: 'পুরো আকার',
      perRequest: '{n} req', noMetrics: 'Engine থেকে এখনো মোট হিসাব আসেনি।', events: 'কেন', retry: 'আবার', loading: 'লোড হচ্ছে…', unsupported: 'এই app এর engine এখনো Context Policies (policy.*) চেনে না। যে build এর native engine এ এগুলো আছে, সেই app update করুন; context card এর বাকি সব আগের মতো কাজ করবে।', unsupportedTitle: 'App update লাগবে', confirmDel: 'Rule মুছবেন', confirmSave: 'পুরো rule set এটা দিয়ে বদলাবেন?', unsaved: 'সংরক্ষণ হয়নি',
    },
  };
  const lang = () => {
    try { const l = (window.__policyLang || document.documentElement.lang || navigator.language || 'en').toLowerCase(); return l.startsWith('bn') ? 'bn' : 'en'; } catch (e) { return 'en'; }
  };
  const L = (k) => (LABEL[lang()] && LABEL[lang()][k]) || LABEL.en[k] || k;

  // ------------------------------------------------------------------ state
  let data = null; // the last policy.get answer
  let lastError = null;
  let unsupported = false; // the engine (or the bridge) does not know policy.* at all
  // An engine or bridge without the policy actions answers like this; retrying cannot help.
  const UNSUPPORTED_RE = /unknown (?:policy )?action[^"]*"?policy\.|engine is too old \(missing 'contextPolicy'\)/i;
  let busy = '';
  let draft = null; // rules document being edited (null = saved one)
  let jsonText = null; // advanced editor text (null = follows draft)
  let jsonCheck = null; // { valid, errors }
  let builder = null;
  let previewOut = null;
  let live = null; // the newest context.policy event
  let metrics = null; // the last policy.metrics answer: totals over this chat's tasks
  let metricsKey = ''; // the chat those totals are for
  let metricsTimer = null;
  const listeners = new Set(); // other views (the Checklist's Activity) that show these numbers
  const hosts = new Set(); // { el, kind: 'workspace' | 'tab' }
  let dialog = null;

  const ct = () => (typeof window !== 'undefined' && window.__contextTree) || null;
  const sessionKey = () => { try { const c = ct(); return (c && c.activeKey && c.activeKey()) || ''; } catch (e) { return ''; } };

  function available() {
    if (typeof window === 'undefined') return false;
    if (window.__ctxPolicyHidden === true) return false;
    const listed = Array.isArray(window.__features) ? window.__features : null;
    if (listed) return listed.includes('contextPolicy');
    try {
      if (typeof engine !== 'undefined' && engine && engine.info && Array.isArray(engine.info.features) && engine.info.features.length) return engine.has('contextPolicy');
    } catch (e) { /* no engine */ }
    return false;
  }

  function sender() {
    const parse = (v) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return {}; } } return v || {}; };
    try {
      const kit = typeof nativeKit === 'function' ? nativeKit() : null;
      if (kit && kit.agent && typeof kit.agent.subagents === 'function') {
        return async (action, extra) => {
          const r = await kit.agent.subagents({ action, sessionKey: sessionKey(), ...(extra || {}) });
          if (r && typeof r.resultJson === 'string') return parse(r.resultJson);
          if (r && typeof r.json === 'string') return parse(r.json);
          return parse(r);
        };
      }
    } catch (e) { /* no native engine */ }
    const rt = (typeof window !== 'undefined' && (window.__runtime || window.__agentRuntime)) || null;
    if (rt && typeof rt.action === 'function') return async (a, p) => parse(await rt.action(a, { sessionKey: sessionKey(), ...(p || {}) }));
    return null;
  }

  async function call(action, extra, what) {
    const send = sender();
    if (!send) { lastError = { what: what || action, message: 'The engine is not available.' }; paint(); return null; }
    try {
      const r = await send(action, extra);
      if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
      lastError = null;
      return r || {};
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      if (UNSUPPORTED_RE.test(message)) unsupported = true;
      lastError = { what: what || action, message };
      paint();
      return null;
    }
  }

  async function refresh() {
    if (!available()) return;
    busy = busy || 'load';
    paint();
    const r = await call('policy.get', {}, 'load');
    if (busy === 'load') busy = '';
    if (r && typeof r === 'object') { data = r; unsupported = false; if (draft == null) jsonText = null; }
    if (r) await loadMetrics();
    paint();
  }

  /** policy.metrics: the totals over this chat's tasks (requests, tokens sent next to T7,
   * latency, fallbacks, by policy and by who picked it). Read straight from the engine's
   * own event log, so the Overall numbers are the ones the engine measured. A failure
   * keeps the last totals and shows no error: the rest of the view still works. */
  async function loadMetrics() {
    const send = sender();
    if (!send || unsupported) return null;
    const key = sessionKey();
    try {
      const m = await send('policy.metrics', { limit: 500 });
      if (m && typeof m === 'object' && !m.error && m.total && typeof m.total === 'object') { metrics = m; metricsKey = key; }
    } catch (e) { /* an older engine without policy.metrics */ }
    return metrics;
  }
  const curMetrics = () => (metrics && metricsKey === sessionKey() ? metrics : null);
  function queueMetrics() {
    if (metricsTimer) return;
    metricsTimer = setTimeout(() => { metricsTimer = null; loadMetrics().then(() => paint()).catch(() => {}); }, 900);
  }

  // ------------------------------------------------------------ data access
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  const savedRules = () => obj(data && data.rules);
  const rulesDoc = () => draft || savedRules();
  const mode = () => String(obj(data && data.settings).policy_mode || 'off');
  const registry = () => arr(data && data.registry).filter((p) => p && typeof p === 'object');
  const fields = () => arr(data && data.fields).filter((f) => f && typeof f.field === 'string');
  const clone = (v) => JSON.parse(JSON.stringify(v == null ? {} : v));
  function editDraft() { if (!draft) draft = clone(savedRules()); if (!Array.isArray(draft.rules)) draft.rules = []; jsonText = null; jsonCheck = null; return draft; }
  function exclusions(doc) {
    const d = doc || rulesDoc();
    const a = obj(obj(d.exclusions).always_exclude);
    return { categories: arr(a.categories), groups: arr(a.groups), turn_ids: arr(a.turn_ids), item_ids: arr(a.item_ids) };
  }
  const isProtected = (id) => /^(sys(\/|$)|ess(\/|$)|tool|task(\/|$))/.test(String(id || ''));

  // --------------------------------------------------------------- pieces
  const chip = (text, cls = '') => `<span class="cp-chip ${cls}">${esc(text)}</span>`;
  const section = (id, title, body, extra = '') => `<section class="cp-sec" aria-labelledby="cp-h-${id}"><div class="cp-sec-head"><h3 class="cp-h" id="cp-h-${id}">${esc(title)}</h3>${extra}</div>${body}</section>`;
  const btn = (label, attrs, cls = '') => `<button type="button" class="cp-btn ${cls}" ${attrs}>${esc(label)}</button>`;
  const fmtN = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '—');
  const fmtK = (n) => (typeof n !== 'number' || !isFinite(n) ? '—' : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString('en-US'));
  const fmtMs = (n) => (typeof n !== 'number' || !isFinite(n) ? '—' : n >= 10000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n).toLocaleString('en-US')} ms`);
  const pct = (sent, t7) => (typeof sent === 'number' && typeof t7 === 'number' && t7 > 0 ? Math.max(0, Math.round((1 - sent / t7) * 100)) : null);
  const fill = (t, vars) => String(t).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));

  /** The newest request steps of this chat (the engine's `tokens` events): what each sent next to T7. */
  function recentSteps() {
    return arr(data && data.events).filter((e) => e && typeof e.inputTokens === 'number' && typeof e.t7Tokens === 'number');
  }

  /** Whether the policy really shortens what is sent, from the engine's own numbers. */
  function checkLine() {
    const m = mode();
    if (m === 'off') return { kind: 'off', text: L('chkOff') };
    const steps = recentSteps();
    if (!steps.length) return { kind: 'none', text: L('chkNone') };
    const smaller = steps.filter((e) => e.inputTokens < e.t7Tokens);
    const saved = steps.reduce((a, e) => a + Math.max(0, e.t7Tokens - e.inputTokens), 0);
    const fb = arr(data && data.events).filter((e) => e && e.kind === 'fallback').length;
    const head = smaller.length ? fill(L('chkWorking'), { n: smaller.length, m: steps.length, t: fmtK(saved) }) : fill(L('chkFull'), { m: steps.length });
    return { kind: smaller.length ? 'ok' : 'full', text: head + (fb ? ' ' + fill(L('chkFallback'), { f: fb }) : '') };
  }

  /** The Overall view: totals over every task of this chat, from policy.metrics, and a
   * check that the policy is really applied. */
  function overallView(compact) {
    const chk = checkLine();
    const badge = chk.kind === 'ok' ? `<span class="cp-ov-badge cp-ov-ok">${esc(L('verified'))}</span>` : chk.kind === 'full' ? `<span class="cp-ov-badge cp-ov-full">${esc(L('notSaving'))}</span>` : '';
    const check = `<p class="cp-ov-check cp-ov-check-${chk.kind}" role="status">${badge}<span>${esc(chk.text)}</span></p>`;
    const mt = curMetrics();
    const t = mt ? obj(mt.total) : null;
    if (!t || !t.tasks) return `<div class="cp-ov" data-cp-overall>${check}${mt ? '' : ''}</div>`;
    const saved = typeof t.t7Tokens === 'number' && typeof t.inputTokens === 'number' ? Math.max(0, t.t7Tokens - t.inputTokens) : null;
    const sp = typeof t.savedPct === 'number' ? Math.round(t.savedPct) : pct(t.inputTokens, t.t7Tokens);
    const tile = (k, v, sub, cls = '') => `<div class="cp-ov-tile ${cls}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd>${sub ? `<span class="cp-ov-sub">${esc(sub)}</span>` : ''}</div>`;
    const tiles = `<dl class="cp-ov-tiles">
      ${tile(L('requests'), fmtN(t.requests), `${fmtN(t.tasks)} task${t.tasks === 1 ? '' : 's'}`)}
      ${tile(L('saved'), sp == null ? '—' : `${sp}%`, saved == null ? '' : `${fmtK(saved)} tokens`, 'cp-ov-tile-hero')}
      ${tile(L('tokensSent'), fmtK(t.inputTokens), `${L('ifT7')} ${fmtK(t.t7Tokens)}`)}
      ${tile(L('avgLatency'), fmtMs(t.avgLatencyMs), typeof t.avgFirstTokenMs === 'number' ? `1st token ${fmtMs(t.avgFirstTokenMs)}` : '')}
      ${compact ? '' : tile(L('tasksDone'), `${fmtN(t.completed)} / ${fmtN(t.tasks)}`, typeof t.successRate === 'number' ? `${Math.round(t.successRate * 100)}%` : '')}
      ${tile(L('fallbacks'), fmtN(t.fallbacks), compact ? '' : `${L('retriesShort')} ${fmtN(t.retries)}`)}
    </dl>`;
    const byP = Object.entries(obj(mt.byPolicy)).filter(([, v]) => v && v.requests).sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0));
    const name = (id) => (registry().find((r) => r.id === id) || {}).name || '';
    const bars = byP.length ? `<ul class="cp-ov-bars" aria-label="${esc(L('byPolicy'))}">${byP.map(([id, v]) => {
      const s = typeof v.savedPct === 'number' ? Math.round(v.savedPct) : pct(v.inputTokens, v.t7Tokens) || 0;
      return `<li class="cp-ov-bar"><span class="cp-ov-bar-head">${chip(id, 'cp-chip-id')}<span class="cp-ov-bar-name">${esc(name(id))}</span><span class="cp-ov-bar-num">${esc(fill(L('perRequest'), { n: fmtN(v.requests) }))} · ${s}%</span></span><span class="cp-ov-track"><span class="cp-ov-fill" style="width:${Math.max(2, Math.min(100, s))}%"></span></span></li>`;
    }).join('')}</ul>` : '';
    const src = Object.entries(obj(mt.bySource)).filter(([, n]) => n);
    const srcLine = src.length ? `<p class="cp-ov-src"><span class="cp-label">${esc(L('pickedBy'))}</span> ${src.map(([k, n]) => `${chip(`${SOURCES[k] || k} ${n}`, 'cp-chip-src')}`).join(' ')}</p>` : '';
    return `<div class="cp-ov" data-cp-overall>${check}${tiles}${bars}${compact ? '' : srcLine}</div>`;
  }

  function errorPanel() {
    if (!lastError) return '';
    return `<div class="cp-err" role="alert"><span><b>${esc(lastError.what)}</b>: ${esc(lastError.message)}</span>${btn(L('retry'), 'data-cp="retry"', 'cp-btn-quiet')}</div>`;
  }

  function modeControl() {
    const m = mode();
    const opts = MODES.map((k) => `<button type="button" role="radio" class="cp-seg-btn" data-cp="mode" data-mode="${k}" aria-checked="${k === m}" tabindex="${k === m ? 0 : -1}"${busy === 'mode' ? ' disabled' : ''}>${esc(L(k))}</button>`).join('');
    return `<div class="cp-row cp-row-wrap"><div class="cp-seg" role="radiogroup" aria-label="${esc(L('mode'))}">${opts}</div>
      <span class="cp-muted">${esc(L('defaultPolicy'))}: ${chip('T7 full_context', 'cp-chip-lock')} <span class="cp-lock" aria-label="${esc(L('locked'))}">${esc(L('locked'))}</span></span></div>`;
  }

  function pinControl() {
    const pin = data && data.pin && data.pin.policy;
    const opts = POLICIES.map((p) => `<option value="${p}"${p === pin ? ' selected' : ''}>${p} ${esc((registry().find((r) => r.id === p) || {}).name || '')}</option>`).join('');
    return `<div class="cp-row cp-row-wrap"><label class="cp-field"><span class="cp-label">${esc(L('pin'))}</span><select class="cp-input" data-cp-in="pin" aria-label="${esc(L('pin'))}">${opts}</select></label>
      ${btn(L('pinBtn'), 'data-cp="pin"')}${pin ? btn(L('unpin'), 'data-cp="unpin"', 'cp-btn-quiet') : `<span class="cp-muted">${esc(L('noPin'))}</span>`}
      ${pin ? chip(`📌 ${pin}`, 'cp-chip-pin') : ''}</div>`;
  }

  function presets() {
    const rows = registry().map((p) => {
      const locked = p.id === 'T7';
      const defaults = Object.entries(obj(p.defaults)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
      return `<li class="cp-preset" data-policy="${esc(p.id)}">
        <div class="cp-preset-head">${chip(p.id, 'cp-chip-id')}<span class="cp-preset-name">${esc(p.name)}</span>${locked ? `<span class="cp-lock">${esc(L('locked'))}</span>` : ''}
          <button type="button" class="cp-btn cp-btn-quiet cp-btn-sm" data-cp="use" data-policy="${esc(p.id)}"${locked ? ' disabled aria-disabled="true"' : ''}>${esc(L('edit'))}</button></div>
        <p class="cp-desc">${esc(p.description)}</p>
        <dl class="cp-kv"><dt>${esc(L('keeps'))}</dt><dd>${esc(arr(p.keeps).join(', ') || p.keeps || '—')}</dd><dt>${esc(L('drops'))}</dt><dd>${esc(arr(p.drops).join(', ') || p.drops || '—')}</dd>${defaults ? `<dt>${esc(L('defaults'))}</dt><dd>${esc(defaults)}</dd>` : ''}</dl></li>`;
    }).join('');
    return `<p class="cp-muted cp-small">${esc(L('lifecycle'))}</p><ul class="cp-list">${rows}</ul>`;
  }

  function condText(c) { return typeof c === 'string' ? c : JSON.stringify(c); }
  function ruleConds(r) {
    const w = obj(r.if || r.when);
    const key = Array.isArray(w.all) ? 'all' : Array.isArray(w.any) ? 'any' : null;
    return key ? { join: key, conds: w[key] } : { join: 'all', conds: r.if ? [r.if] : [] };
  }

  function rulesList() {
    const rules = arr(rulesDoc().rules);
    const list = rules.length ? `<ul class="cp-list">${rules.map((r, i) => {
      const { join, conds } = ruleConds(r);
      const then = obj(r.then).policy || r.policy || '?';
      return `<li class="cp-rule" data-rule="${esc(r.id)}">
        <div class="cp-rule-head"><label class="cp-check"><input type="checkbox" data-cp-in="rule-enabled" data-i="${i}"${r.enabled !== false ? ' checked' : ''} aria-label="${esc(L('enabled'))} ${esc(r.id)}"></label>
          <span class="cp-rule-id">${esc(r.id)}</span>
          <label class="cp-prio"><span class="cp-sr">${esc(L('priority'))}</span><input class="cp-input cp-input-num" type="number" min="0" max="1000" value="${esc(r.priority == null ? 0 : r.priority)}" data-cp-in="rule-priority" data-i="${i}" aria-label="${esc(L('priority'))} ${esc(r.id)}"></label>
          ${btn(L('edit'), `data-cp="rule-edit" data-i="${i}"`, 'cp-btn-quiet cp-btn-sm')}${btn(L('del'), `data-cp="rule-del" data-i="${i}"`, 'cp-btn-danger cp-btn-sm')}</div>
        <div class="cp-rule-body"><span class="cp-kw">IF</span> ${conds.map((c) => `<code>${esc(condText(c))}</code>`).join(` <span class="cp-kw">${join === 'any' ? 'OR' : 'AND'}</span> `) || '<code>true</code>'} <span class="cp-kw">THEN</span> ${chip(then, 'cp-chip-id')}</div></li>`;
    }).join('')}</ul>` : `<p class="cp-empty">${esc(L('noRules'))}</p>`;
    const props = arr(data && data.proposals);
    const proposals = props.length ? `<div class="cp-sub"><h4 class="cp-h4">${esc(L('proposals'))}</h4><ul class="cp-list">${props.map((p) => {
      const r = obj(p.rule);
      return `<li class="cp-rule cp-proposal"><div class="cp-rule-head"><span class="cp-rule-id">${esc(r.id || '#' + p.id)}</span>${chip(obj(r.then).policy || '?', 'cp-chip-id')}
        ${btn(L('approve'), `data-cp="approve" data-id="${esc(p.id)}"`, 'cp-btn-primary cp-btn-sm')}${btn(L('reject'), `data-cp="reject" data-id="${esc(p.id)}"`, 'cp-btn-quiet cp-btn-sm')}</div>
        ${arr(p.errors).length ? `<p class="cp-bad">${esc(arr(p.errors).map((e) => (e && e.message) || e).join('; '))}</p>` : ''}</li>`;
    }).join('')}</ul></div>` : '';
    const dirty = draft ? `<div class="cp-row cp-dirty" role="status"><span>${esc(L('unsaved'))}</span>${btn(L('saveRules'), 'data-cp="rules-save"', 'cp-btn-primary')}${btn(L('revert'), 'data-cp="rules-revert"', 'cp-btn-quiet')}</div>` : '';
    return list + dirty + proposals;
  }

  function newBuilder(policy) {
    const f = fields()[0];
    return { id: '', priority: 50, join: 'all', policy: policy || 'T1', conds: [{ field: f ? f.field : '', op: f ? (f.operators || ['=='])[0] : '==', value: '' }], editing: -1, sample: (builder && builder.sample) || '' };
  }
  function condRow(c, i) {
    const fs = fields();
    const f = fs.find((x) => x.field === c.field) || fs[0] || { operators: ['=='], type: 'string' };
    const ops = arr(f.operators);
    return `<div class="cp-cond" data-i="${i}">
      <select class="cp-input" data-cp-in="b-field" data-i="${i}" aria-label="Field">${fs.map((x) => `<option value="${esc(x.field)}"${x.field === c.field ? ' selected' : ''}>${esc(x.field)}</option>`).join('')}</select>
      <select class="cp-input cp-input-op" data-cp-in="b-op" data-i="${i}" aria-label="Operator">${ops.map((o) => `<option${o === c.op ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
      ${c.op === 'exists' ? '' : f.type === 'bool' ? `<select class="cp-input" data-cp-in="b-value" data-i="${i}" aria-label="Value"><option${c.value === 'true' ? ' selected' : ''}>true</option><option${c.value === 'false' ? ' selected' : ''}>false</option></select>` : `<input class="cp-input" data-cp-in="b-value" data-i="${i}" value="${esc(c.value)}" aria-label="Value" placeholder="${f.type === 'int' || f.type === 'number' ? '0' : 'value'}">`}
      <button type="button" class="cp-icon-btn" data-cp="b-del" data-i="${i}" aria-label="${esc(L('remove'))}" title="${esc(L('remove'))}">×</button></div>`;
  }
  function builderView() {
    if (!builder) builder = newBuilder();
    const b = builder;
    const pv = previewOut ? (previewOut.valid === false ? `<p class="cp-bad">${esc(arr(previewOut.errors).map((e) => `${e.path}: ${e.message}`).join('; '))}</p>` : `<div class="cp-preview" role="status"><div>${chip(previewOut.policy || '?', 'cp-chip-id')} ${esc(previewOut.policyName || '')} · ${esc(L('source'))}: ${esc(SOURCES[previewOut.source] || previewOut.source || '')}${previewOut.rule ? ` · ${esc(previewOut.rule)}` : ''}</div><div class="cp-small cp-muted">${esc(L('checklist'))}: ${esc(arr(obj(previewOut.checklist).items).join(', ') || '—')}</div></div>`) : '';
    return `<div class="cp-builder">
      <div class="cp-row cp-row-wrap"><label class="cp-field"><span class="cp-label">${esc(L('ruleId'))}</span><input class="cp-input" data-cp-in="b-id" value="${esc(b.id)}" placeholder="R_MY_RULE" aria-label="${esc(L('ruleId'))}"></label>
        <label class="cp-field cp-field-sm"><span class="cp-label">${esc(L('priority'))}</span><input class="cp-input cp-input-num" type="number" min="0" max="1000" data-cp-in="b-priority" value="${esc(b.priority)}" aria-label="${esc(L('priority'))}"></label>
        <label class="cp-field cp-field-sm"><span class="cp-label">Join</span><select class="cp-input" data-cp-in="b-join" aria-label="Join"><option value="all"${b.join === 'all' ? ' selected' : ''}>${esc(L('all'))}</option><option value="any"${b.join === 'any' ? ' selected' : ''}>${esc(L('any'))}</option></select></label></div>
      <div class="cp-conds"><span class="cp-kw">IF</span>${b.conds.map(condRow).join('')}${btn('+ ' + L('addCond'), 'data-cp="b-add"', 'cp-btn-quiet cp-btn-sm')}</div>
      <div class="cp-row cp-row-wrap"><span class="cp-kw">THEN</span><select class="cp-input" data-cp-in="b-policy" aria-label="${esc(L('then'))}">${POLICIES.map((p) => `<option value="${p}"${p === b.policy ? ' selected' : ''}>${p} ${esc((registry().find((r) => r.id === p) || {}).name || '')}</option>`).join('')}</select></div>
      <div class="cp-row cp-row-wrap"><label class="cp-field cp-grow"><span class="cp-label">${esc(L('sample'))}</span><input class="cp-input" data-cp-in="b-sample" value="${esc(b.sample)}" placeholder="Turn on the torch" aria-label="${esc(L('sample'))}"></label>${btn(L('preview'), 'data-cp="b-preview"', 'cp-btn-quiet')}</div>
      ${pv}
      <div class="cp-row cp-actions">${btn(L('validate'), 'data-cp="b-validate"', 'cp-btn-quiet')}${btn(b.editing >= 0 ? L('save') : L('addRule'), 'data-cp="b-add-rule"', 'cp-btn-primary')}</div>
      ${builder.errors ? `<p class="cp-bad" role="alert">${esc(builder.errors)}</p>` : ''}</div>`;
  }

  function builderRule() {
    const b = builder;
    const conds = b.conds.filter((c) => c.field).map((c) => {
      if (c.op === 'exists') return `${c.field} exists`;
      const f = fields().find((x) => x.field === c.field) || {};
      const raw = String(c.value == null ? '' : c.value).trim();
      let v = raw;
      if (c.op === 'in') v = `[${raw.split(',').map((s) => JSON.stringify(s.trim())).filter((s) => s !== '""').join(', ')}]`;
      else if (f.type === 'string' || f.type === 'str') v = JSON.stringify(raw);
      return `${c.field} ${c.op} ${v}`;
    });
    return { id: b.id.trim(), enabled: true, priority: Number(b.priority) || 0, if: { [b.join]: conds }, then: { policy: b.policy } };
  }
  function docWithBuilder() {
    const d = clone(rulesDoc());
    if (!Array.isArray(d.rules)) d.rules = [];
    const r = builderRule();
    if (builder.editing >= 0 && builder.editing < d.rules.length) d.rules[builder.editing] = r; else d.rules.push(r);
    return d;
  }

  function advanced() {
    const text = jsonText != null ? jsonText : JSON.stringify(rulesDoc(), null, 2);
    const res = jsonCheck ? (jsonCheck.valid ? `<span class="cp-good" role="status">✓ ${esc(L('valid'))}</span>` : `<ul class="cp-errs" role="alert">${arr(jsonCheck.errors).map((e) => `<li><code>${esc(e.path || '')}</code> ${esc(e.message || e)}</li>`).join('')}</ul>`) : '';
    return `<details class="cp-adv"${jsonText != null || jsonCheck ? ' open' : ''}><summary>${esc(L('advanced'))}</summary>
      <textarea class="cp-json" data-cp-in="json" spellcheck="false" aria-label="${esc(L('advanced'))}" rows="12">${esc(text)}</textarea>
      <div class="cp-row cp-actions">${btn(L('validate'), 'data-cp="json-validate"', 'cp-btn-quiet')}<button type="button" class="cp-btn cp-btn-primary" data-cp="json-save"${jsonCheck && jsonCheck.valid ? '' : ' disabled aria-disabled="true"'}>${esc(L('save'))}</button></div>${res}</details>`;
  }

  function exclusionsView() {
    const ex = exclusions();
    const box = (kind, id, label, prot) => `<label class="cp-opt${prot ? ' cp-opt-locked' : ''}"><input type="checkbox" data-cp-in="ex" data-kind="${kind}" data-id="${esc(id)}"${ex[kind].includes(id) ? ' checked' : ''}${prot ? ' disabled aria-disabled="true"' : ''}><span>${esc(label)}</span></label>`;
    const cats = CATEGORIES.map(([id, t]) => box('categories', id, `${t} (${id})`, id === 'sys' || id === 'ess')).join('');
    const groups = GROUPS.map((g) => box('groups', g, g, false)).join('');
    let items = [];
    try { const s = ct() && ct().state && ct().state(); items = arr(s && s.items).filter((it) => it && typeof it.id === 'string').slice(0, 80); } catch (e) { items = []; }
    const itemBoxes = items.map((it) => box(it.id.startsWith('turn/') && !it.id.slice(5).includes('/') ? 'turn_ids' : 'item_ids', it.id.startsWith('turn/') && !it.id.slice(5).includes('/') ? it.id.slice(5) : it.id, `${it.title ? it.title + ' · ' : ''}${it.id}`, isProtected(it.id))).join('');
    return `<p class="cp-muted cp-small">${esc(L('protectedNote'))}</p>
      <fieldset class="cp-fs"><legend>${esc(L('categories'))}</legend><div class="cp-opts">${cats}</div></fieldset>
      <fieldset class="cp-fs"><legend>${esc(L('groups'))}</legend><div class="cp-opts">${groups}</div></fieldset>
      ${itemBoxes ? `<fieldset class="cp-fs"><legend>${esc(L('items'))}</legend><div class="cp-opts cp-opts-col">${itemBoxes}</div></fieldset>` : ''}`;
  }

  function timeline(task, events) {
    const steps = ['Initial T7'];
    const evs = arr(events).filter((e) => !task || e.taskId === task.taskId).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    if (task) steps.push('Tool Call + Temp Checklist');
    for (const e of evs) {
      if (e.kind === 'step' && e.policy) { const t = `${e.policy} Follow-up`; if (steps[steps.length - 1] !== t) steps.push(t); }
      else if (/subagent/.test(e.kind || '')) steps.push('Sub-agent');
      else if (e.kind === 'fallback' || e.kind === 'steer') steps.push(e.kind === 'steer' ? 'Steer → T7' : 'Fallback → T7');
      else if (e.kind === 'escalation' || e.kind === 'escalate') steps.push(`Escalate → ${e.policy || ''}`);
    }
    if (live && (!task || live.taskId === task.taskId) && live.policy && steps[steps.length - 1] !== `${live.policy} Follow-up`) steps.push(`${live.policy} Follow-up`);
    const status = task && task.status;
    if (status && status !== 'active') { steps.push('Final Answer'); steps.push(status[0].toUpperCase() + status.slice(1).replace(/_/g, ' ')); }
    return `<ol class="cp-tl" aria-label="${esc(L('timeline'))}">${steps.map((s, i) => `<li class="cp-tl-step${i === steps.length - 1 ? ' cp-tl-now' : ''}">${esc(s)}</li>`).join('')}</ol>`;
  }

  function taskView(compact) {
    const task = (data && data.activeTask) || null;
    const events = arr(data && data.events);
    const lastStep = events.slice().reverse().find((e) => (!task || e.taskId === task.taskId) && typeof e.inputTokens === 'number');
    const sent = live && typeof live.tokens === 'number' ? live.tokens : lastStep ? lastStep.inputTokens : null;
    const t7 = live && typeof live.t7Tokens === 'number' ? live.t7Tokens : lastStep ? lastStep.t7Tokens : null;
    const fallbacks = events.filter((e) => e.kind === 'fallback' && (!task || e.taskId === task.taskId)).length;
    const latency = lastStep && typeof lastStep.latencyMs === 'number' ? `${fmtN(lastStep.latencyMs)} ms` : '—';
    const tokens = `<dl class="cp-stats"><div><dt>${esc(L('sent'))}</dt><dd>${fmtN(sent)}</dd></div><div><dt>${esc(L('ifT7'))}</dt><dd>${fmtN(t7)}</dd></div><div><dt>${esc(L('saved'))}</dt><dd>${typeof sent === 'number' && typeof t7 === 'number' && t7 > 0 ? Math.max(0, Math.round((1 - sent / t7) * 100)) + '%' : '—'}</dd></div><div><dt>Latency</dt><dd>${esc(latency)}</dd></div><div><dt>${esc(L('fallbacks'))}</dt><dd>${fallbacks}</dd></div></dl>`;
    if (!task) return `<p class="cp-empty">${esc(L('noTask'))}</p>${live ? tokens : ''}`;
    const goal = obj(task.goal);
    const items = arr(obj(task.checklist).items);
    const req = String(goal.user_request || goal.request || '');
    return `<div class="cp-task">
      <div class="cp-row cp-row-wrap">${chip(task.policy, 'cp-chip-id')}${chip(SOURCES[task.source] || task.source || '', 'cp-chip-src')}${chip(task.status || 'active', 'cp-chip-status')}<span class="cp-muted cp-small">${esc(L('retries'))} ${esc(task.retries || 0)} · ${esc(L('escalations'))} ${esc(task.escalations || 0)}</span></div>
      <p class="cp-req"><span class="cp-label">${esc(L('request'))}</span> ${esc(req.length > 220 ? req.slice(0, 220) + '…' : req)}</p>
      <div><span class="cp-label">${esc(L('checklist'))}</span><div class="cp-items">${items.length ? items.slice(0, compact ? 12 : 60).map((i) => `<code class="cp-item">${esc(i)}</code>`).join('') : '<span class="cp-muted">—</span>'}${items.length > (compact ? 12 : 60) ? `<span class="cp-muted">+${items.length - (compact ? 12 : 60)}</span>` : ''}</div></div>
      ${timeline(task, events)}${tokens}</div>`;
  }

  function recentView() {
    const rec = arr(data && data.recentTasks).slice(0, 8);
    const evs = arr(data && data.events).slice(-12).reverse();
    const r = rec.length ? `<ul class="cp-list cp-compact">${rec.map((t) => `<li class="cp-recent">${chip(t.policy, 'cp-chip-id')}<span class="cp-grow cp-ellipsis">${esc(obj(t.goal).user_request || t.taskId)}</span>${chip(t.status || '', 'cp-chip-status')}</li>`).join('')}</ul>` : '';
    const e = evs.length ? `<details class="cp-adv"><summary>${esc(L('events'))}</summary><ul class="cp-list cp-compact">${evs.map((x) => `<li class="cp-event"><code>${esc(x.kind)}</code> ${x.policy ? chip(x.policy, 'cp-chip-id') : ''} <span class="cp-muted">${esc(x.reason || '')}</span></li>`).join('')}</ul></details>` : '';
    return r + e || '<p class="cp-empty">—</p>';
  }

  /** What shows before the first policy.get answer: never an endless "Loading…". */
  function placeholder() {
    if (unsupported) {
      return `<div class="cp-warn cp-unsupported" role="alert" data-cp-unsupported="1"><b>${esc(L('unsupportedTitle'))}</b><br>${esc(L('unsupported'))}</div>`
        + (lastError ? `<p class="cp-empty"><small>${esc(lastError.message)}</small></p>` : '');
    }
    if (lastError) return errorPanel();
    return `<p class="cp-empty" role="status">${esc(L('loading'))}</p>`;
  }

  /** The whole workspace (also what tests read). */
  function render() {
    if (!available()) return '';
    if (!data) return `<div class="cp-root">${placeholder()}</div>`;
    return `<div class="cp-root">${errorPanel()}
      <p class="cp-lead">${esc(L('note'))}</p>
      ${data.rulesWarning ? `<p class="cp-warn" role="status">${esc(data.rulesWarning)}</p>` : ''}
      ${section('overall', L('overall'), overallView(false))}
      ${section('mode', L('mode'), modeControl() + pinControl())}
      ${section('task', L('task'), taskView(false))}
      ${section('rules', L('rules'), rulesList())}
      ${section('builder', L('builder'), builderView() + advanced())}
      ${section('exclusions', L('exclusions'), exclusionsView())}
      ${section('presets', L('presets'), presets())}
      ${section('recent', L('recent'), recentView())}</div>`;
  }

  /** The compact Policy tab of the context card. */
  function renderTab() {
    if (!available()) return '';
    if (!data) return `<div class="cp-root cp-tab">${placeholder()}</div>`;
    return `<div class="cp-root cp-tab">${errorPanel()}${modeControl()}<div class="cp-tab-block"><h4 class="cp-h">${esc(L('overall'))}</h4>${overallView(true)}</div><div class="cp-tab-block"><h4 class="cp-h">${esc(L('task'))}</h4>${taskView(true)}</div><div class="cp-row">${btn(L('open'), 'data-cp="open"', 'cp-btn-primary')}</div></div>`;
  }

  // ------------------------------------------------------------- painting
  function paint() {
    for (const fn of [...listeners]) { try { fn(); } catch (e) { /* a listener is not our problem */ } }
    for (const h of [...hosts]) {
      if (!h.el || !h.el.isConnected) { hosts.delete(h); continue; }
      const a = document.activeElement;
      if (a && h.el.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox') continue; // never repaint under the fingers
      const html = (() => { try { return h.kind === 'tab' ? renderTab() : render(); } catch (e) { console.warn('context policy paint', e); return null; } })();
      if (html == null) continue;
      const sc = h.el.scrollTop;
      h.el.innerHTML = html;
      h.el.scrollTop = sc;
    }
  }

  function wire(el) {
    if (el._cpWired) return;
    el._cpWired = true;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
  }

  function mount(el) {
    if (!el) return;
    wire(el);
    if (![...hosts].some((h) => h.el === el)) hosts.add({ el, kind: 'workspace' });
    paint();
    if (!data) refresh();
  }

  function paintTab(el) {
    if (!el) return;
    wire(el);
    if (![...hosts].some((h) => h.el === el)) hosts.add({ el, kind: 'tab' });
    paint();
    refresh();
  }

  // ------------------------------------------------------------- dialog
  function open() {
    if (!available()) return null;
    if (!dialog) {
      dialog = document.createElement('div');
      dialog.className = 'cp-dialog-wrap';
      dialog.innerHTML = `<div class="cp-backdrop" data-cp="close"></div><div class="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="cp-title"><header class="cp-dialog-head"><h2 id="cp-title" class="cp-title">${esc(L('title'))}</h2><button type="button" class="cp-icon-btn" data-cp="close" aria-label="${esc(L('close'))}">×</button></header><div class="cp-dialog-body"></div></div>`;
      dialog.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('[data-cp="close"]'); if (t && !t.closest('.cp-dialog-body')) close(); });
      dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'Tab') trapFocus(e); });
      document.body.appendChild(dialog);
    }
    dialog.hidden = false;
    dialog._return = document.activeElement;
    mount(dialog.querySelector('.cp-dialog-body'));
    refresh();
    const c = dialog.querySelector('.cp-icon-btn');
    if (c) c.focus();
    return dialog;
  }
  function close() {
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    const r = dialog._return;
    if (r && r.focus && r.isConnected) { try { r.focus(); } catch (e) { /* gone */ } }
  }
  const isOpen = () => !!(dialog && !dialog.hidden);
  function trapFocus(e) {
    const f = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ------------------------------------------------------------- actions
  async function setMode(m) {
    if (!MODES.includes(m) || m === mode()) return;
    busy = 'mode'; paint();
    const r = await call('ctx.settings', { settings: { policy_mode: m } }, 'mode');
    busy = '';
    if (r) { data = { ...(data || {}), settings: { ...obj(data && data.settings), policy_mode: m } }; }
    await refresh();
  }

  async function saveDoc(doc, confirmText) {
    const v = await call('policy.validate', { rules: doc }, 'validate');
    if (!v) return false;
    if (!v.valid) { jsonCheck = { valid: false, errors: arr(v.errors) }; paint(); return false; }
    if (confirmText && typeof window.confirm === 'function' && !window.confirm(confirmText)) return false;
    const r = await call('policy.save', { rules: doc }, 'save');
    if (!r) return false;
    if (!r.saved) { jsonCheck = { valid: false, errors: arr(r.errors) }; paint(); return false; }
    draft = null; jsonText = null; jsonCheck = null;
    await refresh();
    return true;
  }

  function onClick(ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-cp]') : null;
    if (!t || t.disabled) return;
    const a = t.dataset.cp;
    const i = Number(t.dataset.i);
    if (a === 'retry') { lastError = null; refresh(); }
    else if (a === 'open') open();
    else if (a === 'close') close();
    else if (a === 'mode') setMode(t.dataset.mode);
    else if (a === 'pin') {
      const host = t.closest('.cp-root');
      const sel = host && host.querySelector('[data-cp-in="pin"]');
      const p = sel ? sel.value : 'T7';
      call('policy.pin', { policy: p }, 'pin').then((r) => { if (r) refresh(); });
    } else if (a === 'unpin') call('policy.unpin', {}, 'unpin').then((r) => { if (r) refresh(); });
    else if (a === 'use') { builder = newBuilder(t.dataset.policy); paint(); focusIn('[data-cp-in="b-id"]'); }
    else if (a === 'rule-del') {
      const d = arr(rulesDoc().rules)[i];
      if (!d) return;
      if (typeof window.confirm === 'function' && !window.confirm(`${L('confirmDel')} ${d.id}?`)) return;
      editDraft().rules.splice(i, 1); paint();
    } else if (a === 'rule-edit') {
      const r = arr(rulesDoc().rules)[i];
      if (!r) return;
      const { join, conds } = ruleConds(r);
      builder = { id: r.id || '', priority: r.priority || 0, join, policy: obj(r.then).policy || 'T7', editing: i, sample: builder ? builder.sample : '', conds: conds.map((c) => {
        const s = condText(c).trim();
        const ex = s.match(/^(\S+)\s+exists$/);
        if (ex) return { field: ex[1], op: 'exists', value: '' };
        const m = s.match(/^(\S+)\s+(==|!=|>=|<=|>|<|in|contains)\s+(.*)$/);
        if (!m) return { field: s, op: '==', value: '' };
        let v = m[3];
        try { const p = JSON.parse(v); v = Array.isArray(p) ? p.join(', ') : String(p); } catch (e) { /* bare */ }
        return { field: m[1], op: m[2], value: v };
      }) };
      if (!builder.conds.length) builder.conds = newBuilder().conds;
      paint(); focusIn('[data-cp-in="b-id"]');
    } else if (a === 'rules-save') saveDoc(rulesDoc(), L('confirmSave'));
    else if (a === 'rules-revert') { draft = null; jsonText = null; jsonCheck = null; paint(); }
    else if (a === 'approve' || a === 'reject') call(`policy.${a}`, { id: Number(t.dataset.id) }, a).then((r) => { if (r) refresh(); });
    else if (a === 'b-add') { const f = fields()[0]; builder.conds.push({ field: f ? f.field : '', op: f ? arr(f.operators)[0] || '==' : '==', value: '' }); paint(); }
    else if (a === 'b-del') { builder.conds.splice(i, 1); if (!builder.conds.length) builder.conds = newBuilder().conds; paint(); }
    else if (a === 'b-validate' || a === 'b-add-rule') {
      if (!builder.id.trim()) { builder.errors = `${L('ruleId')}: required`; paint(); return; }
      const doc = docWithBuilder();
      call('policy.validate', { rules: doc }, 'validate').then((v) => {
        if (!v) return;
        if (!v.valid) { builder.errors = arr(v.errors).map((e) => `${e.path}: ${e.message}`).join('; '); paint(); return; }
        builder.errors = '';
        if (a === 'b-add-rule') { draft = doc; jsonText = null; jsonCheck = null; builder = newBuilder(); }
        else builder.errors = '';
        paint();
      });
    } else if (a === 'b-preview') {
      const doc = builder.id.trim() ? docWithBuilder() : rulesDoc();
      call('policy.preview', { request: builder.sample || '', rules: doc, mode: 'auto' }, 'preview').then((r) => { if (r) { previewOut = r; paint(); } });
    } else if (a === 'json-validate') {
      let doc;
      try { doc = JSON.parse(jsonText != null ? jsonText : JSON.stringify(rulesDoc())); } catch (e) { jsonCheck = { valid: false, errors: [{ path: '$', message: String(e.message || e) }] }; paint(); return; }
      call('policy.validate', { rules: doc }, 'validate').then((v) => { if (v) { jsonCheck = { valid: !!v.valid, errors: arr(v.errors) }; paint(); } });
    } else if (a === 'json-save') {
      if (!jsonCheck || !jsonCheck.valid) return;
      let doc;
      try { doc = JSON.parse(jsonText != null ? jsonText : JSON.stringify(rulesDoc())); } catch (e) { return; }
      saveDoc(doc, L('confirmSave'));
    }
  }

  function focusIn(sel) { setTimeout(() => { for (const h of hosts) { const x = h.el && h.el.querySelector(sel); if (x) { x.focus(); return; } } }, 0); }

  function onChange(ev) {
    const t = ev.target;
    const k = t && t.dataset && t.dataset.cpIn;
    if (!k) return;
    const i = Number(t.dataset.i);
    if (k === 'rule-enabled') { const r = editDraft().rules[i]; if (r) r.enabled = !!t.checked; paint(); }
    else if (k === 'rule-priority') { const r = editDraft().rules[i]; if (r) r.priority = Math.max(0, Math.min(1000, Number(t.value) || 0)); paint(); }
    else if (k === 'ex') {
      const d = editDraft();
      const ex = exclusions(d);
      const list = ex[t.dataset.kind];
      const id = t.dataset.id;
      if (!list || isProtected(id) || (t.dataset.kind === 'categories' && (id === 'sys' || id === 'ess'))) { t.checked = false; return; }
      const at = list.indexOf(id);
      if (t.checked && at < 0) list.push(id); else if (!t.checked && at >= 0) list.splice(at, 1);
      d.exclusions = { ...obj(d.exclusions), always_exclude: ex };
      paint();
    } else if (k === 'b-field') { const f = fields().find((x) => x.field === t.value); builder.conds[i] = { field: t.value, op: f ? arr(f.operators)[0] || '==' : '==', value: '' }; paint(); }
    else if (k === 'b-op') { builder.conds[i].op = t.value; paint(); }
    else if (k === 'b-value' && t.tagName === 'SELECT') builder.conds[i].value = t.value;
    else if (k === 'b-join') builder.join = t.value === 'any' ? 'any' : 'all';
    else if (k === 'b-policy') builder.policy = t.value;
  }

  function onInput(ev) {
    const t = ev.target;
    const k = t && t.dataset && t.dataset.cpIn;
    if (!k || !builder) { if (k === 'json') { jsonText = t.value; jsonCheck = null; const s = t.closest('.cp-adv'); const b = s && s.querySelector('[data-cp="json-save"]'); if (b) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); } } return; }
    const i = Number(t.dataset.i);
    if (k === 'b-id') builder.id = t.value.replace(/[^A-Za-z0-9_\-]/g, '_');
    else if (k === 'b-priority') builder.priority = Number(t.value) || 0;
    else if (k === 'b-value') builder.conds[i].value = t.value;
    else if (k === 'b-sample') builder.sample = t.value;
    else if (k === 'json') { jsonText = t.value; jsonCheck = null; const s = t.closest('.cp-adv'); const b = s && s.querySelector('[data-cp="json-save"]'); if (b) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); } }
  }

  function onKey(ev) {
    const t = ev.target;
    if (!t || !t.classList || !t.classList.contains('cp-seg-btn')) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    const all = [...t.parentNode.querySelectorAll('.cp-seg-btn')];
    let n = all.indexOf(t);
    if (ev.key === 'Home') n = 0; else if (ev.key === 'End') n = all.length - 1;
    else n = (n + (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 1) + all.length) % all.length;
    all[n].focus();
    setMode(all[n].dataset.mode);
  }

  /** A `context.policy` event from the engine: the step's policy and sizes. */
  function onEvent(type, payload) {
    if (type !== 'context.policy' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    // A step of another chat (a sub-agent, a background chat) is not this chat's number.
    const k = sessionKey();
    if (typeof payload.sessionKey === 'string' && payload.sessionKey && k && payload.sessionKey !== k) return;
    queueMetrics();
    live = {
      policy: typeof payload.policy === 'string' ? payload.policy : null,
      source: typeof payload.source === 'string' ? payload.source : null,
      taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
      tokens: typeof payload.tokens === 'number' ? payload.tokens : null,
      t7Tokens: typeof payload.t7Tokens === 'number' ? payload.t7Tokens : null,
      reason: typeof payload.reason === 'string' ? payload.reason : null,
    };
    if (data && live.taskId && (!data.activeTask || data.activeTask.taskId !== live.taskId)) refresh();
    else paint();
  }

  function install() {
    try {
      if (typeof document !== 'undefined' && !document._cpEsc) {
        document._cpEsc = true;
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
      }
    } catch (e) { console.warn('context policy install', e); }
  }

  /** Totals and the policy check for other views (the Checklist's Activity). */
  function summary() {
    if (!available()) return null;
    const mt = curMetrics();
    return { mode: data ? mode() : null, pin: (data && data.pin && data.pin.policy) || null, live, task: (data && data.activeTask) || null, metrics: mt, steps: recentSteps(), check: data ? checkLine() : null, registry: registry() };
  }
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const out = { install, mount, render, renderTab, paintTab, open, close, isOpen, onEvent, refresh, available, data: () => data, metrics: curMetrics, summary, subscribe, error: () => lastError, unsupported: () => unsupported, labels: LABEL };
  if (typeof window !== 'undefined') window.__contextPolicies = out;
  return out;
})();
