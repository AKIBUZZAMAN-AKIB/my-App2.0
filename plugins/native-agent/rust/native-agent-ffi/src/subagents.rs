//! Sub-agents: delegated agent runs with their own context, tools and memory.
//!
//! A parent agent (normally the main chat) calls `spawn_subagent`. The
//! sub-agent runs the regular agent loop in its own hidden session
//! (`subagent:<id>`, saved with agent id `subagent`, so it never shows up in
//! the normal chat list), with:
//! - a fresh context: it sees only the task brief, never the parent's chat;
//! - a narrowed tool list: the parent's tools ∩ the requested ones, minus the
//!   app's `ui__` tools; tool rules and approval settings still apply, and
//!   approval requests reach the app tagged with the sub-agent's id and name;
//! - limits: depth, parallel runs, token budget, steps and wall-clock time;
//! - its own memory store, keyed by its name (private / read_parent / shared).
//!
//! Design notes (checked against Claude Code's Task tool, the OpenAI Agents
//! SDK "agents as tools" pattern and LangGraph supervisors): the sub-agent is
//! exposed to the parent as a tool, returns one final report (not its whole
//! transcript) so the parent's context stays small, cannot spawn further
//! sub-agents by default (depth 1), and parallel work is started with
//! `wait=false` and collected with `list_subagents(wait=true)`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Mutex};

use crate::agent_loop::compaction::CompactionPolicy;
use crate::types::{Message, MessageContent, Role, SendMessageParams, TokenUsage, ToolDefinition};
use crate::{MemoryProvider, NativeAgentError, NativeEventCallback};

pub const TOOL_SPAWN: &str = "spawn_subagent";
pub const TOOL_LIST: &str = "list_subagents";
pub const TOOL_MESSAGE: &str = "message_subagent";
pub const TOOL_STOP: &str = "stop_subagent";
pub const TOOL_NAMES: [&str; 4] = [TOOL_SPAWN, TOOL_LIST, TOOL_MESSAGE, TOOL_STOP];
/// Agent id used for sub-agent sessions, so `list_sessions("main")` hides them.
pub const SESSION_AGENT_ID: &str = "subagent";
const REPORT_CAP: usize = 12_000;
const TASK_CAP: usize = 20_000;

/// The task text a new sub-agent gets: its own task whole first, then the
/// brief of the parent's running task (TCPE), all within `TASK_CAP`.
fn with_parent_context(task: &str, context: Option<&str>) -> String {
    let task = truncate_chars(task, TASK_CAP);
    let Some(ctx) = context.map(str::trim).filter(|c| !c.is_empty()) else {
        return task;
    };
    let head = "\n\n---\nParent task context (for reference):\n";
    let room = TASK_CAP.saturating_sub(task.chars().count() + head.chars().count());
    if room < 80 {
        return task;
    }
    format!(
        "{task}{head}{}",
        truncate_chars(ctx, room.saturating_sub(20))
    )
}

mod advanced;
mod allows;
mod branches;
mod channels;
mod comms;
mod compact;
mod cross_session;
mod data;
mod graph;
mod groups;
mod lifetime;
mod swarm;
mod team;
pub use channels::{CommsConfig, COMMS_TOOL_NAMES, PATTERNS};
pub use cross_session::{
    is_session_tool, AskRecord, ChatInfo, SESSION_TOOL_NAMES, TOOL_ASK_SESSION, TOOL_LIST_SESSIONS,
};
pub use data::{parse_parts, TrackedFile, DATA_PARTS};
pub use lifetime::{parse_lifetime, LifetimePolicy};
pub use team::{is_team_tool, normalize_topology, SubagentTemplate, TEAM_TOOL_NAMES, TOPOLOGIES};

pub fn is_subagent_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Separates a sub-agent's own instructions from the app's base prompt, so a
/// grandchild gets the base prompt once instead of its parent's wrapper.
const BASE_PROMPT_MARKER: &str = "\n\n---\n<!-- base prompt -->\n";

pub(crate) fn base_prompt(prompt: &str) -> &str {
    match prompt.find(BASE_PROMPT_MARKER) {
        Some(i) => &prompt[i + BASE_PROMPT_MARKER.len()..],
        None => prompt,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A creation stamp that never repeats: two sub-agents spawned in the same millisecond still get
/// distinct, ordered `created_at` values, so "the oldest" (rank election, lists sorted by age) is
/// the one spawned first rather than whichever random id sorts lower.
fn creation_ms() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = now_ms();
    let mut prev = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(prev + 1);
        match LAST.compare_exchange_weak(prev, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(p) => prev = p,
        }
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("\n…[truncated]");
    out
}

// ── Settings ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SubagentSettings {
    /// Offer the sub-agent tools to the agent at all.
    pub enabled: bool,
    /// How many levels of delegation are allowed. 1 = the main agent can
    /// spawn sub-agents, but sub-agents cannot spawn their own.
    pub max_depth: u32,
    /// Sub-agents running at the same time (across all parents).
    pub max_parallel: u32,
    /// Default total tokens (input + output, all steps) per run. 0 = no cap,
    /// like the main agent: the run is then bounded by its model's real
    /// context window, kept in it by auto-compaction, and by its step and
    /// time limits. A cap counts every resent prompt, so a small one stops a
    /// run long before its context could ever fill and compact.
    pub default_token_budget: u64,
    /// Default model calls (steps) per run.
    pub default_max_steps: u32,
    /// Wall-clock limit per run.
    pub timeout_seconds: u64,
    /// Default memory mode: private | read_parent | shared.
    pub default_memory: String,
    /// Finished records kept for review; the oldest finished ones are pruned.
    pub max_kept: u32,
    /// Spawns beyond `max_parallel` wait in a queue up to this length.
    pub max_queue: u32,
    /// Read-only tools in one turn run in parallel.
    pub parallel_read_tools: bool,
    /// Upper bound for those parallel reads.
    pub max_parallel_tools: u32,
    /// How long a tool waits for a file/device another run is using.
    pub lock_timeout_seconds: u64,
    /// The main agent may message other chats (each send needs approval).
    pub sessions_enabled: bool,
    pub session_timeout_seconds: u64,
    pub session_token_budget: u64,
    pub session_reply_max_chars: u32,
    /// The main agent may find and continue sub-agents started in other chats.
    pub reuse_across_chats: bool,
    /// Who may talk to whom: tree | star | mesh | ring | chain | bus | hierarchical | swarm | custom.
    pub topology: String,
    /// Sub-agents may ask their parent a question (ask_parent).
    pub allow_ask_parent: bool,
    /// What "Always allow" on an approval card covers: `chat` = this chat and
    /// its sub-agents (kept in session_allows.json), `global` = the tool's
    /// permission everywhere.
    pub always_allow_scope: String,
    /// Offer mesh and ring in the app's topology picker (tree and star are
    /// always offered). The engine accepts all four either way.
    pub show_advanced_topologies: bool,
    /// Automatic context compaction for every agent (the main agent and
    /// each sub-agent at every depth) unless an agent has its own setting.
    pub auto_compact: bool,
    /// Compaction starts when the transcript reaches this share (10-100 %)
    /// of the agent's transcript budget. 100 = when it no longer fits.
    pub compact_threshold_percent: u32,
    /// Routing rule: hold every agent-to-agent message (peer messages and
    /// asks to the parent) until the user turns it back on.
    pub comms_paused: bool,
    /// Agent-to-agent messages one agent may send per minute (0 = no limit).
    pub peer_rate_limit_per_min: u32,
    /// Version of the token-budget rules the saved file was written with.
    /// Files without it come from when 200k was the default cap (see `load`).
    pub token_budget_schema: u32,
}

/// The old default per-run cap. Settings, records and templates written
/// before `TOKEN_BUDGET_SCHEMA` that still hold exactly this value never
/// chose it: they move to 0 (no cap) once.
pub(crate) const LEGACY_DEFAULT_TOKEN_BUDGET: u64 = 200_000;
pub(crate) const TOKEN_BUDGET_SCHEMA: u32 = 2;

/// A per-run token cap as stored: 0 = no cap, else 1k..5M.
pub(crate) fn clamp_token_budget(budget: u64) -> u64 {
    if budget == 0 {
        0
    } else {
        budget.clamp(1_000, 5_000_000)
    }
}

impl Default for SubagentSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            // A sub-agent may start its own sub-agents (one more level).
            // Settings allow up to 3.
            max_depth: 2,
            max_parallel: 3,
            // No cap: like the main agent (see the field).
            default_token_budget: 0,
            default_max_steps: 25,
            timeout_seconds: 600,
            default_memory: "private".into(),
            max_kept: 100,
            max_queue: 20,
            parallel_read_tools: true,
            max_parallel_tools: 4,
            lock_timeout_seconds: 120,
            sessions_enabled: true,
            session_timeout_seconds: 180,
            session_token_budget: 60_000,
            session_reply_max_chars: 4_000,
            reuse_across_chats: false,
            topology: "tree".into(),
            allow_ask_parent: true,
            always_allow_scope: "chat".into(),
            show_advanced_topologies: false,
            auto_compact: true,
            compact_threshold_percent: 100,
            comms_paused: false,
            peer_rate_limit_per_min: 20,
            token_budget_schema: TOKEN_BUDGET_SCHEMA,
        }
    }
}

impl SubagentSettings {
    pub fn clamped(mut self) -> Self {
        self.max_depth = self.max_depth.min(3);
        self.max_parallel = self.max_parallel.clamp(1, 8);
        self.topology = team::normalize_topology(&self.topology);
        self.default_token_budget = clamp_token_budget(self.default_token_budget);
        self.token_budget_schema = TOKEN_BUDGET_SCHEMA;
        self.default_max_steps = self.default_max_steps.clamp(1, 200);
        self.timeout_seconds = self.timeout_seconds.clamp(5, 3_600);
        self.default_memory = MemoryMode::parse(&self.default_memory)
            .unwrap_or(MemoryMode::Private)
            .as_str()
            .into();
        self.max_kept = self.max_kept.clamp(10, 500);
        self.max_queue = self.max_queue.clamp(0, 100);
        self.peer_rate_limit_per_min = self.peer_rate_limit_per_min.min(600);
        self.compact_threshold_percent = self.compact_threshold_percent.clamp(
            CompactionPolicy::MIN_THRESHOLD,
            CompactionPolicy::MAX_THRESHOLD,
        );
        self.max_parallel_tools = self.max_parallel_tools.clamp(1, 16);
        self.lock_timeout_seconds = self.lock_timeout_seconds.clamp(5, 3_600);
        self.session_timeout_seconds = self.session_timeout_seconds.clamp(10, 1_800);
        self.session_token_budget = self.session_token_budget.clamp(1_000, 2_000_000);
        self.session_reply_max_chars = self.session_reply_max_chars.clamp(200, 20_000);
        self.always_allow_scope = if self
            .always_allow_scope
            .trim()
            .eq_ignore_ascii_case("global")
        {
            "global".into()
        } else {
            "chat".into()
        };
        self
    }

    /// Apply `patch` on top of `self` one field at a time. A field with a
    /// value of the wrong type is coerced when that is unambiguous ("3" for a
    /// number, "true" for a flag) and otherwise skipped, so one bad field
    /// never resets the others. Unknown keys are ignored. Returns the merged
    /// settings (clamped) and the keys that were rejected.
    pub fn merged(&self, patch: &Value) -> (Self, Vec<String>) {
        let mut rejected = Vec::new();
        let mut current = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        let (Some(obj), Some(p)) = (current.as_object_mut(), patch.as_object()) else {
            return (self.clone().clamped(), rejected);
        };
        for (raw_key, v) in p {
            let key = snake_to_camel(raw_key);
            let Some(base) = obj.get(&key).cloned() else {
                continue;
            };
            match coerce_like(&base, v) {
                Some(c) => {
                    let mut trial = Value::Object(obj.clone());
                    trial[&key] = c.clone();
                    if serde_json::from_value::<SubagentSettings>(trial).is_ok() {
                        obj.insert(key, c);
                    } else {
                        rejected.push(raw_key.clone());
                    }
                }
                None => rejected.push(raw_key.clone()),
            }
        }
        let next = serde_json::from_value::<SubagentSettings>(current)
            .unwrap_or_else(|_| self.clone())
            .clamped();
        (next, rejected)
    }

    /// Settings saved on disk, read leniently (see `merged`).
    pub fn load(path: &Path) -> Self {
        Self::load_migrating(path).0
    }

    /// Like `load`, and also says whether the file predates
    /// `TOKEN_BUDGET_SCHEMA`. Such a file still holding the old default
    /// 200k cap gets no cap, like a fresh install.
    pub fn load_migrating(path: &Path) -> (Self, bool) {
        match fs_read_json::<Value>(path) {
            Some(mut v) => {
                let legacy = v
                    .get("tokenBudgetSchema")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    < TOKEN_BUDGET_SCHEMA as u64;
                if legacy
                    && v.get("defaultTokenBudget").and_then(Value::as_u64)
                        == Some(LEGACY_DEFAULT_TOKEN_BUDGET)
                {
                    v["defaultTokenBudget"] = json!(0);
                }
                (SubagentSettings::default().merged(&v).0, legacy)
            }
            None => (SubagentSettings::default().clamped(), false),
        }
    }
    fn apply_scheduler(&self) {
        crate::tool_scheduler::configure(
            self.parallel_read_tools,
            self.max_parallel_tools,
            self.lock_timeout_seconds,
        );
    }
}

/// `max_depth` -> `maxDepth`; camelCase keys pass through.
fn snake_to_camel(k: &str) -> String {
    let mut out = String::with_capacity(k.len());
    let mut up = false;
    for c in k.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Coerce `v` to the JSON type of `base` when that is unambiguous.
fn coerce_like(base: &Value, v: &Value) -> Option<Value> {
    match base {
        Value::Bool(_) => match v {
            Value::Bool(b) => Some(json!(b)),
            Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "on" | "1" => Some(json!(true)),
                "false" | "no" | "off" | "0" => Some(json!(false)),
                _ => None,
            },
            Value::Number(n) => match n.as_i64() {
                Some(1) => Some(json!(true)),
                Some(0) => Some(json!(false)),
                _ => None,
            },
            _ => None,
        },
        Value::Number(_) => {
            let f = match v {
                Value::Number(n) => n.as_f64()?,
                Value::String(s) => s.trim().parse::<f64>().ok()?,
                _ => return None,
            };
            if !f.is_finite() || f < 0.0 || f.fract() != 0.0 || f > u64::MAX as f64 {
                return None;
            }
            Some(json!(f as u64))
        }
        Value::String(_) => match v {
            Value::String(s) => Some(json!(s)),
            _ => None,
        },
        _ => Some(v.clone()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryMode {
    /// Own store only.
    Private,
    /// Own store for writes; reads search its own store and the main memory.
    ReadParent,
    /// Reads and writes go straight to the parent's memory.
    Shared,
}

impl MemoryMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "private" | "isolated" | "own" => Some(Self::Private),
            "read_parent" | "readparent" | "read" | "inherit" => Some(Self::ReadParent),
            "shared" | "share" | "parent" => Some(Self::Shared),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::ReadParent => "read_parent",
            Self::Shared => "shared",
        }
    }
}

// ── Records ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    pub task: String,
    /// running | finished | error | cancelled | budget_exceeded | timeout | max_steps
    pub status: String,
    pub parent_session_key: String,
    pub session_key: String,
    pub depth: u32,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    pub tools: Vec<String>,
    pub memory_mode: String,
    pub token_budget: u64,
    pub max_steps: u32,
    pub timeout_seconds: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub steps: u32,
    #[serde(default)]
    pub tool_calls: u32,
    #[serde(default)]
    pub last_tool: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: i64,
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    #[serde(default)]
    pub runs: u32,
    /// Higher runs first when queued.
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub queued_at: Option<i64>,
    /// 1-based place in the queue while status is "queued".
    #[serde(default)]
    pub queue_position: Option<u32>,
    /// The record this one was re-run / forked from.
    #[serde(default)]
    pub forked_from: Option<String>,
    /// Files it wrote (tracked from write_file / edit_file).
    #[serde(default)]
    pub files: Vec<TrackedFile>,
    /// The user deleted its chat; a reuse starts from an empty history.
    #[serde(default)]
    pub chat_deleted: bool,
    /// Lineage: the sub-agent that spawned this one (None = the chat's agent).
    #[serde(default)]
    pub parent_id: Option<String>,
    /// The chat this sub-agent ultimately belongs to (its root session).
    #[serde(default)]
    pub root_session_key: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Template it was created from.
    #[serde(default)]
    pub template: Option<String>,
    /// Hidden from every other sub-agent (list_peers / message_peer).
    #[serde(default)]
    pub hidden: bool,
    /// Ids or names of sub-agents that must not see it.
    #[serde(default)]
    pub hidden_from: Vec<String>,
    /// Other chats may find and reuse it.
    #[serde(default)]
    pub shareable: bool,
    /// Explicit peers it may message (overrides the topology).
    #[serde(default)]
    pub can_message: Option<Vec<String>>,
    /// Peer messages waiting for its next run.
    #[serde(default)]
    pub inbox: Vec<String>,
    /// The parent's tool call (spawn_subagent) that started it, so the app
    /// can put its graph card in the message that made the call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_tool_call_id: Option<String>,
    /// Its own compaction setting; None = the chat-wide one in settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionPolicy>,
    /// Context fill after its last model call: estimatedTokens,
    /// budgetTokens, compactAtTokens, thresholdPercent, autoCompact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_status: Option<Value>,
    /// Compaction steps so far (tool results shortened, summary, trim).
    #[serde(default)]
    pub compactions: u32,
    /// The latest compaction event (kind, tokens before/after, trigger, at).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction: Option<Value>,
    /// Its own sampling temperature (0-2); None = the app's setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// How many levels of agents it may start below itself; None = what the
    /// chat-wide depth limit allows. Never more than that limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_child_depth: Option<u32>,
    /// Paused by the user: a queued run does not start until it is resumed.
    #[serde(default)]
    pub paused: bool,
    /// Its own agent-to-agent messages per minute; None = the chat-wide one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_rate_limit: Option<u32>,
    /// How the agent's context was seeded: `fresh` (brief only) or `fork`
    /// (the brief plus the recent transcript of the chat it was forked from).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_mode: Option<String>,
    /// The chat or agent session a `fork` context was copied from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_source: Option<String>,
    /// Agents this one waits for; their reports are added to its brief.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// Batch the agent was started in (`spawn_subagent` with `tasks`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// `parallel`, `pipeline`, `race`, `review` or `gather`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_index: Option<u32>,
    /// The race member that finished first, or the approved worker of a review.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub group_winner: bool,
    /// The parent handed the conversation over: its report is the answer.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub handoff: bool,
    /// Its own topology (who it may message), set when it was spawned (its
    /// own choice, its batch's, or inherited from its parent). None = the
    /// chat's topology.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topology: Option<String>,
    /// `hub` (the centre of a star), `lead` (a sub-team lead in the
    /// hierarchical topology) or `member`. None = decided by the team shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comms_role: Option<String>,
    /// May it broadcast to the team? None = the chat's broadcast rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_broadcast: Option<bool>,
    /// Swarm handoff: the peer it handed its task to (its report follows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handed_to: Option<String>,
    /// Swarm handoff: the peer that handed this task to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handed_from: Option<String>,
    /// Context tree stage 7: `temp` (deleted once its report reached the
    /// parent), `standby` (deleted after its idle TTL) or None = reusable
    /// (kept until the user deletes it, as before).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<String>,
    /// Its own standby TTL in seconds; None = the context tree's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standby_ttl_secs: Option<u64>,
    /// Its final answer is shown in the chat as its own message, and the
    /// parent gets it as a note instead of the full text.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub render_in_chat: bool,
    /// The latest report reached the parent (a tool result): a temp agent
    /// may now be deleted. Reset by every new run.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub report_delivered: bool,
    /// The parent context tree note that keeps its latest report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_note: Option<String>,
}

impl SubagentRecord {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
    pub fn is_running(&self) -> bool {
        self.status == "running"
    }
    /// Running or waiting in the queue.
    pub fn is_active(&self) -> bool {
        self.status == "running" || self.status == "queued"
    }
    fn summary(&self, with_report: bool) -> Value {
        let mut v = json!({
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "task": truncate_chars(&self.task, 200),
            "steps": self.steps,
            "toolCalls": self.tool_calls,
            "tokens": self.total_tokens(),
            "tokenBudget": self.token_budget,
        });
        if let Some(t) = &self.last_tool {
            v["lastTool"] = json!(t);
        }
        if let Some(e) = &self.error {
            v["error"] = json!(e);
        }
        if let Some(p) = self.queue_position {
            v["queuePosition"] = json!(p);
        }
        v["runs"] = json!(self.runs);
        v["memoryMode"] = json!(self.memory_mode);
        if let Some(l) = &self.lifetime {
            v["lifetime"] = json!(l);
        }
        v["lastActiveAt"] = json!(self.finished_at.unwrap_or(self.started_at));
        if self.chat_deleted {
            v["chatDeleted"] = json!(true);
        }
        if with_report && !self.is_active() {
            v["report"] = json!(truncate_chars(
                self.result.as_deref().unwrap_or(""),
                REPORT_CAP
            ));
        }
        v
    }
}

// ── Runner abstraction (real agent loop in production, scripted in tests) ──

pub struct RunRequest {
    pub id: String,
    pub params: SendMessageParams,
    pub prior_messages: Vec<Message>,
    pub callback: Arc<dyn NativeEventCallback>,
    pub abort: Arc<Mutex<bool>>,
    pub steer_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    pub memory: Option<Arc<dyn MemoryProvider>>,
    pub timeout_ms: u64,
    pub child: SubagentCtx,
}

pub struct RunDone {
    pub messages: Vec<Message>,
    pub model: String,
    pub provider: String,
    pub usage: Option<TokenUsage>,
}

pub type RunFuture = Pin<Box<dyn Future<Output = Result<RunDone, NativeAgentError>> + Send>>;

pub trait SubagentRunner: Send + Sync {
    fn run(&self, req: RunRequest) -> RunFuture;
    fn load_messages(&self, session_key: &str) -> Vec<Message>;
    fn save(
        &self,
        session_key: &str,
        done: &RunDone,
        started_at: i64,
        max_steps: u32,
        tools_json: &str,
    );
    fn clear(&self, session_key: &str);
    /// Its chat goes back to its first `keep_turns` turns (an edit, a retry, a
    /// restored version): forget the memory of the later ones, as the main
    /// chat's rewind does (`turn_memory::forget_after`).
    fn forget_turns_after(&self, _session_key: &str, _keep_turns: u32) {}
    /// Saved main chats (not sub-agent sessions), for cross-session asks.
    fn list_chats(&self) -> Vec<ChatInfo> {
        Vec::new()
    }
    /// Save a turn that ran in a main chat (cross-session ask).
    fn save_chat(&self, session_key: &str, done: &RunDone, started_at: i64) {
        self.save(session_key, done, started_at, 0, "null")
    }
}

/// Production runner: the regular agent loop and the engine's SQLite store.
pub struct EngineRunner {
    /// The engine's open chat, refreshed when another chat's ask adds a turn to it.
    pub current_session: Arc<Mutex<Option<crate::types::SessionState>>>,
    pub config: crate::types::InitConfig,
    pub approval_senders:
        Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<crate::types::ApprovalResponse>>>>,
    pub mcp_tools: Arc<Mutex<Vec<ToolDefinition>>>,
    pub mcp_pending:
        Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<crate::types::McpToolResult>>>>,
    pub webllm_pending: crate::protocol_drivers::WebLlmPending,
}

impl SubagentRunner for EngineRunner {
    fn run(&self, req: RunRequest) -> RunFuture {
        let config = self.config.clone();
        let approval_senders = self.approval_senders.clone();
        let mcp_tools = self.mcp_tools.clone();
        let mcp_pending = self.mcp_pending.clone();
        let webllm_pending = self.webllm_pending.clone();
        Box::pin(async move {
            let callback: Arc<dyn NativeEventCallback> = req.callback.clone();
            let turn = crate::agent_loop::run_agent_turn(crate::agent_loop::AgentLoopContext {
                config: &config,
                params: &req.params,
                callback: Some(callback),
                abort_flag: req.abort.clone(),
                is_background: false,
                wall_clock_timeout_ms: Some(req.timeout_ms),
                prior_messages: if req.prior_messages.is_empty() {
                    None
                } else {
                    Some(req.prior_messages)
                },
                approval_senders,
                steer_rx: req.steer_rx.clone(),
                mcp_tools,
                mcp_pending,
                webllm_pending,
                memory_provider: req.memory.clone(),
                skip_user_echo: false,
                session_key: req.params.session_key.clone(),
                subagents: Some(req.child.clone()),
                steer_hub: None,
            })
            .await?;
            Ok(RunDone {
                messages: turn.messages,
                model: turn.model,
                provider: turn.provider,
                usage: Some(turn.usage),
            })
        })
    }

    fn load_messages(&self, session_key: &str) -> Vec<Message> {
        crate::db::open_db(&self.config.db_path)
            .and_then(|conn| crate::db::load_session_messages_raw(&conn, session_key))
            .unwrap_or_default()
    }

    fn save(
        &self,
        session_key: &str,
        done: &RunDone,
        started_at: i64,
        max_steps: u32,
        tools_json: &str,
    ) {
        let Ok(conn) = crate::db::open_db(&self.config.db_path) else {
            return;
        };
        let Ok(messages_json) = serde_json::to_string(&done.messages) else {
            return;
        };
        let saved = crate::db::save_session(
            &conn,
            session_key,
            SESSION_AGENT_ID,
            &messages_json,
            Some(&done.model),
            Some(&done.provider),
            started_at,
            done.usage.as_ref(),
        )
        .is_ok();
        // Same retention as the main chat after its turn is saved.
        if saved {
            crate::turn_memory::retention::after_turn_saved(
                &conn,
                &self.config.workspace_path,
                session_key,
            );
        }
        let _ = crate::db::save_session_constraints(
            &conn,
            session_key,
            Some(max_steps),
            Some(tools_json),
        );
    }

    fn clear(&self, session_key: &str) {
        if let Ok(conn) = crate::db::open_db(&self.config.db_path) {
            let _ = crate::db::clear_session(&conn, session_key);
        }
        // `clear_session` deleted the turn memory and its queued jobs; stop a
        // background summary that is still running for it, as the main chat
        // does on memory.reset / rewind.
        crate::agent_loop::memory_worker::cancel(session_key);
    }

    fn forget_turns_after(&self, session_key: &str, keep_turns: u32) {
        let Ok(conn) = crate::db::open_db(&self.config.db_path) else {
            return;
        };
        let now = chrono::Utc::now().timestamp_millis();
        match crate::turn_memory::forget_after(&conn, session_key, keep_turns, now) {
            // It cancelled the chat's queued summary jobs; stop a running one too.
            Ok(_) => crate::agent_loop::memory_worker::cancel(session_key),
            Err(e) => tracing::warn!(session_key, "sub-agent memory rewind failed: {}", e),
        }
    }

    fn list_chats(&self) -> Vec<ChatInfo> {
        let Ok(conn) = crate::db::open_db(&self.config.db_path) else {
            return Vec::new();
        };
        let raw = crate::db::list_sessions(&conn, "main").unwrap_or_else(|_| "[]".into());
        let items: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
        items
            .into_iter()
            .take(50)
            .filter_map(|v| {
                let key = v.get("sessionKey")?.as_str()?.to_string();
                let messages =
                    crate::db::load_session_messages_raw(&conn, &key).unwrap_or_default();
                // A fallback title from the first thing the user typed.
                let title = messages
                    .iter()
                    .find_map(|m| match (&m.role, &m.content) {
                        (Role::User, MessageContent::Text(t)) => Some(t.clone()),
                        _ => None,
                    })
                    .map(|t| truncate_chars(t.lines().next().unwrap_or("").trim(), 60))
                    .unwrap_or_default();
                Some(ChatInfo {
                    session_key: key,
                    title,
                    updated_at: v.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
                    message_count: messages.len(),
                })
            })
            .collect()
    }

    fn save_chat(&self, session_key: &str, done: &RunDone, started_at: i64) {
        let Ok(conn) = crate::db::open_db(&self.config.db_path) else {
            return;
        };
        let Ok(messages_json) = serde_json::to_string(&done.messages) else {
            return;
        };
        let saved = crate::db::save_session(
            &conn,
            session_key,
            "main",
            &messages_json,
            Some(&done.model),
            Some(&done.provider),
            started_at,
            done.usage.as_ref(),
        )
        .is_ok();
        if saved {
            crate::turn_memory::retention::after_turn_saved(
                &conn,
                &self.config.workspace_path,
                session_key,
            );
        }
        // followUp() continues the in-memory session: keep it in step.
        if let Ok(mut cur) = self.current_session.try_lock() {
            if let Some(state) = cur.as_mut().filter(|s| s.session_key == session_key) {
                state.messages = done.messages.clone();
            }
        }
    }
}

// ── Manager ────────────────────────────────────────────────────────────────

/// Passed down through the agent loop so a loop knows its delegation depth.
#[derive(Clone)]
pub struct SubagentCtx {
    pub manager: Arc<SubagentManager>,
    /// 0 = the main agent, 1 = a sub-agent, …
    pub depth: u32,
}

impl SubagentCtx {
    /// Whether a loop at this depth gets the sub-agent tools.
    pub fn offers_tools(&self) -> bool {
        self.manager.offers_tools_at(self.depth)
    }
    /// Cross-session tools: the main agent only.
    pub fn offers_session_tools(&self) -> bool {
        self.depth == 0 && self.manager.settings().sessions_enabled
    }
}

/// What the parent loop hands over when it calls a sub-agent tool.
#[derive(Clone)]
pub struct ParentEnv {
    pub session_key: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: String,
    /// Tools the parent may use right now (already filtered by its allow-list
    /// and permissions), without `ui__` and sub-agent tools.
    pub tool_names: Vec<String>,
    pub callback: Option<Arc<dyn NativeEventCallback>>,
    pub memory: Option<Arc<dyn MemoryProvider>>,
    pub abort: Option<Arc<Mutex<bool>>>,
    /// A brief of the parent's running task (TCPE), prepended to a new
    /// sub-agent's task within `TASK_CAP`.
    pub task_context: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SpawnSpec {
    pub task: String,
    pub name: Option<String>,
    pub role: Option<String>,
    #[serde(alias = "systemPrompt")]
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(deserialize_with = "lenient::opt_strings")]
    pub tools: Option<Vec<String>>,
    #[serde(alias = "tokenBudget", deserialize_with = "lenient::opt_num")]
    pub token_budget: Option<u64>,
    #[serde(alias = "maxSteps", deserialize_with = "lenient::opt_num")]
    pub max_steps: Option<u32>,
    pub memory: Option<String>,
    #[serde(deserialize_with = "lenient::opt_bool")]
    pub wait: Option<bool>,
    #[serde(alias = "timeoutSeconds", deserialize_with = "lenient::opt_num")]
    pub timeout_seconds: Option<u64>,
    #[serde(deserialize_with = "lenient::opt_num")]
    pub priority: Option<i32>,
    /// Continue a past sub-agent instead: its id or name, or true to reuse
    /// the latest one called `name`.
    pub reuse: Option<Value>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// Saved template to start from.
    pub template: Option<String>,
    #[serde(deserialize_with = "lenient::opt_bool")]
    pub hidden: Option<bool>,
    #[serde(alias = "hiddenFrom", deserialize_with = "lenient::opt_strings")]
    pub hidden_from: Option<Vec<String>>,
    #[serde(deserialize_with = "lenient::opt_bool")]
    pub shareable: Option<bool>,
    #[serde(alias = "canMessage", deserialize_with = "lenient::opt_strings")]
    pub can_message: Option<Vec<String>>,
    /// The parent's tool call that started this run (set by the engine, not
    /// the model), so the app can draw the agent under the message that
    /// spawned it.
    #[serde(rename = "_toolCallId", alias = "spawnToolCallId")]
    pub spawn_tool_call_id: Option<String>,
    /// `fresh` (default) or `fork`: also give the child the recent transcript.
    pub context: Option<String>,
    #[serde(alias = "contextMessages", deserialize_with = "lenient::opt_num")]
    pub context_messages: Option<u32>,
    /// App only: the session a `fork` copies (default: the parent's).
    #[serde(alias = "forkSession")]
    pub fork_session: Option<String>,
    /// App only: copy messages before this index (fork from a message).
    #[serde(alias = "forkUpto", deserialize_with = "lenient::opt_num")]
    pub fork_upto: Option<u32>,
    /// App only: copy the first N user turns (and the replies to them), the
    /// same cut as the chat's "Fork from here".
    #[serde(alias = "forkUserTurns", deserialize_with = "lenient::opt_num")]
    pub fork_user_turns: Option<u32>,
    /// Ids or names of agents to wait for before starting (pipelines / DAGs).
    #[serde(alias = "dependsOn", deserialize_with = "lenient::opt_strings")]
    pub after: Option<Vec<String>>,
    #[serde(deserialize_with = "lenient::opt_bool")]
    pub handoff: Option<bool>,
    #[serde(skip)]
    pub group: Option<(String, String, u32)>,
    /// Who it may message: tree, star, mesh, ring, chain, bus, hierarchical
    /// or custom. Default: its parent's, else the chat's.
    pub topology: Option<String>,
    /// hub | lead | member.
    #[serde(alias = "commsRole")]
    pub comms_role: Option<String>,
    #[serde(alias = "canBroadcast", deserialize_with = "lenient::opt_bool")]
    pub can_broadcast: Option<bool>,
    /// `temp`, `reusable` (default) or `standby` (context tree stage 7).
    pub lifetime: Option<String>,
    /// Standby TTL in seconds (default: the context tree setting).
    #[serde(
        alias = "ttlSecs",
        alias = "standbyTtlSecs",
        alias = "standby_ttl_secs",
        deserialize_with = "lenient::opt_num"
    )]
    pub ttl_secs: Option<u64>,
    /// Show its final answer in the chat as its own message.
    #[serde(alias = "renderInChat", deserialize_with = "lenient::opt_bool")]
    pub render_in_chat: Option<bool>,
}

/// Tool arguments from small models are often stringly typed ("true", "3",
/// "a, b"). These accept those forms and treat null as absent.
pub(crate) mod lenient {
    use serde::{de::Error, Deserialize, Deserializer};
    use serde_json::Value;

    pub fn opt_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
        match Value::deserialize(d)? {
            Value::Null => Ok(None),
            Value::Bool(b) => Ok(Some(b)),
            Value::Number(n) if n.as_i64() == Some(1) => Ok(Some(true)),
            Value::Number(n) if n.as_i64() == Some(0) => Ok(Some(false)),
            Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                "" => Ok(None),
                "true" | "yes" | "1" | "on" => Ok(Some(true)),
                "false" | "no" | "0" | "off" => Ok(Some(false)),
                other => Err(D::Error::custom(format!(
                    "expected true or false, got \"{}\"",
                    other
                ))),
            },
            other => Err(D::Error::custom(format!(
                "expected true or false, got {}",
                other
            ))),
        }
    }

    pub fn opt_num<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: TryFrom<i64>,
    {
        let f = match Value::deserialize(d)? {
            Value::Null => return Ok(None),
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            Value::String(s) if s.trim().is_empty() => return Ok(None),
            Value::String(s) => s
                .trim()
                .parse::<f64>()
                .map_err(|_| D::Error::custom(format!("expected a number, got \"{}\"", s)))?,
            other => {
                return Err(D::Error::custom(format!(
                    "expected a number, got {}",
                    other
                )))
            }
        };
        if !f.is_finite() || f.fract() != 0.0 {
            return Err(D::Error::custom(format!(
                "expected a whole number, got {}",
                f
            )));
        }
        T::try_from(f as i64)
            .map(Some)
            .map_err(|_| D::Error::custom(format!("number out of range: {}", f)))
    }

    pub fn opt_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
        match Value::deserialize(d)? {
            Value::Null => Ok(None),
            Value::Array(a) => Ok(Some(
                a.into_iter()
                    .filter_map(|v| match v {
                        Value::String(s) => Some(s.trim().to_string()),
                        _ => None,
                    })
                    .filter(|s| !s.is_empty())
                    .collect(),
            )),
            Value::String(s) => {
                let t = s.trim();
                // A JSON array sent as a string.
                if t.starts_with('[') {
                    if let Ok(v) = serde_json::from_str::<Vec<String>>(t) {
                        return Ok(Some(
                            v.into_iter()
                                .map(|x| x.trim().to_string())
                                .filter(|x| !x.is_empty())
                                .collect(),
                        ));
                    }
                }
                Ok(Some(
                    t.split(',')
                        .map(|x| x.trim().to_string())
                        .filter(|x| !x.is_empty())
                        .collect(),
                ))
            }
            other => Err(D::Error::custom(format!(
                "expected a list of names, got {}",
                other
            ))),
        }
    }
}

/// A run waiting for a free slot.
struct Pending {
    prompt: String,
    /// Continue the saved conversation (`Some(prior)` = this exact history).
    prior: PendingPrior,
    env: ParentEnv,
    done_tx: Arc<watch::Sender<bool>>,
    done_rx: watch::Receiver<bool>,
    steers: Vec<String>,
    seq: u64,
}

enum PendingPrior {
    Fresh,
    Resume,
    Exact(Vec<Message>),
}

