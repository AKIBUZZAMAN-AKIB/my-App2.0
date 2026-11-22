//! The chat memory as part of the checklist tree (always on).
//!
//! Before this module the memory had its own world: a relevance selector
//! that picked records on every request (the same records again and again),
//! a separate `memory_inspect` tool to look at them, and a checklist that
//! only knew turns and tool calls. Here every memory record is a row of the
//! checklist tree, filed under its own group, with:
//!
//! * **groups** — goals, closed goals, goal history, topics & titles,
//!   decisions in force, replaced / closed decisions, facts, preferences,
//!   replaced facts/prefs/files, files, open tasks, closed tasks, ranges,
//!   old ranges and memory versions ([`GROUPS`]);
//! * **versions** — every change of a record's wording is kept as a new
//!   version (`ctx_mem_versions`); no version is ever overwritten, so any
//!   earlier one can be read or sent again (`#D12@v1`);
//! * **#tags** — every record has a tag (`#D12`, `#F4`, `#S3-7`, a file by
//!   its name `#plan.md`). A tag named in the conversation sends its record;
//!   when the same tag is named many times only the **last** mention counts
//!   (its version), so the same context is never sent twice. A tag can be
//!   made inactive (kept, but it no longer pulls its record in) or removed
//!   (forgotten; only a new mention brings it back);
//! * **picks** — the person in the panel, or the model through `ctx set`
//!   with `mem/<ID>`, checks a record in (always sent), out (never sent) or
//!   back to auto, and may ask for all versions of it;
//! * **reasons** — after every request each row says why it was sent or not:
//!   sent, left out for length (`cut`), taken out (`excluded`), inactive tag,
//!   or `not_shown` (stored, behind "show more"). The panel colours rows by
//!   this ([`colour`]).
//!
//! Files are their own group: a file read again with the same content is
//! reused (one node, the earlier identical tool results are dropped from the
//! request: [`duplicate_calls`]); a changed file becomes a new version.
//!
//! Everything is plain SQLite in the chat's own database, beside the tree's
//! `ctx_*` tables, so a reset of the tree resets this too (store.rs).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::turn_memory::goals::{self, GoalState};
use crate::turn_memory::items::Kind;
use crate::turn_memory::select::{self as sel, Picks, Selection};
use crate::turn_memory::TurnMemory;
use crate::types::{ContentBlock, Message, MessageContent, Role};

/// The groups of the memory checklist, in display order: (id, title, parent).
/// `mem` is the root; every other group hangs under it.
pub const GROUPS: &[(&str, &str, Option<&str>)] = &[
    ("mem", "Chat memory", None),
    ("mem.goals", "Goals", Some("mem")),
    ("mem.goals.closed", "Closed goals (done, cancelled, replaced)", Some("mem.goals")),
    ("mem.goal_history", "Goal history", Some("mem.goals")),
    ("mem.topics", "Topics & titles", Some("mem")),
    ("mem.decisions", "Decisions in force", Some("mem")),
    ("mem.decisions.closed", "Replaced / closed decisions", Some("mem.decisions")),
    ("mem.facts", "Facts", Some("mem")),
    ("mem.prefs", "Preferences", Some("mem")),
    ("mem.replaced", "Replaced / retired facts, preferences & files", Some("mem")),
    ("mem.files", "Files", Some("mem")),
    ("mem.tasks", "Open tasks", Some("mem")),
    ("mem.tasks.closed", "Closed tasks", Some("mem.tasks")),
    ("mem.ranges", "Ranges (turn summaries)", Some("mem")),
    ("mem.ranges.old", "Old ranges", Some("mem.ranges")),
    ("mem.versions", "Memory versions", Some("mem")),
];

/// Ranges newer than this many stay in "Ranges"; the rest are "Old ranges".
pub const RECENT_RANGES: usize = 3;
/// Versions of one record returned in the panel snapshot (all are stored).
pub const SNAPSHOT_VERSIONS: usize = 8;
/// Upper bound of one `ctx memory` answer.
pub const MAX_VIEW_CHARS: usize = 8_000;
/// A tool result shorter than this is never treated as a duplicate.
pub const MIN_DUP_CHARS: usize = 120;
/// Upper bound of a file's content put at its #tag (an older version that
/// is no longer in the view); `ctx memory id=#name@vN` reads more.
pub const INLINE_FILE_CHARS: usize = 6_000;

/// One row of the memory checklist.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    /// The record's own ID: G2, D12, F4, P1, L3, O5, S3-7, T-database,
    /// GH4 (goal history event), V7 (memory version), file:path.
    pub rid: String,
    pub group: &'static str,
    pub title: String,
    /// The line the memory block sends for it.
    pub line: String,
    /// The #tag, lower-cased without the `#`.
    pub tag: String,
    /// Other names the tag answers to (a file's name).
    pub aliases: Vec<String>,
    pub status: String,
    pub turn: u32,
    /// True when the selector knows the record (goals, decisions, items,
    /// ranges); other rows are sent as plain lines when picked.
    pub native: bool,
}

/// A #tag named in the conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    pub tag: String,
    pub rid: String,
    pub version: Option<u32>,
    pub turn: u32,
}

/// A file read by a tool call in the view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRead {
    pub path: String,
    pub hash: String,
    pub turn: u32,
    pub call_index: u32,
    pub chars: usize,
    /// The tool call that read it: its result is stored once in
    /// `tool_results` (turn_memory/store.rs), so every version of the file
    /// stays readable without a second copy. Empty for rows stored before.
    pub tool_use_id: String,
}

/// A record's context put once into the view, at the **last** active #tag
/// of the record (every earlier mention only refers to it). Records with an
/// anchor are left out of the memory block, so nothing is sent twice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub rid: String,
    pub tag: String,
    pub version: Option<u32>,
    pub turn: u32,
    pub text: String,
    /// Every lowercase name a mention of this record may use (its tag, its
    /// ID, `mem/<ID>`, aliases such as `file:<path>`), to find the message
    /// that names it as a whole tag (`#d1` is not a mention of `#d12`).
    pub names: Vec<String>,
}

fn hash(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.chars().count() >= 40 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}

/// A file's name as a tag (`plan.md`), from a path.
fn file_tag(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).trim().to_lowercase()
}

/// File names inside a record's text (`src/main.rs`, `plan.md`).
fn file_names(text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[A-Za-z0-9_./\\-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}\b").unwrap());
    let mut v: Vec<String> = re
        .find_iter(text)
        .map(|m| file_tag(m.as_str()))
        .filter(|n| n.contains('.') && !n.starts_with('.') && n.len() <= 80 && n.chars().any(|c| c.is_alphabetic()))
        .collect();
    v.sort();
    v.dedup();
    v
}

fn item_group(kind: Option<Kind>, current: bool) -> &'static str {
    match (kind, current) {
        (Some(Kind::OpenItem), true) => "mem.tasks",
        (Some(Kind::OpenItem), false) => "mem.tasks.closed",
        (Some(Kind::Fact), true) => "mem.facts",
        (Some(Kind::Preference), true) => "mem.prefs",
        (Some(Kind::File), true) => "mem.files",
        _ => "mem.replaced",
    }
}

