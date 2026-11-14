/**
 * Folders the user shares with the agent.
 *
 * The user grants a whole folder once through the system folder picker:
 *   - Android: Storage Access Framework ACTION_OPEN_DOCUMENT_TREE plus
 *     takePersistableUriPermission, so the grant survives restarts. No
 *     MANAGE_EXTERNAL_STORAGE and no media permissions (Play-policy safe).
 *   - iOS: UIDocumentPickerViewController for a folder plus a bookmark, opened
 *     with startAccessingSecurityScopedResource for each operation.
 * The native side (plugins/custom-native, `folder*` methods) only ever walks
 * children of the granted tree, and this module checks every path before it
 * gets there, so a path can never leave a granted folder.
 *
 * Pure helpers live here so they are unit-testable without a device:
 * path normalisation, folder lookup, text/binary detection, UTF-8 chunking and
 * text extraction from common office documents (DOCX, PPTX, XLSX, ODT, ODS, ODP).
 */
import { strFromU8, unzipSync } from 'fflate';

export type FolderMode = 'read' | 'readwrite';

export interface FolderGrant {
  /** Stable id chosen by the native side when the folder was added. */
  id: string;
  /** The folder's display name (what the user picked). */
  name: string;
  /** What the user allows the agent to do in it. */
  mode: FolderMode;
  /** Whether the OS grant itself includes write access. */
  canWrite?: boolean;
  /** False when the OS grant is gone (revoked, folder deleted, card removed). */
  available?: boolean;
  /** Why it is unavailable, when it is. */
  reason?: string;
  /** A human hint of where it lives, e.g. "Internal storage › Documents". */
  location?: string;
  addedAt?: number;
}

export interface FolderEntry {
  name: string;
  /** Path relative to the folder root (search results). */
  path?: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  mime?: string;
}

/** The native folder surface (NativeKit.folders / NativeKitCustom folder* methods). */
export interface FolderApi {
  list(): Promise<{ folders: FolderGrant[] }>;
  listDir(options: { id: string; path: string; limit?: number }): Promise<{ entries: FolderEntry[]; truncated?: boolean }>;
  stat(options: { id: string; path: string }): Promise<FolderEntry & { exists: boolean }>;
  /** Reads up to `length` bytes from `offset`, base64 encoded. */
  read(options: { id: string; path: string; offset: number; length: number }): Promise<{ data: string; size: number; bytesRead: number; eof: boolean }>;
  /** Writes base64 `data`, creating parent folders. Fails with EXISTS unless overwrite. */
  write(options: { id: string; path: string; data: string; overwrite: boolean }): Promise<{ size: number; created: boolean }>;
  mkdir(options: { id: string; path: string }): Promise<{ created: boolean }>;
  remove(options: { id: string; path: string; recursive: boolean }): Promise<{ deleted: boolean }>;
  move(options: { id: string; path: string; to: string; overwrite: boolean }): Promise<{ path: string }>;
  /** Streams a folder file into the app workspace file at `dest` (a file:// URI). */
  copyToWorkspace(options: { id: string; path: string; dest: string; overwrite: boolean; maxBytes: number }): Promise<{ bytes: number }>;
  /** Streams the workspace file at `src` (a file:// URI) into the folder. */
  copyFromWorkspace(options: { id: string; src: string; path: string; overwrite: boolean; maxBytes: number }): Promise<{ bytes: number }>;
  /** Recursive name search; an empty query lists files. */
  find(options: { id: string; path: string; query: string; limit: number; maxDepth: number }): Promise<{ matches: FolderEntry[]; scanned: number; truncated: boolean }>;
}

