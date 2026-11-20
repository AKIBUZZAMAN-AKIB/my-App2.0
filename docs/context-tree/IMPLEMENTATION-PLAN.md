# Master plan — Agent-managed context tree (`contextTree`, schema v7)

**Repo:** `AKIBUZZAMAN-AKIB/my-App2.0` · **Base:** `48db1fb` (on top of `7b67c8b` + my `subagents` fix)
**Written:** 2026-11-20 · **Audience:** the engineer (human or agent) who will build it
**Companions:** `dynamic-memory-implementation-prompt.md` (the spec), `docs/agentic-memory/*` (existing engine)

---

## 0. বাংলা সারসংক্ষেপ (৫ লাইন)

1. আপনার স্পেক **সঠিক এবং বাস্তবায়নযোগ্য** — আমি কোডে প্রতিটা দাবি যাচাই করেছি; ১৪টার মধ্যে ১২টা হুবহু মিলেছে, ২টা ঠিক করতে হবে (নিচে §1.3)।
2. মূল দর্শন: **আইন (locked core) / সত্য (immutable originals) / দৃষ্টি (AI-managed selection)** — তিন স্তর আলাদা রাখা। এতে memory-poisoning ভয় (`ADR-A5`) আর autonomy দুটোই টিকে যায়।
3. এই প্ল্যানে আপনার স্পেকের **১০ স্টেজ**-কে আরও পরিণত করা হয়েছে: per-category caps, dry-run/plan-commit, differential checklist, cache-friendly prefix, value-score eviction, explainability UI, evaluation harness, drift tests — মোট **৯ স্টেজ + ১২টা অ্যাডভান্সড ডেল্টা**।
4. সময়: পূর্ণ সিস্টেম **~১৮–২৪ dev-day**; ৩ দিনে একটা **vertical slice** (Stage 1–3) দিয়ে "AI নিজের checklist দেখে context ছোট করছে" ডেমো করা যায়।
5. শুরু করার আগে **৫টা সিদ্ধান্ত** দরকার (§19) — বাকিটা আমি নিজেই টেস্ট-সহ করতে পারি।

---

## 1. Verified ground truth (checked in the code, not assumed)

### 1.1 Confirmed anchors

| Claim in the spec | Verified at | Result |
|---|---|---|
| `MEMORY_SCHEMA_VERSION = 6` | `CR/turn_memory/store.rs:33` | ✅ bump to 7 |
| `ensure_tables` is the migration hook | `CR/turn_memory/store.rs:41` | ✅ |
| Feature list returned by `lib.rs` | `CR/lib.rs:905–930` (`turnMemory`, `subagentData`, `crossSession`, `subagentSwarm`, …) | ✅ add `contextTree` |
| App action channel `memory_action` | `CR/lib.rs:2127`, `2160` | ✅ reuse, no new FFI |
| Memory tools registered here | `CR/agent_loop.rs:464` (`recall_turns`), `:466` (`memory_inspect`) | ✅ `ctx_*` go here |
| Request assembled here | `CR/agent_loop.rs:781–893` (assembly record → `CompletionRequest` at `:881`) | ✅ `assemble.rs` hooks before `:881` |
| `TokenMeter::for_model` / `request_overhead` | `CR/tokens.rs:166`, `:285` | ✅ per-model counting |
| `CONTEXT_WINDOW_HEADROOM_TOKENS = 2_048` | `CR/agent_loop.rs:44` | ✅ |
| `keep_recent = 7`, `batch = 7` | `CR/turn_memory.rs:111` | ✅ |
| `MAX_RECALL_TURNS = 200` | `CR/agent_loop/memory_loop.rs:853` | ✅ |
| Scheduler classification `classify → ToolNeeds { read_only, resources }` | `CR/tool_scheduler.rs:33`, `:80` | ✅ lock on `ctx:<session>` |
| Sub-agent delete + event | `CR/subagents/data.rs:295` (`apply_delete`), `:367` (`subagent.deleted`) | ✅ temp/standby GC reuses |
| Rewind/reset hooks | `CR/turn_memory/store.rs:530` (`forget_after`), `:555` (`reset_memory`) | ✅ ctx cleanup rides along |
| Tool groups to mirror | `tools/agent-html-src/40-permissions.js:21–37` — `files, git, shell, web, memory, docs, auto, device, mcp, ui, agents, other` | ✅ port `groupOf()` to Rust |
| UI module numbers in use | up to `57-memory.js` → **58 free**; `build.py` globs `[0-9][0-9]-*.js` | ✅ `58-context-tree.js` |
| Rust test-fn count | 635 `#[test]`/`#[tokio::test]` | ✅ matches "634 pass / 1 ignored" |

### 1.2 Things the spec gets right that are easy to get wrong

* **Originals are already immutable** — `check_segments_append_only`, `check_segment_scope`, `validate_transition` (`turn_memory.rs`), refused segment repairs (`repair.rs:78/101/142`), `immutable_tests.rs`. The tree must *never* route through those paths with temp text (§10.1 of the spec).
* **Long-term memory is host-provided** — `pub memory: Option<Arc<dyn MemoryProvider>>` (`subagents.rs:609`, `:810`), so `ctx_note { long_term: true }` must go through the existing `memory_store` tool path and its approval rule. ✅ spec says this.
* **`subagent.finished` already carries the result** — `render_in_chat` only needs a payload field, no new channel.