/// Every row of the memory checklist, built from the memory, the goals, the
/// saved memory versions and the files read in this chat.
pub fn records(mem: &TurnMemory, st: &GoalState, versions: &[Value], files: &[FileRead]) -> Vec<Record> {
    let mut out: Vec<Record> = Vec::new();
    let rec = |rid: &str, group: &'static str, title: String, line: String, status: &str, turn: u32, native: bool| Record {
        rid: rid.to_string(),
        group,
        title,
        line,
        tag: rid.to_lowercase(),
        aliases: Vec::new(),
        status: status.to_string(),
        turn,
        native,
    };
    // Goals.
    for g in &st.goals {
        let open = g.status == goals::ACTIVE || g.status == goals::PAUSED;
        let group = if open { "mem.goals" } else { "mem.goals.closed" };
        out.push(rec(&g.goal_id, group, g.title.clone(), sel::goal_line(g, false), &g.status, g.source_turn, true));
    }
    for e in &st.events {
        let rid = format!("GH{}", e.seq);
        let title = if e.title.is_empty() { e.goal_id.clone() } else { format!("{} — {}", e.goal_id, e.title) };
        let line = format!(
            "- {} {} at turn {}{}{}",
            e.goal_id,
            e.op,
            e.turn,
            if e.title.is_empty() { String::new() } else { format!(": {}", e.title) },
            if e.evidence.is_empty() { String::new() } else { format!(" (\"{}\")", clip(&e.evidence, 160)) }
        );
        out.push(rec(&rid, "mem.goal_history", format!("{} · {}", e.op, title), line, &e.op, e.turn, false));
    }
    // Topics and the titles their ranges were given.
    for (topic, ranges) in crate::turn_memory::topic_groups(mem) {
        let rid = format!("T-{}", slug(&topic));
        let titles: Vec<String> = mem
            .segments
            .iter()
            .filter(|s| ranges.contains(&(s.from_turn, s.to_turn)) && !s.title.is_empty())
            .map(|s| s.title.clone())
            .collect();
        let turns: Vec<String> = ranges.iter().map(|(a, b)| if a == b { a.to_string() } else { format!("{a}-{b}") }).collect();
        let line = format!(
            "- Topic [{}]: turns {}{}",
            topic,
            turns.join(", "),
            if titles.is_empty() { String::new() } else { format!("; titles: {}", titles.join(" · ")) }
        );
        let first = ranges.first().map(|r| r.0).unwrap_or(0);
        out.push(rec(&rid, "mem.topics", topic.clone(), line, "topic", first, false));
    }
    // Decisions.
    for d in &mem.decisions.current {
        out.push(rec(&d.id, "mem.decisions", clip(&d.text, 90), sel::decision_line(d), "current", d.turn, true));
    }
    for d in &mem.decisions.superseded {
        out.push(rec(&d.id, "mem.decisions.closed", clip(&d.text, 90), sel::superseded_line(d), "superseded", d.turn, true));
    }
    // Facts, preferences, files, tasks.
    for i in &mem.items {
        let current = i.is_current();
        let kind = i.kind();
        let line = if kind == Some(Kind::OpenItem) { sel::task_line(i) } else { sel::item_line(i, true) };
        let mut r = rec(&i.id, item_group(kind, current), clip(&i.text, 90), line, &i.status, i.turn(), true);
        if kind == Some(Kind::File) {
            r.aliases = file_names(&i.text);
        }
        out.push(r);
    }
    // Ranges: the newest few, then the old ones.
    let mut segs: Vec<&crate::turn_memory::Segment> = mem.segments.iter().collect();
    segs.sort_by_key(|s| std::cmp::Reverse(s.to_turn));
    for (n, s) in segs.iter().enumerate() {
        let group = if n < RECENT_RANGES { "mem.ranges" } else { "mem.ranges.old" };
        let title = if s.title.is_empty() { s.topic.clone() } else { s.title.clone() };
        out.push(rec(&sel::seg_id(s), group, title, sel::segment_line(s), "range", s.from_turn, true));
    }
    // Memory versions.
    for v in versions {
        let n = v.get("version").and_then(|x| x.as_i64()).unwrap_or(0);
        if n <= 0 {
            continue;
        }
        let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        let through = v.get("throughTurn").and_then(|x| x.as_i64()).unwrap_or(0);
        let line = format!("- Memory version {n} ({kind}), turns 1-{through} summarized");
        out.push(rec(&format!("V{n}"), "mem.versions", format!("v{n} · {kind}"), line, kind, through.max(0) as u32, false));
    }
    // Files read in the chat: one row per path, its versions by content.
    let mut by_path: BTreeMap<String, Vec<&FileRead>> = BTreeMap::new();
    for f in files {
        by_path.entry(f.path.clone()).or_default().push(f);
    }
    for (path, reads) in by_path {
        let last = reads.iter().max_by_key(|f| (f.turn, f.call_index)).copied();
        let Some(last) = last else { continue };
        let distinct: BTreeSet<&str> = reads.iter().map(|f| f.hash.as_str()).collect();
        // The line names the content only, so a new version is written when
        // the content changes, never because the same file was read again.
        let line = format!("- File {} (content {}, {} chars)", path, last.hash, last.chars);
        let status = format!("{} read(s), {} distinct content(s), last read turn {}", reads.len(), distinct.len(), last.turn);
        let mut r = rec(&format!("file:{path}"), "mem.files", path.clone(), line, &status, last.turn, false);
        r.tag = file_tag(&path);
        r.aliases = vec![format!("file:{}", path.to_lowercase())];
        out.push(r);
    }
    out
}

// ───────────────────────────── storage ─────────────────────────────

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ctx_mem_picks (
            session_key TEXT NOT NULL, rid TEXT NOT NULL,
            pick TEXT NOT NULL DEFAULT 'auto', versions TEXT NOT NULL DEFAULT 'latest',
            actor TEXT NOT NULL DEFAULT 'user', updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, rid));
         CREATE TABLE IF NOT EXISTS ctx_mem_versions (
            session_key TEXT NOT NULL, rid TEXT NOT NULL, version INTEGER NOT NULL,
            hash TEXT NOT NULL, line TEXT NOT NULL, status TEXT NOT NULL DEFAULT '',
            memory_version INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, rid, version));
         CREATE TABLE IF NOT EXISTS ctx_mem_tags (
            session_key TEXT NOT NULL, tag TEXT NOT NULL, rid TEXT NOT NULL,
            version INTEGER, first_turn INTEGER NOT NULL DEFAULT 0, last_turn INTEGER NOT NULL DEFAULT 0,
            mentions INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active',
            removed_through INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, tag));
         CREATE TABLE IF NOT EXISTS ctx_mem_files (
            session_key TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
            turn INTEGER NOT NULL, call_index INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, path, turn, call_index));
         CREATE TABLE IF NOT EXISTS ctx_mem_status (
            session_key TEXT PRIMARY KEY, reasons_json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);",
    )?;
    // Tables written by the first checklist build have no tool_use_id.
    if conn.prepare("SELECT tool_use_id FROM ctx_mem_files LIMIT 0").is_err() {
        conn.execute("ALTER TABLE ctx_mem_files ADD COLUMN tool_use_id TEXT NOT NULL DEFAULT ''", [])?;
    }
    Ok(())
}

