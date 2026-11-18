# Sub-agents: swarm comms, auto compaction and one navigation — report

Branch `feat/subagent-comms`, off `wip/genui` at `af10088`. Pushed to GitHub; not merged into any other branch.

**Result:** pushed. The `npm audit` step is fixed with a narrow, dated exception for the one picomatch advisory
that has no patched release (GHSA-fc5q-39xc-vjpf; section 6); every other advisory still fails the build. On
`e5832db` the Verify Web job (audit, `tsc`, vitest 445 passed, config schema, `dist` freshness) and the Rust job pass
on GitHub Actions. The UI job passed every check of this branch's suites both times it ran, but each run had one
pre-existing flaky check in a suite this branch does not touch (`render`, then `stream`); both checks also fail on the
base branch (section 6). Rust `cargo test --lib` 613 passed / 0 failed / 1 ignored, the iOS xcframework rebuilt by CI
and the iOS validation workflow passed, Android `verify-abis --strict` and `elfcheck` pass on four ABIs.

## Commits

| Commit | What |
|---|---|
| `357e06b` | Swarm research and design (`docs/subagents/SWARM_COMMS_DESIGN.md`) |
| `b154c41` | Swarm engine: topologies, channels, topics, blackboard, request/reply, handoff, gossip, contract net, voting, debate, leader election |
| `121c22e` | First progress report (this file, now rewritten) |
| `4eb28c7` | `spawn_subagent` schema kept compact; the overflow test no longer depends on tool-schema size |
| `72c61a2` | Opened sub-agent: page header + breadcrumb, one section nav (`docs/subagents/SUBAGENT_UI_REDESIGN.md`) |
| `d40d3da` | Auto compaction for coordination state (`docs/subagents/AUTO_COMPACTION.md`) |
| `03616d5` | Swarm UI: Swarm, Topics, Blackboard, Decisions, settings sheet, "How it talks" in spawn / batch / preset dialogs |
| `86689ba` | Graph `swarm` block carries allow/deny rules (and handoffs) for the Explorer |
| `5d1623b` | Explorer swarm layer: topics, handoffs, rules, roles, live flow, Draw rule |
| `d28dc31` | Real-engine fixture: the Rust engine's own answers rendered by the Explorer suite |
| `d42879e` | Four Android ABI `.so` rebuilt (NDK r27), `shots-swarm.js` |
| `30ea16e` | Ordered creation stamps for rank elections; workspace-lock test fix |
| `34298bd` | Four Android ABI `.so` rebuilt for `30ea16e`, FFI stamp current |
| `dd0b3f6` | vitest: `staging.test.ts` `beforeAll` timeout 120 s (prepare-web takes ~7 s alone, ~15 s under parallel load) |
| `80ca7a4` | `list_peers` peer card (role, coordinator, topics); real-engine fixture refreshed |
| `7343a97` | Four Android ABI `.so` rebuilt for `80ca7a4`, FFI stamp current; iOS xcframework CI job also triggers on this branch |
| `a2271a4` | Final report (first version) |
| `c87f5f9` | Accuracy audit: Stop all cancels open auctions and votes; an unknown role is refused |
| `75f9018` | Accuracy audit: UI shows what the engine sends; the mock answers like the engine |
| `d417af6` | Accuracy audit: design doc matches what was built |
| `7243370` | Four Android ABI `.so` rebuilt for `c87f5f9`, FFI stamp current |
| `f0019c0` | iOS xcframework rebuilt from the crate by the CI job (author `nativekit-ci`) |
| `025d491` | Report: accuracy audit and CI results |
| `3d4ebee` | Report: mock-vs-engine check count corrected to 16 |
| `ce51f23` | Report: claims checked again; only what a tool result showed is stated |
| `e5832db` | Verify: `npm audit` gate with a dated allowlist for GHSA-fc5q-39xc-vjpf (picomatch only); `scripts/audit-check.mjs` |
| (this commit) | Report: audit exception and the CI results on `e5832db` |

