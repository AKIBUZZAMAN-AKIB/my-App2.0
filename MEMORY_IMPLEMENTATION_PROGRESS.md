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

## Phase 2 — transaction safety (P1)

| ID | Status | Files | Summary | Tests | Commit |
|---|---|---|---|---|---|
| P2-1 IMMEDIATE transactions | VERIFIED | `turn_memory/store.rs` | every memory write (`save_version`, `archive_turns`, `store_result`, `reset_memory`, `delete_memory`, `forget_after`, `clear_session`) goes through `write_tx` (BEGIN IMMEDIATE; savepoint when nested); no `unchecked_transaction` left in memory code | `write_tx_rolls_back_on_error_and_composes_as_a_savepoint`, `write_tx_rolls_back_when_the_closure_panics`, `concurrent_result_stores_on_separate_connections_all_succeed` (8 threads x 15, file DB, WAL) | phase-2 |
| P2-2 safe concurrent updates | VERIFIED | `turn_memory/store.rs` | version CAS kept; under IMMEDIATE exactly one of N concurrent savers of the same version wins, the rest get `Conflict` (never a DB error or lost update) | `concurrent_saves_of_the_same_version_have_exactly_one_winner` (5 rounds x 4 threads) | phase-2 |
| P2-3 corrupt JSON (W-11) | VERIFIED | `turn_memory/store.rs`, `agent_loop/memory_loop.rs`, `lib.rs` | `load_memory` falls back to the newest readable version (`recovered_from`), else returns an empty memory flagged `unreadable` (keeps the live version number); the next save copies the unreadable JSON to `turn_memory_quarantine` first; `memory.recovered` event; `memory.get` reports `recoveredFrom`, `unreadable`, `fromNewerBuild` | `w11_*`, `an_unreadable_memory_with_no_good_version_*`, `a_recovered_memory_saves_on_top_of_the_broken_live_row` | phase-2 |
| P2-4 schema versioning | VERIFIED | `turn_memory/store.rs`, `turn_memory.rs` | `memory_meta(schema_version)` = 2; `ensure_tables` is a one-read fast path, upgrade runs once under the write lock; JSON carries `schemaVersion` (`MEMORY_JSON_VERSION` = 2); a memory written by a newer build is read but never overwritten and the turn falls back to sending original turns | `the_schema_upgrade_from_the_first_release_is_additive_and_idempotent`, `a_memory_from_a_newer_build_is_read_but_never_overwritten`, `saved_memories_carry_the_json_format_version` | phase-2 |

Full `cargo test --lib` after Phase 2: exit 0, 397 passed, 0 failed. Clippy: no new warnings in memory code beyond ones present at aea3dbd (one introduced `needless_borrow` fixed).

## Phase 3 — faithful large-result storage (P1)

| ID | Status | Files | Summary | Tests | Commit |
|---|---|---|---|---|---|
| P3-1 keep originals | VERIFIED | `tool_runner.rs`, `agent_loop.rs`, `agent_loop/memory_loop.rs` | `execute_command` and `web_fetch` keep reading past `MAX_OUTPUT_BYTES` up to the capture ceiling when run inside the `ORIGINAL_CAPTURE_BYTES` task-local scope (set by the agent loop only); the model still gets 50 KB; the original travels in a private `_original` field that `take_original` strips before anything reaches the model; the stored result is the full JSON (`storedOriginal: true`, real byte totals, `originalTruncated` if the ceiling was hit); the shown result gets a `fullOutput` pointer to `R<n>` | `command_output_keeps_its_original_inside_the_capture_scope`, `command_output_original_stops_at_the_storage_ceiling_and_says_so`, `outside_the_capture_scope_nothing_extra_is_kept`, `split_capture_reports_the_real_total`, `take_original_*`, `note_original_*`, e2e `a_large_command_output_is_stored_in_full_and_shown_cut` (6,000-line command, ~280 KB stored, tail marker only in storage) | phase-3 |
| P3-2 configurable limit | VERIFIED | `turn_memory.rs` | `MemorySettings.max_stored_result_bytes` (default 8 MiB, clamped 64 KiB..64 MiB); old settings files load the default | `the_stored_result_ceiling_is_a_clamped_setting_with_a_default` | phase-3 |
| P3-3 reliable chunk retrieval / partial extraction | VERIFIED | `turn_memory/results.rs`, `agent_loop/memory_loop.rs` | `ask_result` takes `offset`; when the reader budget ends it states the exact read and unread byte ranges and the offset that resumes; the summarizer's large-result readers get the stored original instead of the cut text (`use_stored_originals`) | `a_partial_read_names_the_unread_range_and_its_offset_resumes_it`, `the_summarizer_reads_the_stored_original_of_a_cut_output`, existing chunk-coverage tests | phase-3 |

Full `cargo test --lib` after Phase 3: exit 0, 407 passed, 0 failed, three consecutive runs.
Test-isolation fix: `a_tool_waits_for_a_resource_another_run_holds_and_then_runs` asserts on the process-wide tool scheduler; a concurrently running shell command (new e2e test) holds the `workspace` lock and showed up in `waitingFor`. Both tests now take a shared static mutex. The one-off failure of the same test seen in Phase 1 (before any new tool test existed) points to the same cause with existing write tests; not reproduced since.

## Decision log

- D1 (Phase 1): a rewind that cuts inside the summarized range resets the summary (as a version, revertible) instead of trying to recompute it; archived turns before the cut are kept. Safest, reversible, matches ADR-6.
- D2 (Phase 1): `write_tx` was introduced in Phase 1 (atomic reset/rewind need composable transactions) and is reused for the Phase 2 IMMEDIATE work.
- D3 (Phase 1): the earlier list fields (`facts`, `preferences`, `files`, `openItems`) stay in the JSON as a mirror of current items so older builds and the existing UI keep working (additive, no migration needed); `items` is authoritative when present.
- D5 (Phase 2): migrations are additive only (new tables `memory_meta`, `turn_memory_quarantine`); no column is dropped or retyped, so an older build still opens the DB (ADR-9). The schema number is never lowered.
- D6 (Phase 2): an unreadable memory with no readable history is summarized again from the transcript (the source of truth) instead of blocking memory forever; the unreadable JSON is preserved in `turn_memory_quarantine`, so nothing is lost.
- D7 (Phase 3): the original is carried by a task-local scope + a private result field rather than changing `execute_tool`'s signature, so every other caller (sub-agents, host APIs) is unchanged and gets no extra memory use. Default ceiling 8 MiB per output (ADR-7), user-configurable.
- D4 (Phase 1): items carried over from the earlier list format whose turn is unknown keep an empty `sourceTurns` rather than a guessed turn.