struct Live {
    abort: Arc<Mutex<bool>>,
    steer_tx: mpsc::UnboundedSender<String>,
    stop_reason: Arc<StdMutex<Option<String>>>,
    _done: Arc<watch::Sender<bool>>,
    done_rx: watch::Receiver<bool>,
}

pub struct SubagentManager {
    state_dir: PathBuf,
    runner: Arc<dyn SubagentRunner>,
    settings: StdMutex<SubagentSettings>,
    records: StdMutex<Vec<SubagentRecord>>,
    live: StdMutex<HashMap<String, Live>>,
    memory_lock: StdMutex<()>,
    pending: StdMutex<HashMap<String, Pending>>,
    seq: std::sync::atomic::AtomicU64,
    titles: StdMutex<HashMap<String, String>>,
    asks: StdMutex<Vec<AskRecord>>,
    asks_in_flight: StdMutex<HashMap<String, String>>,
    pub(crate) user_ask_aborts: StdMutex<HashMap<String, Arc<Mutex<bool>>>>,
    workspace: StdMutex<Option<String>>,
    /// Deletes asked for while a run was still stopping: (parts, everything).
    deferred_deletes: StdMutex<HashMap<String, (Vec<&'static str>, bool)>>,
    /// "Always allow" answers scoped to one chat: chat session key -> tools.
    session_allows: StdMutex<HashMap<String, Vec<String>>>,
    /// Attachments (JSON, as `SendMessageParams::attachments_json`) for the
    /// next run of a sub-agent: taken when the run starts.
    next_attachments: StdMutex<HashMap<String, String>>,
    /// Messages with attachments sent while it was running: started in order
    /// as soon as the current run ends (a steer carries text only).
    followups: StdMutex<HashMap<String, std::collections::VecDeque<FollowUp>>>,
    /// When each agent sent its recent agent-to-agent messages (rate limit).
    peer_sends: StdMutex<HashMap<String, std::collections::VecDeque<i64>>>,
    /// Per-chat communication config, topics, blackboard and comms events,
    /// plus saved comms presets (comms.json).
    comms_store: StdMutex<channels::CommsStore>,
    /// Swarm runtime: hop counts, per-pair sends, open requests and the
    /// wait-for graph (deadlock avoidance). Not persisted.
    swarm_rt: StdMutex<channels::Runtime>,
    /// Temp / standby lifetimes (context tree settings). Not persisted here:
    /// the app sets it from the context tree settings.
    lifetimes: StdMutex<LifetimePolicy>,
    /// The memory database holding the context tree, for keeping a deleted
    /// temp agent's report in its parent's tree.
    tree_db: StdMutex<Option<String>>,
    /// A lifetime sweep is running (persist() inside it must not start another).
    sweeping: std::sync::atomic::AtomicBool,
    /// The latest app callback, for `subagent.deleted` events of a sweep.
    last_app: StdMutex<Option<Arc<dyn NativeEventCallback>>>,
}

struct FollowUp {
    text: String,
    attachments_json: String,
    env: ParentEnv,
}

fn set_abort(flag: &Arc<Mutex<bool>>) {
    if let Ok(mut g) = flag.try_lock() {
        *g = true;
        return;
    }
    let flag = flag.clone();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            *flag.lock().await = true;
        });
    } else {
        *flag.blocking_lock() = true;
    }
}

fn is_aborted(flag: &Option<Arc<Mutex<bool>>>) -> bool {
    match flag {
        Some(f) => f.try_lock().map(|g| *g).unwrap_or(false),
        None => false,
    }
}

fn sanitize_name(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if (c == '-' || c == '_' || c == ' ' || c == '.') && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// One context-management event of a sub-agent's run, as its card records it:
/// `(kind, phase, counts as a compaction)`. `None` for events that are not a
/// compaction step. The sub-agent runs the main agent's own code for all of
/// these (`run_agent_turn` and `memory_loop::apply`); this only decides what
/// its Context tab shows, so it lists the same steps the main chat goes
/// through: the four overflow tiers, the turn-memory summary of the oldest
/// batch of turns (keep 7 recent, summarize 7 at a time, in the foreground or
/// by the background worker), and the shrink-and-retry after a provider
/// rejects the request as too long.
pub(crate) fn compaction_step(
    event: &str,
    payload: &Value,
) -> Option<(&'static str, &'static str, bool)> {
    Some(match event {
        "context.compaction_started" => ("compaction_started", "started", false),
        "context.compaction_deferred" => ("compaction_deferred", "deferred", false),
        "context.tool_results_compacted" => ("tool_results_compacted", "done", true),
        "context.explanations_shortened" => ("explanations_shortened", "done", true),
        "context.compacted" => ("compacted", "done", true),
        "context.trimmed" => ("trimmed", "done", true),
        "context.overflow"
            if payload
                .get("recovering")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            ("overflow_retry", "done", true)
        }
        "context.overflow" | "context.overflow_unrecoverable" => {
            ("overflow_retry", "failed", false)
        }
        "memory.queued" => ("memory_summary", "queued", false),
        "memory.summarizing" => ("memory_summary", "started", false),
        // `alreadyDone`: another writer had stored this batch; nothing new.
        "memory.updated"
            if payload
                .get("alreadyDone")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            return None
        }
        "memory.updated" => ("memory_summary", "done", true),
        "memory.pending" => ("memory_summary", "deferred", false),
        "memory.failed" => ("memory_summary", "failed", false),
        "memory.cancelled" => ("memory_summary", "cancelled", false),
        _ => return None,
    })
}

impl SubagentManager {
    /// `state_dir` holds settings, the run registry and per-name memory. It
    /// sits beside the workspace (like the tool rules), so the agent's own
    /// file tools cannot edit it.
    pub fn new(state_dir: PathBuf, runner: Arc<dyn SubagentRunner>) -> Arc<Self> {
        let titles_path = state_dir.join("session_titles.json");
        let state_dir_allows = state_dir.join(allows::SESSION_ALLOWS_FILE);
        let asks_path = state_dir.join("session_asks.json");
        let state_dir_comms = state_dir.join(channels::COMMS_FILE);
        let (settings, legacy_budgets) =
            SubagentSettings::load_migrating(&state_dir.join("settings.json"));
        let mut records = fs_read_json::<Vec<SubagentRecord>>(&state_dir.join("registry.json"))
            .unwrap_or_default();
        // Anything still "running" was cut off when the app last closed.
        let mut changed = false;
        if legacy_budgets {
            // Sub-agents made under the old 200k default keep no cap either,
            // so continuing one is not stopped long before it can compact.
            for r in records
                .iter_mut()
                .filter(|r| r.token_budget == LEGACY_DEFAULT_TOKEN_BUDGET)
            {
                r.token_budget = 0;
                changed = true;
            }
        }
        for r in records.iter_mut().filter(|r| r.is_active()) {
            r.error = Some(if r.status == "queued" {
                "The app closed while this sub-agent was waiting in the queue.".into()
            } else {
                "The app closed while this sub-agent was running.".into()
            });
            r.status = "error".into();
            r.queue_position = None;
            r.finished_at = Some(now_ms());
            changed = true;
        }
        let mgr = Arc::new(Self {
            state_dir,
            runner,
            settings: StdMutex::new(settings),
            records: StdMutex::new(records),
            live: StdMutex::new(HashMap::new()),
            memory_lock: StdMutex::new(()),
            pending: StdMutex::new(HashMap::new()),
            seq: std::sync::atomic::AtomicU64::new(0),
            titles: StdMutex::new(fs_read_json(&titles_path).unwrap_or_default()),
            asks: StdMutex::new(fs_read_json(&asks_path).unwrap_or_default()),
            asks_in_flight: StdMutex::new(HashMap::new()),
            user_ask_aborts: StdMutex::new(HashMap::new()),
            workspace: StdMutex::new(None),
            deferred_deletes: StdMutex::new(HashMap::new()),
            session_allows: StdMutex::new(fs_read_json(&state_dir_allows).unwrap_or_default()),
            next_attachments: StdMutex::new(HashMap::new()),
            followups: StdMutex::new(HashMap::new()),
            peer_sends: StdMutex::new(HashMap::new()),
            comms_store: StdMutex::new(channels::CommsStore::load(&state_dir_comms)),
            swarm_rt: StdMutex::new(channels::Runtime::default()),
            lifetimes: StdMutex::new(LifetimePolicy::default()),
            tree_db: StdMutex::new(None),
            sweeping: std::sync::atomic::AtomicBool::new(false),
            last_app: StdMutex::new(None),
        });
        mgr.settings().apply_scheduler();
        if legacy_budgets {
            mgr.migrate_legacy_template_budgets();
            // Written once with the new schema, so this runs only once.
            fs_write_json(&mgr.state_dir.join("settings.json"), &mgr.settings());
        }
        if changed {
            mgr.persist();
        }
        mgr
    }

    pub fn state_dir_for_workspace(workspace_path: &str) -> PathBuf {
        let ws = Path::new(workspace_path);
        ws.parent().unwrap_or(ws).join("subagents")
    }

    pub fn settings(&self) -> SubagentSettings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(self: &Arc<Self>, patch: &Value) -> SubagentSettings {
        self.set_settings_report(patch).0
    }

    /// Like `set_settings`, and also returns the keys whose values were
    /// rejected (the others still apply).
    pub fn set_settings_report(self: &Arc<Self>, patch: &Value) -> (SubagentSettings, Vec<String>) {
        let (next, rejected) = self.settings().merged(patch);
        *self.settings.lock().unwrap() = next.clone();
        fs_write_json(&self.state_dir.join("settings.json"), &next);
        next.apply_scheduler();
        // A higher parallel limit lets queued runs start now.
        self.pump();
        (next, rejected)
    }

