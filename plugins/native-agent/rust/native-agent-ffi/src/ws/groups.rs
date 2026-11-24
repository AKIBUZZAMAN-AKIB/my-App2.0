//! Groups (plan.md, Phase 3): a group chat of the user and at least three
//! sub-agents, possibly from different chats. Messages live in `ws_messages`
//! with `conversation = 'group:<id>'`; who is woken by each message is
//! decided by `group_rules::decide` and logged in `ws_group_dispatch`.
//!
//! This module only touches the database. Starting runs and delivering notes
//! is the bridge's job (`subagents/groups_bridge.rs`), which calls `post` and
//! then acts on the returned dispatch outside the transaction.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::envelope::{self, clip, Envelope, Party, Posted};
use super::group_rules::{self as rules, Dispatch, GroupInfo, GroupState, Incoming, Member, Presence, Rule};
use super::ids::new_id;
use super::registry::{self, Entry};
use super::now_ms;

/// Fewest live agent members a group needs.
pub const MIN_AGENTS: usize = 3;
/// Attention window after a wake (max) and after the member's last post.
pub const ENGAGED_MAX_MS: i64 = 15 * 60_000;
pub const ENGAGED_AFTER_POST_MS: i64 = 5 * 60_000;
/// Characters of unread context in a group note.
const NOTE_BUDGET: usize = 6_000;
/// Characters of shared items a group's prompt carries (Phase 5).
const CONTEXT_BUDGET: usize = 8_000;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    envelope::ensure_tables(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
            home_root TEXT,
            created_by TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'active',
            preset TEXT NOT NULL DEFAULT 'social',
            settings_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS ws_group_members (
            group_id TEXT NOT NULL, pid TEXT NOT NULL,
            role TEXT NOT NULL,
            membership TEXT NOT NULL DEFAULT 'joined',
            suspended_reason TEXT,
            engaged_until INTEGER,
            last_spoke_at INTEGER, last_woken_at INTEGER,
            can_post INTEGER NOT NULL DEFAULT 1, muted_until INTEGER,
            joined_at INTEGER NOT NULL, left_at INTEGER,
            PRIMARY KEY (group_id, pid, joined_at));
         CREATE TABLE IF NOT EXISTS ws_pins (group_id TEXT, message_id TEXT, pinned_by TEXT NOT NULL, pinned_at INTEGER NOT NULL, note TEXT,
            PRIMARY KEY (group_id, message_id));
         CREATE TABLE IF NOT EXISTS ws_group_rules (
            id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'group',
            kind TEXT NOT NULL,
            params_json TEXT NOT NULL DEFAULT '{}',
            priority INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS ws_group_rules_g ON ws_group_rules(group_id, enabled);
         CREATE TABLE IF NOT EXISTS ws_group_state (
            group_id TEXT PRIMARY KEY,
            unanswered INTEGER NOT NULL DEFAULT 0,
            last_message_at INTEGER, last_agent_reply_at INTEGER,
            chain_depth INTEGER NOT NULL DEFAULT 0,
            wakes_window_start INTEGER, wakes_in_window INTEGER NOT NULL DEFAULT 0,
            tokens_day TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
            rr_cursor TEXT);
         CREATE TABLE IF NOT EXISTS ws_group_dispatch (
            message_id TEXT NOT NULL, pid TEXT NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT NOT NULL,
            rule_id TEXT, est_tokens INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
            PRIMARY KEY (message_id, pid));",
    )
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// `write_tx` with this module's `String` errors.
fn tx<T>(conn: &Connection, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    struct TxErr(String);
    impl From<rusqlite::Error> for TxErr {
        fn from(e: rusqlite::Error) -> Self {
            TxErr(e.to_string())
        }
    }
    crate::turn_memory::store::write_tx(conn, |c| f(c).map_err(TxErr)).map_err(|e| e.0)
}

/// What the group code needs to know about one sub-agent (from its record).
#[derive(Debug, Clone, Default)]
pub struct AgentInfo {
    pub pid: String,
    pub name: String,
    pub title: Option<String>,
    pub status: String,
    pub paused: bool,
    pub shareable: bool,
    pub hidden: bool,
    pub hidden_from: Vec<String>,
    /// Root chat session key.
    pub root: String,
    pub avg_tokens: i64,
}

impl AgentInfo {
    /// From a serialized `SubagentRecord` (camelCase JSON).
    pub fn from_json(r: &Value) -> Option<Self> {
        let id = r["id"].as_str()?;
        let s = |k: &str| r[k].as_str().unwrap_or("").to_string();
        let runs = r["runs"].as_u64().unwrap_or(0).max(1) as i64;
        let tokens = r["inputTokens"].as_i64().unwrap_or(0) + r["outputTokens"].as_i64().unwrap_or(0);
        let root = Some(s("rootSessionKey")).filter(|x| !x.is_empty()).unwrap_or_else(|| s("parentSessionKey"));
        Some(AgentInfo {
            pid: format!("agent:{id}"),
            name: r["title"].as_str().filter(|t| !t.trim().is_empty()).map(str::to_string).unwrap_or_else(|| s("name")),
            title: r["title"].as_str().map(str::to_string),
            status: s("status"),
            paused: r["paused"].as_bool().unwrap_or(false),
            shareable: r["shareable"].as_bool().unwrap_or(false),
            hidden: r["hidden"].as_bool().unwrap_or(false),
            hidden_from: r["hiddenFrom"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            root,
            avg_tokens: if tokens > 0 { tokens / runs } else { 0 },
        })
    }

    pub fn short_name(&self) -> String {
        self.name.clone()
    }

    fn presence(&self) -> Presence {
        if self.paused {
            Presence::Paused
        } else if matches!(self.status.as_str(), "running" | "queued" | "waiting") {
            Presence::Active
        } else {
            Presence::Idle
        }
    }
}

/// Agent infos from a sub-agent state directory (registry.json).
pub fn agents_from_registry(state_dir: &std::path::Path) -> Vec<AgentInfo> {
    registry::read_registry(state_dir).iter().filter_map(AgentInfo::from_json).collect()
}

/// Why an agent may not be (or stay) a member of a group with `home_root`.
pub fn qualify(a: Option<&AgentInfo>, home_root: Option<&str>) -> Result<(), &'static str> {
    let Some(a) = a else { return Err("deleted_agent") };
    if a.hidden {
        return Err("hidden");
    }
    if let Some(h) = home_root {
        if a.hidden_from.iter().any(|x| x == h || x == &format!("session:{h}")) {
            return Err("hidden");
        }
    }
    let cross = home_root.is_none_or(|h| a.root != h);
    if cross && !a.shareable {
        return Err("not_shareable");
    }
    Ok(())
}

/// Why an agent cannot *join* a group (create, add member). A member that
/// later stops qualifying gets `reason_text` instead ("... any more").
pub fn join_reason_text(r: &str) -> &'static str {
    match r {
        "not_shareable" => "from another chat and not shareable",
        _ => reason_text(r),
    }
}

/// The chat every one of `pids` belongs to, when they all share one.
fn common_root(agents: &[AgentInfo], pids: &[String]) -> Option<String> {
    let mut roots = pids.iter().map(|p| find(agents, p).map(|a| a.root.clone()).unwrap_or_default());
    let first = roots.next()?;
    (!first.is_empty() && roots.all(|r| r == first)).then_some(first)
}

pub fn reason_text(r: &str) -> &'static str {
    match r {
        "not_shareable" => "not shareable any more",
        "hidden" => "hidden from this chat",
        "deleted_agent" => "the agent was deleted",
        _ => "no longer qualifies",
    }
}

fn find<'a>(agents: &'a [AgentInfo], pid: &str) -> Option<&'a AgentInfo> {
    agents.iter().find(|a| a.pid == pid)
}

fn group_row(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    ensure_tables(conn).map_err(e2s)?;
    conn.query_row("SELECT id, name, purpose, home_root, created_by, state, preset, settings_json, created_at, updated_at FROM ws_groups WHERE id = ?1", params![id], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "purpose": r.get::<_, String>(2)?,
            "homeRoot": r.get::<_, Option<String>>(3)?, "createdBy": r.get::<_, String>(4)?, "state": r.get::<_, String>(5)?,
            "preset": r.get::<_, String>(6)?, "presetLabel": rules::preset_label(&r.get::<_, String>(6)?),
            "settings": serde_json::from_str::<Value>(&r.get::<_, String>(7)?).unwrap_or(json!({})),
            "createdAt": r.get::<_, i64>(8)?, "updatedAt": r.get::<_, i64>(9)?,
        }))
    })
    .optional()
    .map_err(e2s)
}

fn require(conn: &Connection, id: &str) -> Result<Value, String> {
    let id = id.strip_prefix("group:").unwrap_or(id);
    match group_row(conn, id)? {
        Some(g) if g["state"] != "deleted" => Ok(g),
        _ => Err(format!("No group {id}.")),
    }
}

