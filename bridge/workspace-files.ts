/**
 * App-side access to the agent's workspace files, for the user's own UI
 * (persona editor, file canvas, file previews). This never goes through the
 * model-facing `read_file` tool, so its 50,000-byte schema cap does not apply:
 * a file is streamed whole from the WebView's local file server, any type.
 *
 * - `url(path)` gives a same-origin WebView URL the native local server streams
 *   with Range support, so images, audio, video and PDF play straight from disk
 *   without copying the file into JavaScript.
 * - `read(path)` reads the whole file (text, base64 or bytes) up to a generous,
 *   clearly reported limit, with progress, and refuses a file that changes while
 *   it is being read.
 * - `documentText(path)` returns the text of DOCX/PPTX/XLSX/ODT/ODS/ODP files,
 *   the same extraction the folder tools use.
 *
 * Paths are relative to the workspace root and may not leave it.
 */
import { extractDocumentText, DOCUMENT_EXTENSIONS } from './folder-access';

/** The workspace root, relative to the platform's app-private directory (Android filesDir, iOS Library). */
export const WORKSPACE_ROOT = 'agent/workspace';
/** Whole-file reads into memory (text, base64, bytes): 64 MB. */
export const WORKSPACE_READ_MAX_BYTES = 64 * 1024 * 1024;
/** Office documents whose text is extracted: 60 MB, the folder tools' own limit. */
export const WORKSPACE_DOCUMENT_MAX_BYTES = 60 * 1024 * 1024;
/** Base64 fallback through the Filesystem plugin when the local server can't be reached. */
export const WORKSPACE_BASE64_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;

export type WorkspacePreviewKind = 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'document' | 'binary';

export class WorkspaceFileError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'WorkspaceFileError'; this.code = code; }
}

const MiB = 1024 * 1024;
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MiB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * MiB) return `${(bytes / MiB).toFixed(bytes < 10 * MiB ? 1 : 0)} MB`;
  return `${(bytes / (1024 * MiB)).toFixed(1)} GB`;
}

/** A safe workspace-relative path: no absolute paths, no `..`, no NUL, no backslashes. */
export function workspaceRelPath(input: unknown): string {
  if (typeof input !== 'string') throw new WorkspaceFileError('bad_path', 'A workspace path must be text.');
  let p = input.trim();
  if (!p) throw new WorkspaceFileError('bad_path', 'The file path is empty.');
  if (p.includes('\u0000')) throw new WorkspaceFileError('bad_path', 'The file path contains a NUL character.');
  if (p.includes('\\')) throw new WorkspaceFileError('bad_path', `${input}: use / between folders.`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('~')) throw new WorkspaceFileError('bad_path', `${input} is outside the workspace. Use a path inside it, like notes/todo.md.`);
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new WorkspaceFileError('bad_path', `${input} leaves the workspace (..).`);
    parts.push(seg);
  }
  if (!parts.length) throw new WorkspaceFileError('bad_path', `${input} is the workspace itself, not a file.`);
  return parts.join('/');
}

const MIME: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/x-ndjson', ndjson: 'application/x-ndjson', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain', py: 'text/x-python', rs: 'text/plain', sh: 'text/x-shellscript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg', '3gp': 'video/3gpp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', apk: 'application/vnd.android.package-archive', db: 'application/vnd.sqlite3', sqlite: 'application/vnd.sqlite3', wasm: 'application/wasm', bin: 'application/octet-stream', exe: 'application/octet-stream',
};
const BINARY_EXT = new Set(['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'apk', 'aab', 'ipa', 'db', 'sqlite', 'sqlite3', 'wasm', 'bin', 'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'o', 'a', 'ttf', 'otf', 'woff', 'woff2', 'psd', 'doc', 'xls', 'ppt', 'epub', 'dmg', 'iso']);

export function extOf(name: string): string {
  const base = String(name).split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}
