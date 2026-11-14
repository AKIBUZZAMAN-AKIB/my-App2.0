import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';

import { createDeviceToolsTransport, deviceServerConfig, DEVICE_SERVER_NAME, FOLDER_CHANGE_TOOLS, FOLDER_READ_TOOLS, type DeviceToolDeps } from '../bridge/device-tools';
import {
  extractDocumentText, folderApiFromPlugin, folderErrorText, formatBytes, looksBinary, normalizeFolderPath, resolveFolder, wholeUtf8Length,
  FOLDER_PLUGIN_METHODS, type FolderApi, type FolderEntry, type FolderGrant,
} from '../bridge/folder-access';
import { cancelMcpToolCall, connectMcpServers, MCP_REQUEST_CANCELLED, McpClient, namespacedToolName, runningMcpToolCalls, type AgentLike } from '../bridge/mcp-client';

const textOf = (r: any): string => r?.content?.find((b: any) => b.type === 'text')?.text ?? '';
const b64 = (s: string | Uint8Array) => Buffer.from(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64');

class Fail extends Error { constructor(public code: string, message: string) { super(message); } }

/**
 * In-memory stand-in for the native folder methods, following the same
 * contract as FolderAccess.java / FolderAccess.swift: paths relative to the
 * grant, coded errors, refusals for read-only grants.
 */
function fakeFolders() {
  const grants: FolderGrant[] = [
    { id: 'f1', name: 'Documents', mode: 'readwrite', canWrite: true, available: true, location: 'Internal storage \u203a Documents' },
    { id: 'f2', name: 'Photos', mode: 'read', canWrite: true, available: true },
  ];
  const trees: Record<string, Map<string, Uint8Array | 'dir'>> = { f1: new Map(), f2: new Map() };
  const workspace = new Map<string, Uint8Array>();
  const calls: Array<{ method: string; args: any }> = [];
  const put = (id: string, path: string, data: string | Uint8Array) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) trees[id].set(parts.slice(0, i).join('/'), 'dir');
    trees[id].set(path, typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : data);
  };
  const grant = (id: string, write = false) => {
    const g = grants.find((x) => x.id === id);
    if (!g || g.available === false) throw new Fail('REVOKED', 'Android no longer grants access to this folder');
    if (write && g.mode !== 'readwrite') throw new Fail('READ_ONLY', `"${g.name}" is read-only`);
    return trees[id];
  };
  const check = (p: string) => { if (p.split('/').some((s) => s === '..' || s === '.')) throw new Fail('BAD_PATH', 'bad'); return p; };
  const entry = (path: string, v: Uint8Array | 'dir', withPath = false): FolderEntry => ({
    name: path.split('/').pop()!, ...(withPath ? { path } : {}), type: v === 'dir' ? 'directory' : 'file', ...(v === 'dir' ? {} : { size: v.length }), modified: 1_763_100_000_000,
  });
  const kids = (t: Map<string, Uint8Array | 'dir'>, dir: string) => [...t.entries()].filter(([k]) => (dir ? k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/') : !k.includes('/')));
  const api: FolderApi = {
    async list() { calls.push({ method: 'list', args: {} }); return { folders: grants.map((g) => ({ ...g })) }; },
    async listDir({ id, path, limit }) {
      const t = grant(id); check(path);
      if (path && t.get(path) === undefined) throw new Fail('NOT_FOUND', 'missing');
      const k = kids(t, path);
      return { entries: k.slice(0, limit).map(([p, v]) => entry(p, v)), truncated: k.length > (limit ?? 200) };
    },
    async stat({ id, path }) {
      const t = grant(id); check(path);
      const v = path ? t.get(path) : 'dir';
      return v === undefined ? { exists: false, name: '', type: 'file' } : { ...entry(path || 'root', v), exists: true, mime: path.endsWith('.png') ? 'image/png' : undefined };
    },
    async read({ id, path, offset, length }) {
      calls.push({ method: 'read', args: { id, path, offset, length } });
      const v = grant(id).get(check(path));
      if (v === undefined) throw new Fail('NOT_FOUND', 'missing');
      if (v === 'dir') throw new Fail('NOT_A_FILE', 'folder');
      const slice = v.subarray(offset, offset + length);
      return { data: b64(slice), size: v.length, bytesRead: slice.length, eof: offset + slice.length >= v.length };
    },
    async write({ id, path, data, overwrite }) {
      calls.push({ method: 'write', args: { id, path, overwrite } });
      const t = grant(id, true); check(path);
      const existed = t.has(path);
      if (existed && !overwrite) throw new Fail('EXISTS', `"${path}" already exists`);
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      put(id, path, bytes);
      return { size: bytes.length, created: !existed };
    },
    async mkdir({ id, path }) { const t = grant(id, true); const had = t.has(path); t.set(check(path), 'dir'); return { created: !had }; },
    async remove({ id, path, recursive }) {
      calls.push({ method: 'remove', args: { id, path, recursive } });
      const t = grant(id, true);
      if (!t.has(check(path))) throw new Fail('NOT_FOUND', 'missing');
      if (t.get(path) === 'dir' && kids(t, path).length && !recursive) throw new Fail('NOT_EMPTY', 'not empty');
      for (const k of [...t.keys()]) if (k === path || k.startsWith(`${path}/`)) t.delete(k);
      return { deleted: true };
    },
    async move({ id, path, to, overwrite }) {
      const t = grant(id, true);
      const v = t.get(check(path));
      if (v === undefined) throw new Fail('NOT_FOUND', 'missing');
      if (t.has(check(to)) && !overwrite) throw new Fail('EXISTS', 'exists');
      t.delete(path);
      put(id, to, v === 'dir' ? new Uint8Array() : v);
      return { path: to };
    },
    async copyToWorkspace({ id, path, dest, maxBytes }) {
      calls.push({ method: 'copyToWorkspace', args: { id, path, dest, maxBytes } });
      const v = grant(id).get(check(path));
      if (!(v instanceof Uint8Array)) throw new Fail('NOT_FOUND', 'missing');
      workspace.set(dest, v);
      return { bytes: v.length };
    },
    async copyFromWorkspace({ id, src, path, overwrite }) {
      calls.push({ method: 'copyFromWorkspace', args: { id, src, path, overwrite } });
      grant(id, true);
      const v = workspace.get(src);
      if (!v) throw new Fail('NOT_FOUND', 'missing');
      put(id, check(path), v);
      return { bytes: v.length };
    },
    async find({ id, path, query, limit }) {
      const t = grant(id);
      const q = query.toLowerCase();
      const all = [...t.entries()].filter(([k, v]) => (!path || k.startsWith(`${path}/`)) && (q ? k.split('/').pop()!.toLowerCase().includes(q) : v !== 'dir'));
      return { matches: all.slice(0, limit).map(([k, v]) => entry(k, v, true)), scanned: t.size, truncated: all.length > limit };
    },
  };
  return { api, grants, trees, workspace, calls, put };
}

function setup() {
  const folders = fakeFolders();
  const wsFiles = new Set<string>();
  const deps = {
    now: () => 1_000_000,
    folders: folders.api,
    filesystem: {
      async mkdir() { return undefined; },
      async getUri(o: any) { return { uri: `file:///data/user/0/app/files/${o.path}` }; },
      async stat(o: any) { if (!wsFiles.has(o.path)) throw new Error('File does not exist'); return { type: 'file', size: 10 }; },
    },
  } as unknown as DeviceToolDeps;
  const client = new McpClient(DEVICE_SERVER_NAME, createDeviceToolsTransport(deps), { protocolVersion: 'auto' });
  return { ...folders, deps, wsFiles, call: (name: string, args: Record<string, unknown> = {}) => client.callTool(name, args) as Promise<any>, client };
}

describe('normalizeFolderPath', () => {
  it('accepts relative paths and the folder root', () => {
    expect(normalizeFolderPath('')).toEqual({ ok: true, path: '', segments: [] });
    expect(normalizeFolderPath('/')).toMatchObject({ ok: true, path: '' });
    expect(normalizeFolderPath('.')).toMatchObject({ ok: true, path: '' });
    expect(normalizeFolderPath('./a/b.txt')).toMatchObject({ ok: true, path: 'a/b.txt' });
    expect(normalizeFolderPath('a//b\\c.md/')).toMatchObject({ ok: true, path: 'a/b/c.md' });
    expect(normalizeFolderPath('রিপোর্ট/২০২৬.txt')).toMatchObject({ ok: true, path: 'রিপোর্ট/২০২৬.txt' });
    expect(normalizeFolderPath(undefined)).toMatchObject({ ok: true, path: '' });
  });

  it('refuses every way out of the folder', () => {
    for (const bad of ['..', '../x', 'a/../../b', 'a/./b', 'a/..', '..\\..\\etc', 'content://com.android.externalstorage.documents/tree/primary%3A', 'file:///etc/passwd', 'a\u0000b', 'a\nb']) {
      expect(normalizeFolderPath(bad).ok, bad).toBe(false);
    }
    expect(normalizeFolderPath(42).ok).toBe(false);
    expect(normalizeFolderPath('x'.repeat(1025)).ok).toBe(false);
    expect(normalizeFolderPath(`${'y'.repeat(256)}/z`).ok).toBe(false);
    expect(normalizeFolderPath(' lead/x').ok).toBe(true); // outer spaces are trimmed
    expect(normalizeFolderPath('a/ b').ok).toBe(false);
  });

  it('checks new names and the root when asked', () => {
    expect(normalizeFolderPath('a/b?.txt', { forCreate: true }).ok).toBe(false);
    expect(normalizeFolderPath('a/b?.txt').ok).toBe(true);
    expect(normalizeFolderPath('', { allowRoot: false }).ok).toBe(false);
  });
});

describe('resolveFolder', () => {
  const folders: FolderGrant[] = [
    { id: 'a1', name: 'Work', mode: 'read' },
    { id: 'b2', name: 'work', mode: 'readwrite' },
    { id: 'c3', name: 'Music', mode: 'read', available: false, reason: 'the folder was deleted' },
  ];
  it('finds by id or a unique name and explains the rest', () => {
    expect(resolveFolder(folders, 'b2')).toMatchObject({ ok: true, folder: { id: 'b2' } });
    expect(resolveFolder(folders, 'WORK')).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(resolveFolder(folders, 'Downloads')).toMatchObject({ ok: false, code: 'NOT_SHARED' });
    expect(resolveFolder(folders, undefined)).toMatchObject({ ok: false, code: 'BAD_FOLDER' });
    expect(resolveFolder([folders[0]], undefined)).toMatchObject({ ok: true, folder: { id: 'a1' } });
    expect(resolveFolder([], 'x')).toMatchObject({ ok: false, code: 'NO_FOLDERS' });
    const gone = resolveFolder(folders, 'Music');
    expect(gone).toMatchObject({ ok: false, code: 'REVOKED' });
    expect(!gone.ok && gone.reason).toContain('deleted');
  });
});

describe('content helpers', () => {
  it('detects binary data and keeps UTF-8 characters whole', () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBe(true);
    expect(looksBinary(new Uint8Array(Buffer.from('hello\nworld\t!', 'utf8')))).toBe(false);
    const bangla = new Uint8Array(Buffer.from('আমি', 'utf8')); // 3 chars, 3 bytes each
    expect(wholeUtf8Length(bangla)).toBe(9);
    expect(wholeUtf8Length(bangla.subarray(0, 8))).toBe(6);
    expect(wholeUtf8Length(bangla.subarray(0, 4))).toBe(3);
    const emoji = new Uint8Array(Buffer.from('a\u{1F600}', 'utf8'));
    expect(wholeUtf8Length(emoji.subarray(0, 3))).toBe(1);
    expect(wholeUtf8Length(emoji)).toBe(5);
  });

  it('formats sizes and error codes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1048576)).toBe('5.0 MB');
    const e = folderErrorText(Object.assign(new Error('Android no longer grants access'), { code: 'REVOKED' }), 'Docs');
    expect(e.code).toBe('REVOKED');
    expect(e.text).toContain('add it again');
  });

  it('extracts text from DOCX, PPTX, XLSX and ODT', () => {
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Line two</w:t></w:r></w:p></w:body></w:document>') });
    expect(extractDocumentText('a.docx', docx)).toBe('Hello & welcome\nLine two');
    const pptx = zipSync({ 'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>'), 'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>') });
    expect(extractDocumentText('deck.pptx', pptx)).toBe('## Slide 1\nFirst\n\n## Slide 2\nSecond');
    const xlsx = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Item</t></si><si><t>Rice</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>5 kg</t></is></c></row></sheetData></worksheet>'),
    });
    expect(extractDocumentText('b.xlsx', xlsx)).toBe('## Budget\nItem\t\t42\nRice\t5 kg');
    const odt = zipSync({ 'content.xml': strToU8('<office:document-content><office:body><office:text><text:p>Para<text:s text:c="2"/>one</text:p><text:h>Head</text:h></office:text></office:body></office:document-content>') });
    expect(extractDocumentText('c.odt', odt)).toBe('Para  one\nHead');
    expect(extractDocumentText('c.odt', new Uint8Array([1, 2, 3]))).toBeNull();
    expect(extractDocumentText('c.pdf', docx)).toBeNull();
  });
});