/** Error codes the native side rejects with (call.reject(message, code)). */
export const FOLDER_ERROR_HINTS: Record<string, string> = {
  REVOKED: 'Access to this folder was removed. Ask the user to add it again in Folders (sidebar \u2192 Folders \u2192 Add folder).',
  READ_ONLY: 'This folder is read-only for you. The user can switch it to "Read & write" in Folders.',
  NOT_FOUND: 'Nothing exists at that path. Use folder_list or folder_search to find the right name.',
  EXISTS: 'Something already exists at that path. Pass overwrite: true only if the user wants it replaced.',
  NOT_A_FILE: 'That path is a folder, not a file.',
  NOT_A_DIRECTORY: 'That path is a file, not a folder.',
  TOO_LARGE: 'The file is larger than this tool allows.',
  BAD_PATH: 'Use a path relative to the shared folder, such as "notes/todo.txt".',
  UNSUPPORTED: 'The storage provider behind this folder does not support that operation.',
};

export const MAX_PATH_CHARS = 1024;
export const MAX_SEGMENT_CHARS = 255;
/** Characters most phone, SD card and cloud storages refuse in a name. */
const INVALID_NAME_CHARS = /[<>:"|?*\\]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type PathCheck = { ok: true; path: string; segments: string[] } | { ok: false; reason: string };

/**
 * Normalises a path relative to a granted folder. "" (or "/", ".") is the
 * folder itself. Rejects '..' and '.' segments rather than resolving them, so
 * no input can climb out of the folder, and rejects control characters.
 * With `forCreate`, names must also be valid for new files on common storages.
 */
export function normalizeFolderPath(raw: unknown, { forCreate = false, allowRoot = true }: { forCreate?: boolean; allowRoot?: boolean } = {}): PathCheck {
  if (raw === undefined || raw === null) raw = '';
  if (typeof raw !== 'string') return { ok: false, reason: 'The path must be a string.' };
  if (raw.length > MAX_PATH_CHARS) return { ok: false, reason: `The path is longer than ${MAX_PATH_CHARS} characters.` };
  if (CONTROL_CHARS.test(raw)) return { ok: false, reason: 'The path contains control characters.' };
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return { ok: false, reason: 'Pass a path inside the shared folder, not a URI.' };
  const segments: string[] = [];
  let s = trimmed.replace(/\\/g, '/');
  if (s === '.') s = '';
  while (s.startsWith('./')) s = s.slice(2);
  for (const segment of s.split('/')) {
    if (segment === '') continue;
    if (segment === '..') return { ok: false, reason: "'..' is not allowed: paths stay inside the shared folder." };
    if (segment === '.') return { ok: false, reason: "'.' is not allowed inside a path." };
    if (segment.length > MAX_SEGMENT_CHARS) return { ok: false, reason: `A name in the path is longer than ${MAX_SEGMENT_CHARS} characters.` };
    if (segment !== segment.trim()) return { ok: false, reason: `"${segment}" starts or ends with a space.` };
    if (forCreate && INVALID_NAME_CHARS.test(segment)) return { ok: false, reason: `"${segment}" contains a character storages refuse (< > : " | ? * \\).` };
    segments.push(segment);
  }
  if (!allowRoot && segments.length === 0) return { ok: false, reason: 'Name a file or folder inside the shared folder; the shared folder itself cannot be used here.' };
  return { ok: true, path: segments.join('/'), segments };
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export type FolderLookup = { ok: true; folder: FolderGrant } | { ok: false; reason: string; code: string };

/** Finds a granted folder by id, or by name when the name is unique (case-insensitive). */
export function resolveFolder(folders: FolderGrant[], ref: unknown): FolderLookup {
  const names = folders.map((f) => `"${f.name}" (id ${f.id})`).join(', ');
  if (!folders.length) return { ok: false, code: 'NO_FOLDERS', reason: 'No folders are shared with you yet. Ask the user to add one: sidebar \u2192 Folders \u2192 Add folder.' };
  const key = typeof ref === 'string' ? ref.trim() : '';
  if (!key) {
    if (folders.length === 1) return check(folders[0]);
    return { ok: false, code: 'BAD_FOLDER', reason: `Pass 'folder' (a name or id). Shared folders: ${names}.` };
  }
  const byId = folders.find((f) => f.id === key);
  if (byId) return check(byId);
  const byName = folders.filter((f) => f.name.toLowerCase() === key.toLowerCase());
  if (byName.length === 1) return check(byName[0]);
  if (byName.length > 1) return { ok: false, code: 'AMBIGUOUS', reason: `Several shared folders are named "${key}"; pass the id instead: ${names}.` };
  return { ok: false, code: 'NOT_SHARED', reason: `No shared folder is called "${key}". Shared folders: ${names}. Other folders on the phone are not available to you.` };

  function check(folder: FolderGrant): FolderLookup {
    if (folder.available === false) return { ok: false, code: 'REVOKED', reason: `Access to "${folder.name}" is gone${folder.reason ? ` (${folder.reason})` : ''}. ${FOLDER_ERROR_HINTS.REVOKED}` };
    return { ok: true, folder };
  }
}

/** Whether the agent may change things in this folder. */
export function folderWritable(folder: FolderGrant): boolean {
  return folder.mode === 'readwrite' && folder.canWrite !== false;
}

/** Error text for a native rejection: the message plus what to do about it. */
export function folderErrorText(error: unknown, folderName?: string): { text: string; code: string } {
  const anyErr = error as { code?: unknown; message?: unknown } | null;
  const code = typeof anyErr?.code === 'string' ? anyErr.code : '';
  let message = typeof anyErr?.message === 'string' ? anyErr.message : String(error);
  message = message.replace(/^Error:\s*/, '').slice(0, 300);
  const hint = FOLDER_ERROR_HINTS[code];
  const where = folderName ? ` in "${folderName}"` : '';
  return { code: code || 'FAILED', text: `${message}${where && !message.includes(folderName!) ? where : ''}.${hint ? ` ${hint}` : ''}`.replace(/\.\./g, '.') };
}

// ── Content kinds ────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'sql', 'svg', 'tex', 'bib', 'srt', 'vtt', 'rtf', 'gradle', 'properties',
  'lua', 'r', 'dart', 'vue', 'svelte', 'org', 'rst', 'adoc', 'ics', 'vcf', 'gitignore',
]);
export const DOCUMENT_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp']);

