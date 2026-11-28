//! GC, crash repair, rewind cleanup and mirrors (plan §7, §8 quotas, D11,
//! stages 1, 5 and 7).
//!
//! * **Rewind / reset** — `forget_after` and `reset` run inside the turn-memory
//!   transaction of `turn_memory::forget_after` / `reset_memory`, so the tree
//!   and the memory never disagree about which turns exist.
//! * **GC** — `maybe_run` at a turn boundary: on the first request of a session
//!   after the app started, then every [`GC_EVERY_TURNS`] turns. It repairs what
//!   a killed app can leave behind, enforces the quotas, trims the action log
//!   and purges old tombstones. Never on the reply path's critical section: it
//!   is a handful of indexed statements.
//! * **Mirrors** — `<workspace>/.context/<session-slug>/{strategy.md,notes/<id>.md}`.
//!   Transparency, not truth: written after a commit, rebuilt from the DB when
//!   missing or hand-edited, never read back (I10, T9). Secrets are masked.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection};

use super::store::{self, GcReport, Quotas};

/// GC every this many turns (plan §8: "GC every 50 turns or on startup").
pub const GC_EVERY_TURNS: u32 = 50;
/// Action-log rows kept per session; policy rows are kept twice as long.
pub const ACTION_LOG_MAX_ROWS: i64 = 20_000;
/// A tombstone is kept this long (so the panel and `unknown_id` answers can
/// still say "deleted"), then purged.
pub const TOMBSTONE_KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
/// Strategy versions always kept (plan §8: "≥ 20 strategy versions").
pub const STRATEGY_VERSIONS_KEPT: i64 = 20;

/// What a GC or a cleanup did, for the `context.tree_gc` event and the log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cleanup {
    pub nodes_removed: usize,
    pub temps_removed: usize,
    pub temps_restored: usize,
    pub log_rows_removed: usize,
    pub tombstones_purged: usize,
    pub nodes_trimmed: usize,
    pub notes_trimmed: usize,
    pub temp_trimmed: usize,
    pub bytes_freed: i64,
}

impl Cleanup {
    pub fn did_anything(&self) -> bool {
        *self != Cleanup::default()
    }

    fn add_quota(&mut self, r: &GcReport) {
        self.nodes_trimmed += r.nodes_trimmed;
        self.notes_trimmed += r.notes_trimmed;
        self.temp_trimmed += r.temp_trimmed;
        self.bytes_freed += r.bytes_freed;
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "nodesRemoved": self.nodes_removed,
            "tempsRemoved": self.temps_removed,
            "tempsRestored": self.temps_restored,
            "logRowsRemoved": self.log_rows_removed,
            "tombstonesPurged": self.tombstones_purged,
            "nodesTrimmed": self.nodes_trimmed,
            "notesTrimmed": self.notes_trimmed,
            "tempTrimmed": self.temp_trimmed,
            "bytesFreed": self.bytes_freed,
        })
    }
}

/// The ctx tables exist in this database (the tree was ever turned on).
fn has_tables(conn: &Connection) -> bool {
    store::schema_version(conn).is_some()
}

/// The last turn of a `sum/A-B` id.
fn summary_end(id: &str) -> Option<u32> {
    id.strip_prefix("sum/")?.split('-').nth(1)?.parse().ok()
}

/// The turn a `turn/N[/...]` id belongs to.
fn turn_of_id(id: &str) -> Option<u32> {
    id.strip_prefix("turn/")?.split('/').next()?.parse().ok()
}

// ---------------------------------------------------------------- rewind / reset

