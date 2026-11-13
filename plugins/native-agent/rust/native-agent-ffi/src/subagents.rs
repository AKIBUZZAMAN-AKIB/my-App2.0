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
        self
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
}

impl SubagentRecord {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
    pub fn is_running(&self) -> bool {
        self.status == "running"
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
        if with_report && !self.is_running() {
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
}

/// Production runner: the regular agent loop and the engine's SQLite store.
pub struct EngineRunner {
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
        let settings = fs_read_json::<SubagentSettings>(&state_dir.join("settings.json"))
            .unwrap_or_default()
            .clamped();
        let mut records = fs_read_json::<Vec<SubagentRecord>>(&state_dir.join("registry.json")).unwrap_or_default();
        // Anything still "running" was cut off when the app last closed.
        let mut changed = false;
        for r in records.iter_mut().filter(|r| r.is_running()) {
            r.status = "error".into();
            r.error = Some("The app closed while this sub-agent was running.".into());
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
        });
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

    pub fn set_settings(&self, patch: &Value) -> SubagentSettings {
        let mut current = serde_json::to_value(self.settings()).unwrap_or(json!({}));
        if let (Some(obj), Some(p)) = (current.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                obj.insert(k.clone(), v.clone());
            }
        }
        let next = serde_json::from_value::<SubagentSettings>(current).unwrap_or_default().clamped();
        *self.settings.lock().unwrap() = next.clone();
        fs_write_json(&self.state_dir.join("settings.json"), &next);
        next
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
                match recs.iter().position(|r| !r.is_running()) {
                    Some(i) => {
                        let old = recs.remove(i);
                        self.runner.clear(&old.session_key);
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
                        "wait": {"type": "boolean", "description": "true (default): wait for the report. false: run in the background and return its id."}
                    },
                    "required": ["task"]
                }),
            ),
            def(
                TOOL_LIST,
                "List the sub-agents you started in this chat, with status, steps and token use. With wait=true, block until the given sub-agents (default: all of yours that are running) finish, then return their final reports.",
                json!({
                    "type": "object",
                    "properties": {
                        "ids": {"type": "array", "items": {"type": "string"}, "description": "Only these sub-agents. Reports are included for finished ones."},
                        "status": {"type": "string", "enum": ["running", "finished", "all"], "description": "Filter. Default: all."},
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
                        "id": {"type": "string", "description": "Sub-agent id from spawn_subagent or list_subagents."},
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
        let running = self.running_count();
        if running >= settings.max_parallel as usize {
            return Err(format!(
                "{} sub-agents are already running (limit {}). Wait for one with list_subagents(wait=true), or stop one.",
                running, settings.max_parallel
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
        };
        self.records.lock().unwrap().push(rec.clone());
        self.persist();
        let prompt = rec.task.clone();
        self.start_run(&rec, prompt, Vec::new(), env);
        Ok(rec)
    }

    fn start_run(self: &Arc<Self>, rec: &SubagentRecord, prompt: String, prior: Vec<Message>, env: &ParentEnv) {
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
        let (done_tx, done_rx) = watch::channel(false);
        let done_tx = Arc::new(done_tx);
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

    fn finish(&self, id: &str, status: &str, result: String, error: Option<String>, app: &Option<Arc<dyn NativeEventCallback>>) {
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
        if let Some(live) = live {
            let _ = live._done.send(true);
        }
    }

    fn emit(&self, cb: &Option<Arc<dyn NativeEventCallback>>, event: &str, rec: &SubagentRecord, extra: Value) {
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
        });
        if let (Some(obj), Some(more)) = (payload.as_object_mut(), extra.as_object()) {
            for (k, v) in more {
                obj.insert(k.clone(), v.clone());
            }
        }
        cb.on_event(event.to_string(), payload.to_string());
    }

    /// Stop one sub-agent. Returns false when it isn't running.
    pub fn stop(&self, id: &str, reason: &str) -> bool {
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

    pub fn stop_where<F: Fn(&SubagentRecord) -> bool>(&self, pred: F) -> Vec<String> {
        let ids: Vec<String> = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.is_running() && pred(r))
            .map(|r| r.id.clone())
            .collect();
        ids.into_iter().filter(|id| self.stop(id, "cancelled")).collect()
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
        let settings = self.settings();
        if self.running_count() >= settings.max_parallel as usize {
            return Err(format!("{} sub-agents are already running (limit {}).", self.running_count(), settings.max_parallel));
        }
        let prior = self.runner.load_messages(&rec.session_key);
        let rec = self
            .update(id, |r| {
                r.status = "running".into();
                r.result = None;
                r.error = None;
                r.finished_at = None;
                r.started_at = now_ms();
                r.runs += 1;
            })
            .ok_or("Sub-agent disappeared.")?;
        self.persist();
        self.start_run(&rec, text.to_string(), prior, env);
        Ok((rec, true))
    }

    /// Run the original task again from a clean context.
    pub fn retry(self: &Arc<Self>, id: &str, env: &ParentEnv) -> Result<SubagentRecord, String> {
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_running() {
            return Err("It is still running. Stop it first.".into());
        }
        let settings = self.settings();
        if self.running_count() >= settings.max_parallel as usize {
            return Err(format!("{} sub-agents are already running (limit {}).", self.running_count(), settings.max_parallel));
        }
        self.runner.clear(&rec.session_key);
        let rec = self
            .update(id, |r| {
                r.status = "running".into();
                r.result = None;
                r.error = None;
                r.finished_at = None;
                r.started_at = now_ms();
                r.input_tokens = 0;
                r.output_tokens = 0;
                r.steps = 0;
                r.tool_calls = 0;
                r.last_tool = None;
                r.runs += 1;
            })
            .ok_or("Sub-agent disappeared.")?;
        self.persist();
        let task = rec.task.clone();
        self.start_run(&rec, task, Vec::new(), env);
        Ok(rec)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_running() {
            return Err("It is still running. Stop it first.".into());
        }
        self.runner.clear(&rec.session_key);
        self.records.lock().unwrap().retain(|r| r.id != id);
        self.persist();
        Ok(())
    }

    /// Wait until none of `ids` is running. Stops them if the parent is
    /// cancelled (or the waiting future is dropped because of it).
    pub async fn wait_for(&self, ids: &[String], parent_abort: Option<Arc<Mutex<bool>>>, timeout: Duration) -> WaitEnd {
        let mut receivers: Vec<watch::Receiver<bool>> = {
            let live = self.live.lock().unwrap();
            ids.iter().filter_map(|id| live.get(id).map(|l| l.done_rx.clone())).collect()
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
                let rec = match self.spawn(parent_depth, spec, &env) {
                    Ok(r) => r,
                    Err(e) => return (e, true),
                };
                if !wait {
                    return (
                        format!(
                            "Started sub-agent \"{}\" (id {}) in the background with tools: {}. Call list_subagents with wait=true to collect its report, or use message_subagent / stop_subagent with this id.",
                            rec.name,
                            rec.id,
                            rec.tools.join(", ")
                        ),
                        false,
                    );
                }
                self.wait_and_report(&[rec.id.clone()], &env, None).await
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
                        None => self.list().into_iter().filter(|r| mine(r) && r.is_running()).map(|r| r.id).collect(),
                    };
                    if targets.is_empty() {
                        return ("No sub-agents of yours are running.".into(), false);
                    }
                    return self.wait_and_report(&targets, &env, timeout).await;
                }
                let items: Vec<Value> = self
                    .list()
                    .into_iter()
                    .filter(|r| match &ids {
                        Some(ids) => ids.contains(&r.id) && mine(r),
                        None => mine(r),
                    })
                    .filter(|r| match status.as_str() {
                        "running" => r.is_running(),
                        "finished" => !r.is_running(),
                        _ => true,
                    })
                    .map(|r| r.summary(ids.is_some()))
                    .collect();
                if items.is_empty() {
                    return ("You have no sub-agents in this chat yet.".into(), false);
                }
                (serde_json::to_string_pretty(&items).unwrap_or_default(), false)
            }
            TOOL_MESSAGE => {
                let id = input.get("id").and_then(Value::as_str).unwrap_or("");
                let text = input.get("message").and_then(Value::as_str).unwrap_or("");
                let wait = input.get("wait").and_then(Value::as_bool).unwrap_or(true);
                match self.get(id) {
                    Some(r) if r.parent_session_key == env.session_key => {}
                    _ => return (format!("No sub-agent of yours has id {}.", id), true),
                }
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

    async fn wait_and_report(&self, ids: &[String], env: &ParentEnv, timeout_s: Option<u64>) -> (String, bool) {
        let limit = self
            .settings()
            .timeout_seconds
            .max(ids.iter().filter_map(|id| self.get(id)).map(|r| r.timeout_seconds).max().unwrap_or(0))
            + 30;
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
            "list" => {
                let status = req.get("status").and_then(Value::as_str).unwrap_or("all");
                let parent = req.get("parentSessionKey").and_then(Value::as_str);
                let items: Vec<SubagentRecord> = self
                    .list()
                    .into_iter()
                    .filter(|r| parent.map_or(true, |p| r.parent_session_key == p))
                    .filter(|r| match status {
                        "running" => r.is_running(),
                        "finished" => !r.is_running(),
                        _ => true,
                    })
                    .collect();
                Ok(json!({ "subagents": items, "running": self.running_count(), "settings": self.settings() }))
            }
            "get" => {
                let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
                let transcript = self.runner.load_messages(&rec.session_key);
                Ok(json!({ "subagent": rec, "transcript": transcript, "memory": self.memory_entries(&rec.name) }))
            }
            "spawn" => {
                let mut spec: SpawnSpec = serde_json::from_value(req.clone()).map_err(|e| format!("Invalid spawn request: {}", e))?;
                spec.wait = Some(false);
                let rec = self.spawn(0, spec, env)?;
                Ok(json!({ "subagent": rec }))
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
            "message" => {
                let text = req.get("message").and_then(Value::as_str).unwrap_or("");
                let (rec, resumed) = self.message(id, text, env)?;
                Ok(json!({ "subagent": rec, "resumed": resumed }))
            }
            "retry" => Ok(json!({ "subagent": self.retry(id, env)? })),
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
    manager: &'a SubagentManager,
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
                let prompt = req.params.prompt.clone();
                let cb = req.callback.clone();
                let aborted = || async { *req.abort.lock().await };
                let mut reply = format!("done: {prompt}");
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
                messages.push(Message::user(&prompt));
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
        let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"task": "sleep:10"}), &env).await;
        assert!(err && out.contains("limit 3"), "{out}");
        let started = Instant::now();
        let (out, err) = run_tool(&mgr, TOOL_LIST, json!({"wait": true}), &env).await;
        assert!(!err);
        assert_eq!(out.matches("finished after").count(), 3, "{out}");
        assert!(started.elapsed() < Duration::from_millis(900), "ran in parallel, took {:?}", started.elapsed());
        assert_eq!(script.max_concurrent.load(Ordering::SeqCst), 3);
        assert_eq!(mgr.running_count(), 0);
        let (listing, _) = run_tool(&mgr, TOOL_LIST, json!({}), &env).await;
        assert_eq!(listing.matches("\"status\": \"finished\"").count(), 3, "{listing}");
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
}
