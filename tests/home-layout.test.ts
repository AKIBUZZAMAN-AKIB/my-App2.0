import { describe, expect, it } from 'vitest';
import { addWidget, defaultHomeLayout, fitSize, moveWidget, parseHomeLayout, replaceWidgets, updateWidget } from '../bridge/home-layout';

describe('home layout model', () => {
  it('falls back to the default layout for missing or broken data', () => {
    expect(parseHomeLayout(null).widgets.length).toBeGreaterThan(3);
    expect(parseHomeLayout('{oops').updatedBy).toBe('default');
  });

  it('drops unknown widgets and fixes sizes when parsing', () => {
    const layout = parseHomeLayout(JSON.stringify({ widgets: [{ id: 'a', type: 'battery', size: 'l' }, { id: 'b', type: 'ghost' }] }));
    expect(layout.widgets).toEqual([{ id: 'a', type: 'battery', size: 's', config: {} }]);
  });

  it('maps long size names and keeps allowed sizes', () => {
    expect(fitSize('clock', 'large')).toBe('l');
    expect(fitSize('agent', 's')).toBe('m');
  });

  it('adds at a position, merges config and moves', () => {
    let layout = defaultHomeLayout(1);
    const added = addWidget(layout, { type: 'notes', config: { text: 'hi' }, position: 1 }, 2);
    expect(added.layout.widgets[1].id).toBe(added.widget.id);
    layout = updateWidget(added.layout, { id: added.widget.id, config: { items: ['x'] } }, 3).layout;
    expect(layout.widgets[1].config).toEqual({ text: 'hi', items: ['x'] });
    layout = moveWidget(layout, added.widget.id, 0, 4).layout;
    expect(layout.widgets[0].id).toBe(added.widget.id);
  });

  it('gives duplicate ids a fresh id on replace', () => {
    const layout = replaceWidgets(defaultHomeLayout(1), [{ id: 'x', type: 'clock' }, { id: 'x', type: 'clock' }], 2);
    expect(new Set(layout.widgets.map((w) => w.id)).size).toBe(2);
  });
});
