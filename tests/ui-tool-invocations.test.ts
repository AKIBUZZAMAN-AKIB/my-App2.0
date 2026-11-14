/**
 * Every built-in tool call the app's own screens make (persona editor, file
 * browser, memory panel, home page) goes through the native engine's argument
 * checks, the same ones the model's calls get. A UI call outside a schema
 * limit fails at runtime: `read_file` with `limit_bytes: 1e7` once emptied the
 * persona editor with "Argument '$.limit_bytes' for 'read_file' is outside its
 * allowed range". This suite reads every UI-side call site and checks its
 * literal arguments against the real schemas (tests/fixtures/native-tool-schemas.json,
 * kept equal to tool_runner.rs by a Rust test). Values computed at runtime are
 * checked by the browser suites, which run the same validator on every call.
 *
 * The app's own file reads (persona editor, canvas, previews) no longer use
 * read_file at all: they go through NativeKit.agent.workspace
 * (bridge/workspace-files.ts), so the model's 50 KB cap never limits the user.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validateNativeToolArgs } = require('./fixtures/validate-native-tool-args.cjs');
const ROOT = join(__dirname, '..');
const schemas: Record<string, any> = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/native-tool-schemas.json'), 'utf8'));
const rust = readFileSync(join(ROOT, 'plugins/native-agent/rust/native-agent-ffi/src/tool_runner.rs'), 'utf8');

/** A value the scan cannot know (a variable, a field, a call result). */
const DYN_TARGET = () => undefined;
const DYN: any = new Proxy(DYN_TARGET, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 'dyn' : DYN),
  apply: () => DYN,
  has: () => false,
  ownKeys: () => [],
  getOwnPropertyDescriptor: () => undefined,
});
const isDyn = (v: unknown) => v === DYN || (typeof v === 'number' && Number.isNaN(v));
const GLOBALS = new Set(['Math', 'Number', 'JSON', 'String', 'Boolean', 'Array', 'Object', 'undefined', 'Infinity', 'NaN']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(html|js|mjs|ts)$/.test(name) && !/\.min\.js$|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The text of the balanced {...} starting at `start`, skipping strings and template literals. */
function balanced(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced object at ${start}`);
}

/** Top-level numeric constants (`const READ_CHUNK_BYTES = 50000;`) a call site may name. */
function numericConstants(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9][0-9_]*(?:\.[0-9]+)?(?:e[0-9]+)?)\s*;/g)) out[m[1]] = Number(m[2].replace(/_/g, ''));
  return out;
}

function evaluate(objectText: string, constants: Record<string, number>): any {
  const scope = new Proxy({}, {
    has: (_t, k) => typeof k === 'string' && !GLOBALS.has(k),
    get: (_t, k) => (typeof k === 'string' && k in constants ? constants[k] : k === Symbol.unscopables ? undefined : DYN),
  });
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { return (${objectText}); }`)(scope);
}

const MEMORY_FACADE: Record<string, string> = { list: 'memory_list', search: 'memory_search', store: 'memory_store', recall: 'memory_recall', forget: 'memory_forget' };

interface Site { file: string; line: number; tool: string; text: string; args: any }

