//! Steer: the user's words sent *while* a turn runs (docs/steer/PLAN.bn.md).
//!
//! Three pieces live here:
//!
//! * [`SteerEnvelope`] — one steer as the UI sent it (`id`, verbatim `text`,
//!   `attachments`, `at`, `target`, `mode`). It travels the existing string
//!   steer channel in a versioned JSON wire form ([`SteerEnvelope::encode`]),
//!   so the FFI surface (`steer(text)`) and every native binding stay as they
//!   are; plain text still decodes to an envelope with a generated id.
//! * The safe-point delivery the agent loop calls ([`SteerHub::take_deliverable`]):
//!   the verbatim text **always** reaches the model at the next safe point,
//!   whether the interpreter is quick, slow or failing. It goes in as a user
//!   message marked with [`STEER_TAG`], which keeps it inside the current turn
//!   (see `turn_memory::split_turns`).
//! * The interpreter ([`SteerHub::submit`]): one tokio task per agent handle (the
//!   "steer process" — same process, not an OS process). It turns a steer into a
//!   structured [`SteerPatch`] with a fast path (no model) for a bare stop or a
//!   tiny piece of information, and otherwise one structured-JSON call on the
//!   originating agent's own model. A second steer that arrives while the
//!   interpreter is busy goes to that same task: it stops the running request,
//!   saves what it had, and asks again with the old steer(s) plus the new one.
//!
//! Single writer: the interpreter never touches the session state. Only the
//! agent loop applies a patch ([`apply_patch_tx`]), in one `BEGIN IMMEDIATE`
//! transaction checked against the context tree revision the patch was based on.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Notify};

use crate::types::{ContentBlock, Message, MessageContent, Role};
use crate::NativeEventCallback;

/// Wire version key. A steer string whose JSON object carries this key is an
/// envelope; anything else is plain text.
pub const WIRE_KEY: &str = "steer_v";

/// First characters of the text of every steer message the engine writes.
pub const STEER_TAG: &str = "[steer ";

/// How long a safe point gives the interpreter before the verbatim text goes in
/// without a patch. The loop never waits longer than this, and only at the two
/// points that would otherwise start a model call or end the turn.
pub const DEFAULT_GRACE_MS: u64 = 2_500;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    format!("st-{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SteerEnvelope {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Value>,
    /// Epoch milliseconds when the user pressed Steer.
    pub at: i64,
    /// `None`/"main" for the running main agent; otherwise a sub-agent run id
    /// (or name) the steer is meant for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// "steer" (add to the task) or "update" (change the task). A hint for the
    /// interpreter; `None` reads as "steer".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

impl SteerEnvelope {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            id: new_id(),
            text: text.into(),
            attachments: Vec::new(),
            at: now_ms(),
            target: None,
            mode: None,
        }
    }

    /// The versioned wire form sent through the steer channel / `steer(text)`.
    pub fn encode(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let Some(o) = v.as_object_mut() {
            o.insert(WIRE_KEY.into(), json!(1));
        }
        v.to_string()
    }

    /// Decode a wire string. Plain text (or anything that is not a versioned
    /// envelope) becomes an envelope with a fresh id, so nothing is ever lost.
    pub fn decode(raw: &str) -> Self {
        let t = raw.trim_start();
        if t.starts_with('{') {
            if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(t) {
                if o.get(WIRE_KEY).is_some() {
                    let text = o.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let id = o
                        .get("id")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty() && s.len() <= 80)
                        .map(str::to_string)
                        .unwrap_or_else(new_id);
                    let attachments = o
                        .get("attachments")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let at = o.get("at").and_then(|v| v.as_i64()).unwrap_or_else(now_ms);
                    let target = o
                        .get("target")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "main")
                        .map(str::to_string);
                    let mode = o
                        .get("mode")
                        .and_then(|v| v.as_str())
                        .filter(|m| matches!(*m, "steer" | "update"))
                        .map(str::to_string);
                    return Self {
                        id,
                        text: text.to_string(),
                        attachments,
                        at,
                        target,
                        mode,
                    };
                }
            }
        }
        Self::new(raw)
    }

    pub fn is_update(&self) -> bool {
        self.mode.as_deref() == Some("update")
    }
}

// ---------------------------------------------------------------------------
// Steer messages in the transcript
// ---------------------------------------------------------------------------

/// The header line of a steer message. The model reads it, the UI hides it,
/// and [`steer_of`] / `split_turns` recognise it.
pub fn header(id: &str) -> String {
    format!("{STEER_TAG}{id}] The user sent this while you were working. It belongs to the current task, not a new one.")
}

fn patch_header(id: &str) -> String {
    format!("{STEER_TAG}{id} patch] How the engine read the user's steer above:")
}

/// The user message that carries a steer verbatim. Text only → a plain text
/// message (so every existing steer reader treats it as one); with attachments
/// → blocks, the text first.
pub fn steer_message(env: &SteerEnvelope, patch_note: Option<&str>) -> Message {
    let mut text = format!("{}\n\n{}", header(&env.id), env.text);
    if let Some(note) = patch_note.filter(|n| !n.trim().is_empty()) {
        text.push_str(&format!("\n\n({note})"));
    }
    let images: Vec<ContentBlock> = env
        .attachments
        .iter()
        .filter_map(attachment_block)
        .collect();
    if images.is_empty() {
        Message {
            role: Role::User,
            content: MessageContent::Text(text),
        }
    } else {
        let mut blocks = vec![ContentBlock::Text { text }];
        blocks.extend(images);
        Message {
            role: Role::User,
            content: MessageContent::Blocks(blocks),
        }
    }
}

