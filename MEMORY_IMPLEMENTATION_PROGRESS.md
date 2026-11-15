# Memory architecture implementation progress

Branch: `feat/memory-architecture` (from `origin/wip/genui` @ `aea3dbd`, verified unchanged after `git fetch` on 2026-11-15).
Spec: the seven audit documents (`MEMORY_ARCHITECTURE_AUDIT.md`, `MEMORY_GAP_ANALYSIS.md`, `MEMORY_RESEARCH.md`,
`MEMORY_ARCHITECTURE_PROPOSAL.md`, `MEMORY_IMPLEMENTATION_PLAN.md`, `MEMORY_TEST_STRATEGY.md`, `ARCHITECTURE_DECISIONS.md`).
Crate under test: `plugins/native-agent/rust/native-agent-ffi` (paths below are relative to its `src/`).

Status words: NOT_STARTED / IN_PROGRESS / BLOCKED / IMPLEMENTED / TESTED / VERIFIED.
VERIFIED = the acceptance test(s) named in the row passed in a full-suite run.
All memory tests use scripted models or a hermetic mock provider; no real provider was available, so summary quality
is not evaluated anywhere.

## Baseline (aea3dbd, before any change)

| Suite | Command | Exit | Result |
|---|---|---|---|
| Rust | `cargo test --lib` | 0 | 365 passed, 0 failed |
| TS | `npx vitest run` | 0 | 444 passed, 1 skipped |
| Memory UI | `node tools/agent-html-tests/memory.js` | 0 | 227/227 |
| Other UI suites | `tools/agent-html-tests/run-all.sh` | see Phase notes | first attempt failed: scripts read `/home/sprite/impl/test/mock3.js` (developer path); symlinked and re-run |

## Phase 0 — regression tests for verified defects

| ID | Status | Files | Summary | Tests / result on aea3dbd | Commit |
|---|---|---|---|---|---|
| P0-T1 (W-1) | TESTED | `agent_loop/memory_loop.rs`, `lib.rs` | unit + e2e: a legacy session summary in the stored transcript survives `MemoryFold::finish` and stays visible to the model | `w1_finish_keeps_a_legacy_session_summary_from_the_stored_transcript` FAILED, `w1_a_legacy_session_summary_survives_the_first_memory_turn` FAILED (defect reproduced) | phase-0 |
| P0-T2 (W-2) | TESTED | `turn_memory/regression_tests.rs`, `lib.rs` | re-archiving a rewound turn replaces the stale longer row; `rewind_session` forgets archive + memory after the cut | both FAILED (reproduced) | phase-0 |
| P0-T3 (W-3) | TESTED | `turn_memory/regression_tests.rs` | `db::clear_session` removes all four memory tables | PASSED on aea3dbd: the audit's W-3 claim is wrong for this commit (`db::clear_session` already calls `delete_memory`, but ignores its error and is not one transaction) | phase-0 |
| P0-T4 (W-4) | TESTED | `turn_memory/regression_tests.rs` | facts / open items / files left out of a summary, and the 40-item cap, never drop current items | 3 tests FAILED (reproduced) | phase-0 |
| P0-T5 (W-5) | TESTED | `turn_memory/regression_tests.rs`, `lib.rs` | failed reset leaves memory and archive untouched; `memory.reset` / `memory.revert` refuse during a turn | both FAILED (reproduced) | phase-0 |
| P0-T6 (W-11) | TESTED | `turn_memory/regression_tests.rs` | corrupt live memory JSON falls back to the last good version | FAILED (reproduced); fixed in Phase 2 | phase-0 |
| P0-T7 (invariant) | TESTED | `lib.rs` | stored transcript identical with memory on/off (no overflow) | PASSED | phase-0 |

Reproduction log: `memory-audit/phase0-reproduce.log` (3 passed, 10 failed, exit 101).

## Phase 1 — stop losing data (P0)

| ID | Status | Files | Summary | Tests | Commit |
|---|---|---|---|---|---|
| P1-1 legacy summary (W-1) | VERIFIED | `agent_loop/memory_loop.rs` | `MemoryFold` records how much of the transcript was already stored (`stored`); `finish` keeps every stored message and only drops a memory block / overflow summary created during this turn. The fold keeps messages before turn 1 (the legacy summary) in the view ahead of the memory block. | `w1_finish_keeps_*`, `finish_does_not_store_a_summary_made_for_the_view`, e2e `w1_a_legacy_session_summary_survives_the_first_memory_turn` pass | phase-1 |
| P1-2 archive after rewind (W-2) | VERIFIED | `turn_memory/store.rs`, `lib.rs` | upsert replaces a turn whenever its content differs (length guard removed); new `store::forget_after` deletes archived turns past the cut and resets a summary that covered removed turns; `rewind_session` runs `save_session` + `forget_after` in one transaction | `w2_*` (unit + e2e) pass | phase-1 |
| P1-3 clear (W-3) | VERIFIED | `db.rs`, `turn_memory/store.rs` | `clear_session` deletes messages, session and all `MEMORY_TABLES` in one transaction and no longer ignores the memory error | `w3_*` pass | phase-1 |
| P1-4 atomic reset + in-flight guard (W-5) | VERIFIED | `turn_memory/store.rs`, `lib.rs` | new `write_tx` helper (BEGIN IMMEDIATE, savepoint when nested, rollback on error or panic); `reset_memory` = archive delete + reset version in one transaction; `subagents` refuses `memory.reset` / `memory.revert` while a turn runs | `w5_*` (unit + e2e) pass | phase-1 |
| P1-5 item IDs + lifecycle (W-4) | VERIFIED | new `turn_memory/items.rs`, `turn_memory.rs`, `turn_memory/repair.rs` | `MemoryItem {id F/P/L/O+n, kind, text, status current/done/retired/superseded, source_turns, updated_turn, superseded_by, reason, origin, history}`; summarizer sends `items: {add, update, close}` ops; code carries everything else; earlier-format lists can only add (never remove, never revive a closed item); no list cap; `validate_transition` rejects lost items, reasonless status changes, dangling supersession, revival; legacy lists convert on load (unknown turns stay unknown); the four list fields are mirrored from current items for older builds/UI; repair and revert use items | `w4_*` (3), `items_tests` (10) pass | phase-1 |

Full `cargo test --lib` after Phase 1: 387 passed, 1 failed (`w11_*`, the Phase 2 defect, expected). One run also showed `a_tool_waits_for_a_resource_another_run_holds_and_then_runs` failing once (timing test, unrelated to memory); 3 isolated reruns and the next full run passed.

## Decision log

- D1 (Phase 1): a rewind that cuts inside the summarized range resets the summary (as a version, revertible) instead of trying to recompute it; archived turns before the cut are kept. Safest, reversible, matches ADR-6.
- D2 (Phase 1): `write_tx` was introduced in Phase 1 (atomic reset/rewind need composable transactions) and is reused for the Phase 2 IMMEDIATE work.
- D3 (Phase 1): the earlier list fields (`facts`, `preferences`, `files`, `openItems`) stay in the JSON as a mirror of current items so older builds and the existing UI keep working (additive, no migration needed); `items` is authoritative when present.
- D4 (Phase 1): items carried over from the earlier list format whose turn is unknown keep an empty `sourceTurns` rather than a guessed turn.
