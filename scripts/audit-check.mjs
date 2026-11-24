#!/usr/bin/env node
// npm audit with a narrow, dated allowlist.
//
// Runs `npm audit --json` and fails on every advisory at or above
// --audit-level (default: moderate), exactly like `npm audit --audit-level`,
// except for the advisory IDs listed in ALLOWLIST below. An allowlisted ID is
// skipped only for the package it names; the same ID on another package, and
// every other advisory, still fails the build.
//
// Packages that npm reports only because they depend on an allowlisted
// advisory (for example vite -> picomatch) are skipped with it; a package that
// also carries any other advisory fails.

import { spawnSync } from 'node:child_process';

// Each entry: advisory ID, the one package it applies to, why, and the date it
// was added. Remove an entry as soon as a fixed version can be installed.
// Empty: GHSA-fc5q-39xc-vjpf (picomatch, added 2026-11-18) was removed on
// 2026-11-24 once npm audit stopped reporting it.
const ALLOWLIST = [];

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const argLevel = process.argv.find((a) => a.startsWith('--audit-level='));
const level = argLevel ? argLevel.split('=')[1] : 'moderate';
if (!LEVELS.includes(level)) {
  console.error(`unknown --audit-level: ${level}`);
  process.exit(2);
}
const minRank = LEVELS.indexOf(level);

const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('npm audit did not return JSON:');
  console.error(run.stdout || run.stderr);
  process.exit(2);
}
if (report.error) {
  console.error('npm audit failed:', JSON.stringify(report.error));
  process.exit(2);
}

const vulns = report.vulnerabilities || {};
const ghsa = (url) => (url && url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0]) || null;
const isAllowed = (pkg, url) => ALLOWLIST.some((e) => e.package === pkg && e.id === ghsa(url));

// A package is clean when every advisory it carries is allowlisted and every
// package it is flagged through is clean.
const memo = new Map();
function clean(name, seen = new Set()) {
  if (memo.has(name)) return memo.get(name);
  const v = vulns[name];
  if (!v || seen.has(name)) return true;
  seen.add(name);
  const ok = v.via.every((via) =>
    typeof via === 'string' ? clean(via, seen) : isAllowed(name, via.url),
  );
  memo.set(name, ok);
  return ok;
}

const failing = [];
const allowedHits = new Set();
for (const [name, v] of Object.entries(vulns)) {
  for (const via of v.via) {
    if (typeof via !== 'string' && isAllowed(name, via.url)) allowedHits.add(ghsa(via.url));
  }
  if (LEVELS.indexOf(v.severity) < minRank) continue;
  if (!clean(name)) failing.push(v);
}

for (const e of ALLOWLIST) {
  if (allowedHits.has(e.id)) {
    console.log(`allowlisted ${e.id} (${e.package}, added ${e.added}): ${e.url}`);
  } else {
    console.log(`::warning::${e.id} is allowlisted but npm audit no longer reports it; remove it from scripts/audit-check.mjs`);
  }
}

if (failing.length) {
  console.error(`npm audit: ${failing.length} package(s) at or above "${level}" with advisories that are not allowlisted:`);
  for (const v of failing) {
    const ids = v.via
      .filter((x) => typeof x !== 'string')
      .map((x) => `${ghsa(x.url) || x.source} ${x.title}`)
      .concat(v.via.filter((x) => typeof x === 'string').map((x) => `via ${x}`));
    console.error(`  ${v.name} (${v.severity}, ${v.range}): ${ids.join('; ')}`);
  }
  process.exit(1);
}

const m = report.metadata?.vulnerabilities || {};
console.log(`npm audit: no advisories at or above "${level}" outside the allowlist (npm reported ${m.total ?? 0} total).`);