/// The note pushed when a patch lands after its steer was already delivered.
pub fn patch_message(id: &str, note: &str) -> Message {
    Message {
        role: Role::User,
        content: MessageContent::Text(format!("{}\n{}", patch_header(id), note)),
    }
}

fn attachment_block(a: &Value) -> Option<ContentBlock> {
    // Same shape the UI sends for prompt attachments: {mimeType|mediaType, data}.
    let data = a.get("data").and_then(|v| v.as_str())?;
    let media = a
        .get("mimeType")
        .or_else(|| a.get("mediaType"))
        .or_else(|| a.get("media_type"))
        .and_then(|v| v.as_str())?;
    if !media.starts_with("image/") {
        return None;
    }
    serde_json::from_value(json!({
        "type": "image",
        "source": {"type": "base64", "media_type": media, "data": data}
    }))
    .ok()
}

fn first_text(m: &Message) -> Option<&str> {
    match &m.content {
        MessageContent::Text(t) => Some(t.as_str()),
        MessageContent::Blocks(bs) => bs.iter().find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        }),
    }
}

/// A steer message the engine wrote: `(id, verbatim text, is_patch_note)`.
pub fn steer_of(m: &Message) -> Option<(String, String, bool)> {
    if m.role != Role::User {
        return None;
    }
    let t = first_text(m)?;
    let rest = t.strip_prefix(STEER_TAG)?;
    let close = rest.find(']')?;
    let inner = &rest[..close];
    let (id, is_patch) = match inner.strip_suffix(" patch") {
        Some(id) => (id, true),
        None => (inner, false),
    };
    if id.is_empty() || id.contains(char::is_whitespace) {
        return None;
    }
    let body = &rest[close + 1..];
    let verbatim = if is_patch {
        body.split_once('\n').map(|(_, b)| b).unwrap_or("").to_string()
    } else {
        let b = body.split_once("\n\n").map(|(_, b)| b).unwrap_or("");
        // Drop a trailing "(patch note)" paragraph the engine added.
        match b.rfind("\n\n(") {
            Some(i) if b.ends_with(')') => b[..i].to_string(),
            _ => b.to_string(),
        }
    };
    Some((id.to_string(), verbatim, is_patch))
}