/// The chat was rewound to `keep_turns` complete turns: remove every tree row
/// for the turns that no longer exist (plan §1.4: "delete `ctx_*` rows for
/// the affected range"). Hard deletes, not tombstones: the next turn N+1 is a
/// different turn and must not inherit the model's choices for the old one.
///
/// * turn and turn-part nodes past `keep_turns`, and turn-range summaries that
///   reach past it;
/// * temp summaries made from any of those, and their `tmp/*` nodes; their
///   other sources leave `temp` and go back `in` ("leaving temp puts the
///   original back");
/// * action-log rows of the removed turns.
///
/// Notes, strategy, essentials, files, stored results and sub-agent reports are
/// kept: they are not bound to a turn number. Does nothing when the tree was
/// never on. Runs inside the caller's transaction.
pub fn forget_after(conn: &Connection, session_key: &str, keep_turns: u32, now_ms: i64) -> rusqlite::Result<Cleanup> {
    let mut out = Cleanup::default();
    if !has_tables(conn) {
        return Ok(out);
    }
    let mut gone: BTreeSet<String> = BTreeSet::new();
    {
        let mut stmt = conn.prepare("SELECT id, kind, turn FROM ctx_nodes WHERE session_key = ?1")?;
        let rows = stmt.query_map(params![session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?)))?;
        for row in rows {
            let (id, kind, turn) = row?;
            let past = match kind.as_str() {
                "turn" | "turnPart" => turn.map(|t| t > keep_turns as i64).or_else(|| turn_of_id(&id).map(|t| t > keep_turns)).unwrap_or(false),
                "summary" => summary_end(&id).map(|end| end > keep_turns).unwrap_or(false),
                _ => false,
            };
            if past {
                gone.insert(id);
            }
        }
    }
    for id in &gone {
        out.nodes_removed += conn.execute("DELETE FROM ctx_nodes WHERE session_key = ?1 AND id = ?2", params![session_key, id])?;
    }
    let (removed, restored) = drop_temps_touching(conn, session_key, &gone)?;
    out.temps_removed += removed;
    out.temps_restored += restored;
    out.log_rows_removed += conn.execute(
        "DELETE FROM ctx_action_log WHERE session_key = ?1 AND turn IS NOT NULL AND turn > ?2",
        params![session_key, keep_turns as i64],
    )?;
    if out.did_anything() {
        let _ = store::ensure_session(conn, session_key, now_ms);
        let _ = store::bump_rev(conn, session_key, now_ms);
    }
    Ok(out)
}

/// The memory was reset and turn numbers no longer match: every turn-bound row
/// goes (as a rewind to zero turns). The model's own notes and strategy stay.
pub fn reset(conn: &Connection, session_key: &str, now_ms: i64) -> rusqlite::Result<Cleanup> {
    forget_after(conn, session_key, 0, now_ms)
}

/// The session itself is gone (chat deleted): every ctx row of it.
pub fn purge_session(conn: &Connection, session_key: &str) -> rusqlite::Result<usize> {
    if !has_tables(conn) {
        return Ok(0);
    }
    let mut n = 0;
    for table in ["ctx_nodes", "ctx_categories", "ctx_notes", "ctx_temp_summaries", "ctx_strategy", "ctx_action_log", "ctx_sessions"] {
        n += conn.execute(&format!("DELETE FROM {table} WHERE session_key = ?1"), params![session_key])?;
    }
    Ok(n)
}

/// Temp summaries with a source in `gone` are deleted (with their node); their
/// remaining sources in `temp` go back `in`. Returns (removed, restored).
fn drop_temps_touching(conn: &Connection, session_key: &str, gone: &BTreeSet<String>) -> rusqlite::Result<(usize, usize)> {
    if gone.is_empty() {
        return Ok((0, 0));
    }
    let temps = load_temp_sources(conn, session_key)?;
    let mut removed = 0;
    let mut restored = 0;
    for (temp_id, sources) in temps {
        if !sources.iter().any(|s| gone.contains(s)) {
            continue;
        }
        removed += conn.execute("DELETE FROM ctx_temp_summaries WHERE session_key = ?1 AND id = ?2", params![session_key, temp_id])?;
        conn.execute("DELETE FROM ctx_nodes WHERE session_key = ?1 AND id = ?2", params![session_key, temp_id])?;
        for s in sources.iter().filter(|s| !gone.contains(*s)) {
            restored += conn.execute(
                "UPDATE ctx_nodes SET state = 'in', node_rev = node_rev + 1 WHERE session_key = ?1 AND id = ?2 AND state = 'temp'",
                params![session_key, s],
            )?;
        }
    }
    Ok((removed, restored))
}

fn load_temp_sources(conn: &Connection, session_key: &str) -> rusqlite::Result<Vec<(String, Vec<String>)>> {
    let mut stmt = conn.prepare("SELECT id, sources FROM ctx_temp_summaries WHERE session_key = ?1 ORDER BY created_at, id")?;
    let rows = stmt.query_map(params![session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, raw) = row?;
        out.push((id, serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()));
    }
    Ok(out)
}

// ---------------------------------------------------------------- crash repair