### 1.3 Two corrections to the spec (do these before Stage 0)

1. **The baseline is green now.** The spec's Stage 0 and §14 say "expect the 3 known `subagents.js` failures". Those were fixed in `48db1fb` (preset token-cap validation): the suite is **157/157**. → §14 must require **all** UI suites green, and the "known failures" exception disappears.
2. **There is no fake provider to extend — there is a driver trait.** `pub trait LlmDriver { async fn complete; async fn stream }` (`CR/llm_driver.rs:135`). Stage 0 must add a **`ScriptedDriver`** test double (scripted turns + configurable `window`, `max_output`, and overflow rejection), not "extend the fake provider". Everything in §13 depends on it.

### 1.4 New facts that change the design (not in the spec)

| Finding | Where | Consequence for the plan |
|---|---|---|
| **No prompt caching at all** (`cache_control` / cache-creation tokens: zero hits) | whole crate | Mutating the context every step costs a full input pass. No regression today, but: (a) keep a **stable prefix** (system + tools + locked core) so caching can be added later; (b) the checklist must be *cheap*; (c) add a **differential checklist** (delta 4). |
| Token counting is exact only for OpenAI-family; others are calibrated offline; online count exists for Anthropic/Gemini | `tokens.rs`, `lib.rs::count_tokens` | Per-node `tokens_full` can be stale after a model switch → the spec's `~` staleness marker is mandatory, and recalibration must be **background** (never block a turn). |
| Sub-agent records prune at `max_kept` (10–500) on **inactive** records | `subagents.rs:1376–1390` | `temp`/`standby` GC must run **before** this prune, or a temp agent can be evicted without its parent getting the `subagent.deleted { reason: "temp_done" }` bookkeeping. |
| `doc_index.rs` already has FTS5 over whole documents | `CR/doc_index.rs` | The "10,000-page book" plan should point the agent at `search_documents`/`doc_index` for its own written chapters instead of re-reading files. |

---

## 2. North star and invariants

> **The AI may change what it *sees*. It may never change what *happened*, and it may never lose what it *must* know.**

Three layers, one rule each:

| Layer | Content | Mutability | Enforcement |
|---|---|---|---|
| **Law** | `sys/core` (CORE_RULES_PROMPT), memory rules, all `ess/*` | Immutable, always `In` | `Pin::Locked`, `Pin::Policy`; every op returns `{"ok":false,"reason":"locked"}` |
| **Truth** | `turn_archive`, `tool_results`, policy `sum/*`, workspace files | Never written by `ctx_*` | temp summaries are *new nodes*; originals only change state |
| **Seeing** | `In / Note / Temp / Out`, notes, strategy, AI categories, checklist | AI-controlled via `ctx_*` | state machine + ownership + budget + `rev` |

**Invariants (each gets a named test — §17):**

| # | Invariant |
|---|---|
| I1 | `sys/core` + the full essentials block are in **every** assembled request (incl. starved windows, overflow factors 0.60/0.35). |
| I2 | `ctx_*` never mutates an original: `turn_archive`, `tool_results`, `sum/*` are byte-identical after any sequence of ctx actions. |
| I3 | Every number the AI sees comes from the **same** budget module the engine enforces (`budget.rs`), counted with the **active model's** meter. |
| I4 | Nothing is lost: every `Out`/`Temp`/`Note` node resolves again through `ctx_recall` while its source row exists. |
| I5 | Text is data: no prompt, tool result, file, web page or peer message can change the tree; only real tool calls do. |
| I6 | Per-session isolation: an id is valid only in its own `session_key`; cross-session ids return `unknown_id`. |
| I7 | Bounded: per-step/per-turn call limits, per-call op limits, output caps, category depth, tag count, note size, row quotas. |
| I8 | Deterministic under pressure: when the AI does nothing, the safety net evicts in a fixed, logged order. |
| I9 | Feature-off request is **byte-identical** to `48db1fb` for a fixed transcript (golden test). |
| I10 | Crash-safe: any failpoint leaves a loadable tree; mirrors rebuild from the DB, never the reverse. |

---

## 3. Architecture

```
                       ┌────────────────────── agent_loop::run_agent_turn ──────────────────────┐
 user turn ─────────►  │ resolve_context_plan ─► effective_context_token_budget (window)        │
                       │        │                                                              │
                       │        ▼                                                              │
                       │  memory_loop::apply  (policy fold: archive → segment (immutable))      │
                       │        │                                                              │
                       │        ▼                                                              │
                       │  ┌─────────── context_tree::assemble (NEW) ───────────┐               │
                       │  │ indexer::sync → nodes (turn/res/sum/file/ess/agent)│               │
                       │  │ budget::plan   → selectable, locked, used, free    │               │
                       │  │ select         → tree projection of messages       │               │
                       │  │ render         → checklist + resume blocks         │               │
                       │  └───────────────────────────┬───────────────────────┘               │
                       │                              ▼                                       │
                       │   assembly record (context.assembly)  ─►  CompletionRequest (:881)   │
                       │                              │                                       │
                       │        provider overflow? ───┴─► scale 0.60/0.35 → safety net (per-call)│
                       │                              ▼                                       │
                       │            tool calls → ctx_* handler (tools.rs) → store + audit      │
                       └──────────────────────────────────────────────────────────────────────┘
```