pub fn is_steer_message(m: &Message) -> bool {
    steer_of(m).is_some()
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SteerIntent {
    AddInfo,
    Amend,
    Redirect,
    Cancel,
    NewTask,
    Question,
}

impl SteerIntent {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().replace(['_', '-', ' '], "").as_str() {
            "addinfo" | "info" => Self::AddInfo,
            "amend" | "update" => Self::Amend,
            "redirect" => Self::Redirect,
            "cancel" | "stop" => Self::Cancel,
            "newtask" => Self::NewTask,
            "question" => Self::Question,
            _ => return None,
        })
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AddInfo => "AddInfo",
            Self::Amend => "Amend",
            Self::Redirect => "Redirect",
            Self::Cancel => "Cancel",
            Self::NewTask => "NewTask",
            Self::Question => "Question",
        }
    }
    /// Whether this steer changes the direction of the work (gates approvals
    /// and steer-driven file edits).
    pub fn changes_direction(&self) -> bool {
        matches!(self, Self::Amend | Self::Redirect)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchBase {
    pub step: u32,
    pub ctx_rev: i64,
    pub strategy_version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecklistOp {
    /// "add" | "done" | "drop"
    pub op: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SteerPatch {
    /// Unique per patch; one patch can cover several steers (a re-asked batch).
    pub uid: String,
    pub steer_ids: Vec<String>,
    pub intent: SteerIntent,
    #[serde(default)]
    pub goal_edit: Option<String>,
    #[serde(default)]
    pub plan_edit: Option<String>,
    #[serde(default)]
    pub ctx_ops: Vec<Value>,
    #[serde(default)]
    pub checklist_ops: Vec<ChecklistOp>,
    #[serde(default)]
    pub target_agent: Option<String>,
    #[serde(default)]
    pub agent_note: Option<String>,
    /// For `Question`: the answer the steer process gives from the snapshot.
    #[serde(default)]
    pub answer: Option<String>,
    pub base: PatchBase,
    /// "fast" | "model" | "fallback"
    pub source: String,
}

impl SteerPatch {
    fn plain(ids: Vec<String>, intent: SteerIntent, base: PatchBase, source: &str) -> Self {
        Self {
            uid: format!("sp-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]),
            steer_ids: ids,
            intent,
            goal_edit: None,
            plan_edit: None,
            ctx_ops: Vec::new(),
            checklist_ops: Vec::new(),
            target_agent: None,
            agent_note: None,
            answer: None,
            base,
            source: source.into(),
        }
    }

    /// One short line for the model: what the engine understood. Empty when the
    /// verbatim text says it all (a plain AddInfo).
    pub fn note(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if self.intent != SteerIntent::AddInfo {
            parts.push(format!("intent: {}", self.intent.as_str()));
        }
        if let Some(g) = &self.goal_edit {
            parts.push(format!("goal now: {g}"));
        }
        if let Some(p) = &self.plan_edit {
            parts.push(format!("plan now: {p}"));
        }
        let todo: Vec<&str> = self
            .checklist_ops
            .iter()
            .filter(|c| c.op == "add")
            .map(|c| c.text.as_str())
            .collect();
        if !todo.is_empty() {
            parts.push(format!("to do: {}", todo.join("; ")));
        }
        if let Some(n) = &self.agent_note {
            parts.push(n.clone());
        }
        parts.join(" · ")
    }
}

/// The fast path: no model call for a bare stop, or for a tiny piece of
/// information (a short steer, not an "update").
pub fn fast_path(env: &SteerEnvelope, base: &PatchBase) -> Option<SteerPatch> {
    let norm: String = env
        .text
        .trim()
        .trim_matches(|c: char| c.is_ascii_punctuation() || c == '।' || c.is_whitespace())
        .to_lowercase();
    const STOP: &[&str] = &[
        "stop", "stop it", "stop now", "cancel", "abort", "halt", "wait stop",
        "থামো", "থাম", "থামাও", "থামুন", "বন্ধ করো", "বন্ধ কর", "বাদ দাও",
        "ruko", "ruk jao", "thamo", "thamao", "bondho koro", "bad dao",
    ];
    if env.attachments.is_empty() && STOP.contains(&norm.as_str()) {
        return Some(SteerPatch::plain(
            vec![env.id.clone()],
            SteerIntent::Cancel,
            base.clone(),
            "fast",
        ));
    }
    let words = norm.split_whitespace().count();
    if !env.is_update()
        && env.target.is_none()
        && words > 0
        && words <= 6
        && norm.chars().count() <= 48
        && !norm.contains('?')
        && !env.text.contains('?')
    {
        return Some(SteerPatch::plain(
            vec![env.id.clone()],
            SteerIntent::AddInfo,
            base.clone(),
            "fast",
        ));
    }
    None
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/// What the steer process may read about the running agent, published by the
/// loop through a `tokio::sync::watch` channel (never the loop's own state).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AgentSnapshot {
    pub session_key: String,
    pub running: bool,
    pub step: u32,
    /// "model" | "tools" | "approval" | "idle"
    pub phase: String,
    pub goal: String,
    pub plan: String,
    pub ctx_rev: i64,
    pub strategy_version: i64,
    pub recent_tools: Vec<String>,
    pub files_touched: Vec<String>,
    pub subagents: Vec<String>,
}

impl AgentSnapshot {
    pub fn base(&self) -> PatchBase {
        PatchBase {
            step: self.step,
            ctx_rev: self.ctx_rev,
            strategy_version: self.strategy_version,
        }
    }
}

// ---------------------------------------------------------------------------
// Model access for the interpreter
// ---------------------------------------------------------------------------

pub type SteerModelFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
/// `(system, user, max_tokens) -> text`, built by the loop on the agent's own
/// route (so the interpreter always uses the originating agent's model).
pub type SteerModel = Arc<dyn Fn(String, String, u32) -> SteerModelFuture + Send + Sync>;

pub const INTERPRETER_SYSTEM: &str = "You are the steer interpreter of a coding/chat agent. The user typed one or more messages WHILE the agent was working. Read them against the agent snapshot and answer with ONE JSON object and nothing else:\n{\"intent\": \"AddInfo|Amend|Redirect|Cancel|NewTask|Question\", \"goal_edit\": null or \"the task goal rewritten with the change\", \"plan_edit\": null or \"the new plan in one short paragraph\", \"checklist\": [\"short to-do the steer adds\"], \"target_agent\": null or \"sub-agent id/name when the words are meant for one of the listed sub-agents\", \"agent_note\": null or \"one sentence for the agent\", \"answer\": null or \"for Question only: a short answer from the snapshot\", \"ctx_ops\": []}\nRules: AddInfo = extra facts for the same task. Amend = same task, changed requirement. Redirect = drop the current approach and do something else for the same request. Cancel = stop. NewTask = an unrelated request that should wait for its own turn. Question = the user only asks about progress. When several messages are given, the LAST one wins on any conflict. Never invent facts; keep the user's own words in edits.";

/// Parse the interpreter's JSON into a patch. `None` when the text holds no
/// usable object (the caller falls back to verbatim-only).
pub fn parse_patch(text: &str, ids: &[String], base: &PatchBase) -> Option<SteerPatch> {
    let o = crate::turn_memory::extract_json_object(text)?;
    let intent = o
        .get("intent")
        .and_then(|v| v.as_str())
        .and_then(SteerIntent::parse)?;
    let s = |k: &str| {
        o.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(2_000).collect::<String>())
    };
    let mut p = SteerPatch::plain(ids.to_vec(), intent, base.clone(), "model");
    p.goal_edit = s("goal_edit");
    p.plan_edit = s("plan_edit");
    p.target_agent = s("target_agent");
    p.agent_note = s("agent_note");
    p.answer = s("answer");
    if let Some(list) = o.get("checklist").and_then(|v| v.as_array()) {
        p.checklist_ops = list
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .take(12)
            .map(|t| ChecklistOp {
                op: "add".into(),
                text: t.chars().take(200).collect(),
            })
            .collect();
    }
    if let Some(ops) = o.get("ctx_ops").and_then(|v| v.as_array()) {
        p.ctx_ops = ops.iter().take(12).cloned().collect();
    }
    Some(p)
}

pub fn interpreter_prompt(snapshot: &AgentSnapshot, batch: &[SteerEnvelope], earlier: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str("Agent snapshot:\n");
    out.push_str(&serde_json::to_string_pretty(snapshot).unwrap_or_default());
    out.push_str("\n\n");
    if let Some(e) = earlier.filter(|e| !e.is_empty()) {
        out.push_str("Work saved from the interrupted earlier reading (re-check it against the newest message):\n");
        out.push_str(e);
        out.push_str("\n\n");
    }
    let n = batch.len();
    for (i, env) in batch.iter().enumerate() {
        let label = if i + 1 == n && n > 1 {
            "Newest message (wins on conflict)".to_string()
        } else if n > 1 {
            format!("Earlier message {}", i + 1)
        } else {
            "Message".to_string()
        };
        let mode = if env.is_update() { " [sent with Update: the user wants the task changed]" } else { "" };
        out.push_str(&format!("{label}{mode}:\n{}\n\n", env.text));
    }
    out
}

// ---------------------------------------------------------------------------
// Hub: one per agent handle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SafePoint {
    /// SP1: top of an iteration, before the model call.
    BeforeModel,
    /// SP2: between sequential tool calls.
    BetweenTools,
    /// SP3: before the loop would end the turn.
    BeforeBreak,
    /// SP4: while a tool waits for approval.
    Approval,
}

impl SafePoint {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::BeforeModel => "SP1",
            Self::BetweenTools => "SP2",
            Self::BeforeBreak => "SP3",
            Self::Approval => "SP4",
        }
    }
}

