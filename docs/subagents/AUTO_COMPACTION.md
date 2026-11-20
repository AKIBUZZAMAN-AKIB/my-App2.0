# Auto-compaction everywhere

Status: implemented in `plugins/native-agent/rust/native-agent-ffi/src/subagents/compact.rs`
and wired into `channels.rs`, `swarm.rs`, `team.rs` and `advanced.rs`.

## Two layers

| Layer | What grows | How it compacts | Where |
| --- | --- | --- | --- |
| Transcript | The main chat and every sub-agent session (forked or fresh) | Shorten old tool results, summarise the oldest prefix with the model, then trim; retried on provider overflow | `agent_loop::compaction` (`CompactionPolicy`, per chat and per agent) — existed before this work |
| Coordination state | Topic histories, blackboard, swarm logs (auctions, votes, debates, elections, rumours, handoffs), inboxes and steer queues, reports a gatherer or reviewer reads, handoff chains | Deterministic fold into a `Digest`; budgeted head + tail for text assembled into a prompt | `subagents::compact` (`Policy`, per chat over the Settings default) — new |

The transcript layer already covered "each agent's own context". Everything a team
shares around those transcripts grew without bound (or was cut by hard caps and
`truncate_chars`, which drops the end of a report: usually its conclusion). That
is what the new layer covers.

## What the field does (research, November 2026)

- **Anthropic API context editing** (`clear_tool_uses_20250919`, `clear_thinking_20251015`):
  clears the oldest tool results past a token trigger, keeps the newest N, has
  `clear_at_least` so each clear buys real headroom (a clear invalidates the prompt
  cache from that point), `exclude_tools` for load-bearing results, and leaves a
  placeholder so the model knows something was there. Edits are reported back in
  `applied_edits`. Server-side compaction (`compact-2026-01-12`) summarises the whole
  trajectory near the ceiling; the memory tool stores what must survive verbatim.
  The documented pattern: store, then clear, with compaction over both.
- **Claude Code**: auto-compact near the top of the window, `/compact` on demand,
  `CLAUDE.md` re-injected every turn so rules survive a summary. Sub-agents return a
  summary only ("context isolation with summary return").
- **OpenAI Responses**: `context_management: [{type: "compaction", compact_threshold}]`
  or the stateless `/responses/compact`; the result is an opaque encrypted item that
  carries prior state. The Agents API (openai-python 3.42.0, 31 Oct 2026) adds
  blocking vs background compaction and returns the effective setting.
- **Letta / MemGPT**: memory as an OS hierarchy: core memory always in the prompt,
  recall memory (full history, searchable), archival memory; evicted messages are
  summarised recursively and nothing is truly lost.
- **LangGraph / LangChain**: composable primitives: `trim_messages`, `RemoveMessage`,
  `SummarizationMiddleware(trigger=("tokens", N), keep=("messages", K))`, and offloading
  very large tool results to files.
- **Multi-agent surveys** (CrabTalk, March 2026): every framework compacts per agent;
  only AutoGen's `CompressibleGroupManager` compacts a shared group stream centrally.
  Shared state (topics, boards, logs) is exactly what nobody else compacts.

## Design decisions

1. **Synchronous and deterministic.** Coordination state lives behind locks and is
   read on every message; a model call there would add latency, cost and failure
   modes. Model summaries stay in the transcript layer, which already has them.
2. **Fold, never drop silently** (Letta's "nothing is truly lost", Anthropic's
   placeholder). A `Digest` keeps the count, time span, who (items per author or
   kind), the number of runs, and one short gist line per item (newest 24).
   Agents see `[N earlier posts compacted (a 12, b 8); the last 24 in brief]`.
3. **Keep and mark with hysteresis** (LangGraph `keep` / `trigger`, Anthropic
   `clear_at_least`). Compaction starts when a history passes `compactAt` and folds
   down to the newest `compactKeep`, so it runs in batches, not on every write.
4. **Open work never folds.** A running vote, open auction or live debate stays
   verbatim whatever its age; only closed items older than the newest `keep` fold.
   A long debate keeps its last two rounds and folds earlier turns into its own digest.
5. **Budget what goes into a prompt.** A gatherer that waits for many agents shares
   one budget (`compactContextChars`): short reports stay whole, the rest share what
   is left (water-filling), each cut at line breaks keeping head and tail, so the
   conclusion survives. Review feedback, handoff tasks and notes use head + tail too.
6. **Inboxes and steer queues** past their cap or budget fold the oldest notes into
   one summary note and keep the newest whole.
7. **Handoff chains** carry earlier hops as one line each, not the full notes.
8. **Observable** (Anthropic `applied_edits`, OpenAI effective setting). `swarmState`
   returns `compaction: {policy, runs, items, lastAt, folded: {topics, blackboard, swarm}}`,
   every topic its `digest`, plus `boardDigest` and per-kind swarm `digests`.

