//! Tool execution scheduler: per-resource locks shared by every agent loop
//! (the main chat, sub-agents, cron wakes, cross-session turns).
//!
//! - Read-only tools take *shared* locks; mutating tools take *exclusive*
//!   locks on what they touch: one file path, the git repository, the whole
//!   workspace for `execute_command`, or a device singleton (mic, camera,
//!   torch, alarm, ...).
//! - A request takes all of its locks at once or none of them (no
//!   hold-and-wait), so two agents can never deadlock on each other.
//! - Requests are served in arrival order (tickets): a later request never
//!   overtakes an earlier one that conflicts with it, so writers don't starve.
//! - Waiting has a timeout and stops at once when the run is cancelled.
//!
//! Within one turn, several read-only calls that need no approval run in
//! parallel (see `agent_loop`), bounded by `max_parallel_tools`.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LockMode {
    Shared,
    Exclusive,
}

/// What one tool call needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolNeeds {
    pub read_only: bool,
    /// resource key → mode (BTreeMap: sorted, no duplicates).
    pub resources: BTreeMap<String, LockMode>,
}

const READ_ONLY_BUILTINS: &[&str] = &[
    "read_file", "list_files", "find_files", "grep_files", "git_status", "git_log", "git_diff",
    "web_fetch", "memory_recall", "memory_search", "memory_list", "search_documents", "list_documents",
];

/// Device singletons: (resource, keywords found in the tool name).
const DEVICE_SINGLETONS: &[(&str, &[&str])] = &[
    ("device:mic", &["mic", "microphone", "record_audio", "speech", "listen", "transcribe"]),
    ("device:camera", &["camera", "photo", "scan", "qr", "barcode", "video"]),
    ("device:torch", &["torch", "flashlight", "flash"]),
    ("device:alarm", &["alarm", "timer"]),
    ("device:speaker", &["speak", "tts", "play_sound", "vibrate"]),
    ("device:location", &["location", "gps"]),
    ("device:clipboard", &["clipboard"]),
];

