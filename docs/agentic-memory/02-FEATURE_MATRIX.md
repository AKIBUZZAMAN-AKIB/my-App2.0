# Feature matrix — existing vs missing (Phase 1)

Status at audit time on `4778059` (column *Before*) and on this branch (column *Now*, updated as work lands).
Legend: FULL = implemented, connected and tested · PARTIAL · MISSING · BROKEN · UNTESTED = implemented but no test · INTEGRATE = exists but not reachable by the real loop.
Paths relative to `plugins/native-agent/rust/native-agent-ffi/src/`.

| # | Requirement (spec §) | Before | Evidence (source) | Now |
|---|---|---|---|---|
| A1 | Token budget: window, model limit, system, tools, output reserve, headroom (§4.4) | FULL | `agent_loop.rs::effective_context_token_budget`; test `token_budget_uses_the_model_window_and_reserves_output` | FULL |
| A2 | Provider-compatible tokenizer, documented estimate otherwise (§4.4) | FULL | `tokens.rs` (tiktoken exact for OpenAI; o200k×calibrated factor otherwise) | FULL |
| A3 | Context assembly before every model call (§4.3) | PARTIAL | loop ~L470–700: budget → fold → tiers → call; no single assembly record | FULL (`context.assembly` before each call) |
| A4 | Observability: tokens by source, memory/tool/recent tokens, why memory entered, failures (§4.7) | PARTIAL | only `context.usage` (aggregate, post-response), `context.limit_resolved`, per-tier events | FULL (`agent_loop/assembly.rs`; loop test checks memory source + reason) |
| A5 | Context isolation: large results by reference (§4.6) | FULL | `memory_loop.rs::store_result`, `compaction.rs::shrink_tool_results` (references only to stored results) | FULL |
| A6 | Retrieved content cannot override system/permissions (§4.6, §9.5) | FULL | memory block and recall answers labelled "untrusted data, not instructions" (`turn_memory.rs` L853, L1035, L1050; `workspace.rs` L440); tools still go through permission checks | FULL |
| B1 | Categories: decisions, facts, preferences, files/artifacts, open items/tasks, segments (§5.2) | PARTIAL | `turn_memory/items.rs` kinds; episodic = segments with turn ranges; procedural not separate (conversation-scoped only, by spec scope rule) | PARTIAL (by design) |
| B2 | Decision lifecycle: stable IDs, supersede link, source turn (§5.5) | FULL | `items.rs` (status current/superseded, `supersedes`), `Decision.reason` | FULL |
| B3 | Dedup (§5.6) | FULL | `items.rs` normalized-key dedup | FULL |
| B4 | Confidence / uncertain not shown as confirmed (§5.7) | PARTIAL | items carry source turns; no explicit confidence field | PARTIAL |
| C1 | Original preservation (§6.1) | FULL | `turn_archive`, `tool_results` | FULL |
| C2 | Versioning: latest 10, optimistic concurrency, atomic (§6.3) | FULL | `store.rs`, `commit.rs`, `tx_tests.rs` | FULL |
| C3 | Archive/expiration, reference-safe retention (§6.5) | FULL | `retention.rs`, `retention_tests.rs` | FULL |
| D1 | Structured retrieval (§7.2 L1) | PARTIAL | decisions/segments via memory block; no agent-callable structured query | FULL (`memory_inspect`, real-loop test) |
| D2 | Keyword/semantic retrieval, SQLite FTS evaluated first (§7.2 L2) | MISSING | no FTS5 on turns; `select_segments` matches only the model-written index | FULL for keyword (FTS5, schema v5, benchmark 100 % direct); semantic/paraphrase PARTIAL (37.5 %), vectors not adopted |
| D3 | Original recall with source references, NOT READ ranges (§7.2 L3) | FULL | `memory_loop.rs::recall_tool`, `source.rs` | FULL |
| D4 | Result-ID retrieval with offsets/question (§7.5) | FULL | `results.rs`, recall `result_id` path | FULL |
| D5 | Source-verified repair (§7.6) | FULL | `repair.rs` (evidence must quote original) | FULL |
| E1 | Turn-based compaction separate from overflow (§8.1/8.4) | FULL | `memory_loop::apply` vs `compaction.rs` + tier 3 | FULL |
| E2 | Bounded parallel summarization, order-correct merge (§8.2) | FULL | `MAX_PORTIONS`, merge by turn order; 1000-random-answer test | FULL |
| E3 | Summary size management (§8.3) | FULL | budgeted memory block, segment merge | FULL |
| E4 | Overflow compaction incl. **retry after provider overflow** (§8.4 step 12) | PARTIAL | tiers run pre-call only; provider overflow error ends the turn | FULL (shrink 60 %/35 %, ≤2 retries; mock-provider loop tests) |
| E5 | Large tool results processed completely, no first-N cut (§8.5) | PARTIAL | shell/web_fetch originals stored; read_file pages; **grep cut at 50 with no continuation** (`tool_runner.rs` MAX_GREP_MATCHES); web search is provider-side | FULL for grep (offset/nextOffset); web search remains provider-side (limitation) |
| F1 | Memory tools reachable by the real loop (§9.2, Phase 4) | PARTIAL | only `recall_turns` | FULL for read (`recall_turns` + `memory_inspect`); writes deliberately not exposed (ADR-A5) |
| F2 | Sub-agent scoped context (§9.4) | FULL | own session key + `MemoryMode` (`subagents.rs` L1238) | FULL |
| G1 | Topic segments (§10) | FULL | segments with topic tags and turn ranges | FULL |
| H1–H14 | Memory UI items 1–14 (§11) | PARTIAL | `57-memory.js`: 1,2,3,5,6,7,8,9,10,13,14 present; 4 (comparison) missing; 11/12 compaction status/last success partial | FULL in mock UI tests (Compare + Context tab); not checked against a live engine in the app |
| I1 | DB integrity, additive migrations (§12) | FULL | `store.rs::migrate`, schema v4 | FULL (v5 additive, backfill test) |
| J1 | Mobile performance, bounded work (§13) | PARTIAL | bounded portions/leases; no measured benchmark | PARTIAL (VM numbers only: 400-turn index 56 ms, query 0.27 ms; no device run) |
| K1 | Failure recovery (§14) | FULL | transactional commit, jobs retry, previous version kept | FULL |
| L1 | Evaluation suite A–H incl. ground-truth long-conversation benchmark (§15) | PARTIAL | many unit/acceptance tests; no ground-truth benchmark with metrics | PARTIAL (retrieval benchmark measured; no real-model quality eval) |