/// A group id from `#name`, `group:<id>` or the bare id.
pub fn resolve(conn: &Connection, r: &str) -> Result<String, String> {
    ensure_tables(conn).map_err(e2s)?;
    let r = r.trim();
    let bare = r.strip_prefix("group:").unwrap_or(r);
    if group_row(conn, bare)?.is_some() {
        return Ok(bare.to_string());
    }
    let name = r.trim_start_matches('#');
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM ws_groups WHERE lower(name) = lower(?1) AND state NOT IN ('deleted', 'trashed')")
        .map_err(e2s)?
        .query_map(params![name], |x| x.get(0))
        .map_err(e2s)?
        .collect::<Result<_, _>>()
        .map_err(e2s)?;
    match ids.len() {
        1 => Ok(ids[0].clone()),
        0 => Err(format!("No group {r}.")),
        _ => Err(format!("Two groups are called {name}; use the group id.")),
    }
}

#[derive(Debug, Clone)]
struct MemberRow {
    pid: String,
    role: String,
    membership: String,
    suspended_reason: Option<String>,
    engaged_until: Option<i64>,
    last_spoke_at: Option<i64>,
    last_woken_at: Option<i64>,
    can_post: bool,
    muted_until: Option<i64>,
    joined_at: i64,
}

fn member_rows(conn: &Connection, gid: &str, include_left: bool) -> Result<Vec<MemberRow>, String> {
    let mut st = conn
        .prepare(
            "SELECT pid, role, membership, suspended_reason, engaged_until, last_spoke_at, last_woken_at, can_post, muted_until, joined_at
             FROM ws_group_members WHERE group_id = ?1 AND (?2 OR membership <> 'left') ORDER BY joined_at, pid",
        )
        .map_err(e2s)?;
    let rows = st
        .query_map(params![gid, include_left], |r| {
            Ok(MemberRow {
                pid: r.get(0)?,
                role: r.get(1)?,
                membership: r.get(2)?,
                suspended_reason: r.get(3)?,
                engaged_until: r.get(4)?,
                last_spoke_at: r.get(5)?,
                last_woken_at: r.get(6)?,
                can_post: r.get::<_, i64>(7)? != 0,
                muted_until: r.get(8)?,
                joined_at: r.get(9)?,
            })
        })
        .map_err(e2s)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e2s)?;
    Ok(rows)
}

