# Test & performance report

All results below were produced on branch `feat/agentic-context-memory` in this run. **Every test uses scripted/mock providers (local HTTP mock in `lib.rs::spawn_mock_provider_with`, mock bridge in `tools/agent-html-tests/mock-memory.js`). Nothing was run against a real model provider.**

## Commands, exit codes, counts

| Command | Where | Exit | Result |
|---|---|---|---|
| `cargo test --lib` (run twice on `be043da`) | `plugins/native-agent/rust/native-agent-ffi` | 0, 0 | 471 passed, 0 failed (baseline on `4778059`: 451) |
| `cargo test --lib retrieval_benchmark -- --nocapture` | same | 0 | metrics below |
| `npx vitest run` | repo root | 0 | 31 files, 444 passed, 1 skipped (unchanged from baseline) |
| `bash tools/agent-html-tests/run-all.sh` (16 suites) | repo root | 1 on the first run: `files` and `ui2` could not start (`Cannot find module node_modules/esbuild`; the fresh worktree had no `node_modules`). After linking `node_modules`, `run-all.sh files ui2` → exit 0 | subagents 155/155, s1 206/206, files 299/299, feat 320/320, ui2 550/550, v2 392/392, r3 700/700, vault 83/83, render 112/112, genui 736/736, folders 344, tools 95/95, turnbar 88/88, stream 200/200, controls 443/443, memory 345/345 (baseline 315) |

The known flaky `render` check "320x640 no layout jumps while streaming" passed in this run (112/112); it was not fixed and may fail on a later run.

## New tests (20 Rust tests, 30 UI checks)

| Spec area | Test | What it proves |
|---|---|---|
| Retrieval (§7.2, §15 C) | `turn_memory::fts_tests::*` (8) and `fts::tests` (1) | Bengali words indexed whole, stem query finds inflected word, no false match from fragments; a detail absent from the index found among 300 turns; only summarized turns searched; no cross-chat results; index follows rewind/rewrite/reset; v4 database backfilled; works without the index |
| Agent reachability (§9.2, Phase 4) | `lib.rs::memory_inspect_and_full_text_recall_run_in_the_real_loop` | In the real `run_agent_turn` loop: both tools are offered to the model; `memory_inspect` decisions and search answer; `recall_turns(question)` finds turn 5 through full-text search ("Found by full-text search of the original turns: turn 5") although the only segment points at turn 3, and the recall sub-agent read the original (`saw_zebra=true`); the `context.assembly` record shows the memory block and why |
| Read-only inspection | `turn_memory::inspect::tests` (3) | every section answers, `total_changes()` unchanged (nothing written), decisions show supersede links and reasons, unknown section is an error, another chat sees nothing, output bounded |
| Overflow recovery (§8.4) | `lib.rs::provider_context_overflow_is_compacted_and_retried` | mock returns a real OpenAI-shaped `context_length_exceeded` 400 once; the turn completes; `context.overflow` recorded; retry budget = floor(0.60 × full); retried transcript ≤ budget and smaller than the first; overflow tiers ran; user prompt survives |
| Overflow bound | `lib.rs::provider_context_overflow_gives_up_after_two_retries` | three overflow records (`recovering` true, true, false), three requests, then the provider error ends the turn |
| Overflow classification | `agent_loop::assembly::tests` (3) | OpenAI/Anthropic/Gemini/llama.cpp overflow texts recognised; 429 TPM, rate limit, 401, network not; budget factors; per-source breakdown and memory provenance parsed from the rendered block |
| Large tool results (§8.5) | `tool_runner::tests::grep_pages_through_every_match_with_next_offset` | 137 matches over 3 files → 3 pages of ≤50 via `nextOffset`, all 137 reached, none twice, stable order |
| Benchmark (§15) | `turn_memory::benchmark_tests::retrieval_benchmark` | see below; floors fail the build on regression |
| UI items 4, 11–13 (§11) | `memory.js::testCompareAndContext` (15 checks × 2 viewports) | Compare on every non-current version; LCS diff shows removed/added lines; Context tab empty state, then tokens/window/reserve, memory reason, sources largest-first, compaction actions, reduced-budget explanation, overflow list, last successful summary; no horizontal overflow at 320 px and 1280 px; no console errors |

## Ground-truth retrieval benchmark (measured)

Setup: 400-turn chat, Bengali + English, 48 planted details at known turns (8 exact error codes, 8 names, 8 numbers, 8 Bengali inflected phrases, 8 decisions + their 8 replacements), filler turns that reuse the same vocabulary, and a lossy model-style index (20 segments; summaries mention every other detail). 48 direct questions + 24 paraphrased questions with no shared content word. "Hit" = the turn with the answer is among the turns recall would read.

| Metric | Index only (before) | Full-text only | Merged (now) |
|---|---|---|---|
| Direct questions, hit rate | 41.7 % (20/48) | 100 % top-12, 100 % top-1 | **100 % (48/48)** |
| Exact error codes | 4/8 | — | 8/8 |
| Names | 5/8 | — | 8/8 |
| Numbers | 2/8 | — | 8/8 |
| Bengali inflected (stem in question) | 1/8 | — | 8/8 |
| Replacement decisions | 0/8 | — | 8/8 |
| Original decisions | 8/8 | — | 8/8 |
| Paraphrased questions, hit rate | 29.2 % | — | 37.5 % |
| Average turns read per question | 40.0 | — | 37.2 |

Performance on this VM (debug test build, in-memory SQLite): archiving + indexing 400 turns 56.2 ms; average full-text query 0.27 ms; database 84 pages without the index vs 119 with it after `VACUUM` (+42 %, i.e. about 35 × page size for 400 short turns).

Reading the numbers honestly:
- The "index only" column includes lucky hits from the fallback that reads turns 1–40 when the index has no match.
- Paraphrased questions stay weak (37.5 %): keyword search cannot match a question that shares no word with the answer. This is the one miss class where an embedding index could help; the spec allows vectors only when benchmarks justify them, so this is reported as the evidence for a later decision, not implemented.
- Answer quality (what the recall sub-agent writes) is not measured here: there is no real model in the test run.

## Not executed

- Real-provider tests of any kind (overflow error texts are copied from provider formats, not received live).
- On-device mobile performance (numbers above are from the VM).
- Spec §15 categories that would need a real model for meaningful results (summary faithfulness, contradiction handling by the model) are covered only by the scripted tests that existed before this branch.
