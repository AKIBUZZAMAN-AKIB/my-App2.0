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
   the settings. A small indicator in the top bar opens it and shows the
   state at a glance. Available when the engine lists "turnMemory".
   ========================================================================== */
const ChatMemory = (() => {
  const KIND_LABEL = { summary: 'Summary', repair: 'Repair', revert: 'Revert', reset: 'Reset' };
  const DEFAULTS = { enabled: true, keepRecent: 7, batch: 7 };
  // Icons this screen needs beyond the shared set (lucide, same stroke).
  Object.assign(ICONS, {
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
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
        announce(key, 'Summary failed, will retry on the next turn.');
        refreshSoon(key, 0);
        break;
      case 'memory.cancelled':
        c.summarizing = null;
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
      if (!list.length) { body.replaceChildren(note(`${Range(from, to)} ${from === to ? 'is' : 'are'} not stored.`, 'warning')); return; }
      body.replaceChildren(...list.map((t) => h('pre', { class: 'cm-pre', tabindex: '0', 'aria-label': `Turn ${num(t.turn)}` }, String(t.text || ''))));
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
          body.replaceChildren(h('div', { class: 'cm-unavail', 'data-slot': 'memory-result-unavailable' }, note(`${id} is unavailable. ${UNAVAILABLE_TEXT}`, 'warning')));
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

  /* ---------- tabs ---------- */
  function paintSummary(key, el) {
    const d = chats.get(key)?.data;
    const m = d?.memory;
    if (!m || !num(m.throughTurn)) { el.replaceChildren(h('p', { class: 'cm-empty' }, d ? 'No summary yet. The goal, decisions, facts and the turn index appear here after the first summary.' : '')); return; }
    const out = [];
    if (m.goal) out.push(section('Goal', h('p', { class: 'cm-goal' }, m.goal)));
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
          h('div', { class: 'cm-item-head' }, idBadge(x.id), h('span', { class: 'cm-tag cm-tag-ok' }, 'In force'), x.origin === 'repair' && h('span', { class: 'cm-tag' }, 'Added by repair'), turnLink(key, x.turn)),
          h('p', { class: 'cm-text' }, x.text)))) : h('p', { class: 'cm-empty' }, 'No decisions in force.'),
        old.length && h('h4', { class: 'cm-h4' }, `Replaced (${old.length})`),
        old.length && h('ul', { class: 'cm-list', 'aria-label': 'Replaced decisions' }, ...old.map((x) => {
          const by = x.supersededBy;
          return h('li', { class: 'cm-item', 'data-decision': x.id, 'data-superseded': '', tabindex: '-1' },
            h('div', { class: 'cm-item-head' }, idBadge(x.id, 'cm-id-old'), h('span', { class: 'cm-tag cm-tag-old' }, 'Replaced'), turnLink(key, x.turn)),
            h('p', { class: 'cm-text cm-text-old' }, h('span', { class: 'sr-only' }, 'Replaced decision: '), x.text),
            h('p', { class: 'cm-by' }, icon('arrow-down', 'cm-by-icon'), 'Replaced by ',
              by ? h('button', { type: 'button', class: 'cm-id-link', 'aria-label': `Show decision ${by}`, onclick: () => flash(by) }, by) : h('span', null, 'a later decision'),
              x.supersededAt ? ` in turn ${num(x.supersededAt)}` : ''));
        }))));
    }
    for (const [label, list] of [['Facts', m.facts], ['Preferences', m.preferences]]) {
      if (!list?.length) continue;
      out.push(section(label, h('ul', { class: 'cm-list' }, ...list.map((n) => h('li', { class: 'cm-item' }, h('div', { class: 'cm-item-row' }, h('p', { class: 'cm-text' }, n.text), turnLink(key, n.turn)))))));
    }
    if (m.files?.length) out.push(section('Files and identifiers', h('ul', { class: 'cm-chips' }, ...m.files.map((f) => h('li', null, h('code', { class: 'cm-code' }, f))))));
    if (m.openItems?.length) out.push(section('Open items', h('ul', { class: 'cm-bullets' }, ...m.openItems.map((t) => h('li', null, t)))));
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
    if (!turns.length) { el.replaceChildren(h('p', { class: 'cm-empty' }, 'No turns stored yet. Each finished turn is stored here word for word, so it can be read back after it is summarized.')); return; }
    el.replaceChildren(
      h('p', { class: 'field-hint' }, `${plural(turns.length, 'turn')} stored. ${through ? `Turns 1\u2013${through} are summarized; the model reads their originals only when it recalls them.` : 'None is summarized yet.'}`),
      h('ol', { class: 'cm-list cm-turns' }, ...turns.slice().reverse().map((t) => {
        const n = num(t.turn);
        return h('li', { class: 'cm-item' },
          h('div', { class: 'cm-item-head' }, turnLink(key, n), h('span', { class: `cm-tag ${n <= through ? '' : 'cm-tag-ok'}`.trim() }, n <= through ? 'Summarized' : 'Sent in full'), h('span', { class: 'cm-meta' }, fmtBytes(t.bytes))),
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
    if (gone.length) {
      out.push(section(`Unavailable (${gone.length})`, h('ul', { class: 'cm-list' }, ...gone.map((g) => h('li', { class: 'cm-item', 'data-unavailable': '', 'data-result': g.id },
        h('div', { class: 'cm-item-head' }, idBadge(g.id, 'cm-id-old'), h('span', { class: 'cm-tag cm-tag-warn' }, icon('triangle-alert'), 'Unavailable')),
        h('p', { class: 'cm-text cm-muted' }, UNAVAILABLE_TEXT),
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
      h('p', { class: 'field-hint' }, 'These settings apply to every chat.'),
      section('This chat', h('p', { class: 'field-hint' }, 'Start the memory of this chat over.'), h('div', { class: 'cm-actions' }, clearBtn)));
  }

  /* ---------- the screen ---------- */
  function open(tab = 'summary', key = activeKey()) {
    if (!key) return null;
    if (screen?.panel?.isConnected) { screen.go(tab); return screen; }
    if (!available()) chat(key).error = 'Chat memory needs a newer app engine.';
    const tabs = [['summary', 'Summary'], ['history', 'History'], ['turns', 'Turns'], ['results', 'Results'], ['settings', 'Settings']];
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
      const sig = JSON.stringify([current, c?.data?.version, c?.data?.status, c?.data?.settings, c?.data?.turns?.length, !!c?.results]);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      if (!c?.data) { panel.replaceChildren(); return; }
      if (current === 'summary') paintSummary(key, panel);
      else if (current === 'history') paintHistory(key, panel, () => paint(true));
      else if (current === 'turns') paintTurns(key, panel);
      else if (current === 'results') paintResults(key, panel);
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

  function install(app) {
    appRef = app;
    const runtime = app.chat;
    if (runtime && typeof runtime._onEvent === 'function' && !runtime._cmWrapped) {
      const base = runtime._onEvent.bind(runtime);
      runtime._cmWrapped = true;
      runtime._onEvent = (event) => {
        const type = event?.eventType ?? event?.type ?? '';
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

  const out = { install, open, refresh, onEvent, phase, available, chats, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };
  if (typeof window !== 'undefined') window.__chatMemory = out;
  return out;
})();