pub fn load_rules(conn: &Connection, gid: &str) -> Result<Vec<Rule>, String> {
    let mut st = conn.prepare("SELECT id, scope, kind, params_json, priority, enabled FROM ws_group_rules WHERE group_id = ?1 ORDER BY created_at, id").map_err(e2s)?;
    let rows = st
        .query_map(params![gid], |r| {
            Ok(Rule {
                id: r.get(0)?,
                scope: r.get(1)?,
                kind: r.get(2)?,
                params: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(json!({})),
                priority: r.get(4)?,
                enabled: r.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(e2s)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e2s)?;
    Ok(rows)
}

fn rule_json(r: &Rule) -> Value {
    json!({ "id": r.id, "scope": r.scope, "kind": r.kind, "params": r.params, "priority": r.priority, "enabled": r.enabled })
}

pub fn load_state(conn: &Connection, gid: &str) -> Result<GroupState, String> {
    let st = conn
        .query_row(
            "SELECT unanswered, last_message_at, last_agent_reply_at, chain_depth, wakes_window_start, wakes_in_window, tokens_day, tokens_used, rr_cursor FROM ws_group_state WHERE group_id = ?1",
            params![gid],
            |r| {
                Ok(GroupState {
                    unanswered: r.get(0)?,
                    last_message_at: r.get(1)?,
                    last_agent_reply_at: r.get(2)?,
                    chain_depth: r.get(3)?,
                    wakes_window_start: r.get(4)?,
                    wakes_in_window: r.get(5)?,
                    tokens_day: r.get(6)?,
                    tokens_used: r.get(7)?,
                    rr_cursor: r.get(8)?,
                })
            },
        )
        .optional()
        .map_err(e2s)?;
    Ok(st.unwrap_or_default())
}

fn state_json(s: &GroupState) -> Value {
    json!({ "unanswered": s.unanswered, "lastMessageAt": s.last_message_at, "lastAgentReplyAt": s.last_agent_reply_at, "chainDepth": s.chain_depth,
            "wakesInWindow": s.wakes_in_window, "tokensDay": s.tokens_day, "tokensUsed": s.tokens_used, "rrCursor": s.rr_cursor })
}

/// Today as `YYYY-MM-DD` (UTC) for the daily budget.
pub fn day_of(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// Group messages since `since` (exclusive), for a member's count.
fn count_since(conn: &Connection, gid: &str, since: Option<i64>) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM ws_messages WHERE conversation = ?1 AND kind <> 'system' AND created_at > ?2",
        params![format!("group:{gid}"), since.unwrap_or(0)],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// The members as the rules engine sees them. `pending` = pids with a
/// group wake already running or queued (coalescing).
pub fn members_for_rules(conn: &Connection, gid: &str, agents: &[AgentInfo], pending: &[String]) -> Result<Vec<Member>, String> {
    let mut out = Vec::new();
    for r in member_rows(conn, gid, false)? {
        if !r.pid.starts_with("agent:") {
            continue;
        }
        let a = find(agents, &r.pid);
        let presence = if r.membership == "suspended" {
            Presence::Suspended
        } else {
            a.map_or(Presence::Gone, |a| a.presence())
        };
        out.push(Member {
            pid: r.pid.clone(),
            name: a.map(|a| a.name.clone()).unwrap_or_else(|| super::principals::display_name(conn, &r.pid)),
            role: r.role,
            membership: r.membership,
            suspended_reason: r.suspended_reason,
            presence,
            can_post: r.can_post,
            muted_until: r.muted_until,
            last_spoke_at: r.last_spoke_at,
            last_woken_at: r.last_woken_at,
            engaged_until: r.engaged_until,
            pending_group_wake: pending.contains(&r.pid),
            since_spoke: count_since(conn, gid, r.last_spoke_at.or(Some(r.joined_at))),
            avg_tokens: a.map_or(0, |a| a.avg_tokens),
        });
    }
    Ok(out)
}

fn system_message(conn: &Connection, gid: &str, text: &str) -> Result<Posted, String> {
    let env = Envelope::new(format!("group:{gid}"), Party::new("user", "You"), vec![]).kind("system");
    envelope::post(conn, &env, text, &[])
}

fn add_member_row(conn: &Connection, gid: &str, pid: &str, role: &str, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO ws_group_members (group_id, pid, role, membership, joined_at) VALUES (?1, ?2, ?3, 'joined', ?4)", params![gid, pid, role, now]).map_err(e2s)?;
    Ok(())
}

fn insert_rules(conn: &Connection, gid: &str, preset: &str, now: i64) -> Result<(), String> {
    for (kind, p) in rules::preset_rules(preset) {
        conn.execute(
            "INSERT INTO ws_group_rules (id, group_id, scope, kind, params_json, priority, enabled, created_at, updated_at) VALUES (?1, ?2, 'group', ?3, ?4, 0, 1, ?5, ?5)",
            params![new_id("r"), gid, kind, p.to_string(), now],
        )
        .map_err(e2s)?;
    }
    Ok(())
}

/// `create {name, purpose, members[], preset?, homeRoot?}`.
pub fn create(conn: &Connection, req: &Value, agents: &[AgentInfo]) -> Result<Value, String> {
    ensure_tables(conn).map_err(e2s)?;
    let name = req["name"].as_str().unwrap_or("").trim().trim_start_matches('#').to_string();
    if name.is_empty() {
        return Err("A group needs a name.".into());
    }
    let purpose = req["purpose"].as_str().unwrap_or("").trim().to_string();
    let preset = req["preset"].as_str().filter(|p| rules::PRESETS.contains(p)).unwrap_or("social").to_string();
    let home = req["homeRoot"].as_str().filter(|h| !h.is_empty()).map(|h| h.strip_prefix("session:").unwrap_or(h).to_string());
    let mut pids: Vec<String> = Vec::new();
    for m in req["members"].as_array().cloned().unwrap_or_default() {
        let Some(raw) = m.as_str() else { continue };
        let pid = if raw.starts_with("agent:") { raw.to_string() } else { format!("agent:{raw}") };
        if !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    if pids.len() < MIN_AGENTS {
        return Err(format!("A group needs at least {MIN_AGENTS} agents; you picked {}.", pids.len()));
    }
    // No home given (an older app, another caller): when every member is
    // from one chat, that chat is the home; "cross-chat" would be wrong.
    let home = home.or_else(|| common_root(agents, &pids));
    for p in &pids {
        let a = find(agents, p);
        if let Err(r) = qualify(a, home.as_deref()) {
            let n = a.map(|a| a.name.clone()).unwrap_or_else(|| p.clone());
            return Err(format!("{n} cannot join: {}.", join_reason_text(r)));
        }
    }
    let gid = new_id("g");
    let now = now_ms();
    tx(conn, |c| -> Result<(), String> {
        c.execute(
            "INSERT INTO ws_groups (id, name, purpose, home_root, created_by, state, preset, settings_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'user', 'active', ?5, ?6, ?7, ?7)",
            params![gid, name, purpose, home, preset, json!({"confirmAgents": 4, "confirmTokens": 20_000, "ownMemory": true, "notify": "all"}).to_string(), now],
        )
        .map_err(e2s)?;
        c.execute("INSERT INTO ws_group_state (group_id) VALUES (?1)", params![gid]).map_err(e2s)?;
        add_member_row(c, &gid, "user", "owner", now)?;
        for p in &pids {
            add_member_row(c, &gid, p, "member", now)?;
            if let Some(a) = find(agents, p) {
                super::principals::upsert(c, p, "agent", &a.name, None, "active").map_err(e2s)?;
            }
        }
        insert_rules(c, &gid, &preset, now)?;
        super::principals::upsert(c, &format!("group:{gid}"), "group", &name, None, "active").map_err(e2s)?;
        let mut e = Entry::new("group", format!("db:ws_groups/{gid}"), "user".into(), format!("#{name}"));
        e.scope = Some(format!("group:{gid}"));
        e.meta = json!({ "groupId": gid, "members": pids, "homeRoot": home });
        e.created_at = now;
        registry::touch(c, &e).map_err(e2s)?;
        let names: Vec<String> = pids.iter().map(|p| find(agents, p).map(|a| a.name.clone()).unwrap_or_else(|| p.clone())).collect();
        system_message(c, &gid, &format!("You created #{name} with {}.", names.join(", ")))?;
        Ok(())
    })?;
    get(conn, &gid, agents)
}

/// One group with members (presence), rules, state and pins.
pub fn get(conn: &Connection, gid: &str, agents: &[AgentInfo]) -> Result<Value, String> {
    let g = require(conn, gid)?;
    let gid = g["id"].as_str().unwrap_or("").to_string();
    let now = now_ms();
    let rules_list = load_rules(conn, &gid)?;
    let members: Vec<Value> = member_rows(conn, &gid, true)?
        .into_iter()
        .map(|r| {
            let a = find(agents, &r.pid);
            let presence = if r.pid == "user" {
                "owner".to_string()
            } else if r.membership == "left" {
                "left".into()
            } else if r.membership == "suspended" {
                "suspended".into()
            } else {
                a.map_or("gone", |a| a.presence().as_str()).to_string()
            };
            let applies: Vec<Value> = rules_list.iter().filter(|x| x.enabled && (x.scope == r.pid || x.scope == "group")).map(|x| json!(x.kind)).collect();
            json!({
                "pid": r.pid,
                "name": if r.pid == "user" { "You".to_string() } else { a.map(|a| a.name.clone()).unwrap_or_else(|| super::principals::display_name(conn, &r.pid)) },
                "role": r.role, "membership": r.membership, "suspendedReason": r.suspended_reason,
                "suspendedText": r.suspended_reason.as_deref().map(reason_text),
                "presence": presence,
                "engaged": r.engaged_until.is_some_and(|t| t > now),
                "lastSpokeAt": r.last_spoke_at, "lastWokenAt": r.last_woken_at,
                "canPost": r.can_post, "mutedUntil": r.muted_until, "joinedAt": r.joined_at,
                "crossChat": a.is_some_and(|a| g["homeRoot"].as_str().is_none_or(|h| a.root != h)),
                "rules": applies,
            })
        })
        .collect();
    let state = load_state(conn, &gid)?;
    Ok(json!({
        "group": g,
        "members": members,
        "rules": rules_list.iter().map(rule_json).collect::<Vec<_>>(),
        "state": state_json(&state),
        "pins": pins(conn, &gid)?,
        "tokensToday": if state.tokens_day.as_deref() == Some(day_of(now).as_str()) { state.tokens_used } else { 0 },
        "silence": silence(conn, &gid, now)?,
    }))
}

/// Every group (not deleted), with member count, unread and presence. With
/// `member`, only the groups that pid is a joined or suspended member of.
pub fn list(conn: &Connection, member: Option<&str>, agents: &[AgentInfo]) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM ws_groups WHERE state <> 'deleted' ORDER BY updated_at DESC")
        .map_err(e2s)?
        .query_map([], |r| r.get(0))
        .map_err(e2s)?
        .collect::<Result<_, _>>()
        .map_err(e2s)?;
    let viewer = member.unwrap_or("user");
    let mut out = Vec::new();
    for id in ids {
        let rows = member_rows(conn, &id, false)?;
        if let Some(m) = member {
            if !rows.iter().any(|r| r.pid == m) {
                continue;
            }
        }
        let g = group_row(conn, &id)?.unwrap_or(json!({}));
        let presence: Vec<Value> = rows
            .iter()
            .filter(|r| r.pid.starts_with("agent:"))
            .map(|r| {
                let p = if r.membership == "suspended" { "suspended" } else { find(agents, &r.pid).map_or("gone", |a| a.presence().as_str()) };
                json!({ "pid": r.pid, "presence": p })
            })
            .collect();
        let conv = format!("group:{id}");
        let last_read: Option<String> = conn.query_row("SELECT last_read FROM ws_cursors WHERE pid = ?1 AND conversation = ?2", params![viewer, conv], |r| r.get(0)).optional().map_err(e2s)?.flatten();
        let read_at: i64 = match &last_read {
            Some(m) => conn.query_row("SELECT created_at FROM ws_messages WHERE id = ?1", params![m], |r| r.get(0)).optional().map_err(e2s)?.unwrap_or(0),
            None => 0,
        };
        let unread: i64 = conn
            .query_row("SELECT COUNT(*) FROM ws_messages WHERE conversation = ?1 AND from_pid <> ?2 AND created_at > ?3 AND state = 'sent'", params![conv, viewer, read_at], |r| r.get(0))
            .map_err(e2s)?;
        out.push(json!({
            "id": id, "name": g["name"], "purpose": g["purpose"], "state": g["state"], "preset": g["preset"], "presetLabel": g["presetLabel"],
            "members": presence.len(), "presence": presence, "unread": unread,
            "suspended": rows.iter().filter(|r| r.membership == "suspended").count(),
            "pausedReason": g["settings"]["pausedReason"],
        }));
    }
    Ok(out)
}

fn touch_group(conn: &Connection, gid: &str) -> Result<(), String> {
    conn.execute("UPDATE ws_groups SET updated_at = ?2 WHERE id = ?1", params![gid, now_ms()]).map_err(e2s)?;
    Ok(())
}

fn set_setting(conn: &Connection, gid: &str, key: &str, v: Value) -> Result<(), String> {
    let raw: String = conn.query_row("SELECT settings_json FROM ws_groups WHERE id = ?1", params![gid], |r| r.get(0)).map_err(e2s)?;
    let mut s: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    if v.is_null() {
        if let Some(o) = s.as_object_mut() {
            o.remove(key);
        }
    } else {
        s[key] = v;
    }
    conn.execute("UPDATE ws_groups SET settings_json = ?2, updated_at = ?3 WHERE id = ?1", params![gid, s.to_string(), now_ms()]).map_err(e2s)?;
    Ok(())
}

/// Pause a group whose live agents dropped below three; resume it (only a
/// pause made for that reason) when there are three again.
fn recheck_live_count(conn: &Connection, gid: &str) -> Result<(), String> {
    let g = require(conn, gid)?;
    let live = member_rows(conn, gid, false)?.iter().filter(|r| r.pid.starts_with("agent:") && r.membership == "joined").count();
    let state = g["state"].as_str().unwrap_or("");
    if live < MIN_AGENTS && state == "active" {
        conn.execute("UPDATE ws_groups SET state = 'paused' WHERE id = ?1", params![gid]).map_err(e2s)?;
        set_setting(conn, gid, "pausedReason", json!("below_three"))?;
        system_message(conn, gid, &format!("#{} is paused: it has {live} active agents and needs {MIN_AGENTS}. Add a member or archive it.", g["name"].as_str().unwrap_or("")))?;
    } else if live >= MIN_AGENTS && state == "paused" && g["settings"]["pausedReason"] == "below_three" {
        conn.execute("UPDATE ws_groups SET state = 'active' WHERE id = ?1", params![gid]).map_err(e2s)?;
        set_setting(conn, gid, "pausedReason", Value::Null)?;
        system_message(conn, gid, &format!("#{} is active again.", g["name"].as_str().unwrap_or("")))?;
    }
    Ok(())
}

/// Suspend or restore `pid` in every group, after its record changed
/// (shareable, hidden, deleted). Returns the groups that changed.
pub fn recheck_member(conn: &Connection, pid: &str, agents: &[AgentInfo]) -> Result<Vec<String>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let rows: Vec<(String, String, Option<String>, i64)> = conn
        .prepare("SELECT m.group_id, m.membership, g.home_root, m.joined_at FROM ws_group_members m JOIN ws_groups g ON g.id = m.group_id WHERE m.pid = ?1 AND m.membership <> 'left' AND g.state <> 'deleted'")
        .map_err(e2s)?
        .query_map(params![pid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(e2s)?
        .collect::<Result<_, _>>()
        .map_err(e2s)?;
    let a = find(agents, pid);
    let name = a.map(|a| a.name.clone()).unwrap_or_else(|| super::principals::display_name(conn, pid));
    let mut changed = Vec::new();
    for (gid, membership, home, joined) in rows {
        match qualify(a, home.as_deref()) {
            Err(reason) if membership == "joined" => {
                conn.execute("UPDATE ws_group_members SET membership = 'suspended', suspended_reason = ?4, engaged_until = NULL WHERE group_id = ?1 AND pid = ?2 AND joined_at = ?3", params![gid, pid, joined, reason])
                    .map_err(e2s)?;
                system_message(conn, &gid, &format!("{name} is suspended: {}.", reason_text(reason)))?;
                recheck_live_count(conn, &gid)?;
                changed.push(gid);
            }
            Err(reason) => {
                conn.execute("UPDATE ws_group_members SET suspended_reason = ?4 WHERE group_id = ?1 AND pid = ?2 AND joined_at = ?3", params![gid, pid, joined, reason]).map_err(e2s)?;
            }
            Ok(()) if membership == "suspended" => {
                conn.execute("UPDATE ws_group_members SET membership = 'joined', suspended_reason = NULL WHERE group_id = ?1 AND pid = ?2 AND joined_at = ?3", params![gid, pid, joined]).map_err(e2s)?;
                system_message(conn, &gid, &format!("{name} is back."))?;
                recheck_live_count(conn, &gid)?;
                changed.push(gid);
            }
            Ok(()) => {}
        }
    }
    Ok(changed)
}

/// `members.add {group, pid, role?}`: never starts a run.
pub fn add_member(conn: &Connection, gid: &str, pid: &str, role: Option<&str>, agents: &[AgentInfo]) -> Result<Value, String> {
    let g = require(conn, gid)?;
    let gid = g["id"].as_str().unwrap_or("").to_string();
    let pid = if pid.starts_with("agent:") { pid.to_string() } else { format!("agent:{pid}") };
    let a = find(agents, &pid);
    if let Err(r) = qualify(a, g["homeRoot"].as_str()) {
        return Err(format!("{} cannot join: {}.", a.map(|a| a.name.clone()).unwrap_or(pid.clone()), join_reason_text(r)));
    }
    if member_rows(conn, &gid, false)?.iter().any(|r| r.pid == pid) {
        return Err("Already a member.".into());
    }
    let role = role.filter(|r| matches!(*r, "admin" | "member" | "observer")).unwrap_or("member");
    add_member_row(conn, &gid, &pid, role, now_ms())?;
    if let Some(a) = a {
        super::principals::upsert(conn, &pid, "agent", &a.name, None, "active").map_err(e2s)?;
    }
    if role == "observer" {
        conn.execute("UPDATE ws_group_members SET can_post = 0 WHERE group_id = ?1 AND pid = ?2 AND membership = 'joined'", params![gid, pid]).map_err(e2s)?;
    }
    // Rules disabled because this member had left come back.
    reenable_rules_for(conn, &gid, &pid)?;
    system_message(conn, &gid, &format!("{} was added.", a.map(|a| a.name.clone()).unwrap_or(pid.clone())))?;
    recheck_live_count(conn, &gid)?;
    touch_group(conn, &gid)?;
    get(conn, &gid, agents)
}

fn reenable_rules_for(conn: &Connection, gid: &str, pid: &str) -> Result<(), String> {
    for r in load_rules(conn, gid)?.into_iter().filter(|r| !r.enabled && r.params.get("disabledFor").and_then(Value::as_str) == Some(pid)) {
        let mut p = r.params.clone();
        if let Some(o) = p.as_object_mut() {
            o.remove("disabledReason");
            o.remove("disabledFor");
        }
        conn.execute("UPDATE ws_group_rules SET enabled = 1, params_json = ?2 WHERE id = ?1", params![r.id, p.to_string()]).map_err(e2s)?;
    }
    Ok(())
}

/// `members.remove`: the member leaves; its messages keep their sender, and
/// rules that name it are disabled with a reason (not deleted).
pub fn remove_member(conn: &Connection, gid: &str, pid: &str, agents: &[AgentInfo]) -> Result<Value, String> {
    let g = require(conn, gid)?;
    let gid = g["id"].as_str().unwrap_or("").to_string();
    if pid == "user" {
        return Err("The owner cannot leave; archive or delete the group.".into());
    }
    let now = now_ms();
    let n = conn
        .execute("UPDATE ws_group_members SET membership = 'left', left_at = ?3, engaged_until = NULL WHERE group_id = ?1 AND pid = ?2 AND membership <> 'left'", params![gid, pid, now])
        .map_err(e2s)?;
    if n == 0 {
        return Err("Not a member.".into());
    }
    let name = find(agents, pid).map(|a| a.name.clone()).unwrap_or_else(|| super::principals::display_name(conn, pid));
    for r in load_rules(conn, &gid)? {
        let names_it = r.scope == pid || r.params.get("members").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x == pid)) || r.params.get("wake").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x == pid));
        if names_it && r.enabled {
            let mut p = r.params.clone();
            p["disabledReason"] = json!(format!("{name} left the group"));
            p["disabledFor"] = json!(pid);
            conn.execute("UPDATE ws_group_rules SET enabled = 0, params_json = ?2, updated_at = ?3 WHERE id = ?1", params![r.id, p.to_string(), now]).map_err(e2s)?;
        }
    }
    system_message(conn, &gid, &format!("{name} left."))?;
    recheck_live_count(conn, &gid)?;
    get(conn, &gid, agents)
}

/// `members.role` / `members.mute`.
pub fn set_member(conn: &Connection, gid: &str, pid: &str, role: Option<&str>, muted_until: Option<Option<i64>>) -> Result<(), String> {
    let gid = require(conn, gid)?["id"].as_str().unwrap_or("").to_string();
    if let Some(role) = role {
        if !matches!(role, "admin" | "member" | "observer") || pid == "user" {
            return Err("Role must be admin, member or observer.".into());
        }
        conn.execute("UPDATE ws_group_members SET role = ?3, can_post = ?4 WHERE group_id = ?1 AND pid = ?2 AND membership <> 'left'", params![gid, pid, role, (role != "observer") as i64]).map_err(e2s)?;
    }
    if let Some(m) = muted_until {
        conn.execute("UPDATE ws_group_members SET muted_until = ?3 WHERE group_id = ?1 AND pid = ?2 AND membership <> 'left'", params![gid, pid, m]).map_err(e2s)?;
    }
    touch_group(conn, &gid)
}

/// `rename`, `purpose`, `archive`, `unarchive`, `pause`, `resume`, `delete`, `restore`.
pub fn set_group(conn: &Connection, gid: &str, op: &str, value: &str) -> Result<(), String> {
    let g = require(conn, gid)?;
    let gid = g["id"].as_str().unwrap_or("").to_string();
    let now = now_ms();
    match op {
        "rename" => {
            let v = value.trim().trim_start_matches('#');
            if v.is_empty() {
                return Err("A group needs a name.".into());
            }
            conn.execute("UPDATE ws_groups SET name = ?2, updated_at = ?3 WHERE id = ?1", params![gid, v, now]).map_err(e2s)?;
            super::principals::upsert(conn, &format!("group:{gid}"), "group", v, None, "active").map_err(e2s)?;
            conn.execute("UPDATE ws_items SET title = ?2 WHERE loc = ?1", params![format!("db:ws_groups/{gid}"), format!("#{v}")]).map_err(e2s)?;
            system_message(conn, &gid, &format!("You renamed the group to #{v}."))?;
        }
        "purpose" => {
            conn.execute("UPDATE ws_groups SET purpose = ?2, updated_at = ?3 WHERE id = ?1", params![gid, value.trim(), now]).map_err(e2s)?;
        }
        "archive" | "pause" | "delete" => {
            let st = match op {
                "archive" => "archived",
                "pause" => "paused",
                _ => "trashed",
            };
            conn.execute("UPDATE ws_groups SET state = ?2, updated_at = ?3 WHERE id = ?1", params![gid, st, now]).map_err(e2s)?;
            set_setting(conn, &gid, "pausedReason", if op == "pause" { json!("user") } else { Value::Null })?;
            if op == "delete" {
                set_setting(conn, &gid, "trashedAt", json!(now))?;
                conn.execute("UPDATE ws_items SET state = 'trashed' WHERE loc = ?1", params![format!("db:ws_groups/{gid}")]).map_err(e2s)?;
            }
        }
        "unarchive" | "resume" | "restore" => {
            conn.execute("UPDATE ws_groups SET state = 'active', updated_at = ?2 WHERE id = ?1", params![gid, now]).map_err(e2s)?;
            set_setting(conn, &gid, "pausedReason", Value::Null)?;
            set_setting(conn, &gid, "trashedAt", Value::Null)?;
            conn.execute("UPDATE ws_items SET state = 'live' WHERE loc = ?1 AND state = 'trashed'", params![format!("db:ws_groups/{gid}")]).map_err(e2s)?;
            recheck_live_count(conn, &gid)?;
        }
        other => return Err(format!("Unknown group change {other}.")),
    }
    Ok(())
}

/// `settings {group, settings}`: merge keys into the group settings.
pub fn set_settings(conn: &Connection, gid: &str, patch: &Value) -> Result<(), String> {
    let gid = require(conn, gid)?["id"].as_str().unwrap_or("").to_string();
    if let Some(o) = patch.as_object() {
        for (k, v) in o {
            if k == "aiContext" && !matches!(v.as_str(), Some("user") | Some("model")) && !v.is_null() {
                return Err("aiContext is user or model.".into());
            }
            if matches!(k.as_str(), "confirmAgents" | "confirmTokens" | "ownMemory" | "notify" | "memorySearch" | "aiContext") {
                set_setting(conn, &gid, k, v.clone())?;
                if k == "aiContext" {
                    audit_rules(conn, &gid, "settings.aiContext", json!({ "aiContext": v }));
                }
            }
        }
    }
    Ok(())
}

/// Who decides what a group's AI uses: `user` (default) or `model`.
/// Members' notes (plan.md 3.6): what each member remembered while working
/// in this group, i.e. the entries of its own memory file whose category is
/// `group:<gid>`. Read where they live; nothing is merged into a group
/// memory. Members without notes are left out; left members keep theirs.
pub fn member_notes(conn: &Connection, src: &registry::Sources, gid: &str) -> Result<Vec<Value>, String> {
    let scope = format!("group:{gid}");
    let mut out = Vec::new();
    for m in member_rows(conn, gid, true)? {
        if !m.pid.starts_with("agent:") {
            continue;
        }
        let mut items = registry::query(conn, "owner = ?1 AND scope = ?2 AND kind = 'agent_memory' AND state = 'live'", &[&m.pid, &scope]).map_err(e2s)?;
        if items.is_empty() {
            continue;
        }
        items.sort_by_key(|it| std::cmp::Reverse(it["updatedAt"].as_i64().unwrap_or(0)));
        let notes: Vec<Value> = items
            .iter()
            .map(|it| {
                let id = it["id"].as_str().unwrap_or("");
                let text = registry::read(conn, src, id, Some(&json!({ "limit": 2000 })))
                    .ok()
                    .and_then(|v| v["text"].as_str().or(v["content"]["text"].as_str()).map(str::to_string))
                    .unwrap_or_default();
                json!({ "id": id, "key": it["title"], "text": text, "updatedAt": it["updatedAt"] })
            })
            .collect();
        out.push(json!({ "pid": m.pid, "name": super::principals::display_name(conn, &m.pid), "left": m.membership == "left", "notes": notes }));
    }
    Ok(out)
}

pub fn ai_context_policy(conn: &Connection, gid: &str) -> String {
    let raw: String = conn.query_row("SELECT settings_json FROM ws_groups WHERE id = ?1", params![gid], |r| r.get(0)).unwrap_or_default();
    serde_json::from_str::<Value>(&raw).ok().and_then(|v| v["aiContext"].as_str().map(str::to_string)).filter(|p| p == "model").unwrap_or_else(|| "user".into())
}

/// `rules.set {group, rules[]}` (validated) or `rules.preset {group, preset}`.
pub fn save_rules(conn: &Connection, gid: &str, list: &[Value], names: &dyn Fn(&str) -> String) -> Result<Value, String> {
    let gid = require(conn, gid)?["id"].as_str().unwrap_or("").to_string();
    let parsed: Vec<Rule> = list
        .iter()
        .map(|r| Rule {
            id: r["id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| new_id("r")),
            scope: r["scope"].as_str().unwrap_or("group").to_string(),
            kind: r["kind"].as_str().unwrap_or("").to_string(),
            params: r.get("params").cloned().unwrap_or(json!({})),
            priority: r["priority"].as_i64().unwrap_or(0),
            enabled: r["enabled"].as_bool().unwrap_or(true),
        })
        .collect();
    let pids: Vec<String> = member_rows(conn, &gid, false)?.into_iter().map(|r| r.pid).collect();
    let v = rules::validate(&parsed, &pids, names);
    if v["ok"] != true {
        return Ok(json!({ "saved": false, "validation": v }));
    }
    let now = now_ms();
    tx(conn, |c| -> Result<(), String> {
        c.execute("DELETE FROM ws_group_rules WHERE group_id = ?1", params![gid]).map_err(e2s)?;
        // The editor's order is kept: rules load by created_at.
        for (i, r) in parsed.iter().enumerate() {
            c.execute(
                "INSERT INTO ws_group_rules (id, group_id, scope, kind, params_json, priority, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![r.id, gid, r.scope, r.kind, r.params.to_string(), r.priority, r.enabled as i64, now + i as i64, now],
            )
            .map_err(e2s)?;
        }
        c.execute("UPDATE ws_groups SET preset = 'custom', updated_at = ?2 WHERE id = ?1", params![gid, now]).map_err(e2s)?;
        Ok(())
    })?;
    audit_rules(conn, &gid, "rules.set", json!({ "rules": parsed.iter().map(rule_json).collect::<Vec<_>>(), "warnings": v["warnings"] }));
    Ok(json!({ "saved": true, "validation": v, "rules": load_rules(conn, &gid)?.iter().map(rule_json).collect::<Vec<_>>() }))
}

pub fn apply_preset(conn: &Connection, gid: &str, preset: &str) -> Result<(), String> {
    if !rules::PRESETS.contains(&preset) {
        return Err(format!("Unknown preset {preset}."));
    }
    let gid = require(conn, gid)?["id"].as_str().unwrap_or("").to_string();
    let now = now_ms();
    tx(conn, |c| -> Result<(), String> {
        c.execute("DELETE FROM ws_group_rules WHERE group_id = ?1", params![gid]).map_err(e2s)?;
        insert_rules(c, &gid, preset, now)?;
        c.execute("UPDATE ws_groups SET preset = ?2, updated_at = ?3 WHERE id = ?1", params![gid, preset, now]).map_err(e2s)?;
        Ok(())
    })?;
    audit_rules(conn, &gid, "rules.preset", json!({ "preset": preset }));
    Ok(())
}

/// Rule changes go to `ws_audit` under the group, for the editor's history.
fn audit_rules(conn: &Connection, gid: &str, action: &str, detail: Value) {
    let _ = super::refs::ensure_tables(conn);
    super::refs::audit(conn, "user", action, None, Some(&format!("group:{gid}")), detail);
}

/// The group's rule and AI-context changes, newest first.
pub fn rules_history(conn: &Connection, gid: &str, limit: usize) -> Result<Vec<Value>, String> {
    let gid = require(conn, gid)?["id"].as_str().unwrap_or("").to_string();
    super::refs::ensure_tables(conn).map_err(e2s)?;
    let mut st = conn
        .prepare("SELECT at, actor, action, detail_json FROM ws_audit WHERE holder = ?1 AND (action LIKE 'rules.%' OR action = 'settings.aiContext') ORDER BY id DESC LIMIT ?2")
        .map_err(e2s)?;
    let rows = st
        .query_map(params![format!("group:{gid}"), limit as i64], |r| {
            Ok(json!({ "at": r.get::<_, i64>(0)?, "actor": r.get::<_, String>(1)?, "action": r.get::<_, String>(2)?, "detail": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(json!({})) }))
        })
        .map_err(e2s)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e2s)?;
    Ok(rows)
}

/// A post to make: who, what, threading.
pub struct PostReq<'a> {
    pub from: Party,
    pub text: &'a str,
    pub reply_to: Option<String>,
    pub to: Vec<String>,
    pub attachments: Vec<Value>,
    /// The sender's chat paused agent messages (agents only).
    pub comms_paused: bool,
    /// Members with a group wake already running or queued.
    pub pending: Vec<String>,
}

