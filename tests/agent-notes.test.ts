import { afterEach, describe, expect, it } from 'vitest';

import { createDeviceToolsTransport, defaultDeviceToolDeps, DEVICE_SERVER_NAME, NOTES_MAX, type DeviceToolDeps } from '../bridge/device-tools';
import { McpClient } from '../bridge/mcp-client';

/** Just enough of SQLite for the one notes row. */
function memorySqlite() {
  let row: { data: string; updated_at: number } | null = null;
  return {
    get row() { return row; },
    set row(v) { row = v; },
    async query(_db: string, sql: string) {
      if (/FROM scratchpad_notes/.test(sql)) return { values: row ? [{ ...row }] : [] } as any;
      return { values: [] } as any;
    },
    async run(_db: string, sql: string, values: any[] = []) {
      if (/INSERT OR REPLACE INTO scratchpad_notes/.test(sql)) row = { data: values[0], updated_at: values[1] };
      else if (/DELETE FROM scratchpad_notes/.test(sql)) row = null;
      return { changes: 1 } as any;
    },
  };
}

let t = 1_763_100_000_000;
function client(sqlite: ReturnType<typeof memorySqlite>) {
  const deps = { ...defaultDeviceToolDeps(), sqlite, now: () => (t += 1000) } as unknown as DeviceToolDeps;
  return new McpClient(DEVICE_SERVER_NAME, createDeviceToolsTransport(deps, { features: {} }), { protocolVersion: 'auto' });
}
const text = (r: any) => String(r?.content?.find((b: any) => b.type === 'text')?.text ?? '');

// The bridge announces changes to the page with a DOM event; give node a minimal window.
const events: any[] = [];
const g = globalThis as any;
g.window ??= g;
g.window.dispatchEvent ??= (e: any) => { events.push(e); return true; };
g.CustomEvent ??= class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } };
afterEach(() => { events.length = 0; });

describe('working notes', () => {
  it('update_notes saves, returns the notes, and announces them to the page', async () => {
    const db = memorySqlite();
    const c = client(db);
    const r: any = await c.callTool('update_notes', { notes: 'Plan:\n1. geocode\n2. weather' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('Saved your notes (27 chars). Current notes:\nPlan:\n1. geocode\n2. weather');
    expect(db.row?.data).toBe('Plan:\n1. geocode\n2. weather');
    const ev = events.find((e) => e.type === 'nativekit:agent-notes');
    expect(ev?.detail).toMatchObject({ notes: 'Plan:\n1. geocode\n2. weather', by: 'agent' });
  });

  it('append adds a line; read_notes returns what the user edited', async () => {
    const db = memorySqlite();
    const c = client(db);
    await c.callTool('update_notes', { notes: 'a' });
    const r: any = await c.callTool('update_notes', { notes: 'b', append: true });
    expect(text(r)).toMatch(/^Appended to your notes \(3 chars\)\. Current notes:\na\nb$/);
    db.row = { data: 'a\nb\nuser added this', updated_at: t + 50 }; // the Notes card writes the same row
    const read: any = await c.callTool('read_notes', {});
    expect(text(read)).toMatch(/^Your notes \(19 chars, last changed .*Z\):\na\nb\nuser added this$/);
    expect(read.structuredContent).toMatchObject({ notes: 'a\nb\nuser added this', chars: 19 });
  });

  it('read_notes on empty notes, clear_scratchpad empties them and tells the page', async () => {
    const db = memorySqlite();
    const c = client(db);
    expect(text(await c.callTool('read_notes', {}))).toBe('Your notes are empty.');
    await c.callTool('update_notes', { notes: 'x' });
    events.length = 0;
    await c.callTool('clear_scratchpad', {});
    expect(db.row).toBeNull();
    expect(events.find((e) => e.type === 'nativekit:agent-notes')?.detail).toMatchObject({ notes: '' });
  });

  it('refuses empty or oversized notes and appends that would overflow', async () => {
    const db = memorySqlite();
    const c = client(db);
    expect(text(await c.callTool('update_notes', { notes: '  ' }))).toMatch(/clear_scratchpad/);
    expect(text(await c.callTool('update_notes', { notes: 'x'.repeat(NOTES_MAX + 1) }))).toMatch(/limit is 10000/);
    await c.callTool('update_notes', { notes: 'y'.repeat(NOTES_MAX - 2) });
    const r: any = await c.callTool('update_notes', { notes: 'zzz', append: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/would be 10002 chars/);
    expect(db.row?.data.length).toBe(NOTES_MAX - 2);
  });
});

