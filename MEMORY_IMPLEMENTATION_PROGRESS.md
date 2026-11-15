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

## Decision log

(see per-phase sections below)