pub struct PostOutcome {
    pub posted: Posted,
    pub dispatch: Dispatch,
    pub group_name: String,
}

struct Prepared {
    gid: String,
    name: String,
    env: Envelope,
    info: GroupInfo,
    incoming: Incoming,
    members: Vec<Member>,
    rules: Vec<Rule>,
    state: GroupState,
}

fn prepare(conn: &Connection, gid: &str, req: &PostReq, agents: &[AgentInfo], now: i64) -> Result<Prepared, String> {
    let g = require(conn, gid)?;
    let gid = g["id"].as_str().unwrap_or("").to_string();
    let state_s = g["state"].as_str().unwrap_or("");
    if matches!(state_s, "archived" | "trashed") {
        return Err(format!("#{} is {state_s}; restore it to post.", g["name"].as_str().unwrap_or("")));
    }
    let rows = member_rows(conn, &gid, false)?;
    let from_user = req.from.pid == "user";
    if !from_user {
        match rows.iter().find(|r| r.pid == req.from.pid) {
            Some(r) if r.membership == "suspended" => return Err("You are suspended in this group and cannot post.".into()),
            Some(r) if !r.can_post => return Err("You are an observer in this group and cannot post.".into()),
            Some(_) => {}
            None => return Err("You are not a member of that group.".into()),
        }
    }
    if req.text.trim().is_empty() {
        return Err("The message is empty.".into());
    }
    // Roster for mentions: members (not the sender's own name for agents).
    let roster: Vec<(String, String, Option<String>)> = rows
        .iter()
        .filter(|r| r.pid.starts_with("agent:"))
        .map(|r| {
            let a = find(agents, &r.pid);
            (r.pid.clone(), a.map(|a| a.name.clone()).unwrap_or_else(|| super::principals::display_name(conn, &r.pid)), a.and_then(|a| a.title.clone()))
        })
        .collect();
    let mut mentions = envelope::parse_mentions(req.text, &roster);
    if !from_user {
        // Ambiguous names are rejected for agents.
        let mut seen = std::collections::HashMap::<String, Vec<String>>::new();
        for (pid, name, _) in &roster {
            seen.entry(name.to_lowercase()).or_default().push(pid.clone());
        }
        for (lname, pids) in seen.iter().filter(|(_, p)| p.len() > 1) {
            let hits: Vec<&String> = pids.iter().filter(|p| mentions.contains(p)).collect();
            let by_id = pids.iter().any(|p| {
                let bare = p.split_once(':').map(|x| x.1).unwrap_or(p);
                req.text.contains(&format!("@{bare}")) || req.text.contains(&format!("@{p}"))
            });
            if hits.len() > 1 && !by_id {
                let ids: Vec<String> = pids.iter().map(|p| format!("@{}", p.split_once(':').map(|x| x.1).unwrap_or(p))).collect();
                return Err(format!("Two members are called {lname}; use {}.", ids.join(" or ")));
            }
        }
        // An agent mentioning itself: ignored.
        mentions.retain(|m| m != &req.from.pid);
    }
    let mut to_parties = Vec::new();
    let mut to_pids = Vec::new();
    for t in &req.to {
        let pid = if t.contains(':') { t.clone() } else { format!("agent:{t}") };
        let Some((p, n, _)) = roster.iter().find(|(p, n, _)| p == &pid || n.eq_ignore_ascii_case(t)) else {
            return Err(format!("{t} is not a member of this group."));
        };
        to_pids.push(p.clone());
        to_parties.push(Party::new(p, n));
    }
    let conv = format!("group:{gid}");
    let mut reply_to_author = None;
    if let Some(r) = &req.reply_to {
        let row: Option<(String, String)> = conn.query_row("SELECT conversation, from_pid FROM ws_messages WHERE id = ?1", params![r], |x| Ok((x.get(0)?, x.get(1)?))).optional().map_err(e2s)?;
        match row {
            Some((c, f)) if c == conv => reply_to_author = Some(f),
            Some(_) => return Err(format!("Message {r} is in another conversation.")),
            None => return Err(format!("No message {r} to reply to.")),
        }
    }
    let mut env = Envelope::new(conv, req.from.clone(), if to_parties.is_empty() { vec![Party::new(&format!("group:{gid}"), &format!("#{}", g["name"].as_str().unwrap_or("")))] } else { to_parties });
    env.mentions = mentions.clone();
    env.reply_to = req.reply_to.clone();
    let settings = &g["settings"];
    let info = GroupInfo {
        state: state_s.to_string(),
        comms_paused: req.comms_paused,
        confirm_agents: settings["confirmAgents"].as_u64().unwrap_or(4) as usize,
        confirm_tokens: settings["confirmTokens"].as_i64().unwrap_or(20_000),
        today: day_of(now),
    };
    let incoming = Incoming { from: req.from.pid.clone(), from_user, mentions, to: to_pids, reply_to_author, text_chars: req.text.chars().count() };
    Ok(Prepared {
        name: g["name"].as_str().unwrap_or("").to_string(),
        members: members_for_rules(conn, &gid, agents, &req.pending)?,
        rules: load_rules(conn, &gid)?,
        state: load_state(conn, &gid)?,
        gid,
        env,
        info,
        incoming,
    })
}