## Sub-agents reach their compaction point (token cap, November 2026)

The transcript layer ran for sub-agents, but a sub-agent never got there. Every
run had a cumulative token cap, `defaultTokenBudget`, 200,000 by default, checked
by `budget_check` after each step. It counts input + output of every step, and each
step resends the whole context, so a context growing ~6k per step is stopped at
~46k tokens, while a 128k model compacts at ~118k (a 1M model at ~990k). The main
agent has no such cap, so only it ever filled its real window and compacted. The
UI showed that cap as "x / 200k tokens" on every sub-agent card and row, which read
as a fixed 200k context window.

Now `defaultTokenBudget` defaults to 0 = no cap, like the main agent: the run is
bounded by its model's real context window (resolved per model in
`agent_loop::resolve_context_plan`, the same as the main agent), kept there by
auto-compaction, and by its step and time limits. A cap can still be set per run,
per template or in Settings (1k–5M). Settings files written before
`tokenBudgetSchema: 2` that still hold exactly 200,000 move to 0 once, together with
records and templates that hold the old default. Cards show context used against
the model's window when there is no cap. Tests:
`the_old_200k_cap_stopped_runs_before_their_context_could_compact`,
`by_default_a_sub_agent_is_not_stopped_for_tokens`,
`the_old_default_cap_is_migrated_once`, `budget_zero_means_no_cap`.

## Parity with the main agent (audit, November 2026)

Every transcript mechanism of the main chat lives in `agent_loop::run_agent_turn`
and `agent_loop::memory_loop::apply`, and a sub-agent run goes through the same
`run_agent_turn` (`EngineRunner::run` in `subagents.rs`) with nothing that turns
any of them off for sub-agent sessions:

| Mechanism | Where | Sub-agent |
| --- | --- | --- |
| Context window per model (catalog, learned limit, `contextLength`) | `resolve_context_plan`, `effective_context_token_budget` | same call |
| Turn memory: keep the newest 7 turns verbatim, summarise the oldest 7 at a time (`keepRecent`, `batch`, at most 4 batches per run, in the foreground unless `backgroundSummaries`) | `memory_loop::apply`, `memory_worker`, `turn_memory::plan_batches` | same; a sub-agent's turns are its briefs and the messages it is sent, so it folds once it has 14 finished turns |
| Fold into a memory block, reselect a smaller fold when over budget | `MemoryFold`, `memory_loop::reselect_smaller` | same |
| Store large tool results, `recall_turns` / `memory_inspect` | `memory_loop::store_result`, `recall_tool` | same (handled before the allow-list) |
| Read budget for large tool output | `read_budget::fit_tool_result` / `fit_large_output` | same |
| Tier 1 dedupe and shorten old tool results | `compaction::shrink_tool_results` | same |
| Tier 2 shorten long old explanations | `memory_loop::shorten_explanations` | same |
| Tier 3 summarise the oldest prefix | `summarize_context_prefix` | same |
| Tier 4 trim, then repair the transcript | `trim_to_context_budget_preserving_summary_with` | same |
| Threshold % / on-off | `CompactionPolicy` via `SubagentManager::compaction_policy` | same settings, per agent override |
| Overflow error: learn the limit, shrink to 60 % then 35 %, retry | `assembly::is_context_overflow`, `overflow_retry_ceiling` | same |
| Full transcript persisted (`MemoryFold::finish`) | end of `run_agent_turn` | same (`EngineRunner::save`) |

What differed was around the loop, not in it, and is now the same:

- **Retention** of stored tool results after a save (`autoPruneResults`) ran only
  after a main-chat turn. Both now call `turn_memory::retention::after_turn_saved`
  (main chat, sub-agent sessions, and a cross-session ask saved into a chat).
- **Clearing a sub-agent** deleted its turn memory and jobs but left a running
  background summary going; it now calls `memory_worker::cancel`, as memory.reset
  and rewind do for the main chat.
- **What the Context tab shows**: the turn-memory summaries (`memory.*`) and the
  overflow shrink-and-retry (`context.overflow*`) of a sub-agent were dropped by
  `SubagentEvents`; only the four tiers were recorded. `compaction_step` now maps
  all of them, so the card counts and lists every step the main chat would show.

Still different by design: the sub-agent's wall-clock limit (`timeoutSeconds`,
600 by default; the main chat has none) and the swarm coordination layer above.
Both share a 25-step default per run.

## Settings (per chat over the Settings default)

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `compact` | on | on / off | Auto-compaction of coordination state |
| `compactKeep` | 12 | 2–45 | Items kept verbatim after a run |
| `compactAt` | 30 | 4–50 (always > keep) | A history compacts when it grows past this |
| `compactContextChars` | 24,000 | 2,000–200,000 | Coordination text one prompt may carry |

Out-of-range values are rejected by `setCommsConfig` and reported in `rejected`.
Hard caps (60 posts per topic, 60 swarm items per kind, 200 blackboard keys) stay as
the last line of defence.

