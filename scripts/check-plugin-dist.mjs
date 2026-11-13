#!/usr/bin/env node
// Fails when plugins/native-agent/dist/ no longer matches plugins/native-agent/src/.
//
// dist/ is committed (the app consumes the plugin through a file: dependency),
// and Verify's "dist/ must match src/" step rebuilds it and fails on any diff.
// That step went red on five pushes in a row because src/definitions.ts was
// edited without rebuilding dist/. This runs the same compile into a scratch
// directory, so `npm run check` catches it locally before a push, and it never
// touches the committed files.
//
// Pass --write to rebuild dist/ in place instead of only checking it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins/native-agent');
const committed = path.join(plugin, 'dist/esm');
// Same depth as dist/esm, so the relative `sources` in the .map files match.
const scratch = path.join(plugin, '.dist-check/esm');
const write = process.argv.includes('--write');

// Prefer the plugin's own pinned compiler (what Verify uses); fall back to the
// root one, which emits the same output for this tsconfig.
const tscCandidates = [
  path.join(plugin, 'node_modules/typescript/bin/tsc'),
  path.join(root, 'node_modules/typescript/bin/tsc'),
];
const tsc = tscCandidates.find((p) => existsSync(p));
if (!tsc) {
  console.error('✗ typescript is not installed; run `npm ci` first.');
  process.exit(1);
}

const outDir = write ? committed : scratch;
if (!write) rmSync(path.dirname(scratch), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  execFileSync(process.execPath, [tsc, '-p', plugin, '--outDir', outDir], { stdio: 'inherit' });
} catch {
  console.error('✗ plugins/native-agent failed to compile.');
  process.exit(1);
}

if (write) {
  console.log('✓ plugins/native-agent/dist rebuilt');
  process.exit(0);
}

const list = (dir) =>
  readdirSync(dir)
    .flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? list(full).map((f) => path.join(name, f)) : [name];
    })
    .sort();

const fresh = list(scratch);
const old = existsSync(committed) ? list(committed) : [];
const stale = [];
for (const f of new Set([...fresh, ...old])) {
  const a = path.join(scratch, f);
  const b = path.join(committed, f);
  if (!existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b))) stale.push(f);
}
rmSync(path.dirname(scratch), { recursive: true, force: true });

if (stale.length) {
  console.error('✗ plugins/native-agent/dist is stale relative to src/:');
  for (const f of stale) console.error(`  - dist/esm/${f}`);
  console.error('  Run `npm run build:plugin` and commit the result.');
  process.exit(1);
}
console.log(`✓ plugins/native-agent/dist matches src/ (${fresh.length} files)`);
