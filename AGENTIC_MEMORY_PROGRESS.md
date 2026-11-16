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
- `eae0a3d` docs 04–06 + this progress file
- next: `PRE_MERGE_REPORT.md` + this update, then the `--no-ff` merge into `wip/genui` (Phase 1 of the next-engineering instructions)

## Environment notes for the next run

- Worktree `/home/sprite/acm`; `node_modules` is a symlink to `/home/sprite/genui-merge/node_modules` (same `package.json`); `/home/sprite/impl/test` → `/home/sprite/acm/tools/agent-html-tests`.
- Push with the token inline only; it is never stored.

## Next-engineering run (16 Nov 2026)

- **Phase 1 (pre-merge review): DONE.** See `docs/agentic-memory/PRE_MERGE_REPORT.md`. Decision: safe for `wip/genui`. Backup tag `backup/wip-genui-pre-agentic-4778059`.
- **Merged** into `wip/genui` as `9a37022` (`--no-ff`, tree == `427c64a`), non-force push, ls-remote checked.
- **Phase 2 (real-provider smoke): DONE, free tiers only, $0.** `docs/agentic-memory/REAL_PROVIDER_SMOKE_TEST.md`. Verified: normal call, tool call + result kept, history across calls, streaming (Kilo `kilo-auto/free` → nemotron-3.5-super-vl:free; OVHcloud Llama-3.3-70B). Real overflow is detected only without streaming. **Failed:** overflow retry does not shrink when the window is unknown, and memory summaries fail on both free models. Harness: `tools/real-provider-smoke/`, ignored test `real_provider_smoke`.
- **Phase 3 (retrieval benchmark): DONE.** `docs/agentic-memory/RETRIEVAL_BENCHMARK.md`. Test R@5: FTS5 0.319, bge-m3 0.672, RRF 0.647 (MRR drops 0.677 → 0.509). LLM answer accuracy not measured (free run stopped at 96/174). No product embedding code.
- Second merge `b78e44b` (harnesses + reports, feature `136325e`). CI "Verify" on `9a37022`: success. `cargo test --lib` with the new ignored smoke test: 471 passed, 1 ignored (3 runs; one earlier run under parallel load had 1 failure that did not repeat).
- **Exact next step:** fix in this order: (1) overflow retry budget from the provider's `maximum context length is N`, (2) treat an empty SSE stream as an error and retry without streaming, (3) summarizer for reasoning/free models (low reasoning effort; drop unknown `superseded` ids instead of rejecting). Then re-run `tools/real-provider-smoke/run.sh OUT ovh_overflow_nostream ovh_bengali kilo_bengali`. After that, extend `tools/retrieval-benchmark/dataset.py` with exact-wording questions and test dense-first + FTS5-for-identifiers.

## Next step (older list, kept for history)

1. User decisions: merge target/PR; real-provider run (overflow error texts, recall quality); whether to add an embedding index for paraphrased questions; `backgroundSummaries` default.
2. If approved: a real-provider smoke test script (one long chat, one forced overflow) and record the results here.
3. Optional: apply the Bengali-safe tokenizer to `doc_index.rs` (documents, outside conversation memory) via its own migration.

## Smoke-test fixes run (16 Nov 2026, branch `feat/agentic-context-memory`)

- **Fix 1, overflow retry from the provider's real window: DONE.** `assembly::parse_overflow_limits` reads the window (and prompt count) from OpenAI/vLLM/OVHcloud, OpenRouter/Kilo pass-through, Anthropic (both forms), Gemini, llama.cpp and Mistral errors. Retry ceiling = window − output − system/tools − max(5 %, 1,024), scaled by provider-count/estimate, never above 95 % of what was rejected; without a window, 60 %/35 % of what was *sent* (not of a fallback budget). The window is remembered per provider + exact model in `.native-agent-learned-limits.json` next to the runtime config (`context_limits.rs`: ≤64 entries, 30-day TTL, dropped when a success accepts more tokens; a smaller catalog value still wins; output capped to window/4). A retry that is not smaller (tokens *and* chars, re-counted with the current meter) is never resent: `context.overflow_unrecoverable` + a clear error. Tests: 4 parser/ceiling units, 2 store units, 3 new loop tests (real OVHcloud body, bare error, cannot-shrink). `cargo test --lib`: 478 passed, 0 failed, 1 ignored (3 runs). clippy: per-file counts unchanged.
