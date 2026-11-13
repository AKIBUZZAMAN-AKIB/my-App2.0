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

mod cross_session;
mod data;
pub use data::{parse_parts, TrackedFile, DATA_PARTS};
pub use cross_session::{is_session_tool, AskRecord, ChatInfo, SESSION_TOOL_NAMES, TOOL_ASK_SESSION, TOOL_LIST_SESSIONS};

pub fn is_subagent_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
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
    /// Default total tokens (input + output, all steps) per run.
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
}

impl Default for SubagentSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_depth: 1,
            max_parallel: 3,
            default_token_budget: 200_000,
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
        }
    }
}

impl SubagentSettings {
    pub fn clamped(mut self) -> Self {
        self.max_depth = self.max_depth.min(3);
        self.max_parallel = self.max_parallel.clamp(1, 8);
        self.default_token_budget = self.default_token_budget.clamp(1_000, 5_000_000);
        self.default_max_steps = self.default_max_steps.clamp(1, 200);
        self.timeout_seconds = self.timeout_seconds.clamp(5, 3_600);
        self.default_memory = MemoryMode::parse(&self.default_memory)
            .unwrap_or(MemoryMode::Private)
            .as_str()
            .into();
        self.max_kept = self.max_kept.clamp(10, 500);
        self.max_queue = self.max_queue.clamp(0, 100);
        self.max_parallel_tools = self.max_parallel_tools.clamp(1, 16);
        self.lock_timeout_seconds = self.lock_timeout_seconds.clamp(5, 3_600);
        self.session_timeout_seconds = self.session_timeout_seconds.clamp(10, 1_800);
        self.session_token_budget = self.session_token_budget.clamp(1_000, 2_000_000);
        self.session_reply_max_chars = self.session_reply_max_chars.clamp(200, 20_000);
        self
    }
    fn apply_scheduler(&self) {
        crate::tool_scheduler::configure(self.parallel_read_tools, self.max_parallel_tools, self.lock_timeout_seconds);
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
        v["lastActiveAt"] = json!(self.finished_at.unwrap_or(self.started_at));
        if self.chat_deleted {
            v["chatDeleted"] = json!(true);
        }
        if with_report && !self.is_active() {
            v["report"] = json!(truncate_chars(self.result.as_deref().unwrap_or(""), REPORT_CAP));
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
    fn save(&self, session_key: &str, done: &RunDone, started_at: i64, max_steps: u32, tools_json: &str);
    fn clear(&self, session_key: &str);
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
    pub approval_senders: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<crate::types::ApprovalResponse>>>>,
    pub mcp_tools: Arc<Mutex<Vec<ToolDefinition>>>,
    pub mcp_pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<crate::types::McpToolResult>>>>,
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
                prior_messages: if req.prior_messages.is_empty() { None } else { Some(req.prior_messages) },
                approval_senders,
                steer_rx: req.steer_rx.clone(),
                mcp_tools,
                mcp_pending,
                webllm_pending,
                memory_provider: req.memory.clone(),
                skip_user_echo: false,
                session_key: req.params.session_key.clone(),
                subagents: Some(req.child.clone()),
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

    fn save(&self, session_key: &str, done: &RunDone, started_at: i64, max_steps: u32, tools_json: &str) {
        let Ok(conn) = crate::db::open_db(&self.config.db_path) else { return };
        let Ok(messages_json) = serde_json::to_string(&done.messages) else { return };
        let _ = crate::db::save_session(
            &conn,
            session_key,
            SESSION_AGENT_ID,
            &messages_json,
            Some(&done.model),
            Some(&done.provider),
            started_at,
            done.usage.as_ref(),
        );
        let _ = crate::db::save_session_constraints(&conn, session_key, Some(max_steps), Some(tools_json));
    }

    fn clear(&self, session_key: &str) {
        if let Ok(conn) = crate::db::open_db(&self.config.db_path) {
            let _ = crate::db::clear_session(&conn, session_key);
        }
    }

    fn list_chats(&self) -> Vec<ChatInfo> {
        let Ok(conn) = crate::db::open_db(&self.config.db_path) else { return Vec::new() };
        let raw = crate::db::list_sessions(&conn, "main").unwrap_or_else(|_| "[]".into());
        let items: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
        items
            .into_iter()
            .take(50)
            .filter_map(|v| {
                let key = v.get("sessionKey")?.as_str()?.to_string();
                let messages = crate::db::load_session_messages_raw(&conn, &key).unwrap_or_default();
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
        let Ok(conn) = crate::db::open_db(&self.config.db_path) else { return };
        let Ok(messages_json) = serde_json::to_string(&done.messages) else { return };
        let _ = crate::db::save_session(
            &conn,
            session_key,
            "main",
            &messages_json,
            Some(&done.model),
            Some(&done.provider),
            started_at,
            done.usage.as_ref(),
        );
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
    pub tools: Option<Vec<String>>,
    #[serde(alias = "tokenBudget")]
    pub token_budget: Option<u64>,
    #[serde(alias = "maxSteps")]
    pub max_steps: Option<u32>,
    pub memory: Option<String>,
    pub wait: Option<bool>,
    #[serde(alias = "timeoutSeconds")]
    pub timeout_seconds: Option<u64>,
    pub priority: Option<i32>,
    /// Continue a past sub-agent instead: its id or name, or true to reuse
    /// the latest one called `name`.
    pub reuse: Option<Value>,
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

impl SubagentManager {
    /// `state_dir` holds settings, the run registry and per-name memory. It
    /// sits beside the workspace (like the tool rules), so the agent's own
    /// file tools cannot edit it.
    pub fn new(state_dir: PathBuf, runner: Arc<dyn SubagentRunner>) -> Arc<Self> {
        let titles_path = state_dir.join("session_titles.json");
        let asks_path = state_dir.join("session_asks.json");
        let settings = fs_read_json::<SubagentSettings>(&state_dir.join("settings.json"))
            .unwrap_or_default()
            .clamped();
        let mut records = fs_read_json::<Vec<SubagentRecord>>(&state_dir.join("registry.json")).unwrap_or_default();
        // Anything still "running" was cut off when the app last closed.
        let mut changed = false;
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
        });
        mgr.settings().apply_scheduler();
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
        let mut current = serde_json::to_value(self.settings()).unwrap_or(json!({}));
        if let (Some(obj), Some(p)) = (current.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                obj.insert(k.clone(), v.clone());
            }
        }
        let next = serde_json::from_value::<SubagentSettings>(current).unwrap_or_default().clamped();
        *self.settings.lock().unwrap() = next.clone();
        fs_write_json(&self.state_dir.join("settings.json"), &next);
        next.apply_scheduler();
        // A higher parallel limit lets queued runs start now.
        self.pump();
        next
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
            .map(|(id, p)| {
                let r = recs.iter().find(|r| &r.id == id);
                (r.map(|r| r.priority).unwrap_or(0), r.map(|r| r.parent_session_key.clone()).unwrap_or_default(), p.seq, id.clone())
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
                let pos = order.iter().position(|id| id == &r.id).map(|i| i as u32 + 1);
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
            let cb = self.pending.lock().unwrap().get(&rec.id).and_then(|p| p.env.callback.clone());
            self.emit(&cb, "subagent.queued", &rec, json!({ "queuePosition": rec.queue_position, "queueLength": total }));
        }
    }

    /// Put a run in the queue (the record must already exist).
    fn enqueue(&self, id: &str, prompt: String, prior: PendingPrior, env: &ParentEnv) -> Result<SubagentRecord, String> {
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
            Pending { prompt, prior, env: env.clone(), done_tx: Arc::new(done_tx), done_rx, steers: Vec::new(), seq },
        );
        self.refresh_positions();
        self.persist();
        self.get(id).ok_or_else(|| "Sub-agent disappeared.".to_string())
    }

    /// Start or queue a run for an existing record.
    fn launch(self: &Arc<Self>, id: &str, prompt: String, prior: PendingPrior, env: &ParentEnv) -> Result<SubagentRecord, String> {
        let settings = self.settings();
        if self.running_count() >= settings.max_parallel as usize || self.queued_count() > 0 {
            let rec = self.enqueue(id, prompt, prior, env)?;
            self.pump();
            return Ok(self.get(id).unwrap_or(rec));
        }
        let prior = match prior {
            PendingPrior::Fresh => Vec::new(),
            PendingPrior::Resume => self.get(id).map(|r| self.runner.load_messages(&r.session_key)).unwrap_or_default(),
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
            if self.running_count() >= max {
                break;
            }
            let Some(next) = self.queue_order().into_iter().next() else { break };
            let Some(p) = self.pending.lock().unwrap().remove(&next) else { break };
            let prior = match p.prior {
                PendingPrior::Fresh => Vec::new(),
                PendingPrior::Resume => self.get(&next).map(|r| self.runner.load_messages(&r.session_key)).unwrap_or_default(),
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
            self.start_run(&rec, p.prompt, prior, &p.env, Some((p.done_tx, p.done_rx)), p.steers);
        }
        self.refresh_positions();
    }

    pub fn offers_tools_at(&self, depth: u32) -> bool {
        let s = self.settings.lock().unwrap();
        s.enabled && depth < s.max_depth
    }

    pub fn get(&self, id: &str) -> Option<SubagentRecord> {
        self.records.lock().unwrap().iter().find(|r| r.id == id).cloned()
    }

    pub fn list(&self) -> Vec<SubagentRecord> {
        let mut v = self.records.lock().unwrap().clone();
        v.reverse(); // newest first
        v
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
                        "task": {"type": "string", "description": "Complete, self-contained brief: goal, context, constraints, and the shape of the report you want back."},
                        "name": {"type": "string", "description": "Short handle such as 'researcher' or 'test-fixer'. Sub-agents with the same name share a memory store."},
                        "role": {"type": "string", "description": "One line describing the sub-agent's role or expertise."},
                        "system_prompt": {"type": "string", "description": "Optional extra instructions for how it should work."},
                        "tools": {"type": "array", "items": {"type": "string"}, "description": "Tool names it may use; must be tools you have. Default: all of your tools except UI tools. Give only what it needs."},
                        "model": {"type": "string", "description": "Optional model id. Default: the same model as you."},
                        "provider": {"type": "string", "description": "Optional provider id for `model`. Default: your provider."},
                        "token_budget": {"type": "integer", "minimum": 1000, "description": "Total tokens (input + output, all steps) before it is stopped."},
                        "max_steps": {"type": "integer", "minimum": 1, "description": "Maximum model calls."},
                        "memory": {"type": "string", "enum": ["private", "read_parent", "shared"], "description": "private: its own memory only. read_parent: its own memory, plus read access to the main memory. shared: reads and writes the main memory."},
                        "wait": {"type": "boolean", "description": "true (default): wait for the report. false: run in the background and return its id."},
                        "priority": {"type": "integer", "description": "Queue priority -10..10 (default 0). When the parallel limit is reached, new sub-agents wait in a queue; higher priority starts first."},
                        "reuse": {"description": "Continue an earlier sub-agent instead of starting a new one: its id or name, or true to reuse the latest one with this `name`. It keeps its chat history and memory, gets `task` as its next message, and follows your current tools and limits. If none matches, a new one starts.", "anyOf": [{"type": "string"}, {"type": "boolean"}]}
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
- Sub-agents persist across turns and app restarts. Reuse one (message_subagent with its id or name, or spawn_subagent with reuse) when the new work continues its earlier task or needs what it already read or remembers: a follow-up, a fix to its own change, more of the same research. Spawn a new one for unrelated work, when a fresh unbiased view matters (a review of its own work), or when its history was long or went wrong. Use list_subagents (name, query, recent) to find past ones.\n\
- Limits: {} running at once; by default {} tokens, {} steps and {} seconds each.",
            s.max_parallel, s.default_token_budget, s.default_max_steps, s.timeout_seconds
        )
    }

    fn subagent_system_prompt(rec: &SubagentRecord, parent_prompt: &str) -> String {
        let role = rec.role.as_deref().map(|r| format!(" ({})", r.trim())).unwrap_or_default();
        let mut p = format!(
            "You are \"{}\"{}, a sub-agent. Another agent delegated one task to you.\n\
- Work only on that task, using your tools. You cannot see the other agent's conversation and you cannot ask the user questions. If something is missing, make a reasonable assumption and say so in your report.\n\
- Be efficient: you have at most {} steps and {} tokens.\n\
- Finish with a final report in plain text: what you found or did, the key details (file paths, values, commands), and anything left open. The report is all the other agent will see.",
            rec.name, role, rec.max_steps, rec.token_budget
        );
        if let Some(extra) = rec.system_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
            p.push_str("\n\n## Instructions from the delegating agent\n");
            p.push_str(extra.trim());
        }
        if !parent_prompt.trim().is_empty() {
            p.push_str("\n\n---\n\n");
            p.push_str(parent_prompt);
        }
        p
    }

    // ── Spawning and running ─────────────────────────────────────────────

    /// Start a sub-agent for a parent at `parent_depth`. Must be called inside
    /// a tokio runtime.
    pub fn spawn(self: &Arc<Self>, parent_depth: u32, spec: SpawnSpec, env: &ParentEnv) -> Result<SubagentRecord, String> {
        let rec = self.spawn_record_only(parent_depth, spec, env)?;
        let prompt = rec.task.clone();
        self.launch(&rec.id, prompt, PendingPrior::Fresh, env).map_err(|e| {
            self.records.lock().unwrap().retain(|r| r.id != rec.id);
            self.persist();
            e
        })
    }

    /// Validate a spawn and save its record (status "running" placeholder);
    /// the caller starts it with `launch`.
    fn spawn_record_only(self: &Arc<Self>, parent_depth: u32, spec: SpawnSpec, env: &ParentEnv) -> Result<SubagentRecord, String> {
        let settings = self.settings();
        if !settings.enabled {
            return Err("Sub-agents are turned off in settings.".into());
        }
        if parent_depth >= settings.max_depth {
            return Err(format!(
                "A sub-agent can't start another sub-agent here (delegation depth limit is {}). Do the work yourself.",
                settings.max_depth
            ));
        }
        let task = spec.task.trim();
        if task.is_empty() {
            return Err("`task` is required: give the sub-agent a complete brief.".into());
        }
        let at_limit = self.running_count() >= settings.max_parallel as usize || self.queued_count() > 0;
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
        let now = now_ms();
        let rec = SubagentRecord {
            id: id.clone(),
            name,
            role: spec.role.map(|r| truncate_chars(r.trim(), 200)).filter(|r| !r.is_empty()),
            task: truncate_chars(task, TASK_CAP),
            status: "running".into(),
            parent_session_key: env.session_key.clone(),
            session_key: format!("subagent:{}", id),
            depth: parent_depth + 1,
            provider: spec.provider.filter(|s| !s.trim().is_empty()).or_else(|| env.provider.clone()),
            model: spec.model.filter(|s| !s.trim().is_empty()).or_else(|| env.model.clone()),
            system_prompt: spec.system_prompt.map(|s| truncate_chars(&s, 8_000)),
            tools,
            memory_mode: memory_mode.as_str().into(),
            token_budget: spec.token_budget.unwrap_or(settings.default_token_budget).clamp(1_000, 5_000_000),
            max_steps: spec.max_steps.unwrap_or(settings.default_max_steps).clamp(1, 200),
            timeout_seconds: spec.timeout_seconds.unwrap_or(settings.timeout_seconds).clamp(1, 3_600),
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
        let child = SubagentCtx { manager: self.clone(), depth: rec.depth };
        let mut allowed = rec.tools.clone();
        if child.offers_tools() {
            allowed.extend(TOOL_NAMES.iter().map(|s| s.to_string()));
        }
        let tools_json = serde_json::to_string(&allowed).unwrap_or_else(|_| "[]".into());
        let params = SendMessageParams {
            prompt,
            session_key: rec.session_key.clone(),
            model: rec.model.clone(),
            provider: rec.provider.clone(),
            system_prompt: Self::subagent_system_prompt(rec, &env.system_prompt),
            max_turns: Some(rec.max_steps),
            allowed_tools_json: Some(tools_json.clone()),
            prior_messages_json: None,
            attachments_json: None,
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
        let req = RunRequest {
            id: rec.id.clone(),
            params,
            prior_messages: prior.clone(),
            callback: events,
            abort: abort.clone(),
            steer_rx: Arc::new(Mutex::new(Some(steer_rx))),
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
            let outcome = tokio::time::timeout(Duration::from_millis(timeout_ms + 15_000), fut).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            let reason = stop_reason.lock().unwrap().clone();
            let partial = text_buf.lock().unwrap().trim().to_string();
            let (status, result, error) = match outcome {
                Ok(Ok(done)) => {
                    mgr.runner.save(&session_key, &done, run_started, max_steps, &tools_json);
                    let text = last_assistant_text(&done.messages).unwrap_or_default();
                    let status = match reason.as_deref() {
                        Some(r) => r.to_string(),
                        None if elapsed_ms >= timeout_ms => "timeout".into(),
                        None => "finished".into(),
                    };
                    let text = if text.trim().is_empty() { partial.clone() } else { text };
                    (status, text, None)
                }
                Ok(Err(err)) => {
                    let cancelled = matches!(err, NativeAgentError::Cancelled);
                    let mut messages = prior;
                    messages.push(Message::user(&task_prompt));
                    if !partial.is_empty() {
                        messages.push(Message { role: Role::Assistant, content: MessageContent::Text(partial.clone()) });
                    }
                    mgr.runner.save(
                        &session_key,
                        &RunDone { messages, model: String::new(), provider: String::new(), usage: None },
                        run_started,
                        max_steps,
                        &tools_json,
                    );
                    match (reason, cancelled) {
                        (Some(r), _) => (r, partial, None),
                        (None, true) => ("cancelled".to_string(), partial, None),
                        (None, false) => ("error".to_string(), partial, Some(err.to_string())),
                    }
                }
                Err(_) => ("timeout".to_string(), partial, None),
            };
            mgr.finish(&id, &status, result, error, &app);
        });
    }

    fn finish(self: &Arc<Self>, id: &str, status: &str, result: String, error: Option<String>, app: &Option<Arc<dyn NativeEventCallback>>) {
        let note = match status {
            "budget_exceeded" => Some("Stopped: it used up its token budget."),
            "timeout" => Some("Stopped: it hit its time limit."),
            "max_steps" => Some("Stopped: it reached its step limit."),
            "cancelled" => Some("Stopped before it finished."),
            _ => None,
        };
        let rec = self.update(id, |r| {
            r.status = status.to_string();
            r.result = Some(result);
            r.error = error.or_else(|| note.map(|n| n.to_string()));
            r.finished_at = Some(now_ms());
        });
        self.persist();
        let live = self.live.lock().unwrap().remove(id);
        if let Some(rec) = rec {
            let event = match status {
                "finished" => "subagent.finished",
                "error" => "subagent.error",
                _ => "subagent.cancelled",
            };
            self.emit(app, event, &rec, json!({ "report": truncate_chars(rec.result.as_deref().unwrap_or(""), 2_000) }));
        }
        // A delete asked for while it ran: its transcript is saved by now.
        self.run_deferred_delete(id, app);
        if let Some(live) = live {
            let _ = live._done.send(true);
        }
        self.pump();
    }

    fn emit(&self, cb: &Option<Arc<dyn NativeEventCallback>>, event: &str, rec: &SubagentRecord, extra: Value) {
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
            "sessionKey": rec.session_key,
            "steps": rec.steps,
            "toolCalls": rec.tool_calls,
            "inputTokens": rec.input_tokens,
            "outputTokens": rec.output_tokens,
            "totalTokens": rec.total_tokens(),
            "tokenBudget": rec.token_budget,
            "maxSteps": rec.max_steps,
            "priority": rec.priority,
        });
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
                self.emit(&p.env.callback, "subagent.cancelled", &rec, json!({ "report": "", "whileQueued": true }));
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
        let (queued, running): (Vec<String>, Vec<String>) =
            ids.into_iter().partition(|id| self.pending.lock().unwrap().contains_key(id));
        queued.into_iter().chain(running).filter(|id| self.stop(id, "cancelled")).collect()
    }

    /// Follow-up: steer a running sub-agent, or resume a finished one.
    pub fn message(self: &Arc<Self>, id: &str, text: &str, env: &ParentEnv) -> Result<(SubagentRecord, bool), String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("`message` is empty.".into());
        }
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
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
        self.rerun_existing(id, text.to_string(), PendingPrior::Resume, env, false).map(|r| (r, true))
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
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running or queued. Stop it first.".into());
        }
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
        self.launch(id, prompt, prior, env).map_err(|e| {
            // Put the old state back so nothing looks half-started.
            self.update(id, |r| *r = before.clone());
            self.persist();
            e
        })
    }

    /// Keep only tools the parent may use now (never ui__ / sub-agent tools).
    /// An env without a tool list (tests, older callers) keeps the list.
    fn narrow_to_parent(tools: &[String], env: &ParentEnv) -> Vec<String> {
        let base = tools.iter().filter(|t| !t.starts_with("ui__") && !is_subagent_tool(t));
        if env.tool_names.is_empty() {
            return base.cloned().collect();
        }
        base.filter(|t| env.tool_names.contains(t)).cloned().collect()
    }

    /// spawn_subagent with `reuse`: continue a past sub-agent with its
    /// history and memory when one matches, else start a new one.
    pub fn spawn_or_reuse(self: &Arc<Self>, parent_depth: u32, spec: SpawnSpec, env: &ParentEnv) -> Result<(SubagentRecord, &'static str), String> {
        let key = match &spec.reuse {
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
            Some(Value::Bool(true)) => spec.name.clone(),
            _ => None,
        };
        let Some(key) = key else {
            return self.spawn(parent_depth, spec, env).map(|r| (r, "new"));
        };
        let Some(found) = self.find_reusable(&key, &env.session_key) else {
            return self.spawn(parent_depth, spec, env).map(|r| (r, "not_found"));
        };
        let task = spec.task.trim();
        if task.is_empty() {
            return Err("`task` is required: say what the reused sub-agent should do next.".into());
        }
        // Optional new limits for this run (clamped like a new spawn).
        if spec.token_budget.is_some() || spec.max_steps.is_some() || spec.priority.is_some() || spec.tools.is_some() {
            let requested = spec.tools.clone();
            let ok = self.update(&found.id, |r| {
                if let Some(b) = spec.token_budget { r.token_budget = b.clamp(1_000, 5_000_000); }
                if let Some(m) = spec.max_steps { r.max_steps = m.clamp(1, 200); }
                if let Some(p) = spec.priority { r.priority = p.clamp(-10, 10); }
                if let Some(req) = &requested {
                    if !req.is_empty() { r.tools = req.clone(); }
                }
            });
            if ok.is_some() { self.persist(); }
        }
        let (rec, resumed) = self.message(&found.id, task, env)?;
        Ok((rec, if resumed { "resumed" } else { "steered" }))
    }

    /// Run the original task again from a clean context.
    pub fn retry(self: &Arc<Self>, id: &str, env: &ParentEnv) -> Result<SubagentRecord, String> {
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running. Stop it first.".into());
        }
        let task = rec.task.clone();
        let r = self.rerun_existing(id, task, PendingPrior::Fresh, env, true)?;
        self.runner.clear(&rec.session_key);
        Ok(r)
    }

    /// Find the n-th real user message (typed text, not tool results).
    /// Returns (index into messages, its text).
    fn user_turns(messages: &[Message]) -> Vec<(usize, String)> {
        messages
            .iter()
            .enumerate()
            .filter(|(_, m)| matches!(m.role, crate::types::Role::User))
            .filter_map(|(i, m)| match &m.content {
                MessageContent::Text(t) => Some((i, t.clone())),
                MessageContent::Blocks(blocks) => {
                    if blocks.iter().any(|b| matches!(b, crate::types::ContentBlock::ToolResult { .. })) {
                        return None;
                    }
                    let t: Vec<String> = blocks
                        .iter()
                        .filter_map(|b| if let crate::types::ContentBlock::Text { text } = b { Some(text.clone()) } else { None })
                        .collect();
                    if t.is_empty() { None } else { Some((i, t.join("\n"))) }
                }
            })
            .collect()
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
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
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
        let (idx, original) = turns.get(k).cloned().ok_or_else(|| format!("There is no user message number {} (it has {}).", k + 1, turns.len()))?;
        let prompt = match text.map(str::trim) {
            Some("") => return Err("The edited message is empty.".into()),
            Some(t) => t.to_string(),
            None => original,
        };
        if k == 0 && text.is_some() {
            self.update(id, |r| r.task = prompt.clone());
        }
        let prior = messages[..idx].to_vec();
        self.rerun_existing(id, prompt, PendingPrior::Exact(prior), env, false)
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
        let src = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        let spec = SpawnSpec {
            name: Some(src.name.clone()),
            task: task.map(str::to_string).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| src.task.clone()),
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
            rec = self.update(&rec.id, |r| r.forked_from = Some(src.id.clone())).unwrap_or(rec);
            self.persist();
            return Ok(rec);
        }
        // Copy the conversation, then continue it with the new message.
        let history = self.runner.load_messages(&src.session_key);
        let prompt = spec.task.clone();
        let spec2 = SpawnSpec { task: "(continued from an earlier sub-agent)".into(), ..spec };
        let rec = self.spawn_record_only(parent_depth, spec2, env)?;
        self.update(&rec.id, |r| {
            r.forked_from = Some(src.id.clone());
            r.task = prompt.clone();
        });
        self.persist();
        self.launch(&rec.id, prompt, PendingPrior::Exact(history), env)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running. Stop it first.".into());
        }
        self.runner.clear(&rec.session_key);
        self.remove_log(id);
        self.records.lock().unwrap().retain(|r| r.id != id);
        self.persist();
        Ok(())
    }

    /// Wait until none of `ids` is running. Stops them if the parent is
    /// cancelled (or the waiting future is dropped because of it).
    pub async fn wait_for(self: &Arc<Self>, ids: &[String], parent_abort: Option<Arc<Mutex<bool>>>, timeout: Duration) -> WaitEnd {
        let mut receivers: Vec<watch::Receiver<bool>> = {
            let live = self.live.lock().unwrap();
            let pending = self.pending.lock().unwrap();
            ids.iter()
                .filter_map(|id| live.get(id).map(|l| l.done_rx.clone()).or_else(|| pending.get(id).map(|p| p.done_rx.clone())))
                .collect()
        };
        let mut guard = StopOnDrop { manager: self, ids: ids.to_vec(), armed: true };
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

    pub async fn handle_tool(self: &Arc<Self>, parent_depth: u32, tool: &str, input: &Value, env: ParentEnv) -> (String, bool) {
        match tool {
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
                    let (out, err) = self.wait_and_report(&[rec.id.clone()], &env, None).await;
                    return (format!("{}{}", lead, out), err);
                }
                if !wait {
                    let how = if rec.status == "queued" {
                        format!("Queued sub-agent \"{}\" (id {}, position {} in the queue; it starts when a slot frees)", rec.name, rec.id, rec.queue_position.unwrap_or(1))
                    } else {
                        format!("Started sub-agent \"{}\" (id {}) in the background", rec.name, rec.id)
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
                let (out, err) = self.wait_and_report(&[rec.id.clone()], &env, None).await;
                (format!("{}{}", lead, out), err)
            }
            TOOL_LIST => {
                let ids: Option<Vec<String>> = input.get("ids").and_then(|v| serde_json::from_value(v.clone()).ok());
                let wait = input.get("wait").and_then(Value::as_bool).unwrap_or(false);
                let status = input.get("status").and_then(Value::as_str).unwrap_or("all").to_string();
                let timeout = input.get("timeout_seconds").and_then(Value::as_u64);
                let mine = |r: &SubagentRecord| r.parent_session_key == env.session_key;
                if wait {
                    let targets: Vec<String> = match &ids {
                        Some(ids) => ids.clone(),
                        None => self.list().into_iter().filter(|r| mine(r) && r.is_active()).map(|r| r.id).collect(),
                    };
                    if targets.is_empty() {
                        return ("No sub-agents of yours are running.".into(), false);
                    }
                    return self.wait_and_report(&targets, &env, timeout).await;
                }
                let _ = &status;
                let filtered = input.get("name").is_some() || input.get("query").is_some() || input.get("recent").is_some() || input.get("scope").is_some();
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
                    let none = if filtered { "No sub-agents match that filter." } else { "You have no sub-agents in this chat yet." };
                    let hint = if cross && !self.settings().reuse_across_chats { " Sub-agents from other chats are hidden: the user has not turned on reuse across chats." } else { "" };
                    return (format!("{}{}", none, hint), false);
                }
                (serde_json::to_string_pretty(&items).unwrap_or_default(), false)
            }
            TOOL_MESSAGE => {
                let key = input.get("id").and_then(Value::as_str).or_else(|| input.get("name").and_then(Value::as_str)).unwrap_or("");
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
                            if self.stop(id, "cancelled") { vec![id.to_string()] } else { vec![] }
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

    async fn wait_and_report(self: &Arc<Self>, ids: &[String], env: &ParentEnv, timeout_s: Option<u64>) -> (String, bool) {
        let settings = self.settings();
        let one = settings
            .timeout_seconds
            .max(ids.iter().filter_map(|id| self.get(id)).map(|r| r.timeout_seconds).max().unwrap_or(0));
        // Queued runs wait for a slot first: allow one run-length per queue "round".
        let rounds = 1 + (self.queued_count() as u64).div_ceil(settings.max_parallel.max(1) as u64);
        let limit = one * rounds + 30;
        let timeout = Duration::from_secs(timeout_s.unwrap_or(limit).clamp(1, limit));
        let end = self.wait_for(ids, env.abort.clone(), timeout).await;
        if end == WaitEnd::ParentCancelled {
            return ("Cancelled by the user; the sub-agent was stopped.".into(), true);
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
            let secs = r.finished_at.map(|f| (f - r.started_at).max(0) / 1000).unwrap_or(0);
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
            s.push_str("\nReport:\n");
            s.push_str(if report.is_empty() { "(no report)" } else { report });
            parts.push(truncate_chars(&s, REPORT_CAP));
        }
        (parts.join("\n\n---\n\n"), all_failed)
    }

    // ── Memory store (per sub-agent name) ────────────────────────────────

    fn memory_path(&self, name: &str) -> PathBuf {
        let safe = sanitize_name(name);
        self.state_dir.join("memory").join(format!("{}.json", if safe.is_empty() { "agent" } else { &safe }))
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
            entries.push(MemoryEntry { key, text, metadata, updated_at: now_ms() });
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
        let words: Vec<&str> = q.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 1).collect();
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
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(b.0.updated_at.cmp(&a.0.updated_at)));
        scored.truncate(limit.max(1));
        scored
    }

    /// Every memory store that exists, by sub-agent name.
    pub fn memory_names(&self) -> Vec<String> {
        let dir = self.state_dir.join("memory");
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().to_string()))
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
        let id = req.get("id").and_then(Value::as_str).unwrap_or("");
        match action {
            // ── Cross-session (feature "crossSession") ──
            "chats" => {
                let exclude = req.get("excludeSessionKey").and_then(Value::as_str);
                Ok(json!({ "chats": self.list_chats(exclude) }))
            }
            "titles" => Ok(json!({ "count": self.set_session_titles(req.get("titles").unwrap_or(&Value::Null)) })),
            "asks" => {
                let key = req.get("sessionKey").and_then(Value::as_str);
                let items: Vec<AskRecord> = self
                    .ask_history()
                    .into_iter()
                    .filter(|a| key.map_or(true, |k| a.caller_session_key == k || a.target_session_key == k))
                    .collect();
                Ok(json!({ "asks": items }))
            }
            "cancelAsk" => {
                let target = req.get("targetSessionKey").and_then(Value::as_str).unwrap_or("");
                let flag = self.user_ask_aborts.lock().unwrap().get(target).cloned();
                if let Some(f) = &flag {
                    set_abort(f);
                }
                Ok(json!({ "cancelled": flag.is_some() }))
            }
            "list" => {
                let status = req.get("status").and_then(Value::as_str).unwrap_or("all");
                let parent = req.get("parentSessionKey").and_then(Value::as_str);
                let name = req.get("name").and_then(Value::as_str).map(sanitize_name).filter(|n| !n.is_empty());
                let query = req.get("query").and_then(Value::as_str).map(str::to_lowercase).filter(|q| !q.trim().is_empty());
                let items: Vec<SubagentRecord> = self
                    .list()
                    .into_iter()
                    .filter(|r| parent.map_or(true, |p| r.parent_session_key == p))
                    .filter(|r| name.as_ref().map_or(true, |n| &r.name == n))
                    .filter(|r| query.as_ref().map_or(true, |q| r.task.to_lowercase().contains(q) || r.name.contains(q.as_str())))
                    .filter(|r| match status {
                        "running" => r.is_running(),
                        "queued" => r.status == "queued",
                        "active" => r.is_active(),
                        "finished" => !r.is_active(),
                        _ => true,
                    })
                    .collect();
                Ok(json!({ "subagents": items, "running": self.running_count(), "queued": self.queued_count(), "settings": self.settings() }))
            }
            "get" => {
                let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
                let transcript = self.runner.load_messages(&rec.session_key);
                Ok(json!({ "subagent": rec, "transcript": transcript, "memory": self.memory_entries(&rec.name) }))
            }
            "spawn" => {
                let mut spec: SpawnSpec = serde_json::from_value(req.clone()).map_err(|e| format!("Invalid spawn request: {}", e))?;
                spec.wait = Some(false);
                let (rec, how) = self.spawn_or_reuse(0, spec, env)?;
                Ok(json!({ "subagent": rec, "reuse": how }))
            }
            // Per-part deletion (feature "subagentData").
            "deleteData" => self.delete_data_request(req),
            "log" => {
                let limit = req.get("limit").and_then(Value::as_u64).unwrap_or(200).clamp(1, 2_000) as usize;
                Ok(json!({ "id": id, "log": self.read_log(id, limit) }))
            }
            "find" => {
                let session = req.get("parentSessionKey").and_then(Value::as_str).unwrap_or(&env.session_key);
                let key = req.get("key").or_else(|| req.get("name")).and_then(Value::as_str).unwrap_or("");
                Ok(json!({ "subagent": self.find_reusable(key, session) }))
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
                let (rec, resumed) = self.message(id, text, env)?;
                Ok(json!({ "subagent": rec, "resumed": resumed }))
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
                let text = req.get("message").and_then(Value::as_str).ok_or("`message` is required.")?;
                Ok(json!({ "subagent": self.regenerate(id, turn, Some(text), env)? }))
            }
            // A new sub-agent from this one: same settings, same or edited task.
            "fork" | "rerun" => {
                let task = req.get("task").and_then(Value::as_str);
                let keep = req.get("keepHistory").and_then(Value::as_bool).unwrap_or(false);
                Ok(json!({ "subagent": self.fork(0, id, task, keep, env)? }))
            }
            "priority" => {
                let p = req.get("priority").and_then(Value::as_i64).unwrap_or(0).clamp(-10, 10) as i32;
                let rec = self.update(id, |r| r.priority = p).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
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
                let name = req.get("name").and_then(Value::as_str).map(str::to_string).or_else(|| self.get(id).map(|r| r.name));
                let op = req.get("op").and_then(Value::as_str).unwrap_or("list");
                let Some(name) = name else {
                    return Ok(json!({ "names": self.memory_names() }));
                };
                match op {
                    "list" => Ok(json!({ "name": name, "entries": self.memory_entries(&name) })),
                    "clear" => Ok(json!({ "name": name, "cleared": self.memory_clear(&name) })),
                    "delete" => {
                        let key = req.get("key").and_then(Value::as_str).ok_or("`key` is required.")?;
                        Ok(json!({ "name": name, "deleted": self.memory_forget(&name, key) }))
                    }
                    "promote" => {
                        let main = main_memory.ok_or("The main memory isn't available.")?;
                        let key = req.get("key").and_then(Value::as_str);
                        let mut promoted = 0;
                        for e in self.memory_entries(&name).into_iter().filter(|e| key.map_or(true, |k| e.key == k)) {
                            let meta = json!({ "promotedFrom": name, "subagentMetadata": e.metadata });
                            let out = main.store(e.key.clone(), e.text.clone(), Some(meta.to_string()));
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
            "settings" => {
                let settings = match req.get("settings") {
                    Some(patch) if patch.is_object() => self.set_settings(patch),
                    _ => self.settings(),
                };
                Ok(json!({ "settings": settings }))
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
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok())
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
                let input = payload.get("inputTokens").and_then(Value::as_u64).unwrap_or(0);
                let output = payload.get("outputTokens").and_then(Value::as_u64).unwrap_or(0);
                let Some(rec) = self.manager.update(&self.id, |r| {
                    r.input_tokens += input;
                    r.output_tokens += output;
                    r.steps += 1;
                }) else {
                    return;
                };
                let preview = {
                    let buf = self.text_buf.lock().unwrap();
                    let tail: String = buf.chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
                    tail
                };
                self.manager.emit(&self.app, "subagent.step", &rec, json!({ "preview": preview }));
                self.manager.emit(&self.app, "subagent.usage", &rec, json!({ "stepInputTokens": input, "stepOutputTokens": output }));
                if rec.total_tokens() >= rec.token_budget {
                    self.set_reason("budget_exceeded");
                    set_abort(&self.abort);
                }
            }
            "tool_use" => {
                let tool = payload.get("toolName").and_then(Value::as_str).unwrap_or("").to_string();
                if let Some(args) = payload.get("args") {
                    self.manager.track_tool_use(&self.id, &tool, args);
                }
                // A new tool round: the final report is the text after it.
                self.text_buf.lock().unwrap().clear();
                if let Some(rec) = self.manager.update(&self.id, |r| {
                    r.tool_calls += 1;
                    r.last_tool = Some(tool.clone());
                }) {
                    let args = payload.get("args").map(|a| truncate_chars(&a.to_string(), 300)).unwrap_or_default();
                    self.manager.emit(&self.app, "subagent.tool_call", &rec, json!({ "tool": tool, "toolCallId": payload.get("toolCallId"), "args": args }));
                }
            }
            "tool_result" => {
                if let Some(rec) = self.manager.get(&self.id) {
                    let is_error = payload.pointer("/result/isError").and_then(Value::as_bool).unwrap_or(false);
                    self.manager.emit(&self.app, "subagent.tool_result", &rec, json!({ "tool": payload.get("toolName"), "toolCallId": payload.get("toolCallId"), "isError": is_error }));
                }
            }
            "max_turns_reached" => self.set_reason("max_steps"),
            "agent.background_timeout" => self.set_reason("timeout"),
            "approval_request" | "mcp_tool_call" => {
                let mut p = payload.clone();
                if let Some(obj) = p.as_object_mut() {
                    obj.insert("subagent".into(), json!({ "id": self.id, "name": self.name }));
                    obj.insert("subagentSessionKey".into(), json!(self.session_key));
                    obj.insert("sessionKey".into(), json!(self.parent_session_key));
                }
                if event_type == "approval_request" {
                    if let Some(rec) = self.manager.get(&self.id) {
                        self.manager.emit(&self.app, "subagent.approval_needed", &rec, json!({ "request": payload }));
                    }
                }
                if let Some(app) = &self.app {
                    app.on_event(event_type, p.to_string());
                }
            }
            t if t.starts_with("webllm") => {
                let mut p = payload.clone();
                if let Some(obj) = p.as_object_mut() {
                    obj.insert("subagent".into(), json!({ "id": self.id, "name": self.name }));
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
    fn search_all(&self, query: &str, limit: u32, parent_search: impl Fn(&dyn MemoryProvider) -> String) -> String {
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
        json!({ "success": true, "key": key }).to_string()
    }

    fn recall(&self, query: String, limit: u32) -> String {
        self.search_all(&query, limit, |p| p.recall(query.clone(), limit))
    }

    fn forget(&self, key: String) -> String {
        let removed = self.manager.memory_forget(&self.name, &key);
        json!({ "success": removed, "key": key }).to_string()
    }

    fn search(&self, query: String, max_results: u32) -> String {
        self.search_all(&query, max_results, |p| p.search(query.clone(), max_results))
    }

    fn list(&self, prefix: Option<String>, limit: Option<u32>) -> String {
        // The engine expects an array of key strings here.
        let limit = limit.unwrap_or(100).max(1) as usize;
        let mut seen = HashSet::new();
        let mut out: Vec<Value> = Vec::new();
        for e in self.manager.memory_entries(&self.name).into_iter().rev() {
            if prefix.as_deref().map_or(true, |p| e.key.starts_with(p)) && seen.insert(e.key.clone()) {
                out.push(json!(e.key));
            }
        }
        if let Some(parent) = &self.parent {
            if let Ok(Value::Array(keys)) = serde_json::from_str::<Value>(&parent.list(prefix.clone(), Some(limit as u32))) {
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
            self.0.lock().unwrap().push((event_type, serde_json::from_str(&payload_json).unwrap_or(Value::Null)));
        }
    }
    impl AppEvents {
        fn named(&self, name: &str) -> Vec<Value> {
            self.0.lock().unwrap().iter().filter(|(e, _)| e == name).map(|(_, p)| p.clone()).collect()
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
            let hits: Vec<Value> = self.0.lock().unwrap().iter().filter(|(k, t)| k.contains(&query) || t.contains(&query))
                .map(|(k, t)| json!({"key": k, "text": t, "score": 1.0})).collect();
            Value::Array(hits).to_string()
        }
        fn forget(&self, _key: String) -> String { json!({"success": true}).to_string() }
        fn search(&self, query: String, limit: u32) -> String { self.recall(query, limit) }
        fn list(&self, _p: Option<String>, _l: Option<u32>) -> String {
            Value::Array(self.0.lock().unwrap().iter().map(|(k, _)| json!(k)).collect()).to_string()
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
    }

    impl SubagentRunner for Arc<Script> {
        fn run(&self, req: RunRequest) -> RunFuture {
            let me = self.clone();
            Box::pin(async move {
                me.requests.lock().unwrap().push((req.params.prompt.clone(), req.params.allowed_tools_json.clone(), req.params.system_prompt.clone()));
                let now = me.concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                me.max_concurrent.fetch_max(now, Ordering::SeqCst);
                let _dec = Dec(&me.concurrent);
                let full_prompt = req.params.prompt.clone();
                // A cross-session note wraps the message: act on the message.
                let prompt = if full_prompt.starts_with("[Message from") {
                    full_prompt.split_once("\n\n").map(|x| x.1.to_string()).unwrap_or_default()
                } else {
                    full_prompt.clone()
                };
                let cb = req.callback.clone();
                let aborted = || async { *req.abort.lock().await };
                let mut reply = format!("done: {prompt}");
                if prompt == "whatdoyouknow" {
                    let first = req.prior_messages.first().map(|m| match &m.content { MessageContent::Text(t) => t.clone(), _ => String::new() }).unwrap_or_default();
                    reply = format!("I have {} earlier messages; the first was '{}'.", req.prior_messages.len(), first);
                }
                if let Some(ms) = prompt.strip_prefix("sleep:") {
                    let ms: u64 = ms.trim().parse().unwrap_or(0);
                    let end = Instant::now() + Duration::from_millis(ms);
                    while Instant::now() < end {
                        if aborted().await { return Err(NativeAgentError::Cancelled); }
                        // steer messages show up in the reply
                        if let Some(rx) = req.steer_rx.lock().await.as_mut() {
                            while let Ok(m) = rx.try_recv() { reply.push_str(&format!(" | steer: {m}")); }
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                } else if let Some(n) = prompt.strip_prefix("usage:") {
                    let n: u64 = n.trim().parse().unwrap_or(0);
                    for _ in 0..1000 {
                        if aborted().await { return Err(NativeAgentError::Cancelled); }
                        cb.on_event("text_delta".into(), json!({"text": "partial "}).to_string());
                        cb.on_event("context.usage".into(), json!({"inputTokens": n, "outputTokens": 0}).to_string());
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
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
                }
                let mut messages = req.prior_messages.clone();
                messages.push(Message::user(&full_prompt));
                messages.push(Message { role: Role::Assistant, content: MessageContent::Text(reply) });
                Ok(RunDone { messages, model: "m".into(), provider: "p".into(), usage: None })
            })
        }
        fn load_messages(&self, key: &str) -> Vec<Message> {
            self.saved.lock().unwrap().get(key).cloned().unwrap_or_default()
        }
        fn save(&self, key: &str, done: &RunDone, _s: i64, _m: u32, _t: &str) {
            self.saved.lock().unwrap().insert(key.into(), done.messages.clone());
        }
        fn clear(&self, key: &str) {
            self.saved.lock().unwrap().remove(key);
        }
        fn list_chats(&self) -> Vec<ChatInfo> {
            self.saved
                .lock()
                .unwrap()
                .iter()
                .filter(|(k, _)| !k.starts_with("subagent:"))
                .map(|(k, m)| ChatInfo { session_key: k.clone(), title: String::new(), updated_at: 0, message_count: m.len() })
                .collect()
        }
    }

    struct Dec<'a>(&'a AtomicUsize);
    impl Drop for Dec<'_> {
        fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); }
    }

    fn setup() -> (Arc<SubagentManager>, Arc<Script>, Arc<AppEvents>, ParentEnv, PathBuf) {
        let dir = std::env::temp_dir().join(format!("subagents-test-{}", uuid::Uuid::new_v4()));
        let script = Arc::new(Script::default());
        let mgr = SubagentManager::new(dir.clone(), Arc::new(script.clone()));
        let app = Arc::new(AppEvents::default());
        let env = ParentEnv {
            session_key: "chat-1".into(),
            provider: Some("openai".into()),
            model: Some("gpt-x".into()),
            system_prompt: "PARENT".into(),
            tool_names: vec!["read_file".into(), "write_file".into(), "list_files".into(), "ui__show_card".into(), "spawn_subagent".into()],
            callback: Some(app.clone()),
            memory: Some(Arc::new(MainMemory::default())),
            abort: None,
        };
        (mgr, script, app, env, dir)
    }

    fn spec(task: &str) -> SpawnSpec {
        SpawnSpec { task: task.into(), ..Default::default() }
    }

    async fn run_tool(mgr: &Arc<SubagentManager>, tool: &str, input: Value, env: &ParentEnv) -> (String, bool) {
        mgr.handle_tool(0, tool, &input, env.clone()).await
    }

    #[tokio::test]
    async fn spawn_waits_and_returns_the_report() {
        let (mgr, script, app, env, _) = setup();
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "count files", "name": "Counter Bot"}), &env).await;
        assert!(!err, "{out}");
        assert!(out.contains("finished") && out.contains("done: count files"), "{out}");
        let rec = &mgr.list()[0];
        assert_eq!(rec.status, "finished");
        assert_eq!(rec.name, "counter-bot");
        assert_eq!(rec.model.as_deref(), Some("gpt-x"), "inherits the parent's model");
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
    async fn tools_are_narrowed_to_parent_intersection_without_ui_tools() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, SpawnSpec { tools: Some(vec!["read_file".into(), "ui__show_card".into(), "shell".into(), "read_file".into()]), ..spec("x") }, &env).unwrap();
        assert_eq!(rec.tools, vec!["read_file".to_string()]);
        let rec2 = mgr.spawn(0, spec("y"), &env).unwrap();
        assert_eq!(rec2.tools, vec!["read_file".to_string(), "write_file".into(), "list_files".into()]);
        let err = mgr.spawn(0, SpawnSpec { tools: Some(vec!["shell".into()]), ..spec("z") }, &env).unwrap_err();
        assert!(err.contains("None of the requested tools"));
        mgr.wait_for(&[rec.id.clone(), rec2.id.clone()], None, Duration::from_secs(5)).await;
        // depth 1 default: the child is not offered sub-agent tools
        let allowed: Vec<String> = serde_json::from_str(script.requests.lock().unwrap()[0].1.as_deref().unwrap()).unwrap();
        assert_eq!(allowed, vec!["read_file".to_string()]);
    }

    #[tokio::test]
    async fn depth_limit_blocks_nested_spawning_and_is_configurable() {
        let (mgr, script, _app, env, _) = setup();
        let (out, err) = mgr.handle_tool(1, TOOL_SPAWN, &json!({"task": "nested"}), env.clone()).await;
        assert!(err && out.contains("depth limit is 1"), "{out}");
        assert!(!mgr.offers_tools_at(1) && mgr.offers_tools_at(0));
        mgr.set_settings(&json!({"maxDepth": 2}));
        assert!(mgr.offers_tools_at(1));
        let rec = mgr.spawn(0, spec("child"), &env).unwrap();
        mgr.wait_for(&[rec.id], None, Duration::from_secs(5)).await;
        let allowed: Vec<String> = serde_json::from_str(script.requests.lock().unwrap()[0].1.as_deref().unwrap()).unwrap();
        assert!(allowed.contains(&TOOL_SPAWN.to_string()), "depth 2 lets the child delegate: {allowed:?}");
        mgr.set_settings(&json!({"maxDepth": 99}));
        assert_eq!(mgr.settings().max_depth, 3, "clamped");
    }

    #[tokio::test]
    async fn parallel_runs_and_the_parallel_limit() {
        let (mgr, script, _app, env, _) = setup();
        let mut ids = Vec::new();
        for i in 0..3 {
            let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "sleep:300", "name": format!("w{i}"), "wait": false}), &env).await;
            assert!(!err && out.contains("in the background"), "{out}");
            ids.push(mgr.list()[0].id.clone());
        }
        // Over the limit: it queues instead of failing.
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "sleep:10", "wait": false}), &env).await;
        assert!(!err && out.contains("Queued") && out.contains("position 1"), "{out}");
        assert_eq!(mgr.queued_count(), 1);
        let started = Instant::now();
        let (out, err) = run_tool(&mgr, TOOL_LIST, json!({"wait": true}), &env).await;
        assert!(!err);
        assert_eq!(out.matches("finished after").count(), 4, "{out}");
        assert!(started.elapsed() < Duration::from_millis(1200), "ran in parallel, took {:?}", started.elapsed());
        assert_eq!(script.max_concurrent.load(Ordering::SeqCst), 3);
        assert_eq!(mgr.running_count(), 0);
        assert_eq!(mgr.queued_count(), 0);
        let (listing, _) = run_tool(&mgr, TOOL_LIST, json!({}), &env).await;
        assert_eq!(listing.matches("\"status\": \"finished\"").count(), 4, "{listing}");
        // another chat doesn't see them
        let other = ParentEnv { session_key: "chat-2".into(), ..env.clone() };
        let (none, _) = run_tool(&mgr, TOOL_LIST, json!({}), &other).await;
        assert!(none.contains("no sub-agents"));
    }

    #[tokio::test]
    async fn approval_requests_reach_the_app_tagged_with_the_subagent() {
        let (mgr, _script, app, env, _) = setup();
        let rec = mgr.spawn(0, SpawnSpec { name: Some("Writer".into()), ..spec("approval") }, &env).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(5)).await;
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

    #[tokio::test]
    async fn token_budget_stops_the_run() {
        let (mgr, _script, app, env, _) = setup();
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "usage:400", "token_budget": 1000}), &env).await;
        let rec = &mgr.list()[0];
        assert_eq!(rec.status, "budget_exceeded", "{out}");
        assert!(rec.total_tokens() >= 1000 && rec.total_tokens() < 2000, "{}", rec.total_tokens());
        assert!(out.contains("budget exceeded") && out.contains("token budget"), "{out}");
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
        assert!(!script.load_messages(&rec.session_key).is_empty(), "partial transcript saved");

        // Parent cancelled while waiting -> child stopped.
        let parent_abort = Arc::new(Mutex::new(false));
        let env2 = ParentEnv { abort: Some(parent_abort.clone()), ..env.clone() };
        let m2 = mgr.clone();
        let waiter = tokio::spawn(async move { m2.handle_tool(0, TOOL_SPAWN, &json!({"task": "sleep:5000"}), env2).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        *parent_abort.lock().await = true;
        let (out, err) = tokio::time::timeout(Duration::from_secs(3), waiter).await.unwrap().unwrap();
        assert!(err && out.contains("Cancelled"), "{out}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(mgr.list()[0].status, "cancelled");
        assert_eq!(mgr.running_count(), 0);
    }

    #[tokio::test]
    async fn timeout_stops_the_run() {
        let (mgr, _script, _app, env, _) = setup();
        let started = Instant::now();
        let rec = mgr.spawn(0, SpawnSpec { timeout_seconds: Some(1), ..spec("sleep:10000") }, &env).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(mgr.get(&rec.id).unwrap().status, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn step_limit_is_reported() {
        let (mgr, _script, _app, env, _) = setup();
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "turns", "max_steps": 3}), &env).await;
        assert_eq!(mgr.list()[0].status, "max_steps", "{out}");
        assert!(out.contains("step limit"));
    }

    #[tokio::test]
    async fn memory_modes_private_read_parent_shared_and_promote() {
        let (mgr, _script, _app, env, _) = setup();
        let main = Arc::new(MainMemory::default());
        main.store("city".into(), "Rajshahi".into(), None);
        let env = ParentEnv { memory: Some(main.clone()), ..env };

        // private: writes go to its own store, main memory untouched, can't read main
        run_tool(&mgr, TOOL_SPAWN, json!({"task": "remember:lang=Rust", "name": "dev", "memory": "private"}), &env).await;
        assert_eq!(main.0.lock().unwrap().len(), 1);
        assert_eq!(mgr.memory_entries("dev")[0].text, "Rust");
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "recall:Rajshahi", "name": "dev", "memory": "private"}), &env).await;
        assert!(!out.contains("\"source\":\"main\""), "{out}");
        // same name -> same store across runs
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "recall:Rust", "name": "dev"}), &env).await;
        assert!(out.contains("Rust"), "{out}");
        // another name -> isolated
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "recall:Rust", "name": "other"}), &env).await;
        assert!(out.contains("Report:\n[]"), "{out}");

        // read_parent: sees main memory, writes stay private
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "recall:Rajshahi", "name": "dev", "memory": "read_parent"}), &env).await;
        assert!(out.contains("Rajshahi") && out.contains("\"source\":\"main\""), "{out}");
        run_tool(&mgr, TOOL_SPAWN, json!({"task": "remember:x=1", "name": "dev", "memory": "read_parent"}), &env).await;
        assert_eq!(main.0.lock().unwrap().len(), 1);

        // shared: writes land in main memory
        run_tool(&mgr, TOOL_SPAWN, json!({"task": "remember:team=core", "name": "dev", "memory": "shared"}), &env).await;
        assert!(main.0.lock().unwrap().iter().any(|(k, _)| k == "team"));

        // app: list / promote / delete / clear
        let listed = mgr.handle_app_request(&json!({"action": "memory", "name": "dev"}), &env, Some(main.clone())).unwrap();
        assert_eq!(listed["entries"].as_array().unwrap().len(), 2);
        let promoted = mgr.handle_app_request(&json!({"action": "memory", "name": "dev", "op": "promote", "key": "lang"}), &env, Some(main.clone())).unwrap();
        assert_eq!(promoted["promoted"], 1);
        assert!(main.0.lock().unwrap().iter().any(|(k, v)| k == "lang" && v == "Rust"));
        let deleted = mgr.handle_app_request(&json!({"action": "memory", "name": "dev", "op": "delete", "key": "x"}), &env, None).unwrap();
        assert_eq!(deleted["deleted"], true);
        let cleared = mgr.handle_app_request(&json!({"action": "memory", "name": "dev", "op": "clear"}), &env, None).unwrap();
        assert_eq!(cleared["cleared"], 1);
        assert!(mgr.memory_entries("dev").is_empty());
        let names = mgr.handle_app_request(&json!({"action": "memory"}), &env, None).unwrap();
        assert!(names["names"].as_array().unwrap().contains(&json!("dev")));
    }

    #[tokio::test]
    async fn message_steers_a_running_one_and_resumes_a_finished_one() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("sleep:300"), &env).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": rec.id, "message": "also check tests"}), &env).await;
        assert!(!err && out.contains("delivered"), "{out}");
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(5)).await;
        assert!(mgr.get(&rec.id).unwrap().result.unwrap().contains("steer: also check tests"));

        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": rec.id, "message": "summarise"}), &env).await;
        assert!(!err && out.contains("done: summarise"), "{out}");
        let r = mgr.get(&rec.id).unwrap();
        assert_eq!(r.runs, 2);
        assert_eq!(script.load_messages(&r.session_key).len(), 4, "resumed with prior context");
        // other chats can't message it
        let other = ParentEnv { session_key: "chat-9".into(), ..env.clone() };
        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": rec.id, "message": "hi"}), &other).await;
        assert!(err && out.contains("No sub-agent of yours"));
    }

    #[tokio::test]
    async fn app_actions_spawn_list_retry_delete_and_settings() {
        let (mgr, script, _app, env, dir) = setup();
        let out = mgr.handle_app_request(&json!({"action": "spawn", "task": "sleep:20", "name": "ui", "tokenBudget": 5000, "maxSteps": 4}), &env, None).unwrap();
        let id = out["subagent"]["id"].as_str().unwrap().to_string();
        assert_eq!(out["subagent"]["tokenBudget"], 5000);
        assert_eq!(out["subagent"]["maxSteps"], 4);
        let err = mgr.handle_app_request(&json!({"action": "delete", "id": id}), &env, None).unwrap_err();
        assert!(err.contains("still running"));
        mgr.wait_for(&[id.clone()], None, Duration::from_secs(5)).await;
        let listed = mgr.handle_app_request(&json!({"action": "list", "status": "finished"}), &env, None).unwrap();
        assert_eq!(listed["subagents"].as_array().unwrap().len(), 1);
        let detail = mgr.handle_app_request(&json!({"action": "get", "id": id}), &env, None).unwrap();
        assert_eq!(detail["transcript"].as_array().unwrap().len(), 2);
        let retried = mgr.handle_app_request(&json!({"action": "retry", "id": id}), &env, None).unwrap();
        assert_eq!(retried["subagent"]["runs"], 2);
        mgr.wait_for(&[id.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(script.load_messages(&format!("subagent:{id}")).len(), 2, "retry starts clean");
        mgr.handle_app_request(&json!({"action": "delete", "id": id}), &env, None).unwrap();
        assert!(mgr.get(&id).is_none());
        assert!(script.load_messages(&format!("subagent:{id}")).is_empty());

        let s = mgr.handle_app_request(&json!({"action": "settings", "settings": {"maxParallel": 5, "defaultTokenBudget": 50000}}), &env, None).unwrap();
        assert_eq!(s["settings"]["maxParallel"], 5);
        let reloaded = SubagentManager::new(dir, Arc::new(script.clone()));
        assert_eq!(reloaded.settings().default_token_budget, 50000);
        assert!(mgr.handle_app_request(&json!({"action": "nope"}), &env, None).is_err());
        let stop_all = mgr.handle_app_request(&json!({"action": "stop", "all": true}), &env, None).unwrap();
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
        let a = mgr.spawn(0, SpawnSpec { name: Some("a".into()), ..spec("sleep:250") }, &env).unwrap();
        assert_eq!(a.status, "running");
        let other = ParentEnv { session_key: "chat-2".into(), ..env.clone() };
        let b1 = mgr.spawn(0, SpawnSpec { name: Some("b1".into()), ..spec("sleep:30") }, &env).unwrap();
        let b2 = mgr.spawn(0, SpawnSpec { name: Some("b2".into()), ..spec("sleep:30") }, &env).unwrap();
        let c1 = mgr.spawn(0, SpawnSpec { name: Some("c1".into()), ..spec("sleep:30") }, &other).unwrap();
        assert_eq!((b1.status.as_str(), b2.status.as_str(), c1.status.as_str()), ("queued", "queued", "queued"));
        // Round-robin across chats: b1, c1, b2.
        let pos = |id: &str| mgr.get(id).unwrap().queue_position;
        assert_eq!((pos(&b1.id), pos(&c1.id), pos(&b2.id)), (Some(1), Some(2), Some(3)));
        // Queue full.
        let full = mgr.spawn(0, spec("sleep:1"), &env).unwrap_err();
        assert!(full.contains("queue is full"), "{full}");
        assert_eq!(mgr.list().len(), 4, "a refused spawn leaves no record");
        // Priority jumps the line.
        mgr.handle_app_request(&json!({"action": "priority", "id": b2.id, "priority": 5}), &env, None).unwrap();
        assert_eq!(pos(&b2.id), Some(1));
        let q = mgr.handle_app_request(&json!({"action": "queue"}), &env, None).unwrap();
        assert_eq!(q["queue"][0]["id"], json!(b2.id));
        assert!(q["locks"]["held"].is_array());
        // Cancel while queued: positions close up, events say so.
        assert!(mgr.stop(&c1.id, "cancelled"));
        let c = mgr.get(&c1.id).unwrap();
        assert_eq!(c.status, "cancelled");
        assert!(c.queue_position.is_none());
        assert!(app.named("subagent.cancelled").iter().any(|e| e["whileQueued"] == json!(true)));
        assert_eq!(pos(&b1.id), Some(2));
        assert!(!app.named("subagent.queued").is_empty());
        // A message to a queued one is delivered when it starts.
        let (_, resumed) = mgr.message(&b1.id, "hello-queued", &env).unwrap();
        assert!(!resumed);
        let end = mgr.wait_for(&[a.id.clone(), b1.id.clone(), b2.id.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(end, WaitEnd::Done);
        assert_eq!(script.max_concurrent.load(Ordering::SeqCst), 1, "never more than maxParallel");
        assert!(mgr.get(&b1.id).unwrap().result.unwrap().contains("steer: hello-queued"));
        // Order of starts: a, b2 (priority), b1.
        let order: Vec<String> = script.requests.lock().unwrap().iter().map(|r| r.0.clone()).collect();
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
        let stopped = mgr.handle_app_request(&json!({"action": "stop", "all": true}), &env, None).unwrap();
        assert_eq!(stopped["stopped"].as_array().unwrap().len(), 3);
        mgr.wait_for(&[a.id.clone(), b.id.clone(), c.id.clone()], None, Duration::from_secs(3)).await;
        assert_eq!(mgr.get(&c.id).unwrap().status, "cancelled", "stopping running ones must not start the queued one");
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
        let h = tokio::spawn(async move { m2.handle_tool(0, TOOL_SPAWN, &json!({"task": "sleep:10", "name": "late"}), env2).await });
        tokio::time::sleep(Duration::from_millis(60)).await;
        let late = mgr.list().into_iter().find(|r| r.name == "late").unwrap();
        assert_eq!(late.status, "queued");
        *abort.lock().await = true;
        let (out, err) = h.await.unwrap();
        assert!(err && out.contains("Cancelled"), "{out}");
        assert_eq!(mgr.get(&late.id).unwrap().status, "cancelled");
        mgr.stop_where(|_| true);
    }

    #[tokio::test]
    async fn regenerate_edit_and_fork() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, spec("first"), &env).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(2)).await;
        mgr.message(&rec.id, "second", &env).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(2)).await;
        assert_eq!(script.load_messages(&rec.session_key).len(), 4);
        // Regenerate: the last reply is replaced, the history doesn't grow.
        let r = mgr.handle_app_request(&json!({"action": "regenerate", "id": rec.id}), &env, None).unwrap();
        assert_eq!(r["subagent"]["status"], json!("running"));
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(2)).await;
        let msgs = script.load_messages(&rec.session_key);
        assert_eq!(msgs.len(), 4, "regenerate replaces, not appends");
        assert!(matches!(&msgs[3].content, MessageContent::Text(t) if t == "done: second"));
        // Edit the first message: everything after it is dropped.
        mgr.handle_app_request(&json!({"action": "edit", "id": rec.id, "turn": 0, "message": "first-edited"}), &env, None).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(2)).await;
        let msgs = script.load_messages(&rec.session_key);
        assert_eq!(msgs.len(), 2);
        assert_eq!(mgr.get(&rec.id).unwrap().task, "first-edited");
        assert_eq!(mgr.get(&rec.id).unwrap().result.as_deref(), Some("done: first-edited"));
        // Bad turn and empty edit are refused, nothing changes.
        assert!(mgr.handle_app_request(&json!({"action": "edit", "id": rec.id, "turn": 9, "message": "x"}), &env, None).is_err());
        assert!(mgr.handle_app_request(&json!({"action": "edit", "id": rec.id, "message": "  "}), &env, None).is_err());
        assert_eq!(mgr.get(&rec.id).unwrap().status, "finished");
        // Can't regenerate while running.
        let busy = mgr.spawn(0, spec("sleep:2000"), &env).unwrap();
        assert!(mgr.regenerate(&busy.id, None, None, &env).is_err());
        mgr.stop(&busy.id, "cancelled");
        // Fork: a new record with the same settings and an edited task.
        let f = mgr.handle_app_request(&json!({"action": "fork", "id": rec.id, "task": "other task"}), &env, None).unwrap();
        let fid = f["subagent"]["id"].as_str().unwrap().to_string();
        assert_ne!(fid, rec.id);
        mgr.wait_for(&[fid.clone()], None, Duration::from_secs(2)).await;
        let fr = mgr.get(&fid).unwrap();
        assert_eq!(fr.forked_from.as_deref(), Some(rec.id.as_str()));
        assert_eq!(fr.tools, mgr.get(&rec.id).unwrap().tools);
        assert_eq!(script.load_messages(&fr.session_key).len(), 2);
        // Fork keeping history continues the old conversation.
        let k = mgr.handle_app_request(&json!({"action": "fork", "id": rec.id, "task": "follow-up", "keepHistory": true}), &env, None).unwrap();
        let kid = k["subagent"]["id"].as_str().unwrap().to_string();
        mgr.wait_for(&[kid.clone()], None, Duration::from_secs(2)).await;
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
            msgs.push(if i % 2 == 0 { Message::user(t) } else { Message { role: Role::Assistant, content: MessageContent::Text(t.to_string()) } });
        }
        script.saved.lock().unwrap().insert(key.into(), msgs);
    }

    #[tokio::test]
    async fn ask_session_returns_only_the_reply_and_keeps_histories_apart() {
        let (mgr, script, app, env, _) = setup();
        seed_chat(&script, "chat-plan", &["Plan the trip SECRET-PLAN-123", "Day 1: Sylhet", "and day 2?", "Day 2: Srimangal"]);
        seed_chat(&script, "chat-1", &["hi"]);
        seed_chat(&script, "subagent:sa_x", &["hidden"]);
        mgr.set_session_titles(&json!({"chat-plan": "Trip plan", "chat-1": "Main"}));
        // list_sessions: titles, no contents, not itself, no sub-agent sessions.
        let (list, err) = mgr.handle_session_tool(TOOL_LIST_SESSIONS, &json!({}), env.clone()).await;
        assert!(!err);
        assert!(list.contains("Trip plan") && list.contains("chat-plan"));
        assert!(!list.contains("SECRET-PLAN") && !list.contains("subagent:") && !list.contains("\"chat-1\""), "{list}");
        let before_caller = script.load_messages("chat-1");
        let (out, err) = mgr.handle_session_tool(TOOL_ASK_SESSION, &json!({"session_key": "chat-plan", "message": "whatdoyouknow"}), env.clone()).await;
        assert!(!err, "{out}");
        // The target answered from its own 4 messages ...
        assert!(out.contains("I have 4 earlier messages"), "{out}");
        // ... and only that reply came back, never its history.
        assert!(!out.contains("Sylhet") && !out.contains("Srimangal"), "{out}");
        // The turn is saved in the target, with a visible note; the caller is untouched.
        let target = script.load_messages("chat-plan");
        assert_eq!(target.len(), 6);
        assert!(matches!(&target[4].content, MessageContent::Text(t) if t.contains("Message from your other chat \"Main\"") && t.contains("whatdoyouknow")));
        assert_eq!(script.load_messages("chat-1").len(), before_caller.len());
        // The target run got no session / sub-agent / ui tools.
        let req = script.requests.lock().unwrap().last().cloned().unwrap();
        let tools = req.1.unwrap();
        assert!(!tools.contains("ask_session") && !tools.contains("spawn_subagent") && !tools.contains("ui__"), "{tools}");
        // Events for both chats, and an audit record without history.
        let asked = app.named("session.asked");
        let answered = app.named("session.answered");
        assert_eq!(asked.len(), 1);
        assert_eq!(answered[0]["status"], json!("answered"));
        assert_eq!(answered[0]["targetTitle"], json!("Trip plan"));
        let hist = mgr.handle_app_request(&json!({"action": "asks", "sessionKey": "chat-plan"}), &env, None).unwrap();
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
        assert!(ask("nope", "hi").await.unwrap_err().contains("No saved chat"));
        assert!(ask("subagent:sa_1", "hi").await.unwrap_err().contains("No saved chat"));
        assert!(ask("chat-a", "   ").await.unwrap_err().contains("empty"));
        assert!(ask("chat-a", &"x".repeat(8001)).await.unwrap_err().contains("too long"));
        // One ask per target at a time.
        let slow = tokio::spawn(ask("chat-a", "sleep:300"));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(ask("chat-a", "hi").await.unwrap_err().contains("already answering"));
        // A chat that is being asked can't ask a third chat (no chains).
        let env_a = ParentEnv { session_key: "chat-a".into(), ..env.clone() };
        seed_chat(&script, "chat-b", &["b"]);
        assert!(mgr.ask_session("chat-b", "hi", None, &env_a, "agent").await.unwrap_err().contains("answering another chat"));
        assert!(slow.await.unwrap().is_ok());
        // Turned off in settings.
        mgr.set_settings(&json!({"sessionsEnabled": false}));
        assert!(ask("chat-a", "hi").await.unwrap_err().contains("turned off"));
    }

    #[tokio::test]
    async fn ask_session_budget_timeout_cancel_and_reply_limit() {
        let (mgr, script, app, mut env, _) = setup();
        seed_chat(&script, "chat-a", &["a"]);
        mgr.set_settings(&json!({"sessionTokenBudget": 1000, "sessionReplyMaxChars": 200}));
        let e = mgr.ask_session("chat-a", "usage:400", None, &env, "agent").await.unwrap_err();
        assert!(e.contains("token budget"), "{e}");
        assert_eq!(app.named("session.answered").last().unwrap()["status"], json!("error"));
        // Reply capped.
        let long = format!("{}", "y".repeat(900));
        let (_, r, _) = mgr.ask_session("chat-a", &long, None, &env, "agent").await.unwrap();
        assert!(r.chars().count() <= 215 && r.ends_with("[truncated]"), "{}", r.len());
        // The caller's Stop cancels it.
        let abort = Arc::new(Mutex::new(false));
        env.abort = Some(abort.clone());
        let m2 = mgr.clone();
        let e2 = env.clone();
        let h = tokio::spawn(async move { m2.ask_session("chat-a", "sleep:3000", None, &e2, "agent").await });
        tokio::time::sleep(Duration::from_millis(60)).await;
        *abort.lock().await = true;
        let err = h.await.unwrap().unwrap_err();
        assert!(err.contains("cancelled"), "{err}");
        // The user can ask from the app and cancel it there.
        let m3 = mgr.clone();
        let e3 = ParentEnv { abort: None, ..env.clone() };
        let h = tokio::spawn(async move { m3.user_ask(&json!({"targetSessionKey": "chat-a", "message": "sleep:3000"}), e3).await });
        tokio::time::sleep(Duration::from_millis(60)).await;
        let c = mgr.handle_app_request(&json!({"action": "cancelAsk", "targetSessionKey": "chat-a"}), &env, None).unwrap();
        assert_eq!(c["cancelled"], json!(true));
        assert!(h.await.unwrap().is_err());
        let ok = mgr.user_ask(&json!({"targetSessionKey": "chat-a", "message": "whatdoyouknow"}), ParentEnv { abort: None, ..env.clone() }).await.unwrap();
        assert!(ok["reply"].as_str().unwrap().contains("earlier messages"));
        assert!(app.named("session.asked").iter().any(|e| e["origin"] == json!("user")));
        // Titles persist and are bounded.
        assert_eq!(mgr.set_session_titles(&json!({"chat-a": "  A  ", "x": ""})), 1);
        assert_eq!(mgr.list_chats(None)[0].title, "A");
    }

    #[test]
    fn tool_definitions_and_prompt_are_well_formed() {
        let defs = SubagentManager::tool_definitions();
        assert_eq!(defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), TOOL_NAMES.to_vec());
        assert_eq!(defs[0].input_schema["required"], json!(["task"]));
        for d in &defs {
            assert!(d.description.len() > 60);
            assert_eq!(d.input_schema["type"], "object");
        }
        assert_eq!(MemoryMode::parse("read-parent"), Some(MemoryMode::ReadParent));
        assert_eq!(sanitize_name("  Test Fixer!! 2 "), "test-fixer-2");
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
    async fn two_with_data() -> (Arc<SubagentManager>, Arc<Script>, Arc<AppEvents>, ParentEnv, PathBuf, String, String) {
        let (mgr, script, app, env, _) = setup();
        let ws = ws_setup(&mgr);
        script.saved.lock().unwrap().insert("chat-1".into(), vec![Message::user("main chat")]);
        env.memory.as_ref().unwrap().store("main-key".into(), "main".into(), None);
        std::fs::write(ws.join("existing.txt"), "user's").unwrap();
        let a = mgr.spawn(0, SpawnSpec { name: Some("a".into()), ..spec("remember:ka=va") }, &env).unwrap();
        let b = mgr.spawn(0, SpawnSpec { name: Some("b".into()), ..spec("remember:kb=vb") }, &env).unwrap();
        mgr.wait_for(&[a.id.clone(), b.id.clone()], None, Duration::from_secs(5)).await;
        for (id, file) in [(&a.id, "a-new.txt"), (&b.id, "b-new.txt")] {
            mgr.track_tool_use(id, "write_file", &json!({"path": file}));
            std::fs::write(ws.join(file), "x").unwrap();
        }
        mgr.track_tool_use(&a.id, "edit_file", &json!({"path": "existing.txt"}));
        mgr.track_tool_use(&a.id, "read_file", &json!({"path": "ignored.txt"}));
        mgr.track_tool_use(&a.id, "write_file", &json!({"path": "../escape.txt"}));
        (mgr, script, app, env, ws, a.id, b.id)
    }

    fn assert_b_untouched(mgr: &Arc<SubagentManager>, script: &Arc<Script>, env: &ParentEnv, ws: &Path, b: &str) {
        let rb = mgr.get(b).expect("b record kept");
        assert_eq!(script.load_messages(&rb.session_key).len(), 2, "b transcript kept");
        assert_eq!(mgr.memory_entries("b").len(), 1, "b memory kept");
        assert!(!mgr.read_log(b, 100).is_empty(), "b log kept");
        assert!(ws.join("b-new.txt").exists(), "b file kept");
        assert_eq!(script.load_messages("chat-1").len(), 1, "main chat kept");
        assert!(env.memory.as_ref().unwrap().recall("main".into(), 5).contains("main-key"), "main memory kept");
        assert!(ws.join("existing.txt").exists(), "user's own file kept");
    }

    #[tokio::test]
    async fn file_tracking_marks_only_files_it_created() {
        let (mgr, _s, _app, _env, _ws, a, _b) = two_with_data().await;
        let files = mgr.get(&a).unwrap().files;
        let created: Vec<_> = files.iter().filter(|f| f.created).map(|f| f.path.as_str()).collect();
        let edited: Vec<_> = files.iter().filter(|f| !f.created).map(|f| f.path.as_str()).collect();
        assert_eq!(created, vec!["a-new.txt"]);
        assert_eq!(edited, vec!["existing.txt", "../escape.txt"], "pre-existing and outside-workspace are never ours");
        // a second write to the same path is not added twice and keeps `created`
        mgr.track_tool_use(&a, "write_file", &json!({"path": "a-new.txt"}));
        assert_eq!(mgr.get(&a).unwrap().files.len(), 3);
    }

    #[tokio::test]
    async fn delete_dry_run_lists_everything_and_deletes_nothing() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr.delete_data_request(&json!({"id": a, "parts": ["all"], "dryRun": true})).unwrap();
        let items = out["plan"][0]["items"].as_array().unwrap();
        let parts: Vec<&str> = items.iter().map(|i| i["part"].as_str().unwrap()).collect();
        assert_eq!(parts, vec!["chat", "memory", "files", "logs", "record"]);
        assert_eq!(items[0]["messages"], 2);
        assert_eq!(items[1]["entries"], 1);
        assert_eq!(items[2]["files"], json!(["a-new.txt"]));
        assert!(out["plan"][0]["warnings"].to_string().contains("existed before"), "{out}");
        assert!(mgr.get(&a).is_some() && ws.join("a-new.txt").exists() && mgr.memory_entries("a").len() == 1);
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_chat_only() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let ra = mgr.get(&a).unwrap();
        mgr.delete_data_request(&json!({"id": a, "parts": ["chat"]})).unwrap();
        let after = mgr.get(&a).expect("record kept");
        assert!(script.load_messages(&ra.session_key).is_empty() && after.result.is_none() && after.chat_deleted);
        assert_eq!(mgr.memory_entries("a").len(), 1, "memory kept");
        assert!(ws.join("a-new.txt").exists() && !mgr.read_log(&a, 100).is_empty(), "files and log kept");
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_memory_only() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr.delete_data_request(&json!({"id": a, "parts": "memory"})).unwrap();
        assert_eq!(out["deleted"][0]["memory"], 1);
        assert!(mgr.memory_entries("a").is_empty());
        let ra = mgr.get(&a).unwrap();
        assert_eq!(script.load_messages(&ra.session_key).len(), 2, "chat kept");
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_shared_memory_never_touches_main_memory() {
        let (mgr, script, _app, env, ws, _a, b) = two_with_data().await;
        let s = mgr.spawn(0, SpawnSpec { name: Some("sh".into()), memory: Some("shared".into()), ..spec("remember:ks=vs") }, &env).unwrap();
        mgr.wait_for(&[s.id.clone()], None, Duration::from_secs(5)).await;
        let plan = mgr.delete_data_request(&json!({"id": s.id, "parts": ["memory"], "dryRun": true})).unwrap();
        assert_eq!(plan["plan"][0]["items"][0]["skipped"], true);
        mgr.delete_data_request(&json!({"id": s.id, "parts": ["memory"]})).unwrap();
        assert!(env.memory.as_ref().unwrap().recall("vs".into(), 5).contains("ks"), "shared entries live in the main memory: kept");
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_files_only_removes_files_it_created() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr.delete_data_request(&json!({"id": a, "parts": ["files"]})).unwrap();
        assert_eq!(out["deleted"][0]["files"], json!(["a-new.txt"]));
        assert!(!ws.join("a-new.txt").exists());
        assert!(mgr.get(&a).unwrap().files.iter().all(|f| !f.created), "untracked once deleted");
        assert_eq!(mgr.memory_entries("a").len(), 1);
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_files_without_workspace_reports_and_keeps() {
        let (mgr, _s, _app, env, _) = setup();
        let a = mgr.spawn(0, SpawnSpec { name: Some("a".into()), ..spec("x") }, &env).unwrap();
        mgr.wait_for(&[a.id.clone()], None, Duration::from_secs(5)).await;
        // no workspace: nothing is marked created (unknown = not ours)
        mgr.track_tool_use(&a.id, "write_file", &json!({"path": "n.txt"}));
        assert!(!mgr.get(&a.id).unwrap().files[0].created);
        let out = mgr.delete_data_request(&json!({"id": a.id, "parts": ["files"]})).unwrap();
        assert_eq!(out["deleted"][0]["files"], json!([]));
    }

    #[tokio::test]
    async fn delete_logs_only() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        assert!(mgr.read_log(&a, 100).iter().any(|l| l["event"] == "subagent.finished"));
        mgr.delete_data_request(&json!({"id": a, "parts": ["logs"]})).unwrap();
        assert!(mgr.read_log(&a, 100).is_empty());
        assert_eq!(mgr.memory_entries("a").len(), 1);
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_everything_removes_the_record_and_survives_restart() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let out = mgr.delete_data_request(&json!({"id": a, "parts": ["everything"]})).unwrap();
        assert_eq!(out["deleted"][0]["record"], true);
        assert!(mgr.get(&a).is_none() && !ws.join("a-new.txt").exists() && mgr.memory_entries("a").is_empty());
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
        let reloaded = SubagentManager::new(mgr.state_dir.clone(), Arc::new(script.clone()));
        assert!(reloaded.get(&a).is_none() && reloaded.get(&b).is_some());
    }

    #[tokio::test]
    async fn delete_validates_input() {
        let (mgr, _s, _app, _env, _ws, a, _b) = two_with_data().await;
        assert!(mgr.delete_data_request(&json!({"id": a, "parts": []})).unwrap_err().contains("Choose"));
        assert!(mgr.delete_data_request(&json!({"id": a, "parts": ["secrets"]})).unwrap_err().contains("Unknown data part"));
        assert!(mgr.delete_data_request(&json!({"id": "nope", "parts": ["chat"]})).unwrap_err().contains("No sub-agent"));
        assert!(mgr.delete_data_request(&json!({"parts": ["chat"]})).unwrap_err().contains("Nothing selected"));
        assert!(mgr.delete_data_request(&json!({"scope": "weird", "parts": ["chat"]})).unwrap_err().contains("Unknown scope"));
        assert!(mgr.get(&a).is_some());
    }

    #[tokio::test]
    async fn delete_while_running_stops_first_then_deletes() {
        let (mgr, script, app, env, ws, _a, b) = two_with_data().await;
        let r = mgr.spawn(0, SpawnSpec { name: Some("r".into()), ..spec("sleep:2000") }, &env).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let plan = mgr.delete_data_request(&json!({"id": r.id, "parts": ["all"], "dryRun": true})).unwrap();
        assert!(plan["plan"][0]["warnings"].to_string().contains("stopped first"));
        let out = mgr.delete_data_request(&json!({"id": r.id, "parts": ["all"]})).unwrap();
        assert_eq!(out["stopping"], json!([r.id]));
        mgr.wait_for(&[r.id.clone()], None, Duration::from_secs(5)).await;
        assert!(mgr.get(&r.id).is_none(), "deleted once it stopped");
        assert!(script.load_messages(&r.session_key).is_empty(), "transcript saved on stop was deleted too");
        assert_eq!(app.named("subagent.deleted").len(), 1);
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn delete_while_queued_takes_it_out_of_the_queue() {
        let (mgr, script, _app, env, ws, _a, b) = two_with_data().await;
        mgr.set_settings(&json!({"maxParallel": 1}));
        let run = mgr.spawn(0, SpawnSpec { name: Some("run".into()), ..spec("sleep:200") }, &env).unwrap();
        let q = mgr.spawn(0, SpawnSpec { name: Some("q".into()), ..spec("never") }, &env).unwrap();
        assert_eq!(mgr.get(&q.id).unwrap().status, "queued");
        mgr.delete_data_request(&json!({"id": q.id, "parts": ["all"]})).unwrap();
        assert!(mgr.get(&q.id).is_none() && mgr.queued_count() == 0);
        mgr.wait_for(&[run.id.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(mgr.get(&run.id).unwrap().status, "finished", "the running one is untouched");
        assert!(!script.requests.lock().unwrap().iter().any(|(p, _, _)| p == "never"), "the deleted one never ran");
        assert_b_untouched(&mgr, &script, &env, &ws, &b);
    }

    #[tokio::test]
    async fn bulk_delete_selected_finished_and_all() {
        let (mgr, script, _app, env, ws, a, b) = two_with_data().await;
        let other_chat = ParentEnv { session_key: "chat-2".into(), ..env.clone() };
        let o = mgr.spawn(0, SpawnSpec { name: Some("o".into()), ..spec("x") }, &other_chat).unwrap();
        let run = mgr.spawn(0, SpawnSpec { name: Some("run".into()), ..spec("sleep:400") }, &env).unwrap();
        mgr.wait_for(&[o.id.clone()], None, Duration::from_secs(5)).await;
        // finished in chat-1 only: a and b go, the running one and chat-2's stay
        let out = mgr.delete_data_request(&json!({"scope": "finished", "parentSessionKey": "chat-1", "parts": ["all"]})).unwrap();
        assert_eq!(out["deleted"].as_array().unwrap().len(), 2);
        assert!(mgr.get(&a).is_none() && mgr.get(&b).is_none());
        assert!(mgr.get(&run.id).is_some() && mgr.get(&o.id).is_some());
        assert_eq!(script.load_messages("chat-1").len(), 1);
        assert!(ws.join("existing.txt").exists());
        // selected
        mgr.delete_data_request(&json!({"scope": "selected", "ids": [o.id], "parts": ["chat"]})).unwrap();
        assert!(mgr.get(&o.id).unwrap().chat_deleted);
        // all (stops the running one first)
        let out = mgr.delete_data_request(&json!({"scope": "all", "parts": ["all"]})).unwrap();
        assert_eq!(out["stopping"], json!([run.id]));
        mgr.wait_for(&[run.id.clone()], None, Duration::from_secs(5)).await;
        assert!(mgr.list().is_empty());
        assert_eq!(script.load_messages("chat-1").len(), 1, "main chat survives delete-all");
    }

    #[tokio::test]
    async fn memory_shared_by_name_is_warned_about() {
        let (mgr, _s, _app, env, _ws, a, _b) = two_with_data().await;
        let a2 = mgr.spawn(0, SpawnSpec { name: Some("a".into()), ..spec("x") }, &env).unwrap();
        mgr.wait_for(&[a2.id.clone()], None, Duration::from_secs(5)).await;
        let plan = mgr.delete_data_request(&json!({"id": a, "parts": ["memory"], "dryRun": true})).unwrap();
        assert!(plan["plan"][0]["warnings"].to_string().contains("1 other sub-agent run"), "{plan}");
        // both selected: no warning
        let plan = mgr.delete_data_request(&json!({"ids": [a, a2.id], "parts": ["memory"], "dryRun": true})).unwrap();
        assert!(!plan["plan"][0]["warnings"].to_string().contains("other sub-agent"));
    }

    #[tokio::test]
    async fn reuse_by_name_in_a_later_turn_keeps_history_and_memory() {
        let (mgr, script, _app, env, _) = setup();
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "remember:topic=rust", "name": "researcher"}), &env).await;
        assert!(!err, "{out}");
        let first = mgr.list()[0].clone();
        // later turn: reuse by name
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "whatdoyouknow", "name": "researcher", "reuse": true}), &env).await;
        assert!(!err, "{out}");
        assert!(out.contains("Reusing sub-agent") && out.contains("I have 2 earlier messages; the first was 'remember:topic=rust'"), "{out}");
        assert_eq!(mgr.list().len(), 1, "no new sub-agent");
        assert_eq!(mgr.get(&first.id).unwrap().runs, 2);
        let (out, _) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": "researcher", "message": "recall:topic"}), &env).await;
        assert!(out.contains("rust"), "memory kept: {out}");
        assert_eq!(script.load_messages(&first.session_key).len(), 6);
    }

    #[tokio::test]
    async fn reuse_by_id_after_restart() {
        let (mgr, script, _app, env, _) = setup();
        let rec = mgr.spawn(0, SpawnSpec { name: Some("fixer".into()), ..spec("remember:k=v") }, &env).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(5)).await;
        let mgr2 = SubagentManager::new(mgr.state_dir.clone(), Arc::new(script.clone()));
        let (out, err) = run_tool(&mgr2, TOOL_LIST, json!({"name": "fixer"}), &env).await;
        assert!(!err && out.contains(&rec.id), "{out}");
        let (out, err) = run_tool(&mgr2, TOOL_SPAWN, json!({"task": "recall:k", "reuse": rec.id}), &env).await;
        assert!(!err && out.contains("Reusing") && out.contains("\"v\""), "{out}");
        assert_eq!(mgr2.list().len(), 1);
    }

    #[tokio::test]
    async fn reuse_respects_current_tool_rules_and_limits() {
        let (mgr, _s, _app, env, _) = setup();
        let rec = mgr.spawn(0, SpawnSpec { name: Some("w".into()), ..spec("x") }, &env).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(rec.tools.len(), 3);
        // the parent lost write_file since (a tool rule set to never)
        let narrower = ParentEnv { tool_names: vec!["read_file".into(), "spawn_subagent".into()], ..env.clone() };
        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": "w", "message": "go on"}), &narrower).await;
        assert!(!err, "{out}");
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(mgr.get(&rec.id).unwrap().tools, vec!["read_file".to_string()]);
        // none of its tools left: refused, not widened
        let none = ParentEnv { tool_names: vec!["list_files".into()], ..env.clone() };
        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": rec.id, "message": "again"}), &none).await;
        assert!(err && out.contains("Spawn a new sub-agent"), "{out}");
        // sub-agents turned off
        mgr.set_settings(&json!({"enabled": false}));
        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": rec.id, "message": "again"}), &env).await;
        assert!(err && out.contains("turned off"), "{out}");
        mgr.set_settings(&json!({"enabled": true, "maxParallel": 1}));
        // the parallel limit still applies: a reuse waits in the queue
        let blocker = mgr.spawn(0, spec("sleep:300"), &env).unwrap();
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "more", "reuse": "w", "wait": false}), &env).await;
        assert!(!err, "{out}");
        assert_eq!(mgr.get(&rec.id).unwrap().status, "queued");
        mgr.wait_for(&[blocker.id.clone(), rec.id.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(mgr.get(&rec.id).unwrap().status, "finished");
        // new limits on reuse are clamped
        let (_o, _e) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "x", "reuse": "w", "token_budget": 5, "max_steps": 9999}), &env).await;
        let r = mgr.get(&rec.id).unwrap();
        assert_eq!((r.token_budget, r.max_steps), (1_000, 200));
    }

    #[tokio::test]
    async fn reuse_stays_in_its_chat_unless_allowed() {
        let (mgr, _s, _app, env, _) = setup();
        let rec = mgr.spawn(0, SpawnSpec { name: Some("mine".into()), ..spec("x") }, &env).unwrap();
        mgr.wait_for(&[rec.id.clone()], None, Duration::from_secs(5)).await;
        let other = ParentEnv { session_key: "chat-2".into(), ..env.clone() };
        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": rec.id, "message": "hi"}), &other).await;
        assert!(err && out.contains("No sub-agent of yours"), "{out}");
        let (out, _) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "x", "name": "mine", "reuse": true}), &other).await;
        assert!(out.contains("No earlier sub-agent matched"), "{out}");
        assert_eq!(mgr.list().len(), 2);
        let (out, _) = run_tool(&mgr, TOOL_LIST, json!({"scope": "all"}), &other).await;
        assert!(!out.contains(&rec.id) && out.contains("hidden") == false || !out.contains(&rec.id), "{out}");
        mgr.set_settings(&json!({"reuseAcrossChats": true}));
        let (out, _) = run_tool(&mgr, TOOL_LIST, json!({"scope": "all"}), &other).await;
        assert!(out.contains(&rec.id) && out.contains("chat-1"), "{out}");
        let (out, err) = run_tool(&mgr, TOOL_MESSAGE, json!({"id": rec.id, "message": "hi"}), &other).await;
        assert!(!err, "{out}");
    }

    #[tokio::test]
    async fn list_filters_name_status_recent_query() {
        let (mgr, _s, _app, env, _) = setup();
        let mut ids = vec![];
        for (n, t) in [("alpha", "search docs"), ("beta", "fix tests"), ("alpha", "search more")] {
            let r = mgr.spawn(0, SpawnSpec { name: Some(n.into()), ..spec(t) }, &env).unwrap();
            mgr.wait_for(&[r.id.clone()], None, Duration::from_secs(5)).await;
            ids.push(r.id);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let recs = mgr.filter_records(&json!({"name": "alpha"}), "chat-1");
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].id, ids[2], "newest first");
        assert_eq!(mgr.filter_records(&json!({"query": "TESTS"}), "chat-1")[0].id, ids[1]);
        assert_eq!(mgr.filter_records(&json!({"recent": 1}), "chat-1").len(), 1);
        assert!(mgr.filter_records(&json!({"status": "running"}), "chat-1").is_empty());
        assert_eq!(mgr.filter_records(&json!({"status": "finished"}), "chat-1").len(), 3);
        let (out, _) = run_tool(&mgr, TOOL_LIST, json!({"name": "nobody"}), &env).await;
        assert!(out.contains("No sub-agents match"));
        // find_reusable picks the latest with that name
        assert_eq!(mgr.find_reusable("alpha", "chat-1").unwrap().id, ids[2]);
        assert!(mgr.find_reusable("alpha", "chat-9").is_none());
    }

    #[tokio::test]
    async fn app_actions_for_delete_data_reuse_find_and_log() {
        let (mgr, _s, _app, env, _ws, a, _b) = two_with_data().await;
        let out = mgr.handle_app_request(&json!({"action": "deleteData", "id": a, "parts": ["logs"], "dryRun": true}), &env, None).unwrap();
        assert_eq!(out["dryRun"], true);
        let out = mgr.handle_app_request(&json!({"action": "log", "id": a}), &env, None).unwrap();
        assert!(!out["log"].as_array().unwrap().is_empty());
        let out = mgr.handle_app_request(&json!({"action": "find", "key": "a"}), &env, None).unwrap();
        assert_eq!(out["subagent"]["id"], json!(a));
        let out = mgr.handle_app_request(&json!({"action": "spawn", "task": "again", "reuse": a}), &env, None).unwrap();
        assert_eq!(out["reuse"], "resumed");
        mgr.wait_for(&[a.clone()], None, Duration::from_secs(5)).await;
        let out = mgr.handle_app_request(&json!({"action": "continue", "id": a, "message": "more"}), &env, None).unwrap();
        assert!(out.to_string().contains(&a));
        mgr.wait_for(&[a.clone()], None, Duration::from_secs(5)).await;
        assert_eq!(mgr.get(&a).unwrap().runs, 3);
        // summary exposes what the UI needs
        let s = mgr.get(&a).unwrap().summary(false);
        assert!(s.get("runs").is_some() && s.get("memoryMode").is_some() && s.get("lastActiveAt").is_some());
        let rec = mgr.get(&a).unwrap();
        assert!(serde_json::to_value(&rec).unwrap().get("files").is_some());
    }

    #[test]
    fn delegation_prompt_explains_reuse_vs_new() {
        let dir = std::env::temp_dir().join(format!("subagents-test-{}", uuid::Uuid::new_v4()));
        let mgr = SubagentManager::new(dir, Arc::new(Arc::new(Script::default())));
        let p = mgr.delegation_prompt();
        assert!(p.contains("persist across turns") && p.contains("Spawn a new one for unrelated work"));
        let defs = SubagentManager::tool_definitions();
        let spawn = defs.iter().find(|d| d.name == TOOL_SPAWN).unwrap();
        assert!(spawn.input_schema.to_string().contains("\"reuse\""));
        let list = defs.iter().find(|d| d.name == TOOL_LIST).unwrap();
        for k in ["\"name\"", "\"query\"", "\"recent\"", "\"scope\""] {
            assert!(list.input_schema.to_string().contains(k));
        }
    }
}
