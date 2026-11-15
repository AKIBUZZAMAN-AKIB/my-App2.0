# Lifecycles: memory, context assembly, compaction, agentic workflow

Operational detail behind `03-ARCHITECTURE.md`. Paths relative to `plugins/native-agent/rust/native-agent-ffi/src/`.

## 1. Memory lifecycle (per chat)

| Step | Code | Guarantee |
|---|---|---|
| Turn kept verbatim while recent | `agent_loop.rs` transcript | nothing summarized inside the window |
| Turns leave the window → archive | `turn_memory/store.rs::archive_turns` | original JSON kept; full-text row written in the same transaction (`fts::index_turn`) |
| Summarize | `memory_loop::apply`, portions in parallel (`MAX_PORTIONS`), merge in turn order | in-flight turn never summarized |
| Items | `turn_memory/items.rs` | stable IDs, dedup by normalized key, `superseded` + link + turn, decision reason |
| Commit | `turn_memory/commit.rs` | one transaction, optimistic `version`, previous version kept on failure; last 10 versions |
| Revert | UI `memory.revert` | creates a new version; nothing lost |
| Repair | `turn_memory/repair.rs` | only with evidence quoted from the original turn |
| Retention | `turn_memory/retention.rs` | drops archived originals only when unreferenced; index rows follow via trigger |

## 2. Context assembly (before every model call)

Order in `run_agent_turn`: tools list → budget (`effective_context_token_budget`, then `assembly::scaled_budget` after an overflow) → memory fold (once per run) → tier 1 tool-result references → tier 2 shorter old explanations → tier 3 continuity summary → trim keeping tool pairs → **`context.assembly` event** → provider call.

`context.assembly` payload (emitted before the call): `provider`, `model`, `contextWindowTokens`, `transcriptBudgetTokens`, `fullTranscriptBudgetTokens`, `overflowRetry`, `reservedInputTokens` (system + tool schemas), `reservedOutputTokens`, `transcriptTokens`, `estimatedInputTokens`, `bySource{memory, sessionSummary, userText, assistantText, thinking, toolCalls, toolResults, toolResultReferences, images}`, `messages`, `userTurns`, `references`, `memoryPresent`, `memoryVersion`, `memoryThroughTurn`, `memoryReason`, `actions[]` (`tool_results_compacted`, `explanations_shortened`, `continuity_summary`, `trimmed`), `sessionKey`.

Tokenizer: exact tiktoken for OpenAI families; otherwise o200k × per-model factor calibrated from provider `usage` (`tokens.rs`). The estimate can still be wrong on the first call of a model; section 3 covers that case.

## 3. Compaction lifecycle

- **Turn-based (semantic):** section 1. Triggered by turns leaving the window; versioned.
- **Overflow (mechanical):** tiers 1–3 + trim, per call, cheapest first; protects the newest user prompt and the in-flight tool group.
- **Provider overflow recovery (new):** provider error recognised by `assembly::is_context_overflow` → `context.overflow` {`attempt`, `recovering`, `transcriptBudgetTokens`, `nextBudgetTokens`, `estimatedTranscriptTokens`, `error`(≤300 chars), `sessionKey`} → budget × 0.60, then × 0.35 → same tiers → retry. At most two retries, then the provider's error ends the turn. Rate-limit (TPM) errors are not treated as overflow. Turn-based memory is not touched on this path.

## 4. Retrieval lifecycle

`recall_turns`:
- `from_turn`/`to_turn` → originals of that range (≤ `MAX_RECALL_TURNS`).
- `result_id` (+ `offset` or `question`) → stored tool result, paged or searched.
- `question` → `select_segments` (model index) ∪ `fts::search_turns` (top 12, bm25, prefix terms, Bengali-safe tokenizer) → `fts::merge_hits` → originals → recall sub-agent answers from originals with turn references, lists NOT READ ranges. The tool result says which turns came from the index and which from full-text search.

## 5. Agentic workflow

Tools offered to the model when the chat has memory (`agent_loop.rs`, `recall_enabled`):

- `recall_turns` — originals, as above.
- `memory_inspect` (new, read-only) — `section`: `overview` | `decisions` (in force + superseded with replacement and turn) | `items` | `segments` | `versions` | `results` | `search` (+`query`: turns with a highlighted excerpt). Output labelled as data, capped at 8,000 characters, never stored as a result, never writes (tested with `total_changes()`).

Not offered to the model: writes (supersede, revert, repair, compaction requests). Reason (ADR-A5): text inside a tool result or a web page could tell the model to rewrite memory; writes stay in code paths that check original turns, or with the user in the Memory panel.

Sub-agents run under their own session key; `recall_available`/`memory_inspect` read only that key, so a child neither sees nor changes the parent's memory (also checked by `inspect::tests::another_chat_sees_none_of_it` and `fts_tests::search_never_crosses_into_another_chat`).

## 6. UI

Memory panel (`tools/agent-html-src/57-memory.js`) tabs: Summary, History (View / **Compare** / Revert), Turns, Results, **Context** (last assembly record, sources, actions, overflow list, last successful summary), Settings.