    pub fn queued_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// Queue order: priority (high first), then round-robin across parents
    /// (each parent's 1st waiting run, then each one's 2nd, ...), then arrival.
    fn queue_order(&self) -> Vec<String> {
        let pending = self.pending.lock().unwrap();
        let recs = self.records.lock().unwrap();
        let mut items: Vec<(i32, String, u64, String)> = pending
            .iter()
            .filter(|(id, _)| !recs.iter().any(|r| &r.id == *id && r.paused))
            .filter(|(id, _)| !Self::blocked_in(&recs, id))
            .map(|(id, p)| {
                let r = recs.iter().find(|r| &r.id == id);
                (
                    r.map(|r| r.priority).unwrap_or(0),
                    r.map(|r| r.parent_session_key.clone()).unwrap_or_default(),
                    p.seq,
                    id.clone(),
                )
            })
            .collect();
        items.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)));
        let mut ordinal: HashMap<(i32, String), u32> = HashMap::new();
        let mut keyed: Vec<(i32, u32, u64, String)> = items
            .into_iter()
            .map(|(pr, parent, seq, id)| {
                let n = ordinal.entry((pr, parent)).or_insert(0);
                *n += 1;
                (pr, *n, seq, id)
            })
            .collect();
        keyed.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        keyed.into_iter().map(|k| k.3).collect()
    }

    /// Refresh queue positions and tell the app about any that moved.
    fn refresh_positions(&self) {
        let order = self.queue_order();
        let mut moved = Vec::new();
        {
            let mut recs = self.records.lock().unwrap();
            for r in recs.iter_mut() {
                let pos = order
                    .iter()
                    .position(|id| id == &r.id)
                    .map(|i| i as u32 + 1);
                let pos = if r.status == "queued" { pos } else { None };
                if r.queue_position != pos {
                    r.queue_position = pos;
                    if pos.is_some() {
                        moved.push(r.clone());
                    }
                }
            }
        }
        let total = order.len();
        for rec in moved {
            let cb = self
                .pending
                .lock()
                .unwrap()
                .get(&rec.id)
                .and_then(|p| p.env.callback.clone());
            self.emit(
                &cb,
                "subagent.queued",
                &rec,
                json!({ "queuePosition": rec.queue_position, "queueLength": total }),
            );
        }
    }

    /// Put a run in the queue (the record must already exist).
    fn enqueue(
        &self,
        id: &str,
        prompt: String,
        prior: PendingPrior,
        env: &ParentEnv,
    ) -> Result<SubagentRecord, String> {
        let settings = self.settings();
        if self.queued_count() >= settings.max_queue as usize {
            return Err(format!(
                "{} sub-agents are running and the queue is full ({} waiting). Wait for one with list_subagents(wait=true), or stop one.",
                self.running_count(),
                self.queued_count()
            ));
        }
        let (done_tx, done_rx) = watch::channel(false);
        let seq = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.update(id, |r| {
            r.status = "queued".into();
            r.queued_at = Some(now_ms());
        });
        self.pending.lock().unwrap().insert(
            id.to_string(),
            Pending {
                prompt,
                prior,
                env: env.clone(),
                done_tx: Arc::new(done_tx),
                done_rx,
                steers: Vec::new(),
                seq,
            },
        );
        self.refresh_positions();
        self.persist();
        self.get(id)
            .ok_or_else(|| "Sub-agent disappeared.".to_string())
    }

    /// Start or queue a run for an existing record.
    fn launch(
        self: &Arc<Self>,
        id: &str,
        prompt: String,
        prior: PendingPrior,
        env: &ParentEnv,
    ) -> Result<SubagentRecord, String> {
        let settings = self.settings();
        let nested = self.borrows_parent_slot(&env.session_key);
        if !nested
            && (self.running_count() >= settings.max_parallel as usize || self.queued_count() > 0)
        {
            let rec = self.enqueue(id, prompt, prior, env)?;
            self.pump();
            return Ok(self.get(id).unwrap_or(rec));
        }
        let prior = match prior {
            PendingPrior::Fresh => Vec::new(),
            PendingPrior::Resume => self
                .get(id)
                .map(|r| self.runner.load_messages(&r.session_key))
                .unwrap_or_default(),
            PendingPrior::Exact(m) => m,
        };
        let rec = self
            .update(id, |r| {
                r.status = "running".into();
                r.queue_position = None;
                r.started_at = now_ms();
            })
            .ok_or("Sub-agent disappeared.")?;
        self.persist();
        self.start_run(&rec, prompt, prior, env, None, Vec::new());
        Ok(rec)
    }

    /// Start queued runs while there are free slots.
    fn pump(self: &Arc<Self>) {
        loop {
            let max = self.settings().max_parallel as usize;
            // The first run in queue order that may start: a free slot, or a
            // run whose parent is running and waiting for it (nested runs
            // borrow the parent's slot, as in `launch`).
            let order = self.queue_order();
            let next = order.into_iter().find(|id| {
                if self.running_count() < max {
                    return true;
                }
                let key = self
                    .pending
                    .lock()
                    .unwrap()
                    .get(id)
                    .map(|p| p.env.session_key.clone());
                key.is_some_and(|k| self.borrows_parent_slot(&k))
            });
            let Some(next) = next else { break };
            let Some(mut p) = self.pending.lock().unwrap().remove(&next) else {
                break;
            };
            // An agent it waited for did not finish: do not start on a broken input.
            if let Some(err) = self.failed_dependency(&next) {
                let rec = self.update(&next, |r| {
                    r.status = "cancelled".into();
                    r.queue_position = None;
                    r.error = Some(err.clone());
                    r.finished_at = Some(now_ms());
                    r.result.get_or_insert_with(String::new);
                });
                self.persist();
                if let Some(rec) = rec {
                    self.emit(
                        &p.env.callback,
                        "subagent.cancelled",
                        &rec,
                        json!({ "report": "", "whileQueued": true, "dependencyFailed": true }),
                    );
                }
                let _ = p.done_tx.send(true);
                continue;
            }
            p.prompt.push_str(&self.dependency_reports(&next));
            let prior = match p.prior {
                PendingPrior::Fresh => Vec::new(),
                PendingPrior::Resume => self
                    .get(&next)
                    .map(|r| self.runner.load_messages(&r.session_key))
                    .unwrap_or_default(),
                PendingPrior::Exact(m) => m,
            };
            let Some(rec) = self.update(&next, |r| {
                r.status = "running".into();
                r.queue_position = None;
                r.started_at = now_ms();
            }) else {
                let _ = p.done_tx.send(true);
                continue;
            };
            self.persist();
            self.start_run(
                &rec,
                p.prompt,
                prior,
                &p.env,
                Some((p.done_tx, p.done_rx)),
                p.steers,
            );
        }
        self.refresh_positions();
    }

    pub fn offers_tools_at(&self, depth: u32) -> bool {
        let s = self.settings.lock().unwrap();
        let max = if team::normalize_topology(&s.topology) == "star" {
            s.max_depth.min(1)
        } else {
            s.max_depth
        };
        s.enabled && depth < max
    }

    pub fn get(&self, id: &str) -> Option<SubagentRecord> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.id == id)
            .cloned()
    }

    pub fn list(&self) -> Vec<SubagentRecord> {
        let mut v = self.records.lock().unwrap().clone();
        v.reverse(); // newest first
        v
    }

    /// A run started by a running sub-agent uses its parent's slot: the
    /// parent is (usually) blocked waiting for it, so queueing it behind the
    /// parallel limit would deadlock nested delegation.
    fn borrows_parent_slot(&self, parent_session_key: &str) -> bool {
        let hard_cap = (self.settings().max_parallel as usize) * 4;
        self.record_by_session(parent_session_key)
            .is_some_and(|p| p.is_running())
            && self.running_count() < hard_cap
    }

    pub fn running_count(&self) -> usize {
        self.live.lock().unwrap().len()
    }

    fn update<F: FnOnce(&mut SubagentRecord)>(&self, id: &str, f: F) -> Option<SubagentRecord> {
        let mut recs = self.records.lock().unwrap();
        let r = recs.iter_mut().find(|r| r.id == id)?;
        f(r);
        Some(r.clone())
    }

    fn persist(&self) {
        let max_kept = self.settings.lock().unwrap().max_kept as usize;
        let snapshot = {
            let mut recs = self.records.lock().unwrap();
            while recs.len() > max_kept {
                match recs.iter().position(|r| !r.is_active()) {
                    Some(i) => {
                        let old = recs.remove(i);
                        self.runner.clear(&old.session_key);
                        self.remove_log(&old.id);
                        self.remove_branches(&old.id);
                    }
                    None => break,
                }
            }
            recs.clone()
        };
        fs_write_json(&self.state_dir.join("registry.json"), &snapshot);
    }

    // ── Tool definitions and prompts ─────────────────────────────────────

    pub fn tool_definitions() -> Vec<ToolDefinition> {
        let def = |name: &str, description: &str, schema: Value| ToolDefinition {
            name: name.into(),
            description: description.into(),
            input_schema: schema,
            webview_only: false,
            approval_policy: None,
        };
        vec![
            def(
                TOOL_SPAWN,
                "Delegate a self-contained task to a sub-agent: a separate agent with a fresh context, its own memory and a subset of your tools. Use it for independent multi-step work (searching or reading many files, a focused change in one area, a review) or to run several independent tasks in parallel. The sub-agent cannot see this conversation or ask the user anything, so `task` must be a complete brief: the goal, relevant paths and facts, constraints, and what the final report must contain. It returns one final report. With wait=true (default) this call blocks until the report is ready. With wait=false it returns an id at once: start several, then call list_subagents with wait=true to collect the reports.",
                json!({
                    "type": "object",
                    "properties": {
                        "task": {"type": "string", "description": "With `tasks`: the shared goal and context every one of them gets above its own part. Otherwise: Complete, self-contained brief: goal, context, constraints, and the shape of the report you want back."},
                        "name": {"type": "string", "description": "Short handle such as 'researcher' or 'test-fixer'. Sub-agents with the same name share a memory store."},
                        "role": {"type": "string", "description": "One line describing the sub-agent's role or expertise."},
                        "system_prompt": {"type": "string", "description": "Optional extra instructions for how it should work."},
                        "tools": {"type": "array", "items": {"type": "string"}, "description": "Tool names it may use; must be tools you have. Default: all of your tools except UI tools. Give only what it needs."},
                        "model": {"type": "string", "description": "Optional model id. Default: the same model as you."},
                        "provider": {"type": "string", "description": "Optional provider id for `model`. Default: your provider."},
                        "token_budget": {"type": "integer", "minimum": 0, "description": "Optional cap on total tokens (input + output, all steps; every step resends its context) before it is stopped. Omit or 0 for no cap: like you, its context then stays within its model's real context window through auto-compaction."},
                        "max_steps": {"type": "integer", "minimum": 1, "description": "Maximum model calls."},
                        "memory": {"type": "string", "enum": ["private", "read_parent", "shared"], "description": "private: its own memory only. read_parent: its own memory, plus read access to the main memory. shared: reads and writes the main memory."},
                        "wait": {"type": "boolean", "description": "true (default): wait for the report. false: run in the background and return its id."},
                        "priority": {"type": "integer", "description": "Queue priority -10..10 (default 0). When the parallel limit is reached, new sub-agents wait in a queue; higher priority starts first."},
                        "reuse": {"description": "Continue an earlier sub-agent instead of starting a new one: its id or name, or true to reuse the latest one with this `name`. It keeps its chat history and memory, gets `task` as its next message, and follows your current tools and limits. If none matches, a new one starts.", "anyOf": [{"type": "string"}, {"type": "boolean"}]},
                        "title": {"type": "string", "description": "Short human title shown to the user, e.g. 'Find the CSE 201 syllabus'."},
                        "description": {"type": "string", "description": "One or two sentences for the user on what it does and why."},
                        "template": {"type": "string", "description": "Name of a saved sub-agent template to start from; your other fields override it."},
                        "hidden_from": {"type": "array", "items": {"type": "string"}, "description": "Ids or names of other sub-agents that must not see or message it."},
                        "can_message": {"type": "array", "items": {"type": "string"}, "description": "Ids or names it may message with message_peer (mesh/ring topologies). Default: whatever the topology allows."},
                        "context": {"type": "string", "enum": ["fresh", "fork"], "description": "fresh (default): it sees only your brief. fork: it also gets the recent messages of your conversation, for work that needs what was already said."},
                        "after": {"type": "array", "items": {"type": "string"}, "description": "Ids or names of sub-agents it must wait for. It starts when they all finish and gets their reports with its brief; if one fails it is cancelled."},
                        "handoff": {"type": "boolean", "description": "true: hand the answer over. Its report is your reply to the user, word for word; you add nothing and call no more tools this turn."},
                        "tasks": {"type": "array", "description": "Start several sub-agents in one call instead of one. Each item is a brief (string) or an object with the same fields as this tool (task, name, title, model, tools, ...); fields given outside `tasks` apply to all of them.", "items": {"anyOf": [{"type": "string"}, {"type": "object"}]}},
                        "mode": {"type": "string", "enum": ["parallel", "pipeline", "race", "review", "gather"], "description": "With `tasks`: parallel (default) runs them at once (fan-out) and returns every report; gather runs every brief but the last at once, then the last agent combines all their reports and you get only its one report (fan-out/gather, saves your context); pipeline runs them one after another, each getting the previous report; race runs them at once, keeps the first that finishes and stops the rest; review takes two briefs, a worker then a reviewer: the reviewer checks the work and its feedback goes back to the worker until it approves or `rounds` run out."},
                        "rounds": {"type": "integer", "minimum": 1, "maximum": 5, "description": "With mode review: most review rounds (default 3)."},
                        "topology": {"type": "string", "enum": ["tree", "star", "mesh", "ring", "chain", "bus", "hierarchical", "swarm", "custom"], "description": "Who it (or the batch) may message: tree up/down, star via hub, mesh anyone, ring/chain neighbours, bus topics+blackboard, hierarchical sub-teams, swarm decentralised, custom user edges. Default: yours, else the chat's."},
                        "hub": {"description": "With `tasks`: index or name of the star hub / hierarchical lead.", "anyOf": [{"type": "integer"}, {"type": "string"}]},
                        "comms_role": {"type": "string", "enum": ["hub", "lead", "member"]},
                        "lifetime": {"type": "string", "enum": ["temp", "reusable", "standby"], "description": "reusable (default): kept until the user deletes it; reuse it later by name. temp: deleted automatically once you have its report (one-off work). standby: kept for reuse, deleted after it has been idle for `ttl_secs`."},
                        "ttl_secs": {"type": "integer", "minimum": 300, "maximum": 2592000, "description": "With lifetime standby: idle seconds before it is deleted. Default: the user's setting (24 hours)."},
                        "render_in_chat": {"type": "boolean", "description": "true: its final answer is shown to the user in the chat as its own message, and you get it as a context tree note instead of the full text. Use for an answer the user should read as written."}
                    },
                    "required": ["task"]
                }),
            ),
            def(
                TOOL_LIST,
                "List or find the sub-agents you started in this chat, newest first, with status, steps, runs and token use. They persist across turns and app restarts, so use this to find one to reuse. With wait=true, block until the given sub-agents (default: all of yours that are running) finish, then return their final reports.",
                json!({
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Only sub-agents with this name."},
                        "query": {"type": "string", "description": "Text to look for in the task, name or role."},
                        "recent": {"type": "integer", "minimum": 1, "description": "Only the N most recently active."},
                        "scope": {"type": "string", "enum": ["chat", "all"], "description": "chat (default): this chat's. all: every chat's, only when the user allowed reuse across chats."},
                        "ids": {"type": "array", "items": {"type": "string"}, "description": "Only these sub-agents. Reports are included for finished ones."},
                        "status": {"type": "string", "enum": ["running", "queued", "active", "finished", "failed", "all"], "description": "Filter. Default: all."},
                        "wait": {"type": "boolean", "description": "Wait for them to finish and include their reports."},
                        "timeout_seconds": {"type": "integer", "minimum": 1, "description": "Longest time to wait. Default: the sub-agent time limit."}
                    }
                }),
            ),
            def(
                TOOL_MESSAGE,
                "Send a follow-up to one of your sub-agents. If it is running, the message is added to its context before its next step. If it has finished, it resumes with its previous context and works on the message; with wait=true (default) its new report is returned.",
                json!({
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "Sub-agent id, or its name (the latest one with that name), from spawn_subagent or list_subagents. Works in later turns too."},
                        "message": {"type": "string", "description": "The follow-up instruction or question."},
                        "wait": {"type": "boolean", "description": "For a finished sub-agent: wait for its new report (default true)."}
                    },
                    "required": ["id", "message"]
                }),
            ),
            def(
                TOOL_STOP,
                "Cancel a running sub-agent, or all of yours with all=true. Its partial work stays in its saved transcript.",
                json!({
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "Sub-agent id."},
                        "all": {"type": "boolean", "description": "Stop every running sub-agent you started."}
                    }
                }),
            ),
        ]
    }

    /// System-prompt section added for an agent that may delegate.
    pub fn delegation_prompt(&self) -> String {
        let s = self.settings();
        format!(
            "\n\n## Delegating to sub-agents\n\
You can hand work to sub-agents with spawn_subagent. Each starts with an empty context, so delegating keeps your own context small and lets independent work run in parallel.\n\
- Delegate self-contained, multi-step work: searching or reading many files, a focused change in one area, an independent review, or several independent pieces that can run at once.\n\
- Do it yourself when it takes only a few tool calls, needs this conversation's context, or needs the user's input.\n\
- Write `task` as a complete brief: the goal, relevant files and facts, constraints, and what the report must contain. A sub-agent cannot see this chat or ask the user.\n\
- Give it only the tools it needs. For parallel work, spawn with wait=false, then call list_subagents with wait=true.\n\
- Check important claims in a report before relying on them, and tell the user the results in your own words.\n\
- Sub-agents persist across turns and app restarts unless you set `lifetime`: temp (deleted once you have its report) or standby (deleted after it has been idle for `ttl_secs`). Reuse one (message_subagent with its id or name, or spawn_subagent with reuse) when the new work continues its earlier task or needs what it already read or remembers: a follow-up, a fix to its own change, more of the same research. Spawn a new one for unrelated work, when a fresh unbiased view matters (a review of its own work), or when its history was long or went wrong. Use list_subagents (name, query, recent) to find past ones.\n\
- Limits: {} running at once; by default {}, {} steps and {} seconds each.",
            s.max_parallel,
            if s.default_token_budget == 0 {
                "no token cap (each keeps its context within its model's window by auto-compaction, like you)".to_string()
            } else {
                format!("{} tokens", s.default_token_budget)
            },
            s.default_max_steps,
            s.timeout_seconds
        ) + &self.templates_prompt()
    }

    fn subagent_system_prompt(rec: &SubagentRecord, parent_prompt: &str) -> String {
        let role = rec
            .role
            .as_deref()
            .map(|r| format!(" ({})", r.trim()))
            .unwrap_or_default();
        let mut p = format!(
            "You are \"{}\"{}, a sub-agent. Another agent delegated one task to you.\n\
- Work only on that task, using your tools. You cannot see the other agent's conversation and you cannot ask the user questions. If something is missing, make a reasonable assumption and say so in your report.\n\
- Be efficient: you have at most {} steps{}.\n\
- Finish with a final report in plain text: what you found or did, the key details (file paths, values, commands), and anything left open. The report is all the other agent will see.",
            rec.name,
            role,
            rec.max_steps,
            if rec.token_budget == 0 {
                ". When your context nears your model's window, older parts are compacted automatically".to_string()
            } else {
                format!(" and {} tokens", rec.token_budget)
            }
        );
        if rec.render_in_chat {
            p.push_str("\n- Your final report is also shown to the user in the chat, word for word, as a message from you: write it complete and readable on its own.");
        }
        if rec.lifetime.as_deref() == Some("temp") {
            p.push_str("\n- You are temporary: you are deleted once your report is delivered, so put everything that matters in it.");
        }
        if let Some(extra) = rec
            .system_prompt
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            p.push_str("\n\n## Instructions from the delegating agent\n");
            p.push_str(extra.trim());
        }
        let base = base_prompt(parent_prompt);
        if !base.trim().is_empty() {
            p.push_str(BASE_PROMPT_MARKER);
            p.push_str(base);
        }
        p
    }

    // ── Spawning and running ─────────────────────────────────────────────

    /// Start a sub-agent for a parent at `parent_depth`. Must be called inside
    /// a tokio runtime.
    pub fn spawn(
        self: &Arc<Self>,
        parent_depth: u32,
        spec: SpawnSpec,
        env: &ParentEnv,
    ) -> Result<SubagentRecord, String> {
        let deps = self.resolve_deps(spec.after.as_deref().unwrap_or(&[]), env)?;
        let fork = self.fork_context(&spec, env)?;
        let rec = self.spawn_record_only(parent_depth, spec, env)?;
        let rec = self
            .apply_advanced(&rec.id, &deps, fork.as_ref())
            .unwrap_or(rec);
        let prompt = match &fork {
            Some((_, ctx)) => format!("{}{}", rec.task, ctx),
            None => rec.task.clone(),
        };
        if !deps.is_empty() {
            // Waits in the queue until every agent it depends on has ended.
            let out = self
                .enqueue(&rec.id, prompt, PendingPrior::Fresh, env)
                .inspect_err(|_e| {
                    self.records.lock().unwrap().retain(|r| r.id != rec.id);
                    self.persist();
                });
            self.pump();
            return out.map(|r| self.get(&r.id).unwrap_or(r));
        }
        self.launch(&rec.id, prompt, PendingPrior::Fresh, env)
            .inspect_err(|_e| {
                self.records.lock().unwrap().retain(|r| r.id != rec.id);
                self.persist();
            })
    }

    /// Validate a spawn and save its record (status "running" placeholder);
    /// the caller starts it with `launch`.
    fn spawn_record_only(
        self: &Arc<Self>,
        parent_depth: u32,
        mut spec: SpawnSpec,
        env: &ParentEnv,
    ) -> Result<SubagentRecord, String> {
        let settings = self.settings();
        if !settings.enabled {
            return Err("Sub-agents are turned off in settings.".into());
        }
        self.apply_template(&mut spec)?;
        if parent_depth >= 1 {
            if let Some(parent) = self.record_by_session(&env.session_key) {
                self.may_spawn_by_rule(&parent)?;
            }
        }
        if parent_depth >= 1
            && !self.offers_tools_at(parent_depth)
            && parent_depth < settings.max_depth
        {
            return Err("In the star topology only the main agent starts sub-agents. Do the work yourself or ask your parent.".into());
        }
        if parent_depth >= settings.max_depth {
            return Err(format!(
                "A sub-agent can't start another sub-agent here (delegation depth limit is {}). Do the work yourself.",
                settings.max_depth
            ));
        }
        if let Some((name, limit)) = self.ancestor_depth_limit(env, parent_depth + 1) {
            return Err(format!(
                "{} may start agents only {} level{} below itself. Do the work yourself.",
                name,
                limit,
                if limit == 1 { "" } else { "s" }
            ));
        }
        let task = spec.task.trim();
        if task.is_empty() {
            return Err("`task` is required: give the sub-agent a complete brief.".into());
        }
        let at_limit = !self.borrows_parent_slot(&env.session_key)
            && (self.running_count() >= settings.max_parallel as usize || self.queued_count() > 0);
        if at_limit && self.queued_count() >= settings.max_queue as usize {
            return Err(format!(
                "{} sub-agents are already running (limit {}) and the queue is full ({}). Wait for one with list_subagents(wait=true), or stop one.",
                self.running_count(), settings.max_parallel, self.queued_count()
            ));
        }
        // Tool narrowing: parent ∩ requested, never ui__ or sub-agent tools.
        let parent: Vec<String> = env
            .tool_names
            .iter()
            .filter(|n| !n.starts_with("ui__") && !is_subagent_tool(n))
            .cloned()
            .collect();
        let tools: Vec<String> = match &spec.tools {
            Some(requested) if !requested.is_empty() => {
                let parent_set: HashSet<&String> = parent.iter().collect();
                let mut out = Vec::new();
                let mut seen = HashSet::new();
                for t in requested {
                    if parent_set.contains(t) && seen.insert(t.clone()) {
                        out.push(t.clone());
                    }
                }
                if out.is_empty() {
                    return Err(format!(
                        "None of the requested tools are available to you ({}). Available: {}.",
                        requested.join(", "),
                        parent.join(", ")
                    ));
                }
                out
            }
            _ => parent,
        };
        // Its topology: its own choice, else its parent's (inherited down the
        // tree unless a child overrides it), else the chat's (None).
        let topology_choice = match spec
            .topology
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            Some(t) => Some(channels::parse_topology(t)?),
            None => self
                .record_by_session(&env.session_key)
                .and_then(|p| p.topology),
        };
        let memory_mode = spec
            .memory
            .as_deref()
            .and_then(MemoryMode::parse)
            .or_else(|| MemoryMode::parse(&settings.default_memory))
            .unwrap_or(MemoryMode::Private);
        let id = format!("sa_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        let name = spec
            .name
            .as_deref()
            .map(sanitize_name)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("agent-{}", &id[3..7]));
        let now = creation_ms();
        let (lifetime, standby_ttl_secs, render_in_chat) = self.lifetime_fields(&spec)?;
        let rec = SubagentRecord {
            id: id.clone(),
            name,
            role: spec
                .role
                .map(|r| truncate_chars(r.trim(), 200))
                .filter(|r| !r.is_empty()),
            task: with_parent_context(task, env.task_context.as_deref()),
            status: "running".into(),
            parent_session_key: env.session_key.clone(),
            session_key: format!("subagent:{}", id),
            depth: parent_depth + 1,
            provider: spec
                .provider
                .filter(|s| !s.trim().is_empty())
                .or_else(|| env.provider.clone()),
            model: spec
                .model
                .filter(|s| !s.trim().is_empty())
                .or_else(|| env.model.clone()),
            system_prompt: spec.system_prompt.map(|s| truncate_chars(&s, 8_000)),
            tools,
            memory_mode: memory_mode.as_str().into(),
            token_budget: clamp_token_budget(
                spec.token_budget.unwrap_or(settings.default_token_budget),
            ),
            max_steps: spec
                .max_steps
                .unwrap_or(settings.default_max_steps)
                .clamp(1, 200),
            timeout_seconds: spec
                .timeout_seconds
                .unwrap_or(settings.timeout_seconds)
                .clamp(1, 3_600),
            input_tokens: 0,
            output_tokens: 0,
            steps: 0,
            tool_calls: 0,
            last_tool: None,
            result: None,
            error: None,
            created_at: now,
            started_at: now,
            finished_at: None,
            runs: 1,
            priority: spec.priority.unwrap_or(0).clamp(-10, 10),
            queued_at: None,
            queue_position: None,
            forked_from: None,
            files: Vec::new(),
            chat_deleted: false,
            parent_id: self.record_by_session(&env.session_key).map(|p| p.id),
            root_session_key: self.root_of(&env.session_key),
            title: spec
                .title
                .map(|t| truncate_chars(t.trim(), 120))
                .filter(|t| !t.is_empty()),
            description: spec
                .description
                .map(|t| truncate_chars(t.trim(), 1_000))
                .filter(|t| !t.is_empty()),
            template: spec.template.clone(),
            hidden: spec.hidden.unwrap_or(false),
            hidden_from: spec.hidden_from.unwrap_or_default(),
            shareable: spec.shareable.unwrap_or(false),
            can_message: spec.can_message,
            inbox: Vec::new(),
            compaction: None,
            context_status: None,
            compactions: 0,
            last_compaction: None,
            temperature: None,
            max_child_depth: None,
            paused: false,
            peer_rate_limit: None,
            context_mode: None,
            context_source: None,
            depends_on: Vec::new(),
            group_id: spec.group.as_ref().map(|g| g.0.clone()),
            group_mode: spec.group.as_ref().map(|g| g.1.clone()),
            group_index: spec.group.as_ref().map(|g| g.2),
            group_winner: false,
            handoff: spec.handoff.unwrap_or(false),
            spawn_tool_call_id: spec
                .spawn_tool_call_id
                .filter(|s| !s.trim().is_empty())
                .map(|s| truncate_chars(s.trim(), 200)),
            topology: topology_choice,
            comms_role: spec
                .comms_role
                .as_deref()
                .and_then(channels::normalize_role),
            can_broadcast: spec.can_broadcast,
            handed_to: None,
            handed_from: None,
            lifetime,
            standby_ttl_secs,
            render_in_chat,
            report_delivered: false,
            kept_note: None,
        };
        self.records.lock().unwrap().push(rec.clone());
        self.persist();
        Ok(rec)
    }

    fn start_run(
        self: &Arc<Self>,
        rec: &SubagentRecord,
        prompt: String,
        prior: Vec<Message>,
        env: &ParentEnv,
        done: Option<(Arc<watch::Sender<bool>>, watch::Receiver<bool>)>,
        steers: Vec<String>,
    ) {
        let child = SubagentCtx {
            manager: self.clone(),
            depth: rec.depth,
        };
        let mut allowed = rec.tools.clone();
        if child.offers_tools() {
            allowed.extend(TOOL_NAMES.iter().map(|s| s.to_string()));
        }
        allowed.extend(self.team_tool_names(rec));
        let tools_json = serde_json::to_string(&allowed).unwrap_or_else(|_| "[]".into());
        let params = SendMessageParams {
            prompt,
            session_key: rec.session_key.clone(),
            model: rec.model.clone(),
            provider: rec.provider.clone(),
            system_prompt: {
                // Team rules belong to the sub-agent's own part, above the base prompt.
                let own = Self::subagent_system_prompt(rec, &env.system_prompt);
                let team = self.team_prompt(rec);
                match own.find(BASE_PROMPT_MARKER) {
                    Some(i) => format!("{}{}{}", &own[..i], team, &own[i..]),
                    None => format!("{}{}", own, team),
                }
            },
            max_turns: Some(rec.max_steps),
            allowed_tools_json: Some(tools_json.clone()),
            prior_messages_json: None,
            attachments_json: self.next_attachments.lock().unwrap().remove(&rec.id),
        };
        let abort = Arc::new(Mutex::new(false));
        let (steer_tx, steer_rx) = mpsc::unbounded_channel();
        let (done_tx, done_rx) = match done {
            Some(d) => d,
            None => {
                let (tx, rx) = watch::channel(false);
                (Arc::new(tx), rx)
            }
        };
        for m in steers {
            let _ = steer_tx.send(m);
        }
        let stop_reason: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let watchdog_done = done_rx.clone();
        self.live.lock().unwrap().insert(
            rec.id.clone(),
            Live {
                abort: abort.clone(),
                steer_tx,
                stop_reason: stop_reason.clone(),
                _done: done_tx.clone(),
                done_rx,
            },
        );
        let text_buf = Arc::new(StdMutex::new(String::new()));
        let events = Arc::new(SubagentEvents {
            manager: self.clone(),
            id: rec.id.clone(),
            name: rec.name.clone(),
            parent_session_key: rec.parent_session_key.clone(),
            session_key: rec.session_key.clone(),
            app: env.callback.clone(),
            abort: abort.clone(),
            stop_reason: stop_reason.clone(),
            text_buf: text_buf.clone(),
        });
        let mode = MemoryMode::parse(&rec.memory_mode).unwrap_or(MemoryMode::Private);
        let memory: Option<Arc<dyn MemoryProvider>> = match (mode, env.memory.clone()) {
            (MemoryMode::Shared, parent) => parent,
            (MemoryMode::ReadParent, parent) => Some(Arc::new(SubagentMemory {
                manager: self.clone(),
                name: rec.name.clone(),
                parent,
            })),
            (MemoryMode::Private, _) => Some(Arc::new(SubagentMemory {
                manager: self.clone(),
                name: rec.name.clone(),
                parent: None,
            })),
        };
        self.emit(&env.callback, "subagent.started", rec, json!({ "task": truncate_chars(&rec.task, 500), "tools": rec.tools, "memoryMode": rec.memory_mode, "run": rec.runs }));

        let timeout_ms = rec.timeout_seconds * 1000;
        // Kept to drain at run end: a steer that reached no safe point of this
        // run becomes its next message (a FollowUp), never lost.
        let leftover_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>> =
            Arc::new(Mutex::new(Some(steer_rx)));
        let leftover_env = env.clone();
        let req = RunRequest {
            id: rec.id.clone(),
            params,
            prior_messages: prior.clone(),
            callback: events,
            abort: abort.clone(),
            steer_rx: leftover_rx.clone(),
            memory,
            timeout_ms,
            child,
        };
        let mgr = self.clone();
        let id = rec.id.clone();
        let session_key = rec.session_key.clone();
        let task_prompt = req.params.prompt.clone();
        let max_steps = rec.max_steps;
        let app = env.callback.clone();
        let run_started = now_ms();
        let started = Instant::now();
        let fut = self.runner.run(req);
        // Watchdog: at the time limit, stop the run the normal way (cancel
        // switch), so its partial work is saved and the status says timeout.
        {
            let abort = abort.clone();
            let stop_reason = stop_reason.clone();
            let mut done = watchdog_done;
            tokio::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                        {
                            let mut r = stop_reason.lock().unwrap();
                            if r.is_none() {
                                *r = Some("timeout".into());
                            }
                        }
                        set_abort(&abort);
                    }
                    _ = done.changed() => {}
                }
            });
        }
        tokio::spawn(async move {
            // Hard stop a little after the loop's own wall-clock limit.
            let outcome =
                tokio::time::timeout(Duration::from_millis(timeout_ms + 15_000), fut).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            let reason = stop_reason.lock().unwrap().clone();
            let partial = text_buf.lock().unwrap().trim().to_string();
            let (status, result, error) = match outcome {
                Ok(Ok(done)) => {
                    mgr.runner
                        .save(&session_key, &done, run_started, max_steps, &tools_json);
                    let text = last_assistant_text(&done.messages).unwrap_or_default();
                    let status = match reason.as_deref() {
                        // Stopped ahead of a step that would have overrun the
                        // budget, but the run had already given its answer.
                        Some(BUDGET_RESERVE_REASON) => "finished".into(),
                        Some(r) => r.to_string(),
                        None if elapsed_ms >= timeout_ms => "timeout".into(),
                        None => "finished".into(),
                    };
                    let text = if text.trim().is_empty() {
                        partial.clone()
                    } else {
                        text
                    };
                    (status, text, None)
                }
                Ok(Err(err)) => {
                    let cancelled = matches!(err, NativeAgentError::Cancelled);
                    let mut messages = prior;
                    // As the loop does before a prompt: an earlier run that
                    // stopped before its answer is closed first, so this
                    // message keeps a turn of its own in the saved chat.
                    crate::agent_loop::prepare_for_prompt(&mut messages);
                    messages.push(Message::user(&task_prompt));
                    if !partial.is_empty() {
                        messages.push(Message {
                            role: Role::Assistant,
                            content: MessageContent::Text(partial.clone()),
                        });
                    }
                    mgr.runner.save(
                        &session_key,
                        &RunDone {
                            messages,
                            model: String::new(),
                            provider: String::new(),
                            usage: None,
                        },
                        run_started,
                        max_steps,
                        &tools_json,
                    );
                    match (reason, cancelled) {
                        (Some(r), _) if r == BUDGET_RESERVE_REASON => {
                            ("budget_exceeded".to_string(), partial, None)
                        }
                        (Some(r), _) => (r, partial, None),
                        (None, true) => ("cancelled".to_string(), partial, None),
                        (None, false) => ("error".to_string(), partial, Some(err.to_string())),
                    }
                }
                Err(_) => ("timeout".to_string(), partial, None),
            };
            // Leftover steers (sent after the run's last safe point): queued as
            // the run's next message, ahead of later ones, unless it was
            // cancelled outright.
            let mut leftovers: Vec<String> = Vec::new();
            if let Some(rx) = leftover_rx.lock().await.as_mut() {
                while let Ok(raw) = rx.try_recv() {
                    let env = crate::steer::SteerEnvelope::decode(&raw);
                    if !env.text.trim().is_empty() {
                        leftovers.push(env.text);
                    }
                }
            }
            if !leftovers.is_empty() && status != "cancelled" {
                mgr.followups
                    .lock()
                    .unwrap()
                    .entry(id.clone())
                    .or_default()
                    .push_front(FollowUp {
                        text: leftovers.join("\n\n"),
                        attachments_json: String::new(),
                        env: leftover_env,
                    });
            }
            mgr.finish(&id, &status, result, error, &app);
        });
    }

    /// Step 5 of the steer plan: hand a steer to one of `parent_session_key`'s
    /// sub-agents by id, name or title (the `subagents.message` path). A
    /// running one gets it as a steer; for one that is not running this fails
    /// and the steer stays with the main agent.
    pub fn route_steer(
        self: &Arc<Self>,
        parent_session_key: &str,
        target: &str,
        text: &str,
    ) -> Result<String, String> {
        let t = target.trim();
        let rec = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.parent_session_key == parent_session_key || parent_session_key.is_empty())
            .find(|r| {
                r.id == t
                    || r.name.eq_ignore_ascii_case(t)
                    || r.title.as_deref().is_some_and(|x| x.eq_ignore_ascii_case(t))
            })
            .cloned()
            .ok_or_else(|| format!("No sub-agent '{t}' in this chat."))?;
        let msg = format!("[Message from the user, routed by steer]\n{text}");
        if let Some(live) = self.live.lock().unwrap().get(&rec.id) {
            live.steer_tx
                .send(msg)
                .map_err(|e| e.to_string())?;
            return Ok(rec.id);
        }
        // Not running: the main agent keeps the steer (it can message the
        // sub-agent itself with the full parent context).
        Err(format!("Sub-agent '{t}' is not running."))
    }

    fn finish(
        self: &Arc<Self>,
        id: &str,
        status: &str,
        result: String,
        error: Option<String>,
        app: &Option<Arc<dyn NativeEventCallback>>,
    ) {
        // Interrupt (the chat's Esc / "Interrupt"): the current step stops and is
        // kept; the record reads as stopped, but messages that waited for this run
        // are not dropped: the next one starts at once, as a steer after Esc does.
        let interrupted = status == "interrupted";
        let status = if interrupted { "cancelled" } else { status };
        let note = match status {
            "cancelled" if interrupted => Some("Interrupted. Send a message to go on."),
            "budget_exceeded" => Some("Stopped: it used up its token budget."),
            "timeout" => Some("Stopped: it hit its time limit."),
            "max_steps" => Some("Stopped: it reached its step limit."),
            "cancelled" => Some("Stopped before it finished."),
            "paused" => Some("Paused by the user."),
            _ => None,
        };
        let rec = self.update(id, |r| {
            r.status = status.to_string();
            r.result = Some(result);
            r.error = error.or_else(|| note.map(|n| n.to_string()));
            r.finished_at = Some(now_ms());
            // A new report: a temp agent stays until this one reaches its parent.
            r.report_delivered = false;
        });
        self.remember_app(app);
        // render_in_chat: the answer is shown to the user as its own message and
        // the parent keeps it as a note (`in`), not as the whole text twice.
        let rec = match rec {
            Some(r) if r.render_in_chat && status == "finished" => {
                let kept = self.keep_report_in_tree(&r, true);
                self.update(id, |x| x.kept_note = kept.clone()).or(Some(r))
            }
            other => other,
        };
        // Plan §10: temp / standby GC runs before the `max_kept` prune in
        // persist(), so an expired agent goes first, not a parent's bookkeeping.
        self.sweep_lifetimes();
        self.persist();
        let live = self.live.lock().unwrap().remove(id);
        if let Some(rec) = rec {
            let event = match status {
                "finished" => "subagent.finished",
                "error" => "subagent.error",
                _ => "subagent.cancelled",
            };
            let mut extra =
                json!({ "report": truncate_chars(rec.result.as_deref().unwrap_or(""), 2_000) });
            if rec.render_in_chat && status == "finished" {
                // The chat shows the whole answer in its own bubble ("from <name>").
                extra["renderInChat"] = json!(true);
                extra["answer"] = json!(truncate_chars(
                    rec.result.as_deref().unwrap_or(""),
                    REPORT_CAP
                ));
            }
            if let Some(l) = &rec.lifetime {
                extra["lifetime"] = json!(l);
            }
            self.emit(app, event, &rec, extra);
        }
        // A delete asked for while it ran: its transcript is saved by now.
        self.run_deferred_delete(id, app);
        if let Some(live) = live {
            let _ = live._done.send(true);
        }
        self.pump();
        self.start_followup(id, if interrupted { "interrupted" } else { status });
    }

    /// The next message with attachments that waited for this run, if any.
    /// A run the user stopped drops them (as Stop pauses the app's queue).
    fn start_followup(self: &Arc<Self>, id: &str, status: &str) {
        let next = {
            let mut all = self.followups.lock().unwrap();
            if status == "cancelled" {
                all.remove(id);
                None
            } else {
                let next = all.get_mut(id).and_then(|q| q.pop_front());
                if all.get(id).is_some_and(|q| q.is_empty()) {
                    all.remove(id);
                }
                next
            }
        };
        let Some(f) = next else { return };
        if !f.attachments_json.is_empty() {
            self.next_attachments
                .lock()
                .unwrap()
                .insert(id.to_string(), f.attachments_json);
        }
        if self
            .rerun_existing(id, f.text, PendingPrior::Resume, &f.env, false)
            .is_err()
        {
            self.next_attachments.lock().unwrap().remove(id);
        }
    }

    /// The first agent above a new one (at `child_depth`) whose own depth
    /// limit it would pass, with that limit.
    fn ancestor_depth_limit(&self, env: &ParentEnv, child_depth: u32) -> Option<(String, u32)> {
        let mut cur = self.record_by_session(&env.session_key);
        let mut hops = 0;
        while let Some(r) = cur {
            if hops > 16 {
                break;
            }
            if let Some(limit) = r.max_child_depth {
                if child_depth > r.depth + limit {
                    return Some((r.title.clone().unwrap_or_else(|| r.name.clone()), limit));
                }
            }
            cur = r.parent_id.as_deref().and_then(|p| self.get(p));
            hops += 1;
        }
        None
    }

    /// The memory of the sub-agent behind `session_key`: (name, memory mode,
    /// parent session key). None for the main agent or an unknown key.
    pub fn memory_scope_of(&self, session_key: &str) -> Option<(String, MemoryMode, String)> {
        self.record_by_session(session_key).map(|r| {
            (
                r.name.clone(),
                MemoryMode::parse(&r.memory_mode).unwrap_or(MemoryMode::Private),
                r.parent_session_key.clone(),
            )
        })
    }

    pub fn temperature_for(&self, session_key: &str) -> Option<f64> {
        self.record_by_session(session_key)
            .and_then(|r| r.temperature)
            .filter(|t| t.is_finite() && (0.0..=2.0).contains(t))
    }

    /// When compaction starts for the agent of `session_key`: its own
    /// setting, else the chat-wide one. The main agent uses the chat-wide one.
    pub fn compaction_policy(&self, session_key: &str) -> CompactionPolicy {
        let s = self.settings();
        let base = CompactionPolicy {
            enabled: s.auto_compact,
            threshold_percent: s.compact_threshold_percent,
        }
        .clamped();
        self.record_by_session(session_key)
            .and_then(|r| r.compaction)
            .map(CompactionPolicy::clamped)
            .unwrap_or(base)
    }

    /// A compaction event from a sub-agent's loop: kept on its record (so the
    /// chat shows it after a reload) and sent to the app as subagent.compaction.
    fn note_compaction(
        &self,
        id: &str,
        event: &str,
        payload: &Value,
        app: &Option<Arc<dyn NativeEventCallback>>,
    ) {
        let Some((kind, phase, done)) = compaction_step(event, payload) else {
            return;
        };
        let mut info = json!({ "kind": kind, "phase": phase, "at": now_ms() });
        for k in [
            "tokensBefore",
            "tokensAfter",
            "estimatedContextTokens",
            "compactAtTokens",
            "contextBudgetTokens",
            "thresholdPercent",
            "trigger",
            "reason",
            "compactedMessages",
            "droppedMessages",
            "overBudget",
            // Turn memory (the keep-7 / batch-7 window) and overflow retries.
            "fromTurn",
            "toTurn",
            "throughTurn",
            "attempt",
            "recovering",
            "nextBudgetTokens",
            "estimatedTranscriptTokens",
            "providerContextLimitTokens",
            "error",
            "message",
        ] {
            if let Some(v) = payload.get(k) {
                info[k] = v.clone();
            }
        }
        let Some(rec) = self.update(id, |r| {
            if done {
                r.compactions += 1;
            }
            r.last_compaction = Some(info.clone());
        }) else {
            return;
        };
        if done {
            self.persist();
        }
        // `emit` keeps it in its log with its numbers (kind, tokens before and
        // after, trigger), so the Context tab lists every compaction step.
        self.emit(
            app,
            "subagent.compaction",
            &rec,
            json!({ "compaction": info }),
        );
    }

    fn emit(
        &self,
        cb: &Option<Arc<dyn NativeEventCallback>>,
        event: &str,
        rec: &SubagentRecord,
        extra: Value,
    ) {
        if event != "subagent.usage" {
            self.append_log(&rec.id, event, rec, &extra);
        }
        let Some(cb) = cb else { return };
        let mut payload = json!({
            "id": rec.id,
            "name": rec.name,
            "status": rec.status,
            "depth": rec.depth,
            "parentSessionKey": rec.parent_session_key,
            "rootSessionKey": rec.root_session_key,
            "parentId": rec.parent_id,
            "title": rec.title,
            "description": rec.description,
            "spawnToolCallId": rec.spawn_tool_call_id,
            "sessionKey": rec.session_key,
            "steps": rec.steps,
            "toolCalls": rec.tool_calls,
            "inputTokens": rec.input_tokens,
            "outputTokens": rec.output_tokens,
            "totalTokens": rec.total_tokens(),
            "tokenBudget": rec.token_budget,
            "maxSteps": rec.max_steps,
            "priority": rec.priority,
            "compactions": rec.compactions,
        });
        if let Some(c) = &rec.context_status {
            payload["contextStatus"] = c.clone();
        }
        if let Some(c) = &rec.last_compaction {
            payload["lastCompaction"] = c.clone();
        }
        if let Some(p) = rec.queue_position {
            payload["queuePosition"] = json!(p);
        }
        if let (Some(obj), Some(more)) = (payload.as_object_mut(), extra.as_object()) {
            for (k, v) in more {
                obj.insert(k.clone(), v.clone());
            }
        }
        cb.on_event(event.to_string(), payload.to_string());
    }

    /// Stop one sub-agent. Returns false when it isn't running.
    pub fn stop(self: &Arc<Self>, id: &str, reason: &str) -> bool {
        // Waiting in the queue: take it out and mark it at once.
        let queued = self.pending.lock().unwrap().remove(id);
        if let Some(p) = queued {
            let rec = self.update(id, |r| {
                r.status = "cancelled".into();
                r.queue_position = None;
                r.error = Some("Cancelled while it waited in the queue.".into());
                r.finished_at = Some(now_ms());
                r.result.get_or_insert_with(String::new);
            });
            self.persist();
            if let Some(rec) = rec {
                self.emit(
                    &p.env.callback,
                    "subagent.cancelled",
                    &rec,
                    json!({ "report": "", "whileQueued": true }),
                );
            }
            let _ = p.done_tx.send(true);
            self.refresh_positions();
            return true;
        }
        let live = self.live.lock().unwrap();
        let Some(l) = live.get(id) else { return false };
        {
            let mut r = l.stop_reason.lock().unwrap();
            if r.is_none() {
                *r = Some(reason.to_string());
            }
        }
        set_abort(&l.abort);
        true
    }

    pub fn stop_where<F: Fn(&SubagentRecord) -> bool>(self: &Arc<Self>, pred: F) -> Vec<String> {
        let ids: Vec<String> = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.is_active() && pred(r))
            .map(|r| r.id.clone())
            .collect();
        // Queued ones first, so stopping a running one can't start them.
        let (queued, running): (Vec<String>, Vec<String>) = ids
            .into_iter()
            .partition(|id| self.pending.lock().unwrap().contains_key(id));
        queued
            .into_iter()
            .chain(running)
            .filter(|id| self.stop(id, "cancelled"))
            .collect()
    }

    /// Follow-up: steer a running sub-agent, or resume a finished one.
    pub fn message(
        self: &Arc<Self>,
        id: &str,
        text: &str,
        env: &ParentEnv,
    ) -> Result<(SubagentRecord, bool), String> {
        self.message_with(id, text, None, env)
    }

    /// `message` with attachments (images or text files), in the shape the
    /// main agent's follow-up takes. Text may be empty when an attachment is
    /// given. While it runs, a message with attachments waits and starts as
    /// its next run when this one ends (a steer carries text only).
    pub fn message_with(
        self: &Arc<Self>,
        id: &str,
        text: &str,
        attachments_json: Option<&str>,
        env: &ParentEnv,
    ) -> Result<(SubagentRecord, bool), String> {
        let blocks =
            crate::types::parse_attachments(attachments_json).map_err(|e| e.to_string())?;
        let attachments = if blocks.is_empty() {
            None
        } else {
            attachments_json.map(str::to_string)
        };
        let images = blocks
            .iter()
            .filter(|b| matches!(b, crate::types::ContentBlock::Image { .. }))
            .count();
        let text = text.trim();
        if text.is_empty() && attachments.is_none() {
            return Err("`message` is empty.".into());
        }
        let rec = self
            .get(id)
            .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        // Kept for the delegation graph's timeline.
        self.append_log(
            id,
            "subagent.message",
            &rec,
            &json!({ "text": text, "attachments": blocks.len(), "images": images }),
        );
        if let Some(att) = attachments {
            if rec.is_active() {
                self.followups
                    .lock()
                    .unwrap()
                    .entry(id.to_string())
                    .or_default()
                    .push_back(FollowUp {
                        text: text.to_string(),
                        attachments_json: att,
                        env: env.clone(),
                    });
                return Ok((rec, false));
            }
            self.next_attachments
                .lock()
                .unwrap()
                .insert(id.to_string(), att);
            return self
                .rerun_existing(id, text.to_string(), PendingPrior::Resume, env, false)
                .map(|r| (r, true))
                .inspect_err(|_e| {
                    self.next_attachments.lock().unwrap().remove(id);
                });
        }
        if rec.is_running() {
            let live = self.live.lock().unwrap();
            if let Some(l) = live.get(id) {
                let _ = l.steer_tx.send(text.to_string());
                return Ok((rec, false));
            }
        }
        if rec.status == "queued" {
            if let Some(p) = self.pending.lock().unwrap().get_mut(id) {
                p.steers.push(text.to_string());
                return Ok((rec, false));
            }
        }
        self.rerun_existing(id, text.to_string(), PendingPrior::Resume, env, false)
            .map(|r| (r, true))
    }

    /// Reset a finished record and start (or queue) a new run on it.
    fn rerun_existing(
        self: &Arc<Self>,
        id: &str,
        prompt: String,
        prior: PendingPrior,
        env: &ParentEnv,
        reset_counters: bool,
    ) -> Result<SubagentRecord, String> {
        let rec = self
            .get(id)
            .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running or queued. Stop it first.".into());
        }
        // Acting on an agent the user paused is the user resuming it.
        if rec.paused {
            self.update(id, |r| r.paused = false);
        }
        let inbox = self.take_inbox(id);
        let prompt = if inbox.is_empty() {
            prompt
        } else {
            format!("{}\n\n{}", inbox.join("\n\n"), prompt)
        };
        // A reused sub-agent follows today's rules: the depth limit and the
        // tools its parent may use right now.
        let settings = self.settings();
        if !settings.enabled || rec.depth > settings.max_depth {
            return Err("Sub-agents at this depth are turned off in settings.".into());
        }
        let tools = Self::narrow_to_parent(&rec.tools, env);
        if tools.is_empty() {
            return Err(format!(
                "None of its tools ({}) are allowed for you now, so it can't continue. Spawn a new sub-agent instead.",
                rec.tools.join(", ")
            ));
        }
        self.update(id, |r| {
            r.tools = tools.clone();
            r.chat_deleted = false;
            r.result = None;
            r.error = None;
            r.finished_at = None;
            r.runs += 1;
            if reset_counters {
                r.input_tokens = 0;
                r.output_tokens = 0;
                r.steps = 0;
                r.tool_calls = 0;
                r.last_tool = None;
            }
        });
        let before = rec.clone();
        self.launch(id, prompt, prior, env).inspect_err(|_e| {
            // Put the old state back so nothing looks half-started.
            self.update(id, |r| *r = before.clone());
            self.persist();
        })
    }

    /// Keep only tools the parent may use now (never ui__ / sub-agent tools).
    /// An env without a tool list (tests, older callers) keeps the list.
    fn narrow_to_parent(tools: &[String], env: &ParentEnv) -> Vec<String> {
        let base = tools
            .iter()
            .filter(|t| !t.starts_with("ui__") && !is_subagent_tool(t));
        if env.tool_names.is_empty() {
            return base.cloned().collect();
        }
        base.filter(|t| env.tool_names.contains(t))
            .cloned()
            .collect()
    }

    /// spawn_subagent with `reuse`: continue a past sub-agent with its
    /// history and memory when one matches, else start a new one.
    pub fn spawn_or_reuse(
        self: &Arc<Self>,
        parent_depth: u32,
        spec: SpawnSpec,
        env: &ParentEnv,
    ) -> Result<(SubagentRecord, &'static str), String> {
        let key = match &spec.reuse {
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
            Some(Value::Bool(true)) => spec.name.clone(),
            _ => None,
        };
        let Some(key) = key else {
            return self.spawn(parent_depth, spec, env).map(|r| (r, "new"));
        };
        let Some(found) = self.find_reusable(&key, &env.session_key) else {
            return self
                .spawn(parent_depth, spec, env)
                .map(|r| (r, "not_found"));
        };
        let task = spec.task.trim();
        if task.is_empty() {
            return Err("`task` is required: say what the reused sub-agent should do next.".into());
        }
        // Optional new limits for this run (clamped like a new spawn).
        if spec.token_budget.is_some()
            || spec.max_steps.is_some()
            || spec.priority.is_some()
            || spec.tools.is_some()
        {
            let requested = spec.tools.clone();
            let ok = self.update(&found.id, |r| {
                if let Some(b) = spec.token_budget {
                    r.token_budget = clamp_token_budget(b);
                }
                if let Some(m) = spec.max_steps {
                    r.max_steps = m.clamp(1, 200);
                }
                if let Some(p) = spec.priority {
                    r.priority = p.clamp(-10, 10);
                }
                if let Some(req) = &requested {
                    if !req.is_empty() {
                        r.tools = req.clone();
                    }
                }
            });
            if ok.is_some() {
                self.persist();
            }
        }
        // A reused agent may change its lifetime (e.g. standby -> temp).
        self.update_lifetime_on_reuse(&found.id, &spec)?;
        let (rec, resumed) = self.message(&found.id, task, env)?;
        Ok((rec, if resumed { "resumed" } else { "steered" }))
    }

    /// Run the original task again from a clean context.
    pub fn retry(self: &Arc<Self>, id: &str, env: &ParentEnv) -> Result<SubagentRecord, String> {
        let rec = self
            .get(id)
            .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running. Stop it first.".into());
        }
        let task = rec.task.clone();
        let old = self.runner.load_messages(&rec.session_key);
        let r = self.rerun_existing(id, task, PendingPrior::Fresh, env, true)?;
        self.archive_branch(id, 0, old, "retry");
        self.runner.clear(&rec.session_key);
        Ok(r)
    }

    /// Find the n-th real user message (typed text, not tool results).
    /// Returns (index into messages, its text).
    /// A message with only an image counts too (as the main agent's
    /// rewind does), and attached files are not part of the text.
    fn user_turns(messages: &[Message]) -> Vec<(usize, String)> {
        messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.is_user_prompt())
            .map(|(i, m)| (i, Self::prompt_and_attachments(m).0))
            .collect()
    }

    /// A user message split back into what was typed and its attachments
    /// (as `attachmentsJson`, the shape `message_with` takes), so a retry or
    /// an edit of that message sends the same images and files again.
    fn prompt_and_attachments(m: &Message) -> (String, Option<String>) {
        use crate::types::ContentBlock;
        match &m.content {
            MessageContent::Text(t) => (t.clone(), None),
            MessageContent::Blocks(blocks) => {
                let mut text: Vec<String> = Vec::new();
                let mut att: Vec<Value> = Vec::new();
                for b in blocks {
                    match b {
                        ContentBlock::Text { text: t } => {
                            if let Some(rest) = t.strip_prefix("<attached_file name=\"") {
                                if let Some((name, body)) = rest.split_once("\">\n") {
                                    let body =
                                        body.strip_suffix("\n</attached_file>").unwrap_or(body);
                                    att.push(json!({ "type": "text", "name": name, "text": body }));
                                    continue;
                                }
                            }
                            text.push(t.clone());
                        }
                        ContentBlock::Image { media_type, data } => {
                            att.push(
                                json!({ "type": "image", "mediaType": media_type, "data": data }),
                            );
                        }
                        _ => {}
                    }
                }
                let att = if att.is_empty() {
                    None
                } else {
                    serde_json::to_string(&att).ok()
                };
                (text.join("\n"), att)
            }
        }
    }

    /// Answer the last user message again (drops the old reply).
    /// `turn` (0-based, real user turns) re-answers from an earlier point;
    /// `text` replaces that message (edit and resend).
    pub fn regenerate(
        self: &Arc<Self>,
        id: &str,
        turn: Option<usize>,
        text: Option<&str>,
        env: &ParentEnv,
    ) -> Result<SubagentRecord, String> {
        self.regenerate_with(id, turn, text, None, env)
    }

    /// `regenerate` where an edit can also replace the message's attachments
    /// (Some("[]") removes them; None keeps the ones it had).
    pub fn regenerate_with(
        self: &Arc<Self>,
        id: &str,
        turn: Option<usize>,
        text: Option<&str>,
        attachments_json: Option<&str>,
        env: &ParentEnv,
    ) -> Result<SubagentRecord, String> {
        let rec = self
            .get(id)
            .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running. Stop it first.".into());
        }
        let messages = self.runner.load_messages(&rec.session_key);
        let turns = Self::user_turns(&messages);
        if turns.is_empty() {
            // Nothing saved (e.g. it failed before saving): run the task again.
            let prompt = text.map(str::to_string).unwrap_or_else(|| rec.task.clone());
            if text.is_some() {
                self.update(id, |r| r.task = prompt.clone());
            }
            return self.rerun_existing(id, prompt, PendingPrior::Fresh, env, false);
        }
        let k = turn.unwrap_or(turns.len() - 1);
        let (idx, original) = turns.get(k).cloned().ok_or_else(|| {
            format!(
                "There is no user message number {} (it has {}).",
                k + 1,
                turns.len()
            )
        })?;
        let (_, kept_attachments) = Self::prompt_and_attachments(&messages[idx]);
        // An edit may replace the attachments; otherwise the message keeps them.
        let attachments = match attachments_json.map(str::trim) {
            Some(a) if !a.is_empty() => {
                if crate::types::parse_attachments(Some(a))
                    .map_err(|e| e.to_string())?
                    .is_empty()
                {
                    None
                } else {
                    Some(a.to_string())
                }
            }
            Some(_) => None,
            None => kept_attachments,
        };
        let prompt = match text.map(str::trim) {
            Some("") if attachments.is_none() => return Err("The edited message is empty.".into()),
            Some(t) => t.to_string(),
            None => original,
        };
        if k == 0 && text.is_some() && !prompt.is_empty() {
            self.update(id, |r| r.task = prompt.clone());
        }
        // The answer that is about to be replaced stays as a kept version.
        self.archive_branch(
            id,
            k,
            messages.clone(),
            if text.is_some() { "edit" } else { "regenerate" },
        );
        let prior = messages[..idx].to_vec();
        // Same as the main chat's rewind: the turns after the cut are gone, and
        // so is a turn the cut goes through (an edit of a mid-turn message).
        self.runner.forget_turns_after(
            &rec.session_key,
            crate::turn_memory::whole_turns_before(&messages, idx),
        );
        if let Some(a) = attachments {
            self.next_attachments
                .lock()
                .unwrap()
                .insert(id.to_string(), a);
        }
        self.rerun_existing(id, prompt, PendingPrior::Exact(prior), env, false)
            .inspect_err(|_e| {
                self.next_attachments.lock().unwrap().remove(id);
            })
    }

    /// New sub-agent from an old one: same settings, the same or an edited
    /// task, fresh context (`keep_history` copies the conversation instead).
    pub fn fork(
        self: &Arc<Self>,
        parent_depth: u32,
        id: &str,
        task: Option<&str>,
        keep_history: bool,
        env: &ParentEnv,
    ) -> Result<SubagentRecord, String> {
        let src = self
            .get(id)
            .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        let spec = SpawnSpec {
            name: Some(src.name.clone()),
            task: task
                .map(str::to_string)
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| src.task.clone()),
            role: src.role.clone(),
            system_prompt: src.system_prompt.clone(),
            tools: Some(src.tools.clone()),
            memory: Some(src.memory_mode.clone()),
            model: src.model.clone(),
            provider: src.provider.clone(),
            token_budget: Some(src.token_budget),
            max_steps: Some(src.max_steps),
            timeout_seconds: Some(src.timeout_seconds),
            priority: Some(src.priority),
            ..Default::default()
        };
        if !keep_history {
            let mut rec = self.spawn(parent_depth, spec, env)?;
            rec = self
                .update(&rec.id, |r| r.forked_from = Some(src.id.clone()))
                .unwrap_or(rec);
            self.persist();
            return Ok(rec);
        }
        // Copy the conversation, then continue it with the new message.
        let history = self.runner.load_messages(&src.session_key);
        let prompt = spec.task.clone();
        let spec2 = SpawnSpec {
            task: "(continued from an earlier sub-agent)".into(),
            ..spec
        };
        let rec = self.spawn_record_only(parent_depth, spec2, env)?;
        self.update(&rec.id, |r| {
            r.forked_from = Some(src.id.clone());
            r.task = prompt.clone();
        });
        self.persist();
        self.launch(&rec.id, prompt, PendingPrior::Exact(history), env)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let rec = self
            .get(id)
            .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running. Stop it first.".into());
        }
        self.runner.clear(&rec.session_key);
        self.remove_log(id);
        self.remove_branches(id);
        self.records.lock().unwrap().retain(|r| r.id != id);
        self.persist();
        Ok(())
    }

    /// Wait until none of `ids` is running. Stops them if the parent is
    /// cancelled (or the waiting future is dropped because of it).
    pub async fn wait_for(
        self: &Arc<Self>,
        ids: &[String],
        parent_abort: Option<Arc<Mutex<bool>>>,
        timeout: Duration,
    ) -> WaitEnd {
        let mut receivers: Vec<watch::Receiver<bool>> = {
            let live = self.live.lock().unwrap();
            let pending = self.pending.lock().unwrap();
            ids.iter()
                .filter_map(|id| {
                    live.get(id)
                        .map(|l| l.done_rx.clone())
                        .or_else(|| pending.get(id).map(|p| p.done_rx.clone()))
                })
                .collect()
        };
        let mut guard = StopOnDrop {
            manager: self,
            ids: ids.to_vec(),
            armed: true,
        };
        let deadline = Instant::now() + timeout;
        loop {
            // Done when it says so, or when its run is gone (sender dropped).
            receivers.retain(|rx| !*rx.borrow() && rx.has_changed().is_ok());
            if receivers.is_empty() {
                guard.armed = false;
                return WaitEnd::Done;
            }
            if is_aborted(&parent_abort) {
                return WaitEnd::ParentCancelled; // guard stops them
            }
            if Instant::now() >= deadline {
                guard.armed = false;
                return WaitEnd::TimedOut;
            }
            let rx = &mut receivers[0];
            let _ = tokio::time::timeout(Duration::from_millis(100), rx.changed()).await;
        }
    }

    // ── Tool dispatch (called by the parent's agent loop) ─────────────────

    pub async fn handle_tool(
        self: &Arc<Self>,
        parent_depth: u32,
        tool: &str,
        input: &Value,
        env: ParentEnv,
    ) -> (String, bool) {
        self.remember_app(&env.callback);
        self.sweep_lifetimes();
        match tool {
            TOOL_SPAWN if input.get("tasks").is_some_and(|t| t.is_array()) => {
                self.batch_tool(parent_depth, input, env).await
            }
            TOOL_SPAWN => {
                let spec: SpawnSpec = match serde_json::from_value(input.clone()) {
                    Ok(s) => s,
                    Err(e) => return (format!("Invalid arguments: {}", e), true),
                };
                let wait = spec.wait.unwrap_or(true);
                let (rec, how) = match self.spawn_or_reuse(parent_depth, spec, &env) {
                    Ok(r) => r,
                    Err(e) => return (e, true),
                };
                let lead = match how {
                    "resumed" => format!("Reusing sub-agent \"{}\" (id {}, run {}) with its earlier history and memory.\n", rec.name, rec.id, rec.runs),
                    "steered" => {
                        return (format!("Sub-agent \"{}\" (id {}) is still working; your task was added to it as a follow-up before its next step. Collect its report with list_subagents(wait=true).", rec.name, rec.id), false)
                    }
                    "not_found" => "No earlier sub-agent matched `reuse`, so a new one was started.\n".to_string(),
                    _ => String::new(),
                };
                if how == "resumed" {
                    if !wait {
                        return (format!("{}It runs in the background; collect its report with list_subagents(wait=true).", lead), false);
                    }
                    let (out, err) = self
                        .wait_and_report(std::slice::from_ref(&rec.id), &env, None)
                        .await;
                    return (format!("{}{}", lead, out), err);
                }
                if !wait {
                    let how = if rec.status == "queued" {
                        format!("Queued sub-agent \"{}\" (id {}, position {} in the queue; it starts when a slot frees)", rec.name, rec.id, rec.queue_position.unwrap_or(1))
                    } else {
                        format!(
                            "Started sub-agent \"{}\" (id {}) in the background",
                            rec.name, rec.id
                        )
                    };
                    return (
                        format!(
                            "{}{} with tools: {}. Call list_subagents with wait=true to collect its report, or use message_subagent / stop_subagent with this id.",
                            lead,
                            how,
                            rec.tools.join(", ")
                        ),
                        false,
                    );
                }
                let (out, err) = self
                    .wait_and_report(std::slice::from_ref(&rec.id), &env, None)
                    .await;
                if rec.handoff && !err {
                    return (format!("{}{}", advanced::HANDOFF_LEAD, out), false);
                }
                (format!("{}{}", lead, out), err)
            }
            TOOL_LIST => {
                let ids: Option<Vec<String>> = input
                    .get("ids")
                    .and_then(|v| serde_json::from_value(v.clone()).ok());
                let wait = input.get("wait").and_then(Value::as_bool).unwrap_or(false);
                let status = input
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("all")
                    .to_string();
                let timeout = input.get("timeout_seconds").and_then(Value::as_u64);
                let mine = |r: &SubagentRecord| r.parent_session_key == env.session_key;
                if wait {
                    let targets: Vec<String> = match &ids {
                        Some(ids) => ids.clone(),
                        None => self
                            .list()
                            .into_iter()
                            .filter(|r| mine(r) && r.is_active())
                            .map(|r| r.id)
                            .collect(),
                    };
                    if targets.is_empty() {
                        return ("No sub-agents of yours are running.".into(), false);
                    }
                    return self.wait_and_report(&targets, &env, timeout).await;
                }
                let _ = &status;
                let filtered = input.get("name").is_some()
                    || input.get("query").is_some()
                    || input.get("recent").is_some()
                    || input.get("scope").is_some();
                let cross = input.get("scope").and_then(Value::as_str) == Some("all");
                let items: Vec<Value> = self
                    .filter_records(input, &env.session_key)
                    .into_iter()
                    .map(|r| {
                        let mut v = r.summary(ids.is_some());
                        if cross {
                            v["chat"] = json!(r.parent_session_key);
                        }
                        v
                    })
                    .collect();
                if items.is_empty() {
                    let none = if filtered {
                        "No sub-agents match that filter."
                    } else {
                        "You have no sub-agents in this chat yet."
                    };
                    let hint = if cross && !self.settings().reuse_across_chats {
                        " Sub-agents from other chats are hidden: the user has not turned on reuse across chats."
                    } else {
                        ""
                    };
                    return (format!("{}{}", none, hint), false);
                }
                (
                    serde_json::to_string_pretty(&items).unwrap_or_default(),
                    false,
                )
            }
            TOOL_MESSAGE => {
                let key = input
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| input.get("name").and_then(Value::as_str))
                    .unwrap_or("");
                let text = input.get("message").and_then(Value::as_str).unwrap_or("");
                let wait = input.get("wait").and_then(Value::as_bool).unwrap_or(true);
                let id = match self.find_reusable(key, &env.session_key) {
                    Some(r) => r.id,
                    None => return (format!("No sub-agent of yours has id or name {}. Use list_subagents to find it.", key), true),
                };
                let id = id.as_str();
                match self.message(id, text, &env) {
                    Ok((rec, false)) => (format!("Message delivered to running sub-agent \"{}\"; it will see it before its next step.", rec.name), false),
                    Ok((rec, true)) if !wait => (format!("Sub-agent \"{}\" resumed in the background (id {}).", rec.name, rec.id), false),
                    Ok((rec, true)) => self.wait_and_report(&[rec.id], &env, None).await,
                    Err(e) => (e, true),
                }
            }
            TOOL_STOP => {
                let all = input.get("all").and_then(Value::as_bool).unwrap_or(false);
                let parent = env.session_key.clone();
                let stopped = if all {
                    self.stop_where(|r| r.parent_session_key == parent)
                } else {
                    let id = input.get("id").and_then(Value::as_str).unwrap_or("");
                    match self.get(id) {
                        Some(r) if r.parent_session_key == parent => {
                            if self.stop(id, "cancelled") {
                                vec![id.to_string()]
                            } else {
                                vec![]
                            }
                        }
                        _ => return (format!("No sub-agent of yours has id {}.", id), true),
                    }
                };
                if stopped.is_empty() {
                    ("Nothing was running.".into(), false)
                } else {
                    let ids = stopped.clone();
                    let _ = self.wait_for(&ids, None, Duration::from_secs(10)).await;
                    (format!("Stopped: {}.", stopped.join(", ")), false)
                }
            }
            _ => (format!("Unknown sub-agent tool {}", tool), true),
        }
    }

    async fn wait_and_report(
        self: &Arc<Self>,
        ids: &[String],
        env: &ParentEnv,
        timeout_s: Option<u64>,
    ) -> (String, bool) {
        let settings = self.settings();
        let one = settings.timeout_seconds.max(
            ids.iter()
                .filter_map(|id| self.get(id))
                .map(|r| r.timeout_seconds)
                .max()
                .unwrap_or(0),
        );
        // Queued runs wait for a slot first: allow one run-length per queue "round".
        let rounds = 1 + (self.queued_count() as u64).div_ceil(settings.max_parallel.max(1) as u64);
        let limit = one * rounds + 30;
        let timeout = Duration::from_secs(timeout_s.unwrap_or(limit).clamp(1, limit));
        let started = Instant::now();
        let end = self.wait_for(ids, env.abort.clone(), timeout).await;
        if end == WaitEnd::ParentCancelled {
            return (
                "Cancelled by the user; the sub-agent was stopped.".into(),
                true,
            );
        }
        // Swarm handoffs: whoever waits for an agent that handed its task on
        // waits for the agent that holds it now, and gets its report.
        let handed: Vec<(String, String)> = ids
            .iter()
            .filter_map(|id| self.handoff_target(id).map(|t| (id.clone(), t)))
            .collect();
        if !handed.is_empty() {
            let targets: Vec<String> = handed.iter().map(|h| h.1.clone()).collect();
            let left = timeout
                .saturating_sub(started.elapsed())
                .max(Duration::from_secs(1));
            if self.wait_for(&targets, env.abort.clone(), left).await == WaitEnd::ParentCancelled {
                return (
                    "Cancelled by the user; the sub-agent was stopped.".into(),
                    true,
                );
            }
        }
        let mut parts = Vec::new();
        let mut all_failed = true;
        for id in ids {
            let Some(r) = self.get(id) else {
                parts.push(format!("No sub-agent with id {}.", id));
                continue;
            };
            if r.status == "queued" {
                all_failed = false;
                parts.push(format!(
                    "Sub-agent \"{}\" ({}) is still waiting in the queue (position {}). Call list_subagents with wait=true again, or stop it.",
                    r.name, r.id, r.queue_position.unwrap_or(0)
                ));
                continue;
            }
            if r.is_running() {
                all_failed = false;
                parts.push(format!(
                    "Sub-agent \"{}\" ({}) is still running after the wait ({} steps, {} tokens so far). Call list_subagents with wait=true again, or stop it.",
                    r.name, r.id, r.steps, r.total_tokens()
                ));
                continue;
            }
            if r.status != "error" {
                all_failed = false;
            }
            let secs = r
                .finished_at
                .map(|f| (f - r.started_at).max(0) / 1000)
                .unwrap_or(0);
            let mut s = format!(
                "Sub-agent \"{}\" ({}) {} after {}s · {} steps · {} tokens.",
                r.name,
                r.id,
                r.status.replace('_', " "),
                secs,
                r.steps,
                r.total_tokens()
            );
            if let Some(e) = &r.error {
                s.push_str(&format!("\nNote: {}", e));
            }
            let report = r.result.as_deref().unwrap_or("").trim();
            match (&r.kept_note, r.render_in_chat && r.status == "finished") {
                // Shown to the user already: the parent gets the note, not the text twice.
                (Some(note), true) => s.push_str(&format!(
                    "\nReport: shown to the user in the chat as its own message ({} characters). It is kept in your context tree as {} (sent with every request); do not repeat it.",
                    report.chars().count(),
                    note
                )),
                _ => {
                    s.push_str("\nReport:\n");
                    s.push_str(if report.is_empty() { "(no report)" } else { report });
                }
            }
            if r.lifetime.as_deref() == Some("temp") {
                s.push_str("\n(A temp sub-agent: it is deleted automatically now that you have its report.)");
            }
            self.mark_report_delivered(&r.id);
            if let Some(t) = handed
                .iter()
                .find(|h| &h.0 == id)
                .and_then(|h| self.get(&h.1))
            {
                let tr = t.result.as_deref().unwrap_or("").trim();
                if t.is_active() {
                    s.push_str(&format!("\n\nIt handed its task to \"{}\" ({}), which is still working on it. Wait for {} with list_subagents.", t.name, t.id, t.id));
                    all_failed = false;
                } else {
                    s.push_str(&format!("\n\nIt handed its task to \"{}\" ({}), which {}. Its report (the answer):\n{}", t.name, t.id, t.status.replace('_', " "), if tr.is_empty() { "(no report)" } else { tr }));
                    if t.status != "error" {
                        all_failed = false;
                    }
                }
            }
            parts.push(truncate_chars(&s, REPORT_CAP));
        }
        // Temp agents whose report just arrived go now (after temp_keep_secs).
        self.sweep_lifetimes();
        (parts.join("\n\n---\n\n"), all_failed)
    }

    // ── Memory store (per sub-agent name) ────────────────────────────────

    fn memory_path(&self, name: &str) -> PathBuf {
        let safe = sanitize_name(name);
        self.state_dir.join("memory").join(format!(
            "{}.json",
            if safe.is_empty() { "agent" } else { &safe }
        ))
    }

    pub fn memory_entries(&self, name: &str) -> Vec<MemoryEntry> {
        let _g = self.memory_lock.lock().unwrap();
        fs_read_json(&self.memory_path(name)).unwrap_or_default()
    }

    fn memory_write(&self, name: &str, f: impl FnOnce(&mut Vec<MemoryEntry>)) {
        let _g = self.memory_lock.lock().unwrap();
        let path = self.memory_path(name);
        let mut entries: Vec<MemoryEntry> = fs_read_json(&path).unwrap_or_default();
        f(&mut entries);
        fs_write_json(&path, &entries);
    }

    pub fn memory_store(&self, name: &str, key: &str, text: &str, metadata: Option<Value>) {
        let key = key.to_string();
        let text = truncate_chars(text, 20_000);
        self.memory_write(name, move |entries| {
            entries.retain(|e| e.key != key);
            entries.push(MemoryEntry {
                key,
                text,
                metadata,
                updated_at: now_ms(),
            });
            if entries.len() > 1_000 {
                let extra = entries.len() - 1_000;
                entries.drain(0..extra);
            }
        });
    }

    pub fn memory_forget(&self, name: &str, key: &str) -> bool {
        let mut removed = false;
        self.memory_write(name, |entries| {
            let before = entries.len();
            entries.retain(|e| e.key != key);
            removed = entries.len() != before;
        });
        removed
    }

    pub fn memory_clear(&self, name: &str) -> usize {
        let mut n = 0;
        self.memory_write(name, |entries| {
            n = entries.len();
            entries.clear();
        });
        n
    }

    pub fn memory_search(&self, name: &str, query: &str, limit: usize) -> Vec<(MemoryEntry, f64)> {
        let q = query.to_lowercase();
        let words: Vec<&str> = q
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 1)
            .collect();
        let mut scored: Vec<(MemoryEntry, f64)> = self
            .memory_entries(name)
            .into_iter()
            .filter_map(|e| {
                if words.is_empty() {
                    return Some((e, 0.5));
                }
                let hay = format!("{} {}", e.key, e.text).to_lowercase();
                let hits = words.iter().filter(|w| hay.contains(*w)).count();
                if hits == 0 {
                    return None;
                }
                let mut score = hits as f64 / words.len() as f64;
                if hay.contains(q.trim()) {
                    score = (score + 0.25).min(1.0);
                }
                Some((e, score))
            })
            .collect();
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.0.updated_at.cmp(&a.0.updated_at))
        });
        scored.truncate(limit.max(1));
        scored
    }

    /// Every memory store that exists, by sub-agent name.
    pub fn memory_names(&self) -> Vec<String> {
        let dir = self.state_dir.join("memory");
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| {
                        e.path()
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    // ── App requests (NativeKit `subagents`) ─────────────────────────────

    /// Handle one app request. `env` is used for spawn / message / retry.
    pub fn handle_app_request(
        self: &Arc<Self>,
        req: &Value,
        env: &ParentEnv,
        main_memory: Option<Arc<dyn MemoryProvider>>,
    ) -> Result<Value, String> {
        let action = req.get("action").and_then(Value::as_str).unwrap_or("list");
        if let Some(out) = self.team_app_request(action, req) {
            return out;
        }
        if let Some(out) = self.channels_app_request(action, req, env) {
            return out;
        }
        if let Some(out) = self.comms_app_request(action, req, env) {
            return out;
        }
        if let Some(out) = self.advanced_app_request(action, req, env) {
            return out;
        }
        let id = req.get("id").and_then(Value::as_str).unwrap_or("");
        match action {
            // ── Cross-session (feature "crossSession") ──
            "chats" => {
                let exclude = req.get("excludeSessionKey").and_then(Value::as_str);
                Ok(json!({ "chats": self.list_chats(exclude) }))
            }
            "titles" => Ok(
                json!({ "count": self.set_session_titles(req.get("titles").unwrap_or(&Value::Null)) }),
            ),
            "asks" => {
                let key = req.get("sessionKey").and_then(Value::as_str);
                let items: Vec<AskRecord> = self
                    .ask_history()
                    .into_iter()
                    .filter(|a| {
                        key.is_none_or(|k| a.caller_session_key == k || a.target_session_key == k)
                    })
                    .collect();
                Ok(json!({ "asks": items }))
            }
            "cancelAsk" => {
                let target = req
                    .get("targetSessionKey")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let flag = self.user_ask_aborts.lock().unwrap().get(target).cloned();
                if let Some(f) = &flag {
                    set_abort(f);
                }
                Ok(json!({ "cancelled": flag.is_some() }))
            }
            "list" => {
                // Expired temp / standby agents go before the list is drawn.
                self.remember_app(&env.callback);
                self.sweep_lifetimes();
                let status = req.get("status").and_then(Value::as_str).unwrap_or("all");
                let parent = req.get("parentSessionKey").and_then(Value::as_str);
                let name = req
                    .get("name")
                    .and_then(Value::as_str)
                    .map(sanitize_name)
                    .filter(|n| !n.is_empty());
                let query = req
                    .get("query")
                    .and_then(Value::as_str)
                    .map(str::to_lowercase)
                    .filter(|q| !q.trim().is_empty());
                let items: Vec<SubagentRecord> = self
                    .list()
                    .into_iter()
                    .filter(|r| parent.is_none_or(|p| r.parent_session_key == p))
                    .filter(|r| name.as_ref().is_none_or(|n| &r.name == n))
                    .filter(|r| {
                        query.as_ref().is_none_or(|q| {
                            r.task.to_lowercase().contains(q) || r.name.contains(q.as_str())
                        })
                    })
                    .filter(|r| match status {
                        "running" => r.is_running(),
                        "queued" => r.status == "queued",
                        "active" => r.is_active(),
                        "finished" => !r.is_active(),
                        _ => true,
                    })
                    .collect();
                Ok(
                    json!({ "subagents": items, "running": self.running_count(), "queued": self.queued_count(), "settings": self.settings() }),
                )
            }
            "get" => {
                let rec = self
                    .get(id)
                    .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
                let transcript = self.runner.load_messages(&rec.session_key);
                let mut branches = self.branches(id);
                if !req
                    .get("withBranches")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    branches.iter_mut().for_each(|b| b.messages.clear());
                }
                Ok(
                    json!({ "subagent": rec, "transcript": transcript, "memory": self.memory_entries(&rec.name),
                    "branches": branches, "compaction": self.compaction_policy(&rec.session_key) }),
                )
            }
            "spawn" => {
                let mut spec: SpawnSpec = serde_json::from_value(req.clone())
                    .map_err(|e| format!("Invalid spawn request: {}", e))?;
                spec.wait = Some(false);
                let (rec, how) = self.spawn_or_reuse(0, spec, env)?;
                Ok(json!({ "subagent": rec, "reuse": how }))
            }
            // Per-part deletion (feature "subagentData").
            "deleteData" => self.delete_data_request(req),
            "log" => {
                let limit = req
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(200)
                    .clamp(1, 2_000) as usize;
                Ok(json!({ "id": id, "log": self.read_log(id, limit) }))
            }
            "find" => {
                let session = req
                    .get("parentSessionKey")
                    .and_then(Value::as_str)
                    .unwrap_or(&env.session_key);
                let key = req
                    .get("key")
                    .or_else(|| req.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                Ok(json!({ "subagent": self.find_reusable(key, session) }))
            }
            // Stop only the current step: the run ends where it is, its work is kept,
            // and a message queued for it starts next (Stop drops those).
            // A queued agent has no step to interrupt: it stays queued.
            "interrupt" => {
                let queued = self.pending.lock().unwrap().contains_key(id);
                Ok(json!({ "interrupted": !queued && self.stop(id, "interrupted") }))
            }
            "stop" => {
                let stopped = if req.get("all").and_then(Value::as_bool).unwrap_or(false) {
                    self.stop_where(|_| true)
                } else if self.stop(id, "cancelled") {
                    vec![id.to_string()]
                } else {
                    vec![]
                };
                Ok(json!({ "stopped": stopped }))
            }
            "message" | "continue" | "reuse" => {
                let text = req.get("message").and_then(Value::as_str).unwrap_or("");
                let attachments = req.get("attachmentsJson").and_then(Value::as_str);
                let (rec, resumed) = self.message_with(id, text, attachments, env)?;
                Ok(json!({ "subagent": rec, "resumed": resumed }))
            }
            // Kept versions of its chat (edits and retries), for the switcher.
            "branches" => Ok(json!({ "id": id, "branches": self.branches(id) })),
            "restoreBranch" => {
                let branch = req
                    .get("branchId")
                    .and_then(Value::as_str)
                    .ok_or("`branchId` is required.")?;
                Ok(json!({ "subagent": self.restore_branch(id, branch)? }))
            }
            "retry" => Ok(json!({ "subagent": self.retry(id, env)? })),
            // Answer the last (or `turn`-th) user message again.
            "regenerate" => {
                let turn = req.get("turn").and_then(Value::as_u64).map(|n| n as usize);
                Ok(json!({ "subagent": self.regenerate(id, turn, None, env)? }))
            }
            // Edit user message `turn` (default: the last) and answer from there.
            "edit" => {
                let turn = req.get("turn").and_then(Value::as_u64).map(|n| n as usize);
                let text = req
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or("`message` is required.")?;
                let attachments = req.get("attachmentsJson").and_then(Value::as_str);
                Ok(
                    json!({ "subagent": self.regenerate_with(id, turn, Some(text), attachments, env)? }),
                )
            }
            // A new sub-agent from this one: same settings, same or edited task.
            "fork" | "rerun" => {
                let task = req.get("task").and_then(Value::as_str);
                let keep = req
                    .get("keepHistory")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Ok(json!({ "subagent": self.fork(0, id, task, keep, env)? }))
            }
            "priority" => {
                let p = req
                    .get("priority")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .clamp(-10, 10) as i32;
                let rec = self
                    .update(id, |r| r.priority = p)
                    .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
                self.persist();
                self.refresh_positions();
                Ok(json!({ "subagent": self.get(id).unwrap_or(rec) }))
            }
            "queue" => {
                let order = self.queue_order();
                let items: Vec<SubagentRecord> = order.iter().filter_map(|i| self.get(i)).collect();
                Ok(json!({
                    "queue": items,
                    "running": self.running_count(),
                    "maxParallel": self.settings().max_parallel,
                    "locks": crate::tool_scheduler::global().snapshot(),
                }))
            }
            "delete" => {
                self.delete(id)?;
                Ok(json!({ "deleted": id }))
            }
            "memory" => {
                let name = req
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| self.get(id).map(|r| r.name));
                let op = req.get("op").and_then(Value::as_str).unwrap_or("list");
                let Some(name) = name else {
                    return Ok(json!({ "names": self.memory_names() }));
                };
                match op {
                    "list" => Ok(json!({ "name": name, "entries": self.memory_entries(&name) })),
                    "clear" => Ok(json!({ "name": name, "cleared": self.memory_clear(&name) })),
                    "delete" => {
                        let key = req
                            .get("key")
                            .and_then(Value::as_str)
                            .ok_or("`key` is required.")?;
                        Ok(json!({ "name": name, "deleted": self.memory_forget(&name, key) }))
                    }
                    "promote" => {
                        let main = main_memory.ok_or("The main memory isn't available.")?;
                        let key = req.get("key").and_then(Value::as_str);
                        let mut promoted = 0;
                        for e in self
                            .memory_entries(&name)
                            .into_iter()
                            .filter(|e| key.is_none_or(|k| e.key == k))
                        {
                            let meta =
                                json!({ "promotedFrom": name, "subagentMetadata": e.metadata });
                            let out =
                                main.store(e.key.clone(), e.text.clone(), Some(meta.to_string()));
                            let ok = serde_json::from_str::<Value>(&out)
                                .ok()
                                .and_then(|v| v.get("success").and_then(Value::as_bool))
                                .unwrap_or(true);
                            if ok {
                                promoted += 1;
                            }
                        }
                        Ok(json!({ "name": name, "promoted": promoted }))
                    }
                    other => Err(format!("Unknown memory op {}.", other)),
                }
            }
            "graph" => {
                let key = req
                    .get("sessionKey")
                    .and_then(Value::as_str)
                    .filter(|k| !k.is_empty());
                let max = req.get("maxEvents").and_then(Value::as_u64).unwrap_or(0) as usize;
                Ok(self.graph(key, max))
            }
            "allowTool" => {
                let key = req.get("sessionKey").and_then(Value::as_str).unwrap_or("");
                let tool = req.get("toolName").and_then(Value::as_str).unwrap_or("");
                if key.trim().is_empty() || tool.trim().is_empty() {
                    return Err("allowTool needs sessionKey and toolName.".into());
                }
                // scope "agent": only this agent and the agents below it.
                let agent_scope = req.get("scope").and_then(Value::as_str) == Some("agent");
                let chat = if agent_scope {
                    key.trim().to_string()
                } else {
                    self.root_of(key)
                };
                Ok(
                    json!({ "sessionKey": chat, "scope": if agent_scope { "agent" } else { "chat" }, "tools": self.allow_tool_in_chat(&chat, tool) }),
                )
            }
            "revokeTool" => {
                let key = req.get("sessionKey").and_then(Value::as_str).unwrap_or("");
                let agent_scope = req.get("scope").and_then(Value::as_str) == Some("agent");
                let chat = if agent_scope {
                    key.trim().to_string()
                } else {
                    self.root_of(key)
                };
                Ok(
                    json!({ "sessionKey": chat, "tools": self.revoke_tool_in_chat(&chat, req.get("toolName").and_then(Value::as_str)) }),
                )
            }
            "chatAllows" => {
                let key = req.get("sessionKey").and_then(Value::as_str).unwrap_or("");
                let chat = self.root_of(key);
                // For a sub-agent: its own allows, and what it inherits from the agents above it.
                let mut inherited = Vec::new();
                let mut cur = self.record_by_session(key);
                while let Some(r) = cur {
                    if r.parent_session_key != chat {
                        for t in self.chat_allows(&r.parent_session_key) {
                            inherited.push(json!({ "tool": t, "from": r.parent_session_key }));
                        }
                    }
                    cur = self.record_by_session(&r.parent_session_key);
                    if inherited.len() > 200 {
                        break;
                    }
                }
                let own = if key != chat {
                    self.chat_allows(key)
                } else {
                    Vec::new()
                };
                Ok(
                    json!({ "sessionKey": chat, "tools": self.chat_allows(&chat), "agentTools": own, "inherited": inherited }),
                )
            }
            "settings" => {
                let (settings, rejected) = match req.get("settings") {
                    Some(patch) if patch.is_object() => self.set_settings_report(patch),
                    _ => (self.settings(), Vec::new()),
                };
                Ok(json!({ "settings": settings, "rejected": rejected }))
            }
            other => Err(format!("Unknown sub-agent action {}.", other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitEnd {
    Done,
    ParentCancelled,
    TimedOut,
}

struct StopOnDrop<'a> {
    manager: &'a Arc<SubagentManager>,
    ids: Vec<String>,
    armed: bool,
}

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        if self.armed {
            for id in &self.ids {
                self.manager.stop(id, "cancelled");
            }
        }
    }
}

fn last_assistant_text(messages: &[Message]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|m| m.role == Role::Assistant && !m.text().trim().is_empty())
        .map(|m| m.text())
}

fn fs_read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

fn fs_write_json<T: Serialize>(path: &Path, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(value) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

// ── Event interception ─────────────────────────────────────────────────────

/// The callback a sub-agent's loop emits into. It turns loop events into
/// `subagent.*` progress events for the app, keeps usage on the record,
/// enforces the token budget, and forwards requests that need the app
/// (approvals, MCP/WebView tool calls) re-tagged for the parent chat.
struct SubagentEvents {
    manager: Arc<SubagentManager>,
    id: String,
    name: String,
    parent_session_key: String,
    session_key: String,
    app: Option<Arc<dyn NativeEventCallback>>,
    abort: Arc<Mutex<bool>>,
    stop_reason: Arc<StdMutex<Option<String>>>,
    text_buf: Arc<StdMutex<String>>,
}

/// Internal stop reason: the run was stopped before a step that would have
/// gone past its token budget. Reported as `budget_exceeded` when the run was
/// cut short, and as `finished` when it had already answered.
pub(crate) const BUDGET_RESERVE_REASON: &str = "budget_reserve";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BudgetCheck {
    Ok,
    /// The budget is used up.
    Spent,
    /// Tokens are counted only after the provider answers, and every request
    /// resends at least the context the last one sent, so the next request
    /// would go past the budget. Stop now instead of overrunning it (a run
    /// used to end at e.g. 205k of a 200k budget).
    NextStepWouldOverrun,
}

/// `budget` 0 = no cap: the run is never stopped for tokens, like the main
/// agent; its context is kept inside the model's window by auto-compaction.
pub(crate) fn budget_check(total: u64, last_step_input: u64, budget: u64) -> BudgetCheck {
    if budget == 0 {
        BudgetCheck::Ok
    } else if total >= budget {
        BudgetCheck::Spent
    } else if total.saturating_add(last_step_input) > budget {
        BudgetCheck::NextStepWouldOverrun
    } else {
        BudgetCheck::Ok
    }
}

impl SubagentEvents {
    fn set_reason(&self, reason: &str) {
        let mut r = self.stop_reason.lock().unwrap();
        if r.is_none() {
            *r = Some(reason.to_string());
        }
    }
}

impl NativeEventCallback for SubagentEvents {
    fn on_event(&self, event_type: String, payload_json: String) {
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
        match event_type.as_str() {
            "text_delta" => {
                if let Some(t) = payload.get("text").and_then(Value::as_str) {
                    let mut buf = self.text_buf.lock().unwrap();
                    if buf.len() < 60_000 {
                        buf.push_str(t);
                    }
                }
            }
            "context.usage" => {
                let input = payload
                    .get("inputTokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let output = payload
                    .get("outputTokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                // A step a fallback model answered carries no window figures
                // (agent_loop leaves them out): keep the last known ones.
                let fields = [
                    ("estimatedTokens", "estimatedInputTokens"),
                    ("budgetTokens", "contextBudgetTokens"),
                    ("limitTokens", "contextLimitTokens"),
                    ("compactAtTokens", "compactAtTokens"),
                    ("thresholdPercent", "thresholdPercent"),
                    ("autoCompact", "autoCompact"),
                ];
                let Some(rec) = self.manager.update(&self.id, |r| {
                    r.input_tokens += input;
                    r.output_tokens += output;
                    r.steps += 1;
                    let mut status = r
                        .context_status
                        .take()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({}));
                    for (to, from) in fields {
                        match payload.get(from) {
                            Some(v) if !v.is_null() => {
                                status[to] = v.clone();
                            }
                            _ if status.get(to).is_none() => {
                                status[to] = Value::Null;
                            }
                            _ => {}
                        }
                    }
                    r.context_status = Some(status);
                }) else {
                    return;
                };
                let preview = {
                    let buf = self.text_buf.lock().unwrap();
                    let tail: String = buf
                        .chars()
                        .rev()
                        .take(300)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    tail
                };
                self.manager.emit(
                    &self.app,
                    "subagent.step",
                    &rec,
                    json!({ "preview": preview }),
                );
                self.manager.emit(
                    &self.app,
                    "subagent.usage",
                    &rec,
                    json!({ "stepInputTokens": input, "stepOutputTokens": output }),
                );
                match budget_check(rec.total_tokens(), input, rec.token_budget) {
                    BudgetCheck::Ok => {}
                    BudgetCheck::Spent => {
                        self.set_reason("budget_exceeded");
                        set_abort(&self.abort);
                    }
                    BudgetCheck::NextStepWouldOverrun => {
                        self.set_reason(BUDGET_RESERVE_REASON);
                        set_abort(&self.abort);
                    }
                }
            }
            "tool_use" => {
                let tool = payload
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(args) = payload.get("args") {
                    self.manager.track_tool_use(&self.id, &tool, args);
                }
                // A new tool round: the final report is the text after it.
                self.text_buf.lock().unwrap().clear();
                if let Some(rec) = self.manager.update(&self.id, |r| {
                    r.tool_calls += 1;
                    r.last_tool = Some(tool.clone());
                }) {
                    let args = payload
                        .get("args")
                        .map(|a| truncate_chars(&a.to_string(), 300))
                        .unwrap_or_default();
                    self.manager.emit(&self.app, "subagent.tool_call", &rec, json!({ "tool": tool, "toolCallId": payload.get("toolCallId"), "args": args }));
                }
            }
            "tool_result" => {
                if let Some(rec) = self.manager.get(&self.id) {
                    let is_error = payload
                        .pointer("/result/isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.manager.emit(&self.app, "subagent.tool_result", &rec, json!({
                        "tool": payload.get("toolName"),
                        "toolCallId": payload.get("toolCallId"),
                        "isError": is_error,
                        "preview": payload.pointer("/result/content").and_then(Value::as_str).map(|c| truncate_chars(c, 300)),
                    }));
                }
            }
            "context.compaction_started"
            | "context.compaction_deferred"
            | "context.tool_results_compacted"
            | "context.explanations_shortened"
            | "context.compacted"
            | "context.trimmed"
            | "context.overflow"
            | "context.overflow_unrecoverable"
            | "memory.queued"
            | "memory.summarizing"
            | "memory.updated"
            | "memory.pending"
            | "memory.failed"
            | "memory.cancelled" => {
                self.manager
                    .note_compaction(&self.id, &event_type, &payload, &self.app)
            }
            "max_turns_reached" => self.set_reason("max_steps"),
            "agent.background_timeout" => self.set_reason("timeout"),
            "approval_request" | "mcp_tool_call" => {
                let mut p = payload.clone();
                // From a grandchild it is already tagged with the innermost
                // sub-agent; keep that tag and only lift the chat key.
                let nested = payload.get("subagent").is_some();
                if let Some(obj) = p.as_object_mut() {
                    if !nested {
                        obj.insert(
                            "subagent".into(),
                            json!({ "id": self.id, "name": self.name }),
                        );
                        obj.insert("subagentSessionKey".into(), json!(self.session_key));
                    }
                    obj.insert("sessionKey".into(), json!(self.parent_session_key));
                }
                if event_type == "approval_request" && !nested {
                    if let Some(rec) = self.manager.get(&self.id) {
                        self.manager.emit(
                            &self.app,
                            "subagent.approval_needed",
                            &rec,
                            json!({ "request": payload }),
                        );
                    }
                }
                if let Some(app) = &self.app {
                    app.on_event(event_type, p.to_string());
                }
            }
            // Progress of this sub-agent's own sub-agents (nested delegation)
            // and of its parent consults: pass through to the chat unchanged.
            t if t.starts_with("subagent.") => {
                if let Some(app) = &self.app {
                    app.on_event(event_type, payload_json);
                }
            }
            t if t.starts_with("webllm") => {
                let mut p = payload.clone();
                if let Some(obj) = p.as_object_mut() {
                    if obj.get("subagent").is_none() {
                        obj.insert(
                            "subagent".into(),
                            json!({ "id": self.id, "name": self.name }),
                        );
                    }
                }
                if let Some(app) = &self.app {
                    app.on_event(event_type, p.to_string());
                }
            }
            _ => {}
        }
    }
}

// ── Memory provider ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub key: String,
    pub text: String,
    #[serde(default)]
    pub metadata: Option<Value>,
    pub updated_at: i64,
}