fn label_engaged(d: &mut Dispatch, members: &[Member], now: i64) {
    for (pid, reason) in d.deliver.iter_mut() {
        if reason == "delivery" && members.iter().any(|m| &m.pid == pid && m.presence == Presence::Active && m.engaged_until.is_some_and(|t| t > now)) {
            *reason = "engaged".into();
        }
    }
}

/// The composer's live preview: the same `decide` as `post`, no writes.
pub fn preview(conn: &Connection, gid: &str, req: &PostReq, agents: &[AgentInfo]) -> Result<Value, String> {
    let now = now_ms();
    let p = prepare(conn, gid, req, agents, now)?;
    let mut d = rules::decide(&p.info, &p.incoming, &p.members, &p.rules, &p.state, now);
    label_engaged(&mut d, &p.members, now);
    let mut out = d.to_json();
    out["names"] = json!(p.members.iter().map(|m| (m.pid.clone(), json!(m.name))).collect::<serde_json::Map<_, _>>());
    out["mentions"] = json!(p.incoming.mentions);
    Ok(out)
}

/// Write a group message, decide, log the dispatch and update the counters,
/// all in one transaction. The caller wakes and delivers afterwards.
pub fn post(conn: &Connection, gid: &str, req: &PostReq, agents: &[AgentInfo]) -> Result<PostOutcome, String> {
    post_at(conn, gid, req, agents, now_ms())
}