fn norm_path(raw: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for p in raw.trim().trim_start_matches("./").split(['/', '\\']) {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn path_arg(input: &Value) -> Option<String> {
    for k in ["path", "file_path", "file", "filename"] {
        if let Some(s) = input.get(k).and_then(Value::as_str) {
            return Some(norm_path(s));
        }
    }
    None
}

/// Classify a tool call. Unknown (MCP / app) tools need no lock unless they
/// drive a device singleton.
pub fn classify(name: &str, input: &Value) -> ToolNeeds {
    let mut r = BTreeMap::new();
    let mut read_only = false;
    match name {
        "read_file" | "list_files" | "find_files" | "grep_files" => {
            read_only = true;
            r.insert("workspace".into(), LockMode::Shared);
            if let Some(p) = path_arg(input).filter(|p| !p.is_empty()) {
                if name == "read_file" {
                    r.insert(format!("file:{}", p), LockMode::Shared);
                }
            }
        }
        "write_file" | "edit_file" | "delete_file" => {
            r.insert("workspace".into(), LockMode::Shared);
            let p = path_arg(input).unwrap_or_default();
            r.insert(format!("file:{}", p), LockMode::Exclusive);
        }
        "execute_command" => {
            r.insert("workspace".into(), LockMode::Exclusive);
        }
        "git_status" | "git_log" | "git_diff" => {
            read_only = true;
            r.insert("workspace".into(), LockMode::Shared);
            r.insert("git".into(), LockMode::Shared);
        }
        "git_init" | "git_add" | "git_commit" => {
            r.insert("workspace".into(), LockMode::Shared);
            r.insert("git".into(), LockMode::Exclusive);
        }
        "memory_recall" | "memory_search" | "memory_list" => {
            read_only = true;
            r.insert("memory".into(), LockMode::Shared);
        }
        "memory_store" | "memory_forget" => {
            r.insert("memory".into(), LockMode::Exclusive);
        }
        "manage_cron" => {
            r.insert("cron".into(), LockMode::Exclusive);
        }
        "index_document" => {
            r.insert("documents".into(), LockMode::Exclusive);
        }
        "search_documents" | "list_documents" => {
            read_only = true;
            r.insert("documents".into(), LockMode::Shared);
        }
        "web_fetch" => read_only = true,
        _ => {
            let lower = name.to_ascii_lowercase();
            if lower.starts_with("device__") || lower.starts_with("device_") {
                for (res, words) in DEVICE_SINGLETONS {
                    if words.iter().any(|w| lower.contains(w)) {
                        r.insert((*res).to_string(), LockMode::Exclusive);
                    }
                }
            }
        }
    }
    debug_assert!(!read_only || READ_ONLY_BUILTINS.contains(&name));
    ToolNeeds { read_only, resources: r }
}

pub fn is_read_only(name: &str) -> bool {
    READ_ONLY_BUILTINS.contains(&name)
}

// ── Settings (set from the sub-agent settings) ─────────────────────────────

static PARALLEL_READS: AtomicBool = AtomicBool::new(true);
static MAX_PARALLEL_TOOLS: AtomicU32 = AtomicU32::new(4);
static LOCK_TIMEOUT_MS: AtomicU64 = AtomicU64::new(120_000);

pub fn configure(parallel_reads: bool, max_parallel_tools: u32, lock_timeout_seconds: u64) {
    PARALLEL_READS.store(parallel_reads, Ordering::Relaxed);
    MAX_PARALLEL_TOOLS.store(max_parallel_tools.clamp(1, 16), Ordering::Relaxed);
    LOCK_TIMEOUT_MS.store(lock_timeout_seconds.clamp(1, 3_600) * 1000, Ordering::Relaxed);
}
pub fn parallel_reads() -> bool {
    PARALLEL_READS.load(Ordering::Relaxed)
}
pub fn max_parallel_tools() -> usize {
    MAX_PARALLEL_TOOLS.load(Ordering::Relaxed) as usize
}
pub fn lock_timeout() -> Duration {
    Duration::from_millis(LOCK_TIMEOUT_MS.load(Ordering::Relaxed))
}

// ── Lock table ─────────────────────────────────────────────────────────────

#[derive(Default)]
struct Held {
    readers: usize,
    writer: Option<String>,
    reader_owners: Vec<String>,
}

struct Waiter {
    ticket: u64,
    owner: String,
    resources: BTreeMap<String, LockMode>,
}

#[derive(Default)]
struct Table {
    held: HashMap<String, Held>,
    waiting: Vec<Waiter>,
    next_ticket: u64,
}

fn conflicts(a: LockMode, b: LockMode) -> bool {
    a == LockMode::Exclusive || b == LockMode::Exclusive
}

impl Table {
    fn compatible_with_held(&self, res: &BTreeMap<String, LockMode>) -> bool {
        res.iter().all(|(k, m)| match self.held.get(k) {
            None => true,
            Some(h) => match m {
                LockMode::Shared => h.writer.is_none(),
                LockMode::Exclusive => h.writer.is_none() && h.readers == 0,
            },
        })
    }
    fn blocked_by_earlier(&self, ticket: u64, res: &BTreeMap<String, LockMode>) -> bool {
        self.waiting.iter().filter(|w| w.ticket < ticket).any(|w| {
            w.resources.iter().any(|(k, m)| res.get(k).map(|m2| conflicts(*m, *m2)).unwrap_or(false))
        })
    }
    fn holders(&self, res: &BTreeMap<String, LockMode>) -> Vec<String> {
        let mut out = Vec::new();
        for k in res.keys() {
            if let Some(h) = self.held.get(k) {
                if let Some(w) = &h.writer {
                    out.push(w.clone());
                }
                out.extend(h.reader_owners.iter().cloned());
            }
        }
        out.sort();
        out.dedup();
        out
    }
    fn take(&mut self, owner: &str, res: &BTreeMap<String, LockMode>) {
        for (k, m) in res {
            let h = self.held.entry(k.clone()).or_default();
            match m {
                LockMode::Shared => {
                    h.readers += 1;
                    h.reader_owners.push(owner.to_string());
                }
                LockMode::Exclusive => h.writer = Some(owner.to_string()),
            }
        }
    }
    fn release(&mut self, owner: &str, res: &BTreeMap<String, LockMode>) {
        for (k, m) in res {
            let mut empty = false;
            if let Some(h) = self.held.get_mut(k) {
                match m {
                    LockMode::Shared => {
                        h.readers = h.readers.saturating_sub(1);
                        if let Some(i) = h.reader_owners.iter().position(|o| o == owner) {
                            h.reader_owners.remove(i);
                        }
                    }
                    LockMode::Exclusive => h.writer = None,
                }
                empty = h.readers == 0 && h.writer.is_none();
            }
            if empty {
                self.held.remove(k);
            }
        }
    }
}

pub struct Scheduler {
    table: StdMutex<Table>,
    notify: Notify,
}

pub fn global() -> &'static Arc<Scheduler> {
    static G: OnceLock<Arc<Scheduler>> = OnceLock::new();
    G.get_or_init(|| Arc::new(Scheduler::new()))
}

/// Held locks; released on drop (also when the run is cancelled mid-tool).
pub struct LockGuard {
    sched: Arc<Scheduler>,
    owner: String,
    resources: BTreeMap<String, LockMode>,
    pub waited_ms: u64,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if self.resources.is_empty() {
            return;
        }
        self.sched.table.lock().unwrap().release(&self.owner, &self.resources);
        self.sched.notify.notify_waiters();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AcquireError {
    Cancelled,
    TimedOut { resources: Vec<String>, holders: Vec<String>, waited_ms: u64 },
}

impl AcquireError {
    pub fn message(&self, tool: &str) -> String {
        match self {
            AcquireError::Cancelled => format!("Tool '{}' was cancelled while it waited for its turn.", tool),
            AcquireError::TimedOut { resources, holders, waited_ms } => format!(
                "Tool '{}' was not executed: it waited {}s for {} which another run ({}) is still using. Try again later or pick a different file.",
                tool,
                waited_ms / 1000,
                resources.join(", "),
                if holders.is_empty() { "unknown".to_string() } else { holders.join(", ") }
            ),
        }
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self { table: StdMutex::new(Table::default()), notify: Notify::new() }
    }

    /// Snapshot for the app (held locks and the wait queue).
    pub fn snapshot(&self) -> Value {
        let t = self.table.lock().unwrap();
        let mut held: Vec<Value> = t
            .held
            .iter()
            .map(|(k, h)| json!({ "resource": k, "writer": h.writer, "readers": h.readers }))
            .collect();
        held.sort_by(|a, b| a["resource"].as_str().cmp(&b["resource"].as_str()));
        let waiting: Vec<Value> = t
            .waiting
            .iter()
            .enumerate()
            .map(|(i, w)| json!({ "position": i + 1, "owner": w.owner, "resources": w.resources.keys().collect::<Vec<_>>() }))
            .collect();
        json!({ "held": held, "waiting": waiting })
    }

    /// Try once without queueing (used for tests and quick paths).
    pub fn try_acquire(self: &Arc<Self>, owner: &str, resources: &BTreeMap<String, LockMode>) -> Option<LockGuard> {
        let mut t = self.table.lock().unwrap();
        if t.compatible_with_held(resources) && !t.blocked_by_earlier(u64::MAX, resources) {
            t.take(owner, resources);
            return Some(LockGuard { sched: self.clone(), owner: owner.into(), resources: resources.clone(), waited_ms: 0 });
        }
        None
    }

    /// Take all `resources` at once, in FIFO order with conflicting requests.
    /// `on_wait` is called once, with the current holders, if it must wait.
    pub async fn acquire(
        self: &Arc<Self>,
        owner: &str,
        resources: &BTreeMap<String, LockMode>,
        abort: Option<&Arc<Mutex<bool>>>,
        timeout: Duration,
        mut on_wait: impl FnMut(Vec<String>, usize),
    ) -> Result<LockGuard, AcquireError> {
        if resources.is_empty() {
            return Ok(LockGuard { sched: self.clone(), owner: owner.into(), resources: BTreeMap::new(), waited_ms: 0 });
        }
        let started = Instant::now();
        let ticket = {
            let mut t = self.table.lock().unwrap();
            let ticket = t.next_ticket;
            t.next_ticket += 1;
            if t.compatible_with_held(resources) && !t.blocked_by_earlier(ticket, resources) {
                t.take(owner, resources);
                return Ok(LockGuard { sched: self.clone(), owner: owner.into(), resources: resources.clone(), waited_ms: 0 });
            }
            let holders = t.holders(resources);
            t.waiting.push(Waiter { ticket, owner: owner.into(), resources: resources.clone() });
            let pos = t.waiting.len();
            drop(t);
            on_wait(holders, pos);
            ticket
        };
        let remove_waiter = |s: &Scheduler| {
            let mut t = s.table.lock().unwrap();
            t.waiting.retain(|w| w.ticket != ticket);
            drop(t);
            s.notify.notify_waiters();
        };
        loop {
            let notified = self.notify.notified();
            {
                let mut t = self.table.lock().unwrap();
                if t.compatible_with_held(resources) && !t.blocked_by_earlier(ticket, resources) {
                    t.waiting.retain(|w| w.ticket != ticket);
                    t.take(owner, resources);
                    drop(t);
                    return Ok(LockGuard {
                        sched: self.clone(),
                        owner: owner.into(),
                        resources: resources.clone(),
                        waited_ms: started.elapsed().as_millis() as u64,
                    });
                }
            }
            if let Some(a) = abort {
                if a.try_lock().map(|g| *g).unwrap_or(false) {
                    remove_waiter(self);
                    return Err(AcquireError::Cancelled);
                }
            }
            if started.elapsed() >= timeout {
                let holders = self.table.lock().unwrap().holders(resources);
                remove_waiter(self);
                return Err(AcquireError::TimedOut {
                    resources: resources.keys().cloned().collect(),
                    holders,
                    waited_ms: started.elapsed().as_millis() as u64,
                });
            }
            let _ = tokio::time::timeout(Duration::from_millis(50), notified).await;
        }
    }
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res(items: &[(&str, LockMode)]) -> BTreeMap<String, LockMode> {
        items.iter().map(|(k, m)| (k.to_string(), *m)).collect()
    }

    #[test]
    fn classify_tools() {
        let r = classify("read_file", &json!({"path": "./a/../b.txt"}));
        assert!(r.read_only);
        assert_eq!(r.resources.get("file:b.txt"), Some(&LockMode::Shared));
        let w = classify("edit_file", &json!({"path": "b.txt"}));
        assert!(!w.read_only);
        assert_eq!(w.resources.get("file:b.txt"), Some(&LockMode::Exclusive));
        assert_eq!(w.resources.get("workspace"), Some(&LockMode::Shared));
        let c = classify("execute_command", &json!({"command": "ls"}));
        assert_eq!(c.resources.get("workspace"), Some(&LockMode::Exclusive));
        assert_eq!(classify("git_commit", &json!({})).resources.get("git"), Some(&LockMode::Exclusive));
        assert_eq!(classify("device__torch_on", &json!({})).resources.get("device:torch"), Some(&LockMode::Exclusive));
        assert_eq!(classify("device__record_audio", &json!({})).resources.get("device:mic"), Some(&LockMode::Exclusive));
        assert!(classify("some_mcp_tool", &json!({})).resources.is_empty());
        assert!(classify("web_fetch", &json!({})).read_only);
    }

    #[tokio::test]
    async fn readers_share_writers_exclude_and_fifo_holds() {
        let s = Arc::new(Scheduler::new());
        let r1 = s.try_acquire("a", &res(&[("file:x", LockMode::Shared)])).unwrap();
        let _r2 = s.try_acquire("b", &res(&[("file:x", LockMode::Shared)])).unwrap();
        assert!(s.try_acquire("c", &res(&[("file:x", LockMode::Exclusive)])).is_none());
        // A writer queues; a later reader must not overtake it (no starvation).
        let s2 = s.clone();
        let writer = tokio::spawn(async move {
            s2.acquire("w", &res(&[("file:x", LockMode::Exclusive)]), None, Duration::from_secs(5), |_, _| {}).await.map(|g| g.waited_ms)
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(s.snapshot()["waiting"].as_array().unwrap().len(), 1);
        assert!(s.try_acquire("late-reader", &res(&[("file:x", LockMode::Shared)])).is_none());
        drop(r1);
        drop(_r2);
        let waited = writer.await.unwrap().unwrap();
        assert!(waited >= 20);
        // Unrelated resources never wait.
        assert!(s.try_acquire("z", &res(&[("file:other", LockMode::Exclusive)])).is_some());
    }

    #[tokio::test]
    async fn all_or_nothing_avoids_deadlock() {
        let s = Arc::new(Scheduler::new());
        let g1 = s.try_acquire("a", &res(&[("file:1", LockMode::Exclusive)])).unwrap();
        // B wants 2 and 1: it must not hold 2 while waiting for 1.
        let s2 = s.clone();
        let b = tokio::spawn(async move {
            s2.acquire("b", &res(&[("file:1", LockMode::Exclusive), ("file:2", LockMode::Exclusive)]), None, Duration::from_secs(5), |_, _| {})
                .await
                .is_ok()
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        // file:2 is still free, but B queued first and conflicts on it → A's
        // request for 2 waits behind B; B waits for 1 held by A. Releasing
        // g1 lets B through; then A gets 2. No cycle.
        drop(g1);
        assert!(b.await.unwrap());
        let g = s.acquire("a", &res(&[("file:2", LockMode::Exclusive)]), None, Duration::from_secs(2), |_, _| {}).await;
        assert!(g.is_ok());
    }

    #[tokio::test]
    async fn timeout_and_cancel_leave_the_queue_clean() {
        let s = Arc::new(Scheduler::new());
        let _g = s.try_acquire("holder", &res(&[("workspace", LockMode::Exclusive)])).unwrap();
        let mut waited_for = Vec::new();
        let e = s
            .acquire("t", &res(&[("workspace", LockMode::Shared)]), None, Duration::from_millis(120), |h, _| waited_for = h)
            .await
            .err()
            .unwrap();
        assert_eq!(waited_for, vec!["holder".to_string()]);
        assert!(matches!(e, AcquireError::TimedOut { .. }));
        assert!(e.message("read_file").contains("holder"));
        let abort = Arc::new(Mutex::new(false));
        let a2 = abort.clone();
        let s2 = s.clone();
        let h = tokio::spawn(async move {
            s2.acquire("c", &res(&[("workspace", LockMode::Shared)]), Some(&a2), Duration::from_secs(10), |_, _| {}).await.err()
        });
        tokio::time::sleep(Duration::from_millis(40)).await;
        *abort.lock().await = true;
        assert_eq!(h.await.unwrap(), Some(AcquireError::Cancelled));
        assert!(s.snapshot()["waiting"].as_array().unwrap().is_empty());
    }
}
