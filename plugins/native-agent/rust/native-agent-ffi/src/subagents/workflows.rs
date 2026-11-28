//! Workflows: saved graphs of sub-agents that pass their results to each
//! other on their own.
//!
//! Without a workflow, a sub-agent's report always comes back to the agent
//! that started it, and that agent has to forward it to the next sub-agent by
//! hand. A workflow is a directed graph (nodes + edges) the agent (or the user
//! in the visual editor) builds once and runs as often as needed:
//!
//! - `agent` nodes run a sub-agent with a task template; `router` nodes are
//!   agent nodes that also pick a branch (`ROUTE: <label>`).
//! - `merge`, `transform` and `output` nodes shape text without a model call.
//! - Edges carry a node's output to the next node automatically. An edge may
//!   have a condition (`contains`, `not_contains`, `equals`, `regex`, `route`,
//!   `failed`, `always`, `default`), which gives branching and error paths.
//! - Several edges out of one node fan out in parallel; a node with several
//!   incoming edges joins them (`join: all` waits for every live branch,
//!   `join: any` runs on the first one).
//! - Edges marked `loop` go back to an earlier node (review / fix loops); the
//!   target's `max_runs` bounds the iterations. A loop re-run continues the
//!   same sub-agent, so it keeps its context.
//!
//! The executor is a small dataflow engine (Pregel / LangGraph style): every
//! finished node posts a live or dead delivery on each outgoing edge, a node
//! becomes ready once each forward predecessor has delivered or can no longer
//! deliver, and a node whose inputs are all dead is skipped, which propagates
//! along its edges. Runs are saved after every change and sent to the app as
//! `workflow.run` events, so the graph shows live status per node.

use super::*;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub const TOOL_WORKFLOW: &str = "workflow";
const WORKFLOWS_FILE: &str = "workflows.json";
const RUNS_FILE: &str = "workflow_runs.json";
const RUNS_KEPT: usize = 60;
const MAX_NODES: usize = 40;
const MAX_EDGES: usize = 120;
const MAX_ACTIVATIONS: u32 = 120;
const MAX_RUNS_CAP: u32 = 10;
const OUTPUT_CAP: usize = 12_000;
const INPUT_ID: &str = "__input__";

const NODE_KINDS: [&str; 5] = ["agent", "router", "merge", "transform", "output"];
const COND_TYPES: [&str; 9] = [
    "success",
    "always",
    "failed",
    "contains",
    "not_contains",
    "equals",
    "regex",
    "route",
    "default",
];

/// Live runs: run id -> stop switch.
fn live_runs() -> &'static StdMutex<HashMap<String, Arc<AtomicBool>>> {
    static LIVE: OnceLock<StdMutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    LIVE.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// One lock for the two workflow files.
fn file_lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

mod lenient_num {
    use serde::{Deserialize, Deserializer};
    use serde_json::Value;
    pub fn opt_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
        Ok(match Value::deserialize(d)? {
            Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)),
            Value::String(s) => s.trim().parse::<f64>().ok().map(|f| f.max(0.0) as u64),
            _ => None,
        })
    }
    pub fn opt_u32<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u32>, D::Error> {
        Ok(opt_u64(d)?.map(|v| v.min(u32::MAX as u64) as u32))
    }
    pub fn flag<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
        Ok(match Value::deserialize(d)? {
            Value::Bool(b) => b,
            Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
            Value::String(s) => matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "true" | "yes" | "1" | "on"
            ),
            _ => false,
        })
    }
    pub fn strings<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
        Ok(match Value::deserialize(d)? {
            Value::Array(a) => a
                .into_iter()
                .filter_map(|v| match v {
                    Value::String(s) => Some(s),
                    Value::Null => None,
                    other => Some(other.to_string()),
                })
                .collect(),
            Value::String(s) => s
                .split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect(),
            _ => Vec::new(),
        })
    }
    pub fn opt_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
        let v = strings(d)?;
        Ok(if v.is_empty() { None } else { Some(v) })
    }
}