/// Repair what a killed app can leave half-done (D11):
/// * a temp summary none of whose sources is still `temp` is dropped (the
///   engine drops it once it has no sources left in `temp`);
/// * a node in `temp` that no temp summary covers goes back `in` (orphan
///   `temp_of`), so nothing silently disappears from the request;
/// * a `tmp/*` node without its summary row is removed;
/// * nodes whose category no longer exists move to their kind's default home
///   (`turns`, `results`, `notes`, ...), so the checklist still lists them.
pub fn repair(conn: &Connection, session_key: &str) -> rusqlite::Result<Cleanup> {
    let mut out = Cleanup::default();
    let temps = load_temp_sources(conn, session_key)?;
    let mut states: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, state FROM ctx_nodes WHERE session_key = ?1 AND deleted = 0")?;
        let rows = stmt.query_map(params![session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, state) = row?;
            states.insert(id, state);
        }
    }
    let mut covered: HashSet<String> = HashSet::new();
    let mut temp_ids: HashSet<String> = HashSet::new();
    for (temp_id, sources) in &temps {
        let live: Vec<&String> = sources.iter().filter(|s| states.get(*s).map(|st| st == "temp").unwrap_or(false)).collect();
        if live.is_empty() {
            out.temps_removed += conn.execute("DELETE FROM ctx_temp_summaries WHERE session_key = ?1 AND id = ?2", params![session_key, temp_id])?;
            conn.execute("DELETE FROM ctx_nodes WHERE session_key = ?1 AND id = ?2", params![session_key, temp_id])?;
        } else {
            temp_ids.insert(temp_id.clone());
            covered.extend(live.into_iter().cloned());
        }
    }
    for (id, state) in &states {
        if state == "temp" && !covered.contains(id) {
            out.temps_restored += conn.execute(
                "UPDATE ctx_nodes SET state = 'in', node_rev = node_rev + 1 WHERE session_key = ?1 AND id = ?2",
                params![session_key, id],
            )?;
        }
    }
    out.nodes_removed += conn.execute(
        "DELETE FROM ctx_nodes WHERE session_key = ?1 AND kind = 'tempSummary'
           AND id NOT IN (SELECT id FROM ctx_temp_summaries WHERE session_key = ?1)",
        params![session_key],
    )?;
    let _ = temp_ids;
    // Nodes left in a category that is gone go to their kind's home, when that
    // home exists in this session.
    let cats: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT id FROM ctx_categories WHERE session_key = ?1 AND deleted = 0")?;
        let rows = stmt.query_map(params![session_key], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let homeless: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, kind, parent FROM ctx_nodes WHERE session_key = ?1 AND deleted = 0")?;
        let rows = stmt.query_map(params![session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        rows.filter_map(|r| r.ok())
            .filter(|(_, _, parent)| !cats.contains(parent))
            .filter_map(|(id, kind, _)| {
                let home = super::model::NodeKind::of_str(&kind).map(|k| k.home_category())?;
                cats.contains(home).then(|| (id, home.to_string()))
            })
            .collect()
    };
    for (id, home) in homeless {
        conn.execute(
            "UPDATE ctx_nodes SET parent = ?3, node_rev = node_rev + 1 WHERE session_key = ?1 AND id = ?2",
            params![session_key, id, home],
        )?;
    }
    Ok(out)
}

// ---------------------------------------------------------------- gc

/// One full GC pass: repair, quotas, action-log trim, strategy history trim,
/// tombstone purge.
pub fn run(conn: &Connection, session_key: &str, now_ms: i64) -> rusqlite::Result<Cleanup> {
    let mut out = repair(conn, session_key)?;
    let quota = store::enforce_quotas(conn, session_key, Quotas::default())?;
    out.add_quota(&quota);
    out.log_rows_removed += trim_action_log(conn, session_key, ACTION_LOG_MAX_ROWS)?;
    conn.execute(
        "DELETE FROM ctx_strategy WHERE session_key = ?1 AND version NOT IN
           (SELECT version FROM ctx_strategy WHERE session_key = ?1 ORDER BY version DESC LIMIT ?2)",
        params![session_key, STRATEGY_VERSIONS_KEPT],
    )?;
    out.tombstones_purged += conn.execute(
        "DELETE FROM ctx_nodes WHERE session_key = ?1 AND deleted = 1
           AND COALESCE(last_used_at, created_at) < ?2",
        params![session_key, now_ms.saturating_sub(TOMBSTONE_KEEP_MS)],
    )?;
    if out.did_anything() {
        let _ = store::bump_rev(conn, session_key, now_ms);
        let entry = store::LogEntry {
            actor: "engine".into(),
            tool: None,
            ops: out.to_json().to_string(),
            reason: Some("gc".into()),
            ..Default::default()
        };
        let _ = store::log_action(conn, session_key, &entry, now_ms);
    }
    Ok(out)
}

/// Keep the newest `max_rows` rows; policy rows are kept twice as long (plan §8).
pub fn trim_action_log(conn: &Connection, session_key: &str, max_rows: i64) -> rusqlite::Result<usize> {
    let mut n = conn.execute(
        "DELETE FROM ctx_action_log WHERE session_key = ?1 AND actor != 'policy' AND seq NOT IN
           (SELECT seq FROM ctx_action_log WHERE session_key = ?1 AND actor != 'policy' ORDER BY seq DESC LIMIT ?2)",
        params![session_key, max_rows],
    )?;
    n += conn.execute(
        "DELETE FROM ctx_action_log WHERE session_key = ?1 AND actor = 'policy' AND seq NOT IN
           (SELECT seq FROM ctx_action_log WHERE session_key = ?1 AND actor = 'policy' ORDER BY seq DESC LIMIT ?2)",
        params![session_key, max_rows.saturating_mul(2)],
    )?;
    Ok(n)
}

fn last_gc_turns() -> &'static Mutex<HashMap<String, u32>> {
    static LAST: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

/// GC is due: the first time this process sees the session ("on startup"),
/// then every [`GC_EVERY_TURNS`] turns, or when the turn count went backwards
/// (a rewind this process did not see).
pub fn due(session_key: &str, now_turn: u32) -> bool {
    let last = last_gc_turns().lock().map(|m| m.get(session_key).copied()).unwrap_or(None);
    match last {
        None => true,
        Some(t) => now_turn < t || now_turn >= t.saturating_add(GC_EVERY_TURNS),
    }
}

/// Run the GC when it is due. Returns what it did, or None when it was not due.
pub fn maybe_run(conn: &Connection, session_key: &str, now_turn: u32, now_ms: i64) -> Option<Cleanup> {
    if !due(session_key, now_turn) {
        return None;
    }
    if let Ok(mut m) = last_gc_turns().lock() {
        m.insert(session_key.to_string(), now_turn);
    }
    run(conn, session_key, now_ms).ok()
}

// ---------------------------------------------------------------- mirrors

/// `<workspace>/.context/<slug>` for one session.
pub fn mirror_dir(workspace: &str, session_key: &str) -> Option<PathBuf> {
    let ws = workspace.trim();
    if ws.is_empty() {
        return None;
    }
    Some(Path::new(ws).join(".context").join(slug(session_key)))
}

fn slug(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').chars().take(64).collect::<String>();
    if s.is_empty() { "session".into() } else { s }
}

/// Mask what looks like a secret before it is written where the user's other
/// tools can read it (T8).
pub fn redact(text: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r"(?x)
            \b(?:sk|pk|rk)-[A-Za-z0-9_\-]{16,}
          | \bgithub_pat_[A-Za-z0-9_]{20,}
          | \bgh[pousr]_[A-Za-z0-9]{20,}
          | \bxox[abprs]-[A-Za-z0-9\-]{10,}
          | \bAKIA[0-9A-Z]{16}\b
          | \bAIza[0-9A-Za-z_\-]{30,}
          | \beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}
          | -----BEGIN\ [A-Z\ ]*PRIVATE\ KEY-----[\s\S]*?-----END\ [A-Z\ ]*PRIVATE\ KEY-----
            ",
        )
        .expect("secret pattern compiles")
    });
    re.replace_all(text, "[redacted]").into_owned()
}