export function extensionOf(name: string): string {
  const base = baseName(name);
  const i = base.lastIndexOf('.');
  return i <= 0 ? (base.startsWith('.') ? base.slice(1).toLowerCase() : '') : base.slice(i + 1).toLowerCase();
}
export const isTextName = (name: string) => TEXT_EXTENSIONS.has(extensionOf(name));
export const isDocumentName = (name: string) => DOCUMENT_EXTENSIONS.has(extensionOf(name));

/** True when the bytes look like binary data (NUL bytes or many control characters). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (!n) return false;
  let odd = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) odd += 1;
  }
  return odd / n > 0.1;
}

/**
 * How many bytes of `bytes` form whole UTF-8 characters. A read that stops in
 * the middle of a character leaves the tail for the next page, so no page
 * shows a broken character and none is lost.
 */
export function wholeUtf8Length(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back += 1) {
    const b = bytes[n - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

// ── Office documents ─────────────────────────────────────────────────────────

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 200_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const stripTags = (xml: string) => decodeEntities(xml.replace(/<[^>]+>/g, ''));
const tidy = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function wordXmlText(xml: string): string {
  return tidy(stripTags(xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:p>/g, '\n')));
}
function drawingXmlText(xml: string): string {
  return tidy(stripTags(xml.replace(/<a:br\b[^>]*\/>/g, '\n').replace(/<\/a:p>/g, '\n')));
}
function odfXmlText(xml: string): string {
  const body = xml.replace(/^[\s\S]*?<office:body>/, '').replace(/<\/office:body>[\s\S]*$/, '');
  return tidy(stripTags(body
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_m, c?: string) => ' '.repeat(Math.min(Number(c) || 1, 50)))
    .replace(/<\/table:table-cell>/g, '\t')
    .replace(/<\/table:table-row>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<draw:page\b[^>]*draw:name="([^"]*)"[^>]*>/g, (_m, n: string) => `\n## ${n}\n`)
    .replace(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>/g, (_m, n: string) => `\n## ${n}\n`)));
}
function numbered(files: Record<string, Uint8Array>, re: RegExp): Array<[number, string]> {
  return Object.keys(files)
    .map((k) => [Number(re.exec(k)?.[1]), k] as [number, string])
    .filter(([n]) => Number.isFinite(n))
    .sort((a, b) => a[0] - b[0]);
}
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}
function xlsxText(files: Record<string, Uint8Array>): string {
  const shared: string[] = [];
  const sst = files['xl/sharedStrings.xml'];
  if (sst) for (const m of strFromU8(sst).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(stripTags(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  const names = [...strFromU8(files['xl/workbook.xml'] ?? new Uint8Array()).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  const out: string[] = [];
  for (const [n, key] of numbered(files, /^xl\/worksheets\/sheet(\d+)\.xml$/)) {
    out.push(`## ${names[n - 1] ?? `Sheet ${n}`}`);
    for (const row of strFromU8(files[key]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? '';
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let text = '';
        if (type === 's' && v !== undefined) text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') text = stripTags(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
        else if (v !== undefined) text = decodeEntities(v);
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = text.replace(/[\t\n]+/g, ' ');
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) out.push(cells.join('\t'));
    }
    out.push('');
  }
  return tidy(out.join('\n'));
}

/**
 * Plain text from DOCX, PPTX, XLSX, ODT, ODS or ODP bytes; null for other
 * types or a file that is not a readable document. Cells are tab-separated,
 * slides and sheets get a "## name" line.
 */
export function extractDocumentText(name: string, bytes: Uint8Array): string | null {
  const ext = extensionOf(name);
  if (!DOCUMENT_EXTENSIONS.has(ext) || bytes.length > MAX_DOCUMENT_BYTES) return null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.originalSize <= 60 * 1024 * 1024 && /\.xml$/.test(f.name) });
  } catch {
    return null;
  }
  let text: string | null = null;
  if (ext === 'docx') {
    const doc = files['word/document.xml'];
    if (doc) text = wordXmlText(strFromU8(doc));
  } else if (ext === 'pptx') {
    const slides = numbered(files, /^ppt\/slides\/slide(\d+)\.xml$/);
    if (slides.length) text = slides.map(([n, k]) => `## Slide ${n}\n${drawingXmlText(strFromU8(files[k]))}`).join('\n\n');
  } else if (ext === 'xlsx') {
    if (files['xl/workbook.xml']) text = xlsxText(files);
  } else {
    const content = files['content.xml'];
    if (content) text = odfXmlText(strFromU8(content));
  }
  if (text === null) return null;
  return text.length > MAX_EXTRACTED_CHARS ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n\u2026 (cut at ${MAX_EXTRACTED_CHARS} characters)` : text;
}

/** Human size: 1.2 MB, 340 KB, 12 B. */
export function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

/** Native method names on NativeKitCustom (Android: FolderAccess.java, iOS: FolderAccess.swift). */
export const FOLDER_PLUGIN_METHODS = {
  list: 'folderList', listDir: 'folderListDir', stat: 'folderStat', read: 'folderRead', write: 'folderWrite', mkdir: 'folderMkdir',
  remove: 'folderDelete', move: 'folderMove', copyToWorkspace: 'folderCopyToWorkspace', copyFromWorkspace: 'folderCopyFromWorkspace', find: 'folderFind',
} as const;

/**
 * Adapts the NativeKitCustom plugin to FolderApi. Returns undefined off-device
 * (the browser preview has no folder grants), so the tools say so plainly.
 */
export function folderApiFromPlugin(plugin: unknown, isNative = isNativePlatform()): FolderApi | undefined {
  if (!isNative || !plugin) return undefined;
  const p = plugin as Record<string, (options?: unknown) => Promise<any>>;
  const api = {} as Record<keyof FolderApi, (options?: unknown) => Promise<any>>;
  for (const [key, method] of Object.entries(FOLDER_PLUGIN_METHODS) as Array<[keyof FolderApi, string]>) {
    api[key] = (options?: unknown) => {
      if (typeof p[method] !== 'function') return Promise.reject(Object.assign(new Error('This app build has no shared-folder support'), { code: 'UNAVAILABLE' }));
      return p[method](options ?? {});
    };
  }
  return api as unknown as FolderApi;
}

function isNativePlatform(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}