pub fn post_at(conn: &Connection, gid: &str, req: &PostReq, agents: &[AgentInfo], now: i64) -> Result<PostOutcome, String> {
    let p = prepare(conn, gid, req, agents, now)?;
    let mut d = rules::decide(&p.info, &p.incoming, &p.members, &p.rules, &p.state, now);
    label_engaged(&mut d, &p.members, now);
    let from_user = p.incoming.from_user;
    let posted = tx(conn, |c| -> Result<Posted, String> {
        let posted = envelope::post_at(c, &p.env, req.text, &req.attachments, now, None)?;
        for (pid, decision, reason, rule_id, est) in d.rows() {
            c.execute(
                "INSERT OR REPLACE INTO ws_group_dispatch (message_id, pid, decision, reason, rule_id, est_tokens, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![posted.id, pid, decision, reason, rule_id, est, now],
            )
            .map_err(e2s)?;
        }
        let st = &p.state;
        let (win_start, win_n) = match st.wakes_window_start {
            Some(s) if now - s < 10 * 60_000 => (s, st.wakes_in_window + d.wake.len() as i64),
            _ => (now, d.wake.len() as i64),
        };
        let unanswered = if from_user { st.unanswered + 1 } else { 0 };
        c.execute(
            "INSERT INTO ws_group_state (group_id, unanswered, last_message_at, last_agent_reply_at, chain_depth, wakes_window_start, wakes_in_window, tokens_day, tokens_used, rr_cursor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(group_id) DO UPDATE SET unanswered = excluded.unanswered, last_message_at = excluded.last_message_at,
               last_agent_reply_at = excluded.last_agent_reply_at, chain_depth = excluded.chain_depth, wakes_window_start = excluded.wakes_window_start,
               wakes_in_window = excluded.wakes_in_window, rr_cursor = excluded.rr_cursor",
            params![p.gid, unanswered, now, if from_user { st.last_agent_reply_at } else { Some(now) }, d.chain_depth, win_start, win_n, st.tokens_day, st.tokens_used, d.rr_cursor],
        )
        .map_err(e2s)?;
        if !from_user {
            // The sender spoke: its attention window runs 5 more minutes (max 15 after the wake).
            let woken: Option<i64> = p.members.iter().find(|m| m.pid == p.incoming.from).and_then(|m| m.last_woken_at);
            let until = (now + ENGAGED_AFTER_POST_MS).min(woken.map_or(now + ENGAGED_AFTER_POST_MS, |w| (w + ENGAGED_MAX_MS).max(now)));
            c.execute("UPDATE ws_group_members SET last_spoke_at = ?3, engaged_until = ?4 WHERE group_id = ?1 AND pid = ?2 AND membership <> 'left'", params![p.gid, p.incoming.from, now, until]).map_err(e2s)?;
        }
        for w in &d.wake {
            c.execute("UPDATE ws_group_members SET last_woken_at = ?3, engaged_until = ?4 WHERE group_id = ?1 AND pid = ?2 AND membership = 'joined'", params![p.gid, w.pid, now, now + ENGAGED_MAX_MS]).map_err(e2s)?;
        }
        // The sender has read up to its own message.
        c.execute(
            "INSERT INTO ws_cursors (pid, conversation, last_read) VALUES (?1, ?2, ?3) ON CONFLICT(pid, conversation) DO UPDATE SET last_read = excluded.last_read",
            params![p.incoming.from, format!("group:{}", p.gid), posted.id],
        )
        .map_err(e2s)?;
        c.execute("UPDATE ws_groups SET updated_at = ?2 WHERE id = ?1", params![p.gid, now]).map_err(e2s)?;
        Ok(posted)
    })?;
    Ok(PostOutcome { posted, dispatch: d, group_name: p.name })
}

