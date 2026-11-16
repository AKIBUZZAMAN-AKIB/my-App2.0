/* ==========================================================================
   Chat memory: what the agent keeps of the earlier turns of this chat.
   Long chats are summarized in batches (turn_memory.rs): the last
   `keepRecent` turns go to the model in full, older ones as a structured
   summary with decisions by ID (current / superseded), facts, preferences,
   files, open items and a turn index by topic. The originals and large tool
   results are stored and can be read back.

   This screen shows it per chat, from the engine's memory.* actions:
   status (summarized through turn N, summarizing now, "summary failed, will
   retry"), the summary, the version history with repair evidence and Revert,
   the archived turns, the stored results (R-ids, unavailable when gone) and
   the settings, the chat's goals (G001… with active / paused / completed /
   cancelled / replaced, the current one and their history) and, in Context,
   which memory records the last model call was given. A small indicator in the top bar opens it and shows the
   state at a glance. Available when the engine lists "turnMemory".
   ========================================================================== */
const ChatMemory = (() => {
  const KIND_LABEL = { summary: 'Summary', repair: 'Repair', revert: 'Revert', reset: 'Reset' };
  const DEFAULTS = { enabled: true, keepRecent: 7, batch: 7 };
  const ITEM_KINDS = [['fact', 'Facts'], ['preference', 'Preferences'], ['file', 'Files and identifiers'], ['openItem', 'Open items']];
  const STATUS_LABEL = { current: 'Current', done: 'Done', retired: 'Retired', superseded: 'Replaced' };
  const CHANGE_LABEL = { updated: 'Updated', done: 'Marked done', retired: 'Retired', superseded: 'Replaced', reopened: 'Reopened' };
  const GOAL_LABEL = { active: 'Active', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', superseded: 'Replaced' };
  const GOAL_OP_LABEL = { create: 'Started', switch: 'Switched to', resume: 'Resumed', complete: 'Completed', cancel: 'Cancelled', supersede: 'Replaced', update: 'Updated' };
  const JOB_LABEL = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
  // Icons this screen needs beyond the shared set (lucide, same stroke).
  Object.assign(ICONS, {
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'git-compare': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  });

  let appRef = null;
  let indicator = null;
  let liveRegion = null;
  let screen = null; // the open dialog's api
  /** sessionKey -> { data, results, loading, error, summarizing, notice } */
  const chats = new Map();
  const subs = new Set();

  const activeKey = () => appRef?.chat?.mainId || null;
  const available = () => {
    try { return engine.has('turnMemory') && typeof nativeKit()?.agent?.subagents === 'function'; } catch { return false; }
  };
  const chat = (key) => { if (!chats.has(key)) chats.set(key, { data: null, results: null, loading: false, error: '', summarizing: null, notice: null }); return chats.get(key); };
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const errText = (e) => (typeof redactSecrets === 'function' ? redactSecrets(e?.message || String(e), 300) : String(e?.message || e));
  const notify = (key) => { for (const fn of subs) { try { fn(key); } catch { /* a listener failed */ } } };

  function parseResult(r) {
    if (r == null) return {};
    if (typeof r === 'string') return parseMaybeJSON(r, {}) || {};
    if (typeof r.resultJson === 'string') return parseMaybeJSON(r.resultJson, {}) || {};
    if (typeof r.json === 'string') return parseMaybeJSON(r.json, {}) || {};
    return r;
  }
  async function call(action, key, extra = {}) {
    if (!available()) throw new Error('Chat memory needs a newer app engine.');
    eventLog.add('call', `memory(${action})`);
    return parseResult(await nativeKit().agent.subagents({ action, sessionKey: key, ...extra }));
  }

  /* ---------- formatting ---------- */
  const range = (a, b) => (num(a) === num(b) || !b ? `turn ${num(a)}` : `turns ${num(a)}\u2013${num(b)}`);
  const Range = (a, b) => range(a, b).replace(/^t/, 'T');
  function fmtBytes(n) {
    n = num(n);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }
  function ago(ms) {
    ms = num(ms);
    if (!ms) return '';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    if (hr < 24) return `${hr} h ago`;
    try { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
  }
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /* ---------- state ---------- */
  /** The state the indicator and the status box show. */
  function phase(key) {
    const c = chats.get(key);
    const d = c?.data;
    if (c?.summarizing) return 'busy';
    if (!d) return c?.error ? 'error' : 'unknown';
    if (d.status?.status && d.status.status !== 'ok') return 'pending';
    if (d.settings && d.settings.enabled === false) return 'off';
    return num(d.memory?.throughTurn) > 0 ? 'ok' : 'empty';
  }

  async function refresh(key = activeKey(), { results = false } = {}) {
    if (!key || !available()) return null;
    const c = chat(key);
    c.loading = true;
    try {
      const d = await call('memory.get', key);
      c.data = d;
      c.error = '';
      // A summary running in the engine (also after a reload) shows as one.
      if (d.summarizing && typeof d.summarizing === 'object') c.summarizing = { fromTurn: num(d.summarizing.fromTurn), toTurn: num(d.summarizing.toTurn) };
      else if (d.summarizing === null) c.summarizing = null;
      if (results || c.results) c.results = await call('memory.results', key).catch(() => c.results);
    } catch (e) {
      c.error = errText(e);
    } finally {
      c.loading = false;
    }
    paintIndicator();
    notify(key);
    return c.data;
  }

  /* ---------- engine events ---------- */
  const refreshSoon = (() => {
    const timers = new Map();
    return (key, delay = 150) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); refresh(key); }, delay)); };
  })();

  /** One engine event; true when it was a memory event. */
  function onEvent(type, p) {
    p = p && typeof p === 'object' ? p : {};
    const key = typeof p.sessionKey === 'string' && p.sessionKey ? p.sessionKey : activeKey();
    if (!key) return false;
    if (type === 'agent.completed' || type === 'agent.error' || type === 'agent.background_timeout') {
      // A run ended: whatever it was summarizing is over (a dropped run sends no memory event).
      const c = chats.get(key);
      if (c?.summarizing) { c.summarizing = null; refreshSoon(key); paintIndicator(); notify(key); }
      return false;
    }
    if (!type.startsWith('memory.')) return false;
    const c = chat(key);
    switch (type) {
      case 'memory.summarizing':
        c.summarizing = { fromTurn: num(p.fromTurn), toTurn: num(p.toTurn) };
        announce(key, `Summarizing ${range(p.fromTurn, p.toTurn)}.`);
        break;
      case 'memory.updated':
        c.summarizing = null;
        announce(key, `Memory updated: summarized through turn ${num(p.throughTurn)}.`);
        refreshSoon(key, 0);
        break;
      case 'memory.pending':
      case 'memory.failed':
        c.summarizing = null;
        announce(key, p.jobStatus === 'failed' ? 'Background summary failed. Retry it from the memory screen.' : p.jobStatus === 'queued' ? 'Summary failed, will retry automatically.' : 'Summary failed, will retry on the next turn.');
        refreshSoon(key, 0);
        break;
      case 'memory.cancelled':
        c.summarizing = null;
        refreshSoon(key, 0);
        break;
      case 'memory.queued':
        // A background summary was queued; the turn did not wait for it.
        refreshSoon(key, 0);
        break;
      case 'memory.repaired':
        c.notice = { type: 'info', text: `The memory was repaired as version ${num(p.version)}. You can revert it in History.` };
        refreshSoon(key, 0);
        break;
      case 'memory.repair_rejected':
        c.notice = { type: 'info', text: `A repair proposal was rejected and nothing changed: ${String(p.reason || 'its evidence did not match the original turn')}.` };
        notify(key);
        break;
      default:
        refreshSoon(key);
    }
    paintIndicator();
    notify(key);
    return true;
  }

  function announce(key, text) {
    if (key !== activeKey() || !liveRegion) return;
    liveRegion.textContent = '';
    setTimeout(() => { liveRegion.textContent = text; }, 30);
  }

  /* ---------- indicator ---------- */
  function indicatorLabel(key) {
    const c = chats.get(key);
    const d = c?.data;
    switch (phase(key)) {
      case 'busy': return `Chat memory: summarizing ${range(c.summarizing.fromTurn, c.summarizing.toTurn)}`;
      case 'pending': return 'Chat memory: summary failed, will retry';
      case 'off': return 'Chat memory is off';
      case 'ok': return `Chat memory: summarized through turn ${num(d.memory.throughTurn)}`;
      case 'error': return 'Chat memory: could not load';
      default: return 'Chat memory';
    }
  }
  function paintIndicator() {
    if (!indicator) return;
    const key = activeKey();
    const on = !!key && available();
    indicator.hidden = !on;
    if (!on) return;
    const ph = phase(key);
    const label = indicatorLabel(key);
    indicator.dataset.state = ph;
    indicator.setAttribute('aria-label', label);
    indicator.dataset.tooltip = label;
    const through = num(chats.get(key)?.data?.memory?.throughTurn);
    indicator.querySelector('.cm-ind-count').textContent = ph === 'ok' || (ph === 'busy' && through) ? String(through) : '';
  }

  function mountIndicator() {
    if (indicator?.isConnected) return;
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    indicator = h('button', {
      type: 'button', class: 'btn btn-ghost cm-ind', 'data-slot': 'memory-indicator', 'aria-haspopup': 'dialog', hidden: true,
      onclick: () => open(),
    }, icon('brain'), h('span', { class: 'cm-ind-count', 'aria-hidden': 'true' }), h('span', { class: 'cm-ind-dot', 'aria-hidden': 'true' }));
    liveRegion = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-slot': 'memory-live' });
    bar.insertBefore(indicator, bar.querySelector('.topbar-new') || null);
    bar.append(liveRegion);
    paintIndicator();
  }

  /* ---------- small pieces ---------- */
  const fmtDay = (ms) => { const d = new Date(num(ms)); return Number.isFinite(d.getTime()) && num(ms) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; };
  const ranges = (list) => (Array.isArray(list) ? list : []).map((r) => (Array.isArray(r) ? range(r[0], r[1]) : range(r, r))).join(', ');
  const until = (ms) => {
    const s = Math.round((num(ms) - Date.now()) / 1000);
    if (s <= 0) return 'now';
    if (s < 60) return `in ${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
  };
  const section = (title, ...kids) => h('section', { class: 'cm-section' }, h('h3', { class: 'cm-h' }, title), ...kids);
  const note = (text, type = 'info') => h('p', { class: 'settings-note', 'data-type': type }, icon(type === 'error' ? 'circle-exclamation-point' : type === 'warning' ? 'triangle-alert' : 'info'), h('span', null, text));
  const idBadge = (id, extra = '') => h('span', { class: `cm-id ${extra}`.trim() }, id);

  /** "Turn 12" that opens the original turn; plain text when the turn is unknown. */
  function turnLink(key, from, to = from) {
    if (!num(from)) return h('span', { class: 'cm-turn cm-turn-none' }, 'turn unknown');
    return h('button', {
      type: 'button', class: 'cm-turn', 'aria-label': `Read the original of ${range(from, to)}`,
      onclick: () => openTurns(key, num(from), num(to)),
    }, Range(from, to));
  }

  /* ---------- nested viewers ---------- */
  async function openTurns(key, from, to) {
    const body = h('div', { class: 'cm-viewer' }, h('p', { class: 'field-hint' }, icon('loader-circle', 'spin'), ' Loading\u2026'));
    openDialog({ title: `Original ${range(from, to)}`, description: 'Exactly what was said, as stored. The model sees this only when it recalls these turns.', body, size: 'lg' });
    try {
      const r = await call('memory.turns', key, { fromTurn: from, toTurn: to });
      const list = Array.isArray(r.turns) ? r.turns : [];
      const missing = Array.isArray(r.missing) ? r.missing : [];
      if (!list.length) { body.replaceChildren(note(`${Range(from, to)} ${from === to ? 'is' : 'are'} not stored.`, 'warning')); return; }
      const out = [];
      if (missing.length) out.push(h('div', { 'data-slot': 'memory-turns-missing' }, note(`Not stored anywhere: ${ranges(missing)}. The agent is told these originals are gone.`, 'warning')));
      for (const t of list) {
        const n = num(t.turn);
        const src = t.source === 'archive' ? h('span', { class: 'cm-tag', 'data-source': 'archive', title: 'No longer in the chat; read from the memory archive' }, icon('archive'), 'From the archive') : t.source === 'transcript' ? h('span', { class: 'cm-tag', 'data-source': 'transcript' }, 'From the chat') : null;
        out.push(h('div', { class: 'cm-turn-block', 'data-turn': String(n) },
          h('div', { class: 'cm-item-head' }, h('span', { class: 'cm-id' }, `Turn ${n}`), src, t.archiveDiffers && h('span', { class: 'cm-tag cm-tag-warn', 'data-slot': 'memory-archive-differs', title: 'The archived copy differs; the chat\u2019s text is shown and used' }, icon('triangle-alert'), 'Archive copy differs')),
          h('pre', { class: 'cm-pre', tabindex: '0', 'aria-label': `Turn ${n}` }, String(t.text || ''))));
      }
      if (Array.isArray(r.unread) && r.unread.length === 2) {
        const [a, b] = r.unread.map(num);
        out.push(h('div', { class: 'cm-unread', 'data-slot': 'memory-turns-unread' }, note(`Not loaded in this view: ${range(a, b)}.`, 'info'),
          h('button', { type: 'button', class: 'btn btn-outline btn-sm cm-btn', onclick: () => openTurns(key, a, b) }, `Read ${range(a, b)}`)));
      }
      body.replaceChildren(...out);
    } catch (e) {
      body.replaceChildren(note(errText(e), 'error'));
    }
  }

  const UNAVAILABLE_TEXT = 'The stored copy is gone. The agent is told it is unavailable and does not guess its content.';
  async function openResult(key, id) {
    const body = h('div', { class: 'cm-viewer' }, h('p', { class: 'field-hint' }, icon('loader-circle', 'spin'), ' Loading\u2026'));
    openDialog({ title: `Result ${id}`, body, size: 'lg' });
    let text = '';
    const pre = h('pre', { class: 'cm-pre', tabindex: '0', 'aria-label': `Result ${id}` });
    const more = h('button', { type: 'button', class: 'btn btn-outline btn-sm cm-btn' }, 'Show more');
    const meta = h('p', { class: 'field-hint' });
    async function page(offset) {
      more.disabled = true;
      try {
        const r = await call('memory.result', key, { resultId: id, offset });
        if (r.unavailable) {
          body.replaceChildren(h('div', { class: 'cm-unavail', 'data-slot': 'memory-result-unavailable' }, note(r.prunedAt ? `${id} was removed by storage cleanup on ${fmtDay(r.prunedAt)} (${fmtBytes(r.bytes)}): ${r.reason || 'nothing referred to it'}. The agent is told this and does not guess its content.` : `${id} is unavailable. ${UNAVAILABLE_TEXT}`, 'warning')));
          return;
        }
        text += String(r.text ?? r.preview ?? '');
        pre.textContent = text;
        const shown = Math.min(num(r.bytes), num(r.offset) + new TextEncoder().encode(String(r.text ?? '')).length);
        meta.textContent = [r.tool, r.source, r.turn ? `turn ${r.turn}` : '', `${fmtBytes(shown)} of ${fmtBytes(r.bytes)} shown`, r.isError ? 'error result' : ''].filter(Boolean).join(' \u00b7 ');
        if (r.nextOffset != null) { more.hidden = false; more.disabled = false; more.onclick = () => page(r.nextOffset); }
        else more.hidden = true;
        if (!pre.isConnected) body.replaceChildren(meta, pre, more);
      } catch (e) {
        body.replaceChildren(note(errText(e), 'error'));
      }
    }
    page(0);
  }

  async function openVersion(key, v) {
    const body = h('div', { class: 'cm-viewer' }, h('p', { class: 'field-hint' }, icon('loader-circle', 'spin'), ' Loading\u2026'));
    openDialog({ title: `Version ${v}`, description: 'The memory exactly as the model saw it at this version.', body, size: 'lg' });
    try {
      const r = await call('memory.version', key, { version: v });
      if (r.missing) { body.replaceChildren(note(`Version ${v} is no longer in the history (the last 10 are kept).`, 'warning')); return; }
      body.replaceChildren(h('pre', { class: 'cm-pre', tabindex: '0', 'aria-label': `Version ${v}` }, String(r.rendered || '(empty)')));
    } catch (e) {
      body.replaceChildren(note(errText(e), 'error'));
    }
  }

  // Line diff (LCS) of two rendered versions; bounded so a huge memory cannot freeze the UI.
  function lineDiff(a, b) {
    const A = String(a || '').split('\n'), B = String(b || '').split('\n');
    if (A.length * B.length > 4e6) return null;
    const m = A.length, n = B.length;
    const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', A[i++]]);
      else out.push(['+', B[j++]]);
    }
    while (i < m) out.push(['-', A[i++]]);
    while (j < n) out.push(['+', B[j++]]);
    return out;
  }

  async function compareVersion(key, v, live) {
    const body = h('div', { class: 'cm-viewer', 'data-slot': 'memory-compare' }, h('p', { class: 'field-hint' }, icon('loader-circle', 'spin'), ' Loading\u2026'));
    openDialog({ title: `Version ${v} \u2192 version ${live}`, description: 'Lines removed since this version are marked \u2212, lines added are marked +.', body, size: 'lg' });
    try {
      const [a, b] = await Promise.all([call('memory.version', key, { version: v }), call('memory.version', key, { version: live })]);
      if (a.missing || b.missing) { body.replaceChildren(note(`Version ${a.missing ? v : live} is no longer in the history (the last 10 are kept).`, 'warning')); return; }
      const diff = lineDiff(a.rendered, b.rendered);
      if (!diff) { body.replaceChildren(note('These versions are too large to compare here. Open each one with View.', 'warning')); return; }
      const added = diff.filter((d) => d[0] === '+').length, removed = diff.filter((d) => d[0] === '-').length;
      body.replaceChildren(
        h('p', { class: 'cm-sub', 'data-added': String(added), 'data-removed': String(removed) }, added || removed ? `${plural(added, 'line')} added, ${plural(removed, 'line')} removed.` : 'No difference.'),
        h('pre', { class: 'cm-pre cm-diff', tabindex: '0', 'aria-label': `Changes from version ${v} to version ${live}` },
          ...diff.map(([op, line]) => h('span', { class: op === '+' ? 'cm-add' : op === '-' ? 'cm-del' : 'cm-same', 'data-op': op }, `${op === ' ' ? ' ' : op === '+' ? '+' : '\u2212'} ${line}\n`))));
    } catch (e) {
      body.replaceChildren(note(errText(e), 'error'));
    }
  }

  /* ---------- context assembly (context.assembly / context.overflow events) ---------- */
  const SOURCE_LABEL = { memory: 'Chat memory', sessionSummary: 'Earlier-session summary', userText: 'Your messages', assistantText: 'Agent replies', thinking: 'Reasoning', toolCalls: 'Tool calls', toolResults: 'Tool results', toolResultReferences: 'References to stored results', images: 'Images' };
  const ACTION_LABEL = { tool_results_compacted: 'old tool results replaced by references', explanations_shortened: 'old explanations shortened', continuity_summary: 'oldest part summarized', trimmed: 'oldest messages dropped' };

  function paintContext(key, el) {
    const c = chats.get(key) || {};
    const a = c.assembly;
    const overflows = Array.isArray(c.overflows) ? c.overflows : [];
    const out = [];
    if (!a) {
      out.push(h('p', { class: 'cm-empty' }, 'No model call in this chat since the app started. After the next message this shows what was sent to the model and why.'));
    } else {
      const total = num(a.estimatedInputTokens);
      const budget = num(a.transcriptBudgetTokens);
      out.push(h('div', { class: 'cm-context', 'data-slot': 'memory-context', 'data-retry': String(num(a.overflowRetry)) },
        h('p', { class: 'cm-sub' }, `Last call${a.at ? ` ${ago(a.at)}` : ''}: ${a.provider || '?'} \u00b7 ${a.model || '?'} \u00b7 about ${total.toLocaleString()} input tokens of a ${num(a.contextWindowTokens).toLocaleString()}-token window (${num(a.reservedOutputTokens).toLocaleString()} kept for the reply).`),
        h('p', { class: 'cm-sub' }, `Conversation part: ${num(a.transcriptTokens).toLocaleString()} of ${budget.toLocaleString()} tokens allowed${num(a.overflowRetry) ? ` (reduced after the provider said the request was too long, retry ${num(a.overflowRetry)})` : ''}; system prompt and tool list ${num(a.reservedInputTokens).toLocaleString()}.`),
        h('p', { class: 'cm-text', 'data-memory-present': String(!!a.memoryPresent) }, a.memoryReason || ''),
        h('ul', { class: 'cm-list cm-sources', 'aria-label': 'Tokens by source' }, ...Object.entries(a.bySource || {}).filter(([, v]) => num(v) > 0).sort((x, y) => num(y[1]) - num(x[1])).map(([k, v]) =>
          h('li', { class: 'cm-item', 'data-source': k }, h('div', { class: 'cm-item-head' }, h('span', { class: 'cm-tool' }, SOURCE_LABEL[k] || k), h('span', { class: 'cm-meta' }, `${num(v).toLocaleString()} tokens`))))),
        h('p', { class: 'cm-sub', 'data-actions': (a.actions || []).join(',') }, a.actions?.length ? `To fit, this call: ${a.actions.map((x) => ACTION_LABEL[x] || x).join('; ')}.` : 'Everything fitted; nothing was compacted for this call.')));
    }
    const d = c.data;
    const audit = auditSection(a?.audit || (Array.isArray(d?.audit) ? d.audit[0] : null), !a?.audit);
    if (audit) out.push(audit);
    const lastSummary = (Array.isArray(d?.versions) ? d.versions : []).find((v) => v.kind === 'summary');
    out.push(h('p', { class: 'cm-sub', 'data-slot': 'memory-last-summary' }, lastSummary ? `Last successful summary: version ${num(lastSummary.version)}, through turn ${num(lastSummary.throughTurn)}, ${ago(lastSummary.createdAt)}.` : 'No successful summary yet.'));
    if (overflows.length) {
      out.push(section(`Too-long requests (${overflows.length})`, h('ul', { class: 'cm-list' }, ...overflows.slice().reverse().map((o) => h('li', { class: 'cm-item', 'data-overflow': String(num(o.attempt)), 'data-recovering': String(!!o.recovering) },
        h('div', { class: 'cm-item-head' }, h('span', { class: `cm-tag ${o.recovering ? 'cm-tag-warn' : 'cm-tag-old'}` }, o.recovering ? 'Compacted and retried' : 'Gave up'), h('span', { class: 'cm-meta' }, [o.at ? ago(o.at) : '', `attempt ${num(o.attempt)}`].filter(Boolean).join(' \u00b7 '))),
        h('p', { class: 'cm-text cm-muted cm-clamp' }, String(o.error || '')))))));
    }
    el.replaceChildren(...out);
  }

  /** Which memory records a model call was given (context_assembly_audit:
   *  IDs and numbers only, the same record as the context.assembly event). */
  function auditSection(r, stored) {
    if (!r || typeof r !== 'object') return null;
    const ids = (v) => (Array.isArray(v) ? v.map(String) : []);
    const turns = ids(r.includedRecentTurns);
    const rows = [
      ['goals', 'Goals', ids(r.includedGoalIds)],
      ['decisions', 'Decisions', ids(r.includedDecisionIds)],
      ['tasks', 'Tasks', ids(r.includedTaskIds)],
      ['memory', 'Facts, preferences, files', ids(r.includedMemoryIds)],
      ['segments', 'Summary sections', ids(r.includedSummarySegmentIds)],
    ];
    const meta = [
      r.memoryVersion != null ? `memory version ${num(r.memoryVersion)}` : 'no memory yet',
      num(r.summaryThroughTurn) ? `summarized through turn ${num(r.summaryThroughTurn)}` : '',
      turns.length ? `turns ${turns[0]}–${turns[turns.length - 1]} in full` : '',
      `about ${num(r.estimatedInputTokens).toLocaleString()} of ${num(r.inputTokenBudget).toLocaleString()} input tokens`,
      num(r.attempt) ? `retry ${num(r.attempt)}` : '',
    ].filter(Boolean);
    const extra = [...ids(r.compactionActions), ...ids(r.truncationActions)];
    return section('Memory given to the model',
      h('div', { 'data-slot': 'memory-audit', 'data-assembly-id': r.assemblyId || '', 'data-attempt': String(num(r.attempt)) },
        h('p', { class: 'cm-sub' }, `${stored ? 'Last recorded call' : 'Last call'}${r.createdAt ? ` ${ago(r.createdAt)}` : ''}: ${meta.join(' · ')}.`),
        h('ul', { class: 'cm-list' }, ...rows.map(([k, label, list]) => h('li', { class: 'cm-item', 'data-audit': k },
          h('div', { class: 'cm-item-head' }, h('span', { class: 'cm-tool' }, label), h('span', { class: 'cm-meta' }, list.length ? '' : 'none')),
          list.length ? h('ul', { class: 'cm-chips' }, ...list.map((x) => h('li', null, idBadge(x)))) : null))),
        ids(r.retrievalSources).length ? h('p', { class: 'cm-sub', 'data-slot': 'memory-audit-sources' }, `Chosen because of: ${ids(r.retrievalSources).join(', ')}.`) : null,
        extra.length ? h('p', { class: 'cm-sub', 'data-slot': 'memory-audit-actions' }, `Compaction: ${extra.join('; ')}.`) : null));
  }

  /* ---------- status ---------- */
  function statusBox(key) {
    const c = chats.get(key) || {};
    const d = c.data;
    const keep = num(d?.settings?.keepRecent, 7);
    const batch = num(d?.settings?.batch, 7);
    const ph = phase(key);
    const box = h('div', { class: 'cm-status', 'data-state': ph, 'data-slot': 'memory-status' });
    const line = (ic, title, text, cls) => box.append(h('div', { class: `cm-status-row ${cls || ''}`.trim() }, ic, h('div', { class: 'cm-status-text' }, h('p', { class: 'cm-status-title' }, title), text && h('p', { class: 'cm-status-sub' }, text))));
    if (ph === 'busy') {
      const through = num(d?.memory?.throughTurn);
      line(icon('loader-circle', 'spin cm-status-icon'), `Summarizing ${range(c.summarizing.fromTurn, c.summarizing.toTurn)}\u2026`, through ? `Summarized through turn ${through} until this finishes.` : 'The first summary of this chat.');
    }
    if (ph === 'pending') {
      const st = d.status || {};
      // The engine stores "summary failed, will retry (<reason>)": show the reason once.
      let reason = String(st.detail || '').trim();
      const m = /^summary failed, will retry\s*\(([\s\S]*)\)\s*$/i.exec(reason);
      if (m) reason = m[1].trim();
      reason = reason ? `Reason: ${reason.replace(/[.\s]+$/, '')}.` : 'The summary could not be saved.';
      line(icon('triangle-alert', 'cm-status-icon'), st.message || 'Summary failed, will retry',
        `${reason} Nothing was lost: these turns are sent in full and the same batch is tried again on the next turn.${num(st.retries) ? ` Tries so far: ${num(st.retries)}.` : ''}${st.at ? ` Last try ${ago(st.at)}.` : ''}`, 'cm-warn');
    }
    if (!d) {
      if (c.error) line(icon('circle-exclamation-point', 'cm-status-icon'), 'Could not load the memory', c.error, 'cm-err');
      else if (ph !== 'busy') line(icon('loader-circle', 'spin cm-status-icon'), 'Loading\u2026', '');
      return box;
    }
    jobRows(key, d, box, line);
    if (d.unreadable) box.append(h('div', { 'data-slot': 'memory-unreadable' }, note('The saved memory could not be read and no earlier good version exists. Its data is kept aside, not deleted; turns are sent in full until a new summary is made.', 'error')));
    else if (num(d.recoveredFrom)) box.append(h('div', { 'data-slot': 'memory-recovered' }, note(`The latest memory could not be read; version ${num(d.recoveredFrom)} was loaded instead. The unreadable copy is kept aside.`, 'warning')));
    if (d.fromNewerBuild) box.append(h('div', { 'data-slot': 'memory-newer-build' }, note('This memory was written by a newer version of the app. It is shown read-only and is not changed by this version.', 'warning')));
    const m = d.memory || {};
    const through = num(m.throughTurn);
    if (ph === 'off') line(icon('circle-minus', 'cm-status-icon'), 'Memory is off', 'Every turn is sent in full. Turn it on in Settings to summarize older turns.');
    else if (ph !== 'busy') {
      if (through) line(icon('brain', 'cm-status-icon'), `Summarized through turn ${through}`, `Version ${num(d.version)}${m.updatedAt ? ` \u00b7 updated ${ago(m.updatedAt)}` : ''}. The last ${plural(keep, 'turn')} always go to the model in full.`);
      else if (ph !== 'pending') line(icon('brain', 'cm-status-icon'), 'Nothing summarized yet', `Once this chat has more than ${keep + batch - 1} finished turns, the oldest ${plural(batch, 'turn')} are summarized and the last ${keep} stay in full.`);
    }
    if (c.notice) box.append(note(c.notice.text, c.notice.type));
    return box;
  }

  /** Background summary jobs: what runs, what waits, what failed (and Retry). */
  function jobRows(key, d, box, line) {
    const j = d?.jobs;
    if (!j || typeof j !== 'object') return;
    const a = j.active;
    const last = Array.isArray(j.recent) ? j.recent[0] : null;
    const retryBtn = (label) => h('button', {
      type: 'button', class: 'btn btn-outline btn-sm cm-btn cm-retry', 'data-slot': 'memory-retry',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await call('memory.retry', key);
          toast(r.retried ? 'Retrying the summary now.' : 'There was nothing to retry.', { type: r.retried ? 'success' : 'info' });
        } catch (err) { toast(errText(err), { type: 'error' }); }
        await refresh(key);
      },
    }, icon('rotate-ccw'), label);
    const err = (x) => (x?.lastError ? ` Last error: ${String(x.lastError).replace(/[.\s]+$/, '')}.` : '');
    const row = (x, ic, title, text, cls, btn) => {
      line(ic, title, text, cls);
      const el = box.lastElementChild;
      el.dataset.slot = 'memory-job';
      el.dataset.job = x.status;
      if (btn) el.querySelector('.cm-status-text').append(h('div', { class: 'cm-actions' }, btn));
    };
    if (a && (a.status === 'running' || a.status === 'queued')) {
      const what = range(a.fromTurn, a.toTurn);
      if (a.status === 'running') row(a, icon('loader-circle', 'spin cm-status-icon'), `Summarizing ${what} in the background`, `Attempt ${num(a.attempts) + 1} of ${num(a.maxAttempts, 5)}. Turns go on meanwhile; until it finishes the model gets these turns in full.`, '');
      else if (num(a.attempts) > 0) row(a, icon('triangle-alert', 'cm-status-icon'), `Background summary of ${what} will retry ${until(a.nextAttemptAt)}`, `Tried ${plural(num(a.attempts), 'time')} of ${num(a.maxAttempts, 5)}.${err(a)} Nothing was lost: these turns are sent in full.`, 'cm-warn', retryBtn('Retry now'));
      else row(a, icon('clock', 'cm-status-icon'), `Background summary of ${what} is queued`, 'It runs while the app is open. Until then the model gets these turns in full.', '');
      return;
    }
    if (last && last.status === 'failed') {
      row(last, icon('circle-exclamation-point', 'cm-status-icon'), `Background summary of ${range(last.fromTurn, last.toTurn)} failed`, `Gave up after ${plural(num(last.attempts), 'try', 'tries')}.${err(last)} Nothing was lost: these turns are sent in full until a summary succeeds.`, 'cm-err', retryBtn('Retry'));
    }
  }

  /** Items with stable IDs (Phase 1): current first; closed ones with their history. */
  function itemSection(key, label, kind, items, flashItem) {
    const cur = items.filter((i) => (i.status || 'current') === 'current');
    const closed = items.filter((i) => (i.status || 'current') !== 'current');
    if (!cur.length && !closed.length) return null;
    const head = (i, old) => h('div', { class: 'cm-item-head' }, idBadge(i.id, old ? 'cm-id-old' : ''), old && h('span', { class: `cm-tag cm-tag-old cm-status-${i.status}`, 'data-status': i.status }, STATUS_LABEL[i.status] || i.status), goalTag(i.goalId), i.origin === 'repair' && h('span', { class: 'cm-tag' }, 'Added by repair'), turnLink(key, (i.sourceTurns || [])[0]));
    const history = (i) => {
      const hs = Array.isArray(i.history) ? i.history : [];
      if (!hs.length) return null;
      return h('details', { class: 'cm-details', 'data-slot': 'memory-item-history' }, h('summary', null, `History (${plural(hs.length, 'change')})`),
        h('ol', { class: 'cm-bullets' }, ...hs.slice().reverse().map((c) => h('li', null,
          h('span', { class: 'cm-label' }, `${CHANGE_LABEL[c.change] || c.change}${num(c.turn) ? ` in turn ${num(c.turn)}` : ''}`),
          c.text ? h('span', null, ': was \u201c', c.text, '\u201d') : '',
          c.reason ? h('span', { class: 'cm-muted' }, ` \u2014 ${c.reason}`) : ''))));
    };
    const why = (i) => i.reason && h('p', { class: 'cm-sub', 'data-slot': 'memory-reason' }, h('span', { class: 'cm-label' }, 'Why: '), i.reason);
    const textEl = (i, old) => (kind === 'file' ? h('code', { class: `cm-code ${old ? 'cm-text-old' : ''}`.trim() }, i.text) : h('p', { class: `cm-text ${old ? 'cm-text-old' : ''}`.trim() }, old && h('span', { class: 'sr-only' }, `${STATUS_LABEL[i.status] || i.status}: `), i.text));
    return section(label,
      cur.length ? h('ul', { class: 'cm-list', 'aria-label': `${label}, current` }, ...cur.map((i) => h('li', { class: 'cm-item', 'data-item': i.id, 'data-status': 'current', tabindex: '-1' }, head(i, false), textEl(i, false), history(i)))) : h('p', { class: 'cm-empty' }, `No current ${label.toLowerCase()}.`),
      closed.length && h('details', { class: 'cm-details cm-closed', 'data-slot': 'memory-closed-items' }, h('summary', null, `Closed or replaced (${closed.length})`),
        h('ul', { class: 'cm-list', 'aria-label': `${label}, closed or replaced` }, ...closed.map((i) => h('li', { class: 'cm-item', 'data-item': i.id, 'data-status': i.status, 'data-superseded': '', tabindex: '-1' },
          head(i, true), textEl(i, true),
          (i.supersededBy || num(i.updatedTurn)) && h('p', { class: 'cm-by' }, icon('arrow-down', 'cm-by-icon'), i.supersededBy ? 'Replaced by ' : `${STATUS_LABEL[i.status] || i.status}`,
            i.supersededBy ? h('button', { type: 'button', class: 'cm-id-link', 'aria-label': `Show ${i.supersededBy}`, onclick: () => flashItem(i.supersededBy) }, i.supersededBy) : '',
            num(i.updatedTurn) ? ` in turn ${num(i.updatedTurn)}` : ''),
          why(i), history(i))))));
  }

  /** Code-made coverage report (Phase 5): what the summary does not account for. */
  function coverageSection(key, cov) {
    if (!cov || typeof cov !== 'object') return null;
    const probs = [];
    const add = (label, list, fmt = ranges) => { if (Array.isArray(list) && list.length) probs.push(h('li', null, h('span', { class: 'cm-label' }, `${label}: `), fmt(list))); };
    add('Summarized turns missing from the index', cov.gaps);
    add('Turns in two index entries', cov.overlaps);
    add('Index entries beyond the summary', cov.beyondSummary);
    add('Originals not stored anywhere', cov.originalsMissing);
    add('Decisions without a source turn', cov.decisionsWithoutSource, (l) => l.join(', '));
    add('Items without a source turn', cov.itemsWithoutSource, (l) => l.join(', '));
    const legacy = num(cov.legacyItems);
    const uns = Array.isArray(cov.unsummarized) ? cov.unsummarized : null;
    const kids = [];
    if (cov.ok && !probs.length) kids.push(h('p', { class: 'cm-sub', 'data-slot': 'memory-coverage-ok' }, icon('check', 'cm-by-icon'), ` Checked by code: every summarized turn is in the index once and its original is stored.`));
    else kids.push(h('div', { 'data-slot': 'memory-coverage-problems' }, note('Checked by code: parts of the summary are not backed by the turns. The agent recalls the originals for these.', 'warning'), h('ul', { class: 'cm-bullets' }, ...probs)));
    if (uns) kids.push(h('p', { class: 'cm-sub' }, `Not summarized yet, sent in full: ${range(uns[0], uns[1])}.`));
    if (Array.isArray(cov.archiveOnly) && cov.archiveOnly.length) kids.push(h('p', { class: 'cm-sub', 'data-slot': 'memory-archive-only' }, icon('archive', 'cm-by-icon'), ` No longer in the chat, kept in the memory archive: ${ranges(cov.archiveOnly)}.`));
    if (Array.isArray(cov.archiveDiffers) && cov.archiveDiffers.length) kids.push(h('p', { class: 'cm-sub' }, `Archived copy differs from the chat (the chat\u2019s text is used): ${cov.archiveDiffers.map((n) => `turn ${n}`).join(', ')}.`));
    if (legacy) kids.push(h('p', { class: 'cm-sub' }, `${plural(legacy, 'item')} came from an older memory format and ${legacy === 1 ? 'has' : 'have'} no source turn.`));
    return h('section', { class: 'cm-section', 'data-slot': 'memory-coverage' }, h('h3', { class: 'cm-h' }, 'Coverage'), ...kids);
  }

  function legacySection(lc) {
    if (!lc || typeof lc !== 'object' || !num(lc.messages)) return null;
    return h('section', { class: 'cm-section', 'data-slot': 'memory-legacy-context' }, h('h3', { class: 'cm-h' }, 'Earlier context'),
      h('p', { class: 'cm-sub' }, `This chat starts with ${plural(num(lc.messages), 'message')} from an older version of the app (a session summary, ${num(lc.chars).toLocaleString()} characters). The model still sees it in full; this memory and later turns take precedence.`),
      h('details', { class: 'cm-details' }, h('summary', null, 'Show the beginning'), h('pre', { class: 'cm-pre', tabindex: '0', 'aria-label': 'Earlier context' }, `${lc.preview || ''}${lc.truncated ? '\u2026' : ''}`)));
  }

  /* ---------- goals (memory.get goals, schema v6) ---------- */
  const goalTag = (id) => id && h('span', { class: 'cm-tag cm-goal-link', 'data-goal': id, title: `Made while goal ${id} was current` }, id);
  function goalsSection(key, g) {
    const list = Array.isArray(g?.goals) ? g.goals : [];
    if (!list.length) return null;
    const currentId = g.currentGoalId || null;
    const order = { active: 0, paused: 1, completed: 2, cancelled: 3, superseded: 4 };
    const sorted = list.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.goalId).localeCompare(String(b.goalId)));
    const events = Array.isArray(g.events) ? g.events : [];
    return h('section', { class: 'cm-section', 'data-slot': 'memory-goals', 'data-current-goal': currentId || '' },
      h('h3', { class: 'cm-h' }, 'Goals'),
      currentId ? null : h('p', { class: 'cm-empty', 'data-slot': 'memory-no-current-goal' }, 'No goal is active now.'),
      h('ul', { class: 'cm-list', 'aria-label': 'Goals' }, ...sorted.map((x) => {
        const isCurrent = x.goalId === currentId;
        const tagCls = x.status === 'active' ? 'cm-tag-ok' : x.status === 'paused' ? 'cm-tag-warn' : 'cm-tag-old';
        const done = x.status === 'completed' || x.status === 'cancelled' || x.status === 'superseded';
        return h('li', { class: 'cm-item', 'data-goal-id': x.goalId, 'data-goal-status': x.status, 'aria-current': isCurrent ? 'true' : null },
          h('div', { class: 'cm-item-head' }, idBadge(x.goalId, done ? 'cm-id-old' : ''), h('span', { class: `cm-tag ${tagCls}` }, GOAL_LABEL[x.status] || x.status), isCurrent && h('span', { class: 'cm-tag cm-tag-ok', 'data-slot': 'memory-current-goal' }, 'Current'), num(x.sourceTurn) ? turnLink(key, num(x.sourceTurn)) : null),
          h('p', { class: `cm-text${done ? ' cm-text-old' : ''}` }, x.title || x.description || ''),
          x.description && x.description !== x.title && h('p', { class: 'cm-sub' }, x.description),
          x.completedAt && h('p', { class: 'cm-sub', 'data-slot': 'memory-goal-completed' }, `Completed ${ago(x.completedAt)}.`));
      })),
      events.length ? h('details', { class: 'cm-details', 'data-slot': 'memory-goal-events' },
        h('summary', null, `Goal history (${events.length})`),
        h('ol', { class: 'cm-bullets' }, ...events.map((e) => h('li', { 'data-goal-op': e.op },
          `${GOAL_OP_LABEL[e.op] || e.op} ${e.goalId}`, num(e.turn) ? ` in turn ${num(e.turn)}` : ' (from the earlier goal text)', e.origin && e.origin !== 'user' ? ` · ${e.origin}` : '')))) : null);
  }

  /* ---------- tabs ---------- */
  function paintSummary(key, el) {
    const d = chats.get(key)?.data;
    const m = d?.memory;
    const goals = goalsSection(key, d?.goals);
    if (!m || !num(m.throughTurn)) { el.replaceChildren(...[goals].filter(Boolean), h('p', { class: 'cm-empty' }, d ? 'No summary yet. The decisions, facts and the turn index appear here after the first summary.' : ''), ...[legacySection(d?.legacyContext)].filter(Boolean)); return; }
    const out = [];
    if (goals) out.push(goals);
    else if (m.goal) out.push(section('Goal', h('p', { class: 'cm-goal' }, m.goal)));
    const cur = m.decisions?.current || [];
    const old = m.decisions?.superseded || [];
    const flash = (id) => {
      const target = el.querySelector(`[data-decision="${CSS.escape(id)}"]`);
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target.classList.remove('cm-flash'); void target.offsetWidth; target.classList.add('cm-flash');
      target.focus({ preventScroll: true });
    };
    if (cur.length || old.length) {
      out.push(section('Decisions',
        cur.length ? h('ul', { class: 'cm-list', 'aria-label': 'Decisions in force' }, ...cur.map((x) => h('li', { class: 'cm-item', 'data-decision': x.id, tabindex: '-1' },
          h('div', { class: 'cm-item-head' }, idBadge(x.id), h('span', { class: 'cm-tag cm-tag-ok' }, 'In force'), goalTag(x.goalId), x.origin === 'repair' && h('span', { class: 'cm-tag' }, 'Added by repair'), turnLink(key, x.turn)),
          h('p', { class: 'cm-text' }, x.text)))) : h('p', { class: 'cm-empty' }, 'No decisions in force.'),
        old.length && h('h4', { class: 'cm-h4' }, `Replaced (${old.length})`),
        old.length && h('ul', { class: 'cm-list', 'aria-label': 'Replaced decisions' }, ...old.map((x) => {
          const by = x.supersededBy;
          return h('li', { class: 'cm-item', 'data-decision': x.id, 'data-superseded': '', tabindex: '-1' },
            h('div', { class: 'cm-item-head' }, idBadge(x.id, 'cm-id-old'), h('span', { class: 'cm-tag cm-tag-old' }, 'Replaced'), goalTag(x.goalId), turnLink(key, x.turn)),
            h('p', { class: 'cm-text cm-text-old' }, h('span', { class: 'sr-only' }, 'Replaced decision: '), x.text),
            h('p', { class: 'cm-by' }, icon('arrow-down', 'cm-by-icon'), 'Replaced by ',
              by ? h('button', { type: 'button', class: 'cm-id-link', 'aria-label': `Show decision ${by}`, onclick: () => flash(by) }, by) : h('span', null, 'a later decision'),
              x.supersededAt ? ` in turn ${num(x.supersededAt)}` : ''),
            x.reason && h('p', { class: 'cm-sub', 'data-slot': 'memory-reason' }, h('span', { class: 'cm-label' }, 'Why: '), x.reason));
        }))));
    }
    const items = Array.isArray(m.items) ? m.items : [];
    if (items.length) {
      const flashItem = (id) => {
        const target = el.querySelector(`[data-item="${CSS.escape(id)}"]`);
        if (!target) return;
        const box = target.closest('details');
        if (box) box.open = true;
        target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        target.classList.remove('cm-flash'); void target.offsetWidth; target.classList.add('cm-flash');
        target.focus({ preventScroll: true });
      };
      for (const [kind, label] of ITEM_KINDS) {
        const sec = itemSection(key, label, kind, items.filter((i) => i.kind === kind), flashItem);
        if (sec) out.push(sec);
      }
    } else {
      // A memory from before stable IDs: the plain lists.
      for (const [label, list] of [['Facts', m.facts], ['Preferences', m.preferences]]) {
        if (!list?.length) continue;
        out.push(section(label, h('ul', { class: 'cm-list' }, ...list.map((n) => h('li', { class: 'cm-item' }, h('div', { class: 'cm-item-row' }, h('p', { class: 'cm-text' }, n.text), turnLink(key, n.turn)))))));
      }
      if (m.files?.length) out.push(section('Files and identifiers', h('ul', { class: 'cm-chips' }, ...m.files.map((f) => h('li', null, h('code', { class: 'cm-code' }, f))))));
      if (m.openItems?.length) out.push(section('Open items', h('ul', { class: 'cm-bullets' }, ...m.openItems.map((t) => h('li', null, t)))));
    }
    const segs = m.segments || [];
    if (segs.length) {
      const topics = Array.isArray(d.topics) ? d.topics : [];
      out.push(section('Turn index',
        topics.length > 1 && h('ul', { class: 'cm-chips', 'aria-label': 'Topics' }, ...topics.map((t) => h('li', { class: 'cm-topic' }, h('span', { class: 'cm-topic-name' }, t.topic || 'general'), ' ', h('span', { class: 'cm-topic-turns' }, (t.ranges || []).map((r) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}\u2013${r[1]}`)).join(', '))))),
        h('ol', { class: 'cm-list cm-index' }, ...segs.map((s) => h('li', { class: 'cm-item' },
          h('div', { class: 'cm-item-head' }, turnLink(key, s.fromTurn, s.toTurn), s.topic && h('span', { class: 'cm-tag' }, s.topic)),
          s.title && h('p', { class: 'cm-seg-title' }, s.title),
          h('p', { class: 'cm-text cm-muted' }, s.summary))))));
    }
    const cov = coverageSection(key, d.coverage);
    if (cov) out.push(cov);
    const lc = legacySection(d.legacyContext);
    if (lc) out.push(lc);
    el.replaceChildren(...out);
  }

  function describeVersion(v) {
    const d = v.detail && typeof v.detail === 'object' ? v.detail : {};
    const kids = [];
    const p = (...k) => kids.push(h('p', { class: 'cm-text' }, ...k));
    if (v.kind === 'summary') {
      p(`Summarized ${range(d.fromTurn, d.toTurn)}.`);
      const meta = [d.portions > 1 && plural(num(d.portions), 'portion'), d.calls && plural(num(d.calls), 'model call'), num(d.readerCalls) && plural(num(d.readerCalls), 'large-result read'), num(d.corrections) && plural(num(d.corrections), 'correction')].filter(Boolean);
      if (meta.length) kids.push(h('p', { class: 'cm-sub' }, meta.join(' \u00b7 ')));
      for (const s of d.superseded || []) p(idBadge(s.id, 'cm-id-old'), ' replaced by ', idBadge(s.by || '?'));
    } else if (v.kind === 'repair') {
      if (d.kind === 'decision') p('Added decision ', idBadge(d.added || '?'), `: ${d.text || ''}`, d.turn ? ` (turn ${d.turn})` : '');
      else if (d.kind === 'fact' || d.kind === 'preference') {
        p(`Added ${d.kind}: ${d.added?.text || ''}`, d.added?.turn ? ` (turn ${d.added.turn})` : '');
        if (d.removed) p(h('span', { class: 'cm-muted' }, `Replaced: ${typeof d.removed === 'string' ? d.removed : d.removed.text || ''}`));
      } else if (d.kind === 'segment') {
        p(`Corrected the summary of ${range(d.fromTurn, d.toTurn)}.`);
        if (d.before) kids.push(h('p', { class: 'cm-sub' }, h('span', { class: 'cm-label' }, 'Before: '), d.before));
        if (d.after) kids.push(h('p', { class: 'cm-sub' }, h('span', { class: 'cm-label' }, 'After: '), d.after));
      }
      if (d.reason) kids.push(h('p', { class: 'cm-sub' }, h('span', { class: 'cm-label' }, 'Why: '), d.reason));
      const ev = Array.isArray(d.evidence) ? d.evidence : [];
      if (ev.length) {
        kids.push(h('div', { class: 'cm-evidence', 'data-slot': 'memory-evidence' }, h('p', { class: 'cm-label' }, `Evidence (matched exactly in the original)`),
          ...ev.map((e) => h('figure', { class: 'cm-quote' }, h('figcaption', null, `Turn ${num(e.turn)}`), h('q', null, String(e.quote || ''))))));
      }
    } else if (v.kind === 'revert') {
      p(`Reverted the repair in version ${num(d.revertedVersion)}.`);
    } else if (v.kind === 'reset') {
      p(`Memory cleared${d.previousThroughTurn ? ` (it covered turns 1\u2013${num(d.previousThroughTurn)})` : ''}.`);
      if (d.reason) kids.push(h('p', { class: 'cm-sub' }, d.reason));
    }
    return kids;
  }

  function paintHistory(key, el, rerender) {
    const d = chats.get(key)?.data;
    const versions = Array.isArray(d?.versions) ? d.versions : [];
    if (!versions.length) { el.replaceChildren(h('p', { class: 'cm-empty' }, 'No versions yet. Every summary, repair, revert and reset is saved as a version here.')); return; }
    const reverted = new Set(versions.filter((v) => v.kind === 'revert').map((v) => num(v.detail?.revertedVersion)));
    const live = num(d.version);
    el.replaceChildren(
      h('p', { class: 'field-hint' }, 'The last 10 versions are kept. A repair can be reverted; that is saved as a new version and keeps later summaries.'),
      h('ol', { class: 'cm-list cm-history', 'aria-label': 'Versions, newest first' }, ...versions.map((v) => {
        const n = num(v.version);
        const canRevert = v.kind === 'repair' && !reverted.has(n);
        const actions = h('div', { class: 'cm-actions' },
          h('button', { type: 'button', class: 'btn btn-outline btn-sm cm-btn', 'aria-label': `View version ${n}`, onclick: () => openVersion(key, n) }, icon('eye'), 'View'),
          n !== live && live > 0 && h('button', { type: 'button', class: 'btn btn-outline btn-sm cm-btn cm-compare', 'data-version': String(n), 'aria-label': `Compare version ${n} with the current version`, onclick: () => compareVersion(key, n, live) }, icon('git-compare'), 'Compare'),
          canRevert && h('button', {
            type: 'button', class: 'btn btn-outline btn-sm cm-btn cm-revert', 'data-version': String(n), 'aria-label': `Revert the repair in version ${n}`,
            onclick: () => confirmRevert(key, v, rerender),
          }, icon('rotate-ccw'), 'Revert'),
          v.kind === 'repair' && reverted.has(n) && h('span', { class: 'cm-tag' }, 'Reverted'));
        return h('li', { class: 'cm-item', 'data-version': String(n), 'data-kind': v.kind },
          h('div', { class: 'cm-item-head' }, h('span', { class: 'cm-id' }, `v${n}`), h('span', { class: `cm-tag cm-kind-${v.kind}` }, KIND_LABEL[v.kind] || v.kind), n === live && h('span', { class: 'cm-tag cm-tag-ok' }, 'Current'),
            h('span', { class: 'cm-meta' }, [num(v.throughTurn) ? `through turn ${num(v.throughTurn)}` : 'empty', ago(v.createdAt)].filter(Boolean).join(' \u00b7 '))),
          ...describeVersion(v), actions);
      })));
  }

  function confirmRevert(key, v, rerender) {
    const n = num(v.version);
    const d = v.detail || {};
    const what = d.kind === 'decision' ? `decision ${d.added || ''}` : d.kind === 'segment' ? `the corrected summary of ${range(d.fromTurn, d.toTurn)}` : d.kind ? `the added ${d.kind}` : 'its change';
    confirmDialog({
      title: `Revert the repair in version ${n}?`,
      description: `This removes ${what} and nothing else. Later summaries stay. The revert is saved as a new version.`,
      confirmLabel: 'Revert', destructive: true,
      onConfirm: async () => {
        try {
          const r = await call('memory.revert', key, { version: n });
          if (r.reverted) toast(`Reverted. The memory is now version ${num(r.version)}.`, { type: 'success' });
          else toast(`Not reverted: ${r.error || 'the memory changed'}.`, { type: 'error' });
        } catch (e) {
          toast(errText(e), { type: 'error' });
        }
        await refresh(key);
        rerender();
      },
    });
  }

  function paintTurns(key, el) {
    const d = chats.get(key)?.data;
    const turns = Array.isArray(d?.turns) ? d.turns : [];
    const through = num(d?.memory?.throughTurn);
    // Turns that exist only in the memory archive (rewound or compacted away).
    const archived = new Set();
    for (const r of Array.isArray(d?.coverage?.archiveOnly) ? d.coverage.archiveOnly : []) for (let n = num(r[0]); n <= num(r[1]); n++) archived.add(n);
    if (!turns.length) { el.replaceChildren(h('p', { class: 'cm-empty' }, 'No turns stored yet. Each finished turn is stored here word for word, so it can be read back after it is summarized.')); return; }
    el.replaceChildren(
      h('p', { class: 'field-hint' }, `${plural(turns.length, 'turn')} stored. ${through ? `Turns 1\u2013${through} are summarized; the model reads their originals only when it recalls them.` : 'None is summarized yet.'}`),
      h('ol', { class: 'cm-list cm-turns' }, ...turns.slice().reverse().map((t) => {
        const n = num(t.turn);
        return h('li', { class: 'cm-item', 'data-turn': String(n) },
          h('div', { class: 'cm-item-head' }, turnLink(key, n), h('span', { class: `cm-tag ${n <= through ? '' : 'cm-tag-ok'}`.trim() }, n <= through ? 'Summarized' : 'Sent in full'), archived.has(n) && h('span', { class: 'cm-tag', 'data-source': 'archive', title: 'No longer in the chat (rewound or compacted); kept in the memory archive' }, icon('archive'), 'Archive only'), h('span', { class: 'cm-meta' }, fmtBytes(t.bytes))),
          t.preview && h('p', { class: 'cm-text cm-muted cm-clamp' }, t.preview));
      })));
  }

  async function paintResults(key, el) {
    const c = chat(key);
    if (!c.results) {
      el.replaceChildren(h('p', { class: 'field-hint' }, icon('loader-circle', 'spin'), ' Loading\u2026'));
      try { c.results = await call('memory.results', key); } catch (e) { el.replaceChildren(note(errText(e), 'error')); return; }
    }
    const rows = Array.isArray(c.results.results) ? c.results.results : [];
    const gone = Array.isArray(c.results.unavailable) ? c.results.unavailable : [];
    if (!rows.length && !gone.length) { el.replaceChildren(h('p', { class: 'cm-empty' }, 'No stored tool results. Large results (and every result once memory is on) are stored here as R1, R2\u2026 so the agent can read them back in full.')); return; }
    const out = [h('p', { class: 'field-hint' }, 'When a result is too large or old for the context, the model sees a reference such as [result #R12] and reads it back with recall_turns.')];
    const st = chats.get(key)?.data?.storage;
    if (st && typeof st === 'object') {
      const last = st.lastCleanup;
      const cleanBtn = h('button', {
        type: 'button', class: 'btn btn-outline btn-sm cm-btn', 'data-slot': 'memory-prune',
        onclick: () => confirmDialog({
          title: 'Clean up stored results?',
          description: `Results that nothing in this chat refers to any more (for example, from turns you rewound) are removed once they are older than ${plural(num(st.keepUnreferencedDays, 7), 'day')}, or sooner while the chat is over its ${fmtBytes(st.budgetBytes)} budget. Results the chat, the memory, its history or the archive still refer to are never removed.`,
          confirmLabel: 'Clean up',
          onConfirm: async () => {
            try {
              const r = await call('memory.prune', key);
              const n = Array.isArray(r.report?.pruned) ? r.report.pruned.length : 0;
              toast(n ? `Removed ${plural(n, 'result')} (${fmtBytes(r.report.prunedBytes)}).` : 'Nothing to remove: every stored result is still referred to or recent.', { type: 'success' });
            } catch (e) { toast(errText(e), { type: 'error' }); }
            chat(key).results = null;
            await refresh(key);
            paintResults(key, el);
          },
        }),
      }, icon('trash'), 'Clean up now');
      out.push(h('div', { class: 'cm-storage', 'data-slot': 'memory-storage', 'data-over': String(!!st.overBudget) },
        h('p', { class: 'cm-sub' }, `${plural(num(st.resultCount), 'stored result')}, ${fmtBytes(st.resultBytes)} of ${fmtBytes(st.budgetBytes)}.${num(st.prunedCount) ? ` ${plural(num(st.prunedCount), 'result')} (${fmtBytes(st.prunedBytes)}) removed by cleanup.` : ''}${last?.at ? ` Last cleanup ${ago(last.at)}.` : ''}`),
        st.overBudget && note('Over the storage budget, and everything left is still referred to. Nothing referred to is ever removed.', 'warning'),
        last?.error && note(`The last cleanup failed and changed nothing: ${last.error}`, 'error'),
        h('div', { class: 'cm-actions' }, cleanBtn)));
    }
    if (gone.length) {
      out.push(section(`Unavailable (${gone.length})`, h('ul', { class: 'cm-list' }, ...gone.map((g) => h('li', { class: 'cm-item', 'data-unavailable': '', 'data-result': g.id, 'data-pruned': g.prunedAt ? '' : null },
        h('div', { class: 'cm-item-head' }, idBadge(g.id, 'cm-id-old'), g.prunedAt ? h('span', { class: 'cm-tag cm-tag-old' }, icon('trash'), 'Removed by cleanup') : h('span', { class: 'cm-tag cm-tag-warn' }, icon('triangle-alert'), 'Unavailable'), g.tool && h('span', { class: 'cm-tool' }, g.tool), g.prunedAt && h('span', { class: 'cm-meta' }, [fmtBytes(g.bytes), g.turn ? `turn ${g.turn}` : ''].filter(Boolean).join(' \u00b7 '))),
        h('p', { class: 'cm-text cm-muted' }, g.prunedAt ? `Removed on ${fmtDay(g.prunedAt)}: ${g.reason || 'nothing referred to it'}. The agent is told this and does not guess its content.` : UNAVAILABLE_TEXT),
        g.referencedIn?.length && h('p', { class: 'cm-sub' }, `Still referred to in: ${g.referencedIn.join(', ')}`))))));
    }
    if (rows.length) {
      out.push(section(`Stored (${rows.length})`, h('ul', { class: 'cm-list' }, ...rows.slice().reverse().map((r) => h('li', { class: 'cm-item', 'data-result': r.id },
        h('div', { class: 'cm-item-head' }, idBadge(r.id), h('span', { class: 'cm-tool' }, r.tool), r.isError && h('span', { class: 'cm-tag cm-tag-warn' }, 'Error'), h('span', { class: 'cm-meta' }, [fmtBytes(r.bytes), r.turn ? `turn ${r.turn}` : ''].filter(Boolean).join(' \u00b7 '))),
        r.source && h('p', { class: 'cm-sub cm-src', title: r.source }, r.source),
        r.preview && h('p', { class: 'cm-text cm-muted cm-clamp' }, r.preview),
        h('div', { class: 'cm-actions' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm cm-btn', 'aria-label': `View result ${r.id}`, onclick: () => openResult(key, r.id) }, icon('eye'), 'View')))))));
    }
    el.replaceChildren(...out);
  }

  function paintSettings(key, el, rerender) {
    const d = chats.get(key)?.data;
    const s = { ...DEFAULTS, ...(d?.settings || {}) };
    const id = (p) => `cm-${p}-${uid(5)}`;
    const enabledId = id('on');
    const enabled = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: enabledId, checked: s.enabled !== false });
    const numField = (label, hint, value, name) => {
      const fid = id(name);
      const hid = `${fid}-h`;
      const input = h('input', { type: 'number', class: 'input cm-num', id: fid, name, min: '1', max: '50', step: '1', inputmode: 'numeric', value: String(value), 'aria-describedby': hid });
      return { input, el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: fid }, label), input, h('p', { class: 'field-hint', id: hid }, hint)) };
    };
    const bgId = id('bg');
    const bg = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: bgId, checked: s.backgroundSummaries === true, 'data-setting': 'backgroundSummaries' });
    bg.addEventListener('change', () => save({ backgroundSummaries: bg.checked }));
    const budgetId = id('budget');
    const budgetMb = Math.round(num(s.resultBudgetBytes, 64 * 1048576) / 1048576);
    const budget = h('input', { type: 'number', class: 'input cm-num', id: budgetId, min: '1', max: '4096', step: '1', inputmode: 'numeric', value: String(budgetMb), 'aria-describedby': `${budgetId}-h`, 'data-setting': 'resultBudgetBytes' });
    const daysId = id('days');
    const days = h('input', { type: 'number', class: 'input cm-num', id: daysId, min: '0', max: '365', step: '1', inputmode: 'numeric', value: String(num(s.keepUnreferencedResultDays, 7)), 'aria-describedby': `${daysId}-h`, 'data-setting': 'keepUnreferencedResultDays' });
    const pruneId = id('autoprune');
    const autoPrune = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: pruneId, checked: s.autoPruneResults === true, 'data-setting': 'autoPruneResults' });
    autoPrune.addEventListener('change', () => save({ autoPruneResults: autoPrune.checked }));
    const storeErr = h('p', { class: 'cm-field-error', role: 'alert', 'data-slot': 'memory-storage-error' });
    const storeSave = h('button', {
      type: 'button', class: 'btn btn-default btn-sm cm-btn',
      onclick: () => {
        const b = Number(budget.value); const k = Number(days.value);
        const okB = Number.isInteger(b) && b >= 1 && b <= 4096; const okK = Number.isInteger(k) && k >= 0 && k <= 365;
        budget.setAttribute('aria-invalid', String(!okB)); days.setAttribute('aria-invalid', String(!okK));
        if (!okB || !okK) { storeErr.textContent = !okB ? 'Enter a budget from 1 to 4096 MB.' : 'Enter 0 to 365 days.'; (okB ? days : budget).focus(); return; }
        storeErr.textContent = '';
        save({ resultBudgetBytes: b * 1048576, keepUnreferencedResultDays: k });
      },
    }, 'Save storage');
    const keep = numField('Recent turns sent in full', 'Always sent word for word. 1 to 50; default 7.', s.keepRecent, 'keepRecent');
    const batch = numField('Turns per summary', 'A summary runs when this many older turns are waiting. 1 to 50; default 7.', s.batch, 'batch');
    const err = h('p', { class: 'cm-field-error', role: 'alert' });
    const read = (inp) => { const v = Number(inp.value); return Number.isInteger(v) && v >= 1 && v <= 50 ? v : null; };
    const save = async (patch) => {
      try {
        const r = await call('memory.settings', key, { settings: patch });
        if (chats.get(key)?.data && r.settings) chats.get(key).data.settings = r.settings;
        toast('Memory settings saved.', { type: 'success' });
      } catch (e) { toast(errText(e), { type: 'error' }); }
      await refresh(key);
      rerender();
    };
    const saveBtn = h('button', {
      type: 'button', class: 'btn btn-default btn-sm cm-btn',
      onclick: () => {
        const k = read(keep.input); const b = read(batch.input);
        for (const [inp, v] of [[keep.input, k], [batch.input, b]]) inp.setAttribute('aria-invalid', v == null ? 'true' : 'false');
        if (k == null || b == null) { err.textContent = 'Enter whole numbers from 1 to 50.'; (k == null ? keep.input : batch.input).focus(); return; }
        err.textContent = '';
        save({ enabled: enabled.checked, keepRecent: k, batch: b });
      },
    }, 'Save');
    const defaultsBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm cm-btn', onclick: () => save({ ...DEFAULTS }) }, 'Use defaults (7 and 7)');
    enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
    const clearBtn = h('button', {
      type: 'button', class: 'btn btn-outline btn-sm cm-btn cm-danger', disabled: !num(d?.memory?.throughTurn) && !(d?.turns?.length),
      onclick: () => confirmDialog({
        title: 'Clear this chat\u2019s memory?',
        description: 'The summary and the stored originals of this chat are removed; the chat itself stays. The next turns are summarized again from the start. The clear is kept in History.',
        confirmLabel: 'Clear memory', destructive: true,
        onConfirm: async () => {
          try { await call('memory.reset', key); toast('Memory cleared.', { type: 'success' }); } catch (e) { toast(errText(e), { type: 'error' }); }
          chat(key).results = null;
          await refresh(key);
          rerender();
        },
      }),
    }, icon('trash'), 'Clear memory');
    el.replaceChildren(
      h('div', { class: 'switch-row cm-switch' }, h('div', null, h('label', { class: 'field-label', for: enabledId }, 'Summarize older turns'), h('p', { class: 'field-hint' }, 'Off: every turn is sent in full until the context is full.')), enabled),
      keep.el, batch.el, err,
      h('div', { class: 'cm-actions' }, saveBtn, defaultsBtn),
      h('div', { class: 'switch-row cm-switch' }, h('div', null, h('label', { class: 'field-label', for: bgId }, 'Summarize in the background'), h('p', { class: 'field-hint' }, 'Turns do not wait for a summary; it runs while the app is open and retries on its own. Off: the summary runs at the end of the turn.')), bg),
      section('Stored results',
        h('div', { class: 'switch-row cm-switch' }, h('div', null, h('label', { class: 'field-label', for: pruneId }, 'Clean up automatically'), h('p', { class: 'field-hint' }, 'Off (default): stored results are only removed when you run a cleanup. On: results nothing refers to are removed after a turn or a rewind, using the limits below.')), autoPrune),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: budgetId }, 'Storage budget per chat (MB)'), budget, h('p', { class: 'field-hint', id: `${budgetId}-h` }, 'Only results nothing refers to are removed to stay under it. 1 to 4096; default 64.')),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: daysId }, 'Keep unreferenced results (days)'), days, h('p', { class: 'field-hint', id: `${daysId}-h` }, 'For example, results of turns you rewound. 0 to 365; default 7.')),
        storeErr, h('div', { class: 'cm-actions' }, storeSave)),
      h('p', { class: 'field-hint' }, 'These settings apply to every chat.'),
      section('This chat', h('p', { class: 'field-hint' }, 'Start the memory of this chat over.'), h('div', { class: 'cm-actions' }, clearBtn)));
  }

  /* ---------- the screen ---------- */
  function open(tab = 'summary', key = activeKey()) {
    if (!key) return null;
    if (screen?.panel?.isConnected) { screen.go(tab); return screen; }
    if (!available()) chat(key).error = 'Chat memory needs a newer app engine.';
    const tabs = [['summary', 'Summary'], ['history', 'History'], ['turns', 'Turns'], ['results', 'Results'], ['context', 'Context'], ['settings', 'Settings']];
    let current = tabs.some((t) => t[0] === tab) ? tab : 'summary';
    const status = h('div', { class: 'cm-status-host', 'aria-live': 'polite' });
    const tablist = h('div', { class: 'segmented cm-tabs', role: 'tablist', 'aria-label': 'Memory sections' });
    const panel = h('div', { class: 'cm-panel', role: 'tabpanel', id: `cm-panel-${uid(5)}`, tabindex: '0' });
    const body = h('div', { class: 'cm-screen', 'data-slot': 'memory-screen' }, status, tablist, panel);
    const go = (t) => {
      current = t; paintTabs(); paint();
      tablist.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    function paintTabs() {
      tablist.replaceChildren(...tabs.map(([t, label]) => h('button', {
        type: 'button', role: 'tab', class: 'segmented-item', id: `${panel.id}-${t}`, 'aria-selected': String(t === current), tabindex: t === current ? '0' : '-1', 'aria-controls': panel.id, 'data-tab': t,
        onclick: () => go(t), onkeydown: (e) => {
          const i = tabs.findIndex((x) => x[0] === t);
          const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
          if (n < 0) return;
          e.preventDefault(); go(tabs[n][0]); tablist.querySelector(`[data-tab="${tabs[n][0]}"]`)?.focus();
        },
      }, label)));
      panel.setAttribute('aria-labelledby', `${panel.id}-${current}`);
    }
    let lastSig = '';
    function paint(force = true) {
      const c = chats.get(key);
      status.replaceChildren(statusBox(key));
      // Live updates repaint the open tab only when its data changed (keeps focus and scroll).
      const sig = JSON.stringify([current, c?.data?.version, c?.data?.status, c?.data?.settings, c?.data?.turns?.length, !!c?.results, c?.data?.jobs?.active, c?.data?.jobs?.recent?.[0]?.status, c?.data?.storage?.resultCount, c?.data?.storage?.prunedCount, c?.data?.coverage?.ok, c?.assembly?.at, c?.overflows?.length]);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      if (!c?.data) { panel.replaceChildren(); return; }
      if (current === 'summary') paintSummary(key, panel);
      else if (current === 'history') paintHistory(key, panel, () => paint(true));
      else if (current === 'turns') paintTurns(key, panel);
      else if (current === 'results') paintResults(key, panel);
      else if (current === 'context') paintContext(key, panel);
      else paintSettings(key, panel, () => paint(true));
    }
    const unsub = (() => { const fn = (k) => { if (k === key) paint(false); }; subs.add(fn); return () => subs.delete(fn); })();
    const title = appRef?.chat?.items?.get?.(key)?.title;
    const dlg = openDialog({
      title: 'Chat memory', description: title ? `What the agent keeps of \u201c${title}\u201d.` : 'What the agent keeps of this chat\u2019s earlier turns.',
      body, size: 'lg', align: 'top', onClose: () => { unsub(); screen = null; chat(key).notice = null; },
    });
    dlg.panel.classList.add('cm-dialog');
    screen = { ...dlg, go, key };
    paintTabs();
    paint();
    refresh(key).then(() => paint(true));
    return screen;
  }

  function onContextEvent(type, p) {
    const key = p.sessionKey || activeKey();
    if (!key) return;
    const c = chat(key);
    if (type === 'context.assembly') c.assembly = { ...p, at: Date.now() };
    else { c.overflows = [...(c.overflows || []), { ...p, at: Date.now() }].slice(-10); eventLog.add(type, p); }
    notify(key);
  }

  function install(app) {
    appRef = app;
    const runtime = app.chat;
    if (runtime && typeof runtime._onEvent === 'function' && !runtime._cmWrapped) {
      const base = runtime._onEvent.bind(runtime);
      runtime._cmWrapped = true;
      runtime._onEvent = (event) => {
        const type = event?.eventType ?? event?.type ?? '';
        if (type === 'context.assembly' || type === 'context.overflow') {
          const p = parseMaybeJSON(event?.payloadJson ?? event?.payload ?? event?.data, {}) || {};
          try { onContextEvent(type, p); } catch (e) { console.warn('chat memory', e); }
        }
        if (typeof type === 'string' && (type.startsWith('memory.') || type === 'agent.completed' || type === 'agent.error' || type === 'agent.background_timeout')) {
          const p = parseMaybeJSON(event?.payloadJson ?? event?.payload ?? event?.data, {}) || {};
          try { onEvent(type, p); } catch (e) { console.warn('chat memory', e); }
          if (type.startsWith('memory.')) { eventLog.add(type, p); return undefined; }
        }
        return base(event);
      };
    }
    mountIndicator();
    runtime?.on?.('main', () => { mountIndicator(); paintIndicator(); refresh(); });
    runtime?.on?.('native', () => { if (!indicator?.isConnected) mountIndicator(); paintIndicator(); });
    // The engine's feature list arrives after start-up: show the indicator once it says yes.
    let tries = 0;
    const poll = () => { if (available()) { paintIndicator(); refresh(); return; } if (++tries < 20) setTimeout(poll, 500); };
    poll();
  }

  const out = { install, open, openTurns, refresh, onEvent, onContextEvent, lineDiff, phase, available, chats, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };
  if (typeof window !== 'undefined') window.__chatMemory = out;
  return out;
})();