export function mimeTypeOf(name: string): string {
  return MIME[extOf(name)] || (BINARY_EXT.has(extOf(name)) ? 'application/octet-stream' : 'text/plain');
}
/** How the UI should preview a file, from its name. `text` files are still checked for binary content when read. */
export function previewKindOf(name: string): WorkspacePreviewKind {
  const ext = extOf(name);
  const mime = MIME[ext] || '';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (ext === 'pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (BINARY_EXT.has(ext) || mime === 'application/octet-stream') return 'binary';
  return 'text';
}

/** True when the bytes look binary: a NUL byte, or many control characters, in the first 8 KB. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (n >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return false; // UTF-16 BOM
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.1;
}

/** UTF-8 (BOM stripped) or UTF-16 with a BOM. Invalid bytes become U+FFFD rather than failing. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  return btoa(out);
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(String(b64).replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface WorkspaceStat { size: number; mtime: number; type: 'file' | 'directory' }
export interface WorkspaceFileDeps {
  /** Native file URI (file://…) of a path relative to the app-private directory. */
  getUri(relToAppDir: string): Promise<string>;
  stat(relToAppDir: string): Promise<WorkspaceStat>;
  /** file:// URI -> URL the WebView's local server streams (Capacitor.convertFileSrc). */
  toWebUrl(uri: string): string;
  fetch: typeof fetch;
  /** Whole file as base64 through the Filesystem plugin (fallback). */
  readFileBase64(relToAppDir: string): Promise<string>;
  /** Opens the system share / open-with sheet for a file URI. */
  shareFile?(uri: string, name: string): Promise<unknown>;
}

