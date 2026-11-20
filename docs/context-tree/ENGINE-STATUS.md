# Context tree — what is built, what is left, and why it stopped here

> বাংলায় পুরো ব্যাখ্যা: [`বাংলা-গাইড.md`](./বাংলা-গাইড.md) — কী বানানো হয়েছে,
> কীভাবে চালু করবেন, কীভাবে যাচাই করবেন, কোন স্টেজ কতটা হয়েছে।

Branch: `feat/context-tree-stage-0`. Nothing in this branch changes behaviour: the
module is declared in `lib.rs` but nothing calls it yet, so the app runs exactly as
before. The one exception is the A9 measurement split in `agent_loop.rs`, which
adds three numbers to the audit row and changes nothing else.

## Built and tested (100 unit tests, real SQLite, no engine crate needed)

| file | what it does | tests |
|---|---|---|
| `model.rs` | ids, 12 kinds, states, pins, owners, value score, transition table, marker guard | 11 |
| `budget.rs` | the single source of truth for every number the model sees | 8 |
| `tools.rs` | one `ctx` tool (448 tokens, was 1,632) + a test that keeps it there | 6 |
| `store.rs` | additive tables, revisions, tombstones, quotas, gc, action log | 14 |
| `reading.rs` | reconciles the tree against turns/results/files without touching them | 8 |
| `select.rs` | tiers, safety net, category caps, compression candidates | 9 |
| `render.rs` | checklist (≤900 tokens, collapses), resume block (≤220), refusals | 10 |
| `ops.rs` | op batches: all-or-nothing on revision, best-effort per op | 11 |
| `dispatch.rs` | the eight `ctx` actions, no panics, `Recall` trait for content | 16 |
| `assemble.rs` | the ladder (warn → compact → force → starved) as a pure function | 6 |

Run them with `ctx-verify/run.sh` (reads the files in place; nothing is copied into
the repo). That harness found a non-exhaustive match, a schema 1.6× over budget and a
wrongly-refused transition in the first drafts, and it is how everything above was
verified — the full crate does not build in the authoring sandbox (2 cores / 2 GB).

## Wired — and proven by CI (commit `db84fd7`)

The tree is now inside the loop, with three touch-points and no signature change:

| piece | where | what it does |
|---|---|---|
| flag | `wiring::enabled` / `set_active` | `ctx_meta.enabled = "1"`, read once per request |
| prompt | `agent_loop.rs` (~510) | appends instructions + checklist + resume **before** the budget is computed, so `systemTokens` includes it |
| tool | `tool_runner::execute_tool` | intercepts `ctx` at the top, using the published request context (session, window, reserve, model) |
| context | `wiring::set_request_context` | the session is published once per request, so `execute_tool` keeps its signature and its 20 test call sites |

CI on `db84fd7`: **Rust — check, test, binding identity: success**, with
**740 tests passing** (635 before the branch + 105 new: 100 module tests + 5
wiring tests), warnings-as-errors clean. Web: success. UI (Playwright, ~42 min) was
still running when this line was written.

The first three CI rounds found four things the harness could not see:
`context_length_tokens` is `Option<u64>`; two unused imports (warnings are errors
here); a `Result<()>`/`Result<i64>` mix-up; and a `system_prompt` move inside the
overflow-retry loop. That is exactly why the wiring is CI-verified and the modules
are harness-verified — they see different things.

Still needed to turn the feature *on*: a settings row that writes
`ctx_meta.enabled = "1"` (or `wiring::set_enabled(db, true)`), then a real chat.

## What is left, precisely

Wiring is the only remaining engine work, and it is small but must be done with the
crate open. Three call sites:

1. **Session key into the tool executor.** `tool_runner::execute_tool(name, args,
   workspace, db_path, memory_provider)` has no `session_key`, and the tree is
   per-session. Add it as a parameter (or a thin wrapper
   `execute_ctx_tool(args, db_path, session_key)`) and route `"ctx"` to
   `context_tree::dispatch::handle`. The `Recall` implementation for turns/results/
   files goes there too (`turn_memory::store::load_turns`, `load_result`,
   `workspace read`).
2. **Tool registration.** `tool_runner::all_tool_definitions()` gains
   `context_tree::tools::tool_definition()` when the `contextTree` feature is on;
   the size guard already keeps its cost at 448 tokens.
3. **Assembly.** At `agent_loop.rs` (~529, where `system_prompt_tokens` is now
   measured): index the session (`reading::plan` + `apply`), load nodes, compute
   `Budget` with `locked = system + tool schemas + essentials + checklist +
   resume + newest prompt`, call `assemble::assemble`, append
   `assemble::instructions()` + the checklist + the resume block to the part of the
   system prompt that carries the memory rules, and apply the returned evictions
   with `select::apply_evictions` **before** building the messages. A9 already
   reports `systemPromptTokens` / `toolSchemaTokens`, so the effect is measurable on
   the first run.
4. **Feature flag.** `contextTree` in `lib.rs`'s feature list, default off, so the
   merge to `main` cannot change behaviour until someone turns it on.

Then the UI (a panel that renders the same checklist the model sees, plus the
action log) — that is Stage 4 in the plan and it is purely additive JS in
`agent-html-src`, so it can ship after the engine is on by default.

## Honest position

* **Merging is now safe but pointless until the flag is on.** The module is dead code until step 1–3 land; a
  merge now would ship a binary that is 64 MB (Android) / 98 MB (iOS) larger for no
  behaviour change. That is exactly the cost the implications report warned about
  (M12–M14): land the wiring and the flag together, in one milestone.
* The tests prove the *policy*, not the *integration*. The integration is the part
  CI will have to prove, and it is also the part where a wrong `locked` number
  would show up as a window that is too small rather than a crash.
* Everything the model can do is reversible: evictions are states, not deletions,
  and the notes/summaries it writes are the only content the tree owns.
