/* Agent UI kit: small building blocks shared by the Agents panel (10-subagents.js).

   1. infoTip(): the (i) button. Secondary text (helper hints, stats, legends) lives
      behind it instead of being printed on the page, so every screen shows only what
      the user needs to act. Tapping it opens a small popover with the details; the
      text is also kept in `data-info` so tests and screen readers can reach it.

   2. AgentTree: a native (plain DOM) agent tree that replaces the Mermaid drawing on the
      Diagram tab. Mermaid had to lay out a whole SVG on every change (seconds for a big
      team, and it was debounced, so it lagged behind the real state). This tree:
        - renders instantly (a nested list, no layout engine),
        - updates live: the caller re-renders it on every sub-agent event and the tree
          keeps which branches are collapsed, the scroll position and the focus,
        - flashes a node whose status just changed, so a live change is visible,
        - is mobile friendly: collapsible branches, big touch rows, horizontal scroll
          only inside the tree when the nesting is deep.

   3. activityList(): a native, newest-first list of delegation events (started,
      finished, failed, asked, messaged). It replaces the Mermaid sequence diagram. */
const AgentUiKit = (() => {
  /* ---------------------------------------------------------------------------
     (i) info button
     --------------------------------------------------------------------------- */

  /**
   * An (i) button that shows `content` in a popover when tapped.
   * @param {string|Function} content  Text, or a function returning a node or text (built on open, so it is always current).
   * @param {string} label             What the info is about; used for the accessible name ("About <label>").
   * @param {object} [opts]
   * @param {string} [opts.text]       Plain text to keep in data-info when `content` is a function.
   */
  function infoTip(content, label, opts = {}) {
    const plain = typeof content === 'string' ? content : (opts.text || '');
    const btn = h('button', {
      type: 'button', class: 'aui-info-btn', 'aria-label': `About ${label}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'data-slot': 'info-tip', 'data-info': plain,
    }, icon('info'));
    btn.addEventListener('click', (e) => {
      // The (i) often sits inside a clickable row: do not also open the row.
      e.preventDefault(); e.stopPropagation();
      openPopover(btn, (el) => {
        const body = typeof content === 'function' ? content() : content;
        el.append(h('p', { class: 'aui-info-title' }, label));
        if (body instanceof Node) el.append(body);
        else for (const line of String(body || '').split('\n')) el.append(h('p', { class: 'aui-info-text' }, line));
      }, { class: 'aui-info-pop', label: `About ${label}`, side: 'bottom', align: 'end' });
    });
    return btn;
  }

  /** A label with its (i) right after it, for form fields and switch rows. */
  function labelWithInfo(labelNode, hint, label) {
    if (!hint) return labelNode;
    return h('span', { class: 'aui-label-info' }, labelNode, infoTip(hint, label));
  }

  /** Key/value rows for an info popover ("Tokens: 12k"). */
  function facts(pairs) {
    return h('dl', { class: 'aui-info-facts' }, ...pairs.filter((p) => p && p[1] !== undefined && p[1] !== null && p[1] !== '').flatMap(([k, v]) => [h('dt', null, k), h('dd', null, String(v))]));
  }

  /* ---------------------------------------------------------------------------
     Native agent tree
     --------------------------------------------------------------------------- */

  /**
   * Build (or rebuild) the tree into `host`.
   *
   * @param {HTMLElement} host  Container; it keeps its UI state (collapsed branches, last statuses) on itself.
   * @param {object} o
   * @param {Array}    o.records    Sub-agent records.
   * @param {Function} o.parentOf   (r) => parent id or null (null = started by the main agent).
   * @param {Function} o.tone       (r) => 'run' | 'wait' | 'ok' | 'bad' | 'stop' (colour of the dot).
   * @param {Function} o.statusText (r) => 'Running', 'Finished', ...
   * @param {Function} o.isRunning  (r) => boolean.
   * @param {Function} o.onOpen     (id) => void, open that agent.
   * @param {string}   [o.query]    Filter: only branches whose name matches stay visible.
   */
  function renderTree(host, o) {
    const st = host._treeState || (host._treeState = { collapsed: new Set(), last: new Map() });
    const list = [...o.records];
    const ids = new Set(list.map((r) => r.id));
    // Children by parent. A parent that is not in the list (deleted, other chat) hangs under the main agent.
    const kids = new Map();
    for (const r of list) {
      const p = o.parentOf(r);
      const key = p && ids.has(p) && p !== r.id ? p : 'main';
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(r);
    }
    for (const arr of kids.values()) arr.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || String(a.id).localeCompare(String(b.id)));

    // Search: keep a node when it or anything below it matches.
    const q = String(o.query || '').trim().toLowerCase();
    const keep = new Set();
    if (q) {
      const walk = (id) => {
        let any = false;
        for (const r of kids.get(id) || []) {
          const self = `${r.title || ''} ${r.name || ''} ${r.task || ''}`.toLowerCase().includes(q);
          const below = walk(r.id);
          if (self || below) { keep.add(r.id); any = true; }
        }
        return any;
      };
      walk('main');
    }

    // Count everything under a node (shown on a collapsed branch: "+3").
    const countBelow = (id, seen = new Set()) => {
      let n = 0;
      for (const r of kids.get(id) || []) { if (seen.has(r.id)) continue; seen.add(r.id); n += 1 + countBelow(r.id, seen); }
      return n;
    };

    const prevScroll = host.scrollLeft;
    const focusId = host.contains(document.activeElement) ? document.activeElement?.closest('[data-id]')?.dataset.id : null;
    const seen = new Set();
    const node = (r, level) => {
      if (seen.has(r.id)) return null; // a loop in parent links: draw each agent once
      seen.add(r.id);
      if (q && !keep.has(r.id)) return null;
      const children = kids.get(r.id) || [];
      // A search opens every matching branch; otherwise the user's own choice wins.
      const open = q ? true : !st.collapsed.has(r.id);
      const tone = o.tone(r);
      const prev = st.last.get(r.id);
      const changed = prev !== undefined && prev !== r.status;
      st.last.set(r.id, r.status);
      const li = h('li', { class: 'at-node', role: 'treeitem', 'data-id': r.id, 'data-tone': tone, 'aria-level': String(level), 'aria-expanded': children.length ? String(open) : null, 'data-changed': changed ? 'true' : null });
      const twisty = children.length
        ? h('button', { type: 'button', class: 'at-twisty', 'aria-label': `${open ? 'Collapse' : 'Expand'} ${r.title || r.name}`, onclick: (e) => { e.stopPropagation(); if (open) st.collapsed.add(r.id); else st.collapsed.delete(r.id); renderTree(host, o); } }, icon('chevron-right'))
        : h('span', { class: 'at-twisty is-leaf', 'aria-hidden': 'true' });
      const below = countBelow(r.id);
      li.append(h('div', { class: 'at-row' }, twisty,
        h('button', { type: 'button', class: 'at-open', 'data-focus-key': `tree-${r.id}`, onclick: () => o.onOpen(r.id), 'aria-label': `${r.title || r.name}, ${o.statusText(r)}` },
          h('span', { class: 'at-dot', 'data-tone': tone, 'data-live': o.isRunning(r) ? 'true' : 'false', 'aria-hidden': 'true' }),
          h('span', { class: 'at-name truncate' }, r.title || r.name),
          h('span', { class: 'at-status' }, o.statusText(r)),
          !open && below ? h('span', { class: 'at-more', title: `${below} more below` }, `+${below}`) : null)));
      if (children.length && open) {
        const ul = h('ul', { class: 'at-group', role: 'group' });
        for (const c of children) { const n = node(c, level + 1); if (n) ul.append(n); }
        li.append(ul);
      }
      return li;
    };

    const top = kids.get('main') || [];
    const running = list.filter(o.isRunning).length;
    const root = h('ul', { class: 'at-tree', role: 'tree', 'aria-label': 'Agent tree' },
      h('li', { class: 'at-node at-root', role: 'treeitem', 'aria-level': '1', 'aria-expanded': 'true', 'data-id': 'main' },
        h('div', { class: 'at-row' }, h('span', { class: 'at-twisty is-leaf', 'aria-hidden': 'true' }),
          h('span', { class: 'at-open at-open-static' }, h('span', { class: 'at-root-mark', 'aria-hidden': 'true' }, icon('sparkles')),
            h('span', { class: 'at-name truncate' }, 'Main agent'),
            h('span', { class: 'at-status' }, running ? `${running} running` : `${list.length} sub-agent${list.length === 1 ? '' : 's'}`))),
        (() => { const ul = h('ul', { class: 'at-group', role: 'group' }); for (const r of top) { const n = node(r, 2); if (n) ul.append(n); } return ul; })()));
    // Forget statuses of agents that are gone, so the map does not grow forever.
    for (const k of [...st.last.keys()]) if (!ids.has(k)) st.last.delete(k);
    host.replaceChildren(root);
    if (!list.length) host.append(h('p', { class: 'at-empty' }, 'No sub-agents yet. They appear here the moment the agent starts one.'));
    else if (q && !keep.size) host.append(h('p', { class: 'at-empty' }, 'No agent matches this search.'));
    host.scrollLeft = prevScroll;
    if (focusId) host.querySelector(`[data-id="${CSS.escape(focusId)}"] .at-open`)?.focus({ preventScroll: true });
    return { total: list.length, running };
  }

  /** Collapse or expand every branch of a tree built by renderTree. */
  function setAllCollapsed(host, o, collapsed) {
    const st = host._treeState || (host._treeState = { collapsed: new Set(), last: new Map() });
    st.collapsed.clear();
    if (collapsed) for (const r of o.records) if (o.records.some((x) => o.parentOf(x) === r.id)) st.collapsed.add(r.id);
    renderTree(host, o);
  }

  /* ---------------------------------------------------------------------------
     Native delegation activity (replaces the Mermaid sequence diagram)
     --------------------------------------------------------------------------- */

  const EVENT_LOOK = {
    started: ['play', 'started', 'run'],
    message: ['message-square', 'got a follow-up', 'run'],
    approval_needed: ['circle-exclamation-point', 'needs approval', 'wait'],
    ask_parent: ['messages-square', 'asked its parent', 'wait'],
    parent_answer: ['message-square', 'got an answer', 'run'],
    peer_message: ['messages-square', 'messaged', 'run'],
    finished: ['circle-check', 'finished', 'ok'],
    error: ['circle-x', 'failed', 'bad'],
    cancelled: ['circle-minus', 'was stopped', 'stop'],
  };

  /**
   * Newest-first list of delegation events.
   * @param {Array} entries        Log entries: { kind, id, name, text, at, to }.
   * @param {Function} nameOf      (id) => display name.
   * @param {Function} onOpen      (id) => open that agent.
   * @param {number} [max=30]
   */
  function activityList(entries, nameOf, onOpen, max = 30) {
    const recent = entries.slice(-max).reverse();
    if (!recent.length) return h('p', { class: 'at-empty' }, 'No delegation yet.');
    const fmtTime = (t) => { const d = new Date(Number(t) || t); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    return h('ol', { class: 'at-activity', 'data-slot': 'agent-activity' }, ...recent.map((e) => {
      const [ic, verb, tone] = EVENT_LOOK[e.kind] || ['activity', e.kind, 'stop'];
      const who = nameOf(e.id) || e.name || 'Agent';
      const extra = e.kind === 'peer_message' && e.to ? ` ${nameOf(e.to) || 'an agent'}` : '';
      const text = String(e.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return h('li', { class: 'at-event', 'data-tone': tone, 'data-kind': e.kind },
        h('span', { class: 'at-event-icon', 'aria-hidden': 'true' }, icon(ic)),
        h('button', { type: 'button', class: 'at-event-main', onclick: () => e.id && onOpen(e.id) },
          h('span', { class: 'at-event-line' }, h('b', null, who), ` ${verb}${extra}`),
          text && e.kind !== 'finished' ? h('span', { class: 'at-event-text truncate' }, text) : null),
        h('time', { class: 'at-event-time' }, fmtTime(e.at || e.ts || e.time)));
    }));
  }

  return { infoTip, labelWithInfo, facts, renderTree, setAllCollapsed, activityList };
})();