describe('folder tools', () => {
  it('are listed with the device tools, reads free and changes ask-first', async () => {
    const { client } = setup();
    const names = (await client.listTools()).map((t) => t.name);
    for (const n of [...FOLDER_READ_TOOLS, ...FOLDER_CHANGE_TOOLS]) expect(names).toContain(n);
    const hidden = new McpClient(DEVICE_SERVER_NAME, createDeviceToolsTransport(setup().deps, { features: { filesystem: false } }), { protocolVersion: 'auto' });
    expect((await hidden.listTools()).map((t) => t.name)).not.toContain('folder_read');
    // iOS keeps them (they are not Android-only).
    const ios = new McpClient(DEVICE_SERVER_NAME, createDeviceToolsTransport(setup().deps, { platform: 'ios' }), { protocolVersion: 'auto' });
    expect((await ios.listTools()).map((t) => t.name)).toContain('folder_write');

    const published: string[] = [];
    const agent: AgentLike = { async startMcp(json: string) { published.push(json); return { toolCount: 0 }; }, async respondToMcpTool() { /* unused */ } };
    await connectMcpServers(agent, [deviceServerConfig()], { makeTransport: () => createDeviceToolsTransport(setup().deps) });
    const catalogue = JSON.parse(published[0]) as Array<{ name: string; approvalPolicy: string }>;
    const policy = (n: string) => catalogue.find((e) => e.name === namespacedToolName(DEVICE_SERVER_NAME, n))?.approvalPolicy;
    for (const n of FOLDER_READ_TOOLS) expect(policy(n)).toBe('always_allow');
    for (const n of FOLDER_CHANGE_TOOLS) expect(policy(n)).toBe('always_ask');
    const others = catalogue.filter((e) => ![...FOLDER_READ_TOOLS, ...FOLDER_CHANGE_TOOLS].some((n) => e.name === namespacedToolName(DEVICE_SERVER_NAME, n)));
    expect(others.length).toBeGreaterThan(5);
    for (const e of others) expect(e.approvalPolicy, e.name).toBe('always_ask');
  });

  it('a remote server cannot loosen its own policy with toolApprovalPolicies', async () => {
    const published: string[] = [];
    const agent: AgentLike = { async startMcp(json: string) { published.push(json); return { toolCount: 0 }; }, async respondToMcpTool() { /* unused */ } };
    // A transport that is not injected (a real remote server) answers tools/list over fetch.
    const fetchImpl = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'r', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'anything', inputSchema: { type: 'object' } }] } : {};
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await connectMcpServers(agent, [{ name: 'remote', url: 'https://example.invalid/mcp', toolApprovalPolicies: { anything: 'always_allow' } }], { fetchImpl });
    const catalogue = JSON.parse(published.at(-1) ?? '[]') as Array<{ name: string; approvalPolicy: string }>;
    expect(catalogue.length).toBe(1);
    expect(catalogue[0].approvalPolicy).toBe('always_ask');
  });

  it('lists shared folders and explains how to add one', async () => {
    const s = setup();
    const r = await s.call('list_folders');
    expect(textOf(r)).toContain('"Documents" (id f1): read & write');
    expect(textOf(r)).toContain('"Photos" (id f2): read-only');
    s.grants.splice(0);
    expect(textOf(await s.call('list_folders'))).toContain('sidebar \u2192 Folders \u2192 Add folder');
  });

  it('says plainly when folders are unavailable off-device', async () => {
    const deps = { now: () => 0, filesystem: {} } as unknown as DeviceToolDeps;
    const client = new McpClient(DEVICE_SERVER_NAME, createDeviceToolsTransport(deps), { protocolVersion: 'auto' });
    const r: any = await client.callTool('folder_list', { folder: 'x' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Android or iOS app');
    expect(folderApiFromPlugin({}, false)).toBeUndefined();
  });

  it('lists, reads text in pages and refuses paths outside the folder', async () => {
    const s = setup();
    s.put('f1', 'notes/todo.md', '# Todo\n- milk');
    s.put('f1', 'readme.txt', 'hi');
    const listed = await s.call('folder_list', { folder: 'Documents', path: '' });
    expect(textOf(listed)).toContain('notes/');
    expect(textOf(listed)).toContain('readme.txt');
    expect(listed.structuredContent.folder).toMatchObject({ id: 'f1', name: 'Documents' });

    const read = await s.call('folder_read', { folder: 'f1', path: 'notes/todo.md' });
    expect(textOf(read)).toContain('- milk');
    expect(textOf(read)).toContain('<untrusted_folder_file>');

    s.put('f1', 'big.txt', 'আমি'.repeat(10));
    const p1 = await s.call('folder_read', { folder: 'f1', path: 'big.txt', max_bytes: 10 });
    expect(p1.structuredContent).toMatchObject({ offset: 0, end: 9, eof: false });
    expect(textOf(p1)).toContain('offset 9');
    expect(textOf(p1)).not.toContain('\ufffd');

    for (const bad of ['../secret.txt', 'notes/../../x', 'content://evil/tree/1']) {
      const r = await s.call('folder_read', { folder: 'f1', path: bad });
      expect(r.isError, bad).toBe(true);
      expect(r.structuredContent.code).toBe('BAD_PATH');
    }
    expect(s.calls.filter((c) => c.method === 'read' && String(c.args.path).includes('..'))).toEqual([]);
    const other = await s.call('folder_read', { folder: 'Downloads', path: 'a.txt' });
    expect(other.structuredContent.code).toBe('NOT_SHARED');
  });

  it('does not show binary files as text and reads documents', async () => {
    const s = setup();
    s.put('f1', 'pic.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
    const r = await s.call('folder_read', { folder: 'f1', path: 'pic.png' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.kind).toBe('binary');
    expect(textOf(r)).toContain('folder_copy');
    s.put('f1', 'cv.docx', zipSync({ 'word/document.xml': strToU8('<w:p><w:t>Akib CV</w:t></w:p>') }));
    const d = await s.call('folder_read', { folder: 'f1', path: 'cv.docx' });
    expect(textOf(d)).toContain('Akib CV');
    expect(d.structuredContent.kind).toBe('document');
    const dir = await s.call('folder_read', { folder: 'f1', path: 'missing.txt' });
    expect(dir.structuredContent.code).toBe('NOT_FOUND');
  });

  it('searches names and content', async () => {
    const s = setup();
    s.put('f1', 'a/Invoice-March.txt', 'total 500 taka');
    s.put('f1', 'b/notes.md', 'call the bank\nthe invoice is late');
    s.put('f1', 'c/photo.png', new Uint8Array([0, 1, 2]));
    const names = await s.call('folder_search', { folder: 'f1', query: 'invoice' });
    expect(names.structuredContent.names.map((m: any) => m.path)).toEqual(['a/Invoice-March.txt']);
    const content = await s.call('folder_search', { folder: 'f1', query: 'invoice', in_content: true });
    expect(content.structuredContent.content).toEqual([{ path: 'b/notes.md', line: 2, text: 'the invoice is late' }]);
    expect(content.structuredContent.filesSearched).toBe(2);
  });

  it('writes only in read & write folders and never overwrites by accident', async () => {
    const s = setup();
    const ro = await s.call('folder_write', { folder: 'Photos', path: 'x.txt', content: 'no' });
    expect(ro.structuredContent.code).toBe('READ_ONLY');
    expect(s.calls.some((c) => c.method === 'write')).toBe(false);

    const ok = await s.call('folder_write', { folder: 'Documents', path: 'out/summary.md', content: 'সারাংশ' });
    expect(textOf(ok)).toContain('Created "Documents/out/summary.md"');
    expect(Buffer.from(s.trees.f1.get('out/summary.md') as Uint8Array).toString('utf8')).toBe('সারাংশ');
    const again = await s.call('folder_write', { folder: 'Documents', path: 'out/summary.md', content: 'new' });
    expect(again.structuredContent.code).toBe('EXISTS');
    expect(textOf(again)).toContain('overwrite: true');
    const replaced = await s.call('folder_write', { folder: 'Documents', path: 'out/summary.md', content: 'new', overwrite: true });
    expect(textOf(replaced)).toContain('Replaced');
    const bin = await s.call('folder_write', { folder: 'Documents', path: 'b.bin', content: b64(new Uint8Array([0, 255, 7])), encoding: 'base64' });
    expect(bin.structuredContent.size).toBe(3);
    expect((await s.call('folder_write', { folder: 'Documents', path: 'bad?.txt', content: 'x' })).structuredContent.code).toBe('BAD_PATH');
    expect((await s.call('folder_write', { folder: 'Documents', path: 'b.bin', content: '!!!', encoding: 'base64', overwrite: true })).isError).toBe(true);
  });

  it('renames, moves and deletes inside one folder', async () => {
    const s = setup();
    s.put('f1', 'drafts/a.txt', 'A');
    expect(textOf(await s.call('folder_move', { folder: 'f1', path: 'drafts/a.txt', to: 'drafts/b.txt' }))).toContain('Renamed');
    expect(textOf(await s.call('folder_move', { folder: 'f1', path: 'drafts/b.txt', to: 'final/b.txt' }))).toContain('Moved');
    expect((await s.call('folder_move', { folder: 'f1', path: 'final', to: 'final/inner' })).structuredContent.code).toBe('BAD_PATH');
    expect((await s.call('folder_move', { folder: 'f1', path: 'final/b.txt', to: '../b.txt' })).structuredContent.code).toBe('BAD_PATH');
    expect((await s.call('folder_delete', { folder: 'f1', path: '' })).structuredContent.code).toBe('BAD_PATH');
    const notEmpty = await s.call('folder_delete', { folder: 'f1', path: 'final' });
    expect(notEmpty.structuredContent.code).toBe('NOT_EMPTY');
    expect(textOf(await s.call('folder_delete', { folder: 'f1', path: 'final', recursive: true }))).toContain('Deleted "Documents/final"');
    expect(s.trees.f1.has('final/b.txt')).toBe(false);
    expect((await s.call('folder_delete', { folder: 'Photos', path: 'x' })).structuredContent.code).toBe('READ_ONLY');
  });

  it('copies between a folder and the workspace in both directions', async () => {
    const s = setup();
    s.put('f2', 'trip/IMG_1.jpg', new Uint8Array(1000));
    const toWs = await s.call('folder_copy', { folder: 'Photos', direction: 'to_workspace', path: 'trip/IMG_1.jpg', workspace_path: 'imports/IMG_1.jpg' });
    expect(textOf(toWs)).toContain('(1000 B)');
    const copyCall = s.calls.find((c) => c.method === 'copyToWorkspace')!;
    expect(copyCall.args.dest).toBe('file:///data/user/0/app/files/agent/workspace/imports/IMG_1.jpg');
    expect(copyCall.args.maxBytes).toBe(256 * 1024 * 1024);
    s.wsFiles.add('agent/workspace/imports/IMG_1.jpg');
    const exists = await s.call('folder_copy', { folder: 'Photos', direction: 'to_workspace', path: 'trip/IMG_1.jpg', workspace_path: 'imports/IMG_1.jpg' });
    expect(exists.structuredContent.code).toBe('EXISTS');
    // Into a read-only folder: refused before the native call.
    const ro = await s.call('folder_copy', { folder: 'Photos', direction: 'from_workspace', path: 'x.jpg', workspace_path: 'imports/IMG_1.jpg' });
    expect(ro.structuredContent.code).toBe('READ_ONLY');
    const rw = await s.call('folder_copy', { folder: 'Documents', direction: 'from_workspace', path: 'pics/x.jpg', workspace_path: 'imports/IMG_1.jpg' });
    expect(textOf(rw)).toContain('to "Documents/pics/x.jpg"');
    expect((await s.call('folder_copy', { folder: 'Documents', direction: 'to_workspace', path: 'pics/x.jpg', workspace_path: '../escape' })).structuredContent.code).toBe('BAD_PATH');
    expect((await s.call('folder_copy', { folder: 'Documents', direction: 'sideways', path: 'a', workspace_path: 'b' })).isError).toBe(true);
  });

  it('gives a clear error when access was revoked', async () => {
    const s = setup();
    s.grants[0].available = false;
    s.grants[0].reason = 'Android no longer grants access to it';
    const r = await s.call('folder_list', { folder: 'Documents' });
    expect(r.structuredContent.code).toBe('REVOKED');
    expect(textOf(r)).toContain('add it again');
    // Revoked between the list and the native call.
    s.grants[0].available = true;
    const realList = s.api.listDir;
    s.api.listDir = async () => { throw Object.assign(new Error('Android no longer grants access to "Documents"'), { code: 'REVOKED' }); };
    const r2 = await s.call('folder_list', { folder: 'Documents' });
    expect(r2.structuredContent.code).toBe('REVOKED');
    expect(textOf(r2)).toContain('Folders');
    s.api.listDir = realList;
  });

  it('maps every FolderApi method to a native plugin method', async () => {
    const seen: string[] = [];
    const plugin = Object.fromEntries(Object.values(FOLDER_PLUGIN_METHODS).map((m) => [m, async (o: unknown) => { seen.push(m); return o; }]));
    const api = folderApiFromPlugin(plugin, true)!;
    for (const key of Object.keys(FOLDER_PLUGIN_METHODS)) await (api as any)[key]({});
    expect(seen).toEqual(Object.values(FOLDER_PLUGIN_METHODS));
    const missing = folderApiFromPlugin({}, true)!;
    await expect(missing.list()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

// ── cancelling a long copy ──────────────────────────────────────────────────

/** A native copy that runs until cancelCopy is called with its copyId, reporting progress like the plugin. */
function slowCopy(s: ReturnType<typeof setup>) {
  const running = new Map<string, (e: Error) => void>();
  const progress: Array<(e: any) => void> = [];
  const cancels: string[] = [];
  const api = s.api as any;
  api.copyToWorkspace = (o: any) => new Promise((resolve, reject) => {
    s.calls.push({ method: 'copyToWorkspace', args: o });
    running.set(o.copyId, (e) => reject(e));
    for (const l of progress) l({ copyId: o.copyId, bytes: 65536, total: 200 * 1024 * 1024 });
    for (const l of progress) l({ copyId: 'someone-else', bytes: 1, total: 2 });
    api.finish = () => { running.delete(o.copyId); resolve({ bytes: 1234 }); };
  });
  api.copyFromWorkspace = api.copyToWorkspace;
  api.cancelCopy = async ({ copyId }: { copyId: string }) => {
    cancels.push(copyId);
    const stop = running.get(copyId);
    running.delete(copyId);
    stop?.(new FolderFail('CANCELLED', 'The copy was cancelled'));
    return { cancelled: !!stop };
  };
  api.onCopyProgress = async (l: (e: any) => void) => { progress.push(l); return () => { progress.splice(progress.indexOf(l), 1); }; };
  return { running, cancels, progress, api };
}
class FolderFail extends Error { constructor(public code: string, message: string) { super(message); } }

function agentWithEvents() {
  const answers: Array<{ toolCallId: string; result: any; isError?: boolean }> = [];
  let emit: (event: any) => unknown = () => undefined;
  const agent: AgentLike = {
    async startMcp() { return { toolCount: 0 }; },
    async respondToMcpTool(toolCallId: string, resultJson: string, isError?: boolean) { answers.push({ toolCallId, result: JSON.parse(resultJson), isError }); },
    addListener: (_e: string, fn: (event: any) => unknown) => { emit = fn; return { remove: () => undefined }; },
  } as AgentLike;
  return { agent, answers, emit: (e: any) => emit(e) };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('folder_copy cancellation', () => {
  it('Cancel on the card stops the native copy and the model gets a clear cancelled result', async () => {
    const s = setup();
    s.put('f2', 'big.mov', new Uint8Array(10));
    const slow = slowCopy(s);
    const { agent, answers, emit } = agentWithEvents();
    await connectMcpServers(agent, [deviceServerConfig()], { makeTransport: () => createDeviceToolsTransport(s.deps) });
    // The page's tool cards listen on window; give this Node test one.
    const seen: any[] = [];
    const target = new EventTarget();
    (globalThis as any).window = target;
    target.addEventListener('nativekit:tool-progress', (e: any) => seen.push(e.detail));
    void emit({ eventType: 'mcp_tool_call', payload: { toolCallId: 'toolu_1', toolName: namespacedToolName(DEVICE_SERVER_NAME, 'folder_copy'), args: { folder: 'Photos', direction: 'to_workspace', path: 'big.mov', workspace_path: 'big.mov' } } });
    await tick(10);
    expect(runningMcpToolCalls()).toEqual(['toolu_1']);
    const copyId = (s.calls.find((c) => c.method === 'copyToWorkspace')!.args as any).copyId as string;
    expect(copyId).toMatch(/^toolu_1:/);
    expect(seen[0]).toMatchObject({ toolCallId: 'toolu_1', progress: 65536, total: 200 * 1024 * 1024 });
    expect(seen.some((d) => d.progress === 1)).toBe(false); // another copy's progress isn't shown on this card
    expect(cancelMcpToolCall('toolu_1')).toBe(true);
    await tick(10);
    expect(slow.cancels).toEqual([copyId]);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ toolCallId: 'toolu_1', isError: true });
    const text = textOf(answers[0].result);
    expect(text).toContain('The copy was stopped because the user cancelled it');
    expect(text).toContain('partial copy was deleted');
    expect(answers[0].result.structuredContent).toMatchObject({ code: 'CANCELLED', reason: 'cancelled' });
    expect(runningMcpToolCalls()).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ toolCallId: 'toolu_1', progress: -1 });
    expect(slow.progress).toHaveLength(0); // the progress listener was removed
    expect(cancelMcpToolCall('toolu_1')).toBe(false);
    delete (globalThis as any).window;
  });

  it("Stop (the engine's mcp_tool_cancel) stops a copy from the workspace, with the reason", async () => {
    const s = setup();
    s.wsFiles.add('agent/workspace/out.zip');
    const slow = slowCopy(s);
    const { agent, answers, emit } = agentWithEvents();
    await connectMcpServers(agent, [deviceServerConfig()], { makeTransport: () => createDeviceToolsTransport(s.deps) });
    void emit({ eventType: 'mcp_tool_call', payload: { toolCallId: 'toolu_2', toolName: namespacedToolName(DEVICE_SERVER_NAME, 'folder_copy'), args: { folder: 'Documents', direction: 'from_workspace', path: 'out.zip', workspace_path: 'out.zip' } } });
    await tick(10);
    emit({ eventType: 'mcp_tool_cancel', payloadJson: JSON.stringify({ toolCallId: 'toolu_2', toolName: 'device__folder_copy', reason: 'stopped' }) });
    await tick(10);
    expect(slow.cancels).toHaveLength(1);
    expect(textOf(answers[0].result)).toContain('because the user stopped the reply');
    expect(answers[0].result.structuredContent.reason).toBe('stopped');
  });

  it('a timeout cancel says so, and a finished copy is not affected by a late cancel', async () => {
    const s = setup();
    s.put('f2', 'a.bin', new Uint8Array(10));
    const slow = slowCopy(s);
    const { agent, answers, emit } = agentWithEvents();
    await connectMcpServers(agent, [deviceServerConfig()], { makeTransport: () => createDeviceToolsTransport(s.deps) });
    const call = (id: string) => emit({ eventType: 'mcp_tool_call', payload: { toolCallId: id, toolName: namespacedToolName(DEVICE_SERVER_NAME, 'folder_copy'), args: { folder: 'Photos', direction: 'to_workspace', path: 'a.bin', workspace_path: `${id}.bin` } } });
    void call('t_timeout');
    await tick(10);
    emit({ eventType: 'mcp_tool_cancel', payload: { toolCallId: 't_timeout', reason: 'timeout' } });
    await tick(10);
    expect(textOf(answers[0].result)).toContain('longer than the tool time limit');
    void call('t_done');
    await tick(10);
    (slow.api as any).finish();
    await tick(10);
    expect(answers[1]).toMatchObject({ toolCallId: 't_done' });
    expect(answers[1].isError).toBeFalsy();
    expect(textOf(answers[1].result)).toContain('Copied');
    emit({ eventType: 'mcp_tool_cancel', payload: { toolCallId: 't_done', reason: 'stopped' } });
    await tick(10);
    expect(answers).toHaveLength(2);
    expect(slow.cancels).toHaveLength(1);
  });

  it('a remote MCP tool is cancelled with notifications/cancelled and stops waiting', async () => {
    const sent: any[] = [];
    let release: (v: any) => void = () => undefined;
    const transport = {
      async send(m: any) {
        sent.push(m);
        if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'r', version: '1' } } };
        if (m.method === 'tools/call') return new Promise((r) => { release = r; });
        return m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result: {} };
      },
    };
    const client = new McpClient('remote', transport as any, { protocolVersion: 'auto' });
    const ac = new AbortController();
    const p = client.callTool('slow', {}, { signal: ac.signal });
    await tick(5);
    ac.abort('stopped');
    await expect(p).rejects.toMatchObject({ code: MCP_REQUEST_CANCELLED });
    await tick(5);
    const call = sent.find((m) => m.method === 'tools/call');
    expect(sent.find((m) => m.method === 'notifications/cancelled')?.params).toMatchObject({ requestId: call.id, reason: 'stopped' });
    release({ jsonrpc: '2.0', id: call.id, result: { content: [] } });
  });
});