/// What one safe point hands the loop.
#[derive(Debug, Default)]
pub struct Delivery {
    /// Steer messages (verbatim) and late patch notes, in order.
    pub messages: Vec<Message>,
    /// A delivered steer asked to stop.
    pub cancel: bool,
    /// A delivered patch changes direction (Amend/Redirect).
    pub redirect: Option<String>,
    /// Patches to apply (single writer: the loop).
    pub patches: Vec<SteerPatch>,
    /// Ids delivered verbatim at this point.
    pub delivered: Vec<String>,
}

impl Delivery {
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty() && !self.cancel && self.patches.is_empty()
    }
}

#[derive(Default)]
struct HubState {
    /// Envelopes read from the channel but not delivered yet (waiting for the
    /// grace window or for their patch).
    pending: VecDeque<SteerEnvelope>,
    /// Patches by steer id, not applied yet.
    patches: HashMap<String, SteerPatch>,
    /// Patch uids already applied.
    applied_patches: HashSet<String>,
    /// Steer ids already delivered verbatim (or answered / routed / queued).
    delivered: HashSet<String>,
    /// Steer ids whose interpretation failed (deliver at once).
    failed: HashSet<String>,
    /// Per-steer checklists of the running turn: id -> items.
    checklists: Vec<SteerChecklist>,
    /// Goal revisions of the running turn, deduped by steer id.
    goal_revisions: Vec<(String, String)>,
    /// Steer ids that changed direction in this turn (file-edit gate).
    direction_changes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SteerChecklist {
    pub steer_id: String,
    /// Default true: a new steer's checklist is active (rendered).
    pub active: bool,
    pub items: Vec<(String, bool)>,
}

pub struct SteerHub {
    state: Mutex<HubState>,
    notify: Notify,
    snapshot_tx: watch::Sender<AgentSnapshot>,
    model: Mutex<Option<SteerModel>>,
    interpreter: Mutex<Option<mpsc::UnboundedSender<SteerEnvelope>>>,
    /// How many interpreter tasks were ever spawned (one per handle normally).
    pub spawned: AtomicUsize,
    /// How many model requests the interpreter sent (tests).
    pub requests: AtomicUsize,
    grace_ms: Mutex<u64>,
    db_path: Mutex<Option<String>>,
    callback: Mutex<Option<Arc<dyn NativeEventCallback>>>,
}

impl Default for SteerHub {
    fn default() -> Self {
        Self::new()
    }
}

impl SteerHub {
    pub fn new() -> Self {
        let (snapshot_tx, _) = watch::channel(AgentSnapshot::default());
        Self {
            state: Mutex::new(HubState::default()),
            notify: Notify::new(),
            snapshot_tx,
            model: Mutex::new(None),
            interpreter: Mutex::new(None),
            spawned: AtomicUsize::new(0),
            requests: AtomicUsize::new(0),
            grace_ms: Mutex::new(DEFAULT_GRACE_MS),
            db_path: Mutex::new(None),
            callback: Mutex::new(None),
        }
    }

    pub fn set_grace_ms(&self, ms: u64) {
        *self.grace_ms.lock().unwrap() = ms;
    }
    fn grace(&self) -> u64 {
        *self.grace_ms.lock().unwrap()
    }
    pub fn set_db_path(&self, p: &str) {
        *self.db_path.lock().unwrap() = Some(p.to_string());
    }
    pub fn db_path(&self) -> Option<String> {
        self.db_path.lock().unwrap().clone()
    }
    pub fn set_callback(&self, cb: Option<Arc<dyn NativeEventCallback>>) {
        *self.callback.lock().unwrap() = cb;
    }
    fn emit(&self, event: &str, payload: Value) {
        let cb = self.callback.lock().unwrap().clone();
        crate::event_bus::emit(cb.as_deref(), event, &payload);
    }

    pub fn set_model(&self, model: SteerModel) {
        *self.model.lock().unwrap() = Some(model);
    }
    fn model(&self) -> Option<SteerModel> {
        self.model.lock().unwrap().clone()
    }

