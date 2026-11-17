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

## Tests

- `compact::tests` (5): digest counting and gist window, fold with open items and the
  keep window, head + tail at line breaks, budget sharing, note folding.
- `swarm_tests::coordination_state_auto_compacts_into_digests_the_user_can_tune`:
  range validation, 10 posts with keep 3 / at 6 fold with nothing lost, agents see
  "older compacted", the app sees policy and counts, turning it off stops folding.