export interface WorkspaceReadResult {
  path: string; name: string; size: number; fileBytes: number; mtime: number; modifiedMs: number;
  mimeType: string; kind: WorkspacePreviewKind; truncated: boolean;
  binary?: boolean; content?: string; base64?: string; bytes?: Uint8Array;
}
export interface ReadOptions {
  as?: 'text' | 'base64' | 'bytes';
  /** Upper bound; a file over it throws `too_large`, or with `partial` returns its first maxBytes. */
  maxBytes?: number;
  partial?: boolean;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

export function createWorkspaceFiles(deps: WorkspaceFileDeps) {
  const appRel = (p: string) => `${WORKSPACE_ROOT}/${workspaceRelPath(p)}`;

  async function stat(path: string) {
    const rel = workspaceRelPath(path);
    let s: WorkspaceStat;
    try { s = await deps.stat(`${WORKSPACE_ROOT}/${rel}`); } catch (e: any) {
      const why = String(e?.message ?? e ?? '');
      if (!why || /does ?n[o']t exist|no such file|not found|ENOENT|os error 2/i.test(why)) throw new WorkspaceFileError('not_found', `${rel}: No such file in the workspace.`);
      throw new WorkspaceFileError('read_failed', `${rel} could not be opened: ${why}`);
    }
    const name = rel.split('/').pop() as string;
    return { path: rel, name, size: Number(s.size) || 0, mtime: Number(s.mtime) || 0, type: s.type === 'directory' ? 'directory' : 'file', mimeType: mimeTypeOf(name), kind: previewKindOf(name) } as const;
  }

  async function url(path: string) {
    const s = await stat(path);
    if (s.type !== 'file') throw new WorkspaceFileError('not_a_file', `${s.path} is a folder, not a file.`);
    const uri = await deps.getUri(appRel(s.path));
    return { ...s, uri, url: deps.toWebUrl(uri) };
  }

  async function readBytes(path: string, opts: ReadOptions = {}) {
    const s = await url(path);
    const cap = Math.max(1, Math.min(WORKSPACE_READ_MAX_BYTES, Math.floor(Number(opts.maxBytes)) || WORKSPACE_READ_MAX_BYTES));
    if (s.size > cap && !opts.partial) throw new WorkspaceFileError('too_large', `${s.path} is ${formatSize(s.size)}; the app opens files up to ${formatSize(cap)} here. Use Open or Share to view it in another app.`);
    const want = Math.min(s.size, cap);
    let bytes: Uint8Array | null = null;
    let fetchError: unknown = null;
    try {
      const res = await deps.fetch(s.url, { signal: opts.signal, cache: 'no-store', ...(s.size > cap ? { headers: { Range: `bytes=0-${want - 1}` } } : {}) });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const out = new Uint8Array(want);
      let loaded = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (loaded + value.length > want) {
            if (!opts.partial && s.size <= cap) { try { await reader.cancel(); } catch { /* ignore */ } throw new WorkspaceFileError('changed', `${s.path} changed while it was being read. Try again.`); }
            out.set(value.subarray(0, want - loaded), loaded);
            loaded = want;
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
          out.set(value, loaded);
          loaded += value.length;
          opts.onProgress?.(loaded, want);
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        loaded = Math.min(buf.length, want);
        out.set(buf.subarray(0, loaded));
        if (buf.length > want && !opts.partial) throw new WorkspaceFileError('changed', `${s.path} changed while it was being read. Try again.`);
      }
      if (loaded !== want) throw new WorkspaceFileError('changed', `${s.path} changed while it was being read (${formatSize(loaded)} of ${formatSize(want)}). Try again.`);
      bytes = out;
    } catch (e: any) {
      if (e instanceof WorkspaceFileError || e?.name === 'AbortError') throw e;
      fetchError = e;
    }
    if (!bytes) {
      // The local server could not be reached: read through the Filesystem plugin instead (base64 over the bridge).
      if (s.size > WORKSPACE_BASE64_FALLBACK_MAX_BYTES) throw new WorkspaceFileError('read_failed', `${s.path} could not be streamed (${(fetchError as any)?.message || fetchError}), and it is too large (${formatSize(s.size)}) to read another way.`);
      const all = base64ToBytes(await deps.readFileBase64(appRel(s.path)));
      if (all.length !== s.size) throw new WorkspaceFileError('changed', `${s.path} changed while it was being read. Try again.`);
      bytes = all.subarray(0, want);
      opts.onProgress?.(bytes.length, want);
    }
    return { stat: s, bytes, truncated: want < s.size };
  }

  async function read(path: string, opts: ReadOptions = {}): Promise<WorkspaceReadResult> {
    const { stat: s, bytes, truncated } = await readBytes(path, opts);
    const base = { path: s.path, name: s.name, size: s.size, fileBytes: s.size, mtime: s.mtime, modifiedMs: s.mtime, mimeType: s.mimeType, kind: s.kind, truncated };
    if (opts.as === 'bytes') return { ...base, bytes };
    if (opts.as === 'base64') return { ...base, base64: bytesToBase64(bytes) };
    if (looksBinary(bytes)) return { ...base, binary: true, content: '' };
    return { ...base, binary: false, content: decodeText(bytes) };
  }

  async function documentText(path: string, opts: { signal?: AbortSignal; onProgress?: ReadOptions['onProgress'] } = {}) {
    const name = workspaceRelPath(path);
    if (!DOCUMENT_EXTENSIONS.has(extOf(name))) throw new WorkspaceFileError('not_document', `${name} is not a DOCX, PPTX, XLSX, ODT, ODS or ODP file.`);
    const { stat: s, bytes } = await readBytes(name, { maxBytes: WORKSPACE_DOCUMENT_MAX_BYTES, signal: opts.signal, onProgress: opts.onProgress });
    const text = extractDocumentText(s.name, bytes);
    if (text == null) throw new WorkspaceFileError('unreadable', `${s.name}: its text could not be read; the file may be damaged or protected.`);
    return { path: s.path, name: s.name, size: s.size, mtime: s.mtime, text };
  }

  async function share(path: string) {
    const s = await url(path);
    if (!deps.shareFile) throw new WorkspaceFileError('unsupported', 'Sharing files is not available here.');
    return deps.shareFile(s.uri, s.name);
  }

  return {
    limits: { readMaxBytes: WORKSPACE_READ_MAX_BYTES, documentMaxBytes: WORKSPACE_DOCUMENT_MAX_BYTES },
    stat, url, read, readBytes, documentText, share,
    previewKind: previewKindOf, mimeType: mimeTypeOf,
  };
}
export type WorkspaceFiles = ReturnType<typeof createWorkspaceFiles>;
