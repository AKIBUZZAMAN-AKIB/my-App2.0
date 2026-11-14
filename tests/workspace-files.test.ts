/**
 * bridge/workspace-files.ts: the app's own whole-file reads of the agent
 * workspace (persona editor, canvas, previews), independent of the model's
 * 50 KB read_file tool.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  createWorkspaceFiles, workspaceRelPath, previewKindOf, mimeTypeOf, looksBinary, decodeText,
  bytesToBase64, base64ToBytes, formatSize, WORKSPACE_READ_MAX_BYTES, WORKSPACE_ROOT,
} from '../bridge/workspace-files';

function harness(files: Record<string, Uint8Array>, opts: { fetchFails?: boolean; sizes?: Record<string, number>; statError?: string; chunk?: number } = {}) {
  const calls: string[] = [];
  const rel = (p: string) => p.replace(`${WORKSPACE_ROOT}/`, '');
  const ws = createWorkspaceFiles({
    getUri: async (p) => `file:///app/${p}`,
    stat: async (p) => {
      calls.push(`stat ${p}`);
      if (opts.statError) throw new Error(opts.statError);
      const b = files[rel(p)];
      if (!b) throw new Error('File does not exist.');
      return { size: opts.sizes?.[rel(p)] ?? b.length, mtime: 5, type: 'file' };
    },
    toWebUrl: (uri) => uri.replace('file:///app/', 'https://localhost/_capacitor_file_/'),
    fetch: (async (u: string, init?: RequestInit) => {
      calls.push(`fetch ${u} ${JSON.stringify((init?.headers as any) || {})}`);
      if (opts.fetchFails) throw new TypeError('Failed to fetch');
      const b = files[rel(String(u).replace('https://localhost/_capacitor_file_/', ''))];
      const step = opts.chunk ?? 1 << 20;
      let i = 0;
      const body = new ReadableStream<Uint8Array>({ pull(c) { if (i >= b.length) { c.close(); return; } c.enqueue(b.subarray(i, i + step)); i += step; } });
      return new Response(body, { status: 200 });
    }) as any,
    readFileBase64: async (p) => { calls.push(`base64 ${p}`); return bytesToBase64(files[rel(p)]); },
    shareFile: async (uri, name) => { calls.push(`share ${uri} ${name}`); return {}; },
  });
  return { ws, calls };
}

describe('workspace paths and types', () => {
  it('keeps paths inside the workspace', () => {
    expect(workspaceRelPath('notes//a.md')).toBe('notes/a.md');
    expect(workspaceRelPath('./AGENTS.md')).toBe('AGENTS.md');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'file:///x', 'C:\\x', '', '~/x', 'a\u0000b']) expect(() => workspaceRelPath(bad), bad).toThrow();
  });
  it('classifies files for the preview', () => {
    expect(previewKindOf('a.png')).toBe('image');
    expect(previewKindOf('a.PDF')).toBe('pdf');
    expect(previewKindOf('song.mp3')).toBe('audio');
    expect(previewKindOf('clip.mov')).toBe('video');
    expect(previewKindOf('r.docx')).toBe('document');
    expect(previewKindOf('x.zip')).toBe('binary');
    expect(previewKindOf('main.rs')).toBe('text');
    expect(previewKindOf('Makefile')).toBe('text');
    expect(mimeTypeOf('a.pdf')).toBe('application/pdf');
    expect(mimeTypeOf('a.bin')).toBe('application/octet-stream');
  });
  it('detects binary content and decodes UTF-8 and UTF-16 text', () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4b, 0, 4]))).toBe(true);
    expect(looksBinary(strToU8('বাংলা text\n'))).toBe(false);
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0, 0x95, 0x09]))).toBe('aক');
    expect(Array.from(base64ToBytes(bytesToBase64(new Uint8Array([0, 255, 7]))))).toEqual([0, 255, 7]);
    expect(formatSize(16 * 1024 * 1024)).toBe('16 MB');
  });
});

describe('whole-file reads', () => {
  it('reads a 16 MB Bangla file whole, streamed in pieces, without read_file', async () => {
    const text = 'শুভ সকাল, good morning 🙂\n'.repeat(600_000);
    const bytes = strToU8(text);
    expect(bytes.length).toBeGreaterThan(16 * 1024 * 1024);
    const progress: number[] = [];
    const { ws, calls } = harness({ 'logs/big.log': bytes }, { chunk: 65536 });
    const r = await ws.read('logs/big.log', { onProgress: (l) => progress.push(l) });
    expect(r.content).toBe(text);
    expect(r.fileBytes).toBe(bytes.length);
    expect(r.truncated).toBe(false);
    expect(progress.length).toBeGreaterThan(100);
    expect(calls.some((c) => c.startsWith('fetch https://localhost/_capacitor_file_/agent/workspace/logs/big.log'))).toBe(true);
  });

  it('refuses a file over the limit with both sizes, or returns its start with partial', async () => {
    const { ws } = harness({ 'a.txt': strToU8('abcdef') }, { sizes: { 'a.txt': 6 } });
    await expect(ws.read('a.txt', { maxBytes: 4 })).rejects.toMatchObject({ code: 'too_large', message: expect.stringMatching(/6 B; the app opens files up to 4 B/) });
    const p = await ws.read('a.txt', { maxBytes: 4, partial: true });
    expect(p.content).toBe('abcd');
    expect(p.truncated).toBe(true);
    const big = harness({ 'v.mp4': new Uint8Array(4) }, { sizes: { 'v.mp4': WORKSPACE_READ_MAX_BYTES + 1 } });
    await expect(big.ws.read('v.mp4')).rejects.toMatchObject({ code: 'too_large' });
    // A big file still gets a streaming URL.
    expect((await big.ws.url('v.mp4')).url).toBe('https://localhost/_capacitor_file_/agent/workspace/v.mp4');
  });

  it('says when a file changed while it was read', async () => {
    const { ws } = harness({ 'a.txt': strToU8('abcdef') }, { sizes: { 'a.txt': 4 } });
    await expect(ws.read('a.txt')).rejects.toMatchObject({ code: 'changed' });
  });

  it('falls back to the Filesystem plugin when the local server is unreachable', async () => {
    const { ws, calls } = harness({ 'a.md': strToU8('# hi') }, { fetchFails: true });
    expect((await ws.read('a.md')).content).toBe('# hi');
    expect(calls.some((c) => c.startsWith('base64 agent/workspace/a.md'))).toBe(true);
  });

  it('tells a missing file from one that cannot be read, so the persona editor never overwrites an unreadable file', async () => {
    await expect(harness({}).ws.read('AGENTS.md')).rejects.toMatchObject({ code: 'not_found', message: expect.stringMatching(/No such file/) });
    await expect(harness({}, { statError: 'Permission denied (os error 13)' }).ws.read('AGENTS.md')).rejects.toMatchObject({ code: 'read_failed', message: expect.stringMatching(/Permission denied/) });
  });

  it('returns base64 and bytes, flags binary, and extracts office text', async () => {
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>প্রতিবেদন</w:t></w:r></w:p></w:body></w:document>') });
    const { ws, calls } = harness({ 'b.bin': new Uint8Array([0, 1, 2]), 'r.docx': docx });
    expect((await ws.read('b.bin')).binary).toBe(true);
    expect((await ws.read('b.bin', { as: 'base64' })).base64).toBe('AAEC');
    expect(Array.from((await ws.read('b.bin', { as: 'bytes' })).bytes!)).toEqual([0, 1, 2]);
    expect((await ws.documentText('r.docx')).text).toContain('প্রতিবেদন');
    await expect(ws.documentText('b.bin')).rejects.toMatchObject({ code: 'not_document' });
    await ws.share('b.bin');
    expect(calls).toContain('share file:///app/agent/workspace/b.bin b.bin');
  });
});