/// `group_pass {group, reason}`: posts nothing, records why.
pub fn pass(conn: &Connection, gid: &str, pid: &str, reason: &str, trigger: Option<&str>) -> Result<(), String> {
    let gid = require(conn, gid)?["id"].as_str().unwrap_or("").to_string();
    let mid = match trigger {
        Some(t) => t.to_string(),
        None => conn
            .query_row("SELECT id FROM ws_messages WHERE conversation = ?1 AND from_pid <> ?2 ORDER BY created_at DESC, rowid DESC LIMIT 1", params![format!("group:{gid}"), pid], |r| r.get(0))
            .optional()
            .map_err(e2s)?
            .ok_or("Nothing to pass on.")?,
    };
    conn.execute(
        "INSERT INTO ws_group_dispatch (message_id, pid, decision, reason, at) VALUES (?1, ?2, 'pass', ?3, ?4)
         ON CONFLICT(message_id, pid) DO UPDATE SET decision = 'pass', reason = excluded.reason, at = excluded.at",
        params![mid, pid, format!("pass: {}", clip(reason, 200)), now_ms()],
    )
    .map_err(e2s)?;
    conn.execute("UPDATE ws_group_members SET engaged_until = NULL WHERE group_id = ?1 AND pid = ?2 AND membership <> 'left'", params![gid, pid]).map_err(e2s)?;
    Ok(())
}

/// The `ws_group_dispatch` rows of one message, with names and a sentence.
pub fn dispatch_log(conn: &Connection, message_id: &str) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let mut st = conn.prepare("SELECT pid, decision, reason, rule_id, est_tokens, at FROM ws_group_dispatch WHERE message_id = ?1 ORDER BY decision, pid").map_err(e2s)?;
    let rows = st
        .query_map(params![message_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?)))
        .map_err(e2s)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e2s)?;
    Ok(rows
        .into_iter()
        .map(|(pid, decision, reason, rule_id, est, at)| {
            let name = super::principals::display_name(conn, &pid);
            json!({ "pid": pid, "name": name, "decision": decision, "reason": reason, "ruleId": rule_id, "estTokens": est, "at": at, "text": explain(&name, &decision, &reason) })
        })
        .collect())
}

/// "Critic: not woken, Wait your turn (2 of 3 unanswered)".
pub fn explain(name: &str, decision: &str, reason: &str) -> String {
    let why = if let Some(r) = reason.strip_prefix("rule:wait_your_turn ") {
        format!("Wait your turn {r}")
    } else if let Some(r) = reason.strip_prefix("blocked:suspended:") {
        format!("suspended ({})", reason_text(r))
    } else {
        match reason {
            "mention" => "you mentioned it".into(),
            "at_all" => "@all".into(),
            "direct" => "a direct message".into(),
            "reply" => "a reply to its message".into(),
            "delivery" => "no mention (it can read the message)".into(),
            "engaged" => "still in the conversation".into(),
            "blocked:paused" | "paused" => "paused; it sees this when you resume it".into(),
            "blocked:muted" => "muted".into(),
            "blocked:self" => "its own message".into(),
            "cap:max_replies" => "the reply cap was reached".into(),
            "cap:rate" => "the group's wake rate was reached".into(),
            "rule:quiet" => "quiet member".into(),
            "rule:agent_to_agent_off" => "agents may not wake each other here".into(),
            other => other.replace("rule:", "").replace('_', " "),
        }
    };
    let what = match decision {
        "wake" => "woken",
        "coalesce" => "added to its current run",
        "queue" => "queued",
        "pass" => "passed",
        "skip" => "skipped",
        _ => "not woken",
    };
    format!("{name}: {what}, {why}")
}

/// `group_read`: messages (tombstones for deleted ones), oldest first.
pub fn read(conn: &Connection, gid: &str, before: Option<&str>, thread: Option<&str>, limit: usize) -> Result<Value, String> {
    let g = require(conn, gid)?;
    let gid = g["id"].as_str().unwrap_or("").to_string();
    let mut msgs = match thread {
        Some(root) => envelope::read_thread(conn, root)?.into_iter().filter(|m| m["conversation"] == format!("group:{gid}")).collect(),
        None => envelope::read_conversation(conn, &format!("group:{gid}"), before, limit)?,
    };
    for m in msgs.iter_mut() {
        if m["state"] == "deleted" {
            m["text"] = json!("message deleted");
        }
        if let Some(r) = m["replyTo"].as_str() {
            let q: Option<(String, String, String)> = conn.query_row("SELECT from_pid, text, state FROM ws_messages WHERE id = ?1", params![r], |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?))).optional().map_err(e2s)?;
            if let Some((from, text, state)) = q {
                m["replyQuote"] = json!({ "from": from, "fromName": super::principals::display_name(conn, &from), "text": if state == "deleted" { "message deleted".to_string() } else { clip(&text, 80) } });
            }
        }
    }
    Ok(json!({ "group": g, "messages": msgs, "pins": pins(conn, &gid)? }))
}

pub fn pins(conn: &Connection, gid: &str) -> Result<Vec<Value>, String> {
    let mut st = conn
        .prepare("SELECT p.message_id, p.pinned_by, p.pinned_at, p.note, m.text, m.from_pid FROM ws_pins p LEFT JOIN ws_messages m ON m.id = p.message_id WHERE p.group_id = ?1 ORDER BY p.pinned_at")
        .map_err(e2s)?;
    let rows = st
        .query_map(params![gid], |r| {
            Ok(json!({ "messageId": r.get::<_, String>(0)?, "pinnedBy": r.get::<_, String>(1)?, "pinnedAt": r.get::<_, i64>(2)?, "note": r.get::<_, Option<String>>(3)?,
                       "text": r.get::<_, Option<String>>(4)?.map(|t| clip(&t, 120)), "from": r.get::<_, Option<String>>(5)? }))
        })
        .map_err(e2s)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e2s)?;
    Ok(rows)
}

pub fn pin(conn: &Connection, gid: &str, message_id: &str, by: &str, on: bool) -> Result<(), String> {
    let gid = require(conn, gid)?["id"].as_str().unwrap_or("").to_string();
    if on {
        let conv: Option<String> = conn.query_row("SELECT conversation FROM ws_messages WHERE id = ?1", params![message_id], |r| r.get(0)).optional().map_err(e2s)?;
        if conv.as_deref() != Some(format!("group:{gid}").as_str()) {
            return Err(format!("No message {message_id} in this group."));
        }
        conn.execute("INSERT OR REPLACE INTO ws_pins (group_id, message_id, pinned_by, pinned_at) VALUES (?1, ?2, ?3, ?4)", params![gid, message_id, by, now_ms()]).map_err(e2s)?;
    } else {
        conn.execute("DELETE FROM ws_pins WHERE group_id = ?1 AND message_id = ?2", params![gid, message_id]).map_err(e2s)?;
    }
    Ok(())
}

