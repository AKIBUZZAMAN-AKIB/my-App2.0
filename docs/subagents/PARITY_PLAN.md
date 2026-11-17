# Sub-agent parity plan: one professional per-agent view for every agent

Started 2026-11-16 20:50 +06. Branch work: `wip/subagent-parity` → pushed (non-force) to `wip/genui`.
`main` is never touched or merged into. Each phase is built, tested, committed, pushed, and only
marked DONE here after GitHub Actions "Verify" is green for its commit.

## Goal (the user's words, condensed)

- A sub-agent has the same interface as the main agent: everything visible, everything controllable.
- Auto compaction for every agent (engine: done in `9fcf202`).
- No overall-only diagram. Deep control per agent, with separate tabs (Tools, Settings, …) per agent.
- Goals, targets, memory, and every other piece of data must be visible.
- A controlling UI for agent mesh communication and more. Powerful and professional.

## Reference patterns used

- LangGraph Studio / LangSmith: a node opens a side panel with its state, inputs/outputs, and a
  thread view; runs are a tree of spans with tokens, latency, and cost per span.
- OpenAI Agents SDK tracing: trace → spans (agent, generation, tool, handoff, guardrail), each
  span with timing and payload; handoffs drawn between agents.
- Claude Code: sub-agents with their own context window, tool allow-list, model, and system
  prompt; `/context` shows window use; compaction is automatic with a visible summary.
- Cursor: background agents listed with status; each opens to its own chat + changes.

Design rule taken from all four: **one agent = one page with tabs**, the same page for the main
agent and for any sub-agent at any depth; the team view is just another tab (Graph → Team).

## The per-agent view (target)

Opened from: the Agents list (every row, plus a pinned "Main agent" row), the spawn card in a
message, the breadcrumb in a sub-agent chat, and any node in a graph.

Header (sticky): status dot, title, `Level N · model`, breadcrumb `Main agent › a › b`, actions
(Stop / Retry / Open chat). Tab bar: horizontally scrollable, 44 px targets, keyboard arrows,
`role=tablist`. Tabs:

| Tab | Shows | Controls | Engine source |
| --- | --- | --- | --- |
| Overview | task, description, result/error, status, runs, steps, tokens, cost, tool calls, times, parent and children | stop, retry, open chat, delete | `get`, record |
| Chat | the full chat (13-subagent-chat.js) | send, stop, edit, retry, images, version switcher | `message`, `edit`, `retry`, `branches`, `restoreBranch` |
| Tools | allowed tools, per-agent "Always allow", inherited allows, per-tool call counts | allow/revoke per tool | record `tools`, `chatAllows`, `allowTool`, `revokeTool`, `log` |
| Settings | every per-agent control | model, provider, temperature, system prompt, max child depth, memory mode, timeout, token budget, max steps, peer rate limit, compaction on/off + threshold | `configure`, `get.compaction`, `settings` |
| Goals | goals of the agent's session (active/done/cancelled) | create, resume, complete, cancel | `memory.get` / `memory.goal` |
| Memory | stored entries (searchable), what was injected each turn and why, audit | delete, copy to main, clear | `memory` (sub-agent), `memory.get`/`memory.turns` (session) |
| Context | window used / limit, compact-at line, compaction count + history | compaction on/off, threshold | record `contextStatus`, `compactions`, `log` |
| Team | who it can message, hidden / hiddenFrom, live comms timeline | message, broadcast, pause, resume, stop, stopTree, reparent, pause-all-mesh | `comms`, `pause`, `resume`, `stopTree`, `reparent`, `broadcast`, `configure` |
| Activity | tool calls, permissions, errors, compactions, messages, with time and cost | filter | `log` |
| Graph | this agent's own diagram (parent, sub-tree, peers it messaged, tool calls) and the whole team diagram | open a node | `graph`, `log` |

Mobile-first at 390 px: one column, no horizontal page scroll, every control ≥ 36 px high,
light and dark.

## Phases

