# Sub-agents: swarm comms, auto compaction and one navigation — report

Branch `feat/subagent-comms`, off `wip/genui` at `af10088`. Nothing is pushed or merged.

**Result:** every suite green on the final tree — Rust `cargo test --lib` 612 passed / 0 failed / 1 ignored, vitest
444 passed / 1 skipped (31 files), `tsc` clean, all 23 UI suites 100%, Android `verify-abis --strict` and `elfcheck`
pass on four ABIs. **Ready to push: yes** (see section 5 for what push still has to do: the iOS xcframework).

## Commits

| Commit | What |
|---|---|
| `efb049c` | Swarm research and design (`docs/subagents/SWARM_COMMS_DESIGN.md`) |
| `ba3911e` | Swarm engine: topologies, channels, topics, blackboard, request/reply, handoff, gossip, contract net, voting, debate, leader election |
| `307886e` | First progress report (this file, now rewritten) |
| `f5dc1f9` | `spawn_subagent` schema kept compact; the overflow test no longer depends on tool-schema size |
| `cbf0db4` | Opened sub-agent: page header + breadcrumb, one section nav (`docs/subagents/SUBAGENT_UI_REDESIGN.md`) |
| `b1917dd` | Auto compaction for coordination state (`docs/subagents/AUTO_COMPACTION.md`) |
| `e6c6c03` | Swarm UI: Swarm, Topics, Blackboard, Decisions, settings sheet, "How it talks" in spawn / batch / preset dialogs |
| `21c0fa0` | Graph `swarm` block carries allow/deny rules (and handoffs) for the Explorer |
| `42b910a` | Explorer swarm layer: topics, handoffs, rules, roles, live flow, Draw rule |
| `8a76d4e` | Real-engine fixture: the Rust engine's own answers rendered by the Explorer suite |
| `6c14e4d` | Four Android ABI `.so` rebuilt (NDK r27), `shots-swarm.js` |
| `6f39661` | Ordered creation stamps for rank elections; workspace-lock test fix |
| `19c6692` | Four Android ABI `.so` rebuilt for `6f39661`, FFI stamp current |
| `b7e69dc` | vitest: `staging.test.ts` `beforeAll` timeout 120 s (prepare-web takes ~7 s alone, ~15 s under parallel load) |
| `819b2fb` | `list_peers` peer card (role, coordinator, topics); real-engine fixture refreshed |
| `3d1f09f` | Four Android ABI `.so` rebuilt for `819b2fb`, FFI stamp current; iOS xcframework CI job also triggers on this branch |
| (this commit) | Final report |

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
  wait-for-graph deadlock check, versioned blackboard (stale writes conflict; marks reinforce and evaporate).
- **Protocols**: handoff (report follows the chain back, no loops, depth cap), gossip (fanout, seen-set, hop cap),
  contract net (5 award policies), voting (majority, plurality, unanimous, supermajority, quorum), debate (rounds, early
  stop on agreement), leader election (rank or vote, numbered terms, coordinator named in every prompt).
- **Safety**: max hops, per-pair and per-chat message caps, deadlock detection, timeouts, pause, stop all.
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
  - coordinator crown (term in the accessible name), lead / hub / observer badges, swarm facts in the inspector
    (role, can talk to, topics, handoffs in/out, rules);
  - live flow: a dot runs along the edge of each new message or handoff; with reduced motion only the edge lights up;
  - the four layers sit in one "Swarm" menu (checkbox items, remembered) so the chip row stays one line on a phone;
  - **Draw rule**: pick an agent, then another (mouse or keyboard), choose Allow / Deny / both ways in a small dialog,
    saved through the Swarm settings' own `addEdge` → `setCommsConfig`; Esc cancels, a failed save keeps the dialog
    open with the reason.

## 3. Tests

All numbers are from the final tree (after `819b2fb` / `3d1f09f`), on the VM, unless the row says otherwise.

**Rust** (`plugins/native-agent/rust/native-agent-ffi`)

| Check | Result |
|---|---|
| `cargo test --lib` | 612 passed, 0 failed, 1 ignored (611 before the peer-card test; the two flaky-test fixes held over repeated runs) |
| `compact::tests` | 5/5 |
| `real_engine_swarm_snapshot_feeds_the_explorer` | pass; fixture regenerated from the current engine |

**Android native**

| Check | Result |
|---|---|
| `build-android-all-abis.sh --require-binding-match` (NDK r27) | built arm64-v8a, armeabi-v7a, x86_64, x86; Kotlin bindings unchanged |
| `verify-abis.sh --strict` | 4/4 ABIs carry every required library, none missing |
| `elfcheck.py --expect-abi` | pass on all four |
| `ffi-source-stamp.sh check android` | current (crate tree `2b9f566`) |

**Web / TypeScript** (after `npm ci`)

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| vitest | 31/31 files, 444 passed, 1 skipped |
| `build.py` → `www/agent.html` | matches the committed file |

**UI suites** (`tools/agent-html-tests/run-all.sh`, Playwright, DejaVu fonts as in CI, mock engine)

| Suite | Result | | Suite | Result |
|---|---|---|---|---|
| subagents | 156/156 | | r3 | 700/700 |
| subagent-graph-fixes | 68/68 | | vault | 83/83 |
| subagent-advanced | 270/270 | | render | 112/112 |
| subagent-swarm | 120/120 | | genui | 736/736 |
| subagent-swarm-explorer (incl. 10 real-engine checks) | 87/87 | | folders | 344/344 |
| no-null-text | 16/16 | | tools | 95/95 |
| agent-view | 172/172 | | turnbar | 88/88 |
| team-graph | 126/126 | | stream | 200/200 |
| s1 | 206/206 | | controls | 443/443 |
| files | 299/299 | | memory | 373/373 |
| feat | 320/320 | | | |
| ui2 | 550/550 | | | |
| v2 | 392/392 | | | |

Total: 23 suites, 5,956 checks, 0 failures. The VM restarted after `stream`, so `controls` and `memory` ran in a
second `run-all.sh controls memory` on the same tree.

**Audits** (from the previous run; the UI has not changed since): `audit-subagents.js` reports 52 lines, all on
intentionally hidden elements (32 screen-reader texts, 20 native selects under custom dropdowns); no contrast,
unnamed-control or tiny-text findings. At 390 px an opened agent showed three tab rows before, one now (measured in
the DOM).

**Flakes looked into**

- vitest `staging.test.ts`: its `beforeAll` runs a full `prepare-web --target native` (~7 s alone, ~15 s while other
  files run) against vitest's 10 s default hook timeout. Fixed with an explicit 120 s timeout (`b7e69dc`).
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

## 5. Ready to push?

**Yes.** Everything is committed, every suite above is green on the final tree, and the Android `.so` files match the
crate source.

What push still has to do, and what was not tested:

- **iOS**: the committed xcframework predates the swarm engine. It needs macOS, so it is not rebuilt here.
  `ios-agent-xcframework.yml` now runs on pushes to `feat/subagent-comms` and commits the rebuilt xcframework back to
  the branch; check that job after pushing (or run it with workflow_dispatch).
- **Live run**: no UI was driven against a running engine on a device or emulator, and no model was called (section 4).
- Nothing is pushed or merged.
