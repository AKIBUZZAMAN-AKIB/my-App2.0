# Workflows: sub-agents that hand results to each other

Before, a sub-agent's report always went back to the agent that started it, which then had to forward it to the next sub-agent by hand. A **workflow** is a saved graph of steps whose results flow along its edges on their own, without going back through the main agent.

The design borrows from LangGraph (a state graph with conditional edges and bounded cycles), n8n (a visual node editor, error outputs), CrewAI and AutoGen (sequential and parallel crews, router and critic loops) and the OpenAI Agents SDK (handoffs chosen by the agent).

## Engine (`plugins/native-agent/rust/native-agent-ffi/src/subagents/workflows.rs`)

- **Nodes:** `agent` (a sub-agent with a task template), `router` (an agent that ends with `ROUTE: <label>`), `merge`, `transform` and `output` (text only, no model call).
- **Templates:** `{{input}}` is the run input, `{{inputs}}` every upstream result, `{{last}}` the newest one, `{{node.<id>}}` one step's result. If a task uses none of these, the upstream results are attached at the end.
- **Edges:** each edge can have a condition: `success` (the default), `always`, `failed` (an error path), `contains`, `not_contains`, `equals`, `regex`, `route` or `default` (taken when no sibling edge matched).
- **Parallel steps and joins:** several edges out of one node run in parallel. A node with several inputs waits for every live branch (`join: all`) or runs on the first one (`join: any`).
- **Loops:** a `loop: true` edge goes back to an earlier node and re-runs it, up to its `max_runs` (default 3). The re-run continues the same sub-agent, so it keeps its context. When a loop runs out of runs, its exit edges are taken with the latest result.
- **Errors:** each node can have `retries` (up to 3, and the sub-agent is told what failed). With `failFast` on (the default), the run stops when a node fails and no `failed` edge handles it.
- **Execution:** a dataflow scheduler. Each node passes a live or dead result along every outgoing edge, and a node whose inputs are all dead is skipped. There is a guard of 120 node runs per workflow run.
- **Storage:** `workflows.json` and `workflow_runs.json` (the last 60 runs) in the sub-agent state folder. Every change is sent to the app as a `workflow.run` event, which gives the live graph.

### Agent tool `workflow`

Actions: `create`, `update` (full or partial: `add_nodes`, `remove_nodes`, `add_edges`, `remove_edges`), `get`, `list`, `delete`, `run` (`wait` defaults to true and returns the final output), `status` and `stop`. The delegation prompt tells the agent to use a workflow instead of passing reports along by hand.

Example:

```json
{"action": "create", "name": "Research and write", "run": true, "input": "solid-state batteries",
 "nodes": [
   {"id": "research", "task": "Research {{input}} with sources"},
   {"id": "write", "task": "Write an article from: {{inputs}}"},
   {"id": "review", "task": "Reply APPROVED plus the final text, or list fixes: {{last}}"},
   {"id": "final", "kind": "output"}],
 "edges": [
   {"from": "research", "to": "write"}, {"from": "write", "to": "review"},
   {"from": "review", "to": "write", "loop": true, "when": {"type": "not_contains", "value": "APPROVED"}},
   {"from": "review", "to": "final", "when": {"type": "contains", "value": "APPROVED"}}]}
```

### App requests (`NativeKit.agent.subagents({action})`)

`workflows`, `workflowGet`, `workflowValidate`, `workflowSave`, `workflowDelete`, `workflowRun`, `workflowRuns`, `workflowRunGet` and `workflowStop`. The app shows the screen when the engine lists the feature `subagentWorkflows`.

## Visual graph (`tools/agent-html-src/21-agent-workflows.{js,css}`)

Open it from **Agents ▸ Workflows**. It has:

- A list of workflows and three templates: pipeline with a review loop, parallel analysts with a merge, and a triage router.
- An SVG canvas you can pan, pinch, wheel-zoom and fit to the screen. You drag nodes to move them, and drag from the dot on a node's right side onto another node to connect them. A link back to an earlier node becomes a loop, and links out of a router get its routes.
- An inspector for nodes and edges, client-side checks, auto-arrange, and save.
- Run with an input, and Stop. Node and edge status updates live during a run (running, done, failed, skipped, how many times an edge was used), and you can see each step's output and open its sub-agent. A run picker replays earlier runs on the graph.

Run `python3 tools/agent-html-src/build.py` after editing the sources.

Tests: `cargo test --lib workflow_tests`.