/// Edit (keeps the old text in the item's history) or delete (tombstone)
/// one's own message.
pub fn edit_message(conn: &Connection, message_id: &str, by: &str, new_text: Option<&str>) -> Result<(), String> {
    ensure_tables(conn).map_err(e2s)?;
    let row: Option<(String, String, String)> = conn.query_row("SELECT from_pid, text, state FROM ws_messages WHERE id = ?1", params![message_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(e2s)?;
    let Some((from, old, state)) = row else { return Err(format!("No message {message_id}.")) };
    if from != by {
        return Err("You can only change your own messages.".into());
    }
    if state == "deleted" {
        return Err("That message was deleted.".into());
    }
    let now = now_ms();
    let loc = format!("db:ws_messages/{message_id}");
    let meta_raw: String = conn.query_row("SELECT meta_json FROM ws_items WHERE loc = ?1", params![loc], |r| r.get(0)).optional().map_err(e2s)?.unwrap_or_else(|| "{}".into());
    let mut meta: Value = serde_json::from_str(&meta_raw).unwrap_or(json!({}));
    let mut hist = meta["history"].as_array().cloned().unwrap_or_default();
    hist.push(json!({ "text": old, "at": now }));
    meta["history"] = json!(hist);
    tx(conn, |c| -> Result<(), String> {
        match new_text {
            Some(t) => {
                c.execute("UPDATE ws_messages SET text = ?2, edited_at = ?3 WHERE id = ?1", params![message_id, t, now]).map_err(e2s)?;
            }
            None => {
                c.execute("UPDATE ws_messages SET state = 'deleted', deleted_at = ?2 WHERE id = ?1", params![message_id, now]).map_err(e2s)?;
            }
        }
        c.execute("UPDATE ws_items SET meta_json = ?2, updated_at = ?3 WHERE loc = ?1", params![loc, meta.to_string(), now]).map_err(e2s)?;
        Ok(())
    })
}

/// Add a finished run's tokens to today's group total.
pub fn add_tokens(conn: &Connection, gid: &str, tokens: i64) -> Result<(), String> {
    let today = day_of(now_ms());
    let st = load_state(conn, gid)?;
    let used = if st.tokens_day.as_deref() == Some(today.as_str()) { st.tokens_used + tokens } else { tokens };
    conn.execute(
        "INSERT INTO ws_group_state (group_id, tokens_day, tokens_used) VALUES (?1, ?2, ?3) ON CONFLICT(group_id) DO UPDATE SET tokens_day = excluded.tokens_day, tokens_used = excluded.tokens_used",
        params![gid, today, used],
    )
    .map_err(e2s)?;
    Ok(())
}

/// The silence bar: the newest user message nobody answered, when the
/// nudge is due. Fires once per message (`settings.nudgedFor`).
pub fn silence(conn: &Connection, gid: &str, now: i64) -> Result<Value, String> {
    let conv = format!("group:{gid}");
    let last: Option<(String, String, i64)> = conn
        .query_row("SELECT id, from_pid, created_at FROM ws_messages WHERE conversation = ?1 AND kind <> 'system' AND state = 'sent' ORDER BY created_at DESC, rowid DESC LIMIT 1", params![conv], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(e2s)?;
    let Some((mid, from, at)) = last else { return Ok(Value::Null) };
    if from != "user" {
        return Ok(Value::Null);
    }
    let fired: Option<String> = group_row(conn, gid)?.and_then(|g| g["settings"]["nudgedFor"].as_str().map(str::to_string));
    let rules_list = load_rules(conn, gid)?;
    Ok(rules::silence_due(&rules_list, Some((&mid, at)), false, fired.as_deref(), now).unwrap_or(Value::Null))
}

/// Remember that the nudge for `message_id` was shown or acted on.
pub fn mark_nudged(conn: &Connection, gid: &str, message_id: &str) -> Result<(), String> {
    set_setting(conn, gid, "nudgedFor", json!(message_id))
}

/// Groups `holder` is a member of, for the tree's Groups section.
pub fn groups_of(conn: &Connection, holder: &str) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let mut st = conn
        .prepare(
            "SELECT g.id, g.name, g.state, m.role, m.membership FROM ws_group_members m JOIN ws_groups g ON g.id = m.group_id
             WHERE m.pid = ?1 AND m.membership <> 'left' AND g.state NOT IN ('deleted', 'trashed') ORDER BY g.name",
        )
        .map_err(e2s)?;
    let rows = st
        .query_map(params![holder], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "holder": format!("group:{}", r.get::<_, String>(0)?), "name": r.get::<_, String>(1)?, "state": r.get::<_, String>(2)?, "role": r.get::<_, String>(3)?, "membership": r.get::<_, String>(4)? })))
        .map_err(e2s)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e2s)?;
    Ok(rows)
}

/// The block each member's system prompt gets. Empty when in no group.
pub fn for_agent(conn: &Connection, pid: &str, agents: &[AgentInfo]) -> String {
    let Ok(gs) = groups_of(conn, pid) else { return String::new() };
    let gs: Vec<Value> = gs.into_iter().filter(|g| g["membership"] == "joined").collect();
    if gs.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    for g in &gs {
        let gid = g["id"].as_str().unwrap_or("");
        let others: Vec<String> = member_rows(conn, gid, false)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.pid.starts_with("agent:") && r.pid != pid && r.membership == "joined")
            .map(|r| find(agents, &r.pid).map(|a| a.name.clone()).unwrap_or_else(|| super::principals::display_name(conn, &r.pid)))
            .collect();
        let preset: String = conn.query_row("SELECT preset FROM ws_groups WHERE id = ?1", params![gid], |r| r.get(0)).unwrap_or_else(|_| "social".into());
        parts.push(format!(
            "#{} (id {gid}; you: {}; {}; rules: {}{})",
            g["name"].as_str().unwrap_or(""),
            g["role"].as_str().unwrap_or("member"),
            others.join(", "),
            rules::preset_label(&preset),
            if g["state"] != "active" { format!("; {}", g["state"].as_str().unwrap_or("")) } else { String::new() }
        ));
    }
    format!(
        "\n\nGroups you are in: {}. Reply in the group with group_post; mention with @name; use group_pass when you have nothing to add, group_read for the full thread, and group_pin to pin a message for everyone.",
        parts.join("; ")
    )
}

/// The note a woken (or delivered) member receives: the header of the
/// trigger plus the unread messages since its cursor, folded to a budget.
/// Advances the member's cursor.
pub fn member_note(conn: &Connection, gid: &str, pid: &str, trigger: &Posted, group_name: &str) -> Result<String, String> {
    let conv = format!("group:{gid}");
    let last_read: Option<String> = conn.query_row("SELECT last_read FROM ws_cursors WHERE pid = ?1 AND conversation = ?2", params![pid, conv], |r| r.get(0)).optional().map_err(e2s)?.flatten();
    let since: i64 = match &last_read {
        Some(m) => conn.query_row("SELECT created_at FROM ws_messages WHERE id = ?1", params![m], |r| r.get(0)).optional().map_err(e2s)?.unwrap_or(0),
        None => 0,
    };
    let mut lines: Vec<String> = Vec::new();
    let unread: Vec<Value> = envelope::read_conversation(conn, &conv, None, 50)?
        .into_iter()
        .filter(|m| m["at"].as_i64().unwrap_or(0) > since && m["id"] != trigger.id.as_str() && m["kind"] != "system")
        .collect();
    let mut used = 0usize;
    let mut folded = 0usize;
    for m in unread.iter().rev() {
        let reply = m["replyTo"].as_str().map(|r| format!(" ↪ {r}")).unwrap_or_default();
        let text = if m["state"] == "deleted" { "message deleted".to_string() } else { m["text"].as_str().unwrap_or("").to_string() };
        let line = format!("⟦{} · {} ({}) · msg {}{}⟧ {}", format_args!("#{group_name}"), m["fromName"].as_str().unwrap_or(""), m["from"].as_str().unwrap_or(""), m["id"].as_str().unwrap_or(""), reply, clip(&text, 600));
        if used + line.len() > NOTE_BUDGET {
            folded += 1;
            continue;
        }
        used += line.len();
        lines.push(line);
    }
    lines.reverse();
    let me = super::principals::display_name(conn, pid);
    let from = format!("{} ({})", clip(&trigger.env.from.name, 24), trigger.env.from.pid);
    let mut header = format!("⟦#{group_name} · from: {from}");
    if let Some((name, rpid, quote)) = &trigger.replied {
        let who = if rpid == pid { format!("you ({me})") } else { name.clone() };
        header.push_str(&format!(" · replying to: {who} {} \"{quote}\"", trigger.env.reply_to.as_deref().unwrap_or("")));
    }
    if trigger.env.mentions.iter().any(|m| m == pid || m == "@all") {
        header.push_str(" · mentions: you");
    }
    if trigger.env.to.iter().any(|t| t.pid == pid) {
        header.push_str(" · to: you");
    }
    header.push_str(&format!(" · msg {}⟧", trigger.id));
    let text: String = conn.query_row("SELECT text FROM ws_messages WHERE id = ?1", params![trigger.id], |r| r.get(0)).map_err(e2s)?;
    let mut out = String::new();
    // The group's shared items: exactly the `in` set plus `auto` picks.
    out.push_str(&super::context_use::prompt_block(conn, &conv, CONTEXT_BUDGET));
    if folded > 0 {
        out.push_str(&format!("({folded} older unread messages folded; call group_read for the full thread.)\n"));
    }
    if !lines.is_empty() {
        out.push_str(&format!("Earlier in #{group_name}:\n{}\n", lines.join("\n")));
    }
    out.push_str(&format!("{header}\n{text}\n(Answer in the group with group_post {{group: \"{gid}\"}}, or group_pass if you have nothing to add.)"));
    conn.execute(
        "INSERT INTO ws_cursors (pid, conversation, last_read) VALUES (?1, ?2, ?3) ON CONFLICT(pid, conversation) DO UPDATE SET last_read = excluded.last_read",
        params![pid, conv, trigger.id],
    )
    .map_err(e2s)?;
    Ok(out)
}