/// A sub-agent's memory: its own store keyed by name, optionally with read
/// access to the parent's memory (`read_parent`). `shared` mode doesn't use
/// this type; it hands the parent's provider straight to the loop.
pub struct SubagentMemory {
    manager: Arc<SubagentManager>,
    name: String,
    parent: Option<Arc<dyn MemoryProvider>>,
}

fn parent_items(raw: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(a)) => a,
        Ok(Value::Object(o)) => o
            .get("results")
            .or_else(|| o.get("entries"))
            .or_else(|| o.get("memories"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

impl SubagentMemory {
    fn search_all(
        &self,
        query: &str,
        limit: u32,
        parent_search: impl Fn(&dyn MemoryProvider) -> String,
    ) -> String {
        let mut out: Vec<Value> = self
            .manager
            .memory_search(&self.name, query, limit as usize)
            .into_iter()
            .map(|(e, score)| json!({ "key": e.key, "text": e.text, "score": score, "source": "subagent" }))
            .collect();
        if let Some(parent) = &self.parent {
            for mut item in parent_items(&parent_search(parent.as_ref())) {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("source".into(), json!("main"));
                }
                out.push(item);
            }
        }
        out.truncate(limit.max(1) as usize);
        Value::Array(out).to_string()
    }
}

impl MemoryProvider for SubagentMemory {
    fn store(&self, key: String, text: String, metadata_json: Option<String>) -> String {
        if key.trim().is_empty() {
            return json!({ "success": false, "error": "key is required" }).to_string();
        }
        let meta = metadata_json.and_then(|m| serde_json::from_str::<Value>(&m).ok());
        self.manager.memory_store(&self.name, &key, &text, meta);
        json!({ "success": true, "key": key, "memory": "subagent" }).to_string()
    }

    fn recall(&self, query: String, limit: u32) -> String {
        self.search_all(&query, limit, |p| p.recall(query.clone(), limit))
    }

    fn forget(&self, key: String) -> String {
        let removed = self.manager.memory_forget(&self.name, &key);
        json!({ "success": removed, "key": key, "memory": "subagent" }).to_string()
    }

    fn search(&self, query: String, max_results: u32) -> String {
        self.search_all(&query, max_results, |p| {
            p.search(query.clone(), max_results)
        })
    }

    fn list(&self, prefix: Option<String>, limit: Option<u32>) -> String {
        // The engine expects an array of key strings here.
        let limit = limit.unwrap_or(100).max(1) as usize;
        let mut seen = HashSet::new();
        let mut out: Vec<Value> = Vec::new();
        for e in self.manager.memory_entries(&self.name).into_iter().rev() {
            if prefix.as_deref().is_none_or(|p| e.key.starts_with(p)) && seen.insert(e.key.clone())
            {
                out.push(json!(e.key));
            }
        }
        if let Some(parent) = &self.parent {
            if let Ok(Value::Array(keys)) =
                serde_json::from_str::<Value>(&parent.list(prefix.clone(), Some(limit as u32)))
            {
                for k in keys {
                    if let Some(k) = k.as_str() {
                        if seen.insert(k.to_string()) {
                            out.push(json!(k));
                        }
                    }
                }
            }
        }
        out.truncate(limit);
        Value::Array(out).to_string()
    }
}

#[allow(dead_code)]
fn _assert_traits() {
    fn is_send_sync<T: Send + Sync>() {}
    is_send_sync::<SubagentManager>();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Collects every event the manager sends to the app.
    #[derive(Default)]
    struct AppEvents(StdMutex<Vec<(String, Value)>>);
    impl NativeEventCallback for AppEvents {
        fn on_event(&self, event_type: String, payload_json: String) {
            self.0.lock().unwrap().push((
                event_type,
                serde_json::from_str(&payload_json).unwrap_or(Value::Null),
            ));
        }
    }
    impl AppEvents {
        fn named(&self, name: &str) -> Vec<Value> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .filter(|(e, _)| e == name)
                .map(|(_, p)| p.clone())
                .collect()
        }
    }

    /// Main memory stand-in.
    #[derive(Default)]
    struct MainMemory(StdMutex<Vec<(String, String)>>);
    impl MemoryProvider for MainMemory {
        fn store(&self, key: String, text: String, _m: Option<String>) -> String {
            self.0.lock().unwrap().push((key, text));
            json!({"success": true}).to_string()
        }
        fn recall(&self, query: String, _limit: u32) -> String {
            let hits: Vec<Value> = self
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|(k, t)| k.contains(&query) || t.contains(&query))
                .map(|(k, t)| json!({"key": k, "text": t, "score": 1.0}))
                .collect();
            Value::Array(hits).to_string()
        }
        fn forget(&self, _key: String) -> String {
            json!({"success": true}).to_string()
        }
        fn search(&self, query: String, limit: u32) -> String {
            self.recall(query, limit)
        }
        fn list(&self, _p: Option<String>, _l: Option<u32>) -> String {
            Value::Array(
                self.0
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(k, _)| json!(k))
                    .collect(),
            )
            .to_string()
        }
    }

    /// Scripted stand-in for the agent loop. The prompt says what to do:
    /// `sleep:<ms>`, `usage:<tokens per step>`, `approval`, `remember:<k>=<v>`,
    /// `recall:<q>`, `turns`. It honours the cancel switch like the real loop.
    #[derive(Default)]
    struct Script {
        saved: StdMutex<HashMap<String, Vec<Message>>>,
        requests: StdMutex<Vec<(String, Option<String>, String)>>, // (prompt, allowed tools, system)
        concurrent: AtomicUsize,
        max_concurrent: AtomicUsize,
        /// attachments_json of each run, in order.
        attachments: StdMutex<Vec<Option<String>>>,
        /// (session, kept turns) of each memory rewind, in order.
        forgotten: StdMutex<Vec<(String, u32)>>,
    }

    impl SubagentRunner for Arc<Script> {
        fn run(&self, req: RunRequest) -> RunFuture {
            let me = self.clone();
            Box::pin(async move {
                me.requests.lock().unwrap().push((
                    req.params.prompt.clone(),
                    req.params.allowed_tools_json.clone(),
                    req.params.system_prompt.clone(),
                ));
                me.attachments
                    .lock()
                    .unwrap()
                    .push(req.params.attachments_json.clone());
                let now = me.concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                me.max_concurrent.fetch_max(now, Ordering::SeqCst);
                let _dec = Dec(&me.concurrent);
                let full_prompt = req.params.prompt.clone();
                // A cross-session note wraps the message: act on the message.
                let prompt = if full_prompt.starts_with("[Message from") {
                    full_prompt
                        .split_once("\n\n")
                        .map(|x| x.1.to_string())
                        .unwrap_or_default()
                } else {
                    full_prompt.clone()
                };
                let cb = req.callback.clone();
                let aborted = || async { *req.abort.lock().await };
                let mut reply = format!("done: {prompt}");
                if prompt == "whatdoyouknow" {
                    let first = req
                        .prior_messages
                        .first()
                        .map(|m| match &m.content {
                            MessageContent::Text(t) => t.clone(),
                            _ => String::new(),
                        })
                        .unwrap_or_default();
                    reply = format!(
                        "I have {} earlier messages; the first was '{}'.",
                        req.prior_messages.len(),
                        first
                    );
                }
                if let Some(ms) = prompt.strip_prefix("sleep:") {
                    let ms: u64 = ms.trim().parse().unwrap_or(0);
                    let end = Instant::now() + Duration::from_millis(ms);
                    while Instant::now() < end {
                        if aborted().await {
                            return Err(NativeAgentError::Cancelled);
                        }
                        // steer messages show up in the reply
                        if let Some(rx) = req.steer_rx.lock().await.as_mut() {
                            while let Ok(m) = rx.try_recv() {
                                reply.push_str(&format!(" | steer: {m}"));
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                } else if let Some(n) = prompt.strip_prefix("usage:") {
                    let n: u64 = n.trim().parse().unwrap_or(0);
                    for _ in 0..1000 {
                        if aborted().await {
                            return Err(NativeAgentError::Cancelled);
                        }
                        cb.on_event("text_delta".into(), json!({"text": "partial "}).to_string());
                        cb.on_event(
                            "context.usage".into(),
                            json!({"inputTokens": n, "outputTokens": 0}).to_string(),
                        );
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                } else if let Some(ms) = prompt.strip_prefix("hold:") {
                    // Works without reading its steers (no safe point).
                    tokio::time::sleep(Duration::from_millis(ms.trim().parse().unwrap_or(0))).await;
                } else if prompt == "approval" {
                    cb.on_event("tool_use".into(), json!({"toolName": "write_file", "toolCallId": "t1", "args": {"path": "a"}}).to_string());
                    cb.on_event("approval_request".into(), json!({"toolCallId": "t1", "toolName": "write_file", "sessionKey": req.params.session_key}).to_string());
                } else if let Some(kv) = prompt.strip_prefix("remember:") {
                    let (k, v) = kv.split_once('=').unwrap();
                    let mem = req.memory.as_ref().expect("memory");
                    mem.store(k.into(), v.into(), None);
                } else if let Some(q) = prompt.strip_prefix("recall:") {
                    let mem = req.memory.as_ref().expect("memory");
                    reply = mem.recall(q.into(), 10);
                } else if prompt == "turns" {
                    cb.on_event("max_turns_reached".into(), json!({"turns": 3}).to_string());
                } else if let Some(rest) = prompt.strip_prefix("spawn:") {
                    // A sub-agent that delegates to its own sub-agent.
                    let env = ParentEnv {
                        task_context: None,
                        session_key: req.params.session_key.clone(),
                        provider: None,
                        model: None,
                        system_prompt: req.params.system_prompt.clone(),
                        tool_names: vec!["read_file".into()],
                        callback: Some(cb.clone()),
                        memory: None,
                        abort: Some(req.abort.clone()),
                    };
                    let (out, err) = req
                        .child
                        .manager
                        .handle_tool(
                            req.child.depth,
                            TOOL_SPAWN,
                            &json!({"task": rest, "name": format!("level{}", req.child.depth + 1)}),
                            env,
                        )
                        .await;
                    reply = format!("nested(err={err}): {out}");
                } else if let Some(rest) = prompt.strip_prefix("team:") {
                    let (tool, input) = rest.split_once(' ').unwrap_or((rest, "{}"));
                    let env = ParentEnv {
                        task_context: None,
                        session_key: req.params.session_key.clone(),
                        provider: None,
                        model: None,
                        system_prompt: req.params.system_prompt.clone(),
                        tool_names: Vec::new(),
                        callback: Some(cb.clone()),
                        memory: None,
                        abort: Some(req.abort.clone()),
                    };
                    let (out, err) = req
                        .child
                        .manager
                        .handle_team_tool(tool, &serde_json::from_str(input).unwrap(), env)
                        .await;
                    reply = format!("team(err={err}): {out}");
                } else if let Some(out) = swarm_tests::auto_respond(&full_prompt, &req).await {
                    reply = out;
                } else if full_prompt.starts_with("[Question from your sub-agent") {
                    reply = format!(
                        "PARENT-ANSWER sys_has_task={}",
                        req.params.system_prompt.contains("asks you a question")
                    );
                }
                let mut messages = req.prior_messages.clone();
                // As the real loop: attachments ride on the user message.
                let blocks =
                    crate::types::parse_attachments(req.params.attachments_json.as_deref())
                        .unwrap_or_default();
                if blocks.is_empty() {
                    messages.push(Message::user(&full_prompt));
                } else {
                    reply.push_str(&format!(" [{} attachment(s)]", blocks.len()));
                    messages.push(Message::user_with_attachments(&full_prompt, blocks));
                }
                messages.push(Message {
                    role: Role::Assistant,
                    content: MessageContent::Text(reply),
                });
                Ok(RunDone {
                    messages,
                    model: "m".into(),
                    provider: "p".into(),
                    usage: None,
                })
            })
        }
        fn load_messages(&self, key: &str) -> Vec<Message> {
            self.saved
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .unwrap_or_default()
        }
        fn save(&self, key: &str, done: &RunDone, _s: i64, _m: u32, _t: &str) {
            self.saved
                .lock()
                .unwrap()
                .insert(key.into(), done.messages.clone());
        }
        fn clear(&self, key: &str) {
            self.saved.lock().unwrap().remove(key);
        }
        fn forget_turns_after(&self, key: &str, keep_turns: u32) {
            self.forgotten
                .lock()
                .unwrap()
                .push((key.to_string(), keep_turns));
        }
        fn list_chats(&self) -> Vec<ChatInfo> {
            self.saved
                .lock()
                .unwrap()
                .iter()
                .filter(|(k, _)| !k.starts_with("subagent:"))
                .map(|(k, m)| ChatInfo {
                    session_key: k.clone(),
                    title: String::new(),
                    updated_at: 0,
                    message_count: m.len(),
                })
                .collect()
        }
    }

    mod swarm_tests;

    struct Dec<'a>(&'a AtomicUsize);
    impl Drop for Dec<'_> {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn setup() -> (
        Arc<SubagentManager>,
        Arc<Script>,
        Arc<AppEvents>,
        ParentEnv,
        PathBuf,
    ) {
        let dir = std::env::temp_dir().join(format!("subagents-test-{}", uuid::Uuid::new_v4()));
        let script = Arc::new(Script::default());
        let mgr = SubagentManager::new(dir.clone(), Arc::new(script.clone()));
        let app = Arc::new(AppEvents::default());
        let env = ParentEnv {
            task_context: None,
            session_key: "chat-1".into(),
            provider: Some("openai".into()),
            model: Some("gpt-x".into()),
            system_prompt: "PARENT".into(),
            tool_names: vec![
                "read_file".into(),
                "write_file".into(),
                "list_files".into(),
                "ui__show_card".into(),
                "spawn_subagent".into(),
            ],
            callback: Some(app.clone()),
            memory: Some(Arc::new(MainMemory::default())),
            abort: None,
        };
        (mgr, script, app, env, dir)
    }

    fn spec(task: &str) -> SpawnSpec {
        SpawnSpec {
            task: task.into(),
            ..Default::default()
        }
    }

    async fn run_tool(
        mgr: &Arc<SubagentManager>,
        tool: &str,
        input: Value,
        env: &ParentEnv,
    ) -> (String, bool) {
        mgr.handle_tool(0, tool, &input, env.clone()).await
    }

    #[tokio::test]
    async fn spawn_waits_and_returns_the_report() {
        let (mgr, script, app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "count files", "name": "Counter Bot"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(
            out.contains("finished") && out.contains("done: count files"),
            "{out}"
        );
        let rec = &mgr.list()[0];
        assert_eq!(rec.status, "finished");
        assert_eq!(rec.name, "counter-bot");
        assert_eq!(
            rec.model.as_deref(),
            Some("gpt-x"),
            "inherits the parent's model"
        );
        assert_eq!(app.named("subagent.started").len(), 1);
        assert_eq!(app.named("subagent.finished").len(), 1);
        // persisted transcript + registry
        assert_eq!(script.load_messages(&rec.session_key).len(), 2);
        let reloaded = SubagentManager::new(mgr.state_dir.clone(), Arc::new(script.clone()));
        assert_eq!(reloaded.list()[0].id, rec.id);
        // the brief, not the parent's chat, is the prompt; parent prompt is kept below the sub-agent rules
        let (prompt, _, system) = script.requests.lock().unwrap()[0].clone();
        assert_eq!(prompt, "count files");
        assert!(system.starts_with("You are \"counter-bot\"") && system.ends_with("PARENT"));
    }

    #[tokio::test]
    async fn temp_agent_is_deleted_once_its_report_reached_the_parent() {
        let (mgr, _script, app, env, _) = setup();
        mgr.set_lifetime_policy(LifetimePolicy {
            temp_keep_secs: 0,
            standby_ttl_secs: 3_600,
            render_in_chat: false,
        });
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "one-off", "name": "once", "lifetime": "temp"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(
            out.contains("done: one-off") && out.contains("temp sub-agent"),
            "{out}"
        );
        assert!(
            mgr.list().iter().all(|r| r.name != "once"),
            "a delivered temp agent is gone"
        );
        let deleted = app.named("subagent.deleted");
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0]["reason"], "temp_done");
        // A reusable agent (the default) stays.
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "keep me", "name": "keeper"}),
            &env,
        )
        .await;
        assert!(out.contains("done: keep me"), "{out}");
        assert_eq!(mgr.sweep_lifetimes().len(), 0);
        assert!(mgr
            .list()
            .iter()
            .any(|r| r.name == "keeper" && r.lifetime.is_none()));
    }

    #[tokio::test]
    async fn standby_agent_is_deleted_after_its_idle_ttl() {
        let (mgr, _script, app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "warm up", "name": "sb", "lifetime": "standby", "ttl_secs": 600}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let rec = mgr
            .list()
            .into_iter()
            .find(|r| r.name == "sb")
            .expect("standby agent kept");
        assert_eq!(rec.lifetime.as_deref(), Some("standby"));
        assert_eq!(rec.standby_ttl_secs, Some(600));
        assert!(mgr.sweep_lifetimes().is_empty(), "not idle long enough");
        // Idle for longer than its TTL.
        let old = now_ms() - 601_000;
        mgr.update(&rec.id, |r| {
            r.started_at = old - 1_000;
            r.created_at = old - 1_000;
            r.finished_at = Some(old);
        });
        let gone = mgr.sweep_lifetimes();
        assert_eq!(gone.len(), 1, "{gone:?}");
        assert_eq!(gone[0]["reason"], "standby_expired");
        assert!(mgr.list().iter().all(|r| r.id != rec.id));
        assert_eq!(app.named("subagent.deleted").len(), 1);
    }

    #[tokio::test]
    async fn bad_lifetime_is_refused_and_render_in_chat_sends_the_answer() {
        let (mgr, _script, app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "x", "lifetime": "forever"}),
            &env,
        )
        .await;
        assert!(err && out.contains("Unknown lifetime"), "{out}");
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "show this", "name": "shower", "render_in_chat": true}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let fin = app.named("subagent.finished");
        let last = fin.last().expect("finished event");
        assert_eq!(last["renderInChat"], true);
        assert!(last["answer"]
            .as_str()
            .unwrap_or("")
            .contains("done: show this"));
        // No context tree here: the parent still gets the full report.
        assert!(out.contains("done: show this"), "{out}");
    }

    #[tokio::test]
    async fn tools_are_narrowed_to_parent_intersection_without_ui_tools() {
        let (mgr, script, _app, env, _) = setup();
        // This test is about depth 1 (the default was 1 when it was written;
        // it is 2 now), so it sets depth 1 itself.
        mgr.set_settings(&json!({"maxDepth": 1}));
        let rec = mgr
            .spawn(
                0,
                SpawnSpec {
                    tools: Some(vec![
                        "read_file".into(),
                        "ui__show_card".into(),
                        "shell".into(),
                        "read_file".into(),
                    ]),
                    ..spec("x")
                },
                &env,
            )
            .unwrap();
        assert_eq!(rec.tools, vec!["read_file".to_string()]);
        let rec2 = mgr.spawn(0, spec("y"), &env).unwrap();
        assert_eq!(
            rec2.tools,
            vec![
                "read_file".to_string(),
                "write_file".into(),
                "list_files".into()
            ]
        );
        let err = mgr
            .spawn(
                0,
                SpawnSpec {
                    tools: Some(vec!["shell".into()]),
                    ..spec("z")
                },
                &env,
            )
            .unwrap_err();
        assert!(err.contains("None of the requested tools"));
        mgr.wait_for(
            &[rec.id.clone(), rec2.id.clone()],
            None,
            Duration::from_secs(5),
        )
        .await;
        // depth 1 default: the child is not offered sub-agent tools
        let allowed: Vec<String> =
            serde_json::from_str(script.requests.lock().unwrap()[0].1.as_deref().unwrap()).unwrap();
        assert_eq!(
            allowed,
            vec!["read_file".to_string(), "ask_parent".into()],
            "own tools plus ask_parent (tree topology)"
        );
    }

    #[tokio::test]
    async fn depth_limit_blocks_nested_spawning_and_is_configurable() {
        let (mgr, script, _app, env, _) = setup();
        // Depth 1 set explicitly (the default is 2 now); the assertions are unchanged.
        mgr.set_settings(&json!({"maxDepth": 1}));
        let (out, err) = mgr
            .handle_tool(1, TOOL_SPAWN, &json!({"task": "nested"}), env.clone())
            .await;
        assert!(err && out.contains("depth limit is 1"), "{out}");
        assert!(!mgr.offers_tools_at(1) && mgr.offers_tools_at(0));
        mgr.set_settings(&json!({"maxDepth": 2}));
        assert!(mgr.offers_tools_at(1));
        let rec = mgr.spawn(0, spec("child"), &env).unwrap();
        mgr.wait_for(&[rec.id], None, Duration::from_secs(5)).await;
        let allowed: Vec<String> =
            serde_json::from_str(script.requests.lock().unwrap()[0].1.as_deref().unwrap()).unwrap();
        assert!(
            allowed.contains(&TOOL_SPAWN.to_string()),
            "depth 2 lets the child delegate: {allowed:?}"
        );
        mgr.set_settings(&json!({"maxDepth": 99}));
        assert_eq!(mgr.settings().max_depth, 3, "clamped");
    }

    #[tokio::test]
    async fn nested_spawning_works_to_the_configured_depth_and_reaches_the_chat() {
        let (mgr, script, app, env, _) = setup();
        mgr.set_settings(&json!({"maxDepth": 3, "maxParallel": 1}));
        // depth 1 spawns depth 2, which spawns depth 3, which may not spawn.
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "spawn:spawn:spawn:leaf", "name": "top"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(
            out.contains("nested(err=false)"),
            "level 1 delegated: {out}"
        );
        let list = mgr.list();
        assert_eq!(
            list.len(),
            3,
            "three levels: {:?}",
            list.iter().map(|r| (&r.name, r.depth)).collect::<Vec<_>>()
        );
        let by_depth = |d: u32| list.iter().find(|r| r.depth == d).unwrap().clone();
        let (l1, l2, l3) = (by_depth(1), by_depth(2), by_depth(3));
        assert_eq!(l2.parent_id.as_deref(), Some(l1.id.as_str()), "lineage");
        assert_eq!(l3.parent_id.as_deref(), Some(l2.id.as_str()));
        for r in [&l1, &l2, &l3] {
            assert_eq!(r.root_session_key, "chat-1", "every level knows its chat");
            assert_eq!(r.status, "finished");
        }
        assert!(script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(_, _, sys)| sys.contains("depth 1 of 3")));
        // the depth-3 agent is refused (limit), not deadlocked by maxParallel 1
        let l3_reply = last_assistant_text(&script.load_messages(&l3.session_key)).unwrap();
        assert!(
            l3_reply.contains("err=true") && l3_reply.contains("depth limit is 3"),
            "{l3_reply}"
        );
        // events of every level reach the chat
        let started = app.named("subagent.started");
        assert_eq!(started.len(), 3, "grandchild events are forwarded");
        // the base prompt appears once in a grandchild's system prompt
        let sys3 = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(p, _, _)| p == "spawn:leaf")
            .unwrap()
            .2
            .clone();
        assert_eq!(sys3.matches("PARENT").count(), 1, "{sys3}");
    }

    #[tokio::test]
    async fn topologies_control_peer_messaging_and_visibility() {
        let (mgr, _script, app, env, _) = setup();
        mgr.set_settings(&json!({"topology": "mesh"}));
        let a = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("alpha".into()),
                    ..spec("sleep:400")
                },
                &env,
            )
            .unwrap();
        let b = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("beta".into()),
                    ..spec("sleep:400")
                },
                &env,
            )
            .unwrap();
        let c = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("gamma".into()),
                    hidden_from: Some(vec!["alpha".into()]),
                    ..spec("sleep:400")
                },
                &env,
            )
            .unwrap();
        let ra = mgr.get(&a.id).unwrap();
        assert!(mgr
            .team_tool_names(&ra)
            .contains(&team::TOOL_MESSAGE_PEER.to_string()));
        let peers: Vec<String> = mgr.peers_of(&ra).into_iter().map(|p| p.0.name).collect();
        assert_eq!(
            peers,
            vec!["beta".to_string()],
            "gamma is hidden from alpha"
        );
        let env_a = ParentEnv {
            task_context: None,
            session_key: ra.session_key.clone(),
            ..env.clone()
        };
        let (out, err) = mgr
            .handle_team_tool(
                team::TOOL_MESSAGE_PEER,
                &json!({"to": "beta", "message": "found it in src/lib.rs"}),
                env_a.clone(),
            )
            .await;
        assert!(!err && out.contains("Delivered"), "{out}");
        let (out, err) = mgr
            .handle_team_tool(
                team::TOOL_MESSAGE_PEER,
                &json!({"to": "gamma", "message": "hi"}),
                env_a.clone(),
            )
            .await;
        assert!(err, "hidden peer: {out}");
        assert_eq!(app.named("subagent.peer_message").len(), 1);
        // star: no peer tools, no nesting
        mgr.set_settings(&json!({"topology": "star", "maxDepth": 3}));
        assert!(!mgr
            .team_tool_names(&ra)
            .contains(&team::TOOL_MESSAGE_PEER.to_string()));
        assert!(!mgr.offers_tools_at(1) && mgr.offers_tools_at(0));
        let (out, err) = mgr
            .handle_team_tool(
                team::TOOL_MESSAGE_PEER,
                &json!({"to": "beta", "message": "x"}),
                env_a.clone(),
            )
            .await;
        assert!(err, "{out}");
        // ring: only the next sibling
        mgr.set_settings(&json!({"topology": "ring"}));
        let rb = mgr.get(&b.id).unwrap();
        assert!(mgr.may_message(&ra, &rb).is_ok());
        assert!(mgr.may_message(&rb, &ra).is_err(), "beta's next is gamma");
        // explicit allow-list wins over the topology
        mgr.handle_app_request(
            &json!({"action": "configure", "id": b.id, "canMessage": ["alpha"]}),
            &env,
            None,
        )
        .unwrap();
        assert!(mgr.may_message(&mgr.get(&b.id).unwrap(), &ra).is_ok());
        // a stopped peer gets the message in its inbox for its next run
        mgr.set_settings(&json!({"topology": "mesh"}));
        mgr.wait_for(
            &[a.id.clone(), b.id.clone(), c.id.clone()],
            None,
            Duration::from_secs(5),
        )
        .await;
        let (out, _) = mgr
            .handle_team_tool(
                team::TOOL_MESSAGE_PEER,
                &json!({"to": "beta", "message": "later"}),
                env_a,
            )
            .await;
        assert!(out.contains("inbox"), "{out}");
        assert_eq!(mgr.get(&b.id).unwrap().inbox.len(), 1);
        assert_eq!(mgr.take_inbox(&b.id).len(), 1);
    }

    #[tokio::test]
    async fn ask_parent_consults_the_parent_without_its_tools() {
        let (mgr, script, app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "team:ask_parent {\"question\":\"which folder?\"}"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(
            out.contains("Your parent answers: PARENT-ANSWER sys_has_task=true"),
            "{out}"
        );
        let consult = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(p, _, _)| p.starts_with("[Question from"))
            .cloned()
            .unwrap();
        assert_eq!(consult.1.as_deref(), Some("[]"), "no tools in a consult");
        assert_eq!(app.named("subagent.ask_parent").len(), 1);
        assert_eq!(app.named("subagent.parent_answer").len(), 1);
        mgr.set_settings(&json!({"allowAskParent": false}));
        let (out2, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "team:ask_parent {\"question\":\"x\"}"}),
            &env,
        )
        .await;
        assert!(out2.contains("turned off"), "{out2}");
    }

    #[tokio::test]
    async fn templates_are_saved_reused_and_extended() {
        let (mgr, _script, _app, env, _) = setup();
        let rec = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("researcher".into()),
                    title: Some("Researcher".into()),
                    description: Some("Finds sources".into()),
                    system_prompt: Some("Cite sources.".into()),
                    tools: Some(vec!["read_file".into()]),
                    ..spec("look")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        let saved = mgr
            .handle_app_request(
                &json!({"action": "saveTemplate", "fromId": rec.id}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(saved["template"]["createdFrom"], json!(rec.id));
        assert_eq!(saved["template"]["title"], "Researcher");
        mgr.handle_app_request(&json!({"action": "saveTemplate", "template": {"name": "deep-researcher", "extends": "researcher", "systemPrompt": "Go deep.", "title": "Deep researcher"}}), &env, None).unwrap();
        let resolved = mgr.resolve_template("deep-researcher").unwrap();
        assert_eq!(
            resolved.system_prompt.as_deref(),
            Some("Cite sources.\n\nGo deep.")
        );
        assert_eq!(resolved.tools, Some(vec!["read_file".to_string()]));
        assert_eq!(resolved.title.as_deref(), Some("Deep researcher"));
        let child = mgr
            .spawn(
                0,
                SpawnSpec {
                    template: Some("deep-researcher".into()),
                    ..spec("go")
                },
                &env,
            )
            .unwrap();
        assert_eq!(child.template.as_deref(), Some("deep-researcher"));
        assert_eq!(child.name, "deep-researcher");
        assert_eq!(child.title.as_deref(), Some("Deep researcher"));
        assert_eq!(
            child.system_prompt.as_deref(),
            Some("Cite sources.\n\nGo deep.")
        );
        assert!(mgr.delegation_prompt().contains("deep-researcher"));
        let err = mgr
            .spawn(
                0,
                SpawnSpec {
                    template: Some("nope".into()),
                    ..spec("go")
                },
                &env,
            )
            .unwrap_err();
        assert!(err.contains("No sub-agent template named nope"));
        assert_eq!(
            mgr.handle_app_request(&json!({"action": "lineage", "id": child.id}), &env, None)
                .unwrap()["lineage"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(mgr.delete_template("deep-researcher"));
        mgr.wait_for(&[child.id], None, Duration::from_secs(5))
            .await;
    }

    #[tokio::test]
    async fn parallel_runs_and_the_parallel_limit() {
        let (mgr, script, _app, env, _) = setup();
        let mut ids = Vec::new();
        for i in 0..3 {
            let (out, err) = run_tool(
                &mgr,
                TOOL_SPAWN,
                json!({"task": "sleep:300", "name": format!("w{i}"), "wait": false}),
                &env,
            )
            .await;
            assert!(!err && out.contains("in the background"), "{out}");
            ids.push(mgr.list()[0].id.clone());
        }
        // Over the limit: it queues instead of failing.
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "sleep:10", "wait": false}),
            &env,
        )
        .await;
        assert!(
            !err && out.contains("Queued") && out.contains("position 1"),
            "{out}"
        );
        assert_eq!(mgr.queued_count(), 1);
        let started = Instant::now();
        let (out, err) = run_tool(&mgr, TOOL_LIST, json!({"wait": true}), &env).await;
        assert!(!err);
        assert_eq!(out.matches("finished after").count(), 4, "{out}");
        assert!(
            started.elapsed() < Duration::from_millis(1200),
            "ran in parallel, took {:?}",
            started.elapsed()
        );
        assert_eq!(script.max_concurrent.load(Ordering::SeqCst), 3);
        assert_eq!(mgr.running_count(), 0);
        assert_eq!(mgr.queued_count(), 0);
        let (listing, _) = run_tool(&mgr, TOOL_LIST, json!({}), &env).await;
        assert_eq!(
            listing.matches("\"status\": \"finished\"").count(),
            4,
            "{listing}"
        );
        // another chat doesn't see them
        let other = ParentEnv {
            task_context: None,
            session_key: "chat-2".into(),
            ..env.clone()
        };
        let (none, _) = run_tool(&mgr, TOOL_LIST, json!({}), &other).await;
        assert!(none.contains("no sub-agents"));
    }

    #[tokio::test]
    async fn approval_requests_reach_the_app_tagged_with_the_subagent() {
        let (mgr, _script, app, env, _) = setup();
        let rec = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("Writer".into()),
                    ..spec("approval")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        let req = &app.named("approval_request")[0];
        assert_eq!(req["subagent"]["id"], json!(rec.id));
        assert_eq!(req["subagent"]["name"], "writer");
        assert_eq!(req["sessionKey"], "chat-1", "shown in the parent's chat");
        assert_eq!(req["subagentSessionKey"], json!(rec.session_key));
        assert_eq!(req["toolCallId"], "t1");
        let needed = &app.named("subagent.approval_needed")[0];
        assert_eq!(needed["id"], json!(rec.id));
        let call = &app.named("subagent.tool_call")[0];
        assert_eq!(call["tool"], "write_file");
        assert_eq!(mgr.get(&rec.id).unwrap().tool_calls, 1);
    }

    #[test]
    fn budget_check_stops_before_a_step_that_would_overrun() {
        assert_eq!(budget_check(0, 0, 200_000), BudgetCheck::Ok);
        assert_eq!(budget_check(150_000, 20_000, 200_000), BudgetCheck::Ok);
        assert_eq!(
            budget_check(180_000, 25_000, 200_000),
            BudgetCheck::NextStepWouldOverrun
        );
        assert_eq!(budget_check(200_000, 0, 200_000), BudgetCheck::Spent);
        assert_eq!(budget_check(205_000, 25_000, 200_000), BudgetCheck::Spent);
        assert_eq!(
            budget_check(u64::MAX - 10, 100, u64::MAX - 5),
            BudgetCheck::NextStepWouldOverrun
        );
    }

    #[test]
    fn budget_zero_means_no_cap() {
        assert_eq!(budget_check(0, 0, 0), BudgetCheck::Ok);
        assert_eq!(budget_check(5_000_000, 900_000, 0), BudgetCheck::Ok);
        assert_eq!(clamp_token_budget(0), 0);
        assert_eq!(clamp_token_budget(5), 1_000);
        assert_eq!(clamp_token_budget(9_000_000), 5_000_000);
        assert_eq!(SubagentSettings::default().default_token_budget, 0);
        assert_eq!(
            SubagentSettings {
                default_token_budget: 0,
                ..Default::default()
            }
            .clamped()
            .default_token_budget,
            0
        );
    }

    /// Why sub-agents never compacted: the old 200k cap counts every resent
    /// prompt, so a run whose context grows step by step is stopped long
    /// before that context reaches the compaction point of a model window.
    #[test]
    fn the_old_200k_cap_stopped_runs_before_their_context_could_compact() {
        // A 128k-window model with 8k output reserved (as agent_loop budgets it).
        let transcript_budget = 128_000usize - 8_192 - 2_048;
        let compact_at = CompactionPolicy::default().trigger_tokens(transcript_budget) as u64;
        let run = |cap: u64| -> u64 {
            // Each step resends the context, which grows by 6k (a file read).
            let (mut total, mut context) = (0u64, 10_000u64);
            loop {
                if context >= compact_at {
                    return context; // reached the compaction point
                }
                total += context + 500;
                if budget_check(total, context, cap) != BudgetCheck::Ok {
                    return context; // stopped for tokens
                }
                context += 6_000;
            }
        };
        let stopped_at = run(LEGACY_DEFAULT_TOKEN_BUDGET);
        assert!(
            stopped_at < compact_at / 2,
            "200k cap: stopped at a {stopped_at}-token context, compaction starts at {compact_at}"
        );
        assert!(
            run(0) >= compact_at,
            "no cap: the context grows to the compaction point, like the main agent's"
        );
    }

    #[tokio::test]
    async fn by_default_a_sub_agent_is_not_stopped_for_tokens() {
        let (mgr, _script, _app, env, _) = setup();
        // 1000 steps of 400 tokens: 400k, twice the old 200k default cap.
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "usage:400"}), &env).await;
        let rec = &mgr.list()[0];
        assert_eq!(rec.token_budget, 0);
        assert_eq!(rec.status, "finished", "{out}");
        assert!(rec.total_tokens() >= 400_000, "{}", rec.total_tokens());
        let p = SubagentManager::subagent_system_prompt(rec, "");
        assert!(
            p.contains("compacted automatically") && !p.contains(" 0 tokens"),
            "{p}"
        );
        assert!(mgr.delegation_prompt().contains("no token cap"));
    }

    #[tokio::test]
    async fn the_old_default_cap_is_migrated_once() {
        let (first, _script, _app, env, dir) = setup();
        run_tool(
            &first,
            TOOL_SPAWN,
            json!({"task": "hi", "name": "old", "token_budget": 200_000}),
            &env,
        )
        .await;
        run_tool(
            &first,
            TOOL_SPAWN,
            json!({"task": "hi", "name": "own", "token_budget": 50_000}),
            &env,
        )
        .await;
        let id_of = |name: &str| {
            first
                .list()
                .into_iter()
                .find(|r| r.name == name)
                .unwrap()
                .id
        };
        let (old_id, own_id) = (id_of("old"), id_of("own"));
        drop(first);
        // Files as an older build wrote them: no tokenBudgetSchema.
        std::fs::write(
            dir.join("settings.json"),
            r#"{"defaultTokenBudget":200000,"maxParallel":5}"#,
        )
        .unwrap();
        std::fs::write(dir.join("templates.json"), json!([{"name": "old", "tokenBudget": 200_000}, {"name": "own", "tokenBudget": 70_000}]).to_string()).unwrap();
        let mgr = SubagentManager::new(dir.clone(), Arc::new(Arc::new(Script::default())));
        assert_eq!(mgr.settings().default_token_budget, 0);
        assert_eq!(mgr.settings().max_parallel, 5, "other settings are kept");
        assert_eq!(mgr.get(&old_id).map(|r| r.token_budget), Some(0));
        assert_eq!(
            mgr.get(&own_id).map(|r| r.token_budget),
            Some(50_000),
            "a cap someone chose stays"
        );
        let t = mgr.templates();
        assert_eq!(
            t.iter().find(|t| t.name == "old").unwrap().token_budget,
            None
        );
        assert_eq!(
            t.iter().find(|t| t.name == "own").unwrap().token_budget,
            Some(70_000)
        );
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(saved["tokenBudgetSchema"], TOKEN_BUDGET_SCHEMA);
        // Once migrated, a 200k cap the user sets later stays 200k.
        mgr.set_settings(&json!({"defaultTokenBudget": 200_000}));
        drop(mgr);
        let again = SubagentManager::new(dir, Arc::new(Arc::new(Script::default())));
        assert_eq!(again.settings().default_token_budget, 200_000);
    }

    #[tokio::test]
    async fn token_budget_stops_the_run() {
        let (mgr, _script, app, env, _) = setup();
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "usage:400", "token_budget": 1000}),
            &env,
        )
        .await;
        let rec = &mgr.list()[0];
        assert_eq!(rec.status, "budget_exceeded", "{out}");
        // 400 tokens a step against a budget of 1000: it stops after 800,
        // before the third step would have gone over (it used to reach 1200).
        assert_eq!(rec.total_tokens(), 800, "{}", rec.total_tokens());
        assert!(
            out.contains("budget exceeded") && out.contains("token budget"),
            "{out}"
        );
        assert!(out.contains("partial"), "partial text is the report: {out}");
        assert!(!app.named("subagent.usage").is_empty());
        assert_eq!(app.named("subagent.cancelled").len(), 1);
    }

    #[tokio::test]
    async fn stop_cancels_and_parent_cancel_stops_waiting_children() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("sleep:5000"), &env).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (out, err) = run_tool(&mgr, TOOL_STOP, json!({"id": rec.id}), &env).await;
        assert!(!err && out.contains("Stopped"), "{out}");
        assert_eq!(mgr.get(&rec.id).unwrap().status, "cancelled");
        assert!(
            !script.load_messages(&rec.session_key).is_empty(),
            "partial transcript saved"
        );

        // Parent cancelled while waiting -> child stopped.
        let parent_abort = Arc::new(Mutex::new(false));
        let env2 = ParentEnv {
            task_context: None,
            abort: Some(parent_abort.clone()),
            ..env.clone()
        };
        let m2 = mgr.clone();
        let waiter = tokio::spawn(async move {
            m2.handle_tool(0, TOOL_SPAWN, &json!({"task": "sleep:5000"}), env2)
                .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        *parent_abort.lock().await = true;
        let (out, err) = tokio::time::timeout(Duration::from_secs(3), waiter)
            .await
            .unwrap()
            .unwrap();
        assert!(err && out.contains("Cancelled"), "{out}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(mgr.list()[0].status, "cancelled");
        assert_eq!(mgr.running_count(), 0);
    }

    #[tokio::test]
    async fn interrupt_stops_the_step_and_a_message_goes_on() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("sleep:5000"), &env).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let out = mgr
            .handle_app_request(&json!({"action": "interrupt", "id": rec.id}), &env, None)
            .unwrap();
        assert_eq!(out["interrupted"], json!(true), "{out}");
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(3))
            .await;
        let r = mgr.get(&rec.id).unwrap();
        assert_eq!(r.status, "cancelled", "reads as stopped");
        assert!(
            r.error.as_deref().unwrap_or("").starts_with("Interrupted"),
            "{:?}",
            r.error
        );
        assert!(
            !script.load_messages(&rec.session_key).is_empty(),
            "the step so far is kept"
        );
        // Nothing left to interrupt.
        let again = mgr
            .handle_app_request(&json!({"action": "interrupt", "id": rec.id}), &env, None)
            .unwrap();
        assert_eq!(again["interrupted"], json!(false));
        // A message goes on from where it was.
        let m = mgr
            .handle_app_request(
                &json!({"action": "message", "id": rec.id, "message": "go on"}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(m["resumed"], json!(true), "{m}");
    }

    #[tokio::test]
    async fn timeout_stops_the_run() {
        let (mgr, _script, _app, env, _) = setup();
        let started = Instant::now();
        let rec = mgr
            .spawn(
                0,
                SpawnSpec {
                    timeout_seconds: Some(1),
                    ..spec("sleep:10000")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        assert_eq!(mgr.get(&rec.id).unwrap().status, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn step_limit_is_reported() {
        let (mgr, _script, _app, env, _) = setup();
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "turns", "max_steps": 3}),
            &env,
        )
        .await;
        assert_eq!(mgr.list()[0].status, "max_steps", "{out}");
        assert!(out.contains("step limit"));
    }

    #[tokio::test]
    async fn memory_modes_private_read_parent_shared_and_promote() {
        let (mgr, _script, _app, env, _) = setup();
        let main = Arc::new(MainMemory::default());
        main.store("city".into(), "Rajshahi".into(), None);
        let env = ParentEnv {
            task_context: None,
            memory: Some(main.clone()),
            ..env
        };

        // private: writes go to its own store, main memory untouched, can't read main
        run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "remember:lang=Rust", "name": "dev", "memory": "private"}),
            &env,
        )
        .await;
        assert_eq!(main.0.lock().unwrap().len(), 1);
        assert_eq!(mgr.memory_entries("dev")[0].text, "Rust");
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "recall:Rajshahi", "name": "dev", "memory": "private"}),
            &env,
        )
        .await;
        assert!(!out.contains("\"source\":\"main\""), "{out}");
        // same name -> same store across runs
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "recall:Rust", "name": "dev"}),
            &env,
        )
        .await;
        assert!(out.contains("Rust"), "{out}");
        // another name -> isolated
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "recall:Rust", "name": "other"}),
            &env,
        )
        .await;
        assert!(out.contains("Report:\n[]"), "{out}");

        // read_parent: sees main memory, writes stay private
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "recall:Rajshahi", "name": "dev", "memory": "read_parent"}),
            &env,
        )
        .await;
        assert!(
            out.contains("Rajshahi") && out.contains("\"source\":\"main\""),
            "{out}"
        );
        run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "remember:x=1", "name": "dev", "memory": "read_parent"}),
            &env,
        )
        .await;
        assert_eq!(main.0.lock().unwrap().len(), 1);

        // shared: writes land in main memory
        run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "remember:team=core", "name": "dev", "memory": "shared"}),
            &env,
        )
        .await;
        assert!(main.0.lock().unwrap().iter().any(|(k, _)| k == "team"));

        // app: list / promote / delete / clear
        let listed = mgr
            .handle_app_request(
                &json!({"action": "memory", "name": "dev"}),
                &env,
                Some(main.clone()),
            )
            .unwrap();
        assert_eq!(listed["entries"].as_array().unwrap().len(), 2);
        let promoted = mgr
            .handle_app_request(
                &json!({"action": "memory", "name": "dev", "op": "promote", "key": "lang"}),
                &env,
                Some(main.clone()),
            )
            .unwrap();
        assert_eq!(promoted["promoted"], 1);
        assert!(main
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|(k, v)| k == "lang" && v == "Rust"));
        let deleted = mgr
            .handle_app_request(
                &json!({"action": "memory", "name": "dev", "op": "delete", "key": "x"}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(deleted["deleted"], true);
        let cleared = mgr
            .handle_app_request(
                &json!({"action": "memory", "name": "dev", "op": "clear"}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(cleared["cleared"], 1);
        assert!(mgr.memory_entries("dev").is_empty());
        let names = mgr
            .handle_app_request(&json!({"action": "memory"}), &env, None)
            .unwrap();
        assert!(names["names"].as_array().unwrap().contains(&json!("dev")));
    }

    #[tokio::test]
    async fn message_steers_a_running_one_and_resumes_a_finished_one() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("sleep:300"), &env).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": rec.id, "message": "also check tests"}),
            &env,
        )
        .await;
        assert!(!err && out.contains("delivered"), "{out}");
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        assert!(mgr
            .get(&rec.id)
            .unwrap()
            .result
            .unwrap()
            .contains("steer: also check tests"));

        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": rec.id, "message": "summarise"}),
            &env,
        )
        .await;
        assert!(!err && out.contains("done: summarise"), "{out}");
        let r = mgr.get(&rec.id).unwrap();
        assert_eq!(r.runs, 2);
        assert_eq!(
            script.load_messages(&r.session_key).len(),
            4,
            "resumed with prior context"
        );
        // other chats can't message it
        let other = ParentEnv {
            task_context: None,
            session_key: "chat-9".into(),
            ..env.clone()
        };
        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": rec.id, "message": "hi"}),
            &other,
        )
        .await;
        assert!(err && out.contains("No sub-agent of yours"));
    }

    #[tokio::test]
    async fn sub_agent_leftover_steer_becomes_a_follow_up() {
        let (mgr, _script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("hold:150"), &env).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let routed = mgr.route_steer(&env.session_key, &rec.id, "and add a summary line");
        assert_eq!(routed.as_deref(), Ok(rec.id.as_str()));
        for _ in 0..200 {
            let r = mgr.get(&rec.id).unwrap();
            if r.runs >= 2 && r.status == "finished" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let r = mgr.get(&rec.id).unwrap();
        assert_eq!(r.runs, 2, "the leftover steer started the next run");
        assert!(r.result.unwrap_or_default().contains("and add a summary line"));
        assert!(mgr.route_steer(&env.session_key, "nobody", "x").is_err());
    }

    #[tokio::test]
    async fn app_actions_spawn_list_retry_delete_and_settings() {
        let (mgr, script, _app, env, dir) = setup();
        let out = mgr.handle_app_request(&json!({"action": "spawn", "task": "sleep:20", "name": "ui", "tokenBudget": 5000, "maxSteps": 4}), &env, None).unwrap();
        let id = out["subagent"]["id"].as_str().unwrap().to_string();
        assert_eq!(out["subagent"]["tokenBudget"], 5000);
        assert_eq!(out["subagent"]["maxSteps"], 4);
        let err = mgr
            .handle_app_request(&json!({"action": "delete", "id": id}), &env, None)
            .unwrap_err();
        assert!(err.contains("still running"));
        mgr.wait_for(std::slice::from_ref(&id), None, Duration::from_secs(5))
            .await;
        let listed = mgr
            .handle_app_request(&json!({"action": "list", "status": "finished"}), &env, None)
            .unwrap();
        assert_eq!(listed["subagents"].as_array().unwrap().len(), 1);
        let detail = mgr
            .handle_app_request(&json!({"action": "get", "id": id}), &env, None)
            .unwrap();
        assert_eq!(detail["transcript"].as_array().unwrap().len(), 2);
        let retried = mgr
            .handle_app_request(&json!({"action": "retry", "id": id}), &env, None)
            .unwrap();
        assert_eq!(retried["subagent"]["runs"], 2);
        mgr.wait_for(std::slice::from_ref(&id), None, Duration::from_secs(5))
            .await;
        assert_eq!(
            script.load_messages(&format!("subagent:{id}")).len(),
            2,
            "retry starts clean"
        );
        mgr.handle_app_request(&json!({"action": "delete", "id": id}), &env, None)
            .unwrap();
        assert!(mgr.get(&id).is_none());
        assert!(script.load_messages(&format!("subagent:{id}")).is_empty());

        let s = mgr.handle_app_request(&json!({"action": "settings", "settings": {"maxParallel": 5, "defaultTokenBudget": 50000}}), &env, None).unwrap();
        assert_eq!(s["settings"]["maxParallel"], 5);
        let reloaded = SubagentManager::new(dir, Arc::new(script.clone()));
        assert_eq!(reloaded.settings().default_token_budget, 50000);
        assert!(mgr
            .handle_app_request(&json!({"action": "nope"}), &env, None)
            .is_err());
        let stop_all = mgr
            .handle_app_request(&json!({"action": "stop", "all": true}), &env, None)
            .unwrap();
        assert_eq!(stop_all["stopped"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn runs_cut_off_by_an_app_restart_are_marked() {
        let (mgr, script, _app, env, dir) = setup();
        let rec = mgr.spawn(0, spec("sleep:2000"), &env).unwrap();
        let reloaded = SubagentManager::new(dir, Arc::new(script.clone()));
        let r = reloaded.get(&rec.id).unwrap();
        assert_eq!(r.status, "error");
        assert!(r.error.unwrap().contains("app closed"));
        mgr.stop(&rec.id, "cancelled");
    }

    #[tokio::test]
    async fn queue_priority_fairness_cancel_and_full() {
        let (mgr, script, app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 1, "maxQueue": 3}));
        let a = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("a".into()),
                    ..spec("sleep:250")
                },
                &env,
            )
            .unwrap();
        assert_eq!(a.status, "running");
        let other = ParentEnv {
            task_context: None,
            session_key: "chat-2".into(),
            ..env.clone()
        };
        let b1 = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("b1".into()),
                    ..spec("sleep:30")
                },
                &env,
            )
            .unwrap();
        let b2 = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("b2".into()),
                    ..spec("sleep:30")
                },
                &env,
            )
            .unwrap();
        let c1 = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("c1".into()),
                    ..spec("sleep:30")
                },
                &other,
            )
            .unwrap();
        assert_eq!(
            (b1.status.as_str(), b2.status.as_str(), c1.status.as_str()),
            ("queued", "queued", "queued")
        );
        // Round-robin across chats: b1, c1, b2.
        let pos = |id: &str| mgr.get(id).unwrap().queue_position;
        assert_eq!(
            (pos(&b1.id), pos(&c1.id), pos(&b2.id)),
            (Some(1), Some(2), Some(3))
        );
        // Queue full.
        let full = mgr.spawn(0, spec("sleep:1"), &env).unwrap_err();
        assert!(full.contains("queue is full"), "{full}");
        assert_eq!(mgr.list().len(), 4, "a refused spawn leaves no record");
        // Priority jumps the line.
        mgr.handle_app_request(
            &json!({"action": "priority", "id": b2.id, "priority": 5}),
            &env,
            None,
        )
        .unwrap();
        assert_eq!(pos(&b2.id), Some(1));
        let q = mgr
            .handle_app_request(&json!({"action": "queue"}), &env, None)
            .unwrap();
        assert_eq!(q["queue"][0]["id"], json!(b2.id));
        assert!(q["locks"]["held"].is_array());
        // Cancel while queued: positions close up, events say so.
        assert!(mgr.stop(&c1.id, "cancelled"));
        let c = mgr.get(&c1.id).unwrap();
        assert_eq!(c.status, "cancelled");
        assert!(c.queue_position.is_none());
        assert!(app
            .named("subagent.cancelled")
            .iter()
            .any(|e| e["whileQueued"] == json!(true)));
        assert_eq!(pos(&b1.id), Some(2));
        assert!(!app.named("subagent.queued").is_empty());
        // A message to a queued one is delivered when it starts.
        let (_, resumed) = mgr.message(&b1.id, "hello-queued", &env).unwrap();
        assert!(!resumed);
        let end = mgr
            .wait_for(
                &[a.id.clone(), b1.id.clone(), b2.id.clone()],
                None,
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(end, WaitEnd::Done);
        assert_eq!(
            script.max_concurrent.load(Ordering::SeqCst),
            1,
            "never more than maxParallel"
        );
        assert!(mgr
            .get(&b1.id)
            .unwrap()
            .result
            .unwrap()
            .contains("steer: hello-queued"));
        // Order of starts: a, b2 (priority), b1.
        let order: Vec<String> = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.0.clone())
            .collect();
        assert_eq!(order.len(), 3, "the cancelled one never ran: {order:?}");
        assert_eq!(mgr.queued_count(), 0);
    }

    #[tokio::test]
    async fn raising_the_limit_starts_queued_runs_and_stop_all_includes_queue() {
        let (mgr, _script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 1}));
        let a = mgr.spawn(0, spec("sleep:3000"), &env).unwrap();
        let b = mgr.spawn(0, spec("sleep:3000"), &env).unwrap();
        assert_eq!(mgr.get(&b.id).unwrap().status, "queued");
        mgr.set_settings(&json!({"maxParallel": 2}));
        assert_eq!(mgr.get(&b.id).unwrap().status, "running");
        let c = mgr.spawn(0, spec("sleep:3000"), &env).unwrap();
        assert_eq!(c.status, "queued");
        let stopped = mgr
            .handle_app_request(&json!({"action": "stop", "all": true}), &env, None)
            .unwrap();
        assert_eq!(stopped["stopped"].as_array().unwrap().len(), 3);
        mgr.wait_for(
            &[a.id.clone(), b.id.clone(), c.id.clone()],
            None,
            Duration::from_secs(3),
        )
        .await;
        assert_eq!(
            mgr.get(&c.id).unwrap().status,
            "cancelled",
            "stopping running ones must not start the queued one"
        );
        assert_eq!(mgr.running_count(), 0);
    }

    #[tokio::test]
    async fn parent_cancel_while_waiting_on_a_queued_child_removes_it() {
        let (mgr, _s, _a, mut env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 1}));
        let _blocker = mgr.spawn(0, spec("sleep:3000"), &env).unwrap();
        let abort = Arc::new(Mutex::new(false));
        env.abort = Some(abort.clone());
        let m2 = mgr.clone();
        let env2 = env.clone();
        let h = tokio::spawn(async move {
            m2.handle_tool(
                0,
                TOOL_SPAWN,
                &json!({"task": "sleep:10", "name": "late"}),
                env2,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(60)).await;
        let late = mgr.list().into_iter().find(|r| r.name == "late").unwrap();
        assert_eq!(late.status, "queued");
        *abort.lock().await = true;
        let (out, err) = h.await.unwrap();
        assert!(err && out.contains("Cancelled"), "{out}");
        assert_eq!(mgr.get(&late.id).unwrap().status, "cancelled");
        mgr.stop_where(|_| true);
    }

    /// An edit or a retry rewinds the sub-agent's turn memory like the main
    /// chat's rewind: only turns kept whole stay, and an edit of a message that
    /// joined an open turn (a parent's follow-up while it worked) drops that
    /// turn too.
    #[tokio::test]
    async fn edit_and_retry_forget_the_turns_they_replace() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        // Turn 2 of its chat: a task, a tool round, a follow-up that arrived
        // while it worked, the answer.
        let mut msgs = script.load_messages(&rec.session_key);
        msgs.extend([
            Message::user("second"),
            Message::assistant_blocks(vec![crate::types::ContentBlock::ToolUse {
                id: "c1".into(),
                name: "read_file".into(),
                input: json!({}),
                provider_metadata: None,
            }]),
            Message {
                role: Role::User,
                content: MessageContent::Blocks(vec![crate::types::ContentBlock::ToolResult {
                    tool_use_id: "c1".into(),
                    content: "ok".into(),
                    is_error: false,
                }]),
            },
            Message::user("follow-up while working"),
            Message::assistant_text("done: second"),
        ]);
        script
            .saved
            .lock()
            .unwrap()
            .insert(rec.session_key.clone(), msgs.clone());
        assert_eq!(crate::turn_memory::split_turns(&msgs).len(), 2);
        // Retry the last message (the follow-up, user message 3): it is inside
        // turn 2, so only turn 1 is kept whole.
        mgr.regenerate(&rec.id, None, None, &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert_eq!(
            script.forgotten.lock().unwrap().last().cloned(),
            Some((rec.session_key.clone(), 1))
        );
        // Edit the first message: nothing is kept.
        mgr.regenerate(&rec.id, Some(0), Some("first-edited"), &env)
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert_eq!(
            script.forgotten.lock().unwrap().last().cloned(),
            Some((rec.session_key.clone(), 0))
        );
    }

    #[tokio::test]
    async fn regenerate_edit_and_fork() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        mgr.message(&rec.id, "second", &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert_eq!(script.load_messages(&rec.session_key).len(), 4);
        // Regenerate: the last reply is replaced, the history doesn't grow.
        let r = mgr
            .handle_app_request(&json!({"action": "regenerate", "id": rec.id}), &env, None)
            .unwrap();
        assert_eq!(r["subagent"]["status"], json!("running"));
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        let msgs = script.load_messages(&rec.session_key);
        assert_eq!(msgs.len(), 4, "regenerate replaces, not appends");
        assert!(matches!(&msgs[3].content, MessageContent::Text(t) if t == "done: second"));
        // Edit the first message: everything after it is dropped.
        mgr.handle_app_request(
            &json!({"action": "edit", "id": rec.id, "turn": 0, "message": "first-edited"}),
            &env,
            None,
        )
        .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        let msgs = script.load_messages(&rec.session_key);
        assert_eq!(msgs.len(), 2);
        assert_eq!(mgr.get(&rec.id).unwrap().task, "first-edited");
        assert_eq!(
            mgr.get(&rec.id).unwrap().result.as_deref(),
            Some("done: first-edited")
        );
        // Bad turn and empty edit are refused, nothing changes.
        assert!(mgr
            .handle_app_request(
                &json!({"action": "edit", "id": rec.id, "turn": 9, "message": "x"}),
                &env,
                None
            )
            .is_err());
        assert!(mgr
            .handle_app_request(
                &json!({"action": "edit", "id": rec.id, "message": "  "}),
                &env,
                None
            )
            .is_err());
        assert_eq!(mgr.get(&rec.id).unwrap().status, "finished");
        // Can't regenerate while running.
        let busy = mgr.spawn(0, spec("sleep:2000"), &env).unwrap();
        assert!(mgr.regenerate(&busy.id, None, None, &env).is_err());
        mgr.stop(&busy.id, "cancelled");
        // Fork: a new record with the same settings and an edited task.
        let f = mgr
            .handle_app_request(
                &json!({"action": "fork", "id": rec.id, "task": "other task"}),
                &env,
                None,
            )
            .unwrap();
        let fid = f["subagent"]["id"].as_str().unwrap().to_string();
        assert_ne!(fid, rec.id);
        mgr.wait_for(std::slice::from_ref(&fid), None, Duration::from_secs(2))
            .await;
        let fr = mgr.get(&fid).unwrap();
        assert_eq!(fr.forked_from.as_deref(), Some(rec.id.as_str()));
        assert_eq!(fr.tools, mgr.get(&rec.id).unwrap().tools);
        assert_eq!(script.load_messages(&fr.session_key).len(), 2);
        // Fork keeping history continues the old conversation.
        let k = mgr
            .handle_app_request(
                &json!({"action": "fork", "id": rec.id, "task": "follow-up", "keepHistory": true}),
                &env,
                None,
            )
            .unwrap();
        let kid = k["subagent"]["id"].as_str().unwrap().to_string();
        mgr.wait_for(std::slice::from_ref(&kid), None, Duration::from_secs(2))
            .await;
        let km = script.load_messages(&mgr.get(&kid).unwrap().session_key);
        assert_eq!(km.len(), 4);
        // The source is untouched.
        assert_eq!(script.load_messages(&rec.session_key).len(), 2);
    }

    #[tokio::test]
    async fn restart_marks_queued_runs() {
        let (mgr, _s, _a, env, dir) = setup();
        mgr.set_settings(&json!({"maxParallel": 1}));
        let _a1 = mgr.spawn(0, spec("sleep:3000"), &env).unwrap();
        let q = mgr.spawn(0, spec("sleep:10"), &env).unwrap();
        mgr.persist();
        let script2 = Arc::new(Script::default());
        let again = SubagentManager::new(dir, Arc::new(script2));
        let r = again.get(&q.id).unwrap();
        assert_eq!(r.status, "error");
        assert!(r.error.unwrap().contains("queue"));
        mgr.stop_where(|_| true);
    }

    fn seed_chat(script: &Script, key: &str, texts: &[&str]) {
        let mut msgs = Vec::new();
        for (i, t) in texts.iter().enumerate() {
            msgs.push(if i % 2 == 0 {
                Message::user(t)
            } else {
                Message {
                    role: Role::Assistant,
                    content: MessageContent::Text(t.to_string()),
                }
            });
        }
        script.saved.lock().unwrap().insert(key.into(), msgs);
    }

    #[tokio::test]
    async fn ask_session_returns_only_the_reply_and_keeps_histories_apart() {
        let (mgr, script, app, env, _) = setup();
        seed_chat(
            &script,
            "chat-plan",
            &[
                "Plan the trip SECRET-PLAN-123",
                "Day 1: Sylhet",
                "and day 2?",
                "Day 2: Srimangal",
            ],
        );
        seed_chat(&script, "chat-1", &["hi"]);
        seed_chat(&script, "subagent:sa_x", &["hidden"]);
        mgr.set_session_titles(&json!({"chat-plan": "Trip plan", "chat-1": "Main"}));
        // list_sessions: titles, no contents, not itself, no sub-agent sessions.
        let (list, err) = mgr
            .handle_session_tool(TOOL_LIST_SESSIONS, &json!({}), env.clone())
            .await;
        assert!(!err);
        assert!(list.contains("Trip plan") && list.contains("chat-plan"));
        assert!(
            !list.contains("SECRET-PLAN")
                && !list.contains("subagent:")
                && !list.contains("\"chat-1\""),
            "{list}"
        );
        let before_caller = script.load_messages("chat-1");
        let (out, err) = mgr
            .handle_session_tool(
                TOOL_ASK_SESSION,
                &json!({"session_key": "chat-plan", "message": "whatdoyouknow"}),
                env.clone(),
            )
            .await;
        assert!(!err, "{out}");
        // The target answered from its own 4 messages ...
        assert!(out.contains("I have 4 earlier messages"), "{out}");
        // ... and only that reply came back, never its history.
        assert!(
            !out.contains("Sylhet") && !out.contains("Srimangal"),
            "{out}"
        );
        // The turn is saved in the target, with a visible note; the caller is untouched.
        let target = script.load_messages("chat-plan");
        assert_eq!(target.len(), 6);
        assert!(
            matches!(&target[4].content, MessageContent::Text(t) if t.contains("Message from your other chat \"Main\"") && t.contains("whatdoyouknow"))
        );
        assert_eq!(script.load_messages("chat-1").len(), before_caller.len());
        // The target run got no session / sub-agent / ui tools.
        let req = script.requests.lock().unwrap().last().cloned().unwrap();
        let tools = req.1.unwrap();
        assert!(
            !tools.contains("ask_session")
                && !tools.contains("spawn_subagent")
                && !tools.contains("ui__"),
            "{tools}"
        );
        // Events for both chats, and an audit record without history.
        let asked = app.named("session.asked");
        let answered = app.named("session.answered");
        assert_eq!(asked.len(), 1);
        assert_eq!(answered[0]["status"], json!("answered"));
        assert_eq!(answered[0]["targetTitle"], json!("Trip plan"));
        let hist = mgr
            .handle_app_request(
                &json!({"action": "asks", "sessionKey": "chat-plan"}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(hist["asks"].as_array().unwrap().len(), 1);
        assert!(!hist.to_string().contains("Sylhet"));
    }

    #[tokio::test]
    async fn ask_session_refuses_bad_targets_loops_and_long_messages() {
        let (mgr, script, _app, env, _) = setup();
        seed_chat(&script, "chat-a", &["a"]);
        seed_chat(&script, "subagent:sa_1", &["x"]);
        let ask = |t: &str, m: &str| {
            let mgr = mgr.clone();
            let env = env.clone();
            let (t, m) = (t.to_string(), m.to_string());
            async move { mgr.ask_session(&t, &m, None, &env, "agent").await }
        };
        assert!(ask("chat-1", "hi").await.unwrap_err().contains("this chat"));
        assert!(ask("nope", "hi")
            .await
            .unwrap_err()
            .contains("No saved chat"));
        assert!(ask("subagent:sa_1", "hi")
            .await
            .unwrap_err()
            .contains("No saved chat"));
        assert!(ask("chat-a", "   ").await.unwrap_err().contains("empty"));
        assert!(ask("chat-a", &"x".repeat(8001))
            .await
            .unwrap_err()
            .contains("too long"));
        // One ask per target at a time.
        let slow = tokio::spawn(ask("chat-a", "sleep:300"));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(ask("chat-a", "hi")
            .await
            .unwrap_err()
            .contains("already answering"));
        // A chat that is being asked can't ask a third chat (no chains).
        let env_a = ParentEnv {
            task_context: None,
            session_key: "chat-a".into(),
            ..env.clone()
        };
        seed_chat(&script, "chat-b", &["b"]);
        assert!(mgr
            .ask_session("chat-b", "hi", None, &env_a, "agent")
            .await
            .unwrap_err()
            .contains("answering another chat"));
        assert!(slow.await.unwrap().is_ok());
        // Turned off in settings.
        mgr.set_settings(&json!({"sessionsEnabled": false}));
        assert!(ask("chat-a", "hi")
            .await
            .unwrap_err()
            .contains("turned off"));
    }

    #[tokio::test]
    async fn ask_session_budget_timeout_cancel_and_reply_limit() {
        let (mgr, script, app, mut env, _) = setup();
        seed_chat(&script, "chat-a", &["a"]);
        mgr.set_settings(&json!({"sessionTokenBudget": 1000, "sessionReplyMaxChars": 200}));
        let e = mgr
            .ask_session("chat-a", "usage:400", None, &env, "agent")
            .await
            .unwrap_err();
        assert!(e.contains("token budget"), "{e}");
        assert_eq!(
            app.named("session.answered").last().unwrap()["status"],
            json!("error")
        );
        // Reply capped.
        let long = format!("{}", "y".repeat(900));
        let (_, r, _) = mgr
            .ask_session("chat-a", &long, None, &env, "agent")
            .await
            .unwrap();
        assert!(
            r.chars().count() <= 215 && r.ends_with("[truncated]"),
            "{}",
            r.len()
        );
        // The caller's Stop cancels it.
        let abort = Arc::new(Mutex::new(false));
        env.abort = Some(abort.clone());
        let m2 = mgr.clone();
        let e2 = env.clone();
        let h = tokio::spawn(async move {
            m2.ask_session("chat-a", "sleep:3000", None, &e2, "agent")
                .await
        });
        tokio::time::sleep(Duration::from_millis(60)).await;
        *abort.lock().await = true;
        let err = h.await.unwrap().unwrap_err();
        assert!(err.contains("cancelled"), "{err}");
        // The user can ask from the app and cancel it there.
        let m3 = mgr.clone();
        let e3 = ParentEnv {
            task_context: None,
            abort: None,
            ..env.clone()
        };
        let h = tokio::spawn(async move {
            m3.user_ask(
                &json!({"targetSessionKey": "chat-a", "message": "sleep:3000"}),
                e3,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(60)).await;
        let c = mgr
            .handle_app_request(
                &json!({"action": "cancelAsk", "targetSessionKey": "chat-a"}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(c["cancelled"], json!(true));
        assert!(h.await.unwrap().is_err());
        let ok = mgr
            .user_ask(
                &json!({"targetSessionKey": "chat-a", "message": "whatdoyouknow"}),
                ParentEnv {
                    task_context: None,
                    abort: None,
                    ..env.clone()
                },
            )
            .await
            .unwrap();
        assert!(ok["reply"].as_str().unwrap().contains("earlier messages"));
        assert!(app
            .named("session.asked")
            .iter()
            .any(|e| e["origin"] == json!("user")));
        // Titles persist and are bounded.
        assert_eq!(
            mgr.set_session_titles(&json!({"chat-a": "  A  ", "x": ""})),
            1
        );
        assert_eq!(mgr.list_chats(None)[0].title, "A");
    }

    const SUBAGENT_TOOL_TOKEN_CAP: usize = 2_200;

    #[test]
    fn tool_definitions_and_prompt_are_well_formed() {
        let defs = SubagentManager::tool_definitions();
        assert_eq!(
            defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            TOOL_NAMES.to_vec()
        );
        assert_eq!(defs[0].input_schema["required"], json!(["task"]));
        for d in &defs {
            assert!(d.description.len() > 60);
            assert_eq!(d.input_schema["type"], "object");
        }
        assert_eq!(
            MemoryMode::parse("read-parent"),
            Some(MemoryMode::ReadParent)
        );
        assert_eq!(sanitize_name("  Test Fixer!! 2 "), "test-fixer-2");
    }

    /// The sub-agent tools ride on every main-chat request, so their schemas
    /// are a standing cost against the transcript budget. Swarm options are
    /// described tersely here; the details live in the sub-agent's prompt and
    /// in the swarm tools a sub-agent only gets when its topology needs them.
    #[test]
    fn subagent_tool_schemas_stay_compact() {
        let meter = crate::tokens::TokenMeter::for_model("openrouter", "openrouter/free");
        let cost = meter.tools(&SubagentManager::tool_definitions());
        eprintln!("subagent tool schema tokens: {cost}");
        assert!(
            cost <= SUBAGENT_TOOL_TOKEN_CAP,
            "sub-agent tool schemas cost {cost} tokens (cap {SUBAGENT_TOOL_TOKEN_CAP})"
        );
    }

    // ── S0: separate deletion and reuse across turns ─────────────────────

    fn ws_setup(mgr: &Arc<SubagentManager>) -> PathBuf {
        let ws = std::env::temp_dir().join(format!("subagents-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws).unwrap();
        mgr.set_workspace(ws.to_str().unwrap());
        ws
    }

    /// Two finished sub-agents ("a" and "b"), each with memory, a log, a
    /// transcript and a file it created; plus a main-chat transcript and a
    /// main-memory entry that nothing may touch.
    async fn two_with_data() -> (
        Arc<SubagentManager>,
        Arc<Script>,
        Arc<AppEvents>,
        ParentEnv,
        PathBuf,
        String,
        String,
    ) {
        let (mgr, script, app, env, _) = setup();
        let ws = ws_setup(&mgr);
        script
            .saved
            .lock()
            .unwrap()
            .insert("chat-1".into(), vec![Message::user("main chat")]);
        env.memory
            .as_ref()
            .unwrap()
            .store("main-key".into(), "main".into(), None);
        std::fs::write(ws.join("existing.txt"), "user's").unwrap();
        let a = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("a".into()),
                    ..spec("remember:ka=va")
                },
                &env,
            )
            .unwrap();
        let b = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("b".into()),
                    ..spec("remember:kb=vb")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(&[a.id.clone(), b.id.clone()], None, Duration::from_secs(5))
            .await;
        for (id, file) in [(&a.id, "a-new.txt"), (&b.id, "b-new.txt")] {
            mgr.track_tool_use(id, "write_file", &json!({"path": file}));
            std::fs::write(ws.join(file), "x").unwrap();
        }
        mgr.track_tool_use(&a.id, "edit_file", &json!({"path": "existing.txt"}));
        mgr.track_tool_use(&a.id, "read_file", &json!({"path": "ignored.txt"}));
        mgr.track_tool_use(&a.id, "write_file", &json!({"path": "../escape.txt"}));
        (mgr, script, app, env, ws, a.id, b.id)
    }

    fn assert_b_untouched(
        mgr: &Arc<SubagentManager>,
        script: &Arc<Script>,
        env: &ParentEnv,
        ws: &Path,
        b: &str,
    ) {
        let rb = mgr.get(b).expect("b record kept");
        assert_eq!(
            script.load_messages(&rb.session_key).len(),
            2,
            "b transcript kept"
        );
        assert_eq!(mgr.memory_entries("b").len(), 1, "b memory kept");
        assert!(!mgr.read_log(b, 100).is_empty(), "b log kept");
        assert!(ws.join("b-new.txt").exists(), "b file kept");
        assert_eq!(script.load_messages("chat-1").len(), 1, "main chat kept");
        assert!(
            env.memory
                .as_ref()
                .unwrap()
                .recall("main".into(), 5)
                .contains("main-key"),
            "main memory kept"
        );
        assert!(ws.join("existing.txt").exists(), "user's own file kept");
    }

    #[tokio::test]
    async fn file_tracking_marks_only_files_it_created() {
        let (mgr, _s, _app, _env, _ws, a, _b) = two_with_data().await;
        let files = mgr.get(&a).unwrap().files;
        let created: Vec<_> = files
            .iter()
            .filter(|f| f.created)
            .map(|f| f.path.as_str())
            .collect();
        let edited: Vec<_> = files
            .iter()
            .filter(|f| !f.created)
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(created, vec!["a-new.txt"]);
        assert_eq!(
            edited,
            vec!["existing.txt", "../escape.txt"],
            "pre-existing and outside-workspace are never ours"
        );
        // a second write to the same path is not added twice and keeps `created`
        mgr.track_tool_use(&a, "write_file", &json!({"path": "a-new.txt"}));
        assert_eq!(mgr.get(&a).unwrap().files.len(), 3);
    }

    #[tokio::test]
    async fn delete_dry_run_lists_everything_and_deletes_nothing() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr
            .delete_data_request(&json!({"id": a, "parts": ["all"], "dryRun": true}))
            .unwrap();
        let items = out["plan"][0]["items"].as_array().unwrap();
        let parts: Vec<&str> = items.iter().map(|i| i["part"].as_str().unwrap()).collect();
        assert_eq!(parts, vec!["chat", "memory", "files", "logs", "record"]);
        assert_eq!(items[0]["messages"], 2);
        assert_eq!(items[1]["entries"], 1);
        assert_eq!(items[2]["files"], json!(["a-new.txt"]));
        assert!(
            out["plan"][0]["warnings"]
                .to_string()
                .contains("existed before"),
            "{out}"
        );
        assert!(
            mgr.get(&a).is_some()
                && ws.join("a-new.txt").exists()
                && mgr.memory_entries("a").len() == 1
        );
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_chat_only() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let ra = mgr.get(&a).unwrap();
        mgr.delete_data_request(&json!({"id": a, "parts": ["chat"]}))
            .unwrap();
        let after = mgr.get(&a).expect("record kept");
        assert!(
            script.load_messages(&ra.session_key).is_empty()
                && after.result.is_none()
                && after.chat_deleted
        );
        assert_eq!(mgr.memory_entries("a").len(), 1, "memory kept");
        assert!(
            ws.join("a-new.txt").exists() && !mgr.read_log(&a, 100).is_empty(),
            "files and log kept"
        );
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_memory_only() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr
            .delete_data_request(&json!({"id": a, "parts": "memory"}))
            .unwrap();
        assert_eq!(out["deleted"][0]["memory"], 1);
        assert!(mgr.memory_entries("a").is_empty());
        let ra = mgr.get(&a).unwrap();
        assert_eq!(script.load_messages(&ra.session_key).len(), 2, "chat kept");
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_shared_memory_never_touches_main_memory() {
        let (mgr, script, _app, env, ws, _a, b) = two_with_data().await;
        let s = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("sh".into()),
                    memory: Some("shared".into()),
                    ..spec("remember:ks=vs")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&s.id), None, Duration::from_secs(5))
            .await;
        let plan = mgr
            .delete_data_request(&json!({"id": s.id, "parts": ["memory"], "dryRun": true}))
            .unwrap();
        assert_eq!(plan["plan"][0]["items"][0]["skipped"], true);
        mgr.delete_data_request(&json!({"id": s.id, "parts": ["memory"]}))
            .unwrap();
        assert!(
            env.memory
                .as_ref()
                .unwrap()
                .recall("vs".into(), 5)
                .contains("ks"),
            "shared entries live in the main memory: kept"
        );
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_files_only_removes_files_it_created() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr
            .delete_data_request(&json!({"id": a, "parts": ["files"]}))
            .unwrap();
        assert_eq!(out["deleted"][0]["files"], json!(["a-new.txt"]));
        assert!(!ws.join("a-new.txt").exists());
        assert!(
            mgr.get(&a).unwrap().files.iter().all(|f| !f.created),
            "untracked once deleted"
        );
        assert_eq!(mgr.memory_entries("a").len(), 1);
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_files_without_workspace_reports_and_keeps() {
        let (mgr, _s, _app, env, _) = setup();
        let a = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("a".into()),
                    ..spec("x")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&a.id), None, Duration::from_secs(5))
            .await;
        // no workspace: nothing is marked created (unknown = not ours)
        mgr.track_tool_use(&a.id, "write_file", &json!({"path": "n.txt"}));
        assert!(!mgr.get(&a.id).unwrap().files[0].created);
        let out = mgr
            .delete_data_request(&json!({"id": a.id, "parts": ["files"]}))
            .unwrap();
        assert_eq!(out["deleted"][0]["files"], json!([]));
    }

    #[tokio::test]
    async fn delete_logs_only() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        assert!(mgr
            .read_log(&a, 100)
            .iter()
            .any(|l| l["event"] == "subagent.finished"));
        mgr.delete_data_request(&json!({"id": a, "parts": ["logs"]}))
            .unwrap();
        assert!(mgr.read_log(&a, 100).is_empty());
        assert_eq!(mgr.memory_entries("a").len(), 1);
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_everything_removes_the_record_and_survives_restart() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr
            .delete_data_request(&json!({"id": a, "parts": ["everything"]}))
            .unwrap();
        assert_eq!(out["deleted"][0]["record"], true);
        assert!(
            mgr.get(&a).is_none()
                && !ws.join("a-new.txt").exists()
                && mgr.memory_entries("a").is_empty()
        );
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
        let reloaded = SubagentManager::new(mgr.state_dir.clone(), Arc::new(script.clone()));
        assert!(reloaded.get(&a).is_none() && reloaded.get(&b).is_some());
    }

    #[tokio::test]
    async fn delete_validates_input() {
        let (mgr, _s, _app, _env, _ws, a, _b) = two_with_data().await;
        assert!(mgr
            .delete_data_request(&json!({"id": a, "parts": []}))
            .unwrap_err()
            .contains("Choose"));
        assert!(mgr
            .delete_data_request(&json!({"id": a, "parts": ["secrets"]}))
            .unwrap_err()
            .contains("Unknown data part"));
        assert!(mgr
            .delete_data_request(&json!({"id": "nope", "parts": ["chat"]}))
            .unwrap_err()
            .contains("No sub-agent"));
        assert!(mgr
            .delete_data_request(&json!({"parts": ["chat"]}))
            .unwrap_err()
            .contains("Nothing selected"));
        assert!(mgr
            .delete_data_request(&json!({"scope": "weird", "parts": ["chat"]}))
            .unwrap_err()
            .contains("Unknown scope"));
        assert!(mgr.get(&a).is_some());
    }

    #[tokio::test]
    async fn delete_while_running_stops_first_then_deletes() {
        let (mgr, script, app, env, ws, _a, b) = two_with_data().await;
        let r = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("r".into()),
                    ..spec("sleep:2000")
                },
                &env,
            )
            .unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let plan = mgr
            .delete_data_request(&json!({"id": r.id, "parts": ["all"], "dryRun": true}))
            .unwrap();
        assert!(plan["plan"][0]["warnings"]
            .to_string()
            .contains("stopped first"));
        let out = mgr
            .delete_data_request(&json!({"id": r.id, "parts": ["all"]}))
            .unwrap();
        assert_eq!(out["stopping"], json!([r.id]));
        mgr.wait_for(std::slice::from_ref(&r.id), None, Duration::from_secs(5))
            .await;
        assert!(mgr.get(&r.id).is_none(), "deleted once it stopped");
        assert!(
            script.load_messages(&r.session_key).is_empty(),
            "transcript saved on stop was deleted too"
        );
        assert_eq!(app.named("subagent.deleted").len(), 1);
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_while_queued_takes_it_out_of_the_queue() {
        let (mgr, script, _app, env, ws, _a, b) = two_with_data().await;
        mgr.set_settings(&json!({"maxParallel": 1}));
        let run = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("run".into()),
                    ..spec("sleep:200")
                },
                &env,
            )
            .unwrap();
        let q = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("q".into()),
                    ..spec("never")
                },
                &env,
            )
            .unwrap();
        assert_eq!(mgr.get(&q.id).unwrap().status, "queued");
        mgr.delete_data_request(&json!({"id": q.id, "parts": ["all"]}))
            .unwrap();
        assert!(mgr.get(&q.id).is_none() && mgr.queued_count() == 0);
        mgr.wait_for(std::slice::from_ref(&run.id), None, Duration::from_secs(5))
            .await;
        assert_eq!(
            mgr.get(&run.id).unwrap().status,
            "finished",
            "the running one is untouched"
        );
        assert!(
            !script
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _, _)| p == "never"),
            "the deleted one never ran"
        );
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn bulk_delete_selected_finished_and_all() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let other_chat = ParentEnv {
            task_context: None,
            session_key: "chat-2".into(),
            ..env.clone()
        };
        let o = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("o".into()),
                    ..spec("x")
                },
                &other_chat,
            )
            .unwrap();
        let run = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("run".into()),
                    ..spec("sleep:400")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&o.id), None, Duration::from_secs(5))
            .await;
        // finished in chat-1 only: a and b go, the running one and chat-2's stay
        let out = mgr
            .delete_data_request(
                &json!({"scope": "finished", "parentSessionKey": "chat-1", "parts": ["all"]}),
            )
            .unwrap();
        assert_eq!(out["deleted"].as_array().unwrap().len(), 2);
        assert!(mgr.get(&a).is_none() && mgr.get(&b).is_none());
        assert!(mgr.get(&run.id).is_some() && mgr.get(&o.id).is_some());
        assert_eq!(script.load_messages("chat-1").len(), 1);
        assert!(ws.join("existing.txt").exists());
        // selected
        mgr.delete_data_request(&json!({"scope": "selected", "ids": [o.id], "parts": ["chat"]}))
            .unwrap();
        assert!(mgr.get(&o.id).unwrap().chat_deleted);
        // all (stops the running one first)
        let out = mgr
            .delete_data_request(&json!({"scope": "all", "parts": ["all"]}))
            .unwrap();
        assert_eq!(out["stopping"], json!([run.id]));
        mgr.wait_for(std::slice::from_ref(&run.id), None, Duration::from_secs(5))
            .await;
        assert!(mgr.list().is_empty());
        assert_eq!(
            script.load_messages("chat-1").len(),
            1,
            "main chat survives delete-all"
        );
    }

    #[tokio::test]
    async fn memory_shared_by_name_is_warned_about() {
        let (mgr, _s, _app, env, _ws, a, _b) = two_with_data().await;
        let a2 = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("a".into()),
                    ..spec("x")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&a2.id), None, Duration::from_secs(5))
            .await;
        let plan = mgr
            .delete_data_request(&json!({"id": a, "parts": ["memory"], "dryRun": true}))
            .unwrap();
        assert!(
            plan["plan"][0]["warnings"]
                .to_string()
                .contains("1 other sub-agent run"),
            "{plan}"
        );
        // both selected: no warning
        let plan = mgr
            .delete_data_request(&json!({"ids": [a, a2.id], "parts": ["memory"], "dryRun": true}))
            .unwrap();
        assert!(!plan["plan"][0]["warnings"]
            .to_string()
            .contains("other sub-agent"));
    }

    #[tokio::test]
    async fn reuse_by_name_in_a_later_turn_keeps_history_and_memory() {
        let (mgr, script, _app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "remember:topic=rust", "name": "researcher"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let first = mgr.list()[0].clone();
        // later turn: reuse by name
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "whatdoyouknow", "name": "researcher", "reuse": true}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(
            out.contains("Reusing sub-agent")
                && out.contains("I have 2 earlier messages; the first was 'remember:topic=rust'"),
            "{out}"
        );
        assert_eq!(mgr.list().len(), 1, "no new sub-agent");
        assert_eq!(mgr.get(&first.id).unwrap().runs, 2);
        let (out, _) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": "researcher", "message": "recall:topic"}),
            &env,
        )
        .await;
        assert!(out.contains("rust"), "memory kept: {out}");
        assert_eq!(script.load_messages(&first.session_key).len(), 6);
    }

    #[tokio::test]
    async fn reuse_by_id_after_restart() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("fixer".into()),
                    ..spec("remember:k=v")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        let mgr2 = SubagentManager::new(mgr.state_dir.clone(), Arc::new(script.clone()));
        let (out, err) = run_tool(&mgr2, TOOL_LIST, json!({"name": "fixer"}), &env).await;
        assert!(!err && out.contains(&rec.id), "{out}");
        let (out, err) = run_tool(
            &mgr2,
            TOOL_SPAWN,
            json!({"task": "recall:k", "reuse": rec.id}),
            &env,
        )
        .await;
        assert!(
            !err && out.contains("Reusing") && out.contains("\"v\""),
            "{out}"
        );
        assert_eq!(mgr2.list().len(), 1);
    }

    #[tokio::test]
    async fn reuse_respects_current_tool_rules_and_limits() {
        let (mgr, _s, _app, env, _) = setup();
        let rec = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("w".into()),
                    ..spec("x")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        assert_eq!(rec.tools.len(), 3);
        // the parent lost write_file since (a tool rule set to never)
        let narrower = ParentEnv {
            task_context: None,
            tool_names: vec!["read_file".into(), "spawn_subagent".into()],
            ..env.clone()
        };
        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": "w", "message": "go on"}),
            &narrower,
        )
        .await;
        assert!(!err, "{out}");
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        assert_eq!(
            mgr.get(&rec.id).unwrap().tools,
            vec!["read_file".to_string()]
        );
        // none of its tools left: refused, not widened
        let none = ParentEnv {
            task_context: None,
            tool_names: vec!["list_files".into()],
            ..env.clone()
        };
        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": rec.id, "message": "again"}),
            &none,
        )
        .await;
        assert!(err && out.contains("Spawn a new sub-agent"), "{out}");
        // sub-agents turned off
        mgr.set_settings(&json!({"enabled": false}));
        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": rec.id, "message": "again"}),
            &env,
        )
        .await;
        assert!(err && out.contains("turned off"), "{out}");
        mgr.set_settings(&json!({"enabled": true, "maxParallel": 1}));
        // the parallel limit still applies: a reuse waits in the queue
        let blocker = mgr.spawn(0, spec("sleep:300"), &env).unwrap();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "more", "reuse": "w", "wait": false}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert_eq!(mgr.get(&rec.id).unwrap().status, "queued");
        mgr.wait_for(
            &[blocker.id.clone(), rec.id.clone()],
            None,
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(mgr.get(&rec.id).unwrap().status, "finished");
        // new limits on reuse are clamped
        let (_o, _e) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "x", "reuse": "w", "token_budget": 5, "max_steps": 9999}),
            &env,
        )
        .await;
        let r = mgr.get(&rec.id).unwrap();
        assert_eq!((r.token_budget, r.max_steps), (1_000, 200));
    }

    #[tokio::test]
    async fn reuse_stays_in_its_chat_unless_allowed() {
        let (mgr, _s, _app, env, _) = setup();
        let rec = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("mine".into()),
                    ..spec("x")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        let other = ParentEnv {
            task_context: None,
            session_key: "chat-2".into(),
            ..env.clone()
        };
        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": rec.id, "message": "hi"}),
            &other,
        )
        .await;
        assert!(err && out.contains("No sub-agent of yours"), "{out}");
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "x", "name": "mine", "reuse": true}),
            &other,
        )
        .await;
        assert!(out.contains("No earlier sub-agent matched"), "{out}");
        assert_eq!(mgr.list().len(), 2);
        let (out, _) = run_tool(&mgr, TOOL_LIST, json!({"scope": "all"}), &other).await;
        assert!(
            !out.contains(&rec.id) && out.contains("hidden") == false || !out.contains(&rec.id),
            "{out}"
        );
        mgr.set_settings(&json!({"reuseAcrossChats": true}));
        let (out, _) = run_tool(&mgr, TOOL_LIST, json!({"scope": "all"}), &other).await;
        assert!(out.contains(&rec.id) && out.contains("chat-1"), "{out}");
        let (out, err) = run_tool(
            &mgr,
            TOOL_MESSAGE,
            json!({"id": rec.id, "message": "hi"}),
            &other,
        )
        .await;
        assert!(!err, "{out}");
    }

    #[tokio::test]
    async fn list_filters_name_status_recent_query() {
        let (mgr, _s, _app, env, _) = setup();
        let mut ids = vec![];
        for (n, t) in [
            ("alpha", "search docs"),
            ("beta", "fix tests"),
            ("alpha", "search more"),
        ] {
            let r = mgr
                .spawn(
                    0,
                    SpawnSpec {
                        name: Some(n.into()),
                        ..spec(t)
                    },
                    &env,
                )
                .unwrap();
            mgr.wait_for(std::slice::from_ref(&r.id), None, Duration::from_secs(5))
                .await;
            ids.push(r.id);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let recs = mgr.filter_records(&json!({"name": "alpha"}), "chat-1");
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].id, ids[2], "newest first");
        assert_eq!(
            mgr.filter_records(&json!({"query": "TESTS"}), "chat-1")[0].id,
            ids[1]
        );
        assert_eq!(mgr.filter_records(&json!({"recent": 1}), "chat-1").len(), 1);
        assert!(mgr
            .filter_records(&json!({"status": "running"}), "chat-1")
            .is_empty());
        assert_eq!(
            mgr.filter_records(&json!({"status": "finished"}), "chat-1")
                .len(),
            3
        );
        let (out, _) = run_tool(&mgr, TOOL_LIST, json!({"name": "nobody"}), &env).await;
        assert!(out.contains("No sub-agents match"));
        // find_reusable picks the latest with that name
        assert_eq!(mgr.find_reusable("alpha", "chat-1").unwrap().id, ids[2]);
        assert!(mgr.find_reusable("alpha", "chat-9").is_none());
    }

    #[tokio::test]
    async fn app_actions_for_delete_data_reuse_find_and_log() {
        let (mgr, _s, _app, env, _ws, a, _b) = two_with_data().await;
        let out = mgr
            .handle_app_request(
                &json!({"action": "deleteData", "id": a, "parts": ["logs"], "dryRun": true}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(out["dryRun"], true);
        let out = mgr
            .handle_app_request(&json!({"action": "log", "id": a}), &env, None)
            .unwrap();
        assert!(!out["log"].as_array().unwrap().is_empty());
        let out = mgr
            .handle_app_request(&json!({"action": "find", "key": "a"}), &env, None)
            .unwrap();
        assert_eq!(out["subagent"]["id"], json!(a));
        let out = mgr
            .handle_app_request(
                &json!({"action": "spawn", "task": "again", "reuse": a}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(out["reuse"], "resumed");
        mgr.wait_for(std::slice::from_ref(&a), None, Duration::from_secs(5))
            .await;
        let out = mgr
            .handle_app_request(
                &json!({"action": "continue", "id": a, "message": "more"}),
                &env,
                None,
            )
            .unwrap();
        assert!(out.to_string().contains(&a));
        mgr.wait_for(std::slice::from_ref(&a), None, Duration::from_secs(5))
            .await;
        assert_eq!(mgr.get(&a).unwrap().runs, 3);
        // summary exposes what the UI needs
        let s = mgr.get(&a).unwrap().summary(false);
        assert!(
            s.get("runs").is_some()
                && s.get("memoryMode").is_some()
                && s.get("lastActiveAt").is_some()
        );
        let rec = mgr.get(&a).unwrap();
        assert!(serde_json::to_value(&rec).unwrap().get("files").is_some());
    }

    #[test]
    fn delegation_prompt_explains_reuse_vs_new() {
        let dir = std::env::temp_dir().join(format!("subagents-test-{}", uuid::Uuid::new_v4()));
        let mgr = SubagentManager::new(dir, Arc::new(Arc::new(Script::default())));
        let p = mgr.delegation_prompt();
        assert!(
            p.contains("persist across turns") && p.contains("Spawn a new one for unrelated work")
        );
        let defs = SubagentManager::tool_definitions();
        let spawn = defs.iter().find(|d| d.name == TOOL_SPAWN).unwrap();
        assert!(spawn.input_schema.to_string().contains("\"reuse\""));
        let list = defs.iter().find(|d| d.name == TOOL_LIST).unwrap();
        for k in ["\"name\"", "\"query\"", "\"recent\"", "\"scope\""] {
            assert!(list.input_schema.to_string().contains(k));
        }
    }

    // ── Regression tests: sub-agent graph fixes (2026-11-16) ────────────────

    #[tokio::test]
    async fn one_bad_setting_does_not_reset_the_others() {
        let (mgr, _script, _app, _env, dir) = setup();
        let (s, rejected) = mgr.set_settings_report(&json!({"maxDepth": 3, "topology": "mesh"}));
        assert_eq!((s.max_depth, s.topology.as_str()), (3, "mesh"));
        assert!(rejected.is_empty());
        // A wrong-typed field is skipped; the rest of the patch still applies.
        let (s, rejected) = mgr.set_settings_report(
            &json!({"maxParallel": "lots", "timeoutSeconds": 120, "allowAskParent": "false"}),
        );
        assert_eq!(s.max_depth, 3, "depth kept despite the bad field");
        assert_eq!(s.topology, "mesh");
        assert_eq!(s.timeout_seconds, 120);
        assert!(!s.allow_ask_parent, "\"false\" is read as false");
        assert_eq!(rejected, vec!["maxParallel".to_string()]);
        // Numbers sent as strings and snake_case keys are accepted.
        let s = mgr.set_settings(&json!({"max_depth": "2"}));
        assert_eq!(s.max_depth, 2);
        // A settings file with one broken field keeps the good ones on load.
        std::fs::write(
            dir.join("settings.json"),
            r#"{"maxDepth":3,"timeoutSeconds":"soon","topology":"ring","maxParallel":-1}"#,
        )
        .unwrap();
        let reloaded = SubagentManager::new(dir.clone(), Arc::new(Arc::new(Script::default())));
        let s = reloaded.settings();
        assert_eq!((s.max_depth, s.topology.as_str()), (3, "ring"));
        assert_eq!(
            s.timeout_seconds,
            SubagentSettings::default().timeout_seconds
        );
        assert_eq!(s.max_parallel, SubagentSettings::default().max_parallel);
    }

    #[test]
    fn defaults_allow_one_nested_level_and_chat_scoped_allow() {
        let d = SubagentSettings::default();
        assert_eq!(d.max_depth, 2);
        assert_eq!(d.always_allow_scope, "chat");
        assert!(!d.show_advanced_topologies);
        let (s, _) = d.merged(&json!({"alwaysAllowScope": "GLOBAL"}));
        assert_eq!(s.always_allow_scope, "global");
        let (s, _) = d.merged(&json!({"alwaysAllowScope": "whatever"}));
        assert_eq!(s.always_allow_scope, "chat");
    }

    #[tokio::test]
    async fn spawn_accepts_string_typed_arguments_from_small_models() {
        let (mgr, _script, _app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "count", "wait": "true", "max_steps": "5", "token_budget": "20000", "tools": "read_file, write_file", "priority": "2"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(out.contains("finished"), "waited for the report: {out}");
        let rec = &mgr.list()[0];
        assert_eq!(rec.max_steps, 5);
        assert_eq!(rec.priority, 2);
        assert_eq!(
            rec.tools,
            vec!["read_file".to_string(), "write_file".into()]
        );
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "x", "wait": "maybe"}),
            &env,
        )
        .await;
        assert!(
            err && out.contains("true or false"),
            "a real mistake is still reported: {out}"
        );
    }

    #[tokio::test]
    async fn spawn_keeps_the_tool_call_title_and_description() {
        let (mgr, _script, app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "find it", "title": "Find the syllabus", "description": "Looks up CSE 201.", "_toolCallId": "call_abc"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let rec = &mgr.list()[0];
        assert_eq!(rec.spawn_tool_call_id.as_deref(), Some("call_abc"));
        assert_eq!(rec.title.as_deref(), Some("Find the syllabus"));
        assert_eq!(rec.description.as_deref(), Some("Looks up CSE 201."));
        let started = &app.named("subagent.started")[0];
        assert_eq!(started["spawnToolCallId"], json!("call_abc"));
        assert_eq!(started["description"], json!("Looks up CSE 201."));
        // The schema offers the fields to the model.
        let schema = SubagentManager::tool_definitions()
            .into_iter()
            .find(|t| t.name == TOOL_SPAWN)
            .unwrap()
            .input_schema
            .to_string();
        for k in [
            "\"title\"",
            "\"description\"",
            "\"template\"",
            "\"can_message\"",
        ] {
            assert!(schema.contains(k), "{k} in spawn schema");
        }
    }

    #[tokio::test]
    async fn graph_hangs_each_agent_under_its_real_parent_and_survives_a_restart() {
        let (mgr, script, _app, env, dir) = setup();
        mgr.set_settings(&json!({"maxDepth": 3, "maxParallel": 1}));
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "spawn:spawn:leaf", "name": "top"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let check = |g: &Value| {
            let nodes = g["nodes"].as_array().unwrap();
            assert_eq!(nodes.len(), 3, "{g}");
            let by_depth = |d: u64| {
                nodes
                    .iter()
                    .find(|n| n["depth"] == json!(d))
                    .unwrap()
                    .clone()
            };
            let (l1, l2, l3) = (by_depth(1), by_depth(2), by_depth(3));
            assert_eq!(
                l1["parentId"],
                Value::Null,
                "level 1 hangs under the main agent"
            );
            assert_eq!(
                l2["parentId"], l1["id"],
                "level 2 hangs under level 1, not Main"
            );
            assert_eq!(
                l3["parentId"], l2["id"],
                "level 3 hangs under level 2, not Main"
            );
            let edges = g["edges"].as_array().unwrap();
            assert!(edges.contains(&json!({"from": l1["id"], "to": l2["id"]})));
            assert!(edges.contains(&json!({"from": l2["id"], "to": l3["id"]})));
            let events = g["events"].as_array().unwrap();
            for n in [&l1, &l2, &l3] {
                let mine: Vec<&Value> = events.iter().filter(|e| e["id"] == n["id"]).collect();
                assert!(
                    mine.iter().any(|e| e["event"] == json!("subagent.started")),
                    "start of {}",
                    n["id"]
                );
                assert!(
                    mine.iter()
                        .any(|e| e["event"] == json!("subagent.finished")),
                    "finish of {}",
                    n["id"]
                );
                assert!(mine.iter().all(|e| e["parentId"] == n["parentId"]));
            }
            let finished_report = events
                .iter()
                .find(|e| e["id"] == l1["id"] && e["event"] == json!("subagent.finished"))
                .unwrap();
            assert!(
                finished_report["report"]
                    .as_str()
                    .unwrap_or("")
                    .contains("nested"),
                "{finished_report}"
            );
            let ats: Vec<u64> = events.iter().map(|e| e["at"].as_u64().unwrap()).collect();
            assert!(ats.windows(2).all(|w| w[0] <= w[1]), "time-ordered");
        };
        let g = mgr.graph(Some("chat-1"), 0);
        check(&g);
        assert!(
            mgr.graph(Some("other-chat"), 0)["nodes"]
                .as_array()
                .unwrap()
                .is_empty(),
            "only this chat's agents"
        );
        // After the app restarts (a reload), the same graph comes back from disk.
        let reloaded = SubagentManager::new(dir.clone(), Arc::new(script.clone()));
        let g2 = reloaded
            .handle_app_request(
                &json!({"action": "graph", "sessionKey": "chat-1"}),
                &env,
                None,
            )
            .unwrap();
        check(&g2);
        assert_eq!(g["nodes"], g2["nodes"]);
    }

    #[tokio::test]
    async fn graph_keeps_follow_up_messages_and_peer_messages() {
        let (mgr, _script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("hello"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        mgr.message(&rec.id, "one more thing", &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        let g = mgr.graph(Some("chat-1"), 0);
        let msg = g["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["event"] == json!("subagent.message"))
            .cloned()
            .expect("message logged");
        assert_eq!(msg["text"], json!("one more thing"));
        // A deleted parent: the child is drawn under the main agent and marked.
        mgr.update(&rec.id, |r| r.parent_id = Some("sa-gone".into()));
        let g = mgr.graph(Some("chat-1"), 0);
        assert_eq!(g["nodes"][0]["parentId"], Value::Null);
        assert_eq!(g["nodes"][0]["parentMissing"], json!(true));
    }

    #[tokio::test]
    async fn always_allow_in_chat_covers_its_sub_agents_only_and_persists() {
        let (mgr, script, _app, env, dir) = setup();
        let rec = mgr.spawn(0, spec("x"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        assert!(!mgr.chat_allows_tool(&rec.session_key, "shell"));
        // Allowing from the sub-agent's card stores it on its chat.
        let out = mgr
            .handle_app_request(
                &json!({"action": "allowTool", "sessionKey": rec.session_key, "toolName": "shell"}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(out["sessionKey"], json!("chat-1"));
        assert!(mgr.chat_allows_tool("chat-1", "shell"));
        assert!(
            mgr.chat_allows_tool(&rec.session_key, "shell"),
            "the chat's sub-agents are covered"
        );
        assert!(
            !mgr.chat_allows_tool("chat-2", "shell"),
            "other chats still ask"
        );
        assert!(
            !mgr.chat_allows_tool("chat-1", "write_file"),
            "other tools still ask"
        );
        let reloaded = SubagentManager::new(dir.clone(), Arc::new(script.clone()));
        assert!(
            reloaded.chat_allows_tool(&rec.session_key, "shell"),
            "kept across restarts"
        );
        reloaded
            .handle_app_request(
                &json!({"action": "revokeTool", "sessionKey": "chat-1", "toolName": "shell"}),
                &env,
                None,
            )
            .unwrap();
        assert!(!reloaded.chat_allows_tool("chat-1", "shell"));
    }

    #[tokio::test]
    async fn configure_changes_model_and_limits_for_the_next_run() {
        let (mgr, _script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("x"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(5))
            .await;
        let out = mgr
            .handle_app_request(&json!({"action": "configure", "id": rec.id, "model": "llama-3", "provider": "ovh", "maxSteps": 7, "hiddenFrom": ["beta"], "canMessage": ["alpha"]}), &env, None)
            .unwrap();
        assert_eq!(out["subagent"]["model"], json!("llama-3"));
        let r = mgr.get(&rec.id).unwrap();
        assert_eq!(
            (r.model.as_deref(), r.provider.as_deref(), r.max_steps),
            (Some("llama-3"), Some("ovh"), 7)
        );
        assert_eq!(r.hidden_from, vec!["beta".to_string()]);
        assert_eq!(r.can_message, Some(vec!["alpha".to_string()]));
    }

    #[tokio::test]
    async fn a_level_3_approval_reaches_the_chat_tagged_with_the_innermost_agent() {
        let (mgr, _script, app, env, _) = setup();
        mgr.set_settings(&json!({"maxDepth": 3}));
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "spawn:spawn:approval", "name": "top"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let leaf = mgr
            .list()
            .into_iter()
            .find(|r| r.depth == 3)
            .expect("level 3 ran");
        let req = app
            .named("approval_request")
            .into_iter()
            .find(|r| r["subagent"]["id"] == json!(leaf.id))
            .expect("approval from level 3");
        assert_eq!(
            req["sessionKey"],
            json!("chat-1"),
            "lifted to the chat, so the app shows it in the right chat: {req}"
        );
        assert_eq!(req["subagentSessionKey"], json!(leaf.session_key));
        // "Always allow in this chat" from that card covers level 3 too.
        mgr.handle_app_request(&json!({"action": "allowTool", "sessionKey": leaf.session_key, "toolName": "write_file"}), &env, None).unwrap();
        assert!(mgr.chat_allows_tool(&leaf.session_key, "write_file"));
        // The graph logs the approval on the level-3 node.
        let g = mgr.graph(Some("chat-1"), 0);
        let ev = g["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["event"] == json!("subagent.approval_needed"))
            .cloned()
            .expect("approval in graph");
        assert_eq!(ev["id"], json!(leaf.id));
        assert_eq!(ev["approvalTool"], json!("write_file"));
    }

    const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn image_attachment() -> String {
        json!([{ "type": "image", "mediaType": "image/png", "data": PNG_1PX, "name": "dot.png" }])
            .to_string()
    }

    #[tokio::test]
    async fn a_message_with_an_image_reaches_the_sub_agent() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        let att = image_attachment();
        let r = mgr.handle_app_request(&json!({"action": "message", "id": rec.id, "message": "what is in it?", "attachmentsJson": att}), &env, None).unwrap();
        assert_eq!(r["resumed"], json!(true));
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert_eq!(
            script
                .attachments
                .lock()
                .unwrap()
                .last()
                .cloned()
                .flatten()
                .as_deref(),
            Some(att.as_str())
        );
        let msgs = script.load_messages(&rec.session_key);
        let MessageContent::Blocks(b) = &msgs[2].content else {
            panic!("the image must be on the user message: {:?}", msgs[2])
        };
        assert!(b.iter().any(|x| matches!(x, crate::types::ContentBlock::Image { media_type, .. } if media_type == "image/png")));
        // An image alone (no text) is a message too.
        mgr.handle_app_request(&json!({"action": "message", "id": rec.id, "message": "", "attachmentsJson": image_attachment()}), &env, None).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert_eq!(script.load_messages(&rec.session_key).len(), 6);
        // A broken attachment is refused and nothing runs.
        let runs = script.attachments.lock().unwrap().len();
        assert!(mgr.handle_app_request(&json!({"action": "message", "id": rec.id, "message": "x", "attachmentsJson": "[{\"type\":\"image\"}]"}), &env, None).is_err());
        assert_eq!(script.attachments.lock().unwrap().len(), runs);
    }

    #[tokio::test]
    async fn an_image_sent_while_it_runs_starts_its_next_run() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("sleep:300"), &env).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let r = mgr.handle_app_request(&json!({"action": "message", "id": rec.id, "message": "look", "attachmentsJson": image_attachment()}), &env, None).unwrap();
        assert_eq!(r["resumed"], json!(false), "it waits for the current run");
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(3))
            .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(3))
            .await;
        let atts = script.attachments.lock().unwrap().clone();
        assert_eq!(atts.len(), 2, "the image started a second run: {atts:?}");
        assert!(atts[1].is_some());
        assert!(mgr
            .get(&rec.id)
            .unwrap()
            .result
            .unwrap()
            .contains("[1 attachment(s)]"));
    }

    #[tokio::test]
    async fn retry_and_edit_keep_the_messages_images() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        mgr.handle_app_request(&json!({"action": "message", "id": rec.id, "message": "see", "attachmentsJson": image_attachment()}), &env, None).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        mgr.handle_app_request(&json!({"action": "regenerate", "id": rec.id}), &env, None)
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert!(
            script.attachments.lock().unwrap().last().unwrap().is_some(),
            "retry sends the image again"
        );
        mgr.handle_app_request(
            &json!({"action": "edit", "id": rec.id, "turn": 1, "message": "see again"}),
            &env,
            None,
        )
        .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert!(
            script.attachments.lock().unwrap().last().unwrap().is_some(),
            "an edit keeps the image"
        );
        mgr.handle_app_request(&json!({"action": "edit", "id": rec.id, "turn": 1, "message": "no picture", "attachmentsJson": "[]"}), &env, None).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        assert!(
            script.attachments.lock().unwrap().last().unwrap().is_none(),
            "an edit can remove it"
        );
    }

    #[tokio::test]
    async fn edits_keep_the_earlier_version_across_a_restart() {
        let (mgr, script, _app, env, dir) = setup();
        let rec = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        mgr.handle_app_request(
            &json!({"action": "edit", "id": rec.id, "turn": 0, "message": "first-edited"}),
            &env,
            None,
        )
        .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        mgr.handle_app_request(&json!({"action": "regenerate", "id": rec.id}), &env, None)
            .unwrap();
        mgr.wait_for(std::slice::from_ref(&rec.id), None, Duration::from_secs(2))
            .await;
        // A new manager on the same state folder (the app restarted).
        let again = SubagentManager::new(dir.clone(), Arc::new(script.clone()));
        let t = again
            .handle_app_request(
                &json!({"action": "get", "id": rec.id, "withBranches": true}),
                &env,
                None,
            )
            .unwrap();
        let branches = t["branches"].as_array().unwrap();
        assert_eq!(branches.len(), 2, "{t}");
        assert_eq!(branches[0]["reason"], json!("edit"));
        assert_eq!(branches[0]["messages"][1]["content"], json!("done: first"));
        assert_eq!(branches[1]["reason"], json!("regenerate"));
        // Switching to the old version keeps the current one.
        let old = branches[0]["id"].as_str().unwrap();
        again
            .handle_app_request(
                &json!({"action": "restoreBranch", "id": rec.id, "branchId": old}),
                &env,
                None,
            )
            .unwrap();
        let msgs = script.load_messages(&rec.session_key);
        assert!(matches!(&msgs[0].content, MessageContent::Text(t) if t == "first"));
        // The current version equals the kept retry (the script answers the same), so it is not kept twice.
        assert_eq!(again.branches(&rec.id).len(), 1);
        // Deleting the sub-agent deletes its kept versions.
        again
            .handle_app_request(&json!({"action": "delete", "id": rec.id}), &env, None)
            .unwrap();
        assert!(again.branches(&rec.id).is_empty());
    }

    #[test]
    fn compaction_policy_threshold_and_off() {
        let p = CompactionPolicy {
            enabled: true,
            threshold_percent: 60,
        };
        assert_eq!(p.trigger_tokens(10_000), 6_000);
        assert_eq!(CompactionPolicy::default().trigger_tokens(10_000), 10_000);
        assert_eq!(
            CompactionPolicy {
                enabled: true,
                threshold_percent: 3
            }
            .trigger_tokens(10_000),
            1_000,
            "clamped to 10%"
        );
        assert_eq!(
            CompactionPolicy {
                enabled: false,
                threshold_percent: 50
            }
            .trigger_tokens(10_000),
            10_000
        );
    }

    #[tokio::test]
    async fn every_agent_gets_the_chat_wide_compaction_or_its_own() {
        let (mgr, _s, _app, env, _) = setup();
        mgr.set_settings(&json!({"autoCompact": true, "compactThresholdPercent": 70}));
        let a = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&a.id), None, Duration::from_secs(2))
            .await;
        assert_eq!(
            mgr.compaction_policy("chat-1"),
            CompactionPolicy {
                enabled: true,
                threshold_percent: 70
            },
            "the main agent"
        );
        assert_eq!(
            mgr.compaction_policy(&a.session_key).threshold_percent,
            70,
            "a sub-agent without its own setting"
        );
        mgr.handle_app_request(
            &json!({"action": "configure", "id": a.id, "compaction": {"enabled": false}}),
            &env,
            None,
        )
        .unwrap();
        assert!(!mgr.compaction_policy(&a.session_key).enabled);
        mgr.handle_app_request(&json!({"action": "configure", "id": a.id, "compaction": {"enabled": true, "thresholdPercent": 5}}), &env, None).unwrap();
        assert_eq!(
            mgr.compaction_policy(&a.session_key),
            CompactionPolicy {
                enabled: true,
                threshold_percent: 10
            }
        );
        // Depth 3: an agent two levels below inherits the chat-wide policy, and its own wins.
        mgr.set_settings(&json!({"maxDepth": 3}));
        let a_env = ParentEnv {
            task_context: None,
            session_key: a.session_key.clone(),
            ..env.clone()
        };
        let b = mgr.spawn(1, spec("first"), &a_env).unwrap();
        let b_env = ParentEnv {
            task_context: None,
            session_key: b.session_key.clone(),
            ..env.clone()
        };
        let c = mgr.spawn(2, spec("first"), &b_env).unwrap();
        mgr.wait_for(&[b.id.clone(), c.id.clone()], None, Duration::from_secs(2))
            .await;
        assert_eq!(mgr.get(&c.id).unwrap().depth, 3);
        assert_eq!(mgr.compaction_policy(&c.session_key).threshold_percent, 70);
        mgr.handle_app_request(
            &json!({"action": "configure", "id": c.id, "compaction": {"thresholdPercent": 40}}),
            &env,
            None,
        )
        .unwrap();
        assert_eq!(mgr.compaction_policy(&c.session_key).threshold_percent, 40);
        mgr.handle_app_request(
            &json!({"action": "configure", "id": a.id, "compaction": null}),
            &env,
            None,
        )
        .unwrap();
        assert_eq!(
            mgr.compaction_policy(&a.session_key).threshold_percent,
            70,
            "null goes back to the chat-wide one"
        );
        // An invalid threshold never turns compaction off or breaks settings.
        mgr.set_settings(&json!({"compactThresholdPercent": "lots"}));
        assert!(mgr.settings().auto_compact);
        assert_eq!(
            mgr.settings().max_depth,
            3,
            "an invalid value never resets another setting"
        );
    }

    #[tokio::test]
    async fn compaction_events_show_on_the_sub_agent() {
        let (mgr, _s, app, env, _) = setup();
        let a = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&a.id), None, Duration::from_secs(2))
            .await;
        let ev = SubagentEvents {
            manager: mgr.clone(),
            id: a.id.clone(),
            name: a.name.clone(),
            parent_session_key: a.parent_session_key.clone(),
            session_key: a.session_key.clone(),
            app: Some(app.clone()),
            abort: Arc::new(Mutex::new(false)),
            stop_reason: Arc::new(StdMutex::new(None)),
            text_buf: Arc::new(StdMutex::new(String::new())),
        };
        ev.on_event("context.usage".into(), json!({"inputTokens": 10, "estimatedInputTokens": 9000, "contextBudgetTokens": 10000, "compactAtTokens": 7000, "thresholdPercent": 70, "autoCompact": true}).to_string());
        ev.on_event("context.compacted".into(), json!({"tokensBefore": 9000, "tokensAfter": 3000, "trigger": "threshold", "compactAtTokens": 7000}).to_string());
        let r = mgr.get(&a.id).unwrap();
        assert_eq!(r.compactions, 1);
        assert_eq!(
            r.last_compaction.as_ref().unwrap()["kind"],
            json!("compacted")
        );
        assert_eq!(
            r.context_status.as_ref().unwrap()["compactAtTokens"],
            json!(7000)
        );
        let seen = app.named("subagent.compaction");
        assert_eq!(
            seen.last().unwrap()["compaction"]["tokensAfter"],
            json!(3000)
        );

        // Turn memory (keep 7 / batch 7) and the overflow retry are the main
        // chat's steps too: the card records and counts them.
        ev.on_event(
            "memory.summarizing".into(),
            json!({"fromTurn": 1, "toTurn": 7}).to_string(),
        );
        assert_eq!(
            mgr.get(&a.id).unwrap().compactions,
            1,
            "started is not a compaction"
        );
        ev.on_event(
            "memory.updated".into(),
            json!({"fromTurn": 1, "toTurn": 7, "throughTurn": 7, "version": 2}).to_string(),
        );
        let r = mgr.get(&a.id).unwrap();
        assert_eq!(r.compactions, 2);
        let last = r.last_compaction.clone().unwrap();
        assert_eq!(
            (
                last["kind"].clone(),
                last["toTurn"].clone(),
                last["throughTurn"].clone()
            ),
            (json!("memory_summary"), json!(7), json!(7))
        );
        ev.on_event(
            "memory.updated".into(),
            json!({"throughTurn": 7, "alreadyDone": true}).to_string(),
        );
        assert_eq!(
            mgr.get(&a.id).unwrap().compactions,
            2,
            "a batch another writer stored is not counted twice"
        );
        ev.on_event(
            "context.overflow".into(),
            json!({"attempt": 1, "recovering": true, "nextBudgetTokens": 5000}).to_string(),
        );
        let r = mgr.get(&a.id).unwrap();
        assert_eq!(r.compactions, 3);
        assert_eq!(
            r.last_compaction.as_ref().unwrap()["kind"],
            json!("overflow_retry")
        );
        ev.on_event(
            "context.overflow_unrecoverable".into(),
            json!({"attempt": 2}).to_string(),
        );
        let r = mgr.get(&a.id).unwrap();
        assert_eq!(r.compactions, 3);
        assert_eq!(
            r.last_compaction.as_ref().unwrap()["phase"],
            json!("failed")
        );
        ev.on_event(
            "memory.applied".into(),
            json!({"throughTurn": 7}).to_string(),
        );
        assert_eq!(
            mgr.get(&a.id).unwrap().last_compaction.as_ref().unwrap()["kind"],
            json!("overflow_retry"),
            "not a compaction step"
        );
    }

    #[test]
    fn compaction_step_maps_every_main_agent_step() {
        let none = json!({});
        for (event, kind, done) in [
            (
                "context.tool_results_compacted",
                "tool_results_compacted",
                true,
            ),
            (
                "context.explanations_shortened",
                "explanations_shortened",
                true,
            ),
            ("context.compacted", "compacted", true),
            ("context.trimmed", "trimmed", true),
            ("memory.updated", "memory_summary", true),
            ("memory.summarizing", "memory_summary", false),
            ("memory.queued", "memory_summary", false),
            ("memory.pending", "memory_summary", false),
            ("memory.failed", "memory_summary", false),
            ("memory.cancelled", "memory_summary", false),
            ("context.overflow", "overflow_retry", false),
            ("context.overflow_unrecoverable", "overflow_retry", false),
        ] {
            let (k, _, d) = compaction_step(event, &none).unwrap_or_else(|| panic!("{event}"));
            assert_eq!((k, d), (kind, done), "{event}");
        }
        assert_eq!(
            compaction_step("context.overflow", &json!({"recovering": true})),
            Some(("overflow_retry", "done", true))
        );
        assert_eq!(
            compaction_step("memory.updated", &json!({"alreadyDone": true})),
            None
        );
        assert_eq!(compaction_step("context.usage", &none), None);
    }

    #[tokio::test]
    async fn per_agent_temperature_depth_prompt_and_memory_settings() {
        let (mgr, _s, _app, env, _) = setup();
        let a = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(std::slice::from_ref(&a.id), None, Duration::from_secs(2))
            .await;
        mgr.handle_app_request(&json!({"action": "configure", "id": a.id, "temperature": 0.3, "maxChildDepth": 0, "systemPrompt": "Be brief.", "memory": "isolated", "timeoutSeconds": 120, "peerRateLimit": 4}), &env, None).unwrap();
        let r = mgr.get(&a.id).unwrap();
        assert_eq!(r.temperature, Some(0.3));
        assert_eq!(mgr.temperature_for(&a.session_key), Some(0.3));
        assert_eq!(r.max_child_depth, Some(0));
        assert_eq!(r.system_prompt.as_deref(), Some("Be brief."));
        assert_eq!(r.memory_mode, "isolated");
        assert_eq!(r.timeout_seconds, 120);
        assert_eq!(r.peer_rate_limit, Some(4));
        // maxChildDepth 0: it may not start agents below itself.
        let child_env = ParentEnv {
            task_context: None,
            session_key: a.session_key.clone(),
            ..env.clone()
        };
        let err = mgr.spawn(1, spec("x"), &child_env).unwrap_err();
        assert!(err.contains("only 0 levels"), "{err}");
        mgr.handle_app_request(
            &json!({"action": "configure", "id": a.id, "temperature": null, "maxChildDepth": null}),
            &env,
            None,
        )
        .unwrap();
        assert_eq!(mgr.get(&a.id).unwrap().temperature, None);
        assert!(mgr.spawn(1, spec("x"), &child_env).is_ok());
        mgr.stop_where(|_| true);
    }

    #[tokio::test]
    async fn pause_resume_stop_tree_and_reparent() {
        let (mgr, script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxDepth": 3}));
        let a = mgr.spawn(0, spec("sleep:2000"), &env).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let p = mgr
            .handle_app_request(&json!({"action": "pause", "id": a.id}), &env, None)
            .unwrap();
        assert_eq!(p["subagent"]["paused"], json!(true));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(mgr.get(&a.id).unwrap().status, "paused");
        mgr.handle_app_request(&json!({"action": "resume", "id": a.id}), &env, None)
            .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let r = mgr.get(&a.id).unwrap();
        assert!(!r.paused && r.status != "paused", "{}", r.status);
        assert!(
            script
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|q| q.0.starts_with("Continue the task")),
            "resume continued it"
        );
        mgr.stop(&a.id, "cancelled");
        // A tree: b under a, c under b.
        let a_env = ParentEnv {
            task_context: None,
            session_key: a.session_key.clone(),
            ..env.clone()
        };
        let b = mgr.spawn(1, spec("sleep:3000"), &a_env).unwrap();
        let b_env = ParentEnv {
            task_context: None,
            session_key: b.session_key.clone(),
            ..env.clone()
        };
        let c = mgr.spawn(2, spec("sleep:3000"), &b_env).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            mgr.subtree_ids(&a.id),
            vec![a.id.clone(), b.id.clone(), c.id.clone()]
        );
        assert!(mgr.reparent(&b.id, None).is_err(), "not while it runs");
        let s = mgr
            .handle_app_request(&json!({"action": "stopTree", "id": b.id}), &env, None)
            .unwrap();
        assert_eq!(s["stopped"].as_array().unwrap().len(), 2);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(!mgr.get(&c.id).unwrap().is_active());
        // Move b (with c) directly under the main agent.
        let m = mgr
            .handle_app_request(
                &json!({"action": "reparent", "id": b.id, "parentId": null}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(m["subagent"]["depth"], json!(1));
        assert_eq!(mgr.get(&c.id).unwrap().depth, 2);
        assert_eq!(mgr.get(&b.id).unwrap().parent_id, None);
        assert!(
            mgr.reparent(&b.id, Some(&c.id)).is_err(),
            "never under its own child"
        );
    }

    #[tokio::test]
    async fn comms_timeline_routing_rules_and_broadcast() {
        let (mgr, _s, _app, env, _) = setup();
        mgr.set_settings(&json!({"topology": "mesh", "peerRateLimitPerMin": 1}));
        let a = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("alpha".into()),
                    ..spec("first")
                },
                &env,
            )
            .unwrap();
        let b = mgr
            .spawn(
                0,
                SpawnSpec {
                    name: Some("beta".into()),
                    ..spec("first")
                },
                &env,
            )
            .unwrap();
        mgr.wait_for(&[a.id.clone(), b.id.clone()], None, Duration::from_secs(2))
            .await;
        let a_env = ParentEnv {
            task_context: None,
            session_key: a.session_key.clone(),
            ..env.clone()
        };
        let (out, err) = mgr
            .handle_team_tool(
                team::TOOL_MESSAGE_PEER,
                &json!({"to": b.id, "message": "hi beta"}),
                a_env.clone(),
            )
            .await;
        assert!(!err, "{out}");
        let (out, err) = mgr
            .handle_team_tool(
                team::TOOL_MESSAGE_PEER,
                &json!({"to": b.id, "message": "again"}),
                a_env.clone(),
            )
            .await;
        assert!(err && out.contains("last minute"), "rate limit: {out}");
        mgr.set_settings(&json!({"peerRateLimitPerMin": 0, "commsPaused": true}));
        let (out, err) = mgr
            .handle_team_tool(
                team::TOOL_MESSAGE_PEER,
                &json!({"to": b.id, "message": "x"}),
                a_env.clone(),
            )
            .await;
        assert!(err && out.contains("paused"), "{out}");
        mgr.set_settings(&json!({"commsPaused": false}));
        let d = mgr
            .handle_app_request(
                &json!({"action": "broadcast", "message": "status please"}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(d["delivered"].as_array().unwrap().len(), 2);
        let c = mgr
            .handle_app_request(&json!({"action": "comms"}), &env, None)
            .unwrap();
        let kinds: Vec<&str> = c["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"peer") && kinds.contains(&"blocked") && kinds.contains(&"broadcast"),
            "{kinds:?}"
        );
        let peer = c["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == "peer")
            .unwrap();
        assert_eq!(peer["fromId"], json!(a.id));
        assert_eq!(peer["toId"], json!(b.id));
        assert_eq!(peer["text"], json!("hi beta"));
        assert_eq!(c["topology"], json!("mesh"));
        assert_eq!(c["matrix"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn always_allow_scoped_to_one_agent_and_its_children() {
        let (mgr, _s, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxDepth": 3}));
        let a = mgr.spawn(0, spec("first"), &env).unwrap();
        let b = mgr.spawn(0, spec("first"), &env).unwrap();
        let a_env = ParentEnv {
            task_context: None,
            session_key: a.session_key.clone(),
            ..env.clone()
        };
        let a1 = mgr.spawn(1, spec("first"), &a_env).unwrap();
        mgr.wait_for(
            &[a.id.clone(), b.id.clone(), a1.id.clone()],
            None,
            Duration::from_secs(2),
        )
        .await;
        let r = mgr.handle_app_request(&json!({"action": "allowTool", "sessionKey": a.session_key, "toolName": "shell", "scope": "agent"}), &env, None).unwrap();
        assert_eq!(r["scope"], json!("agent"));
        assert!(mgr.chat_allows_tool(&a.session_key, "shell"));
        assert!(
            mgr.chat_allows_tool(&a1.session_key, "shell"),
            "its child is covered"
        );
        assert!(
            !mgr.chat_allows_tool(&b.session_key, "shell"),
            "a sibling still asks"
        );
        assert!(
            !mgr.chat_allows_tool("chat-1", "shell"),
            "the main agent still asks"
        );
        let l = mgr
            .handle_app_request(
                &json!({"action": "chatAllows", "sessionKey": a1.session_key}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(l["inherited"][0]["tool"], json!("shell"));
        mgr.handle_app_request(&json!({"action": "revokeTool", "sessionKey": a.session_key, "toolName": "shell", "scope": "agent"}), &env, None).unwrap();
        assert!(!mgr.chat_allows_tool(&a1.session_key, "shell"));
    }

    // ── Advanced spawning and control (feature "subagentAdvanced") ───────

    fn prompts(script: &Script) -> Vec<String> {
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.0.clone())
            .collect()
    }

    #[tokio::test]
    async fn adv_parallel_batch_fans_out_with_a_shared_goal() {
        let (mgr, script, _app, env, _) = setup();
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "shared goal", "tasks": ["part a", "part b", {"task": "part c", "name": "Charlie"}]}), &env).await;
        assert!(!err, "{out}");
        assert!(out.contains("3 sub-agents as a parallel batch"), "{out}");
        let mut list = mgr.list();
        list.sort_by_key(|r| r.group_index);
        assert_eq!(list.len(), 3);
        let g = list[0].group_id.clone().unwrap();
        for (i, r) in list.iter().enumerate() {
            assert_eq!(r.group_id.as_deref(), Some(g.as_str()));
            assert_eq!(r.group_mode.as_deref(), Some("parallel"));
            assert_eq!(r.group_index, Some(i as u32));
            assert_eq!(r.status, "finished");
            assert!(
                r.depends_on.is_empty(),
                "parallel members do not wait for each other"
            );
        }
        assert_eq!(list[0].name, "worker-1");
        assert_eq!(list[2].name, "charlie");
        let p = prompts(&script);
        assert!(
            p.iter().any(|x| x == "shared goal\n\n## Your part\npart a"),
            "{p:?}"
        );
        assert!(
            out.contains("done: shared goal") && out.matches("finished after").count() == 3,
            "{out}"
        );
    }

    #[tokio::test]
    async fn adv_pipeline_runs_in_order_and_hands_each_report_on() {
        let (mgr, script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "x", "tasks": ["first", "second", "third"], "mode": "pipeline"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let mut list = mgr.list();
        list.sort_by_key(|r| r.group_index);
        let (a, b, c) = (&list[0], &list[1], &list[2]);
        assert_eq!(
            (a.name.as_str(), b.name.as_str(), c.name.as_str()),
            ("step-1", "step-2", "step-3")
        );
        assert_eq!(b.depends_on, vec![a.id.clone()]);
        assert_eq!(c.depends_on, vec![b.id.clone()]);
        assert!(
            b.started_at >= a.finished_at.unwrap(),
            "step 2 starts after step 1 ends"
        );
        assert!(c.started_at >= b.finished_at.unwrap());
        let p = prompts(&script);
        assert_eq!(p.len(), 3, "{p:?}");
        assert!(p[0].ends_with("## Your part\nfirst"));
        assert!(
            p[1].contains("## Results from the agents you waited for")
                && p[1].contains("done: x\n\n## Your part\nfirst"),
            "{}",
            p[1]
        );
        assert!(
            p[2].contains(&format!("({})", b.id)),
            "step 3 sees step 2's report: {}",
            p[2]
        );
        assert!(out.contains("pipeline batch"));
    }

    #[tokio::test]
    async fn adv_a_failed_pipeline_step_cancels_the_steps_after_it() {
        let (mgr, _script, _app, env, _) = setup();
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "", "tasks": ["sleep:3000", "b", "c"], "mode": "pipeline", "wait": false}), &env).await;
        assert!(!err, "{out}");
        let mut list = mgr.list();
        list.sort_by_key(|r| r.group_index);
        assert_eq!(list[1].status, "queued", "waits for step 1");
        assert!(mgr.stop(&list[0].id, "cancelled"));
        let ids: Vec<String> = list.iter().map(|r| r.id.clone()).collect();
        mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
        let b = mgr.get(&list[1].id).unwrap();
        let c = mgr.get(&list[2].id).unwrap();
        assert_eq!(b.status, "cancelled");
        assert!(
            b.error.as_deref().unwrap().contains("ended as cancelled"),
            "{:?}",
            b.error
        );
        assert_eq!(c.status, "cancelled", "the cancel goes down the chain");
        assert_eq!(b.steps, 0, "it never ran");
    }

    #[tokio::test]
    async fn adv_race_keeps_the_first_to_finish_and_stops_the_rest() {
        let (mgr, _script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "", "tasks": ["sleep:4000", "quick", "sleep:4000"], "mode": "race"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(
            out.contains("Winner") && out.contains("done: quick"),
            "{out}"
        );
        let ids: Vec<String> = mgr.list().iter().map(|r| r.id.clone()).collect();
        mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
        let list = mgr.list();
        let winners: Vec<&SubagentRecord> = list.iter().filter(|r| r.group_winner).collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(winners[0].group_index, Some(1));
        assert!(
            list.iter()
                .filter(|r| !r.group_winner)
                .all(|r| r.status == "cancelled"),
            "{:?}",
            list.iter().map(|r| &r.status).collect::<Vec<_>>()
        );
        let lost = mgr.read_log(&list.iter().find(|r| !r.group_winner).unwrap().id, 50);
        assert!(lost
            .iter()
            .any(|e| e["event"] == json!("subagent.race_lost")));
    }

    #[tokio::test]
    async fn adv_after_waits_for_a_named_agent_and_gets_its_report() {
        let (mgr, script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let (out, _) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "sleep:300", "name": "Researcher", "wait": false}),
            &env,
        )
        .await;
        assert!(out.contains("Started"), "{out}");
        let b = mgr
            .spawn(
                0,
                SpawnSpec {
                    after: Some(vec!["researcher".into()]),
                    name: Some("writer".into()),
                    ..spec("write it up")
                },
                &env,
            )
            .unwrap();
        assert_eq!(b.status, "queued", "free slots, but it waits for its input");
        let a = mgr
            .list()
            .into_iter()
            .find(|r| r.name == "researcher")
            .unwrap();
        assert_eq!(b.depends_on, vec![a.id.clone()]);
        mgr.wait_for(&[a.id.clone(), b.id.clone()], None, Duration::from_secs(5))
            .await;
        let b = mgr.get(&b.id).unwrap();
        assert_eq!(b.status, "finished");
        let p = prompts(&script);
        let pb = p.iter().find(|x| x.starts_with("write it up")).unwrap();
        assert!(
            pb.contains("### researcher") && pb.contains("done: sleep:300"),
            "{pb}"
        );
        let g = mgr.graph(Some("chat-1"), 0);
        assert!(
            g["dependencyEdges"]
                .as_array()
                .unwrap()
                .contains(&json!({"from": a.id, "to": b.id, "kind": "dependency"})),
            "{g}"
        );
        let node = g["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == json!(b.id))
            .unwrap()
            .clone();
        assert_eq!(node["dependsOn"], json!([a.id]));
        assert_eq!(node["contextMode"], json!("fresh"));
        assert!(node["durationMs"].is_number());
        let err = mgr
            .spawn(
                0,
                SpawnSpec {
                    after: Some(vec!["nobody".into()]),
                    ..spec("x")
                },
                &env,
            )
            .unwrap_err();
        assert!(
            err.contains("no sub-agent of this chat") && err.contains("nobody"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn adv_fork_context_gives_the_child_the_recent_transcript() {
        let (mgr, script, _app, env, _) = setup();
        script.saved.lock().unwrap().insert(
            "chat-1".into(),
            vec![
                Message::user("we picked Postgres"),
                Message {
                    role: Role::Assistant,
                    content: MessageContent::Text("Noted: Postgres 16.".into()),
                },
                Message::user("now plan the schema"),
            ],
        );
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "draft the schema", "context": "fork"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        let p = prompts(&script);
        assert!(p[0].starts_with("draft the schema\n\n## Context: the conversation you were forked from\nThe last 3 messages"), "{}", p[0]);
        assert!(
            p[0].contains("User: we picked Postgres")
                && p[0].contains("Assistant: Noted: Postgres 16.")
        );
        let rec = &mgr.list()[0];
        assert_eq!(rec.context_mode.as_deref(), Some("fork"));
        assert_eq!(rec.context_source.as_deref(), Some("chat-1"));
        assert_eq!(
            rec.task, "draft the schema",
            "the brief stays the task; the context only rides on the prompt"
        );
        // From the app: fork another chat up to a message.
        script.saved.lock().unwrap().insert(
            "chat-2".into(),
            vec![Message::user("alpha"), Message::user("beta")],
        );
        let r = mgr
            .handle_app_request(
                &json!({"action": "spawn", "task": "go", "forkSession": "chat-2", "forkUpto": 1}),
                &env,
                None,
            )
            .unwrap();
        let id = r["subagent"]["id"].as_str().unwrap().to_string();
        mgr.wait_for(&[id.clone()], None, Duration::from_secs(5))
            .await;
        let p = prompts(&script);
        let last = p.iter().find(|x| x.starts_with("go")).unwrap();
        assert!(
            last.contains("User: alpha") && !last.contains("beta"),
            "{last}"
        );
        assert_eq!(
            mgr.get(&id).unwrap().context_source.as_deref(),
            Some("chat-2")
        );
        // "Fork from here" on a message: the first N user turns.
        script.saved.lock().unwrap().insert(
            "chat-3".into(),
            vec![
                Message::user("q1"),
                Message {
                    role: Role::Assistant,
                    content: MessageContent::Text("a1".into()),
                },
                Message::user("q2"),
                Message {
                    role: Role::Assistant,
                    content: MessageContent::Text("a2".into()),
                },
            ],
        );
        let r = mgr.handle_app_request(&json!({"action": "spawn", "task": "turns", "forkSession": "chat-3", "forkUserTurns": 1}), &env, None).unwrap();
        let id3 = r["subagent"]["id"].as_str().unwrap().to_string();
        mgr.wait_for(&[id3], None, Duration::from_secs(5)).await;
        let p = prompts(&script);
        let t = p.iter().find(|x| x.starts_with("turns")).unwrap();
        assert!(
            t.contains("User: q1") && t.contains("Assistant: a1") && !t.contains("q2"),
            "{t}"
        );
        let bad = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "x", "context": "telepathy"}),
            &env,
        )
        .await;
        assert!(
            bad.1 && bad.0.contains("must be \"fresh\" or \"fork\""),
            "{bad:?}"
        );
    }

    #[tokio::test]
    async fn adv_handoff_makes_the_report_the_parents_reply() {
        let (mgr, _script, _app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "answer the user", "handoff": true}),
            &env,
        )
        .await;
        assert!(!err);
        assert!(
            out.starts_with("HANDOFF:") && out.contains("done: answer the user"),
            "{out}"
        );
        assert!(mgr.list()[0].handoff);
        let g = mgr.graph(Some("chat-1"), 0);
        assert_eq!(g["nodes"][0]["handoff"], json!(true));
    }

    #[tokio::test]
    async fn adv_move_to_chat_moves_an_idle_tree_and_refuses_the_rest() {
        let (mgr, _script, _app, env, _) = setup();
        let a = mgr.spawn(0, spec("top"), &env).unwrap();
        let a_env = ParentEnv {
            task_context: None,
            session_key: a.session_key.clone(),
            ..env.clone()
        };
        let child = mgr.spawn(1, spec("child"), &a_env).unwrap();
        mgr.wait_for(
            &[a.id.clone(), child.id.clone()],
            None,
            Duration::from_secs(5),
        )
        .await;
        let req =
            |id: &str, to: &str| json!({"action": "moveToChat", "id": id, "targetSessionKey": to});
        let e = mgr
            .handle_app_request(&req(&child.id, "chat-2"), &env, None)
            .unwrap_err();
        assert!(e.contains("top agent"), "{e}");
        let e = mgr
            .handle_app_request(&req(&a.id, &child.session_key), &env, None)
            .unwrap_err();
        assert!(e.contains("not a chat"), "{e}");
        let e = mgr
            .handle_app_request(&req(&a.id, "chat-1"), &env, None)
            .unwrap_err();
        assert!(e.contains("already"), "{e}");
        let r = mgr
            .handle_app_request(&req(&a.id, "chat-2"), &env, None)
            .unwrap();
        assert_eq!(r["subagent"]["parentSessionKey"], json!("chat-2"));
        assert_eq!(
            mgr.get(&child.id).unwrap().root_session_key,
            "chat-2",
            "the tree moves with it"
        );
        assert_eq!(
            mgr.graph(Some("chat-2"), 0)["nodes"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            mgr.graph(Some("chat-1"), 0)["nodes"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(mgr
            .read_log(&a.id, 50)
            .iter()
            .any(|e| e["event"] == json!("subagent.moved")));
        let busy = mgr.spawn(0, spec("sleep:3000"), &env).unwrap();
        let e = mgr
            .handle_app_request(&req(&busy.id, "chat-2"), &env, None)
            .unwrap_err();
        assert!(e.contains("still running"), "{e}");
        mgr.stop(&busy.id, "cancelled");
    }

    #[tokio::test]
    async fn adv_bulk_controls_pause_resume_and_stop_a_whole_chat() {
        let (mgr, _script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 1}));
        for i in 0..3 {
            mgr.spawn(
                0,
                SpawnSpec {
                    name: Some(format!("w{i}")),
                    ..spec("sleep:5000")
                },
                &env,
            )
            .unwrap();
        }
        let bulk = |op: &str| {
            mgr.handle_app_request(
                &json!({"action": "bulk", "op": op, "sessionKey": "chat-1"}),
                &env,
                None,
            )
        };
        let r = bulk("pause").unwrap();
        assert_eq!(r["ok"], json!(3), "{r}");
        for _ in 0..100 {
            if mgr.running_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            mgr.list().iter().all(|r| r.paused),
            "{:?}",
            mgr.list()
                .iter()
                .map(|r| (&r.status, r.paused))
                .collect::<Vec<_>>()
        );
        assert_eq!(mgr.running_count(), 0, "nothing runs while paused");
        let r = bulk("resume").unwrap();
        assert_eq!(r["ok"], json!(3), "{r}");
        assert!(mgr.list().iter().all(|r| !r.paused));
        let r = bulk("stop").unwrap();
        assert_eq!(r["ok"], json!(3), "{r}");
        let ids: Vec<String> = mgr.list().iter().map(|r| r.id.clone()).collect();
        mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
        assert!(mgr.list().iter().all(|r| !r.is_active()));
        let r = mgr
            .handle_app_request(
                &json!({"action": "bulk", "op": "delete", "ids": ids}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(r["ok"], json!(3));
        assert!(mgr.list().is_empty());
        assert!(bulk("explode").unwrap_err().contains("Unknown bulk op"));
    }

    #[tokio::test]
    async fn adv_app_spawn_batch_and_groups() {
        let (mgr, _script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let r = mgr
            .handle_app_request(
                &json!({"action": "spawnBatch", "mode": "race", "tasks": ["sleep:3000", "fast"]}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(r["mode"], json!("race"));
        let ids: Vec<String> = r["subagents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids.len(), 2);
        // The app's race is watched in the background.
        for _ in 0..200 {
            if ids.iter().all(|i| !mgr.get(i).unwrap().is_active()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let g = mgr
            .handle_app_request(
                &json!({"action": "groups", "sessionKey": "chat-1"}),
                &env,
                None,
            )
            .unwrap();
        let grp = &g["groups"][0];
        assert_eq!(grp["size"], json!(2));
        assert_eq!(grp["mode"], json!("race"));
        assert_eq!(grp["winner"], json!(ids[1]), "{g}");
        let graph = mgr.graph(Some("chat-1"), 0);
        assert_eq!(graph["groups"].as_array().unwrap().len(), 1);
        assert_eq!(graph["nodes"][0]["groupMode"], json!("race"));
        let e = mgr
            .handle_app_request(&json!({"action": "spawnBatch", "tasks": []}), &env, None)
            .unwrap_err();
        assert!(e.contains("empty"));
        let e = mgr
            .handle_app_request(
                &json!({"action": "spawnBatch", "mode": "chaos", "tasks": ["a"]}),
                &env,
                None,
            )
            .unwrap_err();
        assert!(e.contains("parallel, pipeline, race, review or gather"));
        let many: Vec<String> = (0..13).map(|i| format!("t{i}")).collect();
        let e = mgr
            .handle_app_request(&json!({"action": "spawnBatch", "tasks": many}), &env, None)
            .unwrap_err();
        assert!(e.contains("at most 12"), "{e}");
    }

    #[tokio::test]
    async fn adv_nested_pipeline_does_not_deadlock_at_one_slot() {
        let (mgr, _script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 1, "maxDepth": 2}));
        // The parent holds the only slot while its pipeline runs below it.
        let parent = mgr.spawn(0, spec("sleep:2500"), &env).unwrap();
        let p_env = ParentEnv {
            task_context: None,
            session_key: parent.session_key.clone(),
            ..env.clone()
        };
        let (out, err) = mgr
            .handle_tool(
                1,
                TOOL_SPAWN,
                &json!({"task": "", "tasks": ["one", "two"], "mode": "pipeline"}),
                p_env,
            )
            .await;
        assert!(!err, "{out}");
        assert_eq!(out.matches("finished after").count(), 2, "{out}");
        mgr.stop(&parent.id, "cancelled");
    }

    #[test]
    fn adv_spawn_tool_advertises_the_new_fields() {
        let defs = SubagentManager::tool_definitions();
        let props = &defs[0].input_schema["properties"];
        for k in ["tasks", "mode", "rounds", "context", "after", "handoff"] {
            assert!(props.get(k).is_some(), "missing {k}");
        }
        assert_eq!(
            props["mode"]["enum"],
            json!(["parallel", "pipeline", "race", "review", "gather"])
        );
    }

    #[test]
    fn adv_review_verdict_reads_the_last_line_only() {
        assert!(advanced::review_approves("Looks right.\n\nAPPROVED"));
        assert!(advanced::review_approves("ok\n**Approved.**\n\n"));
        assert!(!advanced::review_approves(
            "Do not write APPROVED yet.\nFix the intro."
        ));
        assert!(!advanced::review_approves(""));
        assert!(!advanced::review_approves("APPROVED\nbut one more thing"));
    }

    #[tokio::test]
    async fn adv_review_is_approved_in_round_one_and_marks_the_worker() {
        let (mgr, script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        // The mock echoes its prompt; the worker's report ends with APPROVED, and the
        // reviewer's prompt ends with that report, so the reviewer's last line approves.
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "", "tasks": ["draft it\nAPPROVED", "check it"], "mode": "review"}),
            &env,
        )
        .await;
        assert!(!err, "{out}");
        assert!(
            out.contains("review batch") && out.contains("approved the work in round 1 of 3"),
            "{out}"
        );
        let mut list = mgr.list();
        list.sort_by_key(|r| r.group_index);
        let (w, r) = (&list[0], &list[1]);
        assert_eq!((w.name.as_str(), r.name.as_str()), ("worker", "reviewer"));
        assert_eq!(r.depends_on, vec![w.id.clone()]);
        assert!(w.group_winner && !r.group_winner);
        assert_eq!(w.runs, 1);
        let p = prompts(&script);
        assert_eq!(p.len(), 2, "{p:?}");
        assert!(
            p[1].contains("you are the reviewer") && p[1].contains("done: draft it"),
            "{}",
            p[1]
        );
        let log = mgr.read_log(&r.id, 50);
        assert!(
            log.iter()
                .any(|e| e["event"] == json!("subagent.review_round")
                    && e["approved"] == json!(true)),
            "{log:?}"
        );
        let g = mgr.groups(None);
        assert_eq!(g[0]["mode"], json!("review"));
        assert_eq!(g[0]["winner"], json!(w.id));
    }

    #[tokio::test]
    async fn adv_review_sends_feedback_back_until_the_rounds_run_out() {
        let (mgr, script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "", "tasks": ["draft it", "check it"], "mode": "review", "rounds": 2, "name": "essay"}), &env).await;
        assert!(err, "not approved is reported as an error: {out}");
        assert!(
            out.contains("did not approve the work after 2 rounds"),
            "{out}"
        );
        let mut list = mgr.list();
        list.sort_by_key(|r| r.group_index);
        let (w, r) = (&list[0], &list[1]);
        assert_eq!(
            (w.name.as_str(), r.name.as_str()),
            ("essay-worker", "essay-reviewer")
        );
        assert_eq!((w.runs, r.runs), (2, 2), "each ran once per round");
        assert!(!w.group_winner);
        let p = prompts(&script);
        assert_eq!(p.len(), 4, "{p:?}");
        assert!(
            p[2].starts_with("The reviewer asked for changes (round 1 of 2)")
                && p[2].contains("you are the reviewer"),
            "the worker gets the feedback: {}",
            p[2]
        );
        assert!(
            p[3].starts_with("Round 2 of 2: here is the revised work")
                && p[3].contains("done: The reviewer asked"),
            "the reviewer gets the revision: {}",
            p[3]
        );
        let rounds: Vec<Value> = mgr
            .read_log(&r.id, 50)
            .into_iter()
            .filter(|e| e["event"] == json!("subagent.review_round"))
            .collect();
        assert_eq!(rounds.len(), 2);
        assert!(rounds.iter().all(|e| e["approved"] == json!(false)));
    }

    #[tokio::test]
    async fn adv_review_needs_two_briefs_and_sane_rounds() {
        let (mgr, _script, _app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "", "tasks": ["a", "b", "c"], "mode": "review"}),
            &env,
        )
        .await;
        assert!(err && out.contains("exactly two briefs"), "{out}");
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "", "tasks": ["a", "b"], "mode": "review", "rounds": 9}),
            &env,
        )
        .await;
        assert!(err && out.contains("`rounds` must be"), "{out}");
        assert!(mgr.list().is_empty(), "nothing started");
    }

    #[tokio::test]
    async fn adv_app_review_runs_in_the_background() {
        let (mgr, _script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let r = mgr.handle_app_request(&json!({"action": "spawnBatch", "mode": "review", "rounds": 1, "tasks": ["x\nAPPROVED", "y"]}), &env, None).unwrap();
        assert_eq!(r["mode"], json!("review"));
        let ids: Vec<String> = r["subagents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_string())
            .collect();
        mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !mgr.get(&ids[0]).unwrap().group_winner && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            mgr.get(&ids[0]).unwrap().group_winner,
            "the background loop approves the worker"
        );
    }

    #[tokio::test]
    async fn adv_gather_fans_out_then_one_agent_combines_every_report() {
        let (mgr, script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "market", "tasks": ["sleep:200", "prices", "combine"], "mode": "gather", "name": "Survey"}), &env).await;
        assert!(!err, "{out}");
        let mut list = mgr.list();
        list.sort_by_key(|r| r.group_index);
        let (a, b, g) = (&list[0], &list[1], &list[2]);
        assert_eq!(
            (a.name.as_str(), b.name.as_str(), g.name.as_str()),
            ("survey-1", "survey-2", "survey-gatherer")
        );
        assert!(
            a.depends_on.is_empty() && b.depends_on.is_empty(),
            "the parts run at once"
        );
        assert_eq!(
            g.depends_on,
            vec![a.id.clone(), b.id.clone()],
            "the gatherer waits for every part"
        );
        assert!(list
            .iter()
            .all(|r| r.group_mode.as_deref() == Some("gather") && r.status == "finished"));
        assert!(
            g.started_at >= a.finished_at.unwrap().max(b.finished_at.unwrap()),
            "it starts once the slowest part ended"
        );
        let p = prompts(&script);
        let pg = p
            .iter()
            .find(|x| x.contains("## Your part\ncombine"))
            .unwrap();
        assert!(
            pg.contains("you gather the results")
                && pg.contains("### survey-1")
                && pg.contains("### survey-2")
                && pg.contains("done: market\n\n## Your part\nprices"),
            "{pg}"
        );
        assert!(
            out.contains("gather batch")
                && out.contains("2 of 2 parts finished")
                && out.contains("combined report of \"survey-gatherer\""),
            "{out}"
        );
        assert_eq!(
            out.matches("finished after").count(),
            1,
            "only the combined report comes back: {out}"
        );
        let gr = mgr.graph(Some("chat-1"), 0);
        assert_eq!(gr["dependencyEdges"].as_array().unwrap().len(), 2, "{gr}");
    }

    #[tokio::test]
    async fn adv_gather_goes_on_with_the_parts_that_finished() {
        let (mgr, script, _app, env, _) = setup();
        mgr.set_settings(&json!({"maxParallel": 3}));
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "", "tasks": ["sleep:4000", "quick", "combine"], "mode": "gather", "wait": false}), &env).await;
        assert!(!err, "{out}");
        let mut list = mgr.list();
        list.sort_by_key(|r| r.group_index);
        assert_eq!(list[2].status, "queued", "waits for both parts");
        assert!(mgr.stop(&list[0].id, "cancelled"));
        let ids: Vec<String> = list.iter().map(|r| r.id.clone()).collect();
        mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
        assert_eq!(
            mgr.get(&list[2].id).unwrap().status,
            "finished",
            "one part failed, the gatherer still combines the rest"
        );
        let p = prompts(&script);
        let pg = p
            .iter()
            .find(|x| x.contains("you gather the results"))
            .unwrap();
        assert!(
            pg.contains("(did not finish; it ended as cancelled") && pg.contains("done: quick"),
            "{pg}"
        );
        // nothing finished: nothing to combine
        let (_o, _e) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "", "tasks": ["sleep:4000", "combine"], "mode": "gather", "wait": false, "name": "solo"}), &env).await;
        let part = mgr.list().into_iter().find(|r| r.name == "solo-1").unwrap();
        let gat = mgr
            .list()
            .into_iter()
            .find(|r| r.name == "solo-gatherer")
            .unwrap();
        assert!(mgr.stop(&part.id, "cancelled"));
        mgr.wait_for(
            &[part.id.clone(), gat.id.clone()],
            None,
            Duration::from_secs(5),
        )
        .await;
        let gat = mgr.get(&gat.id).unwrap();
        assert_eq!(gat.status, "cancelled");
        assert!(
            gat.error
                .as_deref()
                .unwrap()
                .contains("none of the agents it gathers from finished"),
            "{:?}",
            gat.error
        );
    }

    #[tokio::test]
    async fn adv_gather_needs_two_briefs_and_runs_from_the_app() {
        let (mgr, _script, _app, env, _) = setup();
        let (out, err) = run_tool(
            &mgr,
            TOOL_SPAWN,
            json!({"task": "", "tasks": ["only"], "mode": "gather"}),
            &env,
        )
        .await;
        assert!(err && out.contains("at least two briefs"), "{out}");
        assert!(mgr.list().is_empty(), "nothing started");
        mgr.set_settings(&json!({"maxParallel": 3}));
        let r = mgr
            .handle_app_request(
                &json!({"action": "spawnBatch", "mode": "gather", "tasks": ["a", "b", "c"]}),
                &env,
                None,
            )
            .unwrap();
        assert_eq!(r["mode"], json!("gather"));
        let ids: Vec<String> = r["subagents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_string())
            .collect();
        mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
        assert!(ids.iter().all(|i| mgr.get(i).unwrap().status == "finished"));
        assert_eq!(mgr.get(&ids[2]).unwrap().depends_on.len(), 2);
        let groups = mgr
            .handle_app_request(&json!({"action": "groups"}), &env, None)
            .unwrap();
        assert!(groups.to_string().contains("gather"), "{groups}");
    }
}
