# Agentic context & memory — architecture (Phase 2)

This builds on the existing engine (phases 0–7 of `feat/memory-architecture`, merged in `922160f`). It does not replace it. Only the gaps from the audit are added; everything is conversation-scoped (spec §5.2 scope rule).

## 1. Component architecture

```mermaid
flowchart TB
  subgraph Loop["Main agent loop — agent_loop.rs::run_agent_turn"]
    S[steer + tools list] --> B[Token budget<br/>effective_context_token_budget × overflow factor]
    B --> F[Turn-based fold<br/>memory_loop::apply (once per run)]
    F --> T[Overflow tiers 1→2→3→trim<br/>compaction.rs + continuity summary]
    T --> X[Context assembly record<br/>context.assembly event]
    X --> C[call_with_routing]
    C -- provider overflow error --> O[context.overflow<br/>shrink factor 60% → 35%, retry ≤2]
    O --> B
    C --> R[tool calls]
    R -->|recall_turns / memory_inspect| M
    R -->|other tools| TR[tool_runner.rs]
    TR --> SR[store_result → tool_results R#]
  end
  subgraph M["Memory engine — turn_memory/*"]
    MF[Formation: SUMMARY/PORTION prompts,<br/>items.rs dedup + supersede] --> ST[(SQLite: turn_memory + versions,<br/>turn_memory_items, turn_archive,<br/>tool_results, memory_jobs, repairs,<br/>turn_fts NEW)]
    ST --> RT[Retrieval: segment index + FTS5 (NEW)<br/>→ original turns → recall sub-agent]
    ST --> RP[repair.rs source-verified]
  end
  F --> MF
  ST --> UI[Memory UI 57-memory.js]
  X --> UI
```

ASCII fallback:

```
user msg → [budget] → [fold old turns → versioned summary] → [overflow tiers] → [assembly record] → provider
                ↑                                                                     │ overflow error
                └──────── shrink budget (60%, then 35%), retry ≤ 2 ←──────────────────────────┘
tools → store_result (R#) → references in context; recall_turns(range | result_id | question) → [segment index ∪ FTS5] → originals → answer with turn refs
```

## 2. Memory lifecycle

1. Turn arrives; transcript keeps it verbatim while it is in the recent window.
2. When turns leave the window (turn count / budget), `memory_loop::apply` archives the originals (`turn_archive`), indexes their text in `turn_fts` (NEW, same transaction), and summarizes them (portions in parallel when long; merged in turn order).
3. `items.rs` assigns stable IDs, deduplicates by normalized key, marks replaced decisions `superseded` with a link to the new ID, keeps source turns.
4. Commit is one transaction with an optimistic version check; on conflict it reloads and retries (bounded); on failure the previous version stays (`commit.rs`). Latest 10 versions are kept; revert creates a new version.
5. Retention may drop archived originals only when no current item references them (`retention.rs`); FTS rows follow the archive rows they index.
6. Repair (`repair.rs`) changes memory only with evidence quoted from the original turn and records a repair event.

## 3. Context assembly lifecycle (before every model call)

Order of the existing pipeline mapped to spec §4.3: resolve session → tools list → budget (window − system − tools − output − headroom, × overflow factor) → memory fold (summary replaces old turns; recent turns kept verbatim) → tier 1 (duplicate / large old tool results → references that resolve) → tier 2 (shorten old assistant explanations) → tier 3 (continuity summary of the oldest prefix) → hard trim keeping tool pairs → **assembly record** (NEW) → call.

The assembly record (`context.assembly` event, NEW) carries: provider, model, tokenizer, window, budget, overflow factor and attempt, reserved output, system/tool tokens, transcript tokens split by source (memory block, earlier-session summary, user text, assistant text, tool calls, tool results, references), recent-turn count, memory provenance (version, summarized-through turn, number of decisions in force, why it is present: "turns 1–N were folded"), the compaction actions taken in this call, and the estimate vs. budget. It is emitted *before* the call, so a failed call still has its record.

## 4. Compaction lifecycle

- **Turn-based** (`memory_loop::apply`): semantic, versioned, incremental; runs once per run; never on the in-flight turn.
- **Overflow** (`compaction.rs` + tier 3): mechanical, per call, cheapest first; keeps user instructions, the in-flight tool group, and tool_use/tool_result pairing.
- **Provider overflow recovery** (NEW): when the provider rejects the request as too long despite the estimate, the loop records `context.overflow`, multiplies the budget by 0.60 (second time 0.35), re-runs the same overflow tiers and retries; at most two retries per run, then the original error is returned. The turn-based memory is not touched by this path, so the two kinds stay separate.