// ── Data model ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct WfPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WfNode {
    pub id: String,
    /// agent | router | merge | transform | output
    pub kind: String,
    pub label: String,
    /// agent/router: the task template. `{{input}}` is the workflow input,
    /// `{{inputs}}` every upstream output, `{{last}}` the newest upstream
    /// output, `{{node.<id>}}` the latest output of a node.
    pub task: String,
    /// transform/output: the text template (same placeholders).
    pub template: String,
    pub name: Option<String>,
    pub role: Option<String>,
    #[serde(alias = "system_prompt")]
    pub system_prompt: Option<String>,
    #[serde(deserialize_with = "lenient_num::opt_strings")]
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(alias = "max_steps", deserialize_with = "lenient_num::opt_u32")]
    pub max_steps: Option<u32>,
    #[serde(alias = "timeout_seconds", deserialize_with = "lenient_num::opt_u64")]
    pub timeout_seconds: Option<u64>,
    /// Continue an existing sub-agent (id or name) instead of a new one.
    pub agent: Option<String>,
    /// router: the branch labels it chooses from.
    #[serde(deserialize_with = "lenient_num::strings")]
    pub routes: Vec<String>,
    /// all (default) | any
    pub join: String,
    #[serde(deserialize_with = "lenient_num::opt_u32")]
    pub retries: Option<u32>,
    /// How often it may run in one workflow run (loops). Default 1, or 3
    /// when a loop edge points at it.
    #[serde(alias = "max_runs", deserialize_with = "lenient_num::opt_u32")]
    pub max_runs: Option<u32>,
    pub position: Option<WfPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct WfCond {
    /// success (default) | always | failed | contains | not_contains |
    /// equals | regex | route | default
    #[serde(rename = "type", alias = "op")]
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct WfEdge {
    pub id: String,
    #[serde(alias = "source")]
    pub from: String,
    #[serde(alias = "target")]
    pub to: String,
    pub label: Option<String>,
    #[serde(alias = "condition")]
    pub when: Option<WfCond>,
    /// Goes back to an earlier node: re-runs it (bounded by its max_runs).
    #[serde(alias = "back", deserialize_with = "lenient_num::flag")]
    pub r#loop: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub nodes: Vec<WfNode>,
    pub edges: Vec<WfEdge>,
    /// Stop the whole run when a node fails and no `failed` edge handles it.
    #[serde(alias = "fail_fast")]
    pub fail_fast: Option<bool>,
    pub created_at: i64,
    pub updated_at: i64,
    pub created_in: String,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WfNodeState {
    /// pending | running | finished | error | skipped | cancelled
    pub status: String,
    pub runs: u32,
    pub attempts: u32,
    pub subagent_id: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub route: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WfEdgeState {
    /// idle | live | dead
    pub status: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub session_key: String,
    /// running | finished | error | cancelled | interrupted
    pub status: String,
    pub input: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub nodes: BTreeMap<String, WfNodeState>,
    pub edges: BTreeMap<String, WfEdgeState>,
    /// Node ids in the order they ran.
    pub trace: Vec<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

impl WfNode {
    fn kind(&self) -> &str {
        if self.kind.is_empty() {
            if !self.routes.is_empty() {
                "router"
            } else {
                "agent"
            }
        } else {
            &self.kind
        }
    }
    fn uses_agent(&self) -> bool {
        matches!(self.kind(), "agent" | "router")
    }
    fn join_any(&self) -> bool {
        self.join.eq_ignore_ascii_case("any")
    }
    fn title(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.id
        } else {
            self.label.trim()
        }
    }
}

fn slug(raw: &str) -> String {
    let mut s: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    while s.contains("__") {
        s = s.replace("__", "_");
    }
    let s = s.trim_matches('_').to_string();
    truncate_chars(&s, 40)
}

fn short_id(prefix: &str) -> String {
    format!(
        "{}_{}",
        prefix,
        &uuid::Uuid::new_v4().simple().to_string()[..10]
    )
}

/// Fill in ids, kinds and positions, then check the graph. Errors name the
/// node or edge and say how to fix it.
pub fn normalize_workflow(wf: &mut Workflow) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    if wf.name.trim().is_empty() {
        return Err("`name` is required.".into());
    }
    wf.name = truncate_chars(wf.name.trim(), 80);
    if wf.nodes.is_empty() {
        return Err("A workflow needs at least one node.".into());
    }
    if wf.nodes.len() > MAX_NODES {
        return Err(format!("At most {} nodes.", MAX_NODES));
    }
    if wf.edges.len() > MAX_EDGES {
        return Err(format!("At most {} edges.", MAX_EDGES));
    }
    let mut seen = HashSet::new();
    for (i, n) in wf.nodes.iter_mut().enumerate() {
        if n.id.trim().is_empty() {
            let base = slug(if n.label.is_empty() {
                &n.kind
            } else {
                &n.label
            });
            n.id = if base.is_empty() {
                format!("n{}", i + 1)
            } else {
                base
            };
        }
        n.id = n.id.trim().to_string();
        while seen.contains(&n.id) {
            n.id = format!("{}_{}", n.id, i + 1);
        }
        seen.insert(n.id.clone());
        if n.label.trim().is_empty() {
            n.label = n.id.clone();
        }
        n.kind = n.kind().trim().to_ascii_lowercase();
        if n.kind == "condition" || n.kind == "branch" {
            n.kind = "transform".into();
        }
        if !NODE_KINDS.contains(&n.kind.as_str()) {
            return Err(format!(
                "Node \"{}\": unknown kind \"{}\" (use {}).",
                n.id,
                n.kind,
                NODE_KINDS.join(", ")
            ));
        }
        let j = n.join.trim().to_ascii_lowercase();
        n.join = if j == "any" || j == "first" {
            "any".into()
        } else {
            "all".into()
        };
        n.routes = n
            .routes
            .iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if n.kind == "router" && n.routes.len() < 2 {
            return Err(format!("Router \"{}\" needs at least two `routes`.", n.id));
        }
        if n.uses_agent() && n.task.trim().is_empty() {
            return Err(format!("Agent node \"{}\" needs a `task`.", n.id));
        }
        if let Some(r) = n.retries {
            n.retries = Some(r.min(3));
        }
        if let Some(m) = n.max_runs {
            n.max_runs = Some(m.clamp(1, MAX_RUNS_CAP));
        }
    }
    let ids: HashSet<String> = wf.nodes.iter().map(|n| n.id.clone()).collect();
    // Edges may name a node by its id or its label.
    let by_label: HashMap<String, String> = wf
        .nodes
        .iter()
        .map(|n| (n.label.trim().to_ascii_lowercase(), n.id.clone()))
        .collect();
    let resolve = |r: &str| -> Option<String> {
        let r = r.trim();
        if ids.contains(r) {
            Some(r.to_string())
        } else {
            by_label.get(&r.to_ascii_lowercase()).cloned()
        }
    };
    let mut edge_ids = HashSet::new();
    for (i, e) in wf.edges.iter_mut().enumerate() {
        e.from =
            resolve(&e.from).ok_or_else(|| format!("Edge {}: no node \"{}\".", i + 1, e.from))?;
        e.to = resolve(&e.to).ok_or_else(|| format!("Edge {}: no node \"{}\".", i + 1, e.to))?;
        if e.from == e.to && !e.r#loop {
            return Err(format!(
                "Edge {} goes from \"{}\" to itself: mark it `loop: true`.",
                i + 1,
                e.from
            ));
        }
        if e.id.trim().is_empty() || edge_ids.contains(&e.id) {
            e.id = format!("e_{}_{}", e.from, e.to);
            let mut k = 2;
            while edge_ids.contains(&e.id) {
                e.id = format!("e_{}_{}_{}", e.from, e.to, k);
                k += 1;
            }
        }
        edge_ids.insert(e.id.clone());
        if let Some(c) = &mut e.when {
            c.kind = c.kind.trim().to_ascii_lowercase().replace(['-', ' '], "_");
            c.kind = match c.kind.as_str() {
                "" | "succeeded" | "ok" | "on_success" => "success".into(),
                "error" | "on_error" | "on_failure" | "failure" => "failed".into(),
                "else" | "otherwise" => "default".into(),
                "match" | "matches" => "regex".into(),
                "notcontains" | "excludes" => "not_contains".into(),
                "includes" => "contains".into(),
                other => other.to_string(),
            };
            if !COND_TYPES.contains(&c.kind.as_str()) {
                return Err(format!(
                    "Edge {} -> {}: unknown condition \"{}\" (use {}).",
                    e.from,
                    e.to,
                    c.kind,
                    COND_TYPES.join(", ")
                ));
            }
            if c.kind == "regex" {
                regex::Regex::new(&c.value)
                    .map_err(|err| format!("Edge {} -> {}: bad regex: {}", e.from, e.to, err))?;
            }
            if matches!(
                c.kind.as_str(),
                "contains" | "not_contains" | "equals" | "route"
            ) && c.value.trim().is_empty()
            {
                return Err(format!(
                    "Edge {} -> {}: condition \"{}\" needs a `value`.",
                    e.from, e.to, c.kind
                ));
            }
        }
    }
    for e in &wf.edges {
        if let Some(c) = &e.when {
            if c.kind == "route" {
                let src = wf.nodes.iter().find(|n| n.id == e.from).unwrap();
                if !src
                    .routes
                    .iter()
                    .any(|r| r.eq_ignore_ascii_case(c.value.trim()))
                {
                    return Err(format!(
                        "Edge {} -> {}: route \"{}\" is not one of {}'s routes ({}).",
                        e.from,
                        e.to,
                        c.value,
                        e.from,
                        src.routes.join(", ")
                    ));
                }
            }
        }
    }
    // Forward edges must not form a cycle.
    let order = topo_order(wf).ok_or_else(|| {
        "The edges form a cycle. Mark the edge that goes back to an earlier node with `loop: true` (and set that node's max_runs).".to_string()
    })?;
    // Loop targets run up to 3 times unless told otherwise.
    let loop_targets: HashSet<String> = wf
        .edges
        .iter()
        .filter(|e| e.r#loop)
        .map(|e| e.to.clone())
        .collect();
    for n in wf.nodes.iter_mut() {
        if loop_targets.contains(&n.id) && n.max_runs.is_none() {
            n.max_runs = Some(3);
        }
    }
    // The nodes inside a loop (on a forward path from its target back to its
    // source) may run as often as the target.
    for e in wf
        .edges
        .iter()
        .filter(|e| e.r#loop)
        .cloned()
        .collect::<Vec<_>>()
    {
        let fwd = |start: &str, rev: bool| -> HashSet<String> {
            let mut seen = HashSet::from([start.to_string()]);
            let mut stack = vec![start.to_string()];
            while let Some(id) = stack.pop() {
                for x in wf.edges.iter().filter(|x| !x.r#loop) {
                    let (a, b) = if rev {
                        (&x.to, &x.from)
                    } else {
                        (&x.from, &x.to)
                    };
                    if a == &id && seen.insert(b.clone()) {
                        stack.push(b.clone());
                    }
                }
            }
            seen
        };
        let body: HashSet<String> = fwd(&e.to, false)
            .intersection(&fwd(&e.from, true))
            .cloned()
            .collect();
        let cap = wf
            .nodes
            .iter()
            .find(|n| n.id == e.to)
            .and_then(|n| n.max_runs)
            .unwrap_or(3);
        for n in wf.nodes.iter_mut() {
            if body.contains(&n.id) && n.id != e.to {
                n.max_runs = Some(n.max_runs.unwrap_or(1).max(cap));
            }
        }
    }
    let entries: Vec<&WfNode> = wf
        .nodes
        .iter()
        .filter(|n| !wf.edges.iter().any(|e| !e.r#loop && e.to == n.id))
        .collect();
    if entries.is_empty() {
        return Err("No entry node (a node without incoming edges).".into());
    }
    for n in &wf.nodes {
        if n.kind == "router" {
            let outs: Vec<&WfEdge> = wf.edges.iter().filter(|e| e.from == n.id).collect();
            if !outs
                .iter()
                .any(|e| e.when.as_ref().is_some_and(|c| c.kind == "route"))
            {
                warnings.push(format!(
                    "Router \"{}\" has no `route` edges, so its choice changes nothing.",
                    n.id
                ));
            }
        }
    }
    layout_missing(wf, &order);
    Ok(warnings)
}

/// Topological order of the forward (non-loop) edges, or None on a cycle.
fn topo_order(wf: &Workflow) -> Option<Vec<String>> {
    let mut indeg: HashMap<&str, usize> = wf.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    for e in wf.edges.iter().filter(|e| !e.r#loop) {
        *indeg.get_mut(e.to.as_str())? += 1;
    }
    let mut q: VecDeque<&str> = wf
        .nodes
        .iter()
        .filter(|n| indeg[n.id.as_str()] == 0)
        .map(|n| n.id.as_str())
        .collect();
    let mut out = Vec::new();
    while let Some(id) = q.pop_front() {
        out.push(id.to_string());
        for e in wf.edges.iter().filter(|e| !e.r#loop && e.from == id) {
            let d = indeg.get_mut(e.to.as_str())?;
            *d -= 1;
            if *d == 0 {
                q.push_back(e.to.as_str());
            }
        }
    }
    (out.len() == wf.nodes.len()).then_some(out)
}

/// Layered layout (longest path from the entries) for nodes without a position.
fn layout_missing(wf: &mut Workflow, order: &[String]) {
    if wf.nodes.iter().all(|n| n.position.is_some()) {
        return;
    }
    let mut layer: HashMap<String, usize> = HashMap::new();
    for id in order {
        let l = wf
            .edges
            .iter()
            .filter(|e| !e.r#loop && &e.to == id)
            .filter_map(|e| layer.get(&e.from).map(|l| l + 1))
            .max()
            .unwrap_or(0);
        layer.insert(id.clone(), l);
    }
    let mut row: HashMap<usize, usize> = HashMap::new();
    for id in order {
        let l = layer[id];
        let r = row.entry(l).or_insert(0);
        let n = wf.nodes.iter_mut().find(|n| &n.id == id).unwrap();
        if n.position.is_none() {
            n.position = Some(WfPosition {
                x: 40.0 + l as f64 * 260.0,
                y: 40.0 + *r as f64 * 130.0,
            });
        }
        *r += 1;
    }
}

/// Fill `{{...}}` placeholders.
fn render_template(
    t: &str,
    input: &str,
    inputs: &[(String, String)],
    outputs: &HashMap<String, String>,
) -> String {
    let joined = format_inputs(inputs);
    let last = inputs.last().map(|x| x.1.clone()).unwrap_or_default();
    let re = regex::Regex::new(r"\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}").unwrap();
    re.replace_all(t, |c: &regex::Captures| {
        let key = &c[1];
        match key {
            "input" => input.to_string(),
            "inputs" => joined.clone(),
            "last" | "prev" | "previous" => last.clone(),
            _ => {
                let id = key
                    .strip_prefix("node.")
                    .or_else(|| key.strip_prefix("nodes."))
                    .unwrap_or(key);
                let id = id.strip_suffix(".output").unwrap_or(id);
                outputs.get(id).cloned().unwrap_or_else(|| c[0].to_string())
            }
        }
    })
    .into_owned()
}

fn format_inputs(inputs: &[(String, String)]) -> String {
    inputs
        .iter()
        .map(|(who, text)| format!("### From {}\n{}", who, text.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn mentions_inputs(t: &str) -> bool {
    let re = regex::Regex::new(r"\{\{\s*(inputs|last|prev|previous|node\.|nodes\.)").unwrap();
    re.is_match(t)
}

/// The `ROUTE: <label>` a router chose, matched to one of its routes.
fn parse_route(text: &str, routes: &[String]) -> Option<String> {
    let re =
        regex::Regex::new(r"(?im)^\s*\**\s*route\s*\**\s*[:=]\s*\**\s*`?([^`*\n]+?)`?\s*\**\s*$")
            .unwrap();
    let picked = re
        .captures_iter(text)
        .last()
        .map(|c| c[1].trim().to_ascii_lowercase())?;
    routes
        .iter()
        .find(|r| r.to_ascii_lowercase() == picked)
        .or_else(|| {
            routes
                .iter()
                .find(|r| picked.contains(&r.to_ascii_lowercase()))
        })
        .cloned()
}

fn strip_route(text: &str) -> String {
    let re = regex::Regex::new(r"(?im)^\s*\**\s*route\s*\**\s*[:=].*$").unwrap();
    re.replace_all(text, "").trim().to_string()
}

fn cond_holds(c: &WfCond, ok: bool, text: &str, route: Option<&str>) -> bool {
    let low = text.to_ascii_lowercase();
    let v = c.value.trim();
    let kind = if c.kind.is_empty() {
        "success"
    } else {
        c.kind.as_str()
    };
    match kind {
        "always" => true,
        "failed" => !ok,
        "default" => false,
        _ if !ok => false,
        "success" => true,
        "contains" => low.contains(&v.to_ascii_lowercase()),
        "not_contains" => !low.contains(&v.to_ascii_lowercase()),
        "equals" => text.trim().eq_ignore_ascii_case(v),
        "regex" => regex::Regex::new(v)
            .map(|r| r.is_match(text))
            .unwrap_or(false),
        "route" => route.is_some_and(|r| r.eq_ignore_ascii_case(v)),
        _ => false,
    }
}

// ── Executor ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Delivery {
    from: String,
    live: bool,
    text: String,
    seq: u64,
    via_loop: bool,
}

enum Outcome {
    Ok { text: String, route: Option<String> },
    Err(String),
    Cancelled,
}

struct NodeDone {
    node: String,
    outcome: Outcome,
    subagent: Option<String>,
    attempts: u32,
}

enum Ready {
    Run(Vec<(String, String)>),
    Skip,
    Wait,
}

struct Exec {
    wf: Workflow,
    inbox: HashMap<String, Vec<Delivery>>,
    consumed: HashMap<String, u64>,
    running: HashSet<String>,
    outputs: HashMap<String, String>,
    seq: u64,
}

impl Exec {
    fn node(&self, id: &str) -> &WfNode {
        self.wf.nodes.iter().find(|n| n.id == id).unwrap()
    }
    fn max_runs(&self, id: &str) -> u32 {
        self.node(id).max_runs.unwrap_or(1).clamp(1, MAX_RUNS_CAP)
    }
    fn preds(&self, id: &str) -> Vec<String> {
        let p: Vec<String> = self
            .wf
            .edges
            .iter()
            .filter(|e| !e.r#loop && e.to == id)
            .map(|e| e.from.clone())
            .collect();
        if p.is_empty() {
            vec![INPUT_ID.to_string()]
        } else {
            p
        }
    }
    fn deliver(&mut self, to: &str, from: &str, live: bool, text: String, via_loop: bool) {
        self.seq += 1;
        let d = Delivery {
            from: from.to_string(),
            live,
            text,
            seq: self.seq,
            via_loop,
        };
        self.inbox.entry(to.to_string()).or_default().push(d);
    }
    fn has_new(&self, id: &str) -> bool {
        let c = self.consumed.get(id).copied().unwrap_or(0);
        self.inbox
            .get(id)
            .is_some_and(|v| v.iter().any(|d| d.seq > c))
    }
    /// Nodes that may still produce a delivery, seen from `except`.
    fn active_reach(&self, except: &str) -> HashSet<String> {
        let mut stack: Vec<String> = self
            .wf
            .nodes
            .iter()
            .filter(|n| n.id != except && (self.running.contains(&n.id) || self.has_new(&n.id)))
            .map(|n| n.id.clone())
            .collect();
        let mut seen: HashSet<String> = stack.iter().cloned().collect();
        while let Some(id) = stack.pop() {
            for e in self.wf.edges.iter().filter(|e| e.from == id) {
                if e.to != except && seen.insert(e.to.clone()) {
                    stack.push(e.to.clone());
                }
            }
        }
        seen
    }
    fn readiness(&self, id: &str, runs: u32) -> Ready {
        let c = self.consumed.get(id).copied().unwrap_or(0);
        let all = self.inbox.get(id).cloned().unwrap_or_default();
        let new: Vec<&Delivery> = all.iter().filter(|d| d.seq > c).collect();
        if new.is_empty() || runs >= self.max_runs(id) {
            return Ready::Wait;
        }
        let node = self.node(id);
        let live_new = new.iter().any(|d| d.live);
        let reach = self.active_reach(id);
        let preds = self.preds(id);
        let settled = preds.iter().all(|p| {
            p == INPUT_ID || new.iter().any(|d| &d.from == p && !d.via_loop) || !reach.contains(p)
        });
        if node.join_any() {
            if live_new {
                let first = new.iter().find(|d| d.live).unwrap();
                return Ready::Run(vec![(self.label_of(&first.from), first.text.clone())]);
            }
            return if settled { Ready::Skip } else { Ready::Wait };
        }
        if !settled {
            return Ready::Wait;
        }
        if !live_new {
            return Ready::Skip;
        }
        // Latest live delivery from each predecessor, then new loop feedback.
        let mut inputs = Vec::new();
        for p in &preds {
            if let Some(d) = all.iter().rev().find(|d| &d.from == p && !d.via_loop) {
                if d.live && !(p == INPUT_ID && d.text.trim().is_empty()) {
                    inputs.push((self.label_of(p), d.text.clone()));
                }
            }
        }
        for d in new.iter().filter(|d| d.via_loop && d.live) {
            inputs.push((
                format!("{} (feedback)", self.label_of(&d.from)),
                d.text.clone(),
            ));
        }
        Ready::Run(inputs)
    }
    fn label_of(&self, id: &str) -> String {
        if id == INPUT_ID {
            return "workflow input".into();
        }
        self.wf
            .nodes
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.title().to_string())
            .unwrap_or_else(|| id.to_string())
    }
    fn consume(&mut self, id: &str) {
        let top = self
            .inbox
            .get(id)
            .and_then(|v| v.iter().map(|d| d.seq).max())
            .unwrap_or(0);
        self.consumed.insert(id.to_string(), top);
    }
}

impl SubagentManager {
    fn workflows_path(&self) -> PathBuf {
        self.state_dir.join(WORKFLOWS_FILE)
    }
    fn workflow_runs_path(&self) -> PathBuf {
        self.state_dir.join(RUNS_FILE)
    }

    pub fn workflows(&self) -> Vec<Workflow> {
        let _g = file_lock().lock().unwrap();
        fs_read_json(&self.workflows_path()).unwrap_or_default()
    }

    /// A workflow by id, or by name (case-insensitive).
    pub fn find_workflow(&self, key: &str) -> Option<Workflow> {
        let key = key.trim();
        let all = self.workflows();
        all.iter()
            .find(|w| w.id == key)
            .or_else(|| all.iter().find(|w| w.name.eq_ignore_ascii_case(key)))
            .cloned()
    }

    /// Validate and store a workflow (new, or replacing the one with its id).
    pub fn save_workflow(
        &self,
        mut wf: Workflow,
        session_key: &str,
    ) -> Result<(Workflow, Vec<String>), String> {
        let warnings = normalize_workflow(&mut wf)?;
        let _g = file_lock().lock().unwrap();
        let mut all: Vec<Workflow> = fs_read_json(&self.workflows_path()).unwrap_or_default();
        let now = now_ms();
        if wf.id.trim().is_empty() {
            wf.id = short_id("wf");
        }
        if let Some(old) = all.iter_mut().find(|w| w.id == wf.id) {
            wf.created_at = old.created_at;
            wf.created_in = old.created_in.clone();
            wf.version = old.version + 1;
            wf.updated_at = now;
            *old = wf.clone();
        } else {
            if all.iter().any(|w| w.name.eq_ignore_ascii_case(&wf.name)) {
                return Err(format!("A workflow called \"{}\" already exists; update it by its id or pick another name.", wf.name));
            }
            wf.created_at = now;
            wf.updated_at = now;
            wf.version = 1;
            if wf.created_in.is_empty() {
                wf.created_in = session_key.to_string();
            }
            all.push(wf.clone());
        }
        fs_write_json(&self.workflows_path(), &all);
        Ok((wf, warnings))
    }

    pub fn delete_workflow(&self, key: &str) -> bool {
        let Some(wf) = self.find_workflow(key) else {
            return false;
        };
        let _g = file_lock().lock().unwrap();
        let mut all: Vec<Workflow> = fs_read_json(&self.workflows_path()).unwrap_or_default();
        all.retain(|w| w.id != wf.id);
        fs_write_json(&self.workflows_path(), &all);
        true
    }

    /// Saved runs, newest first. Runs that were running when the app quit
    /// read as interrupted.
    pub fn workflow_runs(&self) -> Vec<WorkflowRun> {
        let _g = file_lock().lock().unwrap();
        let mut runs: Vec<WorkflowRun> =
            fs_read_json(&self.workflow_runs_path()).unwrap_or_default();
        let live = live_runs().lock().unwrap();
        for r in runs.iter_mut() {
            if r.status == "running" && !live.contains_key(&r.id) {
                r.status = "interrupted".into();
                for n in r.nodes.values_mut() {
                    if n.status == "running" || n.status == "pending" {
                        n.status = "cancelled".into();
                    }
                }
            }
        }
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        runs
    }

    pub fn workflow_run(&self, id: &str) -> Option<WorkflowRun> {
        self.workflow_runs().into_iter().find(|r| r.id == id)
    }

    fn store_run(&self, run: &WorkflowRun, app: &Option<Arc<dyn NativeEventCallback>>) {
        {
            let _g = file_lock().lock().unwrap();
            let mut runs: Vec<WorkflowRun> =
                fs_read_json(&self.workflow_runs_path()).unwrap_or_default();
            if let Some(r) = runs.iter_mut().find(|r| r.id == run.id) {
                *r = run.clone();
            } else {
                runs.push(run.clone());
            }
            runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
            runs.truncate(RUNS_KEPT);
            fs_write_json(&self.workflow_runs_path(), &runs);
        }
        let cb = app
            .clone()
            .or_else(|| self.last_app.lock().unwrap().clone());
        if let Some(cb) = cb {
            cb.on_event(
                "workflow.run".into(),
                serde_json::to_string(run).unwrap_or_default(),
            );
        }
    }

    pub fn stop_workflow_run(&self, run_id: &str) -> bool {
        match live_runs().lock().unwrap().get(run_id) {
            Some(f) => {
                f.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Start a run: returns its id at once and runs in the background.
    pub fn start_workflow(
        self: &Arc<Self>,
        wf: Workflow,
        input: String,
        parent_depth: u32,
        env: ParentEnv,
    ) -> WorkflowRun {
        let run = self.new_run(&wf, &input, &env);
        let stop = Arc::new(AtomicBool::new(false));
        live_runs()
            .lock()
            .unwrap()
            .insert(run.id.clone(), stop.clone());
        self.store_run(&run, &env.callback);
        let me = self.clone();
        let first = run.clone();
        tokio::spawn(async move {
            me.execute(wf, run, parent_depth, env, stop).await;
        });
        first
    }

    /// Run a workflow to the end and return the finished run.
    pub async fn run_workflow(
        self: &Arc<Self>,
        wf: Workflow,
        input: String,
        parent_depth: u32,
        env: ParentEnv,
    ) -> WorkflowRun {
        let run = self.new_run(&wf, &input, &env);
        let stop = Arc::new(AtomicBool::new(false));
        live_runs()
            .lock()
            .unwrap()
            .insert(run.id.clone(), stop.clone());
        self.store_run(&run, &env.callback);
        self.execute(wf, run, parent_depth, env, stop).await
    }

    fn new_run(&self, wf: &Workflow, input: &str, env: &ParentEnv) -> WorkflowRun {
        WorkflowRun {
            id: short_id("wr"),
            workflow_id: wf.id.clone(),
            workflow_name: wf.name.clone(),
            session_key: env.session_key.clone(),
            status: "running".into(),
            input: input.to_string(),
            nodes: wf
                .nodes
                .iter()
                .map(|n| {
                    (
                        n.id.clone(),
                        WfNodeState {
                            status: "pending".into(),
                            ..Default::default()
                        },
                    )
                })
                .collect(),
            edges: wf
                .edges
                .iter()
                .map(|e| {
                    (
                        e.id.clone(),
                        WfEdgeState {
                            status: "idle".into(),
                            count: 0,
                        },
                    )
                })
                .collect(),
            started_at: now_ms(),
            ..Default::default()
        }
    }

    async fn execute(
        self: &Arc<Self>,
        wf: Workflow,
        mut run: WorkflowRun,
        parent_depth: u32,
        env: ParentEnv,
        stop: Arc<AtomicBool>,
    ) -> WorkflowRun {
        let app = env.callback.clone();
        let fail_fast = wf.fail_fast.unwrap_or(true);
        let mut ex = Exec {
            wf: wf.clone(),
            inbox: HashMap::new(),
            consumed: HashMap::new(),
            running: HashSet::new(),
            outputs: HashMap::new(),
            seq: 0,
        };
        let entries: Vec<String> = wf
            .nodes
            .iter()
            .filter(|n| !wf.edges.iter().any(|e| !e.r#loop && e.to == n.id))
            .map(|n| n.id.clone())
            .collect();
        for id in &entries {
            ex.deliver(id, INPUT_ID, true, run.input.clone(), false);
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<NodeDone>();
        let mut activations = 0u32;
        let mut failure: Option<String> = None;
        let mut cancelled = false;
        loop {
            // Settle skips first (they can make others ready), then start runs.
            let mut to_start: Vec<(String, Vec<(String, String)>)> = Vec::new();
            if failure.is_none() && !cancelled {
                loop {
                    let mut changed = false;
                    for n in &wf.nodes {
                        if ex.running.contains(&n.id) || to_start.iter().any(|(id, _)| id == &n.id)
                        {
                            continue;
                        }
                        let runs = run.nodes.get(&n.id).map(|s| s.runs).unwrap_or(0);
                        if runs >= ex.max_runs(&n.id) && ex.has_new(&n.id) {
                            ex.consume(&n.id);
                            changed = true;
                            continue;
                        }
                        match ex.readiness(&n.id, runs) {
                            Ready::Wait => {}
                            Ready::Skip => {
                                ex.consume(&n.id);
                                let st = run.nodes.entry(n.id.clone()).or_default();
                                if st.status == "pending" {
                                    st.status = "skipped".into();
                                }
                                for e in wf.edges.iter().filter(|e| e.from == n.id && !e.r#loop) {
                                    ex.deliver(&e.to, &n.id, false, String::new(), false);
                                    run.edges.entry(e.id.clone()).or_default().status =
                                        "dead".into();
                                }
                                changed = true;
                            }
                            Ready::Run(inputs) => {
                                ex.consume(&n.id);
                                // Counts as running at once, so nothing downstream reads it as settled.
                                ex.running.insert(n.id.clone());
                                to_start.push((n.id.clone(), inputs));
                                changed = true;
                            }
                        }
                    }
                    if !changed {
                        break;
                    }
                }
            }
            for (id, inputs) in to_start {
                activations += 1;
                if activations > MAX_ACTIVATIONS || failure.is_some() {
                    if failure.is_none() {
                        failure = Some(format!(
                            "Stopped after {} node runs (loop guard).",
                            MAX_ACTIVATIONS
                        ));
                    }
                    ex.running.remove(&id);
                    run.nodes.entry(id.clone()).or_default().status = "cancelled".into();
                    continue;
                }
                let node = ex.node(&id).clone();
                let st = run.nodes.entry(id.clone()).or_default();
                st.status = "running".into();
                st.runs += 1;
                st.error = None;
                st.started_at = Some(now_ms());
                st.finished_at = None;
                let prev_sub = st.subagent_id.clone();
                run.trace.push(id.clone());
                ex.running.insert(id.clone());
                let me = self.clone();
                let tx = tx.clone();
                let env2 = env.clone();
                let stop2 = stop.clone();
                let input = run.input.clone();
                let outputs = ex.outputs.clone();
                let wf_name = wf.name.clone();
                let run_id = run.id.clone();
                tokio::spawn(async move {
                    let done = me
                        .run_node(
                            &wf_name,
                            &run_id,
                            node,
                            inputs,
                            input,
                            outputs,
                            prev_sub,
                            parent_depth,
                            env2,
                            stop2,
                        )
                        .await;
                    let _ = tx.send(done);
                });
            }
            self.store_run(&run, &app);
            if ex.running.is_empty() {
                break;
            }
            // Wait for the next node to finish, watching the stop switches.
            let done = loop {
                if stop.load(Ordering::SeqCst) || is_aborted(&env.abort) {
                    cancelled = true;
                }
                match tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
                    Ok(Some(d)) => break Some(d),
                    Ok(None) => break None,
                    Err(_) => continue,
                }
            };
            let Some(done) = done else { break };
            ex.running.remove(&done.node);
            let node = ex.node(&done.node).clone();
            let st = run.nodes.entry(done.node.clone()).or_default();
            st.finished_at = Some(now_ms());
            st.attempts = done.attempts;
            if done.subagent.is_some() {
                st.subagent_id = done.subagent.clone();
            }
            let outs: Vec<WfEdge> = wf
                .edges
                .iter()
                .filter(|e| e.from == done.node)
                .cloned()
                .collect();
            match done.outcome {
                Outcome::Cancelled => {
                    st.status = "cancelled".into();
                    cancelled = true;
                }
                Outcome::Ok { text, route } => {
                    st.status = "finished".into();
                    st.output = Some(truncate_chars(&text, OUTPUT_CAP));
                    st.route = route.clone();
                    ex.outputs.insert(done.node.clone(), text.clone());
                    let mut taken: Vec<bool> = outs
                        .iter()
                        .map(|e| {
                            cond_holds(
                                e.when.as_ref().unwrap_or(&WfCond::default()),
                                true,
                                &text,
                                route.as_deref(),
                            )
                        })
                        .collect();
                    // A loop that has used up its runs is not taken.
                    let mut exhausted = false;
                    for (i, e) in outs.iter().enumerate() {
                        if e.r#loop && taken[i] {
                            let runs = run.nodes.get(&e.to).map(|s| s.runs).unwrap_or(0);
                            if runs >= ex.max_runs(&e.to) {
                                taken[i] = false;
                                exhausted = true;
                            }
                        }
                    }
                    let forward_taken =
                        |t: &[bool]| outs.iter().zip(t).any(|(e, t)| *t && !e.r#loop);
                    let loop_taken = outs.iter().zip(&taken).any(|(e, t)| *t && e.r#loop);
                    if !forward_taken(&taken) && !loop_taken {
                        for (i, e) in outs.iter().enumerate() {
                            if !e.r#loop && e.when.as_ref().is_some_and(|c| c.kind == "default") {
                                taken[i] = true;
                            }
                        }
                    }
                    // Loop used up and no exit matched: go on with the latest result.
                    if exhausted && !forward_taken(&taken) && !loop_taken {
                        for (i, e) in outs.iter().enumerate() {
                            if !e.r#loop && !e.when.as_ref().is_some_and(|c| c.kind == "failed") {
                                taken[i] = true;
                            }
                        }
                    }
                    for (e, t) in outs.iter().zip(taken) {
                        self.route_edge(&mut ex, &mut run, e, t, &text);
                    }
                }
                Outcome::Err(err) => {
                    st.status = "error".into();
                    st.error = Some(truncate_chars(&err, 2000));
                    let mut handled = false;
                    for e in &outs {
                        let t = cond_holds(
                            e.when.as_ref().unwrap_or(&WfCond::default()),
                            false,
                            &err,
                            None,
                        );
                        handled |= t && e.when.as_ref().is_some_and(|c| c.kind == "failed");
                        let msg = format!("{} failed: {}", node.title(), err);
                        self.route_edge(&mut ex, &mut run, e, t, &msg);
                    }
                    if !handled && fail_fast && failure.is_none() {
                        failure = Some(format!("Node \"{}\" failed: {}", node.title(), err));
                    }
                }
            }
            if failure.is_some() || cancelled {
                // Stop what is still running, then collect it.
                for id in ex.running.iter() {
                    if let Some(sid) = run.nodes.get(id).and_then(|s| s.subagent_id.clone()) {
                        self.stop(&sid, "workflow stopped");
                    }
                }
                stop.store(true, Ordering::SeqCst);
            }
        }
        drop(tx);
        for st in run.nodes.values_mut() {
            if st.status == "pending" {
                st.status = if failure.is_some() || cancelled {
                    "cancelled".into()
                } else {
                    "skipped".into()
                };
            }
        }
        // Final output: `output` nodes, else the finished sinks.
        let outs: Vec<&WfNode> = {
            let o: Vec<&WfNode> = wf.nodes.iter().filter(|n| n.kind == "output").collect();
            if o.is_empty() {
                wf.nodes
                    .iter()
                    .filter(|n| !wf.edges.iter().any(|e| e.from == n.id && !e.r#loop))
                    .collect()
            } else {
                o
            }
        };
        let finals: Vec<(String, String)> = outs
            .iter()
            .filter(|n| run.nodes.get(&n.id).is_some_and(|s| s.status == "finished"))
            .filter_map(|n| {
                ex.outputs
                    .get(&n.id)
                    .map(|t| (n.title().to_string(), t.clone()))
            })
            .collect();
        run.output = match finals.len() {
            0 => None,
            1 => Some(truncate_chars(&finals[0].1, OUTPUT_CAP)),
            _ => Some(truncate_chars(&format_inputs(&finals), OUTPUT_CAP)),
        };
        run.status = if cancelled && failure.is_none() {
            "cancelled".into()
        } else if failure.is_some() {
            "error".into()
        } else if run.output.is_none() && run.nodes.values().any(|s| s.status == "error") {
            "error".into()
        } else {
            "finished".into()
        };
        if cancelled && failure.is_none() {
            run.error = Some("Stopped.".into());
        } else {
            run.error = failure.or_else(|| {
                (run.status == "error")
                    .then(|| "A node failed and no branch produced a result.".to_string())
            });
        }
        run.finished_at = Some(now_ms());
        live_runs().lock().unwrap().remove(&run.id);
        self.store_run(&run, &app);
        run
    }

    fn route_edge(
        &self,
        ex: &mut Exec,
        run: &mut WorkflowRun,
        e: &WfEdge,
        taken: bool,
        text: &str,
    ) {
        let es = run.edges.entry(e.id.clone()).or_default();
        if e.r#loop {
            if !taken {
                return;
            }
            let runs = run.nodes.get(&e.to).map(|s| s.runs).unwrap_or(0);
            if runs >= ex.max_runs(&e.to) {
                return; // loop exhausted
            }
            es.status = "live".into();
            es.count += 1;
            ex.deliver(&e.to, &e.from, true, text.to_string(), true);
            // The loop body runs again: its nodes are pending once more.
            if let Some(st) = run.nodes.get_mut(&e.to) {
                st.status = "pending".into();
            }
            return;
        }
        if taken {
            es.status = "live".into();
            es.count += 1;
        } else if es.status != "live" {
            es.status = "dead".into();
        }
        ex.deliver(
            &e.to,
            &e.from,
            taken,
            if taken {
                text.to_string()
            } else {
                String::new()
            },
            false,
        );
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_node(
        self: &Arc<Self>,
        wf_name: &str,
        run_id: &str,
        node: WfNode,
        inputs: Vec<(String, String)>,
        input: String,
        outputs: HashMap<String, String>,
        prev_sub: Option<String>,
        parent_depth: u32,
        env: ParentEnv,
        stop: Arc<AtomicBool>,
    ) -> NodeDone {
        let id = node.id.clone();
        let done = |outcome, subagent, attempts| NodeDone {
            node: id.clone(),
            outcome,
            subagent,
            attempts,
        };
        match node.kind() {
            "merge" => {
                return done(
                    Outcome::Ok {
                        text: format_inputs(&inputs),
                        route: None,
                    },
                    None,
                    1,
                )
            }
            "transform" | "output" => {
                let text = if node.template.trim().is_empty() {
                    if inputs.len() == 1 {
                        inputs[0].1.clone()
                    } else {
                        format_inputs(&inputs)
                    }
                } else {
                    render_template(&node.template, &input, &inputs, &outputs)
                };
                return done(Outcome::Ok { text, route: None }, None, 1);
            }
            _ => {}
        }
        // Agent / router: build the brief.
        let mut task = render_template(&node.task, &input, &inputs, &outputs);
        let is_entry_input = inputs.len() == 1 && inputs[0].0 == "workflow input";
        if !mentions_inputs(&node.task)
            && !inputs.is_empty()
            && !(is_entry_input && node.task.contains("{{"))
        {
            let only_input = is_entry_input && inputs[0].1.trim().is_empty();
            if !only_input {
                task.push_str("\n\n---\nInput passed to you by the workflow:\n\n");
                task.push_str(&format_inputs(&inputs));
            }
        }
        if !node.routes.is_empty() {
            task.push_str(&format!(
                "\n\n---\nYou decide where this workflow goes next. End your report with one last line, exactly `ROUTE: <label>`, where <label> is one of: {}.",
                node.routes.join(", ")
            ));
        }
        task.push_str(&format!(
            "\n\n(You are step \"{}\" of the workflow \"{}\". Your final report is passed on to the next step automatically, so make it complete and self-contained.)",
            node.title(),
            wf_name
        ));
        let retries = node.retries.unwrap_or(0);
        let mut sub = prev_sub.clone().or_else(|| node.agent.clone());
        let mut attempts = 0u32;
        let mut last_err = String::new();
        while attempts <= retries {
            attempts += 1;
            if stop.load(Ordering::SeqCst) {
                return done(Outcome::Cancelled, sub, attempts);
            }
            let brief = if attempts > 1 {
                format!(
                    "Your previous attempt failed: {}\nTry again.\n\n{}",
                    last_err, task
                )
            } else {
                task.clone()
            };
            let spec = SpawnSpec {
                task: brief,
                name: Some(
                    node.name
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| format!("wf-{}", slug(node.title()))),
                ),
                role: node.role.clone(),
                system_prompt: node.system_prompt.clone(),
                tools: node.tools.clone(),
                model: node.model.clone(),
                provider: node.provider.clone(),
                max_steps: node.max_steps,
                timeout_seconds: node.timeout_seconds,
                title: Some(truncate_chars(
                    &format!("{} · {}", wf_name, node.title()),
                    80,
                )),
                description: Some(format!("Workflow step (run {}).", run_id)),
                reuse: sub.clone().map(Value::String),
                ..Default::default()
            };
            let rec = match self.spawn_or_reuse(parent_depth, spec, &env) {
                Ok((r, _)) => r,
                Err(e) => {
                    last_err = e;
                    continue;
                }
            };
            sub = Some(rec.id.clone());
            let limit = Duration::from_secs(rec.timeout_seconds.max(60).saturating_mul(3) + 120);
            let deadline = Instant::now() + limit;
            loop {
                if stop.load(Ordering::SeqCst) || is_aborted(&env.abort) {
                    self.stop(&rec.id, "workflow stopped");
                    return done(Outcome::Cancelled, sub, attempts);
                }
                match self
                    .wait_for(
                        std::slice::from_ref(&rec.id),
                        None,
                        Duration::from_millis(800),
                    )
                    .await
                {
                    WaitEnd::Done => break,
                    _ if Instant::now() >= deadline => {
                        self.stop(&rec.id, "workflow step timed out");
                        break;
                    }
                    _ => {}
                }
            }
            let r = self.get(&rec.id).unwrap_or(rec);
            if r.status == "finished" {
                let raw = r.result.clone().unwrap_or_default();
                let route = if node.routes.is_empty() {
                    None
                } else {
                    parse_route(&raw, &node.routes)
                };
                let text = if node.routes.is_empty() {
                    raw
                } else {
                    strip_route(&raw)
                };
                return done(Outcome::Ok { text, route }, sub, attempts);
            }
            if r.status == "cancelled" && stop.load(Ordering::SeqCst) {
                return done(Outcome::Cancelled, sub, attempts);
            }
            last_err = format!(
                "{}{}",
                r.status,
                r.error.map(|e| format!(": {}", e)).unwrap_or_default()
            );
        }
        done(Outcome::Err(last_err), sub, attempts)
    }

    // ── Tool ───────────────────────────────────────────────────────────────

    pub(super) fn workflow_tool_definition() -> ToolDefinition {
        ToolDefinition {
            name: TOOL_WORKFLOW.into(),
            description: "Build and run workflows: saved graphs of sub-agents whose results flow to each other automatically, so you never have to relay one sub-agent's report to the next yourself. Use it for any multi-stage job (research -> write -> review, triage -> specialist, parallel analysts -> merger, draft <-> critic loops) and whenever the user asks for an automation, flow or pipeline. Nodes: `agent` (a sub-agent; `task` is its brief, upstream outputs are attached automatically or placed with {{inputs}}, {{last}}, {{node.<id>}}, {{input}} = the run input), `router` (an agent with `routes` that ends its report with `ROUTE: <label>`), `merge` (joins inputs), `transform`/`output` (a text `template`, no model call). Edges: {from, to, when?: {type, value}, loop?}. Conditions: success (default), always, failed (error path), contains, not_contains, equals, regex, route (router branch), default (taken when no sibling edge matched). Several edges out of one node run in parallel; a node with several inputs waits for all live branches (join: all) or the first (join: any). A `loop: true` edge goes back to an earlier node (e.g. critic -> writer when not_contains APPROVED); that node re-runs up to its max_runs (default 3) and keeps its context. Give the loop's exit edge the opposite condition (critic -> publish when contains APPROVED); when the loop runs out, the exit edges are taken with the latest result. The user sees every workflow as a live visual graph. Actions: create (name, nodes, edges; run=true with input to run at once), update (id + fields; or add_nodes / remove_nodes / add_edges / remove_edges), get, list, delete, run (id or name, input, wait=true by default returns the final output), status (run_id, or id for its latest run; wait=true blocks until it ends), stop (run_id).".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["create", "update", "get", "list", "delete", "run", "status", "stop"]},
                    "id": {"type": "string", "description": "Workflow id or name (update, get, delete, run, status)."},
                    "run_id": {"type": "string", "description": "Run id (status, stop)."},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "nodes": {"type": "array", "description": "The nodes (create, or replace all on update).", "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Short id such as 'research'."},
                            "kind": {"type": "string", "enum": ["agent", "router", "merge", "transform", "output"]},
                            "label": {"type": "string", "description": "Shown on the graph."},
                            "task": {"type": "string", "description": "agent/router: complete brief for the sub-agent."},
                            "template": {"type": "string", "description": "transform/output: text with {{inputs}}, {{last}}, {{node.<id>}}, {{input}}."},
                            "role": {"type": "string"},
                            "system_prompt": {"type": "string"},
                            "tools": {"type": "array", "items": {"type": "string"}, "description": "Tools this step may use (default: yours)."},
                            "model": {"type": "string"},
                            "provider": {"type": "string"},
                            "max_steps": {"type": "integer"},
                            "timeout_seconds": {"type": "integer"},
                            "agent": {"type": "string", "description": "Continue this existing sub-agent (id or name) instead of a new one."},
                            "routes": {"type": "array", "items": {"type": "string"}, "description": "router: branch labels."},
                            "join": {"type": "string", "enum": ["all", "any"]},
                            "retries": {"type": "integer", "minimum": 0, "maximum": 3},
                            "max_runs": {"type": "integer", "minimum": 1, "maximum": 10}
                        }
                    }},
                    "edges": {"type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "from": {"type": "string"},
                            "to": {"type": "string"},
                            "label": {"type": "string"},
                            "when": {"type": "object", "properties": {"type": {"type": "string", "enum": COND_TYPES}, "value": {"type": "string"}}},
                            "loop": {"type": "boolean"}
                        },
                        "required": ["from", "to"]
                    }},
                    "add_nodes": {"type": "array", "items": {"type": "object"}},
                    "remove_nodes": {"type": "array", "items": {"type": "string"}},
                    "add_edges": {"type": "array", "items": {"type": "object"}},
                    "remove_edges": {"type": "array", "items": {"type": "string"}, "description": "Edge ids, or 'from->to'."},
                    "fail_fast": {"type": "boolean", "description": "Stop the run when a node fails without a `failed` edge (default true)."},
                    "input": {"type": "string", "description": "run: the input the entry nodes get ({{input}})."},
                    "run": {"type": "boolean", "description": "create/update: run it right after saving."},
                    "wait": {"type": "boolean", "description": "run/status: wait for the end (default true for run)."},
                    "timeout_seconds": {"type": "integer", "description": "status with wait: longest wait."}
                },
                "required": ["action"]
            }),
            webview_only: false,
            approval_policy: None,
        }
    }

    pub(super) async fn workflow_tool(
        self: &Arc<Self>,
        parent_depth: u32,
        input: &Value,
        env: ParentEnv,
    ) -> (String, bool) {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("list")
            .trim()
            .to_ascii_lowercase();
        let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
        match action.as_str() {
            "list" => {
                let all = self.workflows();
                if all.is_empty() {
                    return (
                        "No workflows yet. Create one with action=create.".into(),
                        false,
                    );
                }
                let runs = self.workflow_runs();
                let lines: Vec<String> = all
                    .iter()
                    .map(|w| {
                        let last = runs.iter().find(|r| r.workflow_id == w.id);
                        format!(
                            "- {} (id {}): {} nodes, {} edges{}{}",
                            w.name,
                            w.id,
                            w.nodes.len(),
                            w.edges.len(),
                            if w.description.is_empty() {
                                String::new()
                            } else {
                                format!(" — {}", truncate_chars(&w.description, 120))
                            },
                            last.map(|r| format!("; last run {} ({})", r.id, r.status))
                                .unwrap_or_default()
                        )
                    })
                    .collect();
                (format!("Workflows:\n{}", lines.join("\n")), false)
            }
            "get" => match s("id").and_then(|k| self.find_workflow(&k)) {
                Some(w) => (
                    format!(
                        "{}\n\n{}",
                        describe(&w),
                        serde_json::to_string_pretty(&w).unwrap_or_default()
                    ),
                    false,
                ),
                None => ("No workflow with that id or name.".into(), true),
            },
            "delete" => match s("id") {
                Some(k) if self.delete_workflow(&k) => {
                    self.emit_workflows_changed(&env.callback);
                    (format!("Deleted workflow {}.", k), false)
                }
                _ => ("No workflow with that id or name.".into(), true),
            },
            "create" | "update" => {
                let mut wf = if action == "update" {
                    match s("id").and_then(|k| self.find_workflow(&k)) {
                        Some(w) => w,
                        None => return ("update: no workflow with that id or name.".into(), true),
                    }
                } else {
                    Workflow::default()
                };
                if let Err(e) = apply_edits(&mut wf, input) {
                    return (e, true);
                }
                let (wf, warnings) = match self.save_workflow(wf, &env.session_key) {
                    Ok(x) => x,
                    Err(e) => return (format!("Not saved: {}", e), true),
                };
                self.emit_workflows_changed(&env.callback);
                let mut out = format!(
                    "Saved workflow \"{}\" (id {}, version {}). The user can see and edit it as a graph in the Workflows screen.\n{}",
                    wf.name,
                    wf.id,
                    wf.version,
                    describe(&wf)
                );
                for w in warnings {
                    out.push_str(&format!("\nWarning: {}", w));
                }
                if input.get("run").and_then(Value::as_bool).unwrap_or(false) {
                    let (r, err) = self.run_from_tool(wf, input, parent_depth, env).await;
                    out.push_str("\n\n");
                    out.push_str(&r);
                    return (out, err);
                }
                (out, false)
            }
            "run" => {
                let Some(wf) = s("id")
                    .or_else(|| s("name"))
                    .and_then(|k| self.find_workflow(&k))
                else {
                    return (
                        "run: no workflow with that id or name. Use action=list.".into(),
                        true,
                    );
                };
                self.run_from_tool(wf, input, parent_depth, env).await
            }
            "status" => {
                let run = match s("run_id") {
                    Some(id) => self.workflow_run(&id),
                    None => s("id").and_then(|k| self.find_workflow(&k)).and_then(|w| {
                        self.workflow_runs()
                            .into_iter()
                            .find(|r| r.workflow_id == w.id)
                    }),
                };
                let Some(mut run) = run else {
                    return ("No such workflow run.".into(), true);
                };
                if input.get("wait").and_then(Value::as_bool).unwrap_or(false)
                    && run.status == "running"
                {
                    let secs = input
                        .get("timeout_seconds")
                        .and_then(Value::as_u64)
                        .unwrap_or(900)
                        .clamp(5, 3600);
                    let end = Instant::now() + Duration::from_secs(secs);
                    while run.status == "running" && Instant::now() < end && !is_aborted(&env.abort)
                    {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        match self.workflow_run(&run.id) {
                            Some(r) => run = r,
                            None => break,
                        }
                    }
                }
                let wf = self.find_workflow(&run.workflow_id);
                (report(&run, wf.as_ref()), run.status == "error")
            }
            "stop" => match s("run_id") {
                Some(id) if self.stop_workflow_run(&id) => (format!("Stopping run {}.", id), false),
                _ => ("No running workflow run with that id.".into(), true),
            },
            other => (format!("Unknown workflow action \"{}\".", other), true),
        }
    }

    async fn run_from_tool(
        self: &Arc<Self>,
        wf: Workflow,
        input: &Value,
        parent_depth: u32,
        env: ParentEnv,
    ) -> (String, bool) {
        let text = match input.get("input") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(v) => v.to_string(),
        };
        if !input.get("wait").and_then(Value::as_bool).unwrap_or(true) {
            let mut env = env;
            env.abort = None;
            let run = self.start_workflow(wf.clone(), text, parent_depth, env);
            return (
                format!("Started workflow \"{}\" in the background (run {}). Check it with action=status, run_id={} (wait=true to block until it ends).", wf.name, run.id, run.id),
                false,
            );
        }
        let run = self.run_workflow(wf.clone(), text, parent_depth, env).await;
        (report(&run, Some(&wf)), run.status == "error")
    }

    fn emit_workflows_changed(&self, app: &Option<Arc<dyn NativeEventCallback>>) {
        let cb = app
            .clone()
            .or_else(|| self.last_app.lock().unwrap().clone());
        if let Some(cb) = cb {
            cb.on_event(
                "workflow.changed".into(),
                json!({"count": self.workflows().len()}).to_string(),
            );
        }
    }

    // ── App requests ───────────────────────────────────────────────────────

    pub(super) fn workflow_app_request(
        self: &Arc<Self>,
        action: &str,
        req: &Value,
        env: &ParentEnv,
    ) -> Option<Result<Value, String>> {
        let s = |k: &str| req.get(k).and_then(Value::as_str).map(str::to_string);
        let out = match action {
            "workflows" | "workflowList" => {
                let runs = self.workflow_runs();
                let list: Vec<Value> = self
                    .workflows()
                    .into_iter()
                    .map(|w| {
                        let last = runs.iter().find(|r| r.workflow_id == w.id);
                        let mut v = serde_json::to_value(&w).unwrap_or(Value::Null);
                        v["lastRun"] = last.map(|r| json!({"id": r.id, "status": r.status, "startedAt": r.started_at})).unwrap_or(Value::Null);
                        v
                    })
                    .collect();
                Ok(json!({"workflows": list}))
            }
            "workflowGet" => match s("id").and_then(|k| self.find_workflow(&k)) {
                Some(w) => Ok(json!({"workflow": w})),
                None => Err("No such workflow.".into()),
            },
            "workflowValidate" | "workflowSave" => {
                let raw = req.get("workflow").cloned().unwrap_or(Value::Null);
                let mut wf: Workflow = match serde_json::from_value(raw) {
                    Ok(w) => w,
                    Err(e) => return Some(Err(format!("Invalid workflow: {}", e))),
                };
                if action == "workflowValidate" {
                    match normalize_workflow(&mut wf) {
                        Ok(w) => Ok(json!({"ok": true, "warnings": w, "workflow": wf})),
                        Err(e) => Ok(json!({"ok": false, "error": e})),
                    }
                } else {
                    match self.save_workflow(wf, &env.session_key) {
                        Ok((w, warnings)) => {
                            self.emit_workflows_changed(&env.callback);
                            Ok(json!({"workflow": w, "warnings": warnings}))
                        }
                        Err(e) => Err(e),
                    }
                }
            }
            "workflowDelete" => match s("id") {
                Some(k) if self.delete_workflow(&k) => {
                    self.emit_workflows_changed(&env.callback);
                    Ok(json!({"deleted": true}))
                }
                _ => Err("No such workflow.".into()),
            },
            "workflowRun" => match s("id").and_then(|k| self.find_workflow(&k)) {
                Some(w) => {
                    self.remember_app(&env.callback);
                    let run =
                        self.start_workflow(w, s("input").unwrap_or_default(), 0, env.clone());
                    Ok(json!({"run": run}))
                }
                None => Err("No such workflow.".into()),
            },
            "workflowRuns" => {
                let wid = s("workflowId").or_else(|| s("id"));
                let limit = req.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
                let runs: Vec<WorkflowRun> = self
                    .workflow_runs()
                    .into_iter()
                    .filter(|r| wid.as_ref().is_none_or(|w| &r.workflow_id == w))
                    .take(limit)
                    .collect();
                Ok(json!({"runs": runs}))
            }
            "workflowRunGet" => match s("runId").and_then(|id| self.workflow_run(&id)) {
                Some(r) => Ok(json!({"run": r})),
                None => Err("No such run.".into()),
            },
            "workflowStop" => {
                Ok(json!({"stopped": s("runId").is_some_and(|id| self.stop_workflow_run(&id))}))
            }
            _ => return None,
        };
        Some(out)
    }
}

/// Apply create/update arguments to a workflow.
fn apply_edits(wf: &mut Workflow, input: &Value) -> Result<(), String> {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    if let Some(n) = s("name") {
        wf.name = n;
    }
    if let Some(d) = s("description") {
        wf.description = d;
    }
    if let Some(f) = input.get("fail_fast").and_then(Value::as_bool) {
        wf.fail_fast = Some(f);
    }
    let parse_nodes = |v: &Value| -> Result<Vec<WfNode>, String> {
        serde_json::from_value(v.clone()).map_err(|e| format!("Invalid nodes: {}", e))
    };
    let parse_edges = |v: &Value| -> Result<Vec<WfEdge>, String> {
        serde_json::from_value(v.clone()).map_err(|e| format!("Invalid edges: {}", e))
    };
    if let Some(v) = input.get("nodes").filter(|v| v.is_array()) {
        let old: HashMap<String, Option<WfPosition>> = wf
            .nodes
            .iter()
            .map(|n| (n.id.clone(), n.position.clone()))
            .collect();
        wf.nodes = parse_nodes(v)?;
        for n in wf.nodes.iter_mut() {
            if n.position.is_none() {
                n.position = old.get(&n.id).cloned().flatten();
            }
        }
    }
    if let Some(v) = input.get("edges").filter(|v| v.is_array()) {
        wf.edges = parse_edges(v)?;
    }
    if let Some(Value::Array(rm)) = input.get("remove_nodes") {
        let rm: HashSet<String> = rm
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        wf.nodes
            .retain(|n| !rm.contains(&n.id) && !rm.contains(&n.label));
        let ids: HashSet<String> = wf.nodes.iter().map(|n| n.id.clone()).collect();
        wf.edges
            .retain(|e| ids.contains(&e.from) && ids.contains(&e.to));
    }
    if let Some(Value::Array(rm)) = input.get("remove_edges") {
        let rm: HashSet<String> = rm
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.replace(' ', "")))
            .collect();
        wf.edges
            .retain(|e| !rm.contains(&e.id) && !rm.contains(&format!("{}->{}", e.from, e.to)));
    }
    if let Some(v) = input.get("add_nodes").filter(|v| v.is_array()) {
        for n in parse_nodes(v)? {
            if let Some(old) = wf
                .nodes
                .iter_mut()
                .find(|o| !n.id.is_empty() && o.id == n.id)
            {
                let pos = old.position.clone();
                *old = n;
                if old.position.is_none() {
                    old.position = pos;
                }
            } else {
                wf.nodes.push(n);
            }
        }
    }
    if let Some(v) = input.get("add_edges").filter(|v| v.is_array()) {
        wf.edges.extend(parse_edges(v)?);
    }
    Ok(())
}

fn cond_text(e: &WfEdge) -> String {
    let mut t = match &e.when {
        Some(c) if c.kind != "success" && !c.kind.is_empty() => {
            if c.value.is_empty() {
                format!(" [{}]", c.kind)
            } else {
                format!(" [{} {:?}]", c.kind, c.value)
            }
        }
        _ => String::new(),
    };
    if e.r#loop {
        t.push_str(" (loop)");
    }
    t
}

