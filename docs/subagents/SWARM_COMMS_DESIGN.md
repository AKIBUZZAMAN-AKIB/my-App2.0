# Sub-agents: swarm communication system

Status: design (phase 1) on `feat/subagent-comms`, off `wip/genui` `af10088`.
Builds on `team.rs` (tree/star/mesh/ring, `ask_parent`, `message_peer`,
`list_peers`, `canMessage`, `hidden`, `hiddenFrom`), `comms.rs` (`commsPaused`,
per-minute send limit, user broadcast, comms timeline and matrix, pause /
resume / stop tree / reparent) and `advanced.rs` (batch modes parallel,
pipeline, race, review, gather).

Goal: a real swarm. Agents decide on their own whom to talk to, whom to hand
the work to and whom to spawn, inside limits the user sets. Every common
multi-agent communication pattern and topology is available, per chat, per
batch and per single spawn, and the user can see and configure all of it.

## 1. Research

What each system contributes, and what we take from it.

| System / idea | Core mechanism | Taken here |
|---|---|---|
| OpenAI Swarm (github.com/openai/swarm), now the OpenAI Agents SDK | Two primitives: agents (instructions + functions) and handoffs. A function that returns another agent makes that agent the active one; the conversation continues with it. `context_variables` are shared state. | `handoff_to_peer`: the caller stops, the target becomes the active agent for the same piece of work, and whoever waits for the caller gets the target's report (the handoff chain is followed). Shared state = the blackboard. |
| LangGraph Swarm (`langgraph-swarm-py`) | `create_handoff_tool(agent_name=...)` per agent; the graph remembers the `active_agent` and resumes with it on the next turn. | The chat remembers who holds the work (`activeAgent` on the swarm state) and the Explorer shows handoffs as arrows. Max handoffs per chain stops ping-pong. |
| LangGraph supervisor / hierarchical teams | A supervisor routes to workers; supervisors of supervisors for big teams. | `star` (a hub) and `hierarchical` (sub-teams with leads; leads talk to leads). |
| kyegomez/swarms | A catalogue of architectures: SequentialWorkflow, ConcurrentWorkflow, AgentRearrange (a flow string such as `a -> b, c`), MixtureOfAgents, GroupChat, HierarchicalSwarm, majority voting, auto swarm builder. | Topologies as data (custom edge graph = AgentRearrange's flow), presets as named configurations, majority voting as a protocol. |
| Anthropic multi-agent research system | Orchestrator-worker: a lead agent plans, spawns 3-5 subagents in parallel with clear briefs and effort budgets, they report back condensed findings; most of the gain comes from spending more tokens in parallel, so limits matter. | The existing spawn/batch model stays the backbone; budgets, max agents and message caps are first-class swarm settings. |
| CAMEL (arXiv 2303.17760) | Role-playing: an AI user and an AI assistant with inception prompts converse turn by turn toward a task. | `request_peer` / `reply_peer` give two agents a turn-taking dialogue with a correlation id. |
| ChatDev (arXiv 2307.07924) | A chat chain: phases, each a dialogue between two roles, output of one phase feeds the next. | `chain` topology (neighbours only) on top of the pipeline batch mode. |
| AgentVerse (arXiv 2308.10848) | Expert recruitment, then collaborative decision-making in a horizontal (everyone discusses, democratic) or vertical (a solver proposes, reviewers critique) structure. | Debate (horizontal) and review mode (vertical, already in `advanced.rs`); leader election recruits a coordinator. |
| AutoGen SelectorGroupChat | A selector picks the next speaker from allowed transitions; termination conditions. | Allowed edges enforced in code; `maxRounds` and `maxHops` as termination conditions. |
| MetaGPT message pool | Agents publish structured messages to a shared pool and subscribe by interest. | Pub/sub topics (`publish_topic` / `subscribe_topic`), scoped per chat. |
| FIPA ACL | Performatives (request, inform, propose, accept, reject, cfp), `conversation-id`, `in-reply-to`, `reply-by`. | Every request carries an id; replies name it; requests carry a deadline. |
| Contract Net Protocol (Smith 1980; FIPA CNP) | A manager announces a task (call for proposals); contractors bid; the manager awards to the best bid and rejects the rest. | `announce_task` / `bid_task` / `award_task`, with award policy best / cheapest / most confident / manager's choice. |
| Multi-agent debate (Du et al., arXiv 2305.14325) | Several model instances answer, then over several rounds read each other's answers and revise; this improves factuality and reasoning. | `start_debate`: N participants, R rounds, every round each sees the others' latest positions; ends with the positions and whether they converged, optionally a vote. |
| Voting / consensus | Majority, plurality, unanimity, supermajority, with a quorum. | `call_vote` / `cast_vote` with the chat's consensus rule and quorum. |
| Leader election (Bully algorithm; Raft terms) | Bully: the highest-ranked live node wins. Raft: candidates ask for votes in a numbered term; a majority wins; a newer term supersedes an older one. | `elect_leader` with method `vote` (majority, Raft-like numbered term) or `rank` (bully: highest priority, then most capable/least busy, deterministic); the winner becomes the coordinator, the term number fences stale coordinators. |
| Gossip / epidemic protocols | Each node forwards news to a few random peers per round (fanout); news reaches everyone in about log N rounds; a seen-set and a TTL stop it. | `gossip`: fanout and max rounds from the config; every rumour has an id, a hop count and a seen-set, so it never loops. |
| Stigmergy (Grassé) / blackboard architecture | Agents coordinate indirectly by leaving marks in a shared environment; marks reinforce and evaporate (ant pheromone). Blackboard: a shared store that specialists read and write. | A per-chat blackboard with versioned keys (optimistic concurrency), search, and `reinforce` marks whose weight evaporates with a half-life, so popular trails rise and stale ones fade. |

Conclusions:

1. Two families: orchestrated (hub, hierarchy, pipeline; reliable, cheap) and
   decentralised (mesh, swarm, gossip, market; flexible, can loop and burn
   tokens). The user chooses; the engine enforces the limits either way.
2. Who may talk to whom must be data that the engine checks at dispatch time,
   not a prompt instruction, so a model cannot route around it.
3. Every decentralised pattern needs a stop condition in code: hop limits,
   per-pair limits, round limits, total caps, timeouts, cycle detection.
4. Everything an agent says to another agent is a logged, visible event.

## 2. Model

### 2.1 Topologies (who may send a direct message to whom)

| Topology | Direct messages allowed |
|---|---|
| `tree` | None between peers; up via `ask_parent`, down via the parent's own tools (unchanged default). |
| `star` | Spokes <-> the hub (an agent with role `hub`); no hub = no peer talk, no nesting (unchanged). |
| `mesh` | Anyone visible in the chat. |
| `ring` | The next sibling, wrapping (unchanged). |
| `chain` | The previous and next sibling, no wrap. |
| `bus` | No direct messages; topics, blackboard and broadcast only. |
| `hierarchical` | Own sub-team (same parent), own parent and children; leads (role `lead` or agents with children) talk to other leads. |
| `swarm` | Anyone visible; every swarm pattern on by default; agents may hand off and spawn (within limits). |
| `custom` | Only the user's allow edges. |

Resolution, most specific first: the agent's own `topology` (set at spawn by
itself, its batch, or inherited from its parent) > the chat's comms config
> the global setting. The sender's topology decides a message.

