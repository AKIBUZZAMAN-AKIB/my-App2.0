# Sub-agents: delegation graph, sub-agent chats, permissions

Status: implemented on `wip/genui` (2026-11-16). Replaces the in-memory-only diagram.

## 1. Where the graph comes from

The engine is the only source. It already keeps, per sub-agent, a record in
`registry.json` (id, name, title, description, task, status, depth, `parentId`,
`parentSessionKey`, `rootSessionKey`, `sessionKey`, tokens, times) and an
append-only log (`logs/<id>.jsonl`).

Added:

- `SubagentRecord.spawnToolCallId`: the parent's `spawn_subagent` tool call id.
  The agent loop passes it in as `_toolCallId`; the model never sets it.
- Log lines now also keep `to`, `toName`, `from`, `delivery`, and a 240-character
  snippet of `text` / `question` / `answer` / `report`, plus `approvalTool` and
  `approvalId` for approvals. `message(id, text)` (a follow-up from the app or
  the parent) is logged as `subagent.message`.
- App action `graph { sessionKey, maxEvents? }` (`subagents/graph.rs`) returns
  `{ nodes, edges, events }` for one chat:
  - `nodes[].parentId` is the real parent (null = the chat's main agent). A
    parent that was deleted is reported as `parentMissing: true` and drawn under
    the main agent.
  - `edges` = `{from, to}` per node.
  - `events` = started / queued / finished / error / cancelled / approval_needed /
    message / peer_message / ask_parent / parent_answer, time-ordered, each
    tagged with its node and parent. Tool calls and step ticks are left out. A
    log that was trimmed still gets a synthetic `started` from the record.
- Engine feature flag `subagentGraph`.

The app (`10-subagents.js`) calls `graph` the first time a chat is shown after
start-up (and on every chat switch), replaces that chat's in-memory log with
the engine's, and appends live events on top. A reload, the app being killed,
or the agents finishing therefore no longer empties the diagram.

## 2. Where the graph shows

1. **Inside the message that spawned it.** The `spawn_subagent` card is matched
   to its record by `spawnToolCallId` (exact), shows the title and description,
   and under it a small tree of every agent that agent started, at every depth,
   with live status. Each row opens that agent.
2. **The full graph** in the Agents panel, Diagram tab: the agent tree
   (flowchart) and the delegation over time (sequence diagram). Both are drawn
   per chat. Every arrow starts at the real sender: a nested start comes from
   its parent, reports go back to the parent, peer messages go agent to agent,
   ask_parent / answers between child and parent.
3. **The agent's own chat** has a breadcrumb `Main agent › level 1 › level 2`.

## 3. A sub-agent as a chat (parity with the main agent)

`13-subagent-chat.js`. "Open as chat" (Agents panel, the agent's detail) opens
the sub-agent in the same chat surface as the main agent: same thread, message
renderer, tool and approval cards, composer, Stop, copy, edit, retry and
branch pickers. Its engine session `subagent:<id>` is loaded as the thread.

| Main agent control | Sub-agent chat does |
| --- | --- |
| Send | `subagents {action: message}` (runs it again, or reaches it after its current step) |
| Stop | `subagents {action: stop}` |
| Edit a message | `subagents {action: edit, turn}` |
| Retry a reply | `subagents {action: regenerate, turn}` |
| Approval cards | the engine's request id, answered with `respondToApproval` |
| Model / provider / tools | header > Setup (`configure`) |
| Back | header back button: the parent agent, then the main chat |

The header shows title, description, breadcrumb, level, model and status, with
Stop or Retry, Setup and Graph. Live tool calls appear as they run; the saved
chat is reloaded after each step and when the run ends.

The Agents panel itself opens as a **side panel** (not modal; the chat behind
stays usable). Each opened agent gets its own tab in the panel. "Open agents
in" (Limits) switches back to the pop-up.

## 4. Topology and per-agent controls

Limits > "How agents work together": topology (tree and star by default; a
switch adds mesh and ring), and "Sub-agents can ask the agent that started
them" (`allowAskParent`). Per agent (detail > Setup): model, provider, tools,
hidden, hidden from, can message. All go to the engine (`settings`,
`configure`). `configure` now also takes `model`, `provider`, `tokenBudget`,
`maxSteps`, `priority`. The session an agent runs in is shown (`subagent:<id>`);
each agent always runs in its own session.

## 5. Permissions

- An approval request goes into the open chat's message only if it belongs to
  that chat (`sessionKey`) and, for a sub-agent's request, while that chat's
  run is live. Otherwise it waits in the **approvals tray** above the composer
  (`12-approvals.js`), answered straight through `respondToApproval`. Another
  chat's requests show as "<chat> needs your approval" with Open.
- When the main run ends with a sub-agent's request unanswered, the request
  moves to the tray instead of being dropped (the engine still waits for it).
- A sub-agent's request no longer starts a phantom main run; when the
  sub-agent ends, its requests leave the tray.
- **"Always allow" scope** (`alwaysAllowScope`, default `chat`): saved per chat
  in `session_allows.json` (`allowTool` / `revokeTool` / `chatAllows`), covers
  that chat and every sub-agent started from it at any depth, never a
  biometric tool. `global` keeps the old behaviour (tool permission everywhere).

## 6. Settings

- Default `maxDepth` is 2 (a sub-agent may start one more level), max 3.
- Settings are merged one field at a time, on load and on save. A wrong-typed
  value is coerced when unambiguous (`"3"`, `"true"`) and otherwise skipped;
  the other fields still apply. `settings` returns `rejected: [keys]` and the
  app says which were not saved.
- `spawn_subagent` accepts string-typed arguments from small models (`wait:
  "true"`, `max_steps: "5"`, `tools: "a, b"`) and offers `title`,
  `description`, `template`, `hidden_from`, `can_message` in its schema.

## 7. Tests

- Rust (`subagents.rs` tests): settings per-field merge and load, defaults,
  lenient spawn arguments, spawn tool call id/title/description, graph parent
  edges at depth 3 and after a restart, follow-up messages in the graph,
  chat-scoped Always allow, configure, level-3 approval routing.
- UI (`tools/agent-html-tests/subagent-graph-fixes.js`): reload persistence,
  real parent edges in both diagrams (and Mermaid renders them), stale
  running/Stop, stuck permission after the main agent finished, another chat's
  requests, Always-allow scope, detail hierarchy and Setup, topology controls,
  graph card in the spawning message, side panel and agent tabs, sub-agent chat
  parity (send, Stop, approval, retry, edit, back).
