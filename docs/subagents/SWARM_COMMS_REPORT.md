# Swarm comms: progress report

Branch `feat/subagent-comms` (off `wip/genui` `af10088`). Not pushed or merged.

## Done

- Phase 1: research and design, `docs/subagents/SWARM_COMMS_DESIGN.md`.
- Phase 2 and 3 (engine, Rust), one commit:
  - `subagents/channels.rs`: per-chat comms config (defaults `*` + chat overlay, validation, null clears), 9 built-in presets plus saved presets, topologies tree / star / mesh / ring / chain / bus / hierarchical / swarm / custom, allow/deny edges (deny wins), patterns that turn tools on, topics (pub/sub with history), versioned blackboard with reinforce / evaporation, request/reply with wait, timeout and wait-for-graph deadlock check, broadcast, hop limit, per-pair limit, chat message cap, per-chat pause, stop all, whoCanSpawn / whoCanBroadcast / blackboardWriters rules, app API (`commsConfig`, `setCommsConfig`, presets, `swarmState`, blackboard and topic actions, `setCommsRole`, `commsStopAll`).
  - `subagents/swarm.rs`: handoff (report follows the chain, loop and depth caps), gossip (fanout, seen-set, hop cap), contract net (announce / bid / award, policies best / cheapest / confident / first / manager), voting (majority / plurality / unanimous / supermajority + quorum), debate (rounds, convergence by POSITION line), leader election (rank or vote, numbered term, coordinator in prompts).
  - Batch `hub` (star hub or hierarchical lead), graph gains `handoffEdges`, `swarm`, node `topology` / `commsRole`; comms timeline lists `subagent.swarm_*` events.
  - Tests: `src/subagents/tests/swarm_tests.rs`, 17 tests; all 17 pass.

## Known issue

- `session_continuity_e2e_tests::bare_overflow_error_still_shrinks_from_what_was_sent` fails with these changes and passes without them (checked twice each way). Not investigated yet; likely the longer sub-agent tool list / prompt changes what fits in the test's tiny context window.

## Not done

- Phase 4: mock engine, UI (swarm/topology picker in spawn and batch dialogs, edge editor and edge drawing in Explorer, topics / blackboard / market / votes / debates panels, timeline kinds), Playwright suite, screenshots.
- Phase 5: full vitest and UI suites, Android ABI rebuild and `verify-abis --strict`.