On top of the topology, in this order:

1. Same chat and not hidden (`hidden`, `hiddenFrom`), as today.
2. A user deny edge always blocks (deny wins).
3. The agent's `canMessage` list, when set, is the whole answer (as today).
4. A user allow edge permits even when the topology would not.
5. Otherwise the topology.

Edges are `{from, to, allow, both}`; `from`/`to` are an id, a name or `*`.

### 2.2 Patterns (what kinds of communication exist)

`direct`, `broadcast`, `topics`, `blackboard`, `request`, `handoff`,
`gossip`, `auction`, `vote`, `debate`, `election`. A chat's `patterns` list
turns them on; unset = the topology's defaults:

- tree, star: none (ask_parent only)
- ring, chain, custom: direct, request
- mesh: direct, broadcast, topics, blackboard, request
- bus: broadcast, topics, blackboard
- hierarchical: direct, broadcast, topics, blackboard, request, vote
- swarm: all of them

A tool is offered to an agent only when its pattern is on. Who may broadcast
and who may spawn are separate rules (`all`, `leads`, `none`), and an agent's
own `canBroadcast` overrides the chat's rule.

### 2.3 Tools (sub-agents only)

Existing: `ask_parent`, `message_peer`, `list_peers`.

- `broadcast_team {message}`: every visible agent of the chat not behind a
  deny edge.
- `publish_topic {topic, message}`, `subscribe_topic {topic}`,
  `unsubscribe_topic {topic}`, `list_topics {}`: per-chat topics; subscribers
  get each post; the last 50 posts of a topic are kept (a late subscriber can
  read them with `list_topics`).
- `blackboard_read {key?}`, `blackboard_write {key, value?, expected_version?,
  reinforce?, delete?}`, `blackboard_search {query}`: versioned keys; a write
  with a stale `expected_version` is refused with the current value (optimistic
  concurrency); `reinforce` adds weight to a mark; weights halve every
  `pheromoneHalfLifeMin` minutes.
- `request_peer {to, question, wait?, timeout_s?}` and
  `reply_peer {request_id, answer}`: request/reply with an id; `wait` blocks
  the asker until the reply or the timeout. An idle target is woken when
  `wakeIdle` is on. Waiting is refused when it would close a cycle of waits
  (deadlock avoidance): the wait-for graph is checked first.
- `handoff_to_peer {to, note}`: swarm handoff. The target receives the
  caller's task and the note and becomes the active agent; the caller ends its
  turn. Whoever waits for the caller gets the target's report too. At most
  `maxHandoffs` per chain.
- `gossip {fact, rumor_id?}`: forward to `gossipFanout` random reachable
  peers that have not seen it, up to `maxRounds` hops.