Every commit on this branch except the CI bot's `f0019c0` carries the author AKIBUZZAMAN AKIB
<akibuzzaman999@gmail.com> (the GitHub account's public identity); hashes above are the ones on GitHub.

## 1. Research (summary; full tables in the design docs)

- **Swarm comms** (`SWARM_COMMS_DESIGN.md`): OpenAI Swarm / Agents SDK handoffs, LangGraph Swarm and supervisor /
  hierarchical teams, kyegomez/swarms, Anthropic's multi-agent research system (orchestrator-worker), CAMEL, ChatDev,
  AgentVerse, AutoGen SelectorGroupChat, MetaGPT message pool, FIPA ACL, Contract Net, multi-agent debate (Du et al.),
  voting / quorum, leader election (Bully, Raft terms), gossip, stigmergy / blackboard. Conclusions: the user picks
  orchestrated or decentralised; who-may-talk is data checked by the engine at dispatch, never a prompt; every
  decentralised pattern has a stop condition in code; every agent-to-agent message is a logged, visible event.
- **Opened sub-agent UI** (`SUBAGENT_UI_REDESIGN.md`): GitHub Primer PageHeader / UnderlineNav / Breadcrumbs, GitHub
  Actions, Linear, Vercel, LangSmith, VS Code. Rule they all share: the parent level becomes a breadcrumb and the
  child's sections get exactly one navigation, never two stacked tab rows.
- **Auto compaction** (`AUTO_COMPACTION.md`): Anthropic context editing and server-side compaction, Claude Code
  auto-compact, OpenAI Responses compaction, Letta / MemGPT, LangGraph trimming and summarisation middleware; eight
  design decisions taken from them.

## 2. Design and what was built

### Engine (Rust, `plugins/native-agent/rust/native-agent-ffi/src/subagents/`)

- **Topologies** (9): tree, star, mesh, ring, chain, bus, hierarchical, swarm, custom; per chat, per batch, per spawn;
  a child inherits its parent's. Batch `hub` = star hub or hierarchical lead.
- **User config**: global defaults plus a per-chat overlay; patterns on/off, allow/deny edges (deny wins), who may
  spawn / broadcast / write the blackboard, consensus rule, quorum, auction policy, every limit; 9 built-in presets and
  saved presets.
- **Primitives**: direct message, broadcast, pub/sub topics with history, request/reply with wait, timeout and
  wait-for-graph deadlock check, versioned blackboard (stale writes conflict; each write adds 1 to a mark's strength, which halves every half-life).
- **Protocols**: handoff (report follows the chain back, no loops, depth cap), gossip (fanout, seen-set, hop cap),
  contract net (5 award policies), voting (majority, plurality, unanimous, supermajority, with an optional quorum), debate (rounds, early
  stop on agreement), leader election (rank or vote, numbered terms, coordinator named in every prompt).
- **Safety**: max hops, per-pair and per-chat message caps, deadlock detection, timeouts, pause, stop all (stops every
  agent and cancels open auctions and votes).
- **Peer card** (after A2A's Agent Card, where an agent advertises what it is and what it can do so others can route
  work to it): `list_peers` now gives each peer's swarm role, whether it is the coordinator, and the topics it follows,
  besides name, title, status, description and whether you may message it.
- **Two flaky tests fixed**: `leader_election_by_rank…` was a real bug — two agents spawned in the same millisecond
  tied on `created_at` and "the oldest" was picked by random id; `creation_ms()` now hands out strictly increasing
  stamps. `a_tool_waits_for_a_resource…` now tolerates another parallel sub-agent test holding the process-wide
  `workspace` key. Before: about one failing run in three; after: repeated runs all green.

### Auto compaction

- Transcripts (main chat and each sub-agent) already compacted (`CompactionPolicy`).
- New `subagents/compact.rs` folds coordination state into digests without a model call: topic posts, faded
  blackboard marks, finished auctions / votes / debates / elections / gossip / handoffs, old debate rounds, inboxes and
  steer queues, gatherer and reviewer context (one shared budget, head + tail of long reports), ask_parent history,
  handoff chains. Live votes, auctions and debates never fold. User settings: `compact`, `compactKeep`, `compactAt`,
  `compactContextChars`.

### UI (`tools/agent-html-src/`, built into `www/agent.html`)

- **Opened sub-agent**: one header (`‹ All agents › parent › …`, status, Stop / Try again, ⋯ menu) and one section
  nav (side nav at ≥ 720 px, one row + More below). The Agents-level tabs and the old open-agent row hide while an
  agent is open. Measured in the DOM: before, 3 visible tab rows (390 px: at y = 101, 159, 375); after, 1.
- **Swarm sections** in that same nav: Swarm (topology picture, Live / Paused, Configure, Pause, Stop all, roles,
  activity, compaction state), Topics, Blackboard (versions, conflict on stale edit), Decisions (Market, Votes,
  Debates, Elections). Settings sheet: This chat / Defaults, presets, 9 topology cards, patterns, permissions,
  decisions, limits, compaction thresholds, allow/deny rule editor. "How it talks" in spawn, batch and preset dialogs.
- **Explorer swarm layer** (new in this round, `16-subagent-explorer.js/.css`), only when the engine sends a swarm:
  - topic pills (width fits the name) under the tree, or after it left-to-right, linked to their subscribers, with
    post counts and an accessible name ("Topic research: 4 subscribers, 12 posts");
  - curved handoff arrows with a count; repeat handoffs add up on one arrow;
  - rule edges: allow solid green, deny dashed red with a no-entry mark, two arrowheads for both-ways rules;
    labels are routed clear of every node box (the curve bows further or flips side until its label is clear);
  - who-may-talk lines (quiet dotted); a dense topology (more links than max(10, 1.5 × agents), e.g. mesh) draws
    none and shows one label instead: "Mesh: N links · lines hidden";
  - coordinator crown (term in the accessible name), lead / hub badges, swarm facts in the inspector
    (role, can talk to, topics, handoffs in/out, rules);
  - live flow: a dot runs along the edge of each new message or handoff; with reduced motion only the edge lights up;
  - the four layers sit in one "Swarm" menu (checkbox items, remembered) so the chip row stays one line on a phone;
  - **Draw rule**: pick an agent, then another (mouse or keyboard), choose Allow / Deny / both ways in a small dialog,
    saved through the Swarm settings' own `addEdge` → `setCommsConfig`; Esc cancels, a failed save keeps the dialog
    open with the reason.

## 3. Tests

Numbers are from the tree after the accuracy audit (`7243370`), on the VM, unless the row says otherwise; the UI suite
numbers are from GitHub Actions on that commit (section 6).

**Rust** (`plugins/native-agent/rust/native-agent-ffi`)

| Check | Result |
|---|---|
| `cargo test --lib` | 613 passed, 0 failed, 1 ignored (612 before the audit's stop-all test); the GitHub Actions Rust job also passed |
| `compact::tests` | 5/5 |
| `real_engine_swarm_snapshot_feeds_the_explorer` | pass; fixture regenerated from the current engine (now with a reinforced blackboard mark) |

**Android native**

| Check | Result |
|---|---|
| `build-android-all-abis.sh --require-binding-match` (NDK r27) | built arm64-v8a, armeabi-v7a, x86_64, x86; Kotlin bindings unchanged |
| `verify-abis.sh --strict` | 4/4 ABIs carry every required library, none missing |
| `elfcheck.py --expect-abi` | pass on all four |
| `ffi-source-stamp.sh check android` / `ios` | both current (crate tree `72c8cd3`; iOS rebuilt by CI in `f0019c0`) |

**Web / TypeScript** (after `npm ci`)

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| vitest | 31/31 files, 445 passed |
| `build.py` → `www/agent.html` | matches the committed file |

**UI suites** (`tools/agent-html-tests/run-all.sh` on GitHub Actions, Playwright, mock engine)

| Suite | Result | | Suite | Result |
|---|---|---|---|---|
| subagents | 156/156 | | r3 | 700/700 |
| subagent-graph-fixes | 68/68 | | vault | 83/83 |
| subagent-advanced | 270/270 | | render | 112/112 |
| subagent-swarm | 120/120 | | genui | 736/736 |
| subagent-swarm-explorer (incl. 12 real-engine and 16 mock-vs-engine checks) | 105/105 | | folders | 344/344 |
| no-null-text | 16/16 | | tools | 95/95 |
| agent-view | 172/172 | | turnbar | 88/88 |
| team-graph | 126/126 | | stream | 200/200 |
| s1 | 206/206 | | controls | 443/443 |
| files | 299/299 | | memory | 373/373 |
| feat | 320/320 | | | |
| ui2 | 550/550 | | | |
| v2 | 392/392 | | | |

Total: 23 suites, 5,974 checks, 0 failures, in one CI run.

**Audits** (from the previous run; the UI has not changed since): `audit-subagents.js` reports 52 lines, all on
intentionally hidden elements (32 screen-reader texts, 20 native selects under custom dropdowns); no contrast,
unnamed-control or tiny-text findings. At 390 px an opened agent showed three tab rows before, one now (measured in
the DOM).

**Flakes looked into**

- vitest `staging.test.ts`: its `beforeAll` runs a full `prepare-web --target native` (~7 s alone, ~15 s while other
  files run) against vitest's 10 s default hook timeout. Fixed with an explicit 120 s timeout (`dd0b3f6`).
- r3 at 320 px (two mermaid checks): failed once earlier (698/700) while a cargo build ran beside it. Since then 700/700
  in the full run and 700/700 again run deliberately alongside the four-ABI Android build. Not reproduced, and r3 and
  the mermaid renderer are untouched by this branch, so nothing was changed there.
- render "no layout jumps while streaming": failed in two earlier runs, 112/112 in the final run; pre-existing and
  outside this branch.

## 4. Mock-only caveats

- Every UI suite runs on the mock engine (`mock*.js`), including the Swarm and Explorer suites.
- One step closer to the real engine: `swarm_tests::real_engine_swarm_snapshot_feeds_the_explorer` drives the real
  Rust engine (a real handoff, roles, a rank election, rules, a topic with a post) and asserts every field the
  Explorer reads. With `SWARM_UI_FIXTURE=…` it writes the engine's `list`, `graph`, `swarmState`, `commsConfig` and
  `comms` answers to `tools/agent-html-tests/fixtures-real-swarm.json`; `subagent-swarm-explorer` (testRealEngine)
  renders those answers unchanged. That proves the data contract, not a live run: the UI was not driven against a
  running engine on a device or emulator, and no model was called.
- Live flow and Draw rule were exercised only on the mock.

## 5. Accuracy audit (before the push)

Every swarm feature was checked against the engine code, the docs and this report, and the UI against what the
engine actually sends (the real-engine fixture). Found and fixed:

- **Engine, Stop all** (`c87f5f9`): stopped every agent but left their auctions and votes `open` forever, so the app
  counted them as open decisions and compaction never folded them. They now close as `cancelled`. New test
  `stop_all_closes_open_auctions_and_votes`.
- **Engine, roles** (`c87f5f9`): `setCommsRole` with a role outside member / lead / hub silently cleared the role. It
  is now an error, with a test.
- **Blackboard meter** (`75f9018`): the engine's mark strength is unbounded (each write adds 1, halving every
  half-life); the UI clamped it to 1, so a reinforced mark looked like a fresh one. Now drawn against the strongest
  mark, with the strength in the meter's value and title; a real-engine check covers it.
- **Topics** (`75f9018`): the post author read a mock-only `from` field and showed mock-only `tags`; it now uses the
  engine's `fromName` / `fromId`. Creating a topic that exists said "created"; the engine answers `created: false`,
  and the toast now says it already exists.
- **Debates** stopped by the engine (`stopped`) showed raw text; they now read "Stopped".
- **Explorer role badges**: listed `observer`, `worker` and `coordinator` roles the engine does not have; now only
  lead and hub (the coordinator keeps its crown). The earlier "lead / hub / observer badges" line here was wrong.
- **Mock engine** (`75f9018`): had drifted from the engine (other built-in preset names; maxHops 4, maxHandoffs 3,
  gossipFanout 3 instead of 8, 5, 2; tree topology defaulted to direct + request instead of none; three actions the
  engine does not have; different answer shapes). It now copies the engine's presets, default patterns and limits,
  and answers every action like `channels.rs`. A new `testMockMatchesEngine` compares it to the real-engine fixture so
  it cannot drift silently again.
- **Docs** (`d417af6`, this report): topic and decision histories keep 60 items, not 50; the design doc's Explorer
  plan (blackboard node, vote / bid badges, a Gossip tab, drag to draw) is marked as built differently; voting is four
  rules with an optional quorum, not five rules; commit hashes updated after the author rewrite.

Checked and correct: the 9 topologies and their default patterns, versioned writes and conflicts, decay, the
request/reply deadlock check, handoff limits, gossip fan-out, the five auction policies, the vote tally (including
the two-thirds supermajority and quorum), debates, rank / vote elections, allow / deny rules, the 9 built-in presets,
compaction policy, and `list_peers` peer cards.

## 6. GitHub Actions

Pushed `feat/subagent-comms` (new branch on GitHub, nothing overwritten, nothing merged).

| Workflow | Commit | Result |
|---|---|---|
| iOS agent FFI — rebuild the xcframework from source | `7243370` | success; committed the rebuilt xcframework back as `f0019c0` |
| iOS validation and IPA (dispatched by the job above) | `f0019c0` | success |
| Verify — Rust tests | `7243370` | success |
| Verify — UI | `7243370` | success, 23 suites, 5,974/5,974 |
| Verify — Web | `7243370` | **failure** at `npm audit --audit-level=moderate`; later steps (tsc, vitest, config, dist) skipped |

The audit failure on `7243370`: picomatch advisory [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
("ReDoS through single-branch repeated extglobs", high), updated on 2026-11-17 to cover every version (`<= 4.0.7`)
with no patched release. picomatch comes only through vitest / vite / tinyglobby / fdir (dev dependencies);
`npm audit --omit=dev` reports 0. npm's suggested fix (vitest 3.1.4) leaves 7 vulnerabilities, 2 critical.

**Checked again on 2026-11-18 before adding an exception:** npm's newest picomatch is still 4.0.7 (the `latest` tag;
4.0.6 and 4.0.7 date from 2026-08-24), the advisory's "first patched version" is empty, and upstream
(`micromatch/picomatch`) has only open fix PRs (#257 to #265, opened 2026-11-17) and no new tag after 4.0.7. vitest
5.1.0 and vite 8.3.8 (the newest) both require `picomatch ^4.0.7`, so neither an upgrade nor an npm `overrides`
entry can install a fixed picomatch.

**The exception.** The Verify step now runs `node scripts/audit-check.mjs --audit-level=moderate` instead of
`npm audit --audit-level=moderate`. The script runs `npm audit --json` and fails on every package at or above the
level, the same as before, except:

- the allowlist holds exactly one entry: `GHSA-fc5q-39xc-vjpf`, for the package `picomatch` only, added 2026-11-18,
  with the advisory link and "Remove when picomatch ships a fix";
- a package npm flags only through that advisory (fdir, tinyglobby, vite, vitest) passes; if it carries any other
  advisory, it fails;
- if npm stops reporting the allowlisted ID, the step prints a warning to remove the entry.

The workflow step carries a dated comment with the same link. Checked on the VM: on the current lockfile the step
exits 0 (npm reports 5 packages, all through this advisory); with the allowlist entry replaced by a dummy ID it exits
1 and lists all 5; on a copy of the lockfile with `minimist@1.2.0` added it exits 1 on minimist's two critical
advisories while still skipping picomatch. No new dependency was added.

**Web steps after the audit** (skipped on `7243370`), run on the VM after `npm ci` on `e5832db`: `tsc --noEmit`
0 errors, vitest 31 files / 445 passed, `validate:config` exit 0, and `npm run build` in `plugins/native-agent` leaves
`dist` unchanged. No errors to fix.

**Results on `e5832db`** ([run 44217558079](https://github.com/AKIBUZZAMAN-AKIB/my-App2.0/actions/runs/44217558079)):

| Job | Attempt 1 | Attempt 2 (re-run) |
|---|---|---|
| Web: audit, types, tests, config, dist | success (allowlisted only GHSA-fc5q-39xc-vjpf; vitest 31 files / 445 passed; dist up to date) | success |
| Rust: check, test, binding identity | success | success |
| UI: 23 Playwright suites | failure: `render` 111/112, every other suite 100% | failure: `stream` 198/200, every other suite 100% (`render` 112/112) |

All of this branch's suites passed in both attempts: subagents 156/156, subagent-graph-fixes 68/68,
subagent-advanced 270/270, subagent-swarm 120/120, subagent-swarm-explorer 105/105, agent-view 172/172,
team-graph 126/126, no-null-text 16/16.

The two failing checks are flaky and older than this branch:

- `render` "320x640 dark no layout jumps while streaming": the reply shrinks by about 28 px near a blockquote while
  markdown streams. On the VM, `render` on the base branch's own `www/agent.html` (`af10088`) failed this check in 3
  of 3 runs; on this branch's build it failed 1 of 3 (another run failed a 320px Mermaid check, one passed 112/112).
- `stream` "both big diagrams are drawn in full once finished" (768 and 1366 dark): the second Mermaid diagram is
  left in its live state. The base branch's own Verify run on `af10088`
  ([44051923813](https://github.com/AKIBUZZAMAN-AKIB/my-App2.0/actions/runs/44051923813)) failed on this same check.

This branch does not change the markdown or Mermaid renderer or these two suites (its UI diff is in
`10-subagents`, `14-agent-view`, `16-subagent-explorer` and `17-subagent-swarm`), so neither was changed here; they
are worth fixing on the base branch.

The Verify run for `3d4ebee` (report only) finished: Rust and UI success, Web failed at the old audit step.

## 7. Ready to merge?

Everything is committed and pushed, every check in this branch's suites is green, and the Android and iOS native binaries match the crate
source. The audit step passes with the one documented picomatch exception. The only red CI checks left are the two
pre-existing flaky UI checks above, which also fail on the base branch.

Not tested:

- **Live run**: no UI was driven against a running engine on a device or emulator, and no model was called (section 4).
- Nothing is merged.