/// Write `text` to `path` only when it differs, through a temp file and a
/// rename, so a killed app never leaves half a mirror.
fn write_if_changed(path: &Path, text: &str) -> std::io::Result<bool> {
    if std::fs::read_to_string(path).map(|old| old == text).unwrap_or(false) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(true)
}

fn note_file_name(id: &str) -> String {
    let base: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let base = base.trim_matches(|c| c == '.' || c == '_').chars().take(96).collect::<String>();
    format!("{}.md", if base.is_empty() { "note".to_string() } else { base })
}

/// Bring the mirrors in line with the DB: strategy.md and one file per note;
/// files of notes that no longer exist are removed. A mirror a user edited by
/// hand is overwritten: the DB is the source of truth. Returns how many files
/// were written or removed. Errors are swallowed by the callers: a mirror is
/// never worth failing a turn for.
pub fn sync_mirrors(conn: &Connection, session_key: &str, workspace: &str) -> std::io::Result<usize> {
    let Some(dir) = mirror_dir(workspace, session_key) else { return Ok(0) };
    let mut changed = 0;
    let strategy = store::latest_strategy(conn, session_key).ok().flatten();
    let strat_path = dir.join("strategy.md");
    match strategy {
        Some((version, text, next)) => {
            let mut body = format!("# Strategy (version {version})\n\n<!-- Mirror of the context tree. Edits here are overwritten; the database is the source of truth. -->\n\n{}\n", redact(text.trim()));
            if let Some(next) = next.filter(|n| !n.trim().is_empty()) {
                body.push_str(&format!("\nNext step: {}\n", redact(next.trim())));
            }
            if write_if_changed(&strat_path, &body)? {
                changed += 1;
            }
        }
        None => {
            if strat_path.exists() {
                std::fs::remove_file(&strat_path)?;
                changed += 1;
            }
        }
    }
    let notes: Vec<(String, String, String)> = {
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT id, title, text FROM ctx_notes WHERE session_key = ?1 ORDER BY id") {
            if let Ok(rows) = stmt.query_map(params![session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))) {
                out.extend(rows.filter_map(|r| r.ok()));
            }
        }
        out
    };
    let notes_dir = dir.join("notes");
    let mut wanted: HashSet<String> = HashSet::new();
    for (id, title, text) in &notes {
        let name = note_file_name(id);
        let body = format!("# {}\n\n<!-- {id} · mirror of the context tree; edits here are overwritten. -->\n\n{}\n", redact(title.trim()), redact(text.trim()));
        if write_if_changed(&notes_dir.join(&name), &body)? {
            changed += 1;
        }
        wanted.insert(name);
    }
    if let Ok(entries) = std::fs::read_dir(&notes_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") && !wanted.contains(&name) {
                let _ = std::fs::remove_file(e.path());
                changed += 1;
            }
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::model::{ItemState, Node, NodeId, NodeKind, Owner, Pin, Provenance};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        store::ensure_tables(&conn).expect("tables");
        store::ensure_session(&conn, "s", 1).expect("session");
        conn
    }

    fn node(id: &str, kind: NodeKind, turn: Option<u32>, state: ItemState) -> Node {
        Node {
            id: NodeId::parse(id).expect("id"),
            session_key: "s".into(),
            kind,
            parent: "turns".into(),
            tags: Vec::new(),
            order: 0,
            title: id.into(),
            state,
            pin: Pin::None,
            owner: Owner::Policy,
            tokens_full: 10,
            tokens_note: 0,
            token_model: String::new(),
            note: None,
            provenance: Provenance::default(),
            created_at: 1,
            last_used_at: None,
            loaded_at: None,
            turn,
            rev: 1,
            deleted: false,
        }
    }

    fn ids(conn: &Connection) -> Vec<String> {
        store::load_nodes(conn, "s").unwrap().into_iter().map(|n| n.id.as_str().to_string()).collect()
    }

    #[test]
    fn a_rewind_removes_the_turns_past_the_cut_and_what_was_made_of_them() {
        let c = db();
        for t in 1..=4u32 {
            store::upsert_node(&c, &node(&format!("turn/{t}"), NodeKind::Turn, Some(t), ItemState::Temp)).unwrap();
        }
        store::upsert_node(&c, &node("sum/1-2", NodeKind::Summary, None, ItemState::In)).unwrap();
        store::upsert_node(&c, &node("sum/2-4", NodeKind::Summary, None, ItemState::In)).unwrap();
        store::put_note(&c, "s", "note/keep", "keep", "text", "notes", ItemState::In, 1).unwrap();
        // tmp/a covers turns 1 and 3; tmp/b covers turns 1 and 2 only.
        store::put_temp_summary(&c, "s", "tmp/a", "a", None, &["turn/1".into(), "turn/3".into()], "model", 1, 1).unwrap();
        store::put_temp_summary(&c, "s", "tmp/b", "b", None, &["turn/1".into(), "turn/2".into()], "model", 1, 1).unwrap();
        let done = forget_after(&c, "s", 2, 5).unwrap();
        let left = ids(&c);
        assert!(left.contains(&"turn/1".to_string()) && left.contains(&"turn/2".to_string()));
        assert!(!left.contains(&"turn/3".to_string()) && !left.contains(&"turn/4".to_string()));
        assert!(left.contains(&"sum/1-2".to_string()) && !left.contains(&"sum/2-4".to_string()));
        assert_eq!(done.temps_removed, 1, "only the temp made from a removed turn");
        assert!(store::load_temp_summary(&c, "s", "tmp/b").unwrap().is_some());
        assert!(store::load_note(&c, "s", "note/keep").unwrap().is_some(), "notes are not bound to a turn");
    }

    #[test]
    fn a_rewind_on_a_database_without_the_tree_does_nothing() {
        let c = Connection::open_in_memory().unwrap();
        assert_eq!(forget_after(&c, "s", 0, 5).unwrap(), Cleanup::default());
        assert_eq!(purge_session(&c, "s").unwrap(), 0);
    }

    #[test]
    fn repair_puts_orphan_temp_nodes_back_and_drops_empty_temps() {
        let c = db();
        store::upsert_node(&c, &node("turn/1", NodeKind::Turn, Some(1), ItemState::Temp)).unwrap();
        store::upsert_node(&c, &node("turn/2", NodeKind::Turn, Some(2), ItemState::In)).unwrap();
        store::put_temp_summary(&c, "s", "tmp/z", "z", None, &["turn/2".into()], "model", 1, 1).unwrap();
        let r = repair(&c, "s").unwrap();
        assert_eq!(r.temps_restored, 1);
        assert_eq!(r.temps_removed, 1);
        let n1 = store::load_node(&c, "s", "turn/1").unwrap().unwrap();
        assert_eq!(n1.state, ItemState::In);
    }

    #[test]
    fn the_action_log_keeps_policy_rows_twice_as_long() {
        let c = db();
        for actor in ["model", "model", "model", "policy", "policy", "policy"] {
            store::log_action(&c, "s", &store::LogEntry { actor: actor.into(), ops: "[]".into(), ..Default::default() }, 1).unwrap();
        }
        assert_eq!(trim_action_log(&c, "s", 1).unwrap(), 2 + 1);
    }

    #[test]
    fn gc_is_due_on_first_sight_then_every_fifty_turns() {
        let key = "gc-due-test";
        assert!(due(key, 3));
        let c = db();
        assert!(maybe_run(&c, key, 3, 10).is_some());
        assert!(!due(key, 4));
        assert!(due(key, 3 + GC_EVERY_TURNS));
        assert!(due(key, 1), "the chat got shorter");
    }

    #[test]
    fn mirrors_follow_the_db_and_mask_secrets() {
        let c = db();
        let ws = std::env::temp_dir().join(format!("ctx-mirror-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        store::put_note(&c, "s", "note/key", "Key", "token sk-abcdefghijklmnopqrstuvwx here", "notes", ItemState::In, 1).unwrap();
        let n = sync_mirrors(&c, "s", ws.to_str().unwrap()).unwrap();
        assert_eq!(n, 1);
        let file = mirror_dir(ws.to_str().unwrap(), "s").unwrap().join("notes").join("note_key.md");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("[redacted]") && !text.contains("sk-abc"));
        // Tampered by hand: rebuilt from the DB.
        std::fs::write(&file, "tampered").unwrap();
        assert_eq!(sync_mirrors(&c, "s", ws.to_str().unwrap()).unwrap(), 1);
        assert!(std::fs::read_to_string(&file).unwrap().contains("[redacted]"));
        // Note deleted: its mirror goes too.
        c.execute("DELETE FROM ctx_notes WHERE session_key = 's'", []).unwrap();
        assert_eq!(sync_mirrors(&c, "s", ws.to_str().unwrap()).unwrap(), 1);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn slugs_and_file_names_stay_inside_the_mirror_folder() {
        assert_eq!(slug("../../etc"), "etc");
        assert_eq!(note_file_name("note/../x"), "note_.._x.md");
        assert!(!note_file_name("../../x").contains('/'));
    }
}
