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
- **Fix 2, empty SSE stream: DONE.** `OpenAiDriver::stream` treats a stream with no text, no reasoning, no tool call and no `finish_reason` (e.g. only `data: [DONE]`) as empty and asks once more without streaming (`complete_after_empty_stream`); its HTTP error (OVHcloud's real 400) goes to fix 1, and a second empty answer is an error, never an empty turn. A stream that finished (`finish_reason` present) with no text is untouched. Loop tests: empty→non-stream 400→smaller retry→answer; empty-but-finished not retried; empty twice = error. `cargo test --lib`: 481 passed, 0 failed, 1 ignored (2 runs). clippy total unchanged (66).
- **Fix 3, summarizer with free/reasoning models: DONE (code + mock tests; real run below).** New `CompletionRequest::minimal_reasoning`, set only by the summarizer's `RouteTextModel`. Mapped per provider: Kilo/OpenRouter `reasoning: {"effort":"none"}`; OpenAI Chat `reasoning_effort: "low"` and Responses `reasoning.effort: "low"` for reasoning models only; Gemini `thinkingBudget: 0` (2.5 Flash/Lite), `128` (2.5 Pro), `thinkingLevel: "low"` (Gemini 3); OVHcloud and other hosts: nothing sent. A 400/422 naming reasoning/thinking is retried once without the hint; `finish_reason: length` with no JSON is retried once with max_tokens ×2 (8,192–16,384) (`memory.summarizer_retry`). Unknown references in a summary (superseded/supersededBy ids, item update/close/supersede ids) are dropped and logged (`memory.dropped_refs`, `droppedRefs` in the version detail) instead of rejecting; a decision whose `supersededBy` is unknown stays current. Still rejected: lost current decision, revived superseded, coverage gaps, bad turns, self-supersede, double change, invented D-ids in `current`; repairs stay strict. JSON extraction also takes the largest balanced object around prose/reasoning braces. Tests: loop test (length cut → retry with bigger budget → summary with stray "N6" saved), Bengali N6 unit, item drops, JSON extraction, per-provider hint mapping, retry budget. `cargo test --lib`: 489 passed, 0 failed, 1 ignored (2 runs). clippy total unchanged.
- **Fix 4, token estimate vs provider usage: DONE.** Re-checked against the raw smoke bodies: the system prompt and tool schemas were already in the estimate (`reserved_input_tokens` = system + tools; e.g. request 0002: 426 of 431 estimated tokens were the tool schema). The earlier report line saying they were excluded was wrong. The real cause of the 0.57–1.30 spread: ratio-only calibration (50/50 smoothing) cannot represent the fixed tokens a hosted model adds per request (chat template, tool rendering, gateway text), so it swung between requests. Now affine, `ratio × raw + overhead`, fitted on the last 8 requests per provider+model, upper envelope (never below a seen provider count), ratio 0.5–2.5, overhead ≤ 4,096; the overhead is part of `reserved_input_tokens` and `count_tokens`. Replaying the seven real Kilo counts: the old method gave est/actual 0.67–1.22; the new one stays within 7.4 % after the first two requests. No new dependency (tiktoken-rs was already used). Tests: replay test + bounds test. `cargo test --lib`: 491 passed, 0 failed, 1 ignored (2 runs). clippy unchanged.
- **Real-provider re-run (free, keyless, $0): see REAL_PROVIDER_SMOKE_TEST.md §5.** Verified: overflow with streaming on (empty `[DONE]` → non-stream 400 → window 32,768 learned → retry 680 chars vs 142,650 → correct answer; next turn uses the learned window), Bengali summary saved on Kilo and OVHcloud (length retry + dropped stray ids), `recall_turns` FTS hits, context rebuilt from memory, tools/streaming. Not achieved: Kilo's nemotron ignores every reasoning-off control tried; token estimate spread in the live run still 0.57–1.40 (leans high after the first request); OVHcloud streams give no usage.
- **Next steps:** (1) when a summary's superseded entry names a decision created in the same batch, link it instead of dropping (both live runs reported 0 superseded although the port changed 8080 → 9150; the answers were still right); (2) calibration key per actually-served model for auto routes (`kilo-auto/free` serves varying models); (3) request `stream_options.include_usage` for OVHcloud once verified it returns usage; (4) phone performance and real-app UI check still not done.
- **Full checks after all four fixes:** `cargo test --lib` 491 passed / 0 failed / 1 ignored; `npx vitest run` exit 0; `tsc`, `validate:config`, `check:plugin-dist` exit 0; `run-all.sh` all 19 suites pass (memory 345/345, files 299/299, ui2 550/550, genui 736/736 …), `render` 111/112 in the full run (known flaky "no layout jumps while streaming"), 112/112 when re-run alone; clippy 66 warnings, per-file counts unchanged.
