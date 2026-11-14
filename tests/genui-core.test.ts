import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const src = readFileSync(join(__dirname, '..', 'tools', 'agent-html-src', '50-genui-core.js'), 'utf8');
const context: any = { Intl, JSON, Math, Number, String, Object, Array, Set, Map, Error };
vm.createContext(context);
vm.runInContext(`${src}\nthis.GenUICore = GenUICore;`, context);
const G: any = context.GenUICore;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('JSON Pointer and JSON Patch', () => {
  it('reads and escapes pointers', () => {
    expect(G.readPointer({ a: { 'b/c': [1, { d: 2 }] } }, '/a/b~1c/1/d')).toBe(2);
    expect(G.toPointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
    expect(G.readPointer({ a: 1 }, '/__proto__')).toBeUndefined();
  });

  it('applies a JSONL stream in order, parents before children', () => {
    const lines = [
      '{"op":"add","path":"/root","value":"main"}',
      '{"op":"add","path":"/state","value":{"items":[1,2]}}',
      '{"op":"add","path":"/elements/main","value":{"type":"Stack","children":[]}}',
      '{"op":"add","path":"/elements/main/children/-","value":"t"}',
      '{"op":"add","path":"/elements/t","value":{"type":"Text","props":{"text":"hi"}}}',
      '{"op":"add","path":"/state/items/1","value":9}',
      '{"op":"remove","path":"/state/items/0"}',
      '{"op":"replace","path":"/elements/t/props/text","value":"hello"}',
      '{"op":"copy","from":"/elements/t","path":"/elements/t2"}',
      '{"op":"move","from":"/elements/t2","path":"/elements/t3"}',
      '{"op":"test","path":"/root","value":"main"}',
    ].join('\n');
    const { spec, errors } = G.applyPatches(null, lines);
    expect(errors).toEqual([]);
    expect(plain(spec.state.items)).toEqual([9, 2]);
    expect(spec.elements.t.props.text).toBe('hello');
    expect(spec.elements.t2).toBeUndefined();
    expect(spec.elements.t3.type).toBe('Text');
    expect(plain(spec.elements.main.children)).toEqual(['t']);
  });

  it('skips bad lines, reports them by line number, and keeps applying the rest', () => {
    const { spec, errors } = G.applyPatches(null, '{"op":"add","path":"/root","value":"a"}\nnot json\n{"op":"remove","path":"/nope"}\n{"op":"jump","path":"/x"}\n{"op":"add","path":"/state/n","value":3}');
    expect(spec.root).toBe('a');
    expect(spec.state.n).toBe(3);
    expect(errors.map((e: any) => e.line)).toEqual([2, 3, 4]);
    expect(errors[2].message).toMatch(/unknown op "jump"/);
  });

  it('accepts a JSON array and ```fenced``` text, and refuses prototype keys', () => {
    expect(G.applyPatches(null, '```json\n[{"op":"add","path":"/root","value":"r"}]\n```').spec.root).toBe('r');
    const bad = G.applyPatches(null, [{ op: 'add', path: '/state/__proto__/x', value: 1 }]);
    expect(bad.errors[0].message).toMatch(/cannot be used as a key/);
    expect(({} as any).x).toBeUndefined();
  });

  it('does not mutate the spec it starts from', () => {
    const base = { root: 'a', elements: {}, state: { n: 1 } };
    G.applyPatches(base, [{ op: 'replace', path: '/state/n', value: 2 }]);
    expect(base.state.n).toBe(1);
  });
});

describe('$calc formulas', () => {
  const ctx = { state: { guests: 6, items: [{ price: 10, qty: 2 }, { price: 5.5, qty: 1 }], name: 'Akib', rate: 0.01 } };
  it('computes arithmetic with precedence, references and text', () => {
    expect(G.evalFormula('${/guests} * 0.12 + 1', ctx)).toBeCloseTo(1.72);
    expect(G.evalFormula('2 + 3 * 4 ** 2 / 8', ctx)).toBe(8);
    expect(G.evalFormula('-(${/guests} - 10)', ctx)).toBe(4);
    expect(G.evalFormula("round(${/guests} * 0.125, 2) + ' kg'", ctx)).toBe('0.75 kg');
    expect(G.evalFormula("'Hi ' + ${/name}", ctx)).toBe('Hi Akib');
    expect(G.evalFormula('${/guests} > 4 ? "big" : "small"', ctx)).toBe('big');
    expect(G.evalFormula('${/guests} >= 6 && !(${/guests} == 7)', ctx)).toBe(true);
  });
  it('aggregates lists and formats numbers', () => {
    expect(G.evalFormula("sum(${/items}, '/price')", ctx)).toBe(15.5);
    expect(G.evalFormula("avg(${/items}, '/qty')", ctx)).toBe(1.5);
    expect(G.evalFormula('count(${/items})', ctx)).toBe(2);
    expect(G.evalFormula('max(3, ${/guests}, 1)', ctx)).toBe(6);
    expect(G.evalFormula("currency(1234.5, 'USD')", ctx)).toBe('$1,234.50');
    expect(G.evalFormula('percent(0.256, 1)', ctx)).toBe('25.6%');
    expect(G.evalFormula("plural(${/guests}, 'guest', 'guests')", ctx)).toBe('6 guests');
    expect(G.evalFormula('time(13 * 60 + 5)', ctx)).toBe('1:05 PM');
    expect(G.evalFormula('round(pmt(${/rate}, 12, 1200), 2)', ctx)).toBeCloseTo(106.62, 2);
    expect(plain(G.evalFormula('without(${/items}, 0)', ctx))).toEqual([{ price: 5.5, qty: 1 }]);
  });
  it('reads repeat items and the index', () => {
    expect(G.evalFormula('${$item/price} * ${$item/qty} + ${$index}', { state: {}, item: { price: 3, qty: 2 }, index: 1 })).toBe(7);
  });
  it('returns null instead of throwing for bad input, division by zero and unknown paths', () => {
    expect(G.evalFormula('1 / 0', ctx)).toBeNull();
    expect(G.evalFormula('${/missing} * 2', ctx)).toBeNull();
    expect(G.evalFormula('1 +', ctx)).toBeNull();
  });
  it('cannot run code: no identifiers, members, calls of unknown functions or eval', () => {
    for (const bad of ['constructor', 'this.x', 'alert(1)', 'globalThis', '${/a}.constructor', '[1,2]', 'x = 1', 'eval("1")', 'Function("return 1")()']) {
      expect(() => G.parseFormula(bad)).toThrow();
    }
    expect(() => G.parseFormula('nope(1)')).toThrow(/unknown function "nope"/);
    expect(() => G.parseFormula('round()')).toThrow(/takes 1-2 arguments/);
    expect(() => G.parseFormula('${guests}')).toThrow(/not a reference/);
  });
  it('bounds work on huge formulas', () => {
    expect(() => G.parseFormula('1+'.repeat(1500) + '1')).toThrow(/at most/);
  });
});

describe('expressions and conditions', () => {
  const ctx = { state: { open: true, n: 3, user: { name: 'Akib' }, tab: 1 } };
  it('resolves $state, $bindState, $template, $cond and $calc inside props', () => {
    const out = G.resolve({ a: { $state: '/n' }, b: { $template: 'Hi ${/user/name}, ${/n} left' }, c: { $cond: { $state: '/open' }, $then: 'yes', $else: 'no' }, d: [{ $calc: '${/n} * 2' }], e: { $bindState: '/tab' }, f: { $state: '/none', default: 'x' } }, ctx);
    expect(plain(out)).toEqual({ a: 3, b: 'Hi Akib, 3 left', c: 'yes', d: [6], e: 1, f: 'x' });
  });
  it('evaluates visibility conditions', () => {
    expect(G.checkCondition({ $state: '/n', gt: 2 }, ctx)).toBe(true);
    expect(G.checkCondition({ $state: '/n', eq: '3' }, ctx)).toBe(true);
    expect(G.checkCondition({ not: { $state: '/open' } }, ctx)).toBe(false);
    expect(G.checkCondition({ $or: [false, { $state: '/open' }] }, ctx)).toBe(true);
    expect(G.checkCondition([{ $state: '/open' }, { $calc: '${/n} < 2' }], ctx)).toBe(false);
    expect(G.checkCondition({ $state: '/n', gte: 3, lt: 4 }, ctx)).toBe(true);
  });
  it('finds binding paths, including inside a repeat', () => {
    expect(G.bindingPath({ $bindState: '/a' }, {})).toBe('/a');
    expect(G.bindingPath({ $bindItem: 'done' }, { itemPath: '/todos/2' })).toBe('/todos/2/done');
  });
});

describe('spec validation', () => {
  const good = {
    root: 'main',
    state: { guests: 4, items: [] },
    elements: {
      main: { type: 'Card', props: { title: 'Plan' }, children: ['g', 'f', 'b'] },
      g: { type: 'Stepper', props: { label: 'Guests', value: { $bindState: '/guests' } } },
      f: { type: 'Facts', props: { items: [{ label: 'Rice', value: { $calc: '${/guests} * 0.1' } }] } },
      b: { type: 'Button', props: { label: 'Add' }, on: { press: { action: 'setState', params: { path: '/items/-', value: 1 } } } },
    },
  };
  it('accepts a correct spec', () => {
    expect(G.validateSpec(good).ok).toBe(true);
  });
  it('reports each kind of mistake with a path and a fix', () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.elements.main.children.push('ghost', { nested: true });
    bad.elements.x = { type: 'Column', props: {} };
    bad.elements.f.props.items = 'no';
    bad.elements.g.props.zoom = 3;
    bad.elements.t = { type: 'Text', props: { text: { $calc: '1 +' } }, children: ['g'] };
    bad.elements.b.on = { tap: { action: 'launch' } };
    bad.elements.h = { type: 'Header', props: { tone: 'pink' } };
    const { ok, issues } = G.validateSpec(bad);
    expect(ok).toBe(false);
    const codes = issues.map((i: any) => i.code);
    for (const code of ['missing-child', 'invalid-child', 'unknown-type', 'invalid-type', 'unknown-prop', 'invalid-formula', 'no-children', 'unknown-event', 'unknown-action', 'missing-prop', 'invalid-enum', 'unreachable']) expect(codes).toContain(code);
    expect(issues.find((i: any) => i.code === 'unknown-type').message).toMatch(/Use "Stack"/);
    expect(G.formatIssues(issues)).toMatch(/errors? to fix/);
  });
  it('catches missing roots and cycles', () => {
    expect(G.validateSpec({ elements: {} }).issues[0].code).toBe('missing-root');
    const cyc = G.validateSpec({ root: 'a', elements: { a: { type: 'Stack', children: ['b'] }, b: { type: 'Stack', children: ['a'] } } });
    expect(cyc.issues.map((i: any) => i.code)).toContain('cycle');
  });
  it('lists the catalog and the actions', () => {
    for (const name of ['Header', 'Card', 'Facts', 'Table', 'Chart', 'Tabs', 'Timeline', 'Map', 'Steps', 'Form', 'Carousel', 'Citations', 'Weather', 'Stepper']) expect(G.COMPONENT_NAMES).toContain(name);
    expect(Object.keys(G.ACTIONS)).toEqual(['setState', 'sendMessage', 'copyText', 'openUrl', 'toggle']);
  });
});