Each phase: build → relevant Rust tests (`cargo test --lib`), `cargo check` warning-free, clippy
(no new warnings), `tsc`, `vitest`, plugin dist check, the Playwright files it touches plus
`subagents.js` and `subagent-graph-fixes.js` → commit → check no build folders or binaries in the
commit → push non-force to `wip/genui` → Verify green → mark DONE here.

### Phase 1 — Baseline, "null" regression test, first push

- Verify the three local commits (`9fcf202`, `50520f1`, `e5a6765`): full `cargo test --lib`,
  `cargo check` warning-free, clippy, tsc, vitest, plugin dist, the two sub-agent Playwright files.
- Add `tools/agent-html-tests/no-null-text.js` (the file the `appendKids` comment already names): renders every sub-agent surface with records whose
  optional fields are missing (no description, no title, no files, no parent) and fails if any
  text node reads `null`/`undefined`. Must FAIL on the 63fd8bf `agent.html` and PASS now.
- The comment in `agent.html` that named this file is now true.
- Acceptance: all of the above green; push; Verify green.

### Phase 2 — Per-agent view shell + Overview, Tools, Activity

- New module `14-agent-view.js` (`AgentTabs`): scrollable tab bar and tab router inside the
  Agents-panel detail, the same for any sub-agent at any depth. `open({ id, agentTab })` opens a tab
  directly. (A "Main agent" row with the same tabs moves to phase 3, where the main agent's
  settings and context come in.)
- Overview, Tools (allow/revoke per agent), Activity (from `log`, filter by kind).
- Mock: `log`, `chatAllows`, `allowTool`, `revokeTool` in `mock-subagents.js`.
- Test `agent-view.js`: every tab renders for main + depth-1 + depth-3 agents, keyboard tab
  navigation, allow/revoke round-trip, activity filter, no page overflow at 390 px, no `null`,
  no console errors.

### Phase 3 — Settings and Context tabs

- Settings: every `configure` field with validation and a "Use chat default" reset (sends null).
- Context: meter (used / limit, compact-at marker), compaction count, compaction history from the
  log (kind, tokens before → after, reason, time).
- Test: each field round-trips through `configure`; invalid values rejected inline; reset sends
  null; context meter numbers match the record.

### Phase 4 — Team/Mesh and Graph tabs, Main-agent row

- A pinned "Main agent" row in the Agents list opening the same tabs (Settings = chat-wide
  `settings`, Context = the main transcript, Team = the whole chat).

- Team: canMessage / hidden / hiddenFrom editors, live comms timeline (`comms`), message,
  broadcast, pause, resume, stop, stopTree, reparent (with a cycle guard in the UI, the engine
  also refuses).
- Graph: per-agent diagram (parent, sub-tree, peers messaged, tool calls) + team diagram.
- Test: each action sends the right request; timeline updates from a live event; reparent to a
  descendant is refused; the per-agent graph contains only that agent's neighbourhood.

### Phase 5 — Goals and Memory tabs

- Goals: list from `memory.get` (active, done, cancelled) with create/resume/complete/cancel via
  `memory.goal`.
- Memory: sub-agent entries (search, delete, copy to main, clear); for the session: injected
  items per turn and why (`memory.turns`/assembly audit), searchable.
- Rust tests for `memory.goal` (create, resume, complete, cancel, unknown op, bad id).

### Phase 6 — Chat tab completions

- Image attachments from the sub-agent composer reach the engine (`message` with attachments).
- Edit-version switcher backed by `branches` / `restoreBranch` (survives reload).
- Test: attachment payload sent; switcher lists versions and restores one after reload.

### Phase 7 — Real provider run and re-verification

- Free keyless OVHcloud Llama ($0): nested spawn to depth 3, a permission at depth 3, and an
  auto-compaction of a sub-agent past a low threshold.
- Re-verify the original 7 issues and the parent-edge bug, with evidence.
- Update DELEGATION_GRAPH_DESIGN.md and this plan.

