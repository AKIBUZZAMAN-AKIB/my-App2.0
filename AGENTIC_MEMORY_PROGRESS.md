# AGENTIC_MEMORY_PROGRESS — living progress file

Branch `feat/agentic-context-memory` from `origin/wip/genui` = `4778059`. Not merged anywhere; `main` and `wip/genui` untouched.
Spec: the user's `Writing.txt` (copy at `/home/sprite/memory-audit/SPEC_Writing.txt`, not committed).
Docs: `docs/agentic-memory/` — 01 audit, 02 feature matrix, 03 architecture (+diagram, ADRs, research log), 04 test & performance, 05 migration, 06 lifecycles (memory / context / compaction / agentic).
Status: NOT_STARTED / IN_PROGRESS / BLOCKED / IMPLEMENTED / TESTED / VERIFIED. VERIFIED = connected to the real loop (or real UI code) and covered by an executed test. All tests are scripted/mock; **no real-provider verification exists**.

## Per-requirement status

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| P0 | Repository audit | VERIFIED | `01-AUDIT_REPORT.md` |
| P1 | Feature matrix | VERIFIED | `02-FEATURE_MATRIX.md` |
| P2 | Architecture, lifecycles, ADRs, research log | VERIFIED | `03-ARCHITECTURE.md`, `06-LIFECYCLE_CONTEXT_COMPACTION_AGENTIC.md` |
| D2 | FTS5 retrieval over original turns, schema v5, Bengali-safe tokenizer | VERIFIED | `turn_memory/fts.rs`; `fts_tests.rs` (8); real-loop test `memory_inspect_and_full_text_recall_run_in_the_real_loop` |
| E4 | Provider overflow recovery (shrink 60 %/35 %, ≤2 retries) | VERIFIED (mock provider) | `agent_loop/assembly.rs`; `provider_context_overflow_is_compacted_and_retried`, `..._gives_up_after_two_retries` |
| A4 | Context assembly record + observability | VERIFIED | `context.assembly` event; asserted in overflow and loop tests; shown in UI Context tab |
| E5 | grep continuation (no first-N cut) | VERIFIED | `tool_runner.rs`; `grep_pages_through_every_match_with_next_offset`; schema snapshot updated |
| F1 | `memory_inspect` read-only tool in the real loop | VERIFIED | `turn_memory/inspect.rs`; inspect tests (3) + real-loop test |
| H4 | UI version comparison | VERIFIED (mock bridge) | `57-memory.js` `compareVersion`/`lineDiff`; `memory.js::testCompareAndContext` |
| H11–13 | UI context/compaction status, last successful summary, overflow failures | VERIFIED (mock events) | Context tab; same UI test |
| L1 | Ground-truth long-conversation retrieval benchmark | VERIFIED (retrieval only) | `benchmark_tests.rs`; metrics in `04-...md` |
| L2 | Answer-quality evaluation with a real model | NOT_STARTED | needs a real provider key and the user's approval of cost |
| J1 | On-device performance | NOT_STARTED | VM numbers only |
| S1 | Semantic (paraphrase) retrieval | BLOCKED by decision | benchmark: paraphrase hit rate 37.5 %; vectors need the user's go-ahead (spec: only when justified) |
| X1 | `subagents.rs::set_settings` reset-on-bad-key bug | NOT_STARTED (out of scope) | noted in audit |

## Decisions taken (reversible, logged)

ADR-A1…A6 in `03-ARCHITECTURE.md`: FTS5 before vectors; `unicode61 categories 'L* N* Co Mc Mn'`; overflow factor instead of a new compactor; assembly record as event (no table); no model-driven memory writes; grep offset paging.

## Tests (real results, this run)

- `cargo test --lib`: exit 0 twice, 471 passed / 0 failed (baseline 451).
- `npx vitest run`: exit 0, 31 files, 444 passed, 1 skipped.
- `run-all.sh`: 14 suites exit 0 on the first run; `files`/`ui2` failed to start (no `node_modules` in the fresh worktree), then exit 0 after linking it (299/299, 550/550). memory 345/345 (baseline 315). render 112/112 (known flaky check not fixed).
- Benchmark: direct hit rate index-only 41.7 % → merged 100 % (48 questions, 400 turns); paraphrase 29.2 % → 37.5 %; 400-turn indexing 56.2 ms; query 0.27 ms; DB +35 pages (84→119).

## Commits (all non-force pushed; remote verified with `git ls-remote` after each)

- `4e93d33` phase 0–2 docs
- `df137d3` FTS5 index + recall
- `3c7e053` assembly record + overflow recovery
- `5813e7b` grep paging
- `2d133f0` memory_inspect + loop test
- `3a994be` retrieval benchmark
- `be043da` UI compare + Context tab
- (this file and docs 04–06: next commit)

## Environment notes for the next run

- Worktree `/home/sprite/acm`; `node_modules` is a symlink to `/home/sprite/genui-merge/node_modules` (same `package.json`); `/home/sprite/impl/test` → `/home/sprite/acm/tools/agent-html-tests`.
- Push with the token inline only; it is never stored.

## Next step

1. User decisions: merge target/PR; real-provider run (overflow error texts, recall quality); whether to add an embedding index for paraphrased questions; `backgroundSummaries` default.
2. If approved: a real-provider smoke test script (one long chat, one forced overflow) and record the results here.
3. Optional: apply the Bengali-safe tokenizer to `doc_index.rs` (documents, outside conversation memory) via its own migration.