describe('present trees', () => {
  it('flattens a nested tree into a valid spec', () => {
    const { spec, issues } = G.treeToSpec({ _type: 'Card', title: 'Hi', children: [{ _type: 'Text', text: 'one' }, 'two', { _type: 'Weather', id: 'wx-1' }] });
    expect(issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    expect(spec.elements[spec.root].type).toBe('Card');
    expect(spec.elements[spec.root].children).toHaveLength(3);
    expect(spec.elements.n2.props.text).toBe('two');
  });
  it('wraps several roots in a Stack and reports unknown node types', () => {
    const { spec, issues } = G.treeToSpec([{ _type: 'Badge', text: 'a' }, { _type: 'Nope' }]);
    expect(spec.elements.root.type).toBe('Stack');
    expect(issues.some((i: any) => i.code === 'unknown-type')).toBe(true);
  });
});

describe('edit_widget string edits', () => {
  const code = '<div class="a">Hello</div>\n<div class="b">World</div>';
  it('applies exact replacements in order', () => {
    const r = G.applyEdits(code, [{ old_string: 'Hello', new_string: 'Hi' }, { old_string: 'Hi</div>', new_string: 'Hi!</div>' }]);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('<div class="a">Hi!</div>\n<div class="b">World</div>');
  });
  it('is all or nothing, and explains not-found and ambiguous matches', () => {
    expect(G.applyEdits(code, [{ old_string: 'Hello', new_string: 'Hi' }, { old_string: 'Nope', new_string: 'x' }])).toMatchObject({ ok: false, index: 1 });
    expect(G.applyEdits(code, [{ old_string: '<div', new_string: '<p' }]).error).toMatch(/matches 2 places/);
    expect(G.applyEdits(code, [{ old_string: ' Hello ', new_string: 'x' }]).error).toMatch(/not found/);
    expect(G.applyEdits(code, [{ old_string: '  World', new_string: 'x' }]).error).toMatch(/whitespace/);
    expect(G.applyEdits(code, []).ok).toBe(false);
    expect(G.applyEdits(code, [{ old_string: 'a', new_string: 'a' }]).error).toMatch(/the same/);
  });
});

describe('read_me guidance', () => {
  it('lists modules without arguments and returns the requested ones', () => {
    expect(G.readMe()).toMatch(/spec:.*\n.*present:/s);
    const spec = G.readMe(['spec']);
    expect(spec).toMatch(/render_spec/);
    for (const name of G.COMPONENT_NAMES) expect(spec).toContain(`**${name}**`);
    expect(spec).toContain('$calc');
    expect(G.readMe(['html', 'nope'])).toMatch(/--aui-bg[\s\S]*Unknown module: nope/);
  });
  it('the example in the guide is a valid spec', () => {
    const example = G.readMe(['spec']).split('## Example (patches)\n')[1];
    const { spec, errors } = G.applyPatches(null, example);
    expect(errors).toEqual([]);
    expect(G.validateSpec(spec).ok).toBe(true);
    expect(G.evalFormula(spec.elements.amounts.props.items[0].value.$calc, { state: spec.state })).toBe('0.48 kg');
  });
  it('maps WMO weather codes', () => {
    expect(plain(G.weatherCode(61))).toEqual({ label: 'Light rain', icon: 'rain' });
    expect(G.weatherCode(1234).label).toBe('Unknown');
  });
});