### Phase 8 — Phone app

- Find the build pipeline for the bundled engine (`.so` / xcframework) and the bundled UI,
  rebuild if possible here; otherwise write the exact steps.

### Phase 9 — Delivery

- 390 px screenshots of every finished tab, Bengali page with phase status, CI links, tests,
  phone status, and the recommendation on `main` (no merge).

## Status

| Phase | Status | Commit | Verify run |
| --- | --- | --- | --- |
| 1 | DONE (pushed, Verify green) | cd3b3ca | [43900143031](https://github.com/AKIBUZZAMAN-AKIB/my-App2.0/actions/runs/43900143031) |
| 2 | DONE (pushed, Verify green) | 5c0123e | [43900143031](https://github.com/AKIBUZZAMAN-AKIB/my-App2.0/actions/runs/43900143031) |
| 3 | DONE (pushed, Verify green) | 7fa9886 | [43900143031](https://github.com/AKIBUZZAMAN-AKIB/my-App2.0/actions/runs/43900143031) |
| 4 | DONE (pushed, Verify green) | f9dfa4f | [43910817969](https://github.com/AKIBUZZAMAN-AKIB/my-App2.0/actions/runs/43910817969) |
| 5 | built + tested on `feat/subagents-advanced` (local, not pushed): Goals and Memory tabs, `subagent-advanced.js` Goals/Memory checks at 1280 and 390 px | see `git log feat/subagents-advanced` | not run (not pushed) |
| 6 | built + tested on `feat/subagents-advanced` (local, not pushed): images via `attachmentsJson`, Versions dialog over `branches`/`restoreBranch` | see `git log feat/subagents-advanced` | not run (not pushed) |
| 7 | todo | | |
| 8 | Android: all four ABIs rebuilt from the `subagentAdvanced` engine with 16 KB page alignment, `verify-abis --strict` passes. iOS: the xcframework workflow now also runs on `wip/genui` and `feat/subagents-advanced` pushes (needs macOS; not buildable on the Linux VM) | see `git log feat/subagents-advanced` | iOS: runs on first push |
| 9 | todo | | |

## Advanced sub-agents (`feat/subagents-advanced`, engine feature `subagentAdvanced`)

- Spawn: one call runs several agents (`tasks`) as `parallel`, `pipeline` (each step gets the
  previous report) or `race` (first to finish wins, the rest stop); `after` waits on other agents
  and is cancelled when one of them fails; `context: "fork"` starts from the chat's recent
  messages (`forkSession`, `forkUpto`, `forkUserTurns`); `handoff` makes the agent's report the
  main agent's answer.
- Control: `spawnBatch`, `groups`, `moveToChat` (an idle agent with its whole tree), `bulk`
  (stop, stopTree, pause, resume, retry, delete for a whole chat).
- UI: Explorer graph (zoom/pan/pinch/keyboard, two layouts, filters, edge toggles for spawn /
  waits for / messages, batch boxes with the race winner, timeline replay, node inspector with
  every control, chat-wide bulk), New batch dialog, Fork into sub-agent from the message menu,
  Settings title/description/shareable/move to another chat.
- Review mode (generator-critic): a worker and a reviewer; feedback loops until the reviewer's
  last line is `APPROVED` or `rounds` (1-5, default 3) run out.
- UI/UX pass: Graph / Timeline switch (a waterfall of every agent: wait, run time, tokens, tokens
  of the agents below it), minimap, floating zoom controls, auto layout direction that fits the
  panel, a first view that keeps text readable, arrow-key moves between agents, Compare batch
  (reports side by side, winner or approved marked), a resizable and expandable side panel that
  remembers its width; 32 px touch targets on phones, WCAG AA contrast on status text
  (`audit-subagents.js`), screenshots via `shots-subagents.js` on the `demo-seed.js` team.
- CI: the `ui` job in `verify.yml` checks that `www/agent.html` matches its sources and runs every
  Playwright suite (`run-all.sh`), uploading the output.