**New module (11 files, mirrors the spec, plus two I recommend):**

```
CR/context_tree.rs              pub API, re-exports, feature flag, settings struct
CR/context_tree/model.rs        NodeId, Node, Category, ItemState, Provenance, Pin, Owner, ValueScore
CR/context_tree/store.rs        schema v7, load/save, revisions, mirrors
CR/context_tree/catalog.rs      system-prompt part catalog + CORE_RULES_PROMPT
CR/context_tree/indexer.rs      turn_archive/tool_results/files/essentials/sub-agents → nodes
CR/context_tree/assemble.rs     tree → (system prompt, messages) inside the budget
CR/context_tree/budget.rs       ALL budget math (single source of truth)
CR/context_tree/select.rs       (NEW) selection + eviction algorithm, value score, pins
CR/context_tree/tools.rs        ctx_* definitions + handlers
CR/context_tree/render.rs       checklist (full + differential) + resume block
CR/context_tree/temp.rs         temp summaries (direct + via temp sub-agent)
CR/context_tree/gc.rs           GC, quotas, TTL, crash repair
CR/context_tree/tests/*.rs      unit, property, golden, scenarios
```

**Hook points (exact):**

| Hook | File:line | Change |
|---|---|---|
| Tool registration | `agent_loop.rs:464–466` | `+ context_tree::tools::definitions()` when feature on |
| Assembly | `agent_loop.rs:781` before `:881` | `assemble::project(&messages, &system_prompt, &tree, &budget)` |
| Audit row | `agent_loop.rs:804–860` | add `treeRev`, `selectedIds`, `policyActions` |
| Migration | `turn_memory/store.rs:41` | `context_tree::store::ensure_tables(conn)` |
| Rewind/reset | `turn_memory/store.rs:530`, `:555` | delete `ctx_*` rows for the affected range |
| Sub-agent delete | `subagents/data.rs:295` | emit node tombstone + temp/standby reasons |
| Scheduler | `tool_scheduler.rs:80` | `ctx:<session_key>` locks (read for `ctx_view`) |

---

## 4. Data model (schema v6 → v7, additive only)

```sql
-- tree nodes: an index over existing storage, never a second copy of content
CREATE TABLE IF NOT EXISTS ctx_nodes (
  session_key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, parent TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', ord INTEGER NOT NULL, title TEXT NOT NULL,
  state TEXT NOT NULL, pin TEXT NOT NULL DEFAULT 'none', owner TEXT NOT NULL DEFAULT 'policy',
  tokens_full INTEGER NOT NULL DEFAULT 0, tokens_note INTEGER NOT NULL DEFAULT 0,
  token_model TEXT NOT NULL DEFAULT '', note TEXT, provenance TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, last_used_at INTEGER, loaded_at INTEGER,
  turn INTEGER, rev INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
  temp_of TEXT, content_hash TEXT,
  PRIMARY KEY (session_key, id)
);
CREATE INDEX IF NOT EXISTS ctx_nodes_parent ON ctx_nodes(session_key, parent, ord);
CREATE INDEX IF NOT EXISTS ctx_nodes_state  ON ctx_nodes(session_key, state);
CREATE INDEX IF NOT EXISTS ctx_nodes_lru    ON ctx_nodes(session_key, last_used_at);

CREATE TABLE IF NOT EXISTS ctx_categories (          -- system rows seeded at migration
  session_key TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, title TEXT NOT NULL,
  owner TEXT NOT NULL, ord INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
  cap_tokens INTEGER,                      -- DELTA 2: per-category budget cap
  created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_key, id)
);

CREATE TABLE IF NOT EXISTS ctx_notes (
  session_key TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'notes', state TEXT NOT NULL DEFAULT 'in',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_key, id)
);

CREATE TABLE IF NOT EXISTS ctx_temp_summaries (
  session_key TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, focus TEXT,
  sources TEXT NOT NULL DEFAULT '[]', source_hashes TEXT NOT NULL DEFAULT '[]',
  made_by TEXT NOT NULL,        -- 'model' | 'subagent:<id>'
  tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, id)
);

CREATE TABLE IF NOT EXISTS ctx_strategy_versions (
  session_key TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]', next_step TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (session_key, version)                  -- keep 20, like turn_memory
);

CREATE TABLE IF NOT EXISTS ctx_action_log (           -- "why did this leave context?"
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, at INTEGER NOT NULL,
  turn INTEGER, step INTEGER, actor TEXT NOT NULL,     -- model | policy | user | engine
  tool TEXT, ops TEXT NOT NULL, rev_before INTEGER, rev_after INTEGER,
  tokens_before INTEGER, tokens_after INTEGER, reason TEXT
);

CREATE TABLE IF NOT EXISTS ctx_quotas (
  session_key TEXT PRIMARY KEY, nodes INTEGER NOT NULL DEFAULT 0,
  bytes_notes INTEGER NOT NULL DEFAULT 0, bytes_temp INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

**Quotas (defaults):** ≤ 4,000 nodes/session, notes ≤ 512 KB, temp summaries ≤ 1 MB, ≥ 20 strategy versions, action log ≤ 20,000 rows (trim oldest, keep policy rows 2× longer), GC every 50 turns or on startup.

**Mirrors (transparency, not truth):** `<workspace>/.context/<session-slug>/{strategy.md,notes/<id>.md}` — written atomically after commit, rebuilt from DB if missing (**DB is the source of truth**).

---

## 5. Token accounting (the heart of trust)

`budget.rs` is the only place that computes numbers; everything else asks it.

```
window       = ResolvedContextPlan.context_length_tokens (learned limit > catalog > user cap)
reserve_out  = max_output_tokens for this call
headroom     = 2_048 (CONTEXT_WINDOW_HEADROOM_TOKENS) + TokenMeter::request_overhead
locked       = tokens(sys/core) + tokens(essentials) + tokens(tool schemas)
               + tokens(protected in-flight tool group + newest user prompt)