- `announce_task {task, criteria?, wait_s?}`, `bid_task {auction_id,
  proposal, cost?, confidence?}`, `award_task {auction_id, to?}`: contract net.
  With `wait_s` the announcer waits for every bid (or the deadline) and the
  engine awards by `auctionPolicy`.
- `call_vote {question, options, wait_s?}`, `cast_vote {vote_id, option,
  reason?}`: tallied by `consensusRule` (majority, plurality, unanimous,
  supermajority) with `quorumPercent`.
- `start_debate {topic, participants?, rounds?}`: the engine runs R rounds of
  requests; each round every participant sees the others' latest positions;
  returns the final positions and whether they agree.
- `elect_leader {method?, candidates?}`: `rank` (bully) or `vote` (Raft-like
  majority, numbered term). The winner gets role `lead` and becomes the chat's
  coordinator; every agent is told.

### 2.4 Safety

- `commsPaused` (global, unchanged) and a per-chat `paused`.
- Per-minute send limit per agent (unchanged), plus a per-pair limit
  (`maxPairMessages` per 10 minutes) and a chat-wide cap on agent messages
  (`maxMessages`).
- Hops: a message carries the hop count of the chain that caused it; an agent
  that received a message at hop h sends at h + 1; above `maxHops` it is
  refused. A run started by the user or the main agent resets it.
- Rounds: debates, gossip and elections stop at `maxRounds`.
- Deadlock: a wait (request, vote, auction, debate) is refused when the
  target already waits, directly or through others, on the asker; every wait
  has a timeout.
- Budgets: the existing per-agent token budgets and step limits, the global
  parallel limit and depth limit; `whoCanSpawn` limits who in a swarm may
  create agents.
- Stop all: pauses comms for the chat and stops every running agent of it.

### 2.5 Storage

`comms.json` next to `settings.json`:

```
{ chats: { <rootSessionKey>: { config, topics, blackboard, swarm } },
  presets: [ { name, title, description, config } ] }
```

- `config`: topology, patterns, edges, limits, rules (2.1-2.4).
- `topics`: name -> { subscribers, posts (last 50), createdBy }.
- `blackboard`: key -> { value, version, author, updatedAt, weight, tags }.
- `swarm`: auctions, votes, debates, elections, rumours, handoffs,
  coordinator, term (last 50 of each).

Record fields (SubagentRecord): `topology`, `commsRole` (hub, lead, member),
`canBroadcast`, `handedTo`, `handedFrom`.

### 2.6 App API (`handleAppRequest` actions)

- `commsConfig {sessionKey}` -> `{config, effective, presets, topologies,
  patterns}`; `setCommsConfig {sessionKey, patch}`.
- `commsPresets`, `saveCommsPreset {name, title?, description?, config}`,
  `deleteCommsPreset {name}`, `applyCommsPreset {sessionKey, name}`.
- `swarmState {sessionKey}` -> topics, blackboard, auctions, votes, debates,
  elections, rumours, handoffs, coordinator, allowed edges.
- `blackboardWrite {sessionKey, key, value}` / `blackboardDelete`,
  `topicPublish {sessionKey, topic, message}` (the user posts),
  `topicCreate` / `topicDelete`.
- `commsStopAll {sessionKey}`.
- `graph` gains `topologyEdges`, `topics`, `blackboard`, `handoffs`,
  `coordinator`.
- `comms` (timeline) gains the new kinds: topic, broadcast, request, reply,
  handoff, gossip, cfp, bid, award, vote, ballot, debate, election, blackboard.

### 2.7 UI

- Settings and a per-chat Swarm sheet: a topology picker drawn as small
  diagrams, pattern toggles, limits, rules, presets (built-in and saved),
  an edge editor (from / to / allow-deny / both ways) and a drawing mode in
  the Explorer (drag from one agent to another to add an edge).
- Spawn and batch dialogs: topology / swarm picker, hub or lead for the
  batch.
- Explorer: topology edges (dashed, allowed paths), message flow (solid,
  animated while live), topic nodes (bus) linked to subscribers, a blackboard
  node with recent writers, handoff arrows, the coordinator's crown, vote and
  bid badges. Swarm panel tabs: Topics, Blackboard, Market (auctions),
  Votes, Debates, Elections, Gossip. The Timeline lists every comms event.
- 390px mobile, dark mode, keyboard and screen-reader labels, WCAG AA
  contrast and 32px targets, as the rest of the agents UI.

### 2.8 Built-in presets

| Preset | Topology | Patterns | Notes |
|---|---|---|---|
| Supervisor | star | request | spokes talk only to the hub |
| Strict tree | tree | none | the default today |
| Open swarm | swarm | all | handoffs, auctions, votes on |
| Research team | hierarchical | direct, topics, blackboard, request, vote | leads coordinate sub-teams |
| Debate panel | mesh | direct, request, debate, vote | unanimous rule, 3 rounds |
| Market | mesh | direct, request, auction | cheapest-bid award |
| Blackboard | bus | topics, blackboard, broadcast | stigmergy, no direct talk |
| Pipeline | chain | direct, request | neighbours only |
| Gossip network | mesh | gossip, blackboard | fanout 2 |