/// Every memory-checklist row of one chat goes (part of a tree reset).
pub fn reset_session(conn: &Connection, session_key: &str) -> rusqlite::Result<usize> {
    ensure_tables(conn)?;
    let mut n = 0;
    for t in ["ctx_mem_picks", "ctx_mem_versions", "ctx_mem_tags", "ctx_mem_files", "ctx_mem_status"] {
        n += conn.execute(&format!("DELETE FROM {t} WHERE session_key = ?1"), [session_key])?;
    }
    Ok(n)
}

/// One stored version of a record.
#[derive(Debug, Clone, PartialEq)]
pub struct Version {
    pub version: u32,
    pub hash: String,
    pub line: String,
    pub status: String,
    pub memory_version: u64,
    pub turn: u32,
    pub created_at: i64,
}

pub fn load_versions(conn: &Connection, session_key: &str, rid: &str) -> Vec<Version> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT version, hash, line, status, memory_version, turn, created_at FROM ctx_mem_versions WHERE session_key = ?1 AND rid = ?2 ORDER BY version",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![session_key, rid], |r| {
        Ok(Version {
            version: r.get::<_, i64>(0)? as u32,
            hash: r.get(1)?,
            line: r.get(2)?,
            status: r.get(3)?,
            memory_version: r.get::<_, i64>(4)? as u64,
            turn: r.get::<_, i64>(5)? as u32,
            created_at: r.get(6)?,
        })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

fn latest_versions(conn: &Connection, session_key: &str) -> HashMap<String, (u32, String)> {
    let mut out = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT rid, MAX(version), hash FROM ctx_mem_versions WHERE session_key = ?1 GROUP BY rid") {
        if let Ok(rows) = stmt.query_map([session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32, r.get::<_, String>(2)?))) {
            for (rid, v, _) in rows.flatten() {
                out.insert(rid, (v, String::new()));
            }
        }
    }
    // The hash of the newest version (the GROUP BY above cannot be trusted
    // to return the hash of the MAX row on every SQLite build).
    let keys: Vec<(String, u32)> = out.iter().map(|(k, (v, _))| (k.clone(), *v)).collect();
    for (rid, v) in keys {
        let h: Option<String> = conn
            .query_row("SELECT hash FROM ctx_mem_versions WHERE session_key = ?1 AND rid = ?2 AND version = ?3", params![session_key, rid, v], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        if let Some(h) = h {
            out.insert(rid, (v, h));
        }
    }
    out
}

/// Keep every record's versions: a record whose line changed since its
/// newest stored version gets a new version. Nothing is ever overwritten.
/// Returns how many versions were written.
pub fn sync_versions(conn: &Connection, session_key: &str, records: &[Record], memory_version: u64, now_ms: i64) -> rusqlite::Result<usize> {
    ensure_tables(conn)?;
    let latest = latest_versions(conn, session_key);
    let mut written = 0;
    for r in records {
        let h = hash(&r.line);
        let next = match latest.get(&r.rid) {
            Some((_, old)) if *old == h => continue,
            Some((v, _)) => v + 1,
            None => 1,
        };
        conn.execute(
            "INSERT OR IGNORE INTO ctx_mem_versions (session_key, rid, version, hash, line, status, memory_version, turn, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![session_key, r.rid, next as i64, h, r.line, r.status, memory_version as i64, r.turn as i64, now_ms],
        )?;
        written += 1;
    }
    Ok(written)
}

/// The files read in the chat that were stored earlier (they survive the
/// turns that read them being summarized away).
pub fn load_files(conn: &Connection, session_key: &str) -> Vec<FileRead> {
    let Ok(mut stmt) = conn.prepare("SELECT path, hash, turn, call_index, chars, tool_use_id FROM ctx_mem_files WHERE session_key = ?1 ORDER BY turn, call_index") else {
        return Vec::new();
    };
    stmt.query_map([session_key], |r| {
        Ok(FileRead { path: r.get(0)?, hash: r.get(1)?, turn: r.get::<_, i64>(2)? as u32, call_index: r.get::<_, i64>(3)? as u32, chars: r.get::<_, i64>(4)? as usize, tool_use_id: r.get(5)? })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

pub fn save_files(conn: &Connection, session_key: &str, files: &[FileRead]) -> rusqlite::Result<()> {
    ensure_tables(conn)?;
    for f in files {
        conn.execute(
            "INSERT OR REPLACE INTO ctx_mem_files (session_key, path, hash, turn, call_index, chars, tool_use_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![session_key, f.path, f.hash, f.turn as i64, f.call_index as i64, f.chars as i64, f.tool_use_id],
        )?;
    }
    Ok(())
}

/// The person's (or the model's) choice for one record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickRow {
    pub pick: String,
    pub versions: String,
    pub actor: String,
}

pub fn load_picks(conn: &Connection, session_key: &str) -> HashMap<String, PickRow> {
    let mut out = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT rid, pick, versions, actor FROM ctx_mem_picks WHERE session_key = ?1") {
        if let Ok(rows) = stmt.query_map([session_key], |r| Ok((r.get::<_, String>(0)?, PickRow { pick: r.get(1)?, versions: r.get(2)?, actor: r.get(3)? }))) {
            out.extend(rows.flatten());
        }
    }
    out
}

/// One #tag of the chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRow {
    pub tag: String,
    pub rid: String,
    pub version: Option<u32>,
    pub first_turn: u32,
    pub last_turn: u32,
    pub mentions: u32,
    pub state: String,
    pub removed_through: u32,
}