selectable   = window − reserve_out − headroom − locked          (never < 0)
used_sel     = Σ tokens(nodes in In|Note|Temp) + tokens(checklist) + tokens(resume)
free         = selectable − used_sel
compact_at   = selectable × CompactionPolicy.threshold_percent / 100
warn_soft    = 85% · warn_hard = 100% · force = 115% of compact_at (≤ selectable)
min_selectable = 1_024   → below this: "starved" mode (§8.4)
```

Rules:
* Counting uses `TokenMeter::for_model(provider, model)`; `tokens_full/tokens_note` carry `token_model`. Mismatch ⇒ shown with `~` and recounted (in-context nodes first, then background).
* **Every assembled request is asserted** in tests: `meter.count(request) ≤ window − reserve_out`.
* Octet-level detail (schemas, marker blocks, resume) is counted, not estimated — the spec's `used_sel` formula already includes them; keep the test that proves it.

---

## 6. Prompt catalog (`sys/*`) — parts, locks, groups

`catalog::build()` replaces the single string in `workspace::load_system_prompt` (kept as a thin wrapper so old callers/tests see the same bytes when all default parts are loaded).

| Part id | Source today | Lock | Group |
|---|---|---|---|
| `sys/core` | **new** `CORE_RULES_PROMPT` | **Locked** | — |
| `sys/memory` | `CHAT_MEMORY_PROMPT` (`workspace.rs:439`) | Locked when `contextTree` on | — |
| `sys/ws.{AGENTS,SOUL,IDENTITY,USER}.md` | `WORKSPACE_PROMPT_FILES` | Default | — |
| `sys/ws.{TOOLS,HEARTBEAT,MEMORY}.md` | `WORKSPACE_PROMPT_FILES` | Default | — |
| `sys/vault` | `VAULT_ALIAS_PROMPT` | Default | — |
| `sys/formats` | `chat_tools_prompt(tools)` | Default (only with `ui__` tools) | `ui` |
| `sys/folders`, `sys/large_files` | shared folders / large files prompts | Default | `files` |
| `sys/tool_summaries` | `generate_tool_summaries(tools)` | Default | — |
| `sys/tools.<group>` | **new** per-group usage notes | **OnDemand** | 12 groups from `40-permissions.js` |
| `sys/skills` | **new** catalog (name + 1 line) | Default | `auto` |
| `sys/skill.<name>` | **new** skill body | OnDemand | `auto` |
| `sys/subagents`, `sys/team`, `sys/sessions` | `delegation_prompt`, `team_prompt`/`templates_prompt`, `session_prompt_section` | Default when their tools are offered | `agents` |

**Group parity:** port `groupOf(name, mcpNames)` (`40-permissions.js:25–37`) to Rust and add a **drift test** that fails when the JS and Rust group tables disagree — exactly the pattern that caught the bridge allow-list drift in `ce361d0`. Unloading a part removes **text only**; tool schemas stay registered (approval/scheduler behaviour unchanged).

---

## 7. Tools (`ctx_*`)

Full schemas are in the spec §5.1–5.8; this table is the contract summary, plus the deltas.

| Tool | Kind | Locks | Limits | Deltas I add |
|---|---|---|---|---|
| `ctx_view` | read | `ctx:<sk>` R | `path`, `states`, `depth≤6`, `limit≤200` | **D4** `since_rev` → differential output |
| `ctx_set` | write | `ctx:<sk>` W | ≤12 ops, `expect_rev` | **D3** `dryRun` returns projected budget + per-op `tokens_delta` without committing |
| `ctx_category` | write | `ctx:<sk>` W | depth ≤6, owner `ai` only | **D2** `set_cap` action per category |
| `ctx_summarize` | write | `ctx:<sk>` W | ≤40 ids, 64…4,000 tokens | **D8** preset `focus` templates for book/chapter work |
| `ctx_recall` | read | `ctx:<sk>` R | `MAX_RECALL_TURNS` (200) | `changed_since_read` via `content_hash` |
| `ctx_note` | write | `ctx:<sk>` W + `memory:store` when `long_term` | ≤20,000 chars | `list` supports category filter; notes visible as files |
| `ctx_strategy` | write | `ctx:<sk>` W | ≤12,000 chars, 20 versions | steps parsed from `- [ ]` markdown |
| `ctx_prompt` | write | `ctx:<sk>` W | ≤10 per call | alias of `ctx_set` on `sys/*` |

**Error taxonomy (stable strings, tested):** `locked`, `policy_pinned`, `unknown_id`, `not_owner`, `note_required`, `stale`, `limit`, `would_exceed_budget`, `depth`, `quota`, `unsupported`.

**Token economy (defaults):** `max_ctx_calls_per_step = 4`, `max_ctx_calls_per_turn = 24`, `max_ops_per_call = 12`; identical call in the same step → cached, `"cached": true`, not counted; `ctx_view` output ≤ `clamp(window × 3%, 400, 3000)`.

---

## 8. Selection & eviction

### 8.1 Order of selection
1. `sys/*` with `Locked`, then `Default` (unless AI unloaded).
2. All `ess/*` (policy pinned).
3. `strat/main` if `In`; `sys/resume` if fresh.
4. Newest `keep_recent` turns verbatim (protected).
5. AI-pinned nodes (`Pin::Ai`), oldest pin first if they must be demoted.
6. Nodes by value score (§8.2), highest first, while `free > 0`.
7. Anything that does not fit → `Out` (logged with the reason `budget`).

### 8.2 Value score (deterministic, no ML)
```
score =  w1·recency(last_used_at)      // decay over turns, half-life 40 turns
       + w2·usage(hits)                // times recalled/included, log-scaled
       + w3·kind_weight                // essentials > files > results > turns > temp
       + w4·freshness(created_at)      // newer slightly higher
       + w5·category_cap_pressure      // DELTA 2: over-cap categories drop first
```
Weights live in `ContextTreeSettings` (tunable, tested for monotonicity, never random).

### 8.3 Safety net (deterministic, logged per node as `context.tree_policy_action`)
(a) results → references (existing Tier 1) → (b) unpinned, `Out`-eligible by **lowest score** (oldest `last_used_at`, then largest `tokens_full`) → (c) policy summaries older than the newest 2 → (d) AI pins (oldest first, emit `context.tree_pin_overridden`) → (e) then existing Tier 2/3. **Locked and Policy nodes are never touched.**

### 8.4 Starved mode
`selectable < 1_024` ⇒ send locked + essentials + newest user prompt only, emit `context.tree_starved`, and the resume block instructs the AI to use `ctx_summarize via_subagent` / temp agents. Never drop locked content; never overflow the provider.

### 8.5 Overflow interaction
On provider overflow (`OVERFLOW_FACTORS = [0.60, 0.35]`): re-run the safety net **against the scaled budget only**; the AI's persisted choices are not modified; the per-call selection is written to the audit row (`attempt`), so the next step starts from the persisted tree.

---

## 9. Warnings, resume, continuity

**Thresholds** (of `compact_at`): soft 85% → one notice line; hard 100% → **one chance**: request goes out with `ACTION NEEDED` and `ctx_*` marked recommended; if the next step is still over, the safety net runs.

**Resume block** `[native-agent-resume-v1]` (≤1,500 tokens), emitted once after: app restart · continuing an old session · Tier 3 compaction · a safety-net run that moved ≥25% of selected tokens. Built **only from stored data** (strategy, goals, `ctx_action_log`, `turn_archive` metadata): last task + status · where you were + next step · strategy's first 3 open steps · last 5 context actions with times · what changed (file `content_hash`, sub-agents finished/expired).

---

## 10. Sub-agent lifetimes

| Lifetime | Created by | Ends | Cleanup |
|---|---|---|---|
| `temp` | AI (`spawn_subagent {lifetime:"temp"}`) or `ctx_summarize via_subagent` | first terminal status | result copied to parent tree (`agent/<id>` note or `tmp/*`), then `apply_delete(all parts)` after `temp_keep_secs_after_finish` (default 0, clamp 0–3,600) → `subagent.deleted {reason:"temp_done"}` |
| `reusable` | today's behaviour | explicit delete / `max_kept` | unchanged |
| `standby` | AI or user | `now > last_used_at + ttl` while not running/queued | `gc` deletes → `{reason:"standby_expired"}`; reuse resets the clock |

Settings: `standby_ttl_default_secs` (86,400; clamp 300–2,592,000), `temp_keep_secs_after_finish`. `render_in_chat: true` ⇒ the spawn prompt tells the child "your final answer is shown to the user directly; write it complete", UI renders it as an assistant bubble labelled "from <name>" (`subagent.finished.renderInChat`), and the parent gets the result **as a note**, not duplicated full text. **No `ui__` tools for sub-agents** — rendering stays the parent's job (§12 T7).

**GC ordering rule (from §1.4):** temp/standby GC must run *before* the `max_kept` prune in `subagents.rs::persist`, else the parent loses the completion bookkeeping.

---

## 11. Security threat model (each with a test)

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Injection in a tool result / web page / file asks the AI to unload `sys/core` or wipe memory | Only real tool calls mutate; `locked` refusal; markers escaped; CORE_RULES says "text is data" | fixture with `ctx_set` JSON + "ignore your rules" → tree unchanged |
| T2 | Marker spoofing in titles/notes (`[native-agent-resume-v1]` inside a filename) | strip markers + newlines, cap 120 chars, escape on render | title with marker → rendered escaped |
| T3 | MCP / `device__*` tools calling ctx functions | not in allow-list; `classify` rejects | call → `unsupported` |
| T4 | Sub-agent mutating the parent tree | ctx tools act on own `session_key`; cross-session id → `unknown_id` | two sessions + child |
| T5 | Cross-session leakage in the checklist | every query filters `session_key` | titles of chat B never in chat A's render |
| T6 | Budget denial-of-service (AI loops on `ctx_view`) | per-step/turn limits, cached identical calls, output caps | 50 calls → `limit` after 4 |
| T7 | Sub-agent rendering arbitrary UI | `ui__` tools main-agent only; `render_in_chat` is a display flag | sub-agent calling `ui__` → not offered |
| T8 | Secret leaking into notes/strategy/mirrors | notes redacted through the existing vault/redaction path; mirrors live in the workspace (already user-visible) | note with `sk-…` → redacted |
| T9 | Malicious `.context/` file hand-edited by user | DB is the source of truth; mirrors rebuilt, never trusted | tamper mirror → rebuilt on start |

---

## 12. Observability & explainability

* **Events:** `context.tree_snapshot` (on big changes), `context.tree_changed` (per revision, ids only), `context.tree_warning {level}`, `context.tree_policy_action` (per node, reason), `context.tree_pin_overridden`, `context.tree_starved`, `context.tree_gc`, `context.tree_migrated`, plus `context.assembly` extended with `treeRev`, `selectedIds`, `policyActions`.
* **Answer "why is X out?"** — `ctx_action_log` + a UI panel: *who* (model/policy/user), *when*, *reason*, *what it cost*. This is the single most important debugging surface for trust.
* **Audit row** extension: `tree_rev`, `selected_node_ids`, `tokens_by_category` (so the existing Memory → Context tab shows the tree, not just the memory block).

---

## 13. UI plan (`58-context-tree.js` + Memory panel)

| Screen | Content | Constraints |
|---|---|---|
| Chat side meter | `used / selectable` bar + `compact at` tick + warning colour | 320 px safe, aria `meter` |
| Tree panel | categories → nodes, tokens, state chip (`in/note/temp/out`), pin, actions | own scroll box; no page-level sideways scroll; rows virtualised >200 |
| Node sheet | why in/out, provenance (turn/call/file range), hash changed?, "recall", "note only", "exclude", "pin" | 44 px targets |
| Sub-agent lifetime controls | temp/reusable/standby + TTL + `render_in_chat` | reuse existing sub-agent editors |
| Settings | enable, thresholds, limits, TTL defaults, quotas | defaults locked-safe |
| Explain | "why out" list from `ctx_action_log` | read-only |

Tests: `tools/agent-html-tests/context-tree.js` + `mock-context-tree.js` (fake engine advertising `contextTree`), added to `run-all.sh` `NAMES`; 320/360/390 + desktop, light/dark, no console errors, screenshots; plus a fallback test with the **old** mock (flag absent → today's UI).

---

## 14. Performance & mobile budgets

| Budget | Target | How |
|---|---|---|
| Assembly overhead | ≤ 15 ms per model call (1,000 nodes) | in-memory tree per turn, SQLite read once (`indexer::sync` diff only) |
| `ctx_view` | ≤ 20 ms | indexed reads, caps |
| GC | ≤ 50 ms, off the reply path | batched, at startup/turn boundaries |
| Tokens for the checklist | ≤ 3% of window (cap 3,000) | differential render (D4) after the first step |
| DB growth | nodes ≤ 4k/session; log trimmed | quotas + retention |
| Crash recovery | tree loads in ≤ 100 ms | single transaction per revision, WAL |

---

## 15. Migration, compatibility, rollback

1. `migrate` v6 → v7 in one transaction: create tables, seed system categories, backfill nodes from `turn_archive`/`tool_results`/segments **lazily** (a bounded first pass, the rest on demand — never block a turn).
2. Old code opening a v7 DB: `stored_schema_version >= MEMORY_SCHEMA_VERSION` short-circuits (`store.rs:42`), tables are additive ⇒ safe (test it).
3. `contextTree.enabled = false` ⇒ **golden byte-identical request** test (fixture committed in Stage 0).
4. Rollback: flag off; rows remain (harmless); a `ctx_reset` action drops all `ctx_*` rows for a session.

---

## 16. Stage plan (each stage = code + tests + docs row + one commit)

| Stage | Deliverable | Files | Tests | Est. | Risk |
|---|---|---|---|---|---|
| **0** | Baseline green + `ScriptedDriver` (configurable window, overflow rejection) + golden fixture | `CR/tests/support/scripted.rs`, fixture | all suites; driver tests | 0.5 d | low |
| **1** | `model` + `store` + **schema v7** + `indexer::sync` (read-only) + settings + GC skeleton | `model.rs`, `store.rs`, `gc.rs`, `turn_memory/store.rs` | migration, idempotent sync, failpoints, rewind cleanup | 2 d | med |
| **2** | Prompt catalog + `sys/tools.<group>` + skills catalog + `CORE_RULES_PROMPT` + **group drift test** | `catalog.rs`, `40-permissions.js` port | byte-identical wrapper, per-part tokens, lock refusals | 2 d | low |
| **3** | `budget` + `assemble` + checklist render + audit extension (**vertical slice**: AI sees the tree) | `budget.rs`, `assemble.rs`, `render.rs` | budget units, I1 property, golden off, request ≤ window | 2.5 d | **high** |
| **4** | `ctx_view`, `ctx_set` (+dryRun), `ctx_category`, `ctx_prompt`, `ctx_recall`, locks, limits, caching | `tools.rs`, `select.rs` | every transition, ownership, stale, injection, limits | 3 d | med |
| **5** | `ctx_note`, `ctx_strategy`, `ctx_summarize` (direct), mirrors, quotas | `temp.rs` | originals byte-identical, delete restores, mirror rebuild | 3 d | med |
| **6** | Warnings, safety net, resume block, starved mode | `render.rs`, `select.rs` | ignored vs obeyed, deterministic order, restart resume | 2 d | med |
| **7** | Sub-agent lifetimes + `render_in_chat` + `via_subagent` summarize + GC ordering | `subagents.rs`, `advanced.rs`, `data.rs` | temp crash cleanup, standby fake clock, old JSON loads | 2 d | med |
| **8** | Bridge + UI + mock engine + UI suite | `bridge/nativekit.ts`, `58-context-tree.js`, `mock-context-tree.js`, `run-all.sh` | vitest, UI 4 widths × 2 themes, fallback | 3 d | med |
| **9** | Scenarios (8), docs, progress rows, final full CI run | `tests/scenarios.rs`, `docs/` | end-to-end, real counts reported | 1.5 d | low |

**Total ≈ 21.5 dev-days** (critical path: 1 → 2 → 3 → 4; 5/6/7 partly parallel).
**3-day vertical slice:** Stage 0 + Stage 3 minimal (budget + assemble + read-only checklist, no writes) → the AI already *sees* its real window and can report it.

---

## 17. Test matrix (nothing is "done" without a row here)

| Layer | What | Where |
|---|---|---|
| Unit | budget math, state machine, ownership, category depth, scoring, TTL clamps | `context_tree/tests/*` |
| Property | I1 (locked always present) over random trees × budgets × overflow factors | `proptest`-style loop (no new dep: seeded RNG) |
| Golden | feature-off byte-identical request | `tests/golden_request.json` |
| Injection | T1–T9 fixtures | `tests/security.rs` |
| Race | `expect_rev` stale, memory worker writing mid-step, apply-twice idempotency | `tests/races.rs` |
| Crash | failpoints: after commit/before reply, mid temp-run, mid GC | `tests/crash.rs` |
| Scenarios | 8 end-to-end (book 10k pages, overflow, ignored/obeyed, restart, temp cleanup, standby, isolation, range purity) | `tests/scenarios.rs` |
| Regression | `immutable_tests.rs`, `turn_memory/*_tests.rs` unchanged and passing | existing |
| UI | `context-tree.js` suite + fallback | `tools/agent-html-tests/` |
| CI | add `context-tree` to `run-all.sh` NAMES; keep `verify.yml` gates; honest counts in the report | `.github/workflows/verify.yml` |

**Baseline to beat (measured today):** `subagents.js` 157/157 · 635 Rust test fns · vitest green · 24 UI suites green.

---

## 18. Beyond the spec — 12 advanced deltas I recommend

| # | Delta | Why it makes the system *more* advanced | Cost |
|---|---|---|---|
| **D1** | Stable-prefix layout (system + tools + locked core first, mutable memory last) + `cacheable_prefix_tokens` in the audit | The engine has **no prompt caching today**; this costs nothing now and is the prerequisite for enabling provider cache later | 0.3 d |
| **D2** | **Per-category token caps** (`ctx_category set_cap`) | Turns a global budget into an *engineered* one ("notes ≤3k"), which is how humans actually allocate attention | 0.7 d |
| **D3** | `ctx_set {dryRun:true}` plan→commit | The AI can *reason* about its context before spending a revision; kills most `would_exceed_budget` retries | 0.4 d |
| **D4** | Differential checklist (`since_rev`) | Cuts the checklist to ~40% of its tokens after step 1 — critical in 8k windows | 0.5 d |
| **D5** | Value score with usage statistics (§8.2) | Eviction becomes "least valuable", not just "least recent" | 0.6 d |
| **D6** | Cost meter (`~$0.004/step` from a local price table) in the checklist | Makes the AI cost-aware; pure JSON, no network | 0.4 d |
| **D7** | Tree snapshot + restore tied to memory versions | Time-travel debugging; "why did it forget on turn 30?" | 0.6 d |
| **D8** | Book/long-task recipe + presets (`book/` files, chapter categories, note templates) | Makes the "10,000 pages" scenario reproducible instead of aspirational | 0.5 d |
| **D9** | `ScriptedDriver` + metrics harness (no-overflow rate, tokens/task, continuity score) | Turns the engine into something you can *optimise*, not just hope works | 1 d |
| **D10** | "Why is this out?" explain panel (UI) | Trust: the user can audit every eviction | included in Stage 8 |
| **D11** | Startup repair matrix (mirrors, orphan `temp_of`, tombstones) | Mobile reality: the app is killed mid-write | included in Stage 1 |
| **D12** | Drift tests (catalog ↔ `GROUPS`, bridge allow-list, mock ↔ engine tool names) | This repo has been bitten twice by drift; make it impossible | 0.4 d |

---

## 19. Decisions I need from you before Stage 1

1. **Default on or off at Stage 3?** (spec says `true` after Stage 3, `false` before). Recommendation: `true` only after Stage 6, so users never see warnings without a safety net.
2. **May the AI delete its own notes/temp summaries automatically?** (spec: yes for temp/notes; verified layer never). Recommendation: yes for `temp`, and for `notes` only those it created in the same turn — plus a 30-day recycle bin.
3. **Per-category caps (D2)** — include in Stage 4 or defer? Recommendation: include (it's what makes the checklist usable at 8k).
4. **`render_in_chat` default** — off (only when asked) or on for temp summarizers? Recommendation: off for temp (they're plumbing), on only by explicit `render_in_chat: true`.
5. **Standby TTL default** — 1 day (spec) or 7 days? Recommendation: 1 day on mobile storage, 7 days if the user marks the agent `reusable`.

---

## 20. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Assembly regression breaks normal chats | med | **high** | I1 property test + feature-off golden + staged flag |
| R2 | `rev` races (memory worker writes between render and `ctx_set`) | **high** | med | `expect_rev` + stale refusal + race tests |
| R3 | Checklist overhead hurts small windows | med | med | D4 differential + 3% cap + soft fallback to a single line |
| R4 | Indexer drift (nodes point at deleted rows) | med | med | lazy validation on read + GC sweep + `unknown_id` |
| R5 | GC deletes a running/queued agent | low | **high** | TTL check excludes `running`/`queued`; test |
| R6 | Prompt-cache miss if enabled later | — | med | D1 prefix layout from day one |
| R7 | Token counts wrong after model switch | med | med | `token_model` + background recount + `~` marker |
| R8 | User confusion ("why did it forget?") | med | med | D10 explain panel + resume block |
| R9 | Mobile storage growth from notes/temp | low | med | quotas + GC + mirror cleanup |
| R10 | Scope creep (semantic retrieval sneaks in) | med | med | FTS5 only (existing decision A1/A8); vectors need a benchmark first |
| R11 | CI time explodes (new UI suite) | med | low | `context-tree.js` kept ≤ 2 min; run in the same `ui` job |
| R12 | Native rebuilds needed for iOS/Android | **high** | low | note in the report: `native-agent-ffi.yml` dispatches builders; no crate deps added |

---

## 21. Definition of done (superset of the spec §14)

- [ ] All 9 stages committed, one message each; **all** suites green (Rust, vitest, 25 UI suites incl. the new one) — no "known failures" exception.
- [ ] I1–I10 each have a named test; T1–T9 each have a fixture.
- [ ] Feature-off request is byte-identical (golden).
- [ ] 8 scenarios pass, including the 10,000-page book at window 8,192 / output 1,024 with **zero** provider overflows.
- [ ] Checklist ≤ 3% of window; assembly ≤ 15 ms; tree loads ≤ 100 ms after a kill.
- [ ] `contextTree` absent ⇒ UI falls back (tested against the old mock).
- [ ] Docs: `docs/context-tree/ARCHITECTURE.md`, `TOOLS.md`, `SECURITY.md`, `MIGRATION-v7.md`, plus rows in `docs/agentic-memory/02-FEATURE_MATRIX.md`.
- [ ] Report: commits, exact test counts per suite, screenshots (390 px light/dark), everything unverified, every deviation with a reason, native-build status.

---

## 22. Appendix — why this shape (design lineage)

Letta/MemGPT (core vs archival, tool-edited) · Anthropic context editing (clear old results, file-backed memory) · Claude Code (threshold compaction, sub-agents returning short findings) · Manus (filesystem as unlimited memory, restorable compression, plan file) · OpenAI Agents SDK / LangGraph (session-scoped, namespaced stores) — inspirations only; **no new dependencies**, mobile-first, SQLite + FTS5 only.