## Immutable turn-range summaries (20 Nov 2026)

**Rule (Akib):** once turns a-b have a summary, that summary is never edited, regenerated, merged or re-versioned. The essentials (goal, decisions, facts, preferences, files, open items) keep updating every batch, exactly as before, and always go to the AI.

**What the audit found (before this change, `124d243`):**
- The batch summarizer itself could not rewrite turns 1-7 while summarizing 21-28: `apply_update_full` only accepts segments inside the new range and keeps the earlier ones. So the exact example (21-28 rewrites 1-7) did not happen on the summary path.
- But an older range summary could still be changed or lost in three other places:
  1. **Recall repair:** a recall sub-agent could propose a `segment` repair, which replaced the text of an existing range summary in a new memory version (`repair.rs`, `RepairChange::Segment`). Only the last 10 versions are kept, so after 10 more versions the original text was gone.
  2. **`coarsen`** merged the two oldest segments into one shortened segment. It had no caller in production code, but it was a ready path to rewrite summaries.
  3. **Tier-3 continuity note:** when the prompt overflowed, the oldest prefix of the view, which can include the memory block (the essentials and the selected range summaries), was folded into a lossy note, and the overflow hard-trim could drop the memory block. Prompt-only (the stored memory was never changed), but the AI then lost the essentials for that call.
- `validate_transition` did not check that earlier segments were unchanged.

**What changed:**
- `check_segments_append_only` (in `validate_transition`, which every summary, repair and revert passes): every earlier segment must still be there byte for byte (range, topic, title, text, `createdAt`), and a new segment may not overlap an existing range.
- Each new segment gets `createdAt` (ms) when it is written. Segments from older builds keep no timestamp: they are not rewritten even to add one.
- Segment repairs are refused at proposal, check and apply. An older segment repair is not reverted: the live text is the immutable record (migration rule: the latest stored version wins).
- `coarsen` only drops superseded-decision history from a view and never touches segments.
- Prompt selection is unchanged in kind: the essentials always go in, then the relevant and newest range summaries that fit. A range that does not fit is listed as not shown and stays recallable; it is never shortened.
- Tier 3 never summarizes the memory block: it is taken out of the note's source and put back after the note unchanged. The hard-trim (also used on the overflow retry) keeps the leading note and memory block.
- `recall_turns` now returns the stored original summaries of the requested ranges (with when they were written) beside the original turns; `memory_inspect` section `segments` lists every range summary, including those not in the prompt.
- Prompts and tool descriptions say that range summaries are written once and any range can be recalled.
- UI: the Context tab's Turn index says summaries are never changed and shows when each was written; no Revert button for an old segment repair.
- Originals: the turn archive is only deleted by a rewind or a memory reset that the user asks for. Retention prunes only unreferenced stored tool results, and anything an archived turn refers to counts as referenced, so no setting was needed.
- Sub-agents and cross-session asks use the same `run_agent_turn` and memory store under their own session key, so the same rules apply.

**Scope rule (each summary covers only its own turns):**
- The summarizer gets only the turns of the new range. The earlier memory goes in as "EARLIER SUMMARY ... CONTEXT ONLY, do not summarize it": the essentials (goal, decisions with IDs, items) and `earlierRanges`, an index of earlier ranges (range, topic, title) without their summary text, so no earlier wording can be copied.
- The summarizer, portion and merge prompts carry `SCOPE_RULES`: a segment describes only its own fromTurn-toTurn turns. The one exception is one short line at the end of the new segment, `Changes to turns A-B: old -> new`, when the new turns change something from an earlier range. The note lives only in the new summary; the earlier summary is untouched.
- Enforced in code (`check_segment_scope`, in `apply_update_full`): outside the change-note line, a new segment (summary or title) may not name a turn outside its range, and it may not repeat a sentence (40+ characters) of an earlier range's summary. A violating answer is sent back once with the reason; if it still violates, nothing is saved. Turn references written without digits or in another script are not caught by the check; the prompt rule covers those.

**Comparison:** Letta (MemGPT) keeps a small core memory in the prompt on every turn and the full conversation history in recall storage, searched by a tool. This change follows the same split: the essentials are the always-sent part, and the immutable range summaries plus the original turns are the recall part. Unlike MemGPT's recursive summarization, nothing stored is summarized again.

**Tests:** `turn_memory/immutable_tests.rs` (11) and two agent-loop tests (memory block kept through trim, overflow retry and the continuity note).

## Tests

- `compact::tests` (5): digest counting and gist window, fold with open items and the
  keep window, head + tail at line breaks, budget sharing, note folding.
- `swarm_tests::coordination_state_auto_compacts_into_digests_the_user_can_tune`:
  range validation, 10 posts with keep 3 / at 6 fold with nothing lost, agents see
  "older compacted", the app sees policy and counts, turning it off stops folding.
