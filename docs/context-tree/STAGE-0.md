# Context tree — Stage 0 (foundation), what actually landed

Status: **code written and tested in isolation; not yet wired into the agent loop**
(by design — Stage 0 adds the law and the numbers, nothing calls them yet).

The design documents live next to this file:

| file | what it is |
|---|---|
| `IMPLEMENTATION-PLAN.md` | the master plan, stages 0–9, decisions D1–D12 |
| `IMPLICATIONS.md` | measured consequences of adopting it (M1–M20, amendments A1–A10) |
| `SCHEMA-v7.sql` | the additive SQLite schema the store stage will use |
| `STAGE-0.md` | this file |

---

## 1. What is in the patch

### `src/context_tree.rs` — module root
The law + truth + evidence framing in the module doc, and the three submodules.
Feature-gated feature id `contextTree` (declared in `lib.rs`'s module list, no
runtime wiring yet).

### `src/context_tree/model.rs` — ids, kinds, states, pins, value
* `NodeId` — `cat/c3`, `turn/t12`, `file/f5a1…`, `res/R7`, `tmp/s3`, `note/n2`,
  `strat/1`. Parsing is total: unknown prefixes, empty paths and over-long ids are
  errors, never a fallback. `home_category()` gives the storage category, so an id
  that moves category keeps its identity.
* `NodeKind` — the 12 kinds with their home category and a base weight
  (`essential` 50 … `tempSummary` 10) used by the value score.
* `ItemState` — `in | note | temp | out`; `is_sent()` is the only place that
  decides whether a token is charged to the window (`temp` is charged elsewhere:
  the summary is its own node).
* `Pin` — `none | locked | policy | ai`; `is_hard()` is the law: locked and
  policy nodes cannot leave the window, whatever anyone asks.
* `Owner` — `system | policy | ai | subagent:<id>`; a sub-agent cannot write what
  only the model owns.
* `Refusal` — `locked | note_required | use_summarize | unchanged`, carried into
  the tool result so the model learns *why* instead of guessing.
* `value_score` — recency (½-life 40 turns **and** 6 h wall clock), `ln(1+uses)`
  usage, kind weight, −25 for an over-cap category. Deterministic; no clock reads
  inside, so tests never flake.
* `eviction_order` — mutable + currently-sent nodes, cheapest first, tie-broken by
  id so the order is stable across runs.
* `can_transition` — the state machine: `out→in`, `note→in/out`, `in/out→note`
  (needs a note), **`→temp` only through summarize**, `temp→in/out` puts the
  original back. Refusals are values, not panics.
* `safe_title` + `RESUME_MARKER` + `CORE_NODE_ID` — an item's own text can never
  forge the resume block or the checklist markers (prompt-injection guard), and
  titles are one line, ≤120 chars.

### `src/context_tree/budget.rs` — the numbers, in one place
The engine's existing formula, extended with the locked/selectable split:

```
selectable = window − reserve_out − headroom − locked
used_sel   = Σ sent nodes + checklist + resume
free       = selectable − used_sel
compact_at = selectable × threshold%      (warn at 85/100%, force at 115%, clamped)
```

`headroom` is an **input** (`DEFAULT_HEADROOM_TOKENS = 2,048`) so this module and
`agent_loop.rs` cannot drift apart. `starved` is true below 1,024 selectable
tokens: the window is then sent with the locked set + newest prompt only, and
says so, instead of letting the provider reject the request.
`scaled(factor)` re-derives the same budget for an overflow retry (0.60, 0.35)
**without touching the tree**, so the model's choices survive a retry.

### `src/context_tree/tools.rs` — one tool, and a guard on its price
The spec's eight tools (`ctx_view` … `ctx_prompt`) measured **6,203 characters
≈ 1,632 tokens on every model call**. They are now one `ctx` tool with an
`action` enum:

| | chars | ≈ tokens |
|---|---|---|
| spec, eight tools | 6,203 | 1,632 |
| `ctx`, one tool | **1,794** | **448** |

The eight names still resolve (`legacy_alias`), so the UI, docs and tests written
against the spec keep their meaning. `MAX_SCHEMA_CHARS = 2,300` is enforced by a
unit test: a schema cost that is not tested grows.

### `agent_loop.rs` — amendment A9, the measurement foundation
`reserved_input_tokens` was one opaque sum. The assembly record now also carries
`systemPromptTokens`, `toolSchemaTokens`, `requestOverheadTokens` and
`headroomTokens`. Nothing about behaviour changes; what changes is that a small
window can be **explained** from the audit row instead of guessed at. This is the
30-minute measurement the whole plan depends on (implied cost of tool schemas on
a phone), and it is cheap enough to land first.

---

## 2. How it was verified

The full engine crate cannot be built in the authoring sandbox (2 cores / 2 GB:
`rusqlite` bundled + `tiktoken-rs` + `uniffi` thrash it). The three new modules
have no dependency on the engine except `crate::types::ToolDefinition`, so they
are compiled and tested **for real** in a standalone harness against a stub of
that one type (`ctx-verify/`, see its README):

```
running 25 tests
test result: ok. 25 passed; 0 failed
```

with `RUSTFLAGS="-D warnings"` clean (the crate does not deny warnings, but the
new module is warning-free anyway).

Three real bugs were found and fixed this way, which is the point of running it:

1. `can_transition`'s match was non-exhaustive (`(Temp, Temp)` and the equal
   pairs) — a compile error, caught immediately.
2. The first `ctx` schema was **3,619 chars**, not the ≤2,300 it was supposed to
   be; the per-action prose was moved out of the schema (it belongs in
   `sys/core`, which is cached and shared) and the schema fell to 1,794.
3. `Temp → In` was refused as `use_summarize` although putting the original back
   is a normal, reversible include — the state machine now allows it.

## 3. What Stage 0 still needs (before any wiring)

* `ScriptedDriver` — a deterministic `LlmDriver` for tests. Without it no test can
  drive a full turn, and without a fake provider the whole feature is untestable
  at the level that matters. (The repo has no fake driver today.)
* `harness/` scenario runner: scripted turn → expected assembly record →
  assertion. Stage 1 cannot be reviewed without it.
* Nothing else. No store, no wiring, no UI in Stage 0.

## 4. Risk notes carried into Stage 1

* **Binary cost**: every FFI change costs **64 MB Android + 98 MB iOS** of
  checked-in artifacts, and 11 of the last 60 commits were rebuild commits.
  Nine stages at this rate is ~1.5 GB of history. Milestones are 3, not 9.
* **`rev` races**: parallel tool execution (≤16) plus a single tree means every
  mutation carries `expect_rev`. `ctx` is a leaf task that takes its lock last;
  the limiter runs before dispatch.
* **Per-kind quotas**: a single 4,000-node cap breaks long chats (~4.5 nodes per
  turn). Quotas are per kind, and GC trims the oldest of each kind first.
* **No prompt caching today**: splitting the system prompt into parts (D1) is
  free to do now — it only starts paying off when a provider with caching is used.