    pub fn publish(&self, snap: AgentSnapshot) {
        self.snapshot_tx.send_replace(snap);
    }
    pub fn snapshot(&self) -> AgentSnapshot {
        self.snapshot_tx.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<AgentSnapshot> {
        self.snapshot_tx.subscribe()
    }
    pub fn update_snapshot(&self, f: impl FnOnce(&mut AgentSnapshot)) {
        self.snapshot_tx.send_modify(f);
    }

    /// Start of a turn: forget the last turn's per-turn state.
    pub fn begin_turn(&self, session_key: &str) {
        let mut s = self.state.lock().unwrap();
        s.checklists.clear();
        s.goal_revisions.clear();
        s.direction_changes.clear();
        s.applied_patches.clear();
        drop(s);
        self.update_snapshot(|snap| {
            snap.session_key = session_key.to_string();
            snap.running = true;
            snap.step = 0;
            snap.phase = "model".into();
            snap.recent_tools.clear();
            snap.files_touched.clear();
        });
    }

    pub fn end_turn(&self) {
        self.update_snapshot(|snap| {
            snap.running = false;
            snap.phase = "idle".into();
        });
    }

    /// Hand a steer to the steer process. The first steer spawns it; later
    /// steers go to the same task (which restarts a running reading). The fast
    /// path answers at once without a task.
    pub fn submit(self: &Arc<Self>, env: SteerEnvelope) -> Option<SteerPatch> {
        let base = self.snapshot().base();
        if let Some(p) = fast_path(&env, &base) {
            self.store_patch(p.clone());
            return Some(p);
        }
        if self.model().is_none() {
            // No route known yet: nothing to interpret with. Verbatim delivery
            // still happens at the next safe point.
            self.state.lock().unwrap().failed.insert(env.id.clone());
            self.notify.notify_waiters();
            return None;
        }
        let mut slot = self.interpreter.lock().unwrap();
        if let Some(tx) = slot.as_ref() {
            match tx.send(env) {
                Ok(()) => return None,
                Err(e) => {
                    // The task ended (runtime shut down): start a new one.
                    let env = e.0;
                    let tx = self.spawn_interpreter();
                    let _ = tx.send(env);
                    *slot = Some(tx);
                    return None;
                }
            }
        }
        let tx = self.spawn_interpreter();
        let _ = tx.send(env);
        *slot = Some(tx);
        None
    }

    fn spawn_interpreter(self: &Arc<Self>) -> mpsc::UnboundedSender<SteerEnvelope> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.spawned.fetch_add(1, Ordering::SeqCst);
        let hub = Arc::downgrade(self);
        tokio::spawn(interpreter_task(hub, rx));
        tx
    }

    fn store_patch(&self, p: SteerPatch) {
        let mut s = self.state.lock().unwrap();
        for id in &p.steer_ids {
            s.patches.insert(id.clone(), p.clone());
        }
        drop(s);
        if let Some(db) = self.db_path() {
            if let Ok(conn) = Connection::open(&db) {
                for id in &p.steer_ids {
                    let _ = inbox_set_patch(&conn, id, &p);
                }
            }
        }
        self.emit(
            "steer.interpreted",
            json!({"ids": p.steer_ids, "intent": p.intent.as_str(), "source": p.source}),
        );
        self.notify.notify_waiters();
    }

    fn mark_failed(&self, ids: &[String]) {
        let mut s = self.state.lock().unwrap();
        for id in ids {
            s.failed.insert(id.clone());
        }
        drop(s);
        self.notify.notify_waiters();
    }

    /// Wait until a patch or failure lands (or `ms` pass).
    pub async fn wait_change(&self, ms: u64) {
        let n = self.notify.notified();
        tokio::pin!(n);
        let _ = tokio::time::timeout(Duration::from_millis(ms), n).await;
    }

    /// Resolves once a steer whose patch changes direction is known for an
    /// envelope that is pending or was delivered in this turn. Used at SP4.
    pub async fn wait_redirect(&self) -> String {
        loop {
            let n = self.notify.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            if let Some(id) = self.redirect_known() {
                return id;
            }
            n.await;
        }
    }

    pub fn redirect_known(&self) -> Option<String> {
        let s = self.state.lock().unwrap();
        s.pending.iter().find_map(|e| {
            s.patches
                .get(&e.id)
                .filter(|p| p.intent.changes_direction() || p.intent == SteerIntent::Cancel)
                .map(|_| e.id.clone())
        })
    }

    pub fn has_pending(&self) -> bool {
        let s = self.state.lock().unwrap();
        !s.pending.is_empty() || s.patches.values().any(|p| !s.applied_patches.contains(&p.uid))
    }

    /// Envelopes the loop read from the channel go here first.
    pub fn enqueue(&self, envs: Vec<SteerEnvelope>) {
        if envs.is_empty() {
            return;
        }
        let mut s = self.state.lock().unwrap();
        for e in envs {
            if !s.delivered.contains(&e.id) && !s.pending.iter().any(|p| p.id == e.id) {
                s.pending.push_back(e);
            }
        }
    }

    /// Everything still pending, removed (turn ended before a safe point).
    pub fn take_leftovers(&self) -> Vec<SteerEnvelope> {
        let mut s = self.state.lock().unwrap();
        let out: Vec<SteerEnvelope> = s.pending.drain(..).collect();
        for e in &out {
            s.delivered.insert(e.id.clone());
        }
        out
    }