pub fn load_tags(conn: &Connection, session_key: &str) -> Vec<TagRow> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT tag, rid, version, first_turn, last_turn, mentions, state, removed_through FROM ctx_mem_tags WHERE session_key = ?1 ORDER BY last_turn DESC, tag",
    ) else {
        return Vec::new();
    };
    stmt.query_map([session_key], |r| {
        Ok(TagRow {
            tag: r.get(0)?,
            rid: r.get(1)?,
            version: r.get::<_, Option<i64>>(2)?.map(|v| v as u32),
            first_turn: r.get::<_, i64>(3)? as u32,
            last_turn: r.get::<_, i64>(4)? as u32,
            mentions: r.get::<_, i64>(5)? as u32,
            state: r.get(6)?,
            removed_through: r.get::<_, i64>(7)? as u32,
        })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

// ───────────────────────────── #tags ─────────────────────────────

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?:^|[^\w&#/])#([A-Za-z0-9][A-Za-z0-9_.:/\-]{0,100})(?:@v(\d{1,5}))?").unwrap())
}

/// Resolve a tag (without `#`, any case) to a record ID.
pub fn resolve(records: &[Record], tag: &str) -> Option<String> {
    let t = tag.trim().trim_start_matches('#').trim_end_matches(['.', ',', ';', ':', ')', '!', '?']).to_lowercase();
    let t = t.strip_prefix("mem/").map(str::to_string).unwrap_or(t);
    if t.is_empty() {
        return None;
    }
    records
        .iter()
        .find(|r| r.tag == t || r.rid.to_lowercase() == t)
        .or_else(|| records.iter().find(|r| r.aliases.iter().any(|a| *a == t)))
        .map(|r| r.rid.clone())
}

/// The #tags named in the conversation, in order. Only what the user and the
/// assistant wrote counts (not tool results, not the memory block itself).
/// `turns` gives each message's absolute turn number (None: no turn).
pub fn scan_mentions(messages: &[Message], turn_of: &dyn Fn(usize) -> Option<u32>, records: &[Record]) -> Vec<Mention> {
    let mut out = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        if m.role == Role::Context || crate::turn_memory::is_memory_message(m) {
            continue;
        }
        let Some(turn) = turn_of(i) else { continue };
        let text = m.text();
        if !text.contains('#') {
            continue;
        }
        for c in tag_re().captures_iter(&text) {
            let raw = c.get(1).map(|x| x.as_str()).unwrap_or("");
            let raw = raw.trim_end_matches(['.', ',', ';', ':', ')', '!', '?', '/']);
            let Some(rid) = resolve(records, raw) else { continue };
            let version = c.get(2).and_then(|v| v.as_str().parse::<u32>().ok());
            let tag = records.iter().find(|r| r.rid == rid).map(|r| r.tag.clone()).unwrap_or_else(|| raw.to_lowercase());
            out.push(Mention { tag, rid, version, turn });
        }
    }
    out
}

/// Store the mentions: one row per tag, keeping its **last** mention (turn
/// and version) and how often it was named. A removed tag stays removed for
/// every mention up to its removal; a newer mention brings it back. An
/// inactive tag keeps its state.
pub fn record_mentions(conn: &Connection, session_key: &str, mentions: &[Mention], now_ms: i64) -> rusqlite::Result<()> {
    ensure_tables(conn)?;
    let existing: HashMap<String, TagRow> = load_tags(conn, session_key).into_iter().map(|t| (t.tag.clone(), t)).collect();
    let mut by_tag: BTreeMap<String, (String, Option<u32>, u32, u32, u32)> = BTreeMap::new();
    for m in mentions {
        let removed_through = existing.get(&m.tag).map(|t| t.removed_through).unwrap_or(0);
        if existing.get(&m.tag).map(|t| t.state == "removed").unwrap_or(false) && m.turn <= removed_through {
            continue;
        }
        let e = by_tag.entry(m.tag.clone()).or_insert((m.rid.clone(), m.version, m.turn, m.turn, 0));
        // Mentions come in transcript order: a later one always wins.
        if m.turn >= e.3 {
            e.0 = m.rid.clone();
            e.1 = m.version;
            e.3 = m.turn;
        }
        e.2 = e.2.min(m.turn);
        e.4 += 1;
    }
    for (tag, (rid, version, first, last, count)) in by_tag {
        let state = match existing.get(&tag) {
            Some(t) if t.state == "inactive" => "inactive",
            _ => "active",
        };
        let removed_through = existing.get(&tag).map(|t| t.removed_through).unwrap_or(0);
        conn.execute(
            "INSERT INTO ctx_mem_tags (session_key, tag, rid, version, first_turn, last_turn, mentions, state, removed_through, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(session_key, tag) DO UPDATE SET rid = excluded.rid, version = excluded.version,
               first_turn = excluded.first_turn, last_turn = excluded.last_turn, mentions = excluded.mentions,
               state = excluded.state, updated_at = excluded.updated_at",
            params![session_key, tag, rid, version.map(|v| v as i64), first as i64, last as i64, count as i64, state, removed_through as i64, now_ms],
        )?;
    }
    Ok(())
}

// ───────────────────────────── picks → selection ─────────────────────────────

/// What the checklist asks of this request: picks, active tags (each at its
/// last mention's version) and inactive tags, as the selector's [`Picks`].
pub fn build_picks(conn: &Connection, session_key: &str, records: &[Record]) -> Picks {
    build_picks_with(conn, session_key, records, &[])
}

/// [`build_picks`] where the records in `anchors` are sent at their last
/// #tag in the view: they go to `Picks::inline` and stay out of the block.
pub fn build_picks_with(conn: &Connection, session_key: &str, records: &[Record], anchors: &[Anchor]) -> Picks {
    let mut p = Picks::default();
    for a in anchors {
        p.inline.insert(a.rid.clone());
    }
    let by_rid: HashMap<&str, &Record> = records.iter().map(|r| (r.rid.as_str(), r)).collect();
    let picks = load_picks(conn, session_key);
    let mut extra_seen: BTreeSet<String> = BTreeSet::new();
    let mut push_extra = |p: &mut Picks, key: String, line: String| {
        if extra_seen.insert(key.clone()) {
            p.extra.push((key, line));
        }
    };
    let mut rids: Vec<&String> = picks.keys().collect();
    rids.sort();
    for rid in rids {
        let row = &picks[rid];
        let Some(r) = by_rid.get(rid.as_str()) else { continue };
        match row.pick.as_str() {
            "out" => {
                p.exclude.insert(rid.clone());
                continue;
            }
            "in" => {
                if r.native {
                    p.include.push((rid.clone(), "user_pick"));
                } else {
                    push_extra(&mut p, rid.clone(), r.line.clone());
                }
            }
            _ => {}
        }
        if row.versions == "all" {
            if r.native {
                p.with_history.insert(rid.clone());
            }
            // Earlier wordings of the record itself, oldest first.
            for v in load_versions(conn, session_key, rid) {
                if v.line != r.line {
                    push_extra(&mut p, format!("{rid}@v{}", v.version), format!("- #{rid}@v{} (earlier wording) {}", v.version, v.line.trim_start_matches("- ")));
                }
            }
        }
    }
    for t in load_tags(conn, session_key) {
        if p.exclude.contains(&t.rid) || p.inline.contains(&t.rid) {
            continue;
        }
        let Some(r) = by_rid.get(t.rid.as_str()) else { continue };
        match t.state.as_str() {
            "active" => {
                // The version the last mention named, when it is not the newest.
                let older = t.version.and_then(|v| {
                    let vs = load_versions(conn, session_key, &t.rid);
                    let newest = vs.last().map(|x| x.version).unwrap_or(0);
                    if v < newest {
                        vs.into_iter().find(|x| x.version == v)
                    } else {
                        None
                    }
                });
                match older {
                    Some(v) => push_extra(&mut p, format!("{}@v{}", t.rid, v.version), format!("- #{}@v{} (version named in the chat) {}", t.rid, v.version, v.line.trim_start_matches("- "))),
                    None if r.native => {
                        if !p.include.iter().any(|(id, _)| *id == t.rid) {
                            p.include.push((t.rid.clone(), "mentioned"));
                        }
                    }
                    None => push_extra(&mut p, t.rid.clone(), r.line.clone()),
                }
            }
            "inactive" => {
                if !p.include.iter().any(|(id, _)| *id == t.rid) {
                    p.inactive.insert(t.rid.clone());
                }
            }
            _ => {}
        }
    }
    p
}

/// Store why each record was or was not sent this time (for the colours).
/// Rows the selector does not know (topics, goal history, versions, files)
/// are `user_pick`/`mentioned` when the checklist sent them, else `not_shown`.
pub fn save_status(conn: &Connection, session_key: &str, selection: &Selection, picks: &Picks, records: &[Record], now_ms: i64) -> rusqlite::Result<()> {
    ensure_tables(conn)?;
    let mut reasons: BTreeMap<String, String> = selection.reasons.iter().cloned().collect();
    let tags: HashMap<String, TagRow> = load_tags(conn, session_key).into_iter().map(|t| (t.rid.clone(), t)).collect();
    for r in records.iter().filter(|r| !r.native) {
        let sent = picks.extra.iter().any(|(k, _)| *k == r.rid);
        let why = if picks.exclude.contains(&r.rid) {
            "excluded"
        } else if picks.inline.contains(&r.rid) {
            "inline"
        } else if sent {
            match tags.get(&r.rid) {
                Some(t) if t.state == "active" => "mentioned",
                _ => "user_pick",
            }
        } else if picks.inactive.contains(&r.rid) {
            "inactive"
        } else {
            "not_shown"
        };
        reasons.insert(r.rid.clone(), why.to_string());
    }
    conn.execute(
        "INSERT INTO ctx_mem_status (session_key, reasons_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(session_key) DO UPDATE SET reasons_json = excluded.reasons_json, updated_at = excluded.updated_at",
        params![session_key, serde_json::to_string(&reasons).unwrap_or_default(), now_ms],
    )?;
    Ok(())
}

fn load_status(conn: &Connection, session_key: &str) -> BTreeMap<String, String> {
    conn.query_row("SELECT reasons_json FROM ctx_mem_status WHERE session_key = ?1", [session_key], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The colour class of a reason: `sent` (in this request), `left_out`
/// (matched but cut for length, or taken out by hand), `show_more` (stored,
/// not needed now), `inactive` (its tag is inactive), `pinned` (an earlier
/// version sent on request).
pub fn colour(reason: &str) -> &'static str {
    match reason {
        "cut" | "excluded" => "left_out",
        "not_shown" | "" => "show_more",
        "inactive" => "inactive",
        "pinned_version" | "versions" => "pinned",
        _ => "sent",
    }
}

// ───────────────────────────── one call per request ─────────────────────────────

/// Everything the memory loop needs for one request: the rows (with their
/// versions kept up to date), the tags named in the transcript, and the
/// picks for the selector. `messages` is the whole transcript before the
/// fold, `turn_of` its turn numbers.
pub fn prepare(
    conn: &Connection,
    session_key: &str,
    mem: &TurnMemory,
    st: &GoalState,
    messages: &[Message],
    turn_of: &dyn Fn(usize) -> Option<u32>,
    now_ms: i64,
) -> (Vec<Record>, Picks) {
    let (recs, picks, _) = prepare_anchored(conn, session_key, mem, st, messages, turn_of, &|_| false, now_ms);
    (recs, picks)
}

/// [`prepare`] that also returns the anchors: each active #tag whose last
/// mention is in a turn `in_view` says is still shown gets its record's
/// context there, once, and the record leaves the memory block.
#[allow(clippy::too_many_arguments)]
pub fn prepare_anchored(
    conn: &Connection,
    session_key: &str,
    mem: &TurnMemory,
    st: &GoalState,
    messages: &[Message],
    turn_of: &dyn Fn(usize) -> Option<u32>,
    in_view: &dyn Fn(u32) -> bool,
    now_ms: i64,
) -> (Vec<Record>, Picks, Vec<Anchor>) {
    if ensure_tables(conn).is_err() {
        return (Vec::new(), Picks::default(), Vec::new());
    }
    let (_, reads) = duplicate_calls_abs(messages, turn_of);
    let _ = save_files(conn, session_key, &reads);
    let files = load_files(conn, session_key);
    let versions = crate::turn_memory::list_versions(conn, session_key);
    let recs = records(mem, st, &versions, &files);
    let _ = sync_versions(conn, session_key, &recs, mem.version, now_ms);
    let mentions = scan_mentions(messages, turn_of, &recs);
    let _ = record_mentions(conn, session_key, &mentions, now_ms);
    let active_goal = st.current().map(|g| g.goal_id.clone());
    let mut anchors = anchors(conn, session_key, &recs, active_goal.as_deref(), in_view);
    // Only an anchor that has a message to go to keeps its record out of
    // the block; otherwise the record would be sent nowhere.
    anchors.retain(|a| anchor_slot(messages, turn_of, a).is_some());
    let picks = build_picks_with(conn, session_key, &recs, &anchors);
    (recs, picks, anchors)
}

// ───────────────────────────── context at the last #tag ─────────────────────────────

/// The content hash a file row's version line names (`content 1a2b…`).
fn content_hash(line: &str) -> Option<String> {
    let rest = line.split("(content ").nth(1)?;
    let h: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    (!h.is_empty()).then_some(h)
}

/// The newest read of `path` with this content: (turn, tool_use_id).
fn read_with_hash(conn: &Connection, session_key: &str, path: &str, hash: &str) -> Option<(u32, String)> {
    conn.query_row(
        "SELECT turn, tool_use_id FROM ctx_mem_files WHERE session_key = ?1 AND path = ?2 AND hash = ?3 ORDER BY turn DESC, call_index DESC LIMIT 1",
        params![session_key, path, hash],
        |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, String>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// One version of a file: (version, its line, the newest read with that
/// content, the stored content when the tool result is still kept).
pub fn file_version(conn: &Connection, session_key: &str, rid: &str, version: Option<u32>) -> Option<(u32, String, Option<u32>, Option<String>)> {
    let path = rid.strip_prefix("file:")?;
    let vs = load_versions(conn, session_key, rid);
    let v = match version {
        Some(n) => vs.into_iter().find(|v| v.version == n)?,
        None => vs.into_iter().last()?,
    };
    let hash = content_hash(&v.line);
    let read = hash.as_deref().and_then(|h| read_with_hash(conn, session_key, path, h));
    let content = read
        .as_ref()
        .filter(|(_, id)| !id.is_empty())
        .and_then(|(_, id)| crate::turn_memory::load_result(conn, session_key, id))
        .filter(|r| hash.as_deref() == Some(self::hash(&r.content).as_str()))
        .map(|r| r.content);
    Some((v.version, v.line, read.map(|r| r.0), content))
}

fn file_anchor_text(conn: &Connection, session_key: &str, r: &Record, version: Option<u32>, in_view: &dyn Fn(u32) -> bool) -> String {
    let Some((v, line, read_turn, content)) = file_version(conn, session_key, &r.rid, version) else {
        return r.line.clone();
    };
    let label = format!("#{}@v{}", r.tag, v);
    match (read_turn, content) {
        (Some(t), _) if in_view(t) => format!("{label}: {} The content of this version is the file read of turn {t} above; it is not repeated here.", line.trim_start_matches("- ")),
        (_, Some(c)) => {
            let n = c.chars().count();
            let body = clip(&c, INLINE_FILE_CHARS);
            let more = if n > INLINE_FILE_CHARS { format!("\n(first {INLINE_FILE_CHARS} of {n} characters; ctx memory id={label} reads more)") } else { String::new() };
            format!("{label}: {}\n{body}{more}", line.trim_start_matches("- "))
        }
        _ => format!("{label}: {} (its content is no longer stored; read the file again if it is needed)", line.trim_start_matches("- ")),
    }
}

/// The anchors of this request: one per record, at the last mention of its
/// active #tag, when that turn is still in the view. A record the checklist
/// already sends in the block (picked in, all versions) or takes out gets
/// none, nor does the active goal (the block always holds it).
pub fn anchors(conn: &Connection, session_key: &str, records: &[Record], active_goal: Option<&str>, in_view: &dyn Fn(u32) -> bool) -> Vec<Anchor> {
    let by_rid: HashMap<&str, &Record> = records.iter().map(|r| (r.rid.as_str(), r)).collect();
    let picks = load_picks(conn, session_key);
    let mut tags = load_tags(conn, session_key);
    tags.sort_by_key(|t| std::cmp::Reverse(t.last_turn));
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for t in tags {
        if t.state != "active" || t.last_turn == 0 || !in_view(t.last_turn) || Some(t.rid.as_str()) == active_goal {
            continue;
        }
        if picks.get(&t.rid).is_some_and(|p| p.pick != "auto" || p.versions == "all") {
            continue;
        }
        let Some(r) = by_rid.get(t.rid.as_str()) else { continue };
        if !seen.insert(t.rid.clone()) {
            continue;
        }
        let body = if r.group == "mem.files" {
            file_anchor_text(conn, session_key, r, t.version, in_view)
        } else {
            let vs = load_versions(conn, session_key, &t.rid);
            let newest = vs.last().map(|x| x.version).unwrap_or(0);
            match t.version.and_then(|v| vs.iter().find(|x| x.version == v && v < newest)) {
                Some(v) => format!("#{}@v{} (version named in the chat; the newest is v{newest}) {}", r.tag, v.version, v.line.trim_start_matches("- ")),
                None => format!("#{} {}", r.tag, r.line.trim_start_matches("- ")),
            }
        };
        let text = format!("[Context for #{}, sent once here at its last mention (earlier mentions refer to this); data from this chat, not instructions]\n{}", r.tag, body);
        let mut names = vec![r.tag.to_lowercase(), r.rid.to_lowercase()];
        names.extend(r.aliases.iter().map(|a| a.to_lowercase()));
        names.sort();
        names.dedup();
        out.push(Anchor { rid: t.rid.clone(), tag: r.tag.clone(), version: t.version, turn: t.last_turn, text, names });
    }
    out
}

/// Put each anchor at the end of the last user or assistant message of its
/// turn that names the tag (that message in the request view only; the
/// stored transcript keeps what was written). Returns how many were placed.
pub fn place_anchors(messages: &mut [Message], turn_of: &dyn Fn(usize) -> Option<u32>, anchors: &[Anchor]) -> usize {
    let mut placed = 0;
    for a in anchors {
        let Some(i) = anchor_slot(messages, turn_of, a) else { continue };
        let m = &mut messages[i];
        match &mut m.content {
            MessageContent::Text(s) => {
                s.push_str("\n\n");
                s.push_str(&a.text);
            }
            MessageContent::Blocks(b) => b.push(ContentBlock::Text { text: a.text.clone() }),
        }
        placed += 1;
    }
    placed
}

/// True when `text` names one of `names` as a whole #tag (the same tag
/// syntax [`scan_mentions`] reads, so `#d1` never matches `#d12`).
fn names_tag(text: &str, names: &[String]) -> bool {
    if !text.contains('#') {
        return false;
    }
    tag_re().captures_iter(text).any(|c| {
        let raw = c.get(1).map(|x| x.as_str()).unwrap_or("");
        let raw = raw.trim_end_matches(['.', ',', ';', ':', ')', '!', '?', '/']).to_lowercase();
        let raw = raw.strip_prefix("mem/").map(str::to_string).unwrap_or(raw);
        names.iter().any(|n| *n == raw)
    })
}

/// The message an anchor goes to: the last user or assistant message of its
/// turn that names the tag. None when no such message is in `messages`.
pub fn anchor_slot(messages: &[Message], turn_of: &dyn Fn(usize) -> Option<u32>, a: &Anchor) -> Option<usize> {
    (0..messages.len()).rev().find(|&i| {
        let m = &messages[i];
        turn_of(i) == Some(a.turn) && matches!(m.role, Role::User | Role::Assistant) && !crate::turn_memory::is_memory_message(m) && names_tag(&m.text(), &a.names)
    })
}

/// The rows of a chat as they stand (for the panel and `ctx memory`).
pub fn current_records(conn: &Connection, session_key: &str) -> Vec<Record> {
    let mem = crate::turn_memory::load_memory(conn, session_key);
    let st = goals::load_state(conn, session_key);
    let versions = crate::turn_memory::list_versions(conn, session_key);
    let _ = ensure_tables(conn);
    let files = load_files(conn, session_key);
    records(&mem, &st, &versions, &files)
}

// ───────────────────────────── duplicates and files ─────────────────────────────

fn result_text(content: &str) -> String {
    content.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn read_path(name: &str, input: &Value) -> Option<String> {
    let n = name.to_ascii_lowercase();
    if !(n == "read_file" || n.ends_with("_read") || n.ends_with("read_file") || n == "view_file" || n == "open_file") {
        return None;
    }
    ["path", "file_path", "filePath", "file", "filename"]
        .iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Tool calls whose result repeats a later call's result word for word (the
/// same file read twice, the same memory recalled again): every occurrence
/// but the **last** is dropped from the request, so the same context is
/// never sent twice. Returned as (absolute turn, call index), the shape
/// `request_view_mapped` takes; plus every file read with its content hash.
pub fn duplicate_calls_abs(messages: &[Message], turn_of: &dyn Fn(usize) -> Option<u32>) -> (BTreeSet<(u32, u32)>, Vec<FileRead>) {
    // (turn, call index, tool name, input, result) in transcript order.
    let mut calls: Vec<(u32, u32, String, Value, String, String)> = Vec::new();
    let mut index_in_turn: HashMap<u32, u32> = HashMap::new();
    let mut pos: HashMap<String, usize> = HashMap::new();
    for (i, m) in messages.iter().enumerate() {
        let MessageContent::Blocks(blocks) = &m.content else { continue };
        for b in blocks {
            match b {
                ContentBlock::ToolUse { id, name, input, .. } if m.role == Role::Assistant => {
                    let Some(turn) = turn_of(i) else { continue };
                    let k = index_in_turn.entry(turn).or_insert(0);
                    *k += 1;
                    pos.insert(id.clone(), calls.len());
                    calls.push((turn, *k, name.clone(), input.clone(), String::new(), id.clone()));
                }
                ContentBlock::ToolResult { tool_use_id, content, is_error } => {
                    if let Some(&at) = pos.get(tool_use_id) {
                        if !*is_error {
                            calls[at].4 = content.clone();
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut drop = BTreeSet::new();
    let mut last_of: HashMap<(String, String), usize> = HashMap::new();
    for (n, c) in calls.iter().enumerate() {
        if c.4.chars().count() < MIN_DUP_CHARS {
            continue;
        }
        last_of.insert((c.2.clone(), hash(&result_text(&c.4))), n);
    }
    for (n, c) in calls.iter().enumerate() {
        if c.4.chars().count() < MIN_DUP_CHARS {
            continue;
        }
        if let Some(&last) = last_of.get(&(c.2.clone(), hash(&result_text(&c.4)))) {
            if last != n {
                drop.insert((c.0, c.1));
            }
        }
    }
    let reads = calls
        .iter()
        .filter(|c| !c.4.is_empty())
        .filter_map(|c| read_path(&c.2, &c.3).map(|p| FileRead { path: p, hash: hash(&c.4), turn: c.0, call_index: c.1, chars: c.4.chars().count(), tool_use_id: c.5.clone() }))
        .collect();
    (drop, reads)
}

/// [`duplicate_calls_abs`] on the request view, with the tree's turn numbers.
pub fn duplicate_calls(view: &[Message], nums: &super::wiring::TurnNumbers) -> BTreeSet<(u32, u32)> {
    let turns = crate::turn_memory::split_turns(view);
    let mut turn_at: Vec<Option<u32>> = vec![None; view.len()];
    for t in &turns {
        for slot in turn_at.iter_mut().take(t.end.min(view.len())).skip(t.start) {
            *slot = Some(nums.abs(t.no));
        }
    }
    duplicate_calls_abs(view, &|i| turn_at.get(i).copied().flatten()).0
}

// ───────────────────────────── edits from the panel and `ctx set` ─────────────────────────────

/// True for an op id that names a memory record (`mem/D12`, `#D12`).
pub fn is_memory_id(id: &str) -> bool {
    let t = id.trim();
    t.starts_with("mem/") || t.starts_with('#')
}

/// The op actions a memory row takes.
pub const OP_ACTIONS: &[&str] = &["include", "exclude", "auto", "pin", "unpin", "all_versions", "latest", "inactive", "active", "remove"];

/// Apply checklist ops on memory rows. `include`/`pin` always send the row,
/// `exclude` never sends it, `auto`/`unpin` give it back to the selector;
/// `all_versions`/`latest` choose whether earlier versions go with it;
/// `inactive`/`active`/`remove` act on its #tag. Takes effect on the next
/// request.
pub fn apply_ops(conn: &Connection, session_key: &str, ops: &[Value], actor: &str, now_ms: i64) -> Value {
    if let Err(e) = ensure_tables(conn) {
        return json!({"ok": false, "error": e.to_string()});
    }
    let records = current_records(conn, session_key);
    let mut results = Vec::new();
    let mut ok_all = true;
    for op in ops {
        let id = op.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let action = op.get("action").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
        let Some(rid) = resolve(&records, id) else {
            ok_all = false;
            results.push(json!({"id": id, "action": action, "ok": false, "message": format!("no memory record {id}; ctx memory lists them")}));
            continue;
        };
        let tag = records.iter().find(|r| r.rid == rid).map(|r| r.tag.clone()).unwrap_or_else(|| rid.to_lowercase());
        let set_pick = |pick: Option<&str>, versions: Option<&str>| -> rusqlite::Result<()> {
            conn.execute(
                "INSERT INTO ctx_mem_picks (session_key, rid, pick, versions, actor, updated_at) VALUES (?1, ?2, COALESCE(?3, 'auto'), COALESCE(?4, 'latest'), ?5, ?6)
                 ON CONFLICT(session_key, rid) DO UPDATE SET pick = COALESCE(?3, ctx_mem_picks.pick), versions = COALESCE(?4, ctx_mem_picks.versions), actor = ?5, updated_at = ?6",
                params![session_key, rid, pick, versions, actor, now_ms],
            )?;
            Ok(())
        };
        let set_tag = |state: &str| -> rusqlite::Result<()> {
            let last: u32 = conn
                .query_row("SELECT last_turn FROM ctx_mem_tags WHERE session_key = ?1 AND tag = ?2", params![session_key, tag], |r| r.get::<_, i64>(0))
                .optional()?
                .unwrap_or(0) as u32;
            let removed = if state == "removed" { last } else { 0 };
            conn.execute(
                "INSERT INTO ctx_mem_tags (session_key, tag, rid, state, removed_through, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(session_key, tag) DO UPDATE SET state = ?4, removed_through = CASE WHEN ?4 = 'removed' THEN ?5 ELSE ctx_mem_tags.removed_through END, updated_at = ?6",
                params![session_key, tag, rid, state, removed as i64, now_ms],
            )?;
            Ok(())
        };
        let (r, msg) = match action.as_str() {
            "include" | "pin" => (set_pick(Some("in"), None), format!("{rid} is always sent from the next request")),
            "exclude" => (set_pick(Some("out"), None), format!("{rid} is not sent from the next request (kept, and listed in the checklist)")),
            "auto" | "unpin" => (set_pick(Some("auto"), None), format!("{rid} is chosen by relevance again")),
            "all_versions" => (set_pick(None, Some("all")), format!("{rid} is sent with its earlier versions when it is sent")),
            "latest" => (set_pick(None, Some("latest")), format!("{rid} is sent in its newest version only")),
            "inactive" => (set_tag("inactive"), format!("#{tag} is inactive: kept in the list, it no longer pulls {rid} in")),
            "active" => (set_tag("active"), format!("#{tag} is active again")),
            "remove" => (set_tag("removed"), format!("#{tag} is removed: its mentions so far are ignored; a new mention brings it back")),
            other => {
                ok_all = false;
                results.push(json!({"id": id, "action": other, "ok": false, "message": format!("unknown memory action \"{other}\" ({})", OP_ACTIONS.join(", "))}));
                continue;
            }
        };
        match r {
            Ok(()) => results.push(json!({"id": format!("mem/{rid}"), "rid": rid, "tag": format!("#{tag}"), "action": action, "ok": true, "message": msg})),
            Err(e) => {
                ok_all = false;
                results.push(json!({"id": id, "action": action, "ok": false, "message": e.to_string()}));
            }
        }
    }
    json!({"ok": ok_all, "memory": results})
}

// ───────────────────────────── the panel and `ctx memory` ─────────────────────────────

/// The memory part of the checklist tree for the panel: every group (as a
/// tree, `parent` naming the group above), every row with its tag, state,
/// reason and colour, its newest versions, the chat's #tags and the counts.
pub fn snapshot(conn: &Connection, session_key: &str) -> Value {
    let _ = ensure_tables(conn);
    let records = current_records(conn, session_key);
    let picks = load_picks(conn, session_key);
    let tags = load_tags(conn, session_key);
    let status = load_status(conn, session_key);
    let tag_of: HashMap<&str, &TagRow> = tags.iter().map(|t| (t.rid.as_str(), t)).collect();
    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    let groups: Vec<Value> = GROUPS
        .iter()
        .map(|(gid, title, parent)| {
            let items: Vec<Value> = records
                .iter()
                .filter(|r| r.group == *gid)
                .map(|r| {
                    let reason = status.get(&r.rid).cloned().unwrap_or_else(|| "not_shown".into());
                    let c = colour(&reason);
                    *counts.entry(c).or_insert(0) += 1;
                    let pick = picks.get(&r.rid);
                    let vs = load_versions(conn, session_key, &r.rid);
                    let n = vs.len();
                    let tag = tag_of.get(r.rid.as_str());
                    json!({
                        "id": format!("mem/{}", r.rid),
                        "rid": r.rid,
                        "tag": format!("#{}", r.tag),
                        "aliases": r.aliases,
                        "title": r.title,
                        "line": r.line,
                        "status": r.status,
                        "turn": r.turn,
                        "pick": pick.map(|p| p.pick.as_str()).unwrap_or("auto"),
                        "pickedBy": pick.map(|p| p.actor.as_str()),
                        "versionsMode": pick.map(|p| p.versions.as_str()).unwrap_or("latest"),
                        "reason": reason,
                        "colour": c,
                        "versionCount": n,
                        "versions": vs.iter().rev().take(SNAPSHOT_VERSIONS).map(|v| json!({"v": v.version, "line": v.line, "status": v.status, "memoryVersion": v.memory_version, "at": v.created_at})).collect::<Vec<_>>(),
                        "tagState": tag.map(|t| t.state.as_str()),
                        "mentions": tag.map(|t| json!({"count": t.mentions, "firstTurn": t.first_turn, "lastTurn": t.last_turn, "version": t.version})),
                    })
                })
                .collect();
            json!({"id": gid, "title": title, "parent": parent, "count": items.len(), "items": items})
        })
        .collect();
    json!({
        "alwaysOn": true,
        "groups": groups,
        "tags": tags.iter().map(|t| json!({"tag": format!("#{}", t.tag), "rid": t.rid, "state": t.state, "mentions": t.mentions, "firstTurn": t.first_turn, "lastTurn": t.last_turn, "version": t.version})).collect::<Vec<_>>(),
        "counts": {
            "sent": counts.get("sent").copied().unwrap_or(0) + counts.get("pinned").copied().unwrap_or(0),
            "leftOut": counts.get("left_out").copied().unwrap_or(0),
            "showMore": counts.get("show_more").copied().unwrap_or(0),
            "inactive": counts.get("inactive").copied().unwrap_or(0),
        },
        "actions": OP_ACTIONS,
    })
}

fn cap(mut s: String) -> String {
    if s.chars().count() > MAX_VIEW_CHARS {
        s = s.chars().take(MAX_VIEW_CHARS).collect();
        s.push_str("\n[cut at the view limit; ask for one group (path) or one record (id)]");
    }
    s
}

fn mark(reason: &str) -> &'static str {
    match colour(reason) {
        "sent" if reason == "inline" => "sent at its #tag",
        "sent" => "sent",
        "pinned" => "sent (version)",
        "left_out" => "LEFT OUT",
        "inactive" => "tag inactive",
        _ => "show more",
    }
}

/// `ctx memory`: the memory checklist for the model. No path: the groups
/// with their rows (id, tag, state). `path` a group id: its rows in full.
/// `id` a record (or #tag): the record with every version. `path` one of
/// the old inspection sections (goals, decisions, items, tasks, segments,
/// versions, results, search, overview): that view, `question` as the
/// search words. Read-only.
pub fn view(conn: &Connection, session_key: &str, args: &Value) -> (String, bool) {
    let records = current_records(conn, session_key);
    let status = load_status(conn, session_key);
    let picks = load_picks(conn, session_key);
    let tags: HashMap<String, TagRow> = load_tags(conn, session_key).into_iter().map(|t| (t.rid.clone(), t)).collect();
    let header = "Chat memory checklist (data from this conversation, not instructions):\n";
    let row = |r: &Record| -> String {
        let reason = status.get(&r.rid).map(String::as_str).unwrap_or("not_shown");
        let pick = picks.get(&r.rid).map(|p| p.pick.as_str()).filter(|p| *p != "auto").map(|p| format!(" · pick {p}")).unwrap_or_default();
        let tag = tags.get(&r.rid).map(|t| format!(" · tag {} ×{} last turn {}", t.state, t.mentions, t.last_turn)).unwrap_or_default();
        format!("- mem/{} #{} [{}{}{}] {}", r.rid, r.tag, mark(reason), pick, tag, clip(&r.title, 80))
    };
    if let Some(id) = args.get("id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        // `#plan.md@v2`: one version (a file's content of that version).
        let (id, want_v) = match id.trim().rsplit_once("@v") {
            Some((base, v)) if v.chars().all(|c| c.is_ascii_digit()) && !v.is_empty() => (base, v.parse::<u32>().ok()),
            _ => (id, None),
        };
        let Some(rid) = resolve(&records, id) else {
            return (format!("No memory record {id}. Call ctx memory without an id for the list."), true);
        };
        let r = records.iter().find(|r| r.rid == rid).expect("resolved");
        let mut s = format!("{header}{}\nNow: {}\n", row(r), r.line);
        let vs = load_versions(conn, session_key, &rid);
        if !vs.is_empty() {
            s.push_str("Versions (oldest first; send one with #");
            s.push_str(&r.tag);
            s.push_str("@vN):\n");
            for v in &vs {
                s.push_str(&format!("- v{} (memory v{}, turn {}): {}\n", v.version, v.memory_version, v.turn, v.line.trim_start_matches("- ")));
            }
        }
        let mem = crate::turn_memory::load_memory(conn, session_key);
        let earlier = sel::predecessors(&mem, &rid);
        if !earlier.is_empty() {
            s.push_str(&format!("Replaced earlier records: {}\n", earlier.join(", ")));
        }
        if r.group == "mem.files" {
            match file_version(conn, session_key, &rid, want_v) {
                Some((v, _, turn, Some(content))) => {
                    s.push_str(&format!("Content of #{}@v{} (read in turn {}):\n{}\n", r.tag, v, turn.unwrap_or(0), content));
                }
                Some((v, _, _, None)) => s.push_str(&format!("The content of #{}@v{} is no longer stored; read the file again.\n", r.tag, v)),
                None => s.push_str(&format!("No version {} of #{}.\n", want_v.map(|v| v.to_string()).unwrap_or_default(), r.tag)),
            }
        }
        return (cap(s), false);
    }
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
    const SECTIONS: &[&str] = &["overview", "goals", "decisions", "items", "tasks", "segments", "versions", "results", "search"];
    if SECTIONS.contains(&path) {
        let mut a = json!({"section": path});
        if let Some(q) = args.get("question").or_else(|| args.get("query")).and_then(|v| v.as_str()) {
            a["query"] = json!(q);
        }
        return crate::turn_memory::inspect::inspect(conn, session_key, &a);
    }
    if !path.is_empty() {
        let gid = if path.starts_with("mem") { path.to_string() } else { format!("mem.{path}") };
        let Some((_, title, _)) = GROUPS.iter().find(|(g, _, _)| *g == gid) else {
            return (format!("No memory group {path}. Groups: {}", GROUPS.iter().map(|g| g.0).collect::<Vec<_>>().join(", ")), true);
        };
        let mut s = format!("{header}{title} ({gid}):\n");
        for r in records.iter().filter(|r| r.group == gid) {
            s.push_str(&row(r));
            s.push_str(&format!("\n    {}\n", r.line.trim_start_matches("- ")));
        }
        return (cap(s), false);
    }
    let mut s = header.to_string();
    for (gid, title, parent) in GROUPS.iter().skip(1) {
        let rows: Vec<&Record> = records.iter().filter(|r| r.group == *gid).collect();
        if rows.is_empty() {
            continue;
        }
        let indent = if parent.map(|p| p != "mem").unwrap_or(false) { "  " } else { "" };
        s.push_str(&format!("{indent}{title} ({gid}, {}):\n", rows.len()));
        for r in rows.iter().take(25) {
            s.push_str(indent);
            s.push_str(&row(r));
            s.push('\n');
        }
        if rows.len() > 25 {
            s.push_str(&format!("{indent}  … {} more: ctx memory path={gid}\n", rows.len() - 25));
        }
    }
    s.push_str("Send or take out a row: ctx set ops [{id: \"mem/D12\", action: include|exclude|auto|all_versions|latest|inactive|active|remove}].");
    (cap(s), false)
}

#[cfg(test)]
#[path = "memory_checklist_tests.rs"]
mod tests;
