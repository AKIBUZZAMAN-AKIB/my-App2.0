/* ==========================================================================
   Generative UI core: the pure (no DOM) half of the declarative UI builder.
   - JSON Pointer + RFC 6902 JSON Patch, applied as a stream of JSONL lines
   - a safe formula language for `$calc` (own tokenizer/parser, no eval)
   - expression resolution ($state, $bindState, $template, $cond, $calc,
     $item, $bindItem, $index, $event) and visibility conditions
   - the component catalog, spec validation with issues for the model
   - exact string edits (edit_widget) and the read_me guidance modules
   The spec format follows assistant-ui's generative-frame spec mode:
   { root, elements: { id: { type, props, children, visible, repeat, on } }, state }.
   This file is spliced into agent.html and loaded by vitest through node:vm.
   ========================================================================== */
const GenUICore = (() => {
  'use strict';

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const LIMITS = { elements: 400, depth: 32, patchLines: 2000, formulaSteps: 20000, formulaLength: 2000, repeatItems: 500 };

  /* ---------- JSON Pointer ---------- */
  function parsePointer(pointer) {
    if (pointer === '' || pointer === '/') return pointer === '' ? [] : [''];
    if (typeof pointer !== 'string' || pointer[0] !== '/') throw new Error(`"${pointer}" is not a JSON Pointer: it must start with "/"`);
    return pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  const toPointer = (tokens) => (tokens.length ? '/' + tokens.map((t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '');
  function getAt(base, tokens) {
    let cur = base;
    for (const t of tokens) {
      if (cur == null || typeof cur !== 'object' || FORBIDDEN_KEYS.has(t)) return undefined;
      if (Array.isArray(cur)) {
        if (!/^\d+$/.test(t)) return t === 'length' ? cur.length : undefined;
        cur = cur[Number(t)];
      } else {
        if (!Object.prototype.hasOwnProperty.call(cur, t)) return undefined;
        cur = cur[t];
      }
    }
    return cur;
  }
  const readPointer = (base, path) => {
    try { return getAt(base, parsePointer(path && path[0] !== '/' ? `/${path}` : path || '')); } catch { return undefined; }
  };

  /** Writes value at tokens inside root (mutates), creating objects on the way. `-` appends. */
  function setAt(root, tokens, value, { create = true, insert = false } = {}) {
    if (!tokens.length) return value;
    let cur = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i];
      if (FORBIDDEN_KEYS.has(t)) throw new Error(`"${t}" cannot be used as a key`);
      let next = Array.isArray(cur) ? cur[Number(t)] : cur[t];
      if (next == null || typeof next !== 'object') {
        if (!create) throw new Error(`path ${toPointer(tokens.slice(0, i + 1))} does not exist`);
        next = /^\d+$/.test(tokens[i + 1]) || tokens[i + 1] === '-' ? [] : {};
        if (Array.isArray(cur)) cur[Number(t)] = next; else cur[t] = next;
      }
      cur = next;
    }
    const last = tokens[tokens.length - 1];
    if (FORBIDDEN_KEYS.has(last)) throw new Error(`"${last}" cannot be used as a key`);
    if (Array.isArray(cur)) {
      if (last === '-') { cur.push(value); return root; }
      if (!/^\d+$/.test(last)) throw new Error(`"${last}" is not an array index`);
      const index = Number(last);
      if (index > cur.length) throw new Error(`index ${index} is past the end of the array (length ${cur.length})`);
      if (insert) cur.splice(index, 0, value); else cur[index] = value;
    } else if (cur && typeof cur === 'object') {
      cur[last] = value;
    } else {
      throw new Error(`cannot write inside a ${cur === null ? 'null' : typeof cur}`);
    }
    return root;
  }
  function removeAt(root, tokens) {
    if (!tokens.length) throw new Error('cannot remove the whole document');
    const parent = getAt(root, tokens.slice(0, -1));
    const last = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
      const index = Number(last);
      if (!/^\d+$/.test(last) || index >= parent.length) throw new Error(`no array item at ${toPointer(tokens)}`);
      parent.splice(index, 1);
    } else if (isObj(parent) && Object.prototype.hasOwnProperty.call(parent, last)) {
      delete parent[last];
    } else {
      throw new Error(`nothing to remove at ${toPointer(tokens)}`);
    }
    return root;
  }
  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** Applies one RFC 6902 operation to doc (mutates and returns the new doc). */
  function applyOperation(doc, op) {
    if (!isObj(op)) throw new Error('an operation must be a JSON object');
    const kind = op.op;
    if (!['add', 'replace', 'remove', 'move', 'copy', 'test'].includes(kind)) throw new Error(`unknown op "${kind}" (use add, replace, remove, move, copy or test)`);
    if (typeof op.path !== 'string') throw new Error('"path" must be a string');
    const tokens = parsePointer(op.path);
    const needsValue = kind === 'add' || kind === 'replace' || kind === 'test';
    if (needsValue && !('value' in op)) throw new Error(`"${kind}" needs a "value"`);
    switch (kind) {
      case 'add': {
        if (!tokens.length) return clone(op.value);
        const parent = getAt(doc, tokens.slice(0, -1));
        return setAt(doc, tokens, clone(op.value), { insert: Array.isArray(parent) });
      }
      case 'replace':
        if (!tokens.length) return clone(op.value);
        if (getAt(doc, tokens) === undefined) {
          // Be forgiving like streaming renderers: replacing a missing key adds it.
          return setAt(doc, tokens, clone(op.value));
        }
        return setAt(doc, tokens, clone(op.value));
      case 'remove':
        return removeAt(doc, tokens);
      case 'move':
      case 'copy': {
        if (typeof op.from !== 'string') throw new Error(`"${kind}" needs a "from" pointer`);
        const from = parsePointer(op.from);
        const value = getAt(doc, from);
        if (value === undefined) throw new Error(`nothing at "from" ${op.from}`);
        if (kind === 'move') {
          if (op.path.startsWith(op.from + '/')) throw new Error('cannot move a value inside itself');
          removeAt(doc, from);
        }
        const parent = getAt(doc, tokens.slice(0, -1));
        return setAt(doc, tokens, clone(value), { insert: Array.isArray(parent) });
      }
      case 'test':
        if (!deepEqual(getAt(doc, tokens), op.value)) throw new Error(`test failed at ${op.path}`);
        return doc;
      default:
        return doc;
    }
  }

  const emptySpec = () => ({ root: '', elements: {}, state: {} });

  /**
   * Applies patch operations to a spec. `patches` may be JSONL text (one op per line, the streaming form),
   * a JSON array of ops, or an array. A bad line is skipped and reported; the rest still apply.
   */
  function applyPatches(initial, patches) {
    let spec = clone(isObj(initial) ? initial : emptySpec());
    const errors = [];
    let ops = [];
    if (Array.isArray(patches)) {
      ops = patches.map((op, i) => ({ op, line: i + 1, text: safeJson(op) }));
    } else if (typeof patches === 'string') {
      const text = patches.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
      if (text.startsWith('[')) {
        try {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) ops = arr.map((op, i) => ({ op, line: i + 1, text: safeJson(op) }));
        } catch (e) {
          errors.push({ line: 1, text: text.slice(0, 120), message: `the patch array is not valid JSON (${e.message})` });
        }
      } else {
        const lines = text.split(/\r?\n/);
        lines.forEach((raw, i) => {
          const line = raw.trim().replace(/,$/, '');
          if (!line || line.startsWith('//')) return;
          try { ops.push({ op: JSON.parse(line), line: i + 1, text: line }); } catch (e) {
            errors.push({ line: i + 1, text: line.slice(0, 160), message: `not valid JSON (${e.message})` });
          }
        });
      }
    }
    if (ops.length > LIMITS.patchLines) {
      errors.push({ line: LIMITS.patchLines + 1, text: '', message: `only the first ${LIMITS.patchLines} operations were applied` });
      ops = ops.slice(0, LIMITS.patchLines);
    }
    for (const { op, line, text } of ops) {
      try {
        const next = applyOperation(spec, op);
        spec = isObj(next) ? next : spec;
        if (!isObj(next)) throw new Error('the root of a spec must stay an object');
      } catch (e) {
        errors.push({ line, text: String(text).slice(0, 160), message: e.message });
      }
    }
    if (!isObj(spec.elements)) spec.elements = {};
    if (!isObj(spec.state)) spec.state = {};
    return { spec, errors, applied: ops.length - errors.filter((e) => e.line <= ops.length).length };
  }
  function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

  /* ---------- formulas ($calc) ---------- */
  const FUNCS = {};
  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const list = (v) => (Array.isArray(v) ? v : null);
  const fieldValues = (arr, field) => arr.map((x) => (field ? readPointer(x, field) : x));
  const nums = (args) => {
    const flat = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return flat.map(num).filter((n) => n !== null);
  };
  const fmt = (locale, opts, value) => {
    try { return new Intl.NumberFormat(locale, opts).format(value); } catch { return String(value); }
  };
  const def = (name, min, max, run) => { FUNCS[name] = { min, max, run }; };
  def('round', 1, 2, ([x, d]) => { const n = num(x); if (n === null) return null; const p = 10 ** Math.max(0, Math.min(10, num(d) ?? 0)); return Math.round(n * p) / p; });
  def('floor', 1, 1, ([x]) => (num(x) === null ? null : Math.floor(num(x))));
  def('ceil', 1, 1, ([x]) => (num(x) === null ? null : Math.ceil(num(x))));
  def('abs', 1, 1, ([x]) => (num(x) === null ? null : Math.abs(num(x))));
  def('sqrt', 1, 1, ([x]) => (num(x) === null || num(x) < 0 ? null : Math.sqrt(num(x))));
  def('pow', 2, 2, ([x, y]) => (num(x) === null || num(y) === null ? null : num(x) ** num(y)));
  def('clamp', 3, 3, ([x, lo, hi]) => { const n = num(x), a = num(lo), b = num(hi); return n === null || a === null || b === null ? null : Math.min(Math.max(n, a), b); });
  def('min', 1, 50, (args) => { const n = nums(args); return n.length ? Math.min(...n) : null; });
  def('max', 1, 50, (args) => { const n = nums(args); return n.length ? Math.max(...n) : null; });
  def('count', 1, 1, ([l]) => (Array.isArray(l) ? l.length : typeof l === 'string' ? l.length : null));
  def('len', 1, 1, ([l]) => (Array.isArray(l) || typeof l === 'string' ? l.length : null));
  def('without', 2, 2, ([l, i]) => { const arr = list(l); const n = num(i); return arr && n !== null ? arr.filter((_, k) => k !== n) : arr; });
  def('sum', 1, 2, ([l, f]) => { const arr = list(l); if (!arr) return null; return fieldValues(arr, f).reduce((s, v) => s + (num(v) ?? 0), 0); });
  def('avg', 1, 2, ([l, f]) => { const arr = list(l); if (!arr || !arr.length) return null; const v = fieldValues(arr, f).map(num).filter((n) => n !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; });
  def('number', 1, 2, ([x, d], locale) => { const n = num(x); if (n === null) return null; const digits = num(d); return fmt(locale, digits === null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }, n); });
  def('currency', 1, 3, ([x, c, d], locale) => { const n = num(x); if (n === null) return null; const code = typeof c === 'string' && /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : 'USD'; const digits = num(d); return fmt(locale, { style: 'currency', currency: code, ...(digits === null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }) }, n); });
  def('percent', 1, 2, ([x, d], locale) => { const n = num(x); if (n === null) return null; const digits = num(d) ?? 0; return fmt(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }, n); });
  def('time', 1, 1, ([m]) => { const n = num(m); if (n === null) return null; const t = ((Math.round(n) % 1440) + 1440) % 1440; const hh = Math.floor(t / 60), mm = t % 60; const h12 = hh % 12 || 12; return `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; });
  def('plural', 3, 3, ([n, one, many]) => { const v = num(n); return `${v === null ? n : v} ${v === 1 ? one : many}`; });
  def('pmt', 3, 3, ([rate, periods, principal]) => { const r = num(rate), n = num(periods), p = num(principal); if (r === null || n === null || p === null || n <= 0) return null; return r === 0 ? p / n : (p * r) / (1 - (1 + r) ** -n); });
  def('upper', 1, 1, ([s]) => (s == null ? null : String(s).toUpperCase()));
  def('lower', 1, 1, ([s]) => (s == null ? null : String(s).toLowerCase()));
  def('join', 1, 2, ([l, sep]) => (Array.isArray(l) ? l.map((v) => (v == null ? '' : typeof v === 'object' ? safeJson(v) : String(v))).join(sep == null ? ', ' : String(sep)) : null));
  def('includes', 2, 2, ([l, v]) => (Array.isArray(l) ? l.some((x) => deepEqual(x, v)) : typeof l === 'string' ? l.includes(String(v)) : false));
  def('if', 3, 3, ([c, a, b]) => (truthy(c) ? a : b));

  const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)));

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '$' && src[i + 1] === '{') {
        const end = src.indexOf('}', i + 2);
        if (end < 0) throw new Error('a "${" reference is not closed with "}"');
        tokens.push({ kind: 'ref', text: src.slice(i + 2, end).trim() });
        i = end + 1;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        tokens.push({ kind: 'lit', value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1, out = '';
        while (j < src.length && src[j] !== c) {
          if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else out += src[j++];
        }
        if (j >= src.length) throw new Error('a text value is missing its closing quote');
        tokens.push({ kind: 'lit', value: out });
        i = j + 1;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        const w = m[0];
        if (w === 'true' || w === 'false') tokens.push({ kind: 'lit', value: w === 'true' });
        else if (w === 'null') tokens.push({ kind: 'lit', value: null });
        else tokens.push({ kind: 'name', text: w });
        i += w.length;
        continue;
      }
      const two = src.slice(i, i + 3) === '===' || src.slice(i, i + 3) === '!==' ? src.slice(i, i + 3) : src.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||', '**', '===', '!=='].includes(two)) {
        tokens.push({ kind: 'sym', text: two.length === 3 ? two.slice(0, 2) : two });
        i += two.length;
        continue;
      }
      if ('+-*/%<>!?:(),'.includes(c)) { tokens.push({ kind: 'sym', text: c }); i++; continue; }
      throw new Error(`unexpected character "${c}"`);
    }
    tokens.push({ kind: 'end' });
    return tokens;
  }

  const PARSE_CACHE = new Map();
  /** Parses a formula into an AST; throws a readable Error on bad syntax. */
  function parseFormula(src) {
    if (typeof src !== 'string') throw new Error('a formula must be text');
    if (src.length > LIMITS.formulaLength) throw new Error(`a formula may be at most ${LIMITS.formulaLength} characters`);
    if (PARSE_CACHE.has(src)) return PARSE_CACHE.get(src);
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const isSym = (t) => peek().kind === 'sym' && peek().text === t;
    const expect = (t) => { if (!isSym(t)) throw new Error(`expected "${t}" near token ${pos + 1}`); pos++; };
    const BIN = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
    const ternary = () => {
      const cond = binary(0);
      if (isSym('?')) { pos++; const a = ternary(); expect(':'); const b = ternary(); return { k: 'cond', c: cond, a, b }; }
      return cond;
    };
    const binary = (level) => {
      if (level >= BIN.length) return power();
      let left = binary(level + 1);
      while (peek().kind === 'sym' && BIN[level].includes(peek().text)) {
        const op = tokens[pos++].text;
        left = { k: 'bin', op, l: left, r: binary(level + 1) };
      }
      return left;
    };
    const power = () => {
      const base = unary();
      if (isSym('**')) { pos++; return { k: 'bin', op: '**', l: base, r: power() }; }
      return base;
    };
    const unary = () => {
      if (isSym('!') || isSym('-') || isSym('+')) { const op = tokens[pos++].text; return { k: 'un', op, v: unary() }; }
      return primary();
    };
    const primary = () => {
      const t = peek();
      if (t.kind === 'lit') { pos++; return { k: 'lit', v: t.value }; }
      if (t.kind === 'ref') {
        pos++;
        if (!(t.text === '$index' || t.text === '$item' || t.text.startsWith('$item/') || t.text === '$event' || t.text.startsWith('$event/') || t.text.startsWith('/'))) {
          throw new Error(`"\${${t.text}}" is not a reference: write \${/path} for state, or \${$item/field} / \${$index} inside a repeat`);
        }
        return { k: 'ref', p: t.text };
      }
      if (t.kind === 'name') {
        pos++;
        const fn = FUNCS[t.text];
        if (!isSym('(')) throw new Error(`"${t.text}" is not known: references are written \${/path}, text is quoted`);
        if (!fn) throw new Error(`unknown function "${t.text}"; available: ${Object.keys(FUNCS).join(', ')}`);
        pos++;
        const args = [];
        if (!isSym(')')) {
          do { args.push(ternary()); } while (isSym(',') && ++pos);
        }
        expect(')');
        if (args.length < fn.min || args.length > fn.max) throw new Error(`${t.text}() takes ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} argument${fn.max === 1 ? '' : 's'}, got ${args.length}`);
        return { k: 'call', n: t.text, args };
      }
      if (isSym('(')) { pos++; const e = ternary(); expect(')'); return e; }
      if (t.kind === 'end') throw new Error('the formula ends too early');
      throw new Error(`unexpected "${t.text}"`);
    };
    const ast = ternary();
    if (peek().kind !== 'end') throw new Error(`unexpected "${peek().text ?? ''}" after the end of the formula`);
    if (PARSE_CACHE.size > 500) PARSE_CACHE.clear();
    PARSE_CACHE.set(src, ast);
    return ast;
  }

  function readRef(path, ctx) {
    if (path === '$index') return ctx.index ?? null;
    if (path === '$item') return ctx.item ?? null;
    if (path.startsWith('$item/')) return readPointer(ctx.item, path.slice(5)) ?? null;
    if (path === '$event') return ctx.event ?? null;
    if (path.startsWith('$event/')) return readPointer(ctx.event, path.slice(6)) ?? null;
    return readPointer(ctx.state, path) ?? null;
  }

  /** Evaluates a formula. Returns null when it cannot compute (bad input, division by zero, too much work). */
  function evalFormula(src, ctx = {}) {
    let ast;
    try { ast = parseFormula(src); } catch { return null; }
    let steps = 0;
    const locale = ctx.locale || 'en-US';
    const ev = (n) => {
      if (++steps > LIMITS.formulaSteps) throw new Error('too much work');
      switch (n.k) {
        case 'lit': return n.v;
        case 'ref': return readRef(n.p, ctx);
        case 'cond': return truthy(ev(n.c)) ? ev(n.a) : ev(n.b);
        case 'un': {
          const v = ev(n.v);
          if (n.op === '!') return !truthy(v);
          const x = num(v);
          return x === null ? null : n.op === '-' ? -x : x;
        }
        case 'call': return FUNCS[n.n].run(n.args.map(ev), locale);
        case 'bin': {
          if (n.op === '&&') return truthy(ev(n.l)) && truthy(ev(n.r));
          if (n.op === '||') return truthy(ev(n.l)) || truthy(ev(n.r));
          const a = ev(n.l), b = ev(n.r);
          switch (n.op) {
            case '==': return looseEq(a, b);
            case '!=': return !looseEq(a, b);
            case '+':
              if (typeof a === 'string' || typeof b === 'string') return `${a ?? ''}${b ?? ''}`;
              return arith(a, b, (x, y) => x + y);
            case '-': return arith(a, b, (x, y) => x - y);
            case '*': return arith(a, b, (x, y) => x * y);
            case '/': return arith(a, b, (x, y) => (y === 0 ? null : x / y));
            case '%': return arith(a, b, (x, y) => (y === 0 ? null : x % y));
            case '**': return arith(a, b, (x, y) => x ** y);
            case '<': case '<=': case '>': case '>=': {
              const x = num(a), y = num(b);
              const [p, q] = x !== null && y !== null ? [x, y] : [String(a ?? ''), String(b ?? '')];
              return n.op === '<' ? p < q : n.op === '<=' ? p <= q : n.op === '>' ? p > q : p >= q;
            }
            default: return null;
          }
        }
        default: return null;
      }
    };
    try {
      const out = ev(ast);
      return typeof out === 'number' && !Number.isFinite(out) ? null : out === undefined ? null : out;
    } catch { return null; }
  }
  const arith = (a, b, f) => { const x = num(a), y = num(b); if (x === null || y === null) return null; const r = f(x, y); return r === null || !Number.isFinite(r) ? null : r; };
  const looseEq = (a, b) => {
    if (a === b) return true;
    const x = num(a), y = num(b);
    if (x !== null && y !== null && typeof a !== 'boolean' && typeof b !== 'boolean') return x === y;
    if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
    return typeof a === 'object' && typeof b === 'object' && deepEqual(a, b);
  };

  /* ---------- expressions ---------- */
  const EXPR_KEYS = ['$state', '$bindState', '$item', '$bindItem', '$index', '$template', '$cond', '$calc', '$event'];
  const isExpr = (v) => isObj(v) && EXPR_KEYS.some((k) => k in v);
  function fillTemplate(text, ctx) {
    return String(text).replace(/\$\{([^}]*)\}/g, (m, p) => {
      const path = p.trim();
      const v = path.startsWith('/') || path.startsWith('$') ? readRef(path, ctx) : undefined;
      if (v === undefined) return m;
      return v === null ? '' : typeof v === 'object' ? safeJson(v) : String(v);
    });
  }
  /** Resolves every expression inside value against ctx ({ state, item, index, event, locale }). */
  function resolve(value, ctx, depth = 0) {
    if (depth > 40) return null;
    if (Array.isArray(value)) return value.map((v) => resolve(v, ctx, depth + 1));
    if (!isObj(value)) return value;
    if ('$state' in value) return readRef(String(value.$state || ''), ctx) ?? (value.default ?? null);
    if ('$bindState' in value) return readRef(String(value.$bindState || ''), ctx) ?? null;
    if ('$item' in value) return value.$item === '' || value.$item === true ? (ctx.item ?? null) : readPointer(ctx.item, String(value.$item)) ?? null;
    if ('$bindItem' in value) return readPointer(ctx.item, String(value.$bindItem)) ?? null;
    if ('$index' in value) return ctx.index ?? null;
    if ('$event' in value) return value.$event === '' ? (ctx.event ?? null) : readPointer(ctx.event, String(value.$event)) ?? null;
    if ('$template' in value) return fillTemplate(value.$template, ctx);
    if ('$calc' in value) return evalFormula(String(value.$calc), ctx);
    if ('$cond' in value) return resolve(checkCondition(value.$cond, ctx) ? value.$then : value.$else, ctx, depth + 1) ?? null;
    const out = {};
    for (const k of Object.keys(value)) if (!FORBIDDEN_KEYS.has(k)) out[k] = resolve(value[k], ctx, depth + 1);
    return out;
  }
  /** The state path a `$bindState` / `$bindItem` writes back to, or null. */
  function bindingPath(value, ctx) {
    if (!isObj(value)) return null;
    if (typeof value.$bindState === 'string') return value.$bindState;
    if (typeof value.$bindItem === 'string' && typeof ctx.itemPath === 'string') return ctx.itemPath + (value.$bindItem.startsWith('/') ? value.$bindItem : `/${value.$bindItem}`);
    return null;
  }
  /** Visibility / `$cond` conditions. */
  function checkCondition(cond, ctx, depth = 0) {
    if (depth > 30) return false;
    if (cond === undefined) return true;
    if (typeof cond === 'boolean') return cond;
    if (Array.isArray(cond)) return cond.every((c) => checkCondition(c, ctx, depth + 1));
    if (!isObj(cond)) return truthy(cond);
    if ('not' in cond) return !checkCondition(cond.not, ctx, depth + 1);
    if ('$or' in cond) return Array.isArray(cond.$or) && cond.$or.some((c) => checkCondition(c, ctx, depth + 1));
    if ('$and' in cond) return Array.isArray(cond.$and) && cond.$and.every((c) => checkCondition(c, ctx, depth + 1));
    const value = resolve(Object.fromEntries(Object.entries(cond).filter(([k]) => EXPR_KEYS.includes(k) || k === 'default')), ctx, depth + 1);
    const v = isExpr(cond) ? value : cond;
    const cmp = [['eq', (a, b) => looseEq(a, b)], ['neq', (a, b) => !looseEq(a, b)], ['gt', (a, b) => num(a) !== null && num(b) !== null && num(a) > num(b)], ['gte', (a, b) => num(a) !== null && num(b) !== null && num(a) >= num(b)], ['lt', (a, b) => num(a) !== null && num(b) !== null && num(a) < num(b)], ['lte', (a, b) => num(a) !== null && num(b) !== null && num(a) <= num(b)]];
    const present = cmp.filter(([k]) => k in cond);
    if (!present.length) return truthy(v);
    return present.every(([k, f]) => f(v, resolve(cond[k], ctx, depth + 1)));
  }

  /* ---------- component catalog ---------- */
  // prop type shorthands: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' | [enum values]
  const P = (type, description, extra = {}) => ({ type, description, ...extra });
  const TONES = ['default', 'muted', 'info', 'success', 'warning', 'danger'];
  const CATALOG = {
    // layout
    Stack: { group: 'layout', children: true, description: 'Lays children out in a column (or a row with direction "horizontal").', props: { direction: P(['vertical', 'horizontal'], 'Default vertical.'), gap: P(['none', 'xs', 'sm', 'md', 'lg'], 'Space between children. Default md.'), align: P(['start', 'center', 'end', 'stretch'], 'Cross-axis alignment.'), wrap: P('boolean', 'Wrap horizontal children onto new lines.') } },
    Row: { group: 'layout', children: true, description: 'Children side by side; wraps on narrow phones.', props: { gap: P(['none', 'xs', 'sm', 'md', 'lg'], 'Default sm.'), align: P(['start', 'center', 'end', 'stretch', 'baseline'], 'Vertical alignment. Default center.'), justify: P(['start', 'center', 'end', 'between'], 'Horizontal distribution.'), wrap: P('boolean', 'Default true.') } },
    Grid: { group: 'layout', children: true, description: 'A responsive grid: as many columns as fit, never more than `columns`; one column on a 320 px phone.', props: { columns: P('number', 'Most columns (1-4). Default 2.'), gap: P(['xs', 'sm', 'md', 'lg'], 'Default sm.') } },
    Card: { group: 'layout', children: true, description: 'A bordered surface that groups content, with an optional title.', props: { title: P('string', 'Card title.'), subtitle: P('string', 'Line under the title.'), variant: P(['default', 'muted', 'outline', 'accent'], 'Default default.'), icon: P('string', 'An emoji shown before the title.') }, events: ['press'] },
    Section: { group: 'layout', children: true, description: 'A titled section without a border.', props: { title: P('string', 'Section heading.'), description: P('string', 'Muted text under it.') } },
    Tabs: { group: 'layout', children: true, description: 'Tabbed panels: child i is the panel for tabs[i]; only the selected panel shows.', props: { tabs: P('array', 'Tab labels, as strings or {label}.', { required: true }), value: P('any', 'Selected tab index; bind it with {"$bindState":"/tab"} to read or set it.') }, events: ['change'] },
    Collapsible: { group: 'layout', children: true, description: 'A disclosure: a title that opens to show its children.', props: { title: P('string', 'Summary line.', { required: true }), open: P('boolean', 'Open at first.') } },
    Divider: { group: 'layout', children: false, description: 'A thin horizontal rule.', props: { label: P('string', 'Optional centred label.') } },
    Spacer: { group: 'layout', children: false, description: 'Empty vertical space.', props: { size: P(['xs', 'sm', 'md', 'lg'], 'Default md.') } },
    // content
    Header: { group: 'content', children: true, description: 'A hero header for the whole UI: optional eyebrow, title, subtitle, badge and image; children go under it (actions, facts).', props: { title: P('string', 'Main title.', { required: true }), subtitle: P('string', 'Supporting line.'), eyebrow: P('string', 'Small label above the title.'), badge: P('string', 'A short status pill.'), tone: P(TONES, 'Badge tone.'), image: P('string', 'https: image URL shown as a banner.'), icon: P('string', 'An emoji beside the title.') } },
    Heading: { group: 'content', children: false, description: 'A heading.', props: { text: P('string', 'Heading text.', { required: true }), level: P('number', '1-4. Default 2.') } },
    Text: { group: 'content', children: false, description: 'A paragraph of plain text.', props: { text: P('any', 'The text.', { required: true }), tone: P(TONES, 'Colour. Default default.'), size: P(['xs', 'sm', 'md', 'lg', 'xl'], 'Default md.'), weight: P(['normal', 'medium', 'bold'], 'Default normal.'), align: P(['start', 'center', 'end'], 'Default start.'), mono: P('boolean', 'Monospace digits/text.') } },
    Markdown: { group: 'content', children: false, description: 'Rich text in Markdown (bold, lists, links, inline code).', props: { text: P('string', 'Markdown source.', { required: true }) } },
    Badge: { group: 'content', children: false, description: 'A small pill label.', props: { text: P('any', 'Label.', { required: true }), tone: P(TONES, 'Colour.') } },
    Alert: { group: 'content', children: true, description: 'A callout for a tip, warning or error.', props: { title: P('string', 'Bold first line.'), text: P('string', 'Body text.'), tone: P(['info', 'success', 'warning', 'danger'], 'Default info.') } },
    Image: { group: 'content', children: false, description: 'An image from an https: URL.', props: { src: P('string', 'https: URL.', { required: true }), alt: P('string', 'What it shows.', { required: true }), caption: P('string', 'Caption under it.'), aspect: P(['auto', 'square', 'video', 'wide', 'portrait'], 'Crop to an aspect ratio. Default auto.'), href: P('string', 'Page to open when tapped.') } },
    Link: { group: 'content', children: false, description: 'A link that opens in the browser.', props: { label: P('string', 'Link text.', { required: true }), href: P('string', 'https: URL.', { required: true }) } },
    Code: { group: 'content', children: false, description: 'A block of code or preformatted text with a copy button.', props: { code: P('string', 'The code.', { required: true }), language: P('string', 'Language name.') } },
    // data
    Facts: { group: 'data', children: false, description: 'Label/value pairs, such as a summary of details.', props: { items: P('array', '[{label, value, hint?}]', { required: true }), columns: P('number', '1 or 2. Default 1 (2 on wide screens when set to 2).') } },
    Stat: { group: 'data', children: false, description: 'One headline number with a label and an optional change.', props: { label: P('string', 'What it measures.', { required: true }), value: P('any', 'The number or text.', { required: true }), delta: P('any', 'Change, e.g. "+12%".'), trend: P(['up', 'down', 'flat'], 'Arrow direction.'), good: P(['up', 'down'], 'Which direction is good (colours the delta). Default up.'), hint: P('string', 'Small text under it.') } },
    Table: { group: 'data', children: false, description: 'A table that scrolls inside itself on narrow screens.', props: { columns: P('array', 'Columns: strings, or {key, label, align?: "start"|"end", format?: "number"|"currency"|"percent"}.', { required: true }), rows: P('array', 'Rows: arrays of cells, or objects keyed by column key.', { required: true }), caption: P('string', 'Caption.'), currency: P('string', 'ISO code for currency columns. Default USD.') } },
    List: { group: 'data', children: false, description: 'A list of items: strings, or {title, description?, meta?, icon?, image?, href?}.', props: { items: P('array', 'The items.', { required: true }), ordered: P('boolean', 'Number the items.'), variant: P(['plain', 'divided', 'cards'], 'Default divided.') } },
    Chart: { group: 'data', children: false, description: 'A bar, line, area, pie or donut chart drawn as SVG.', props: { type: P(['bar', 'line', 'area', 'pie', 'donut'], 'Default bar.'), data: P('array', 'Single series: [{label, value}].'), labels: P('array', 'X labels for multi-series data.'), series: P('array', 'Multi-series: [{name, values: number[]}] (at most 4).'), unit: P('string', 'Unit after values, e.g. "mm".'), title: P('string', 'Chart title.'), height: P('number', 'Plot height in px (120-360). Default 180.'), stacked: P('boolean', 'Stack multi-series bars.') } },
    Progress: { group: 'data', children: false, description: 'A progress bar.', props: { value: P('any', 'Current value.', { required: true }), max: P('number', 'Default 100.'), label: P('string', 'Label.'), tone: P(TONES, 'Colour.'), showValue: P('boolean', 'Show the percentage. Default true.') } },
    Timeline: { group: 'data', children: false, description: 'Events in time order: [{time, title, description?, tone?}].', props: { items: P('array', 'The events.', { required: true }) } },
    Steps: { group: 'data', children: false, description: 'Numbered steps with status: [{title, description?, status?: "done"|"current"|"upcoming"}].', props: { items: P('array', 'The steps.', { required: true }), current: P('number', 'Index of the current step (sets status for items without one).') } },
    Map: { group: 'data', children: false, description: 'A map of a place from OpenStreetMap tiles with a marker, and an Open in Maps link.', props: { latitude: P('number', 'Latitude.', { required: true }), longitude: P('number', 'Longitude.', { required: true }), zoom: P('number', '3-17. Default 13.'), label: P('string', 'Place name.'), markers: P('array', 'Extra markers [{latitude, longitude, label?}] near the centre.') } },
    Carousel: { group: 'data', children: false, description: 'A horizontally swiping row of image cards: [{image, title?, caption?, href?}].', props: { items: P('array', 'The cards.', { required: true }) } },
    Citations: { group: 'data', children: false, description: 'Numbered sources: [{title, url, source?, snippet?}].', props: { items: P('array', 'The sources.', { required: true }) } },
    Weather: { group: 'data', children: false, description: 'A weather card from a get_weather result: pass its `id`, or the result object as `data`.', props: { id: P('string', 'The id a get_weather result returned.'), data: P('object', 'A get_weather result object.'), days: P('number', 'Days of forecast to show (1-7).') } },
    // interactive
    Button: { group: 'interactive', children: false, description: 'A button that runs actions on press.', props: { label: P('any', 'Button text.', { required: true }), variant: P(['primary', 'secondary', 'outline', 'ghost', 'danger'], 'Default secondary.'), size: P(['sm', 'md'], 'Default md.'), disabled: P('any', 'Disable it (a condition is fine).'), icon: P('string', 'An emoji before the label.') }, events: ['press'] },
    Input: { group: 'interactive', children: false, description: 'A one-line text or number field.', props: { label: P('string', 'Field label.'), value: P('any', 'Bind with {"$bindState":"/path"}.'), placeholder: P('string', 'Hint text.'), inputType: P(['text', 'number', 'email', 'tel', 'url', 'date', 'time', 'search', 'password'], 'Default text.'), min: P('number', 'Number minimum.'), max: P('number', 'Number maximum.'), step: P('number', 'Number step.'), required: P('boolean', 'Must be filled in a Form.') }, events: ['change', 'submit'] },
    Textarea: { group: 'interactive', children: false, description: 'A multi-line text field.', props: { label: P('string', 'Field label.'), value: P('any', 'Bind with $bindState.'), placeholder: P('string', 'Hint text.'), rows: P('number', 'Visible lines (2-12). Default 3.') }, events: ['change'] },
    Select: { group: 'interactive', children: false, description: 'A dropdown.', props: { label: P('string', 'Field label.'), value: P('any', 'Bind with $bindState.'), options: P('array', 'Strings or {label, value}.', { required: true }), placeholder: P('string', 'Shown when nothing is chosen.') }, events: ['change'] },
    Checkbox: { group: 'interactive', children: false, description: 'A checkbox.', props: { label: P('string', 'Label.', { required: true }), checked: P('any', 'Bind with $bindState.'), description: P('string', 'Muted line under the label.') }, events: ['change'] },
    Switch: { group: 'interactive', children: false, description: 'An on/off toggle.', props: { label: P('string', 'Label.', { required: true }), checked: P('any', 'Bind with $bindState.') }, events: ['change'] },
    RadioGroup: { group: 'interactive', children: false, description: 'Pick one of a few options.', props: { label: P('string', 'Group label.'), value: P('any', 'Bind with $bindState.'), options: P('array', 'Strings or {label, value, description?}.', { required: true }) }, events: ['change'] },
    Slider: { group: 'interactive', children: false, description: 'A range slider that shows its value.', props: { label: P('string', 'Label.'), value: P('any', 'Bind with $bindState.'), min: P('number', 'Default 0.'), max: P('number', 'Default 100.'), step: P('number', 'Default 1.'), unit: P('string', 'Shown after the value.') }, events: ['change'] },
    Stepper: { group: 'interactive', children: false, description: 'A number with - and + buttons, such as guests or servings.', props: { label: P('string', 'Label.'), value: P('any', 'Bind with $bindState.', { required: true }), min: P('number', 'Default 0.'), max: P('number', 'Default 99.'), step: P('number', 'Default 1.'), unit: P('string', 'Shown after the value.') }, events: ['change'] },
    Form: { group: 'interactive', children: true, description: 'Groups fields with a submit button; `submit` runs when the user taps it and every required field is filled.', props: { submitLabel: P('string', 'Default "Submit".'), title: P('string', 'Optional heading.') }, events: ['submit'] },
    ChoiceChips: { group: 'interactive', children: false, description: 'Tappable chips; single or multiple choice.', props: { options: P('array', 'Strings or {label, value}.', { required: true }), value: P('any', 'Bind with $bindState (a value, or a list when multiple).'), multiple: P('boolean', 'Allow several.') }, events: ['change'] },
  };
  const ACTIONS = {
    setState: { params: { path: 'string', value: 'any' }, required: ['path'], description: 'Writes `value` at the JSON Pointer `path` in state (append to a list with `/items/-`).' },
    sendMessage: { params: { text: 'string' }, required: ['text'], description: 'Sends `text` as the user\'s next chat message. Only runs on a tap.' },
    copyText: { params: { text: 'string' }, required: ['text'], description: 'Copies `text` to the clipboard.' },
    openUrl: { params: { url: 'string' }, required: ['url'], description: 'Opens an https: URL in the browser.' },
    toggle: { params: { path: 'string' }, required: ['path'], description: 'Flips the boolean at `path`.' },
  };
  const COMPONENT_NAMES = Object.keys(CATALOG);

  /* ---------- validation ---------- */
  const near = (name, options) => {
    const lower = String(name).toLowerCase();
    const hit = options.find((o) => o.toLowerCase() === lower) || options.find((o) => o.toLowerCase().startsWith(lower.slice(0, 3)));
    return hit ? ` Did you mean "${hit}"?` : '';
  };
  const ALIASES = { Column: 'Stack', Col: 'Stack', Box: 'Stack', VStack: 'Stack', HStack: 'Row', Title: 'Heading', Paragraph: 'Text', Label: 'Text', Caption: 'Text', KeyValue: 'Facts', Fact: 'Facts', Metric: 'Stat', Kpi: 'Stat', Toggle: 'Switch', Radio: 'RadioGroup', Dropdown: 'Select', TextField: 'Input', Accordion: 'Collapsible', Gallery: 'Carousel', Sources: 'Citations', Callout: 'Alert', Separator: 'Divider' };

  /** Validates a spec. Returns { ok, issues: [{severity, code, path, message}] }. */
  function validateSpec(spec) {
    const issues = [];
    const add = (severity, code, path, message) => issues.push({ severity, code, path, message });
    if (!isObj(spec)) { add('error', 'invalid-spec', '', 'The spec must be an object { root, elements, state }.'); return { ok: false, issues }; }
    const elements = isObj(spec.elements) ? spec.elements : null;
    if (!elements) add('error', 'missing-elements', '/elements', '`elements` must be an object mapping ids to elements.');
    if (typeof spec.root !== 'string' || !spec.root) add('error', 'missing-root', '/root', 'Set `root` to the id of the top element, e.g. {"op":"add","path":"/root","value":"main"}.');
    else if (elements && !elements[spec.root]) add('error', 'missing-root-element', '/root', `The root "${spec.root}" has no element. Add it at /elements/${spec.root}.`);
    if (spec.state !== undefined && !isObj(spec.state)) add('error', 'invalid-state', '/state', '`state` must be an object.');
    if (!elements) return { ok: false, issues };
    const ids = Object.keys(elements);
    if (ids.length > LIMITS.elements) add('error', 'too-many-elements', '/elements', `A spec may have at most ${LIMITS.elements} elements (this one has ${ids.length}). Use repeat for long lists.`);
    for (const id of ids) {
      const el = elements[id];
      const base = `/elements/${toPointer([id]).slice(1)}`;
      if (!isObj(el)) { add('error', 'invalid-element', base, 'An element must be an object { type, props, children }.'); continue; }
      const type = el.type;
      const def = CATALOG[type];
      if (!def) {
        const alias = ALIASES[type];
        add('error', 'unknown-type', `${base}/type`, `Unknown component "${type}".${alias ? ` Use "${alias}".` : near(type, COMPONENT_NAMES)} Components: ${COMPONENT_NAMES.join(', ')}.`);
        continue;
      }
      if (el.props !== undefined && !isObj(el.props)) add('error', 'invalid-props', `${base}/props`, '`props` must be an object.');
      const props = isObj(el.props) ? el.props : {};
      for (const [name, pd] of Object.entries(def.props)) {
        if (pd.required && (props[name] === undefined || props[name] === null || props[name] === '')) add('error', 'missing-prop', `${base}/props/${name}`, `${type} needs \`${name}\` (${pd.description})`);
      }
      for (const [name, value] of Object.entries(props)) {
        const pd = def.props[name];
        const path = `${base}/props/${name}`;
        if (!pd) {
          if (!(type === 'Text' && name === 'content')) add('warning', 'unknown-prop', path, `${type} has no prop \`${name}\`; it is ignored. Props: ${Object.keys(def.props).join(', ')}.`);
          continue;
        }
        checkExpressions(value, path, add);
        if (isExpr(value)) continue;
        if (Array.isArray(pd.type) && value !== undefined && !pd.type.includes(value)) add('error', 'invalid-enum', path, `\`${name}\` must be one of ${pd.type.map((x) => `"${x}"`).join(', ')}, not ${safeJson(value)}.`);
        else if (pd.type === 'number' && value !== undefined && typeof value !== 'number') add(num(value) === null ? 'error' : 'warning', 'invalid-type', path, `\`${name}\` should be a number, not ${safeJson(value)}.`);
        else if (pd.type === 'array' && value !== undefined && !Array.isArray(value)) add('error', 'invalid-type', path, `\`${name}\` must be an array.`);
        else if (pd.type === 'boolean' && value !== undefined && typeof value !== 'boolean') add('warning', 'invalid-type', path, `\`${name}\` should be true or false.`);
      }
      if (type === 'Chart' && !isExpr(props.data) && !isExpr(props.series) && !Array.isArray(props.data) && !Array.isArray(props.series)) add('error', 'missing-prop', `${base}/props/data`, 'Chart needs `data` ([{label, value}]) or `series` ([{name, values}]) with `labels`.');
      if (type === 'Weather' && !props.id && !props.data) add('error', 'missing-prop', `${base}/props/id`, 'Weather needs the `id` a get_weather result returned (or the result as `data`).');
      if (el.children !== undefined) {
        if (!Array.isArray(el.children)) add('error', 'invalid-children', `${base}/children`, '`children` must be an array of element ids.');
        else {
          if (el.children.length && !def.children) add('error', 'no-children', `${base}/children`, `${type} takes no children; put them in a Stack or Card.`);
          el.children.forEach((child, i) => {
            if (typeof child !== 'string') add('error', 'invalid-child', `${base}/children/${i}`, 'Children are element ids (strings), never nested elements.');
            else if (!elements[child]) add('error', 'missing-child', `${base}/children/${i}`, `Child "${child}" has no element. Add /elements/${child} or remove it from children.`);
          });
        }
      }
      if (el.visible !== undefined) checkExpressions(el.visible, `${base}/visible`, add);
      if (el.repeat !== undefined) {
        if (!isObj(el.repeat) || typeof el.repeat.path !== 'string') add('error', 'invalid-repeat', `${base}/repeat`, '`repeat` must be { "path": "/items", "key"?: "id" }.');
        else {
          const arr = readPointer(spec.state, el.repeat.path);
          if (arr !== undefined && !Array.isArray(arr)) add('error', 'invalid-repeat', `${base}/repeat/path`, `State at ${el.repeat.path} is not a list.`);
          else if (arr === undefined) add('warning', 'repeat-empty', `${base}/repeat/path`, `Nothing in state at ${el.repeat.path} yet, so this repeat shows nothing.`);
        }
      }
      if (el.on !== undefined) {
        if (!isObj(el.on)) add('error', 'invalid-on', `${base}/on`, '`on` maps event names to actions.');
        else for (const [event, binding] of Object.entries(el.on)) {
          const allowed = def.events || [];
          if (!allowed.includes(event)) add('error', 'unknown-event', `${base}/on/${event}`, `${type} has no \`${event}\` event${allowed.length ? `; use ${allowed.map((e) => `\`${e}\``).join(', ')}` : ''}.`);
          (Array.isArray(binding) ? binding : [binding]).forEach((b, i) => checkAction(b, `${base}/on/${event}${Array.isArray(binding) ? `/${i}` : ''}`, add));
        }
      }
      for (const key of Object.keys(el)) {
        if (!['type', 'props', 'children', 'visible', 'repeat', 'on', 'key'].includes(key)) add('warning', 'unknown-key', `${base}/${key}`, `Elements have no \`${key}\` key; it is ignored.`);
      }
    }
    // reachability, cycles and depth
    if (typeof spec.root === 'string' && elements[spec.root]) {
      const seen = new Set();
      const stack = new Set();
      let cycle = false, tooDeep = false;
      const walk = (id, depth) => {
        if (depth > LIMITS.depth) { tooDeep = true; return; }
        if (stack.has(id)) { if (!cycle) add('error', 'cycle', `/elements/${id}`, `"${id}" contains itself through its children.`); cycle = true; return; }
        if (seen.has(id) || !isObj(elements[id])) return;
        seen.add(id); stack.add(id);
        for (const c of Array.isArray(elements[id].children) ? elements[id].children : []) if (typeof c === 'string') walk(c, depth + 1);
        stack.delete(id);
      };
      walk(spec.root, 0);
      if (tooDeep) add('error', 'too-deep', '/elements', `Elements nest more than ${LIMITS.depth} levels deep.`);
      const orphans = ids.filter((id) => !seen.has(id));
      if (orphans.length) add('warning', 'unreachable', '/elements', `Not reachable from the root, so not shown: ${orphans.slice(0, 8).join(', ')}${orphans.length > 8 ? '…' : ''}.`);
    }
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  }
  function checkExpressions(value, path, add, depth = 0) {
    if (depth > 30) return;
    if (Array.isArray(value)) { value.forEach((v, i) => checkExpressions(v, `${path}/${i}`, add, depth + 1)); return; }
    if (!isObj(value)) return;
    if ('$calc' in value) {
      try { parseFormula(String(value.$calc)); } catch (e) { add('error', 'invalid-formula', path, `$calc "${String(value.$calc).slice(0, 80)}": ${e.message}.`); }
    }
    for (const k of ['$state', '$bindState']) {
      if (k in value && (typeof value[k] !== 'string' || (value[k] !== '' && value[k][0] !== '/'))) add('error', 'invalid-pointer', path, `${k} must be a JSON Pointer like "/guests", not ${safeJson(value[k])}.`);
    }
    for (const [k, v] of Object.entries(value)) if (k !== '$calc') checkExpressions(v, `${path}/${k}`, add, depth + 1);
  }
  function checkAction(binding, path, add) {
    if (!isObj(binding) || typeof binding.action !== 'string') { add('error', 'invalid-action', path, 'An action is { "action": name, "params": {…} }.'); return; }
    const def = ACTIONS[binding.action];
    if (!def) { add('error', 'unknown-action', `${path}/action`, `Unknown action "${binding.action}"; use ${Object.keys(ACTIONS).join(', ')}.`); return; }
    const params = isObj(binding.params) ? binding.params : {};
    for (const r of def.required) if (params[r] === undefined) add('error', 'missing-param', `${path}/params/${r}`, `${binding.action} needs \`${r}\`.`);
    if ((binding.action === 'setState' || binding.action === 'toggle') && typeof params.path === 'string' && params.path[0] !== '/') add('error', 'invalid-pointer', `${path}/params/path`, `${binding.action} path must start with "/".`);
    checkExpressions(params, `${path}/params`, add);
  }
  function formatIssues(issues, { max = 20 } = {}) {
    if (!issues.length) return 'No issues.';
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity !== 'error');
    const lines = [];
    if (errors.length) lines.push(`${errors.length} error${errors.length === 1 ? '' : 's'} to fix (send small patches on the same title):`);
    for (const i of errors.slice(0, max)) lines.push(`- ${i.path || '(spec)'}: ${i.message}`);
    if (warnings.length) lines.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
    for (const i of warnings.slice(0, Math.max(0, max - errors.length))) lines.push(`- ${i.path || '(spec)'}: ${i.message}`);
    return lines.join('\n');
  }

  /* ---------- present: nested component trees ---------- */
  /** Converts a present() tree ({ _type, ...props, children? }) into a flat spec the renderer draws. */
  function treeToSpec(tree) {
    const elements = {};
    const issues = [];
    let n = 0;
    const visit = (node, path, depth) => {
      if (depth > LIMITS.depth) { issues.push({ severity: 'error', code: 'too-deep', path, message: 'The tree nests too deeply.' }); return null; }
      if (typeof node === 'string') node = { _type: 'Text', text: node };
      if (!isObj(node)) { issues.push({ severity: 'error', code: 'invalid-node', path, message: 'A node is an object { "_type": "Card", …props, "children": [ … ] } or a string.' }); return null; }
      const type = node._type ?? node.type;
      const id = `n${n++}`;
      if (n > LIMITS.elements) { issues.push({ severity: 'error', code: 'too-many-elements', path, message: `At most ${LIMITS.elements} nodes.` }); return null; }
      const { _type, type: _t, children, props: nestedProps, ...rest } = node;
      const props = { ...(isObj(nestedProps) ? nestedProps : {}), ...rest };
      const kids = [];
      if (Array.isArray(children)) children.forEach((c, i) => { const cid = visit(c, `${path}/children/${i}`, depth + 1); if (cid) kids.push(cid); });
      else if (children !== undefined) issues.push({ severity: 'error', code: 'invalid-children', path: `${path}/children`, message: '`children` must be an array of nodes.' });
      elements[id] = { type, props, ...(kids.length ? { children: kids } : {}) };
      return id;
    };
    const roots = Array.isArray(tree) ? tree : [tree];
    const ids = roots.map((r, i) => visit(r, Array.isArray(tree) ? `/${i}` : '', 0)).filter(Boolean);
    let root = ids[0] || '';
    if (ids.length > 1) { root = 'root'; elements.root = { type: 'Stack', props: { gap: 'md' }, children: ids }; }
    const spec = { root, elements, state: {} };
    const v = validateSpec(spec);
    // present() is display-only: interactive components and actions make no sense without state.
    for (const [id, el] of Object.entries(elements)) {
      if (CATALOG[el.type]?.group === 'interactive' && el.type !== 'Button') issues.push({ severity: 'warning', code: 'interactive-in-present', path: `/elements/${id}`, message: `${el.type} is interactive; use render_spec for UI with state.` });
    }
    return { spec, issues: [...issues, ...v.issues.map((i) => ({ ...i, path: i.path.replace(/^\/elements\/n(\d+)/, (m, k) => `node #${k}`) }))] };
  }

  /* ---------- edits (edit_widget) ---------- */
  /** Applies exact string replacements in order. All or nothing: any failing edit leaves the source unchanged. */
  function applyEdits(source, edits) {
    if (typeof source !== 'string') return { ok: false, error: 'There is no source to edit.' };
    if (!Array.isArray(edits) || !edits.length) return { ok: false, error: 'Pass `edits`: a list of { old_string, new_string }.' };
    let out = source;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] || {};
      const oldS = e.old_string ?? e.old ?? e.oldText;
      const newS = e.new_string ?? e.new ?? e.newText ?? '';
      const label = `Edit ${i + 1}`;
      if (typeof oldS !== 'string' || !oldS) return { ok: false, error: `${label}: old_string must be non-empty text copied exactly from the current code.`, index: i };
      if (typeof newS !== 'string') return { ok: false, error: `${label}: new_string must be text.`, index: i };
      if (oldS === newS) return { ok: false, error: `${label}: old_string and new_string are the same.`, index: i };
      const first = out.indexOf(oldS);
      if (first < 0) {
        const trimmed = oldS.trim();
        const hint = trimmed && trimmed !== oldS && out.includes(trimmed) ? ' It matches once leading/trailing whitespace is removed: copy the exact whitespace.' : ' Copy it exactly, including whitespace and quotes, from the current code.';
        return { ok: false, error: `${label}: old_string was not found.${hint}`, index: i };
      }
      let count = 0;
      for (let at = out.indexOf(oldS); at >= 0 && count < 3; at = out.indexOf(oldS, at + 1)) count++;
      if (count > 1) return { ok: false, error: `${label}: old_string matches ${count >= 3 ? '3 or more' : count} places. Include more surrounding text so it matches exactly one.`, index: i };
      out = out.slice(0, first) + newS + out.slice(first + oldS.length);
    }
    return { ok: true, source: out, changed: out !== source };
  }

  /* ---------- read_me guidance ---------- */
  const describeType = (t) => (Array.isArray(t) ? t.map((x) => `"${x}"`).join('|') : t);
  function catalogGuide() {
    const groups = {};
    for (const [name, d] of Object.entries(CATALOG)) (groups[d.group] ||= []).push([name, d]);
    const out = [];
    for (const [group, entries] of Object.entries(groups)) {
      out.push(`### ${group[0].toUpperCase()}${group.slice(1)}`);
      for (const [name, d] of entries) {
        const props = Object.entries(d.props).map(([k, p]) => `${k}${p.required ? '' : '?'}: ${describeType(p.type)}`).join('; ');
        out.push(`- **${name}** — ${d.description}${d.children ? ' Takes children.' : ''} Props: ${props || 'none'}.${d.events ? ` Events: ${d.events.join(', ')}.` : ''}`);
      }
    }
    return out.join('\n');
  }
  const SPEC_EXAMPLE = [
    '{"op":"add","path":"/root","value":"main"}',
    '{"op":"add","path":"/state","value":{"guests":4}}',
    '{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Biryani for a crowd"},"children":["guests","amounts"]}}',
    '{"op":"add","path":"/elements/guests","value":{"type":"Stepper","props":{"label":"Guests","value":{"$bindState":"/guests"},"min":1,"max":40}}}',
    '{"op":"add","path":"/elements/amounts","value":{"type":"Facts","props":{"items":[{"label":"Rice","value":{"$calc":"round(${/guests} * 0.12, 2) + \' kg\'"}},{"label":"Chicken","value":{"$calc":"round(${/guests} * 0.2, 2) + \' kg\'"}}]}}}',
  ].join('\n');
  const GUIDE = {
    spec: {
      summary: 'How to write render_spec UIs: format, components, expressions ($calc), actions, patches.',
      text: () => `# render_spec — declarative UI from the app's own components

Use render_spec for structured content the user scans or acts on: dashboards, comparisons, plans and itineraries, recipes that scale, budgets, checklists, forms and choices. The app draws it with its own components, themed for light and dark, and fitted to a 320 px phone.

## Format
A spec is flat: { "root": id, "elements": { id: element }, "state": { … } }. An element is { "type", "props", "children": [ids], "visible"?, "repeat"?, "on"? }. Children are ids, never nested elements. Ids are short kebab-case names ("total-row").

Pass it one of two ways (always with a snake_case \`title\` that names this UI in the conversation):
1. \`patches\`: RFC 6902 JSON Patch operations as JSONL, one object per line: root first, then state, then each element whole, parents before children. Preferred.
2. \`spec\`: the complete object.
To change a UI you already rendered, call render_spec again with the SAME title and only the patches that change it (replace/remove/add on its paths). The newest version shows at the bottom of the chat and keeps what the user typed. Escape "/" in keys as ~1 and "~" as ~0; append to arrays with "-".

## Expressions (any prop or action param)
- {"$state":"/path"} reads state. {"$bindState":"/path"} reads it AND lets an input write it back.
- {"$template":"Hi \${/name}"} fills \${…} placeholders.
- {"$cond": condition, "$then": a, "$else": b} picks a value.
- {"$calc":"round(\${/guests} * 0.12, 2) + ' kg'"} computes live: numbers, 'text', \${/path}, + - * / % **, == != < <= > >=, && || !, a ? b : c. Functions: ${Object.keys(FUNCS).join(', ')}. sum(list, '/price') and avg(list, '/field') read a field of each item; currency(x, 'BDT'), number(x, 2), percent(0.25), plural(n, 'item', 'items'), time(minutes), pmt(rate, periods, principal). A formula that cannot compute shows nothing. No other code runs.
- Inside repeat: {"$item":"/field"}, {"$bindItem":"/field"}, {"$index":true}, \${$item/field}.

## Visibility and repetition
- "visible": true/false, {"$state":"/open"}, {"$state":"/count","gt":0} (eq, neq, gt, gte, lt, lte), {"$calc":"\${/n} > 2"}, {"not":…}, {"$or":[…]}, {"$and":[…]}.
- "repeat": {"path":"/items","key":"id"} draws the element's children once per item of that state list.

## Actions ("on": { event: action or [actions] })
${Object.entries(ACTIONS).map(([k, a]) => `- ${k} — params {${Object.entries(a.params).map(([p, t]) => `${p}${a.required.includes(p) ? '' : '?'}: ${t}`).join(', ')}}. ${a.description}`).join('\n')}
Remove a repeated item: {"action":"setState","params":{"path":"/items","value":{"$calc":"without(\${/items}, \${$index})"}}}.

## Components (use only these)
${catalogGuide()}

## Rules
- Lead with what matters (a Header or the key Stat), then details. Keep it scannable: short labels, no paragraphs the user must read.
- Every number that follows an input is a $calc; never hard-code values the user can change.
- For a count the user adjusts (guests, servings, nights), use a Stepper bound to state.
- Phones are 320 px wide: Grid/Row wrap by themselves; keep Table columns to 4-5; long text wraps.
- Images and maps load from https: (Wikimedia, OpenStreetMap). Get real image URLs from search_images; never invent URLs.
- Don't repeat in prose what the UI shows; one short sentence around it is enough.
- The result lists validation issues. Fix every error with small patches on the same title.

## Example (patches)
${SPEC_EXAMPLE}`,
    },
    present: {
      summary: 'present: show a display-only component tree (e.g. a Weather card) without state.',
      text: () => `# present — display-only component trees

present draws a nested tree right away: { "_type": "Card", "title": "…", "children": [ { "_type": "Text", "text": "…" } ] }. Props sit beside _type. A string child is a Text. It uses the same components as render_spec (see the spec module) but has no state, $calc or inputs; use render_spec when the user changes anything.

Weather: call get_weather (it returns an id), then present {"_type":"Weather","id":"<that id>"}. Mix freely: [{"_type":"Weather","id":"wx-…"},{"_type":"Alert","tone":"warning","text":"Carry an umbrella after 3 PM"}].
Places: geocode_location, then {"_type":"Map","latitude":…,"longitude":…,"label":"…"}.
Images: search_images, then {"_type":"Carousel","items":[{"image":url,"title":…,"href":page_url}]} with the URLs it returned, and credit the author/licence in a caption.`,
    },
    widgets: {
      summary: 'show_widget: the quick built-in widget types (options, form, todo, table, chart, stats, confirm, links, gallery, steps, html).',
      text: () => `# show_widget — quick built-in widgets

One call, one card. Types: options (question + options; the user's pick comes back), form (fields → values come back), confirm (yes/no), todo (checklist), table (columns + rows), chart (bar/line with labels + series), stats (big numbers), links, gallery (images), steps, html (custom code; same rules as show_html).
Pick show_widget for a single simple card or a question you need answered (options/form/confirm wait for the user). Pick render_spec for anything with several parts, live calculations or layout. Pick show_html only when no component can draw it (a game, a custom visualisation, a canvas).`,
    },
    html: {
      summary: 'show_html / html widgets: sandbox rules, theme variables, the window.aui bridge, phone layout.',
      text: () => `# show_html — custom HTML/CSS/JS widgets

The code runs in a sealed sandbox: scripts run, but there is NO network (no CDNs, fetch, fonts or remote images; inline everything; images only as data: URLs or inline SVG). It cannot read the app.
- Size: it must fit a 320 px wide phone with no sideways scrolling: use max-width:100%, flex-wrap, % or fr widths, min-width:0 on flex children, overflow-wrap:anywhere. The frame grows to the content height (max 640 px).
- Theme: use the CSS variables --aui-bg, --aui-fg, --aui-muted, --aui-border, --aui-accent, --aui-card. They follow the app's light/dark theme live; <html> gets class "dark" in dark mode and an "aui-theme" event fires on change. Never hard-code white/black backgrounds. Body background is transparent.
- Bridge: window.aui.send(text) sends a chat message (only after a user tap), window.aui.result(value) sends structured data back, window.aui.theme is "light" or "dark", window.aui.resize() re-measures.
- Accessibility: real <button>/<label> elements, visible focus, 44 px tap targets, text contrast that works in both themes.
- Before showing complex code, check it with preview_widget (errors, blank output, height, overflow). To change a shown widget, use edit_widget with exact replacements instead of resending it.`,
    },
    charts: {
      summary: 'Choosing and shaping charts: Chart component data, multi-series, and SVG charts in HTML.',
      text: () => `# Charts

- Trend over time → line or area; compare categories → bar; parts of a whole (≤ 6 parts) → pie or donut; one number → Stat.
- render_spec Chart: single series {"type":"bar","data":[{"label":"Jan","value":12}]} or multi {"type":"line","labels":["Jan","Feb"],"series":[{"name":"Rain","values":[3,5]}]} (≤ 4 series, ≤ 60 points). Values may be $calc so the chart follows inputs. Add "unit".
- Colours come from the theme (4 colour-blind-safe series colours); don't pass colours.
- In show_html, draw charts as inline SVG with viewBox and width:100% so they scale; label axes; use currentColor / --aui-* variables.`,
    },
    theme: {
      summary: 'Theme: light/dark, set_theme, and theme-aware styling.',
      text: () => `# Theme

The app has light, dark and system (follow the phone) themes. set_theme asks the user before switching; call it only when the user asks to change the look ("dark mode please"). Every render_spec/present component and the show_html variables follow the theme automatically, so never pass colours for light vs dark.`,
    },
    editing: {
      summary: 'edit_widget and preview_widget: change shown UI without resending it; check code before showing it.',
      text: () => `# Editing and previewing

- edit_widget {title, edits:[{old_string,new_string}]} changes a widget already shown (show_html, an html show_widget, render_spec or present) by its title. old_string must match exactly one place in the CURRENT code (copy it with whitespace); edits apply in order, all or nothing. For render_spec the code is the spec as pretty JSON (2-space indent); small JSON patches on the same title are usually easier.
- The edited version is drawn at the bottom of the chat; the older card says it was updated.
- preview_widget {html | spec | title, width?, appearance?} renders offscreen and reports errors, blocked network requests, blank output, height, sideways overflow and the visible text, without showing anything to the user. Use it for any non-trivial show_html, then show it.`,
    },
  };
  const MODULE_NAMES = Object.keys(GUIDE);
  function readMe(modules) {
    const wanted = Array.isArray(modules) && modules.length ? modules : typeof modules === 'string' && modules ? [modules] : null;
    if (!wanted) {
      return `Guidance modules — call read_me again with the ones you need:\n${MODULE_NAMES.map((m) => `- ${m}: ${GUIDE[m].summary}`).join('\n')}`;
    }
    const unknown = wanted.filter((m) => !GUIDE[m]);
    const parts = wanted.filter((m) => GUIDE[m]).map((m) => GUIDE[m].text());
    if (unknown.length) parts.push(`Unknown module${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Available: ${MODULE_NAMES.join(', ')}.`);
    return parts.join('\n\n---\n\n');
  }

  /* ---------- weather codes (WMO), shared by the Weather card ---------- */
  const WMO = {
    0: ['Clear sky', 'sun'], 1: ['Mainly clear', 'sun'], 2: ['Partly cloudy', 'cloud-sun'], 3: ['Overcast', 'cloud'],
    45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'], 51: ['Light drizzle', 'drizzle'], 53: ['Drizzle', 'drizzle'], 55: ['Heavy drizzle', 'drizzle'],
    56: ['Freezing drizzle', 'drizzle'], 57: ['Freezing drizzle', 'drizzle'], 61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
    66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'], 71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
    80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Violent showers', 'rain'], 85: ['Snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
    95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm with hail', 'storm'], 99: ['Thunderstorm with heavy hail', 'storm'],
  };
  const weatherCode = (code) => { const w = WMO[Number(code)]; return w ? { label: w[0], icon: w[1] } : { label: 'Unknown', icon: 'cloud' }; };

  return {
    LIMITS, CATALOG, ACTIONS, COMPONENT_NAMES, MODULE_NAMES, FUNCS,
    parsePointer, toPointer, readPointer, getAt, setAt, removeAt, applyOperation, applyPatches, emptySpec, clone,
    parseFormula, evalFormula, resolve, bindingPath, checkCondition, fillTemplate, isExpr, truthy,
    validateSpec, formatIssues, treeToSpec, applyEdits, readMe, catalogGuide, weatherCode,
  };
})();