function collectSites(): Site[] {
  const files = [...walk(join(ROOT, 'www')), ...walk(join(ROOT, 'tools/agent-html-src')), ...walk(join(ROOT, 'bridge'))];
  const sites: Site[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const constants = numericConstants(src);
    const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
      [/\b(?:invokeTool|invokeFile|invokeMemory|invokeAgentMemoryTool)\(\s*(['"])([a-z_]+)\1\s*,\s*(?=\{)/g, (m) => m[2]],
      [/\bmemory\??\.(list|search|store|recall|forget)\(\s*(?=\{)/g, (m) => MEMORY_FACADE[m[1]]],
    ];
    for (const [re, toolOf] of patterns) {
      for (const m of src.matchAll(re)) {
        const lineText = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
        if (/^\s*(?:\/\/|\*|\/\*)/.test(lineText)) continue; // documentation, not a call
        const at = (m.index ?? 0) + m[0].length;
        const text = balanced(src, at);
        if (text === '{...}') continue; // an example in a comment
        const line = src.slice(0, m.index).split('\n').length;
        let args: any;
        try { args = evaluate(text, constants); } catch (e) { throw new Error(`${relative(ROOT, file)}:${line} could not read the arguments ${text.slice(0, 200)}: ${e}`); }
        sites.push({ file: relative(ROOT, file), line, tool: toolOf(m), text, args });
      }
    }
  }
  return sites;
}

describe('UI-side built-in tool calls against the real schemas', () => {
  const sites = collectSites();

  it('finds the call sites of every screen that calls tools directly', () => {
    const files = new Set(sites.map((s) => s.file));
    for (const f of ['www/agent.html', 'www/agent-workspace.js', 'www/home.html']) expect(files, f).toContain(f);
    const tools = new Set(sites.map((s) => s.tool));
    for (const t of ['write_file', 'list_files', 'delete_file', 'memory_list', 'memory_store', 'memory_search']) expect(tools, t).toContain(t);
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it('every call names a built-in tool and passes its schema and byte limits', () => {
    const problems = sites
      .map((s) => ({ s, error: validateNativeToolArgs(schemas, s.tool, s.args, isDyn) }))
      .filter((x) => x.error)
      .map(({ s, error }) => `${s.file}:${s.line} ${s.tool}(${s.text.replace(/\s+/g, ' ').slice(0, 120)}) -> ${error}`);
    expect(problems).toEqual([]);
  });

  it('the validator reproduces the engine error the user saw', () => {
    expect(validateNativeToolArgs(schemas, 'read_file', { path: 'AGENTS.md', offset_bytes: 0, limit_bytes: 1e7 }))
      .toBe("Argument '$.limit_bytes' for 'read_file' is outside its allowed range");
    expect(validateNativeToolArgs(schemas, 'read_file', { path: 'a', offset_bytes: 0, limit_bytes: 400000 })).toMatch(/outside its allowed range/);
    expect(validateNativeToolArgs(schemas, 'memory_list', { prefix: '', limit: 100 })).toBe("Argument '$.limit' for 'memory_list' is outside its allowed range");
    expect(validateNativeToolArgs(schemas, 'read_file', { path: 'a', limit_bytes: 50000 })).toBeNull();
    expect(validateNativeToolArgs(schemas, 'read_file', { path: 'a', limit_bytes: 1.5 })).toBe("Argument '$.limit_bytes' for 'read_file' must be integer");
    expect(validateNativeToolArgs(schemas, 'memory_store', { key: 'k', text: 'ক'.repeat(7000) })).toBe("Argument 'text' for 'memory_store' exceeds the 20000 UTF-8 byte limit");
    expect(validateNativeToolArgs(schemas, 'nope', {})).toBe('Unknown tool: nope');
  });

  it('the scan would have caught the old calls', () => {
    const old = evaluate("{ path: 'AGENTS.md', offset_bytes: 0, limit_bytes: 1e7 }", {});
    expect(validateNativeToolArgs(schemas, 'read_file', old, isDyn)).toMatch(/outside its allowed range/);
    const viaConst = evaluate('{ path: f.path, offset_bytes: 0, limit_bytes: MAX_TEXT }', { MAX_TEXT: 400000 });
    expect(validateNativeToolArgs(schemas, 'read_file', viaConst, isDyn)).toMatch(/outside its allowed range/);
  });

  it("agent.html's own screens never read files through the model's read_file tool", () => {
    const uiReads = sites.filter((x) => x.file === 'www/agent.html' && x.tool === 'read_file');
    expect(uiReads.map((x) => `${x.file}:${x.line}`)).toEqual([]);
    const html = readFileSync(join(ROOT, 'www/agent.html'), 'utf8');
    expect(html).not.toMatch(/READ_CHUNK_BYTES/);
    expect(html).toMatch(/workspaceFiles\(\)\.read\(path/);
  });

  it("agent.html's limits: memory equals the engine's, the app's own file reads are far above read_file's", () => {
    const html = readFileSync(join(ROOT, 'www/agent.html'), 'utf8');
    const c = numericConstants(html);
    expect(c.MEMORY_LIST_MAX).toBe(schemas.memory_list.properties.limit.maximum);
    const engineFileMax = Number(/const MAX_FILE_SIZE: u64 = ([0-9_]+);/.exec(rust)![1].replace(/_/g, ''));
    const ws = readFileSync(join(ROOT, 'bridge/workspace-files.ts'), 'utf8');
    const appMax = Number(/WORKSPACE_READ_MAX_BYTES = (\d+) \* 1024 \* 1024/.exec(ws)![1]) * 1024 * 1024;
    expect(appMax).toBeGreaterThanOrEqual(15 * 1024 * 1024);
    expect(appMax).toBeGreaterThan(engineFileMax);
    // The model-facing cap is unchanged.
    expect(schemas.read_file.properties.limit_bytes.maximum).toBe(50000);
    expect(Number(/const MAX_OUTPUT_BYTES: usize = ([0-9_]+);/.exec(rust)![1].replace(/_/g, ''))).toBe(50000);
  });

  it('the schema snapshot covers every built-in tool name in tool_runner.rs', () => {
    const block = /const BUILTIN_TOOL_NAMES[^=]*=\s*\[([\s\S]*?)\];/.exec(rust)![1];
    const names = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(Object.keys(schemas).sort()).toEqual(names);
  });
});