    /// The safe-point core. `force` delivers every pending envelope verbatim
    /// (patch or not); otherwise an envelope waits until its patch is ready,
    /// its interpretation failed, or the grace window passed.
    pub fn take_deliverable(&self, point: &SafePoint, force: bool) -> Delivery {
        let grace = self.grace() as i64;
        let now = now_ms();
        let mut d = Delivery::default();
        let mut events: Vec<(&'static str, Value)> = Vec::new();
        let mut s = self.state.lock().unwrap();
        let mut keep: VecDeque<SteerEnvelope> = VecDeque::new();
        let pending: Vec<SteerEnvelope> = s.pending.drain(..).collect();
        for env in pending {
            let patch = s.patches.get(&env.id).cloned();
            let ready = force
                || patch.is_some()
                || s.failed.contains(&env.id)
                || now.saturating_sub(env.at) >= grace;
            if !ready {
                keep.push_back(env);
                continue;
            }
            s.delivered.insert(env.id.clone());
            match patch.as_ref().map(|p| p.intent) {
                Some(SteerIntent::NewTask) => {
                    s.applied_patches.insert(patch.as_ref().unwrap().uid.clone());
                    events.push((
                        "steer.unapplied",
                        json!({"id": env.id, "text": env.text, "reason": "new_task"}),
                    ));
                    continue;
                }
                Some(SteerIntent::Question) if patch.as_ref().and_then(|p| p.answer.as_ref()).is_some() => {
                    let p = patch.unwrap();
                    s.applied_patches.insert(p.uid.clone());
                    events.push((
                        "steer.answer",
                        json!({"id": env.id, "text": p.answer}),
                    ));
                    continue;
                }
                _ => {}
            }
            let note = patch.as_ref().map(|p| p.note()).unwrap_or_default();
            d.messages.push(steer_message(&env, Some(&note)));
            d.delivered.push(env.id.clone());
            if let Some(p) = patch {
                if p.intent == SteerIntent::Cancel {
                    d.cancel = true;
                }
                if p.intent.changes_direction() {
                    d.redirect = Some(env.id.clone());
                    s.direction_changes.push(env.id.clone());
                }
                if s.applied_patches.insert(p.uid.clone()) {
                    d.patches.push(p);
                }
            }
            events.push((
                "steer.applied",
                json!({"id": env.id, "point": point.as_str(), "step": self.snapshot_tx.borrow().step}),
            ));
        }
        s.pending = keep;
        // Late patches: their steer went in verbatim earlier.
        let late: Vec<SteerPatch> = s
            .patches
            .values()
            .filter(|p| !s.applied_patches.contains(&p.uid))
            .filter(|p| p.steer_ids.iter().all(|id| s.delivered.contains(id)))
            .cloned()
            .collect();
        let mut seen = HashSet::new();
        for p in late {
            if !seen.insert(p.uid.clone()) {
                continue;
            }
            s.applied_patches.insert(p.uid.clone());
            if matches!(p.intent, SteerIntent::NewTask | SteerIntent::Question) {
                // Already in the transcript verbatim: the model handles it.
                continue;
            }
            let note = p.note();
            let id = p.steer_ids.last().cloned().unwrap_or_default();
            if !note.is_empty() {
                d.messages.push(patch_message(&id, &note));
            }
            if p.intent == SteerIntent::Cancel {
                d.cancel = true;
            }
            if p.intent.changes_direction() {
                d.redirect = Some(id.clone());
                s.direction_changes.push(id);
            }
            d.patches.push(p);
        }
        // Patches are applied in steer order, so the latest user words win.
        d.patches.sort_by_key(|p| p.base.step);
        drop(s);
        if let Some(db) = self.db_path() {
            if let Ok(conn) = Connection::open(&db) {
                for id in &d.delivered {
                    let _ = inbox_set_status(&conn, id, "applied");
                }
            }
        }
        for (e, p) in events {
            self.emit(e, p);
        }
        d
    }

    /// Record what a patch did to the turn's own steer state (single writer:
    /// called by the loop right after [`apply_patch_tx`]).
    pub fn record_patch(&self, p: &SteerPatch) {
        let mut s = self.state.lock().unwrap();
        let id = p.steer_ids.last().cloned().unwrap_or_default();
        if let Some(g) = &p.goal_edit {
            // Revisions are deduped by steer id, not text.
            if let Some(slot) = s.goal_revisions.iter_mut().find(|(i, _)| *i == id) {
                slot.1 = g.clone();
            } else {
                s.goal_revisions.push((id.clone(), g.clone()));
            }
        }
        let adds: Vec<(String, bool)> = p
            .checklist_ops
            .iter()
            .filter(|c| c.op == "add")
            .map(|c| (c.text.clone(), false))
            .collect();
        if !adds.is_empty() {
            if let Some(cl) = s.checklists.iter_mut().find(|c| c.steer_id == id) {
                cl.items.extend(adds);
            } else {
                s.checklists.push(SteerChecklist {
                    steer_id: id.clone(),
                    active: true,
                    items: adds,
                });
            }
        }
        for c in p.checklist_ops.iter().filter(|c| c.op == "done" || c.op == "drop") {
            for cl in s.checklists.iter_mut() {
                if c.op == "drop" {
                    cl.items.retain(|(t, _)| t != &c.text);
                } else if let Some(it) = cl.items.iter_mut().find(|(t, _)| t == &c.text) {
                    it.1 = true;
                }
            }
        }
    }

    /// Lines for `render_task_block`: the turn's steer goal revisions and the
    /// active per-steer checklists. Empty when no steer changed anything.
    pub fn task_lines(&self) -> Vec<String> {
        let s = self.state.lock().unwrap();
        let mut out = Vec::new();
        if let Some((id, g)) = s.goal_revisions.last() {
            out.push(format!("Goal as changed by steer {id}: {g}"));
        }
        for cl in s.checklists.iter().filter(|c| c.active && !c.items.is_empty()) {
            let items: Vec<String> = cl
                .items
                .iter()
                .map(|(t, done)| format!("[{}] {t}", if *done { "x" } else { " " }))
                .collect();
            out.push(format!("Steer {} to-do: {}", cl.steer_id, items.join("; ")));
        }
        out
    }

    pub fn checklists(&self) -> Vec<SteerChecklist> {
        self.state.lock().unwrap().checklists.clone()
    }

    pub fn set_checklist_active(&self, steer_id: &str, active: bool) -> bool {
        let mut s = self.state.lock().unwrap();
        match s.checklists.iter_mut().find(|c| c.steer_id == steer_id) {
            Some(c) => {
                c.active = active;
                true
            }
            None => false,
        }
    }

    /// Whether a steer in this turn changed direction (file-edit permission).
    pub fn direction_changed(&self) -> Option<String> {
        self.state.lock().unwrap().direction_changes.last().cloned()
    }
}

async fn interpreter_task(hub: std::sync::Weak<SteerHub>, mut rx: mpsc::UnboundedReceiver<SteerEnvelope>) {
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];
        let mut earlier: Option<String> = None;
        loop {
            let Some(h) = hub.upgrade() else { return };
            let ids: Vec<String> = batch.iter().map(|e| e.id.clone()).collect();
            let Some(model) = h.model() else {
                h.mark_failed(&ids);
                break;
            };
            let snap = h.snapshot();
            let base = snap.base();
            let user = interpreter_prompt(&snap, &batch, earlier.as_deref());
            h.requests.fetch_add(1, Ordering::SeqCst);
            h.emit("steer.interpreting", json!({"ids": ids}));
            drop(h);
            let call = model(INTERPRETER_SYSTEM.to_string(), user.clone(), 600);
            tokio::pin!(call);
            tokio::select! {
                res = &mut call => {
                    let Some(h) = hub.upgrade() else { return };
                    match res.ok().and_then(|t| parse_patch(&t, &ids, &base)) {
                        Some(p) => h.store_patch(p),
                        None => h.mark_failed(&ids),
                    }
                    break;
                }
                next = rx.recv() => {
                    let Some(next) = next else { return };
                    // A second steer: stop the running reading, save what it
                    // had (the earlier steers and the request), ask again with
                    // the old work plus the new steer.
                    let Some(h) = hub.upgrade() else { return };
                    if let Some(db) = h.db_path() {
                        if let Ok(conn) = Connection::open(&db) {
                            for id in &ids {
                                let _ = inbox_set_status(&conn, id, "reinterpreting");
                            }
                        }
                    }
                    h.emit("steer.restarted", json!({"ids": ids, "by": next.id}));
                    let saved: Vec<String> = batch.iter().map(|e| format!("- {}: {}", e.id, e.text)).collect();
                    earlier = Some(saved.join("\n"));
                    batch.push(next);
                    continue;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// steer_inbox: durable record of every steer
// ---------------------------------------------------------------------------

pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS steer_inbox (
            id TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            text TEXT NOT NULL,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            target TEXT,
            mode TEXT,
            at INTEGER NOT NULL,
            status TEXT NOT NULL,
            patch_json TEXT,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_steer_inbox_status ON steer_inbox(status);",
    )
}

pub fn inbox_insert(conn: &Connection, session_key: &str, env: &SteerEnvelope, status: &str) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO steer_inbox (id, session_key, text, attachments_json, target, mode, at, status, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            env.id,
            session_key,
            env.text,
            Value::Array(env.attachments.clone()).to_string(),
            env.target,
            env.mode,
            env.at,
            status,
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn inbox_set_status(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    conn.execute(
        "UPDATE steer_inbox SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, status, now_ms()],
    )?;
    Ok(())
}

fn inbox_set_patch(conn: &Connection, id: &str, p: &SteerPatch) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    conn.execute(
        "UPDATE steer_inbox SET patch_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, serde_json::to_string(p).unwrap_or_default(), now_ms()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InboxRow {
    pub id: String,
    #[serde(rename = "sessionKey")]
    pub session_key: String,
    pub text: String,
    pub at: i64,
    pub status: String,
}

/// Steers that were accepted but never reached the model (the app closed in
/// between). Marks them `unapplied` and returns them, oldest first, so the UI
/// can show them to the user after a restart.
pub fn inbox_take_unapplied(conn: &Connection) -> rusqlite::Result<Vec<InboxRow>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, session_key, text, at, status FROM steer_inbox
         WHERE status IN ('accepted','reinterpreting','unapplied') ORDER BY at ASC LIMIT 50",
    )?;
    let rows: Vec<InboxRow> = stmt
        .query_map([], |r| {
            Ok(InboxRow {
                id: r.get(0)?,
                session_key: r.get(1)?,
                text: r.get(2)?,
                at: r.get(3)?,
                status: r.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    for r in &rows {
        conn.execute(
            "UPDATE steer_inbox SET status = 'unapplied', updated_at = ?2 WHERE id = ?1",
            params![r.id, now_ms()],
        )?;
    }
    Ok(rows)
}

/// The user saw an unapplied steer (re-sent or dismissed it).
pub fn inbox_dismiss(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    inbox_set_status(conn, id, "dismissed")
}

pub fn inbox_status(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT status FROM steer_inbox WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

// ---------------------------------------------------------------------------
// Applying a patch: single writer, one transaction
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ApplyOutcome {
    pub ctx_applied: usize,
    /// The tree moved since the patch was read: ops were re-checked on the new
    /// revision (`rebased`) or dropped (`ctx_dropped`, with `note`).
    pub rebased: bool,
    pub ctx_dropped: bool,
    pub strategy_version: Option<i64>,
    pub refused_locked: usize,
    pub note: Option<String>,
}

/// Apply the structured part of a patch in one `BEGIN IMMEDIATE` transaction:
/// context ops checked against `base.ctx_rev` (rebased when still valid on the
/// newest revision, else dropped with a note — the verbatim text already went
/// in), the plan edit as a new strategy version that keeps the old plan as
/// superseded, and the inbox row. `ucl/*` (user checklists) are read-only here.
pub fn apply_patch_tx(db_path: &str, session_key: &str, p: &SteerPatch) -> Result<ApplyOutcome, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(Duration::from_secs(5));
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    let res = apply_inner(&conn, session_key, p);
    match res {
        Ok(o) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(o)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn apply_inner(conn: &Connection, session_key: &str, p: &SteerPatch) -> Result<ApplyOutcome, String> {
    use crate::context_tree::{ops, store};
    let mut out = ApplyOutcome::default();
    let now = now_ms();
    // Context ops, minus anything on the user's own checklists.
    let raw: Vec<Value> = p
        .ctx_ops
        .iter()
        .filter(|o| {
            let locked = o
                .get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|id| id.starts_with("ucl/") || id == "ucl");
            if locked {
                out.refused_locked += 1;
            }
            !locked
        })
        .cloned()
        .collect();
    if !raw.is_empty() {
        match ops::parse_ops(&Value::Array(raw)) {
            Ok(list) => {
                let env = ops::BatchEnv {
                    session_key,
                    now_ms: now,
                    now_turn: None,
                    step: Some(p.base.step),
                    actor: "steer",
                    tool: "steer",
                };
                let r = ops::apply_batch(conn, &env, &list, Some(p.base.ctx_rev), false)
                    .map_err(|e| e.to_string())?;
                if r.stale {
                    // Rebase: re-check on the newest revision.
                    let cur = store::rev(conn, session_key).map_err(|e| e.to_string())?;
                    let dry = ops::apply_batch(conn, &env, &list, Some(cur), true)
                        .map_err(|e| e.to_string())?;
                    if dry.refused == 0 && !dry.stale {
                        let r2 = ops::apply_batch(conn, &env, &list, Some(cur), false)
                            .map_err(|e| e.to_string())?;
                        out.ctx_applied = r2.applied;
                        out.rebased = true;
                    } else {
                        out.ctx_dropped = true;
                        out.note = Some("the context changed while the steer was read; its context changes were not applied, the user's words above stand as written".into());
                    }
                } else {
                    out.ctx_applied = r.applied;
                }
            }
            Err(e) => {
                out.ctx_dropped = true;
                out.note = Some(format!("steer context changes ignored: {e}"));
            }
        }
    }
    // Plan edit: a new strategy version; the old plan stays, marked superseded.
    if let Some(plan) = &p.plan_edit {
        let old = store::latest_strategy(conn, session_key).map_err(|e| e.to_string())?;
        let mut text = plan.clone();
        if let Some((v, old_text, _)) = old {
            if !old_text.trim().is_empty() {
                let id = p.steer_ids.last().cloned().unwrap_or_default();
                text.push_str(&format!(
                    "\n\nSuperseded by steer {id} (plan v{v}, kept, not deleted; steps already done stay done):\n{}",
                    old_text.chars().take(1_500).collect::<String>()
                ));
            }
        }
        let v = store::put_strategy(conn, session_key, &text, None, now).map_err(|e| e.to_string())?;
        out.strategy_version = Some(v);
    }
    ensure_schema(conn).map_err(|e| e.to_string())?;
    for id in &p.steer_ids {
        conn.execute(
            "UPDATE steer_inbox SET patch_json = ?2, status = 'applied', updated_at = ?3 WHERE id = ?1",
            params![id, serde_json::to_string(p).unwrap_or_default(), now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Steer-driven file edits: permission + git checkpoints
// ---------------------------------------------------------------------------

/// Permission key (tool_permissions) for file edits a steer drives:
/// `always_allow` or ask (the default).
pub const STEER_EDIT_PERMISSION: &str = "steer_file_edits";

/// The steer checkpoint repository's git dir, next to the agent database.
pub fn checkpoint_dir(db_path: &str) -> std::path::PathBuf {
    std::path::Path::new(db_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default()
        .join("steer-checkpoints.git")
}

/// Tools that write files in the workspace.
pub fn is_file_write_tool(name: &str) -> bool {
    matches!(
        name,
        "write_file" | "edit_file" | "apply_patch" | "delete_file" | "move_file" | "create_file" | "multi_edit"
    )
}

/// Paths a file-writing call touches, from its arguments.
pub fn paths_of(args: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for k in ["path", "file_path", "from", "to", "source", "destination"] {
        if let Some(p) = args.get(k).and_then(|v| v.as_str()) {
            out.push(p.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests;