## 5. Retrieval lifecycle

`recall_turns(question)` → (a) segment index match (`select_segments`) ∪ (b) FTS5 match over original turn text (NEW; bm25 rank, prefix terms, Bengali-safe tokenizer) → ranges capped by `MAX_RECALL_TURNS` → originals read from `turn_archive` → recall sub-agent answers from originals with turn references; ranges not read are listed as NOT READ; decision status comes from the memory context. `recall_turns(result_id, offset|question)` reads stored tool results. FTS is used only when the index exists; otherwise the old path runs unchanged.

## 6. Agentic orchestration

- The model sees the memory block (summary + decisions in force + segment index) and two tools when the chat has memory: `recall_turns` (originals) and `memory_inspect` (NEW, read-only: decisions current+superseded with links, versions, segments, stored results list, last context assembly numbers).
- Write operations (supersede, revert, repair, compaction) stay app-controlled: the summarizer and repair path decide with source evidence; the user reverts in the UI. Rationale in ADR-A5.
- Sub-agents run under their own session key; they neither read nor write the parent's memory.

## 7. Database changes

One additive migration, schema v4 → v5: `turn_fts` FTS5 virtual table (`session_key UNINDEXED, turn_no UNINDEXED, body`, tokenizer `unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 0`), backfilled from existing `turn_archive` rows. If the SQLite build lacks FTS5, the migration records that in meta and retrieval falls back; nothing else fails. No column or table is dropped. Details: `05-MIGRATION_REPORT.md`.

## 8. Decisions (ADR log for this branch)

- **A1 FTS5 before vectors** — spec §7.2; zero new infrastructure; measured in the benchmark (test report). Vectors rejected until the benchmark shows a miss class FTS cannot fix.
- **A2 Bengali-safe tokenizer** — measured fragmentation of default `unicode61` (audit finding 4); `categories 'L* N* Co Mc Mn'` keeps words whole; prefix queries cover suffixes (`-এর`, `-ে`).
- **A3 Overflow factor, not a new compactor** — reuses the tested tiers; bounded to two retries to avoid loops and cost.
- **A4 Assembly record as an event** — the UI and logs already consume `context.*` events; no new table.
- **A5 No model-driven memory writes** — a model told by injected text to "supersede D3" could corrupt memory; writes stay in code paths that verify against original turns (summarizer merge, `repair.rs`) or in the user's hands (UI revert). The read-only tool gives the agent the inspection it needs.
- **A6 grep continuation** — `offset` arg + `nextOffset` in the result instead of a bigger cap (bounded memory on mobile).

## 9. Research log (adopted / modified / rejected)

| Source | Idea | Decision |
|---|---|---|
| LangChain, "Context engineering for agents" (https://www.langchain.com/blog/context-engineering-for-agents) | write / select / compress / isolate | Adopted as the frame: write = archive+results; select = segment index + FTS; compress = fold + tiers; isolate = references + sub-agent sessions. |
| LangGraph memory concepts (https://docs.langchain.com/oss/python/concepts/memory) | short-term (thread) vs long-term (namespaced store); semantic/episodic/procedural | Modified: only thread (conversation) scope implemented; episodic = segments, semantic = facts, procedural not stored (out of scope rule). |
| LangGraph add-memory (https://docs.langchain.com/oss/python/langgraph/add-memory) | trim / delete / summarize messages | Adopted: summarize old turns, keep recent verbatim; never delete originals (we archive instead). |
| LangGraph context (https://docs.langchain.com/oss/python/concepts/context) | static vs dynamic runtime context | Adopted: system/tools static, memory + recall dynamic per call. |
| SQLite FTS5 (https://www.sqlite.org/fts5.html) | bm25, prefix queries, `unicode61` `categories` option, external content | Adopted bm25 + prefix + `categories`; external-content rejected (archive JSON is not plain text; a small separate table is simpler and consistent inside one transaction). |
| Claude Code / OpenHands paging (cited in `read_budget.rs`) | cap one read, page with offset | Adopted for grep (offset/nextOffset). |
| Prior research log `MEMORY_RESEARCH.md` (memory-audit) | MemGPT-style paging, Anthropic context editing, recursive summarization | Already adopted in phases 0–7; unchanged. |