/// A short text picture of the graph for the model.
fn describe(wf: &Workflow) -> String {
    let mut out = String::from("Nodes:\n");
    for n in &wf.nodes {
        out.push_str(&format!(
            "- {} [{}{}{}] {}\n",
            n.id,
            n.kind(),
            if n.join_any() { ", join any" } else { "" },
            n.max_runs
                .filter(|m| *m > 1)
                .map(|m| format!(", max_runs {}", m))
                .unwrap_or_default(),
            n.title()
        ));
    }
    out.push_str("Edges:\n");
    if wf.edges.is_empty() {
        out.push_str("(none)\n");
    }
    for e in &wf.edges {
        out.push_str(&format!("- {} -> {}{}\n", e.from, e.to, cond_text(e)));
    }
    out.trim_end().to_string()
}

/// The run's result for the model.
fn report(run: &WorkflowRun, wf: Option<&Workflow>) -> String {
    let mut out = format!(
        "Workflow \"{}\" run {}: {}.",
        run.workflow_name, run.id, run.status
    );
    if let Some(e) = &run.error {
        out.push_str(&format!(" {}", e));
    }
    out.push_str("\nSteps:");
    let order: Vec<String> = wf
        .map(|w| w.nodes.iter().map(|n| n.id.clone()).collect())
        .unwrap_or_else(|| run.nodes.keys().cloned().collect());
    for id in order {
        if let Some(st) = run.nodes.get(&id) {
            let label = wf
                .and_then(|w| w.nodes.iter().find(|n| n.id == id))
                .map(|n| n.title().to_string())
                .unwrap_or_else(|| id.clone());
            out.push_str(&format!(
                "\n- {} ({}): {}{}{}{}",
                label,
                id,
                st.status,
                if st.runs > 1 {
                    format!(", ran {} times", st.runs)
                } else {
                    String::new()
                },
                st.route
                    .as_ref()
                    .map(|r| format!(", route {}", r))
                    .unwrap_or_default(),
                st.error
                    .as_ref()
                    .map(|e| format!(", error: {}", truncate_chars(e, 300)))
                    .unwrap_or_default()
            ));
        }
    }
    match &run.output {
        Some(o) => out.push_str(&format!("\n\nFinal output:\n{}", o)),
        None if run.status == "running" => out.push_str("\n\nStill running."),
        None => out.push_str("\n\nNo final output."),
    }
    out
}
