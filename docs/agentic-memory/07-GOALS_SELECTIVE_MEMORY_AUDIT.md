# 07 — Goal lifecycle, selective memory injection, assembly audit (schema v6)

Branch `wip/genui` (work branch `wip/goals-wip` on top of `2553771`). Everything below is wired into the real agent loop and covered by tests that run through `NativeAgentHandle::send_message`; nothing here is model-driven without validation (ADR-A5).

## 1. Goal lifecycle (`turn_memory/goals.rs`)

- Goals live in their own tables, not in the rolling summary, so a goal changes on the turn it is stated instead of waiting for the 7+7 fold.
- IDs `G001`, `G002`, … per chat, never reused, never deleted. Statuses: `active`, `paused`, `completed`, `cancelled`, `superseded`.
- Every change is an event (`memory_goal_events`) with its turn, origin and evidence:
  - `user_command` — deterministic English/Bengali detector run on each new user message before the model call (no LLM). Questions and negations never complete or cancel a goal.
  - `summary` — `goalOps` from the summarizer, accepted only when the quoted evidence occurs in that turn's user text.
  - `migration` — the old free-text `goal` of a v5 memory (turn 0, text verbatim).
- Status and `current_goal_id` are a replay of the non-voided events in (turn, seq) order, so a late event (from a fold of older turns) lands in its place and cannot overwrite a newer state. An event that would make the history invalid (resume a cancelled goal, complete twice) is rejected and nothing is written.
- Rules: a new goal pauses the active one; switch/resume re-activates the existing ID (no duplicate) and pauses the active one; complete/cancel/supersede are separate terminal statuses set only by explicit words; at most one goal is active and it is the current one; an unrelated question changes nothing.
- Rewind voids (marks, keeps) the events of removed turns and replays; a memory reset voids all events including the migrated one.
- Decisions and open items get an optional `goalId`: the goal that was current at their creation turn, `NULL` when none (never guessed for older records). Superseded decisions keep their link. A goal's status never changes its tasks' status.

## 2. Selective injection (`turn_memory/select.rs`, wired in `agent_loop/memory_loop.rs`)

The memory block is chosen for each request instead of sending the whole memory:

- Always: current goal; decisions in force of that goal or of no goal; its open tasks and open tasks of no goal; current preferences.
- By request: other goals named by ID or title words, with their decisions and tasks; records sharing words with the request; segments matching by topic/title/summary or holding a turn the FTS5 index finds; the newest segment (bridge to the verbatim turns).
- Closed tasks and superseded decisions only when the request asks about history/comparison or names them.
- Everything left out is listed by ID and status ("Not shown here"), reachable with `recall_turns` / `memory_inspect`.
- Token cap = context budget / `MEMORY_BUDGET_DIVISOR` (6), min 500. Optional records are dropped least-relevant first; the always-in layer is never cut.
- Overflow: before compaction touches recent turns, `reselect_smaller` chooses again with a smaller cap; the block is replaced only if it really is smaller. Provider overflow retries therefore drop optional memory first and each retry is smaller (never an identical resend). The existing empty-stream rule is unchanged (empty SSE → non-stream retry; not treated as a confirmed overflow without provider metadata).

## 3. Assembly audit (`turn_memory/audit.rs`)

- One row in `context_assembly_audit` per main model request (each retry attempt too), at most 500 per chat (oldest trimmed). IDs and numbers only, no prompt text.
- Fields: assembly id, provider, model, iteration, attempt, memory version, summarized-through turn, input budget, estimated input tokens, reserved output, included recent turns, included goal / decision / task / memory / segment IDs, retrieval sources, compaction and truncation actions.
- The same record is sent as `audit` inside the `context.assembly` event (tested equal).
- `memory.get` returns the newest 20 records; the Memory screen's Context tab shows the stored one until a live event arrives.

## 4. Retention

`retention.rs` never deleted `turn_archive` rows or the transcript; it replaced unreferenced stored tool results (`R#`) with a short stub. That automatic pruning (after a turn or a rewind) is now opt-in: setting `autoPruneResults` (default `false`, switch in Memory → Settings → Stored results). The manual cleanup (`memory.prune`) is unchanged.

## 5. Database (schema v5 → v6)

One additive migration in one transaction (`store.rs::ensure_tables`): `memory_goals`, `memory_goal_events`, `memory_goal_state`, `context_assembly_audit`; each chat's free-text goal becomes `G001` (`origin = migration`, description verbatim). No table or column is dropped; `goalId`/`key` are optional JSON fields inside the memory document, so old rows load unchanged. A failure inside the step rolls back to v5; the next open retries. Tested on a real v5 database written by the previous build (`turn_memory/fixtures/memory-v5.db`) and on a v1 database.

## 6. UI and bridge

- `memory.get` adds `goals {currentGoalId, goals, events (newest 50, voided ones left out)}` and `audit` (newest 20).
- `57-memory.js`: Goals section (status, current, completed time, history incl. the migrated goal) replaces the old free-text goal line when goals exist; goal tag on decisions and items; "Memory given to the model" section in Context; automatic-cleanup switch.

## 7. Tests

| Test | What it proves |
|---|---|
| `session_continuity_e2e_tests::goals::goal_lifecycle_selective_memory_and_audit_through_the_agent_loop` | 24 user turns through `send_message`: G001→G002 (G001 paused), resume G001 (same ID), complete (completed_at), create+cancel (≠ completed), unrelated turns keep the goal, ≤1 active after every turn; 7+7 folds 1–7 at turn 15 and 8–14 at turn 22, each turn summarized once, 2 versions; originals in archive and transcript; `recall_turns` reads turn 4; R1 not auto-pruned; decision/task goal links; three queries (unrelated / history comparison / paused goal named) get different blocks; every main request has one audit row equal to its event; `memory.get` bridge; a rejected request is retried with a smaller selection keeping the current goal and preferences. |
| `turn_memory::migration_tests` (3) | v5 fixture → v6 (G001 verbatim, data unchanged, no invented links, FTS5, integrity_check, idempotent reopen); interrupted upgrade rolls back and reruns; v1 database. |
| `goals_tests` (16), `select_tests` (10) | detector EN/BN, replay rules, late events, rewind; selection layers, cap, "Not shown". |
| `rewind_keeps_stored_results_unless_auto_prune_is_on` | default: rewind prunes nothing; manual cleanup still works. |
| `tools/agent-html-tests/memory.js::testGoalsAndAudit` | goals list/order/current, goal links, stored + live audit, no horizontal overflow (320 px, 1280 px), switch saves `autoPruneResults`. |

## 8. ADRs added

- **A7 Goals as an event log, not a summary field** — a status that changes on a user command must not wait for the fold; replay makes late summarizer evidence safe and rewind cheap.
- **A8 Deterministic selection** — no embeddings (A1 still holds); request words + goal links + FTS5. A miss is recoverable through the "Not shown" list and `recall_turns`.
- **A4 revised** — the assembly record is also stored (`context_assembly_audit`, IDs/numbers only) so the selection of a past request can be checked after the event stream is gone.

## 9. Known limits

- The goal detector understands explicit commands only ("new goal:", "switch to", "go back to", "mark the goal as done", "cancel the goal", Bengali equivalents); an implicit goal change is not detected until a summary with quoted evidence proposes it.
- Selection by word overlap misses paraphrases (same limit as FTS5 retrieval, see the benchmark); the not-shown list and `recall_turns` are the fallback.
- Not verified with a real provider in this run (mock provider only).
