/* ==========================================================================
   Generative UI — draws GenUICore specs with the app's own components.
     render_spec   flat JSON spec, built from JSON Patch lines; same title = update
     present       a nested display-only tree, converted to a spec
   Versions are keyed by chat + title. A new version shows at the bottom of
   the chat, the older card collapses to "Updated below", and whatever the
   user typed or picked carries over to the new version.
   ========================================================================== */
const GenUI = (() => {
  'use strict';
  const C = GenUICore;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const numOr = (v, d) => { const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v); return Number.isFinite(n) ? n : d; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : '');
  const linkUrl = (u) => (typeof u === 'string' && /^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : '');
  const mediaUrl = (u) => httpsUrl(u) || (typeof u === 'string' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(u) ? u : '');
  const TONES = new Set(['neutral', 'muted', 'info', 'success', 'warning', 'danger', 'accent']);
  const tone = (t, d = 'neutral') => (TONES.has(t) ? t : d);
  const MAX_CALLS = 400;
  const MAX_REPEAT = 500;
  const MAX_DEPTH = 40;
  const STATE_KEY = 'genuiUserState';
  let uid = 0;

  const nf = (opts) => { try { return new Intl.NumberFormat(undefined, opts); } catch { return new Intl.NumberFormat(undefined); } };
  const fmtNum = (v, opts) => (typeof v === 'number' && Number.isFinite(v) ? nf(opts).format(v) : str(v));
  const compact = (v) => fmtNum(v, Math.abs(v) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 });
  const isDark = () => doc.documentElement.classList.contains('dark');

  function openExternal(url) {
    const a = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' });
    doc.body.append(a); a.click(); a.remove();
  }

  /* ---------- user edits survive a reload ---------- */
  const userStore = {
    read() { try { const v = JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); return isObj(v) ? v : {}; } catch { return {}; } },
    get(id) { const v = this.read()[id]; return isObj(v?.values) ? v.values : null; },
    put(id, values) {
      try {
        const all = this.read();
        all[id] = { at: Date.now(), values };
        const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
        for (const k of keys.slice(150)) delete all[k];
        const text = JSON.stringify(all);
        if (text.length < 400000) localStorage.setItem(STATE_KEY, text);
      } catch { /* storage full or blocked */ }
    },
  };

  /* ---------- versions ---------- */
  const calls = new Map(); // toolCallId -> version
  const byTitle = new Map(); // chat|title -> [toolCallId…]
  let seq = 0;
  const chatId = (ctx) => String(ctx?.sessionKey || app?.chat?.main?.id || 'chat');
  const titleKey = (chat, title) => `${chat}|${String(title || '').trim().toLowerCase()}`;

  function latest(key, exceptId) {
    const list = byTitle.get(key) || [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i] !== exceptId && calls.has(list[i])) return calls.get(list[i]);
    return null;
  }

  function track(v) {
    calls.set(v.id, v);
    const list = byTitle.get(v.key) || [];
    if (!list.includes(v.id)) list.push(v.id);
    byTitle.set(v.key, list);
    for (const id of list) if (id !== v.id) calls.get(id)?.supersede(v);
    if (calls.size > MAX_CALLS) {
      for (const [id, old] of calls) {
        if (calls.size <= MAX_CALLS) break;
        if (latest(old.key) !== old) { calls.delete(id); const l = byTitle.get(old.key); if (l) l.splice(l.indexOf(id), 1); }
      }
    }
  }

  /** Carries values the user changed in the previous version into the new state. */
  function carryUserValues(prev, spec) {
    const paths = new Set(prev?.userPaths || []);
    for (const p of paths) {
      const value = C.readPointer(prev.spec.state, p);
      if (value === undefined) continue;
      try { C.setAt(spec.state, C.parsePointer(p), clone(value)); } catch { paths.delete(p); }
    }
    return paths;
  }

  /** Builds the version for a tool call once; the tool's execute and its card share it. */
  function ensureVersion(part, ctx) {
    const id = String(part.toolCallId || `local-${++uid}`);
    if (calls.has(id)) return calls.get(id);
    const args = isObj(part.args) ? part.args : {};
    const tool = String(part.toolName || '').replace(/^ui__/, '');
    const chat = chatId(ctx);
    let title = String(args.title || '').trim();
    let spec = null; let issues = []; let patchErrors = []; let prev = null;
    if (tool === 'present') {
      if (!title) title = `present_${id.slice(-6)}`;
      const tree = args.tree ?? args.ui ?? args.component ?? args.node ?? args.root;
      const r = C.treeToSpec(tree);
      spec = r.spec; issues = r.issues;
    } else {
      if (!title) title = `ui_${id.slice(-6)}`;
      prev = latest(titleKey(chat, title), id);
      const base = isObj(args.spec) ? clone(args.spec) : prev ? clone(prev.spec) : null;
      if (base && !isObj(base.state)) base.state = {};
      const patches = args.patches ?? args.jsonl ?? args.ops;
      const r = patches != null && patches !== '' ? C.applyPatches(base, patches) : { spec: base || C.emptySpec(), errors: [] };
      spec = r.spec; patchErrors = r.errors;
      issues = C.validateSpec(spec).issues;
    }
    if (!isObj(spec.state)) spec.state = {};
    if (!isObj(spec.elements)) spec.elements = {};
    const v = new Version({ id, key: titleKey(chat, title), title, tool, spec, issues, patchErrors, number: (prev?.number || 0) + 1 });
    v.userPaths = carryUserValues(prev, spec);
    const saved = userStore.get(id);
    if (saved) for (const [p, value] of Object.entries(saved)) { try { C.setAt(spec.state, C.parsePointer(p), value); v.userPaths.add(p); } catch { /* path gone */ } }
    track(v);
    return v;
  }

  /* ---------- one drawn version ---------- */
  class Version {
    constructor(o) {
      Object.assign(this, o);
      this.seq = ++seq;
      this.local = new Map(); // UI-only state (a tab without a binding, map zoom…)
      this.runtimeErrors = [];
      this.el = null; this.body = null; this.superseded = null;
      this._queued = false;
    }

    exprCtx(rctx, event) {
      return { state: this.spec.state, item: rctx?.item, index: rctx?.index, itemPath: rctx?.itemPath, event };
    }

    /** A user change: write the bound state path, remember it, redraw. */
    write(rawProp, value, rctx, opts) {
      const path = C.bindingPath(rawProp, this.exprCtx(rctx));
      if (!path) return false;
      this.setPath(path, value, opts);
      return true;
    }

    setPath(path, value, opts) {
      try { C.setAt(this.spec.state, C.parsePointer(path), clone(value)); } catch (e) { this.runtimeErrors.push(`state ${path}: ${e.message}`); return; }
      this.userPaths.add(path);
      const values = {};
      for (const p of this.userPaths) { const val = C.readPointer(this.spec.state, p); if (val !== undefined) values[p] = val; }
      userStore.put(this.id, values);
      if (opts?.lazy) this.scheduleLazy(); else this.schedule();
    }

    /** Typing redraws after a short pause, never in the middle of an IME composition. */
    scheduleLazy() {
      clearTimeout(this._lazy);
      this._lazy = setTimeout(() => {
        if (this.composing) { this.scheduleLazy(); return; }
        this.render();
      }, 320);
    }

    schedule() {
      clearTimeout(this._lazy);
      if (this._queued) return;
      this._queued = true;
      queueMicrotask(() => { this._queued = false; this.render(); });
    }

    /** Runs the actions bound to an element event. */
    fire(el, event, payload, rctx, domEvent) {
      const raw = el?.on?.[event];
      if (!raw) return;
      const list = Array.isArray(raw) ? raw : [raw];
      for (const b of list.slice(0, 20)) {
        if (!isObj(b)) continue;
        const params = C.resolve(isObj(b.params) ? b.params : {}, this.exprCtx(rctx, payload));
        const path = typeof params.path === 'string' ? params.path : '';
        try {
          switch (b.action) {
            case 'setState':
              if (path) this.setPath(path, params.value === undefined ? null : params.value);
              break;
            case 'toggle':
              if (path) this.setPath(path, !C.truthy(C.readPointer(this.spec.state, path)));
              break;
            case 'pushState': {
              if (!path) break;
              const cur = C.readPointer(this.spec.state, path);
              this.setPath(path, [...(Array.isArray(cur) ? cur : []), params.value]);
              break;
            }
            case 'removeState': {
              const cur = C.readPointer(this.spec.state, path);
              const index = Number(params.index);
              if (path && Array.isArray(cur) && Number.isInteger(index)) this.setPath(path, cur.filter((_, i) => i !== index));
              break;
            }
            case 'sendMessage': {
              // Only a real tap or key press may speak for the user.
              const text = str(params.text ?? params.message).trim();
              if (!text || !domEvent?.isTrusted) break;
              sendFromUI(text.slice(0, 4000));
              break;
            }
            case 'copyText': {
              const text = str(params.text);
              if (text) Promise.resolve(copyText(text)).then(() => toast('Copied', { type: 'success' })).catch(() => toast('Could not copy', { type: 'error' }));
              break;
            }
            case 'openUrl': {
              const url = httpsUrl(str(params.url));
              if (url && domEvent?.isTrusted) openExternal(url);
              break;
            }
            default: break;
          }
        } catch (e) { this.runtimeErrors.push(`${b.action}: ${e?.message || e}`); }
      }
    }

    /** The card for this version; the same element is reused on every re-render of the thread. */
    card() {
      if (this.el) return this.el;
      this.body = h('div', { class: 'gu-body' });
      this.body.addEventListener('compositionstart', () => { this.composing = true; });
      this.body.addEventListener('compositionend', () => { this.composing = false; });
      this.el = h('div', { class: 'gu-root', 'data-genui': this.title, 'data-version': String(this.number), 'data-tool': this.tool }, this.body);
      this.render();
      if (this.superseded) { const n = this.superseded; this.superseded = null; this.supersede(n); }
      return this.el;
    }

    supersede(newer) {
      this.superseded = newer;
      if (!this.el || this.el.classList.contains('gu-old')) return;
      this.el.classList.add('gu-old');
      const toggle = h('button', { type: 'button', class: 'gu-old-toggle', 'aria-expanded': 'false' }, icon('chevron-down'), h('span', {}, 'Show'));
      const bar = h('div', { class: 'gu-old-bar' },
        h('span', { class: 'gu-old-text' }, icon('arrow-down'), h('span', {}, `${this.title.replace(/[_-]+/g, ' ')}: updated below`)), toggle);
      toggle.addEventListener('click', () => {
        const open = this.el.classList.toggle('gu-old-open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.lastChild.textContent = open ? 'Hide' : 'Show';
      });
      this.el.prepend(bar);
    }

    render() {
      if (!this.body) return;
      const host = this.body;
      const active = doc.activeElement;
      const focusGid = active && host.contains(active) ? active.getAttribute('data-gid') : null;
      let sel = null;
      try { if (focusGid && typeof active.selectionStart === 'number') sel = [active.selectionStart, active.selectionEnd]; } catch { /* not a text input */ }
      this.runtimeErrors = [];
      const r = new Renderer(this);
      let node;
      try { node = r.draw(); } catch (e) { node = notice(`This view could not be drawn: ${e?.message || e}`, 'danger'); this.runtimeErrors.push(String(e?.message || e)); }
      host.replaceChildren(node);
      if (focusGid) {
        const next = host.querySelector(`[data-gid="${CSS.escape(focusGid)}"]`);
        if (next) { next.focus({ preventScroll: true }); try { if (sel) next.setSelectionRange(sel[0], sel[1]); } catch { /* no selection */ } }
      }
    }

    /** Short plain summary of the values the user changed, for the model. */
    userSummary() {
      const values = {};
      for (const p of this.userPaths) { const val = C.readPointer(this.spec.state, p); if (val !== undefined) values[p] = val; }
      return Object.keys(values).length ? JSON.stringify(values).slice(0, 1500) : '';
    }
  }

  function notice(text, t = 'neutral') {
    return h('p', { class: 'gu-notice', 'data-tone': t }, text);
  }

  /* ---------- the renderer ---------- */
  class Renderer {
    constructor(v) { this.v = v; this.count = 0; }

    draw() {
      const spec = this.v.spec;
      if (!spec.root || !isObj(spec.elements[spec.root])) {
        return notice(this.v.tool === 'present' ? 'Nothing to show.' : 'This view has no root element yet.', 'warning');
      }
      return this.build(spec.root, { gid: '', item: undefined, index: undefined }, 0) || h('div');
    }

    build(id, rctx, depth) {
      const el = this.v.spec.elements[id];
      if (!isObj(el)) return null;
      if (depth > MAX_DEPTH) return notice('This view nests too deeply.', 'warning');
      if (++this.count > 2500) return null;
      const ectx = this.v.exprCtx(rctx);
      if (el.visible !== undefined && !C.checkCondition(el.visible, ectx)) return null;
      const gid = `${rctx.gid}/${id}`;
      const raw = isObj(el.props) ? el.props : {};
      let p;
      try { p = C.resolve(raw, ectx); } catch (e) { p = {}; this.v.runtimeErrors.push(`${id}: ${e.message}`); }
      if (!isObj(p)) p = {};
      const kidIds = Array.isArray(el.children) ? el.children.filter((k) => typeof k === 'string') : [];
      const kids = () => {
        const out = [];
        if (isObj(el.repeat) && typeof el.repeat.path === 'string') {
          const list = C.readPointer(this.v.spec.state, el.repeat.path);
          if (!Array.isArray(list)) return out;
          list.slice(0, MAX_REPEAT).forEach((item, index) => {
            const key = el.repeat.key && isObj(item) && item[el.repeat.key] != null ? str(item[el.repeat.key]) : String(index);
            const sub = { gid: `${gid}[${key}]`, item, index, itemPath: `${el.repeat.path}/${index}` };
            for (const k of kidIds) { const n = this.build(k, sub, depth + 1); if (n) out.push(n); }
          });
          return out;
        }
        for (const k of kidIds) { const n = this.build(k, rctx, depth + 1); if (n) out.push(n); }
        return out;
      };
      const v = this.v;
      const api = {
        id, el, p, raw, rctx, gid, kids, v, r: this,
        on: (event, payload, domEvent) => v.fire(el, event, payload, rctx, domEvent),
        has: (event) => !!el.on?.[event],
        bind: (prop, value, opts) => v.write(raw[prop], value, rctx, opts),
        bound: (prop) => !!C.bindingPath(raw[prop], ectx),
        local: (key, init) => (v.local.has(`${gid}:${key}`) ? v.local.get(`${gid}:${key}`) : init),
        setLocal: (key, value) => { v.local.set(`${gid}:${key}`, value); v.schedule(); },
      };
      const make = Object.prototype.hasOwnProperty.call(R, el.type) ? R[el.type] : null;
      let node;
      try {
        node = make ? make(api) : notice(`Unknown component "${str(el.type)}".`, 'warning');
      } catch (e) {
        v.runtimeErrors.push(`${id} (${el.type}): ${e?.message || e}`);
        node = notice(`${str(el.type)} could not be drawn.`, 'danger');
      }
      if (node && node.nodeType === 1 && !node.hasAttribute('data-el')) node.setAttribute('data-el', id);
      return node;
    }
  }

  /* ---------- small shared pieces ---------- */
  function hash(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; }
  const fieldId = (gid) => `gu-${Math.abs(hash(gid)).toString(36)}-${++uid}`;
  const gap = (g, d) => (['none', 'xs', 'sm', 'md', 'lg'].includes(g) ? g : d);
  const emoji = (v) => (v ? h('span', { class: 'gu-emoji', 'aria-hidden': 'true' }, Array.from(str(v)).slice(0, 2).join('')) : null);
  const ext = (href, kids, cls) => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, kids);

  function field(api, control, label) {
    const id = control.id || (control.id = fieldId(api.gid));
    return h('div', { class: 'gu-field' }, label ? h('label', { class: 'gu-label', for: id }, label) : null, control);
  }

  function options(list) {
    return (Array.isArray(list) ? list : []).slice(0, 200).map((o) => (isObj(o)
      ? { value: str(o.value ?? o.label), label: str(o.label ?? o.value), description: o.description ? str(o.description) : '' }
      : { value: str(o), label: str(o), description: '' }));
  }

  /* ---------- chart (SVG, redrawn at its real width) ---------- */
  function chartData(p) {
    let labels; let series;
    if (Array.isArray(p.series) && p.series.length) {
      labels = (Array.isArray(p.labels) ? p.labels : []).slice(0, 120).map(str);
      series = p.series.slice(0, 6).map((s, i) => ({
        name: str(isObj(s) ? s.name ?? `Series ${i + 1}` : `Series ${i + 1}`),
        values: (isObj(s) ? s.values ?? s.data ?? [] : Array.isArray(s) ? s : []).slice(0, 120).map((x) => numOr(x, null)),
      }));
    } else {
      const data = (Array.isArray(p.data) ? p.data : []).slice(0, 120);
      labels = data.map((d, i) => (isObj(d) ? str(d.label ?? d.name ?? d.x ?? '') : Array.isArray(p.labels) ? str(p.labels[i] ?? '') : ''));
      series = [{ name: str(p.title || 'Value'), values: data.map((d) => numOr(isObj(d) ? d.value ?? d.y : d, null)) }];
    }
    const n = Math.max(labels.length, ...series.map((s) => s.values.length));
    while (labels.length < n) labels.push('');
    return { labels, series, n };
  }

  function niceTicks(min, max, count = 4) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    if (min === max) { if (min === 0) max = 1; else if (min > 0) min = 0; else max = 0; }
    const step0 = (max - min) / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0 * 0.999) || step0;
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step / 2 && ticks.length < 12; t += step) ticks.push(+t.toFixed(10));
    return ticks.length > 1 ? ticks : [lo, lo + step];
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, ...kids) {
    const n = doc.createElementNS(SVGNS, tag);
    for (const [k, val] of Object.entries(attrs)) if (val != null) n.setAttribute(k, String(val));
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  const svgTitle = (t) => svg('title', {}, t);
  const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut'];

  function drawChart(p, width) {
    const type = CHART_TYPES.includes(p.type) ? p.type : 'bar';
    const { labels, series, n } = chartData(p);
    const unit = p.unit ? str(p.unit) : '';
    const short = unit && Array.from(unit).length <= 2 ? unit : '';
    const fmt = (x) => (x == null ? '–' : `${compact(x)}${short}`);
    const H = clamp(numOr(p.height, 180), 120, 360);
    const W = Math.max(200, Math.round(width || 320));
    if (!n || series.every((s) => s.values.every((x) => x == null))) return h('p', { class: 'gu-hint' }, 'No data.');
    if (type === 'pie' || type === 'donut') {
      const vals = series[0].values.map((x) => Math.max(0, x || 0));
      const total = vals.reduce((a, b) => a + b, 0) || 1;
      const r = Math.min(H / 2 - 4, 100); const cx = r + 4; const cy = r + 4; const inner = type === 'donut' ? r * 0.6 : 0;
      const g = svg('svg', { viewBox: `0 0 ${2 * r + 8} ${2 * r + 8}`, width: 2 * r + 8, height: 2 * r + 8, class: 'gu-pie', 'aria-hidden': 'true' });
      const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
      let a0 = -Math.PI / 2;
      vals.forEach((val, i) => {
        if (val <= 0) return;
        const frac = val / total;
        const a1 = a0 + frac * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        let d;
        if (frac >= 0.9999) {
          d = `M ${pt(r, 0)} A ${r} ${r} 0 1 1 ${pt(r, Math.PI)} A ${r} ${r} 0 1 1 ${pt(r, 0)} Z`;
          if (inner) d += ` M ${pt(inner, 0)} A ${inner} ${inner} 0 1 0 ${pt(inner, Math.PI)} A ${inner} ${inner} 0 1 0 ${pt(inner, 0)} Z`;
        } else if (inner) {
          d = `M ${pt(r, a0)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)} L ${pt(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${pt(inner, a0)} Z`;
        } else {
          d = `M ${cx} ${cy} L ${pt(r, a0)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)} Z`;
        }
        g.append(svg('path', { d, class: `gu-s${i % 8} gu-slice`, 'fill-rule': 'evenodd' }, svgTitle(`${labels[i]}: ${fmt(val)} (${Math.round(frac * 100)}%)`)));
        a0 = a1;
      });
      const legend = h('ul', { class: 'gu-legend gu-legend-col' }, vals.map((val, i) => h('li', {},
        h('span', { class: `gu-swatch gu-s${i % 8}` }), h('span', { class: 'gu-legend-label' }, labels[i] || `#${i + 1}`),
        h('span', { class: 'gu-legend-value' }, `${fmt(val)} · ${Math.round((val / total) * 100)}%`))));
      return h('div', { class: 'gu-pie-wrap' }, g, legend);
    }
    const stacked = !!p.stacked && type !== 'line';
    const all = [];
    if (stacked) {
      for (let i = 0; i < n; i++) { let pos = 0; let neg = 0; for (const s of series) { const x = s.values[i] || 0; if (x >= 0) pos += x; else neg += x; } all.push(pos, neg); }
    } else for (const s of series) for (const x of s.values) if (x != null) all.push(x);
    const dMin = Math.min(...all); const dMax = Math.max(...all);
    // Bars and areas start at zero; a line may zoom into its own range.
    const zero = type !== 'line' || (dMin >= 0 && dMin < dMax * 0.35) || dMin < 0;
    const ticks = niceTicks(zero ? Math.min(0, dMin) : dMin, zero ? Math.max(0, dMax) : dMax);
    const tMin = ticks[0]; const tMax = ticks[ticks.length - 1];
    const labelW = Math.min(70, Math.max(...ticks.map((t) => fmt(t).length)) * 6.2 + 10);
    const pad = { l: labelW, r: 8, t: 8, b: 24 };
    const pw = W - pad.l - pad.r; const ph = H - pad.t - pad.b;
    const y = (val) => pad.t + ph - ((val - tMin) / (tMax - tMin || 1)) * ph;
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'gu-chart-svg', 'aria-hidden': 'true' });
    for (const t of ticks) {
      g.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(t).toFixed(1), y2: y(t).toFixed(1), class: t === 0 ? 'gu-axis' : 'gu-gridline' }));
      g.append(svg('text', { x: pad.l - 6, y: (y(t) + 3.5).toFixed(1), 'text-anchor': 'end', class: 'gu-tick' }, fmt(t)));
    }
    const band = pw / n;
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 48))));
    labels.forEach((l, i) => {
      if (i % every) return;
      const x = pad.l + band * i + band / 2;
      g.append(svg('text', { x: x.toFixed(1), y: H - 7, 'text-anchor': 'middle', class: 'gu-tick' }, l.length > 9 ? `${l.slice(0, 8)}…` : l));
    });
    const tip = (s, i) => svgTitle(`${series.length > 1 ? `${s.name}, ` : ''}${labels[i] ? `${labels[i]}: ` : ''}${fmt(s.values[i])}${unit && !short ? ` ${unit}` : ''}`);
    if (type === 'bar') {
      const groupW = band * 0.74;
      const bw = stacked ? groupW : groupW / series.length;
      for (let i = 0; i < n; i++) {
        let pos = 0; let neg = 0;
        series.forEach((s, si) => {
          const val = s.values[i];
          if (val == null) return;
          let y0; let y1;
          if (stacked) { if (val >= 0) { y0 = pos; pos += val; y1 = pos; } else { y0 = neg; neg += val; y1 = neg; } } else { y0 = 0; y1 = val; }
          const x = pad.l + band * i + (band - groupW) / 2 + (stacked ? 0 : bw * si);
          const top = Math.min(y(y0), y(y1)); const hgt = Math.max(1, Math.abs(y(y1) - y(y0)));
          g.append(svg('rect', { x: (x + 0.5).toFixed(1), y: top.toFixed(1), width: Math.max(1, bw - 1).toFixed(1), height: hgt.toFixed(1), rx: Math.min(3, bw / 4).toFixed(1), class: `gu-s${si % 8}` }, tip(s, i)));
        });
      }
    } else {
      const cum = new Array(n).fill(0);
      series.forEach((s, si) => {
        const pts = s.values.map((val, i) => {
          if (val == null) return null;
          const base = stacked ? cum[i] : Math.max(tMin, Math.min(0, tMax));
          const top = (stacked ? cum[i] : 0) + val;
          if (stacked) cum[i] = top;
          return [pad.l + band * i + band / 2, y(top), y(base)];
        });
        const segs = []; let cur = [];
        for (const pt of pts) { if (pt) cur.push(pt); else if (cur.length) { segs.push(cur); cur = []; } }
        if (cur.length) segs.push(cur);
        for (const seg of segs) {
          const line = seg.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');
          if (type === 'area') {
            const back = seg.slice().reverse().map((pt) => `L${pt[0].toFixed(1)} ${pt[2].toFixed(1)}`).join(' ');
            g.append(svg('path', { d: `${line} ${back} Z`, class: `gu-area gu-s${si % 8}` }));
          }
          g.append(svg('path', { d: line, class: `gu-line gu-st${si % 8}` }));
          if (seg.length <= 40) for (const pt of seg) g.append(svg('circle', { cx: pt[0].toFixed(1), cy: pt[1].toFixed(1), r: 2.75, class: `gu-dot gu-s${si % 8}` }));
        }
      });
      // One hit area per x position, with every series in its tooltip.
      for (let i = 0; i < n; i++) {
        const text = series.map((s) => `${series.length > 1 ? `${s.name}: ` : ''}${fmt(s.values[i])}`).join(', ');
        g.append(svg('rect', { x: (pad.l + band * i).toFixed(1), y: pad.t, width: band.toFixed(1), height: ph, class: 'gu-hit' }, svgTitle(`${labels[i] ? `${labels[i]}: ` : ''}${text}`)));
      }
    }
    const wrap = h('div', { class: 'gu-chart-plot' }, g);
    if (series.length > 1) wrap.append(h('ul', { class: 'gu-legend' }, series.map((s, i) => h('li', {}, h('span', { class: `gu-swatch gu-s${i % 8}` }), h('span', { class: 'gu-legend-label' }, s.name)))));
    return wrap;
  }

  function chartTable(p) {
    const { labels, series } = chartData(p);
    return h('table', { class: 'sr-only' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Label'), series.map((s) => h('th', {}, s.name)))),
      h('tbody', {}, labels.map((l, i) => h('tr', {}, h('th', {}, l), series.map((s) => h('td', {}, s.values[i] == null ? '' : String(s.values[i])))))));
  }

  /* ---------- map (CARTO raster tiles: light and dark, OpenStreetMap data) ---------- */
  const TILE = 256;
  function worldPx(lat, lon, z) {
    const s = TILE * 2 ** z;
    const sin = Math.sin((clamp(lat, -85.05, 85.05) * Math.PI) / 180);
    return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  function tileUrl(x, y, z) {
    const n = 2 ** z; const xx = ((x % n) + n) % n;
    return `https://${'abcd'[(xx + y) % 4]}.basemaps.cartocdn.com/${isDark() ? 'dark_all' : 'light_all'}/${z}/${xx}/${y}@2x.png`;
  }

  /* ---------- forecasts from get_weather results in this chat ---------- */
  const weatherCache = new Map();
  function parseData(result) {
    let value = result;
    if (isObj(value) && Array.isArray(value.content)) value = value.content.map((c) => c?.text || '').join('\n');
    if (typeof value === 'string') {
      const i = value.indexOf('{');
      if (i < 0) return null;
      try { value = JSON.parse(value.slice(i)); } catch { return null; }
    }
    return isObj(value) ? value : null;
  }
  function rememberData(result) {
    const data = parseData(result);
    if (data?.id && (data.current || data.daily)) weatherCache.set(String(data.id), data);
    return data;
  }
  function findWeather(id) {
    if (!id) return null;
    if (weatherCache.has(id)) return weatherCache.get(id);
    for (const m of app?.chat?.main?.messages || []) {
      for (const part of Array.isArray(m?.content) ? m.content : []) {
        if (part?.type !== 'tool-call' || !/get_weather$/.test(part.toolName || '') || part.result == null) continue;
        const data = rememberData(part.result);
        if (data?.id === id) return data;
      }
    }
    return null;
  }
  const WEMOJI = { sun: '\u2600\uFE0F', 'cloud-sun': '\u26C5', cloud: '\u2601\uFE0F', fog: '\uD83C\uDF2B\uFE0F', drizzle: '\uD83C\uDF26\uFE0F', rain: '\uD83C\uDF27\uFE0F', snow: '\uD83C\uDF28\uFE0F', storm: '\u26C8\uFE0F' };
  function wmo(code) {
    const w = C.weatherCode(code);
    const key = String((Array.isArray(w) ? w[1] : w?.icon) || '');
    const label = (Array.isArray(w) ? w[0] : w?.label) || 'Unknown';
    let e = WEMOJI.cloud;
    if (/storm|lightning|thunder/.test(key)) e = WEMOJI.storm;
    else if (/snow/.test(key)) e = WEMOJI.snow;
    else if (/drizzle/.test(key)) e = WEMOJI.drizzle;
    else if (/rain|shower/.test(key)) e = WEMOJI.rain;
    else if (/fog/.test(key)) e = WEMOJI.fog;
    else if (/sun/.test(key) && /cloud/.test(key)) e = WEMOJI['cloud-sun'];
    else if (/sun|clear/.test(key)) e = WEMOJI.sun;
    return { label, emoji: e };
  }
  const dayName = (iso, i) => {
    if (i === 0) return 'Today';
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? str(iso) : d.toLocaleDateString(undefined, { weekday: 'short' });
  };

  /* ---------- components ---------- */
  const R = {
    Stack(a) {
      return h('div', { class: 'gu-stack', 'data-dir': a.p.direction === 'horizontal' ? 'row' : 'col', 'data-gap': gap(a.p.gap, 'md'), 'data-align': a.p.align || '', 'data-wrap': a.p.wrap ? '1' : '' }, a.kids());
    },
    Row(a) {
      return h('div', { class: 'gu-stack', 'data-dir': 'row', 'data-gap': gap(a.p.gap, 'sm'), 'data-align': a.p.align || 'center', 'data-justify': a.p.justify || '', 'data-wrap': a.p.wrap === false ? '' : '1' }, a.kids());
    },
    Grid(a) {
      const cols = clamp(Math.round(numOr(a.p.columns, 2)), 1, 4);
      return h('div', { class: 'gu-grid', 'data-gap': gap(a.p.gap, 'sm'), style: `--gu-cols:${cols}` }, a.kids());
    },
    Card(a) {
      const head = a.p.title || a.p.subtitle ? h('div', { class: 'gu-card-head' }, emoji(a.p.icon),
        h('div', { class: 'gu-card-titles' }, a.p.title ? h('h3', { class: 'gu-card-title' }, str(a.p.title)) : null, a.p.subtitle ? h('p', { class: 'gu-card-sub' }, str(a.p.subtitle)) : null)) : null;
      const kids = a.kids();
      const node = h('div', { class: 'gu-card', 'data-variant': ['muted', 'outline', 'accent'].includes(a.p.variant) ? a.p.variant : 'default' }, head, kids.length ? h('div', { class: 'gu-card-body' }, kids) : null);
      if (a.has('press')) {
        node.setAttribute('role', 'button'); node.tabIndex = 0; node.dataset.press = '1'; node.dataset.gid = a.gid;
        node.addEventListener('click', (e) => { if (!e.target.closest('button, a, input, select, textarea, label')) a.on('press', {}, e); });
        node.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); a.on('press', {}, e); } });
      }
      return node;
    },
    Section(a) {
      return h('section', { class: 'gu-section' },
        a.p.title ? h('h3', { class: 'gu-section-title' }, str(a.p.title)) : null,
        a.p.description ? h('p', { class: 'gu-muted' }, str(a.p.description)) : null,
        h('div', { class: 'gu-stack', 'data-dir': 'col', 'data-gap': 'sm' }, a.kids()));
    },
    Tabs(a) {
      const tabs = options(a.p.tabs);
      const kids = a.kids();
      const toIndex = (v) => {
        if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v) && !tabs.some((t) => t.value === v))) return clamp(Math.round(Number(v)), 0, Math.max(0, tabs.length - 1));
        const i = tabs.findIndex((t) => t.value === str(v) || t.label === str(v));
        return i < 0 ? 0 : i;
      };
      const index = toIndex(a.bound('value') ? a.p.value ?? 0 : a.local('tab', a.p.value ?? 0));
      const base = fieldId(a.gid);
      const pick = (i, e) => {
        if (!tabs[i]) return;
        if (!a.bind('value', i)) a.setLocal('tab', i);
        a.on('change', { value: i, label: tabs[i].label }, e);
      };
      const list = h('div', { class: 'gu-tabs', role: 'tablist' }, tabs.map((t, i) => {
        const b = h('button', { type: 'button', role: 'tab', id: `${base}-t${i}`, 'aria-controls': `${base}-p`, 'aria-selected': String(i === index), tabindex: i === index ? '0' : '-1', class: 'gu-tab', 'data-gid': `${a.gid}#${i}` }, t.label);
        b.addEventListener('click', (e) => pick(i, e));
        b.addEventListener('keydown', (e) => {
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          let next = null;
          if (step) next = (i + step + tabs.length) % tabs.length; else if (e.key === 'Home') next = 0; else if (e.key === 'End') next = tabs.length - 1;
          if (next == null) return;
          e.preventDefault();
          b.parentElement.children[next]?.focus();
          pick(next, e);
        });
        return b;
      }));
      return h('div', { class: 'gu-tabs-wrap' }, list, h('div', { class: 'gu-tab-panel', role: 'tabpanel', id: `${base}-p`, 'aria-labelledby': `${base}-t${index}` }, kids[index] || null));
    },
    Collapsible(a) {
      const open = a.local('open', !!a.p.open);
      const d = h('details', { class: 'gu-collapsible', ...(open ? { open: '' } : {}) },
        h('summary', { class: 'gu-collapsible-head', 'data-gid': a.gid }, h('span', {}, str(a.p.title || 'Details')), icon('chevron-down')),
        h('div', { class: 'gu-collapsible-body' }, a.kids()));
      d.addEventListener('toggle', () => a.v.local.set(`${a.gid}:open`, d.open));
      return d;
    },
    Divider(a) {
      return a.p.label ? h('div', { class: 'gu-divider', role: 'separator' }, h('span', {}, str(a.p.label))) : h('hr', { class: 'gu-hr' });
    },
    Spacer(a) { return h('div', { class: 'gu-spacer', 'data-size': ['xs', 'sm', 'md', 'lg', 'xl'].includes(a.p.size) ? a.p.size : 'md', 'aria-hidden': 'true' }); },

    Header(a) {
      const img = mediaUrl(str(a.p.image));
      const kids = a.kids();
      return h('header', { class: 'gu-header', 'data-tone': tone(a.p.tone, 'neutral'), 'data-image': img ? '1' : '' },
        img ? h('img', { class: 'gu-header-img', src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
        h('div', { class: 'gu-header-text' },
          a.p.eyebrow ? h('p', { class: 'gu-eyebrow' }, str(a.p.eyebrow)) : null,
          h('div', { class: 'gu-header-row' }, emoji(a.p.icon), h('h2', { class: 'gu-header-title' }, str(a.p.title)), a.p.badge ? h('span', { class: 'gu-badge', 'data-tone': 'accent' }, str(a.p.badge)) : null),
          a.p.subtitle ? h('p', { class: 'gu-header-sub' }, str(a.p.subtitle)) : null,
          kids.length ? h('div', { class: 'gu-header-extra' }, kids) : null));
    },
    Heading(a) {
      const level = clamp(Math.round(numOr(a.p.level, 2)), 1, 4);
      return h(`h${level + 2}`, { class: 'gu-heading', 'data-level': String(level) }, str(a.p.text));
    },
    Text(a) {
      return h('p', { class: 'gu-text', 'data-tone': a.p.tone && a.p.tone !== 'default' ? str(a.p.tone) : '', 'data-size': str(a.p.size || ''), 'data-weight': str(a.p.weight || ''), 'data-align': str(a.p.align || ''), 'data-mono': a.p.mono ? '1' : '' }, str(a.p.text));
    },
    Markdown(a) {
      const box = h('div', { class: 'gu-markdown aui-md' });
      try { Markdown.render(box, str(a.p.text)); } catch { box.textContent = str(a.p.text); }
      return box;
    },
    Badge(a) { return h('span', { class: 'gu-badge', 'data-tone': tone(a.p.tone) }, str(a.p.text)); },
    Alert(a) {
      const t = tone(a.p.tone, 'info');
      const ic = { success: 'circle-check', warning: 'triangle-alert', danger: 'circle-x' }[t] || 'info';
      return h('div', { class: 'gu-alert', 'data-tone': t, role: t === 'danger' || t === 'warning' ? 'alert' : 'note' }, icon(ic),
        h('div', { class: 'gu-alert-text' }, a.p.title ? h('p', { class: 'gu-alert-title' }, str(a.p.title)) : null, a.p.text ? h('p', {}, str(a.p.text)) : null));
    },
    Image(a) {
      const src = mediaUrl(str(a.p.src));
      const aspect = { square: '1 / 1', wide: '16 / 9', video: '16 / 9', portrait: '3 / 4' }[a.p.aspect] || '';
      const fallback = () => h('div', { class: 'gu-img-missing', role: 'img', 'aria-label': str(a.p.alt || 'Image unavailable') }, str(a.p.alt || 'Image unavailable'));
      const img = src ? h('img', { src, alt: str(a.p.alt), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', style: aspect ? `aspect-ratio:${aspect}` : '', onerror: (e) => e.target.replaceWith(fallback()) }) : fallback();
      const href = httpsUrl(str(a.p.href));
      return h('figure', { class: 'gu-figure' }, href ? ext(href, img) : img, a.p.caption ? h('figcaption', {}, str(a.p.caption)) : null);
    },
    Link(a) {
      const href = linkUrl(str(a.p.href));
      if (!href) return h('span', { class: 'gu-text' }, str(a.p.label || a.p.href));
      return ext(href, [h('span', {}, str(a.p.label || href.replace(/^https?:\/\//, ''))), icon('external-link')], 'gu-link');
    },
    Code(a) {
      const code = str(a.p.code);
      const c = h('code', {});
      try { c.innerHTML = Markdown.highlight(code, str(a.p.language)); } catch { c.textContent = code; }
      const copy = h('button', { type: 'button', class: 'gu-icon-btn gu-code-copy', 'aria-label': 'Copy code', title: 'Copy' }, icon('copy'));
      copy.addEventListener('click', () => Promise.resolve(copyText(code)).then(() => toast('Copied', { type: 'success' })).catch(() => {}));
      return h('div', { class: 'gu-code-wrap' }, h('div', { class: 'gu-code-head' }, h('span', { class: 'gu-code-lang' }, str(a.p.language || 'code')), copy), h('pre', { class: 'gu-code', tabindex: '0' }, c));
    },

    Facts(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 100);
      return h('dl', { class: 'gu-facts', 'data-cols': numOr(a.p.columns, 1) >= 2 ? '2' : '1' }, items.map((it) => h('div', { class: 'gu-fact' },
        h('dt', {}, str(isObj(it) ? it.label ?? it.name ?? '' : it), isObj(it) && it.hint ? h('span', { class: 'gu-fact-hint' }, str(it.hint)) : null), h('dd', {}, str(isObj(it) ? it.value ?? '' : '')))));
    },
    Stat(a) {
      const trend = ['up', 'down', 'flat'].includes(a.p.trend) ? a.p.trend : '';
      const good = a.p.good === 'down' ? 'down' : 'up';
      const sentiment = !trend || trend === 'flat' || a.p.good === 'neutral' ? 'neutral' : trend === good ? 'success' : 'danger';
      return h('div', { class: 'gu-stat' },
        h('p', { class: 'gu-stat-label' }, str(a.p.label)),
        h('p', { class: 'gu-stat-value' }, str(a.p.value)),
        a.p.delta != null && a.p.delta !== '' ? h('p', { class: 'gu-stat-delta', 'data-tone': sentiment },
          trend === 'up' ? icon('arrow-up') : trend === 'down' ? icon('arrow-down') : null, h('span', {}, str(a.p.delta)),
          sentiment !== 'neutral' ? h('span', { class: 'sr-only' }, sentiment === 'success' ? ' (better)' : ' (worse)') : null) : null,
        a.p.hint ? h('p', { class: 'gu-hint' }, str(a.p.hint)) : null);
    },
    Table(a) {
      const rows = (Array.isArray(a.p.rows) ? a.p.rows : []).slice(0, 500);
      let cols = (Array.isArray(a.p.columns) ? a.p.columns : []).map((c) => (isObj(c) ? { key: str(c.key ?? c.label), label: str(c.label ?? c.key), format: c.format, align: c.align } : { key: str(c), label: str(c) }));
      if (!cols.length && rows.length && isObj(rows[0])) cols = Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
      const currency = /^[A-Z]{3}$/.test(str(a.p.currency)) ? a.p.currency : 'USD';
      const valueOf = (row, c, i) => (Array.isArray(row) ? row[i] : isObj(row) ? row[c.key] : i === 0 ? row : '');
      const cell = (val, c) => {
        if (typeof val === 'number') {
          if (c.format === 'currency') return fmtNum(val, { style: 'currency', currency });
          if (c.format === 'percent') return fmtNum(val, { style: 'percent', maximumFractionDigits: 1 });
          return fmtNum(val, { maximumFractionDigits: 2 });
        }
        if (typeof val === 'boolean') return val ? 'Yes' : 'No';
        return str(val);
      };
      const numeric = cols.map((c, i) => c.align === 'end' || c.align === 'right' || (c.align == null && rows.some((r) => typeof valueOf(r, c, i) === 'number')));
      const table = h('table', { class: 'gu-table' },
        a.p.caption ? h('caption', {}, str(a.p.caption)) : null,
        h('thead', {}, h('tr', {}, cols.map((c, i) => h('th', { scope: 'col', 'data-num': numeric[i] ? '1' : '' }, c.label)))),
        h('tbody', {}, rows.map((row) => h('tr', {}, cols.map((c, i) => h(i === 0 ? 'th' : 'td', { ...(i === 0 ? { scope: 'row' } : {}), 'data-num': numeric[i] ? '1' : '' }, cell(valueOf(row, c, i), c)))))));
      return h('div', { class: 'gu-table-wrap', tabindex: '0', role: 'region', 'aria-label': str(a.p.caption || 'Table') }, table);
    },
    List(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 200);
      const variant = ['plain', 'divided', 'cards', 'check', 'bullet'].includes(a.p.variant) ? a.p.variant : 'divided';
      return h(a.p.ordered ? 'ol' : 'ul', { class: 'gu-list', 'data-variant': variant }, items.map((it) => {
        const o = isObj(it) ? it : { title: it };
        const img = mediaUrl(str(o.image));
        const href = httpsUrl(str(o.href ?? o.url));
        const done = o.done !== false;
        const lead = variant === 'check' ? icon(done ? 'circle-check' : 'circle')
          : img ? h('img', { class: 'gu-list-img', src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
            : o.icon ? h('span', { class: 'gu-list-icon', 'aria-hidden': 'true' }, Array.from(str(o.icon)).slice(0, 2).join('')) : null;
        const body = [lead,
          h('span', { class: 'gu-list-text' }, h('span', { class: 'gu-list-title' }, str(o.title ?? o.text ?? o.label)), o.description ? h('span', { class: 'gu-muted gu-list-desc' }, str(o.description)) : null),
          o.meta != null && o.meta !== '' ? h('span', { class: 'gu-list-meta' }, str(o.meta)) : null,
          href ? icon('chevron-right') : null];
        return h('li', { 'data-done': variant === 'check' && done ? '1' : '' }, href ? ext(href, body, 'gu-list-link') : body);
      }));
    },
    Chart(a) {
      const p = a.p;
      const type = CHART_TYPES.includes(p.type) ? p.type : 'bar';
      const host = h('div', { class: 'gu-chart-host' });
      const box = h('figure', { class: 'gu-chart', 'data-type': type },
        p.title ? h('figcaption', { class: 'gu-chart-title' }, str(p.title), p.unit ? h('span', { class: 'gu-muted' }, ` (${str(p.unit)})`) : null) : null,
        host, chartTable(p));
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', `${str(p.title || 'Chart')}, ${type} chart. The data follows as a table.`);
      let lastW = 0;
      const draw = (w) => { lastW = w; host.replaceChildren(drawChart(p, w)); };
      draw(a.v.chartWidth || 320);
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver((entries) => {
          if (!host.isConnected) { ro.disconnect(); return; }
          const w = Math.round(entries[0]?.contentRect?.width || 0);
          if (w && Math.abs(w - lastW) > 2) { a.v.chartWidth = w; draw(w); }
        });
        ro.observe(host);
      }
      return box;
    },
    Progress(a) {
      const max = numOr(a.p.max, 100) || 100;
      const val = clamp(numOr(a.p.value, 0), 0, max);
      const pct = Math.round((val / max) * 100);
      return h('div', { class: 'gu-progress', 'data-tone': tone(a.p.tone, 'accent') },
        h('div', { class: 'gu-progress-head' }, h('span', {}, str(a.p.label || '')), a.p.showValue === false ? null : h('span', { class: 'gu-muted' }, `${pct}%`)),
        h('div', { class: 'gu-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(val), 'aria-label': str(a.p.label || 'Progress') },
          h('div', { class: 'gu-progress-fill', style: `width:${pct}%` })));
    },
    Timeline(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 100);
      return h('ol', { class: 'gu-timeline' }, items.map((it) => {
        const o = isObj(it) ? it : { title: it };
        return h('li', { 'data-tone': tone(o.tone, 'neutral') }, h('span', { class: 'gu-tl-dot', 'aria-hidden': 'true' }),
          h('div', { class: 'gu-tl-body' }, o.time ? h('p', { class: 'gu-tl-time' }, str(o.time)) : null, h('p', { class: 'gu-tl-title' }, str(o.title ?? o.text)), o.description ? h('p', { class: 'gu-muted' }, str(o.description)) : null));
      }));
    },
    Steps(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 50);
      const current = a.p.current == null ? -1 : numOr(a.p.current, -1);
      return h('ol', { class: 'gu-steps' }, items.map((it, i) => {
        const o = isObj(it) ? it : { title: it };
        const status = ['done', 'current', 'pending', 'upcoming', 'error'].includes(o.status) ? (o.status === 'upcoming' ? 'pending' : o.status) : current < 0 ? 'pending' : i < current ? 'done' : i === current ? 'current' : 'pending';
        const sr = { done: ' (done)', error: ' (failed)', current: ' (current step)' }[status];
        return h('li', { 'data-status': status, ...(status === 'current' ? { 'aria-current': 'step' } : {}) },
          h('span', { class: 'gu-step-n', 'aria-hidden': 'true' }, status === 'done' ? icon('check') : status === 'error' ? icon('x') : String(i + 1)),
          h('div', { class: 'gu-step-body' }, h('p', { class: 'gu-step-title' }, str(o.title ?? o.text), sr ? h('span', { class: 'sr-only' }, sr) : null), o.description ? h('p', { class: 'gu-muted' }, str(o.description)) : null));
      }));
    },
    Map(a) {
      const lat = numOr(a.p.latitude, NaN); const lon = numOr(a.p.longitude, NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return notice('This map has no valid location.', 'warning');
      const z = clamp(Math.round(a.local('zoom', numOr(a.p.zoom, 13))), 3, 17);
      const [cx, cy] = worldPx(lat, lon, z);
      const tiles = h('div', { class: 'gu-map-tiles', 'aria-hidden': 'true' });
      for (let ty = Math.floor((cy - 112) / TILE); ty <= Math.floor((cy + 112) / TILE); ty++) {
        if (ty < 0 || ty >= 2 ** z) continue;
        for (let tx = Math.floor((cx - 560) / TILE); tx <= Math.floor((cx + 560) / TILE); tx++) {
          tiles.append(h('img', { src: tileUrl(tx, ty, z), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer', style: `left:calc(50% + ${Math.round(tx * TILE - cx)}px);top:calc(50% + ${Math.round(ty * TILE - cy)}px)`, onerror: (e) => { e.target.style.visibility = 'hidden'; } }));
        }
      }
      const markers = [{ latitude: lat, longitude: lon, label: a.p.label }, ...(Array.isArray(a.p.markers) ? a.p.markers.slice(0, 30) : [])];
      const seen = new Set();
      const names = [];
      for (const m of markers) {
        if (!isObj(m)) continue;
        const mlat = numOr(m.latitude ?? m.lat, NaN); const mlon = numOr(m.longitude ?? m.lon ?? m.lng, NaN);
        if (!Number.isFinite(mlat) || !Number.isFinite(mlon)) continue;
        const k = `${mlat.toFixed(5)},${mlon.toFixed(5)}`; if (seen.has(k)) continue; seen.add(k);
        if (m.label) names.push(str(m.label));
        const [mx, my] = worldPx(mlat, mlon, z);
        tiles.append(h('span', { class: 'gu-map-pin', style: `left:calc(50% + ${Math.round(mx - cx)}px);top:calc(50% + ${Math.round(my - cy)}px)` },
          m.label ? h('span', { class: 'gu-map-pin-label' }, str(m.label).slice(0, 40)) : null));
      }
      const zoomBtn = (d, ic, label) => {
        const b = h('button', { type: 'button', class: 'gu-icon-btn', 'aria-label': label, title: label, 'data-gid': `${a.gid}z${d}`, ...(z + d < 3 || z + d > 17 ? { disabled: '' } : {}) }, icon(ic));
        b.addEventListener('click', () => a.setLocal('zoom', clamp(z + d, 3, 17)));
        return b;
      };
      const f = (x) => x.toFixed(5);
      const osm = `https://www.openstreetmap.org/?mlat=${f(lat)}&mlon=${f(lon)}#map=${z}/${f(lat)}/${f(lon)}`;
      const label = str(a.p.label || `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
      return h('figure', { class: 'gu-map' },
        h('div', { class: 'gu-map-view', role: 'img', 'aria-label': `Map of ${label}${names.length > 1 ? ` with ${names.length} places: ${names.join(', ')}` : ''}` }, tiles),
        h('div', { class: 'gu-map-zoom' }, zoomBtn(1, 'plus', 'Zoom in'), zoomBtn(-1, 'circle-minus', 'Zoom out')),
        h('span', { class: 'gu-map-attr' }, '\u00A9 ', ext('https://www.openstreetmap.org/copyright', 'OpenStreetMap'), ' \u00A9 ', ext('https://carto.com/attributions', 'CARTO')),
        h('figcaption', { class: 'gu-map-caption' }, h('span', { class: 'gu-map-label' }, label), ext(osm, [h('span', {}, 'Open map'), icon('external-link')], 'gu-link')));
    },
    Carousel(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 30);
      return h('ul', { class: 'gu-carousel', tabindex: '0', 'aria-label': 'Carousel, scroll sideways for more' }, items.map((it) => {
        const o = isObj(it) ? it : { title: it };
        const img = mediaUrl(str(o.image ?? o.src));
        const href = httpsUrl(str(o.href ?? o.url));
        const inner = [img ? h('img', { src: img, alt: str(o.alt || ''), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
          h('div', { class: 'gu-carousel-text' }, o.title ? h('p', { class: 'gu-carousel-title' }, str(o.title)) : null, o.subtitle || o.description || o.caption ? h('p', { class: 'gu-muted' }, str(o.subtitle ?? o.description ?? o.caption)) : null)];
        return h('li', { class: 'gu-carousel-item' }, href ? ext(href, inner) : inner);
      }));
    },
    Citations(a) {
      const items = (Array.isArray(a.p.items) ? a.p.items : []).slice(0, 50);
      return h('ol', { class: 'gu-citations' }, items.map((it, i) => {
        const o = isObj(it) ? it : { url: it };
        const href = linkUrl(str(o.url ?? o.href));
        let host = '';
        try { host = /^https?:/.test(href) ? new URL(href).hostname.replace(/^www\./, '') : ''; } catch { /* not a URL */ }
        const title = str(o.title || host || o.url || `Source ${i + 1}`);
        return h('li', {}, h('span', { class: 'gu-cite-n', 'aria-hidden': 'true' }, String(i + 1)),
          h('div', { class: 'gu-cite-body' }, href ? ext(href, title, 'gu-cite-title') : h('span', { class: 'gu-cite-title' }, title),
            host || o.source ? h('span', { class: 'gu-muted gu-cite-src' }, str(o.source || host)) : null, o.snippet ? h('p', { class: 'gu-cite-snippet' }, str(o.snippet)) : null));
      }));
    },
    Weather(a) {
      const data = isObj(a.p.data) ? a.p.data : findWeather(str(a.p.id));
      if (!data) return notice(a.p.id ? `The forecast "${str(a.p.id)}" isn't in this chat. Call get_weather first.` : 'No forecast to show.', 'warning');
      const units = isObj(data.units) ? data.units : {};
      const tu = str(units.temperature || '\u00B0C');
      const cur = isObj(data.current) ? data.current : {};
      const w = wmo(cur.weather_code ?? cur.code);
      const daily = Array.isArray(data.daily) ? data.daily : [];
      const days = clamp(Math.round(numOr(a.p.days, 7)), 1, 7);
      const deg = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? '\u2013' : `${Math.round(Number(x))}\u00B0`);
      const facts = [
        cur.apparent_temperature != null ? ['Feels like', `${Math.round(cur.apparent_temperature)}${tu}`] : null,
        cur.relative_humidity != null ? ['Humidity', `${Math.round(cur.relative_humidity)}%`] : null,
        cur.wind_speed != null ? ['Wind', `${Math.round(cur.wind_speed)} ${str(units.wind || 'km/h')}`] : null,
        cur.precipitation != null && Number(cur.precipitation) > 0 ? ['Rain now', `${cur.precipitation} ${str(units.precipitation || 'mm')}`] : null,
      ].filter(Boolean);
      const place = str(data.location?.name || data.name || '');
      const region = [data.location?.admin1, data.location?.country].filter(Boolean).map(str).join(', ');
      return h('div', { class: 'gu-weather' },
        h('div', { class: 'gu-weather-now' },
          h('span', { class: 'gu-weather-icon', 'aria-hidden': 'true' }, w.emoji),
          h('div', { class: 'gu-weather-main' },
            h('p', { class: 'gu-weather-place' }, place, region ? h('span', { class: 'gu-muted' }, ` ${region}`) : null),
            h('p', { class: 'gu-weather-temp' }, cur.temperature != null ? `${Math.round(cur.temperature)}${tu}` : '\u2013'),
            h('p', { class: 'gu-muted' }, w.label, daily[0] ? ` \u00B7 High ${deg(daily[0].max)}, low ${deg(daily[0].min)}` : ''))),
        facts.length ? h('dl', { class: 'gu-weather-facts' }, facts.map(([k, val]) => h('div', {}, h('dt', {}, k), h('dd', {}, val)))) : null,
        daily.length ? h('ol', { class: 'gu-weather-days', 'aria-label': 'Daily forecast' }, daily.slice(0, days).map((d, i) => {
          const dw = wmo(d.weather_code ?? d.code);
          return h('li', {}, h('span', { class: 'gu-wd-day' }, dayName(d.date, i)),
            h('span', { class: 'gu-wd-icon', title: dw.label, 'aria-hidden': 'true' }, dw.emoji), h('span', { class: 'sr-only' }, `${dw.label}, `),
            h('span', { class: 'gu-wd-rain' }, d.precipitation_probability != null ? `${Math.round(d.precipitation_probability)}%` : ''),
            h('span', { class: 'gu-wd-temps' }, h('span', { class: 'sr-only' }, 'high '), h('span', { class: 'gu-wd-max' }, deg(d.max)), h('span', { class: 'sr-only' }, ', low '), h('span', { class: 'gu-muted' }, deg(d.min))));
        })) : null,
        h('p', { class: 'gu-weather-src' }, ext('https://open-meteo.com/', 'Weather data by Open-Meteo')));
    },

    Button(a) {
      const variant = ['primary', 'secondary', 'outline', 'ghost', 'danger'].includes(a.p.variant) ? a.p.variant : 'secondary';
      const cls = { primary: 'btn-default', secondary: 'btn-outline gu-btn-secondary', outline: 'btn-outline', ghost: 'btn-ghost', danger: 'btn-destructive' }[variant];
      const b = h('button', { type: 'button', class: `btn ${cls}${a.p.size === 'sm' ? ' btn-sm' : ''} gu-btn`, 'data-gid': a.gid, ...(a.p.disabled ? { disabled: '' } : {}) },
        a.p.icon ? emoji(a.p.icon) : null, h('span', {}, str(a.p.label || 'OK')));
      b.addEventListener('click', (e) => a.on('press', {}, e));
      return b;
    },
    Input(a) {
      const type = ['text', 'number', 'email', 'tel', 'url', 'date', 'time', 'search', 'password'].includes(a.p.inputType) ? a.p.inputType : 'text';
      const n = h('input', { class: 'input', type, 'data-gid': a.gid, autocomplete: 'off', ...(type === 'number' ? { inputmode: 'decimal' } : {}) });
      n.value = a.p.value == null ? '' : str(a.p.value);
      if (a.p.placeholder) n.placeholder = str(a.p.placeholder);
      for (const k of ['min', 'max', 'step']) if (a.p[k] != null) n.setAttribute(k, str(a.p[k]));
      n.required = !!a.p.required;
      const read = () => (type === 'number' ? (n.value === '' ? null : numOr(n.value, null)) : n.value);
      n.addEventListener('input', () => { n.removeAttribute('aria-invalid'); a.bind('value', read(), { lazy: true }); a.on('change', { value: read() }, null); });
      n.addEventListener('change', () => { a.bind('value', read()); });
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !n.closest('form')) { e.preventDefault(); a.bind('value', read()); a.on('submit', { value: read() }, e); } });
      return field(a, n, a.p.label ? `${str(a.p.label)}${a.p.required ? ' *' : ''}` : '');
    },
    Textarea(a) {
      const n = h('textarea', { class: 'textarea', 'data-gid': a.gid, rows: String(clamp(Math.round(numOr(a.p.rows, 3)), 2, 12)) });
      n.value = a.p.value == null ? '' : str(a.p.value);
      if (a.p.placeholder) n.placeholder = str(a.p.placeholder);
      n.addEventListener('input', () => { a.bind('value', n.value, { lazy: true }); a.on('change', { value: n.value }, null); });
      n.addEventListener('change', () => { a.bind('value', n.value); });
      return field(a, n, str(a.p.label || ''));
    },
    Select(a) {
      const opts = options(a.p.options);
      const value = a.p.value == null ? '' : str(a.p.value);
      const known = opts.some((o) => o.value === value);
      const n = h('select', { class: 'select', 'data-gid': a.gid },
        !known || a.p.placeholder ? h('option', { value: '', disabled: '', ...(!known ? { selected: '' } : {}) }, str(a.p.placeholder || 'Choose…')) : null,
        opts.map((o) => h('option', { value: o.value, ...(o.value === value ? { selected: '' } : {}) }, o.label)));
      n.addEventListener('change', (e) => { a.bind('value', n.value); a.on('change', { value: n.value }, e); });
      return field(a, n, str(a.p.label || ''));
    },
    Checkbox(a) {
      const id = fieldId(a.gid);
      const n = h('input', { type: 'checkbox', class: 'gu-check', id, 'data-gid': a.gid, ...(C.truthy(a.p.checked) ? { checked: '' } : {}) });
      n.addEventListener('change', (e) => { a.bind('checked', n.checked); a.on('change', { value: n.checked, checked: n.checked }, e); });
      return h('div', { class: 'gu-checkrow' }, n, h('label', { for: id, class: 'gu-checklabel' }, h('span', {}, str(a.p.label)), a.p.description ? h('span', { class: 'gu-muted' }, str(a.p.description)) : null));
    },
    Switch(a) {
      const id = fieldId(a.gid);
      const n = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id, 'data-gid': a.gid, ...(C.truthy(a.p.checked) ? { checked: '' } : {}) });
      n.addEventListener('change', (e) => { a.bind('checked', n.checked); a.on('change', { value: n.checked, checked: n.checked }, e); });
      return h('div', { class: 'gu-switchrow' }, h('label', { for: id, class: 'gu-switchlabel' }, str(a.p.label)), n);
    },
    RadioGroup(a) {
      const opts = options(a.p.options);
      const value = a.p.value == null ? '' : str(a.p.value);
      const name = fieldId(a.gid);
      return h('fieldset', { class: 'gu-radios' }, a.p.label ? h('legend', { class: 'gu-label' }, str(a.p.label)) : null,
        opts.map((o, i) => {
          const id = `${name}-${i}`;
          const r = h('input', { type: 'radio', name, id, value: o.value, class: 'gu-radio', 'data-gid': `${a.gid}#${i}`, ...(o.value === value ? { checked: '' } : {}) });
          r.addEventListener('change', (e) => { if (r.checked) { a.bind('value', o.value); a.on('change', { value: o.value }, e); } });
          return h('div', { class: 'gu-checkrow' }, r, h('label', { for: id, class: 'gu-checklabel' }, h('span', {}, o.label), o.description ? h('span', { class: 'gu-muted' }, o.description) : null));
        }));
    },
    Slider(a) {
      const min = numOr(a.p.min, 0); const max = Math.max(min, numOr(a.p.max, 100)); const step = numOr(a.p.step, 1) || 1;
      const value = clamp(numOr(a.p.value, min), min, max);
      const unit = str(a.p.unit || '');
      const text = (x) => `${fmtNum(x)}${unit ? (unit.length > 2 ? ` ${unit}` : unit) : ''}`;
      const id = fieldId(a.gid);
      const out = h('output', { class: 'gu-slider-value', for: id }, text(value));
      const n = h('input', { type: 'range', class: 'gu-slider', id, min: String(min), max: String(max), step: String(step), 'data-gid': a.gid, 'aria-valuetext': text(value) });
      n.value = String(value);
      n.style.setProperty('--gu-fill', `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`);
      n.addEventListener('input', () => {
        const x = Number(n.value);
        out.textContent = text(x); n.setAttribute('aria-valuetext', text(x));
        n.style.setProperty('--gu-fill', `${max > min ? ((x - min) / (max - min)) * 100 : 0}%`);
        a.bind('value', x, { lazy: true }); a.on('change', { value: x }, null);
      });
      n.addEventListener('change', () => a.bind('value', Number(n.value)));
      return h('div', { class: 'gu-field' }, h('div', { class: 'gu-slider-head' }, h('label', { class: 'gu-label', for: id }, str(a.p.label || '')), out), n);
    },
    Stepper(a) {
      const min = numOr(a.p.min, 0); const max = Math.max(min, numOr(a.p.max, 99)); const step = numOr(a.p.step, 1) || 1;
      const value = clamp(numOr(a.p.value, min), min, max);
      const unit = str(a.p.unit || '');
      const label = str(a.p.label || '');
      const set = (x, e) => { const next = clamp(+x.toFixed(6), min, max); a.bind('value', next); a.on('change', { value: next }, e); };
      const minus = h('button', { type: 'button', class: 'gu-icon-btn', 'aria-label': `Decrease ${label}`.trim(), 'data-gid': `${a.gid}-`, ...(value - step < min ? { disabled: '' } : {}) }, icon('circle-minus'));
      const plus = h('button', { type: 'button', class: 'gu-icon-btn', 'aria-label': `Increase ${label}`.trim(), 'data-gid': `${a.gid}+`, ...(value + step > max ? { disabled: '' } : {}) }, icon('plus'));
      minus.addEventListener('click', (e) => set(value - step, e));
      plus.addEventListener('click', (e) => set(value + step, e));
      return h('div', { class: 'gu-stepper', role: 'group', 'aria-label': label || 'Amount' }, h('span', { class: 'gu-label' }, label),
        h('div', { class: 'gu-stepper-ctl' }, minus, h('output', { class: 'gu-stepper-value', 'aria-live': 'polite' }, `${fmtNum(value)}${unit ? ` ${unit}` : ''}`), plus));
    },
    Form(a) {
      const submit = h('button', { type: 'submit', class: 'btn btn-default gu-btn', 'data-gid': `${a.gid}!` }, str(a.p.submitLabel || 'Submit'));
      const form = h('form', { class: 'gu-form', novalidate: '' },
        a.p.title ? h('h3', { class: 'gu-card-title' }, str(a.p.title)) : null,
        h('div', { class: 'gu-stack', 'data-dir': 'col', 'data-gap': 'sm' }, a.kids()),
        h('div', { class: 'gu-form-actions' }, submit));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fields = [...form.querySelectorAll('input, select, textarea')];
        for (const f of fields) f.dispatchEvent(new Event('change'));
        const bad = fields.find((f) => !f.checkValidity());
        if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.reportValidity?.(); bad.focus(); return; }
        a.on('submit', clone(a.v.spec.state), e);
      });
      return form;
    },
    ChoiceChips(a) {
      const opts = options(a.p.options);
      const multiple = !!a.p.multiple;
      const selected = new Set(multiple ? (Array.isArray(a.p.value) ? a.p.value.map(str) : []) : a.p.value == null ? [] : [str(a.p.value)]);
      return h('div', { class: 'gu-chips', role: 'group' }, opts.map((o, i) => {
        const on = selected.has(o.value);
        const b = h('button', { type: 'button', class: 'gu-chip', 'aria-pressed': String(on), 'data-gid': `${a.gid}#${i}` }, on ? icon('check') : null, h('span', {}, o.label));
        b.addEventListener('click', (e) => {
          let next;
          if (multiple) { const s = new Set(selected); if (s.has(o.value)) s.delete(o.value); else s.add(o.value); next = opts.map((x) => x.value).filter((x) => s.has(x)); } else next = o.value;
          a.bind('value', next); a.on('change', { value: next }, e);
        });
        return b;
      }));
    },
  };

  /* ---------- tool cards and results ---------- */
  const treeArg = (args) => args.tree ?? args.ui ?? args.component ?? args.node ?? args.root;
  function specCard(part, status) {
    const args = isObj(part.args) ? part.args : {};
    const present = /present$/.test(part.toolName || '');
    const empty = present ? treeArg(args) == null : (args.patches ?? args.jsonl ?? args.ops ?? args.spec) == null;
    if (empty) return h('div', { class: 'gu-root gu-pending' }, h('p', { class: 'gu-hint' }, status?.type === 'running' ? 'Building the view…' : 'The agent sent an empty view.'));
    return ensureVersion(part).card();
  }

  function resultText(v) {
    const lines = [];
    const n = Object.keys(v.spec.elements || {}).length;
    lines.push(v.tool === 'present' ? `Shown to the user as "${v.title}" (${n} element${n === 1 ? '' : 's'}). Change it with edit_widget or a render_spec call with this title.` : `Rendered "${v.title}" version ${v.number} (${n} element${n === 1 ? '' : 's'}).`);
    if (v.patchErrors.length) {
      lines.push(`${v.patchErrors.length} patch line${v.patchErrors.length === 1 ? '' : 's'} skipped (the rest applied):`);
      for (const e of v.patchErrors.slice(0, 12)) lines.push(`- line ${e.line}: ${e.message}${e.text ? ` — ${e.text}` : ''}`);
    }
    if (v.issues.length) lines.push(C.formatIssues(v.issues));
    const user = v.userSummary();
    if (user) lines.push(`Values the user set (kept in this version): ${user}`);
    if (v.tool !== 'present') lines.push(`To change it, call render_spec with title "${v.title}" and only the patches that change it.`);
    return lines.join('\n');
  }

  const isFatal = (v) => !v.spec.root || !isObj(v.spec.elements?.[v.spec.root]);

  const TOOLS = [
    {
      name: 'render_spec',
      description: 'Show a native, themed UI in the chat from a flat JSON spec: dashboards, comparisons, plans, recipes that scale, budgets, checklists, forms, charts, maps, forecasts. The app draws it with its own components in light and dark, fitted to a 320 px phone. Send `patches` as JSONL JSON Patch lines (root first, then state, then each element, parents before children) or a complete `spec`. Call it again with the SAME title and only the changed patches to update it; the new version keeps what the user typed. Call read_me(["spec"]) first for the format, the 41 components and $calc expressions. Returns issues to fix.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'snake_case name for this UI in the conversation, e.g. "trip_budget". Reuse it to update the same UI.' },
          patches: { type: 'string', description: 'RFC 6902 operations, one JSON object per line, e.g. {"op":"add","path":"/root","value":"main"}.' },
          spec: { type: 'object', description: 'A complete spec {root, elements, state}, instead of patches.' },
        },
        required: ['title'],
      },
      execute(args, ctx) {
        if (!isObj(args) || !String(args.title || '').trim()) throw new Error('title is required (a snake_case name for this UI).');
        if (args.patches == null && args.spec == null && args.jsonl == null && args.ops == null) throw new Error('Send patches (JSONL) or a complete spec.');
        const v = ensureVersion({ toolCallId: ctx?.toolCallId, toolName: 'render_spec', args }, ctx);
        const text = resultText(v);
        if (isFatal(v)) throw new Error(`Nothing could be drawn. ${text}`);
        return text;
      },
    },
    {
      name: 'present',
      description: 'Show display-only content in the chat as a nested component tree with no state: a summary card, facts, a table, a chart, a timeline, citations, a map, a forecast. Each node is {"type":"Card","props":{…},"children":[…]}; a string child becomes Text. Use render_spec instead when the user types or picks something, or the UI must update later. Components: read_me(["present"]).',
      inputSchema: {
        type: 'object',
        properties: {
          tree: { description: 'The root node, or an array of nodes stacked vertically.' },
          title: { type: 'string', description: 'Optional snake_case name.' },
        },
        required: ['tree'],
      },
      execute(args, ctx) {
        if (!isObj(args) || treeArg(args) == null) throw new Error('tree is required.');
        const v = ensureVersion({ toolCallId: ctx?.toolCallId, toolName: 'present', args }, ctx);
        const text = resultText(v);
        if (isFatal(v)) throw new Error(`Nothing could be shown. ${text}`);
        return text;
      },
    },
  ];

  function addTools(list, ui) {
    for (const t of list) {
      if (!UI_TOOLS.some((x) => x.name === t.name)) UI_TOOLS.push(t);
      if (ui) TOOLKIT[`ui__${t.name}`] = { ...(TOOLKIT[`ui__${t.name}`] || {}), ui };
    }
  }

  function install() {
    addTools(TOOLS, specCard);
    // Maps switch between light and dark tiles with the theme.
    let dark = isDark();
    new MutationObserver(() => {
      if (isDark() === dark) return;
      dark = isDark();
      for (const v of calls.values()) if (v.el?.isConnected && v.el.querySelector('.gu-map')) v.render();
    }).observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  return { install, addTools, ensureVersion, Version, calls, byTitle, latest, titleKey, chatId, rememberData, findWeather, parseData, Renderer, R, TOOLS, resultText, isFatal, notice, drawChart, userStore };
})();
