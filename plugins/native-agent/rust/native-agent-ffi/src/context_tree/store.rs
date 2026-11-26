//! Persistence for the tree. Additive: it creates its own tables in the session
//! database and never touches the engine's v6 tables.
//!
//! Three rules hold everywhere in this file:
//!
//! 1. **Every read and write is scoped by `session_key`.** There is no query that
//!    can see another session's rows, so the tree cannot leak across chats.
//! 2. **The tree is an index, not a copy.** Only temp summaries, notes, strategy,
//!    categories and the action log own content here. A `turn`/`file`/`result`
//!    node stores a locator and sizes; the content stays where it already lives.
//! 3. **Ids are never reused.** A deleted node keeps a tombstone, and the
//!    counter on the session row only moves forward, so a stale id in the model's
//!    context can never silently point at a different item.
//!
//! The schema version is kept in `ctx_meta`, not in `PRAGMA user_version`: the
//! engine already uses that pragma for its own v6 schema and the two must not
//! fight over it.

use rusqlite::{params, Connection, OptionalExtension, Result};

use super::model::{ItemState, Node, NodeId, NodeKind, Owner, Pin, Provenance};

/// Version of the context-tree tables (independent of the engine's v6).
pub const CTX_SCHEMA_VERSION: i64 = 2;

/// The categories every session starts with. `sys` and `ess` are locked homes:
/// the model may look at them, never remove them.
pub const BUILTIN_CATEGORIES: [(&str, &str, &str); 7] = [
    ("sys", "System prompt", "system"),
    ("ess", "Essentials", "system"),
    ("turns", "Conversation", "system"),
    ("files", "Files", "system"),
    ("results", "Tool output", "system"),
    ("notes", "Notebook", "system"),
    ("strategy", "Strategy", "system"),
];

/// Default per-session caps. Per-kind trimming keeps long chats alive: one global
/// node cap would starve the newest turns of a 900-turn session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quotas {
    pub nodes: i64,
    /// Bytes of note text (a note is the model's own writing, worth keeping).
    pub bytes_notes: i64,
    /// Bytes of temp-summary text.
    pub bytes_temp: i64,
}

impl Default for Quotas {
    fn default() -> Self {
        Quotas { nodes: 4_000, bytes_notes: 512 * 1024, bytes_temp: 1024 * 1024 }
    }
}

/// What one GC pass did, so the caller can log it honestly.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GcReport {
    pub nodes_trimmed: usize,
    pub notes_trimmed: usize,
    pub temp_trimmed: usize,
    pub bytes_freed: i64,
}

impl GcReport {
    pub fn did_anything(&self) -> bool {
        self.nodes_trimmed > 0 || self.notes_trimmed > 0 || self.temp_trimmed > 0
    }
}

// ---------------------------------------------------------------- schema

/// Create the tables if they are missing. Idempotent and cheap when already
/// present, so it is safe to call on every open.
pub fn ensure_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ctx_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ctx_sessions (
            session_key  TEXT PRIMARY KEY,
            rev          INTEGER NOT NULL DEFAULT 0,
            next_node_no INTEGER NOT NULL DEFAULT 1,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ctx_nodes (
            session_key  TEXT NOT NULL,
            id           TEXT NOT NULL,
            kind         TEXT NOT NULL,
            parent       TEXT NOT NULL,
            tags         TEXT NOT NULL DEFAULT '[]',
            ord          INTEGER NOT NULL DEFAULT 0,
            title        TEXT NOT NULL,
            state        TEXT NOT NULL DEFAULT 'out',
            pin          TEXT NOT NULL DEFAULT 'none',
            owner        TEXT NOT NULL DEFAULT 'policy',
            tokens_full  INTEGER NOT NULL DEFAULT 0,
            tokens_note  INTEGER NOT NULL DEFAULT 0,
            token_model  TEXT NOT NULL DEFAULT '',
            note         TEXT,
            source       TEXT NOT NULL DEFAULT 'engine',
            locator      TEXT,
            range        TEXT,
            turn         INTEGER,
            call_index   INTEGER,
            content_hash TEXT,
            created_at   INTEGER NOT NULL,
            last_used_at INTEGER,
            loaded_at    INTEGER,
            node_rev     INTEGER NOT NULL DEFAULT 1,
            deleted      INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, id)
        );
        CREATE INDEX IF NOT EXISTS ctx_nodes_parent ON ctx_nodes(session_key, parent, ord);
        CREATE INDEX IF NOT EXISTS ctx_nodes_state  ON ctx_nodes(session_key, state);
        CREATE INDEX IF NOT EXISTS ctx_nodes_lru    ON ctx_nodes(session_key, last_used_at);
        CREATE TABLE IF NOT EXISTS ctx_categories (
            session_key TEXT NOT NULL,
            id          TEXT NOT NULL,
            parent      TEXT,
            title       TEXT NOT NULL,
            owner       TEXT NOT NULL,
            ord         INTEGER NOT NULL DEFAULT 0,
            depth       INTEGER NOT NULL DEFAULT 0,
            cap_tokens  INTEGER,
            created_at  INTEGER NOT NULL,
            deleted     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, id)
        );
        CREATE TABLE IF NOT EXISTS ctx_notes (
            session_key TEXT NOT NULL,
            id          TEXT NOT NULL,
            title       TEXT NOT NULL,
            text        TEXT NOT NULL,
            category    TEXT NOT NULL DEFAULT 'notes',
            state       TEXT NOT NULL DEFAULT 'in',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            PRIMARY KEY (session_key, id)
        );
        CREATE TABLE IF NOT EXISTS ctx_temp_summaries (
            session_key   TEXT NOT NULL,
            id            TEXT NOT NULL,
            text          TEXT NOT NULL,
            focus         TEXT,
            sources       TEXT NOT NULL DEFAULT '[]',
            source_hashes TEXT NOT NULL DEFAULT '[]',
            made_by       TEXT NOT NULL,
            tokens        INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (session_key, id)
        );
        CREATE TABLE IF NOT EXISTS ctx_strategy (
            session_key TEXT NOT NULL,
            version     INTEGER NOT NULL,
            text        TEXT NOT NULL,
            steps       TEXT NOT NULL DEFAULT '[]',
            next_step   TEXT,
            at          INTEGER NOT NULL,
            PRIMARY KEY (session_key, version)
        );
        CREATE TABLE IF NOT EXISTS ctx_action_log (
            seq           INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key   TEXT NOT NULL,
            at            INTEGER NOT NULL,
            turn          INTEGER,
            step          INTEGER,
            actor         TEXT NOT NULL,
            tool          TEXT,
            ops           TEXT NOT NULL,
            rev_before    INTEGER,
            rev_after     INTEGER,
            tokens_before INTEGER,
            tokens_after  INTEGER,
            reason        TEXT
        );
        CREATE INDEX IF NOT EXISTS ctx_action_log_session ON ctx_action_log(session_key, seq);
        "#,
    )?;
    conn.execute(
        "INSERT INTO ctx_meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(ctx_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)",
        params![CTX_SCHEMA_VERSION.to_string()],
    )?;
    // Schema 2: the task context policy tables (pins, tasks, events).
    crate::context_policy::store::ensure_tables(conn)?;
    Ok(())
}

/// The schema version the tables report, if they exist at all.
pub fn schema_version(conn: &Connection) -> Option<i64> {
    conn.query_row("SELECT value FROM ctx_meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
}

// ---------------------------------------------------------------- session + rev

/// Create the session row if needed and return its current revision.
pub fn ensure_session(conn: &Connection, session_key: &str, now_ms: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO ctx_sessions (session_key, rev, next_node_no, created_at, updated_at)
         VALUES (?1, 0, 1, ?2, ?2)
         ON CONFLICT(session_key) DO NOTHING",
        params![session_key, now_ms],
    )?;
    for (id, title, owner) in BUILTIN_CATEGORIES {
        conn.execute(
            "INSERT INTO ctx_categories (session_key, id, parent, title, owner, ord, depth, created_at)
             VALUES (?1, ?2, NULL, ?3, ?4, 0, 0, ?5)
             ON CONFLICT(session_key, id) DO NOTHING",
            params![session_key, id, title, owner, now_ms],
        )?;
    }
    rev(conn, session_key)
}

/// The tree revision. `0` means "no tree yet".
pub fn rev(conn: &Connection, session_key: &str) -> Result<i64> {
    Ok(conn
        .query_row("SELECT rev FROM ctx_sessions WHERE session_key = ?1", params![session_key], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

/// Move the revision forward. Called once per applied batch, inside the caller's
/// transaction, so a reader never sees half a change.
pub fn bump_rev(conn: &Connection, session_key: &str, now_ms: i64) -> Result<i64> {
    conn.execute(
        "UPDATE ctx_sessions SET rev = rev + 1, updated_at = ?2 WHERE session_key = ?1",
        params![session_key, now_ms],
    )?;
    rev(conn, session_key)
}

/// Allocate the next id for a kind. Never reuses a number, even after deletion.
pub fn next_node_id(conn: &Connection, session_key: &str, kind: NodeKind, now_ms: i64) -> Result<NodeId> {
    let n: i64 = conn
        .query_row("SELECT next_node_no FROM ctx_sessions WHERE session_key = ?1", params![session_key], |r| r.get(0))
        .optional()?
        .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
    conn.execute(
        "UPDATE ctx_sessions SET next_node_no = ?2, updated_at = ?3 WHERE session_key = ?1",
        params![session_key, n + 1, now_ms],
    )?;
    let prefix = kind.id_prefix();
    let raw = format!("{prefix}/{n}");
    NodeId::parse(&raw).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            e,
        )))
    })
}

// ---------------------------------------------------------------- nodes

fn node_from_row(r: &rusqlite::Row<'_>) -> Result<Node> {
    let id: String = r.get("id")?;
    let kind: String = r.get("kind")?;
    let state: String = r.get("state")?;
    let pin: String = r.get("pin")?;
    let owner: String = r.get("owner")?;
    let tags: String = r.get("tags")?;
    let fallback = NodeId::parse("turn/t0").expect("static id");
    Ok(Node {
        id: NodeId::parse(&id).unwrap_or(fallback),
        session_key: r.get("session_key")?,
        kind: NodeKind::of_str(&kind).unwrap_or(NodeKind::Turn),
        parent: r.get("parent")?,
        tags: serde_json::from_str::<Vec<String>>(&tags).unwrap_or_default(),
        order: r.get("ord")?,
        title: r.get("title")?,
        state: ItemState::parse(&state).unwrap_or(ItemState::Out),
        pin: Pin::parse(&pin).unwrap_or(Pin::None),
        owner: Owner::parse(&owner).unwrap_or(Owner::Policy),
        tokens_full: r.get::<_, i64>("tokens_full")?.clamp(0, u32::MAX as i64) as u32,
        tokens_note: r.get::<_, i64>("tokens_note")?.clamp(0, u32::MAX as i64) as u32,
        token_model: r.get("token_model")?,
        note: r.get("note")?,
        provenance: Provenance {
            source: r.get("source")?,
            locator: r.get("locator")?,
            range: r.get("range")?,
            turn: r.get::<_, Option<i64>>("turn")?.map(|v| v as u32),
            call_index: r.get::<_, Option<i64>>("call_index")?.map(|v| v as u32),
            content_hash: r.get("content_hash")?,
        },
        created_at: r.get("created_at")?,
        last_used_at: r.get("last_used_at")?,
        loaded_at: r.get("loaded_at")?,
        turn: r.get::<_, Option<i64>>("turn")?.map(|v| v as u32),
        rev: r.get("node_rev")?,
        deleted: r.get::<_, i64>("deleted")? != 0,
    })
}

/// Insert a node, replacing any tombstone that happens to share its id (it never
/// does: ids are never reused, but an import of an older tree can collide).
pub fn upsert_node(conn: &Connection, node: &Node) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_nodes (session_key, id, kind, parent, tags, ord, title, state, pin, owner,
            tokens_full, tokens_note, token_model, note, source, locator, range, turn, call_index,
            content_hash, created_at, last_used_at, loaded_at, node_rev, deleted)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,0)
         ON CONFLICT(session_key, id) DO UPDATE SET
            kind=excluded.kind, parent=excluded.parent, tags=excluded.tags, ord=excluded.ord,
            title=excluded.title, state=excluded.state, pin=excluded.pin, owner=excluded.owner,
            tokens_full=excluded.tokens_full, tokens_note=excluded.tokens_note,
            token_model=excluded.token_model, note=excluded.note, source=excluded.source,
            locator=excluded.locator, range=excluded.range, turn=excluded.turn,
            call_index=excluded.call_index, content_hash=excluded.content_hash,
            loaded_at=excluded.loaded_at, node_rev=ctx_nodes.node_rev+1, deleted=0",
        params![
            node.session_key,
            node.id.as_str(),
            node.kind.as_str(),
            node.parent,
            serde_json::to_string(&node.tags).unwrap_or_else(|_| "[]".into()),
            node.order,
            node.title,
            node.state.as_str(),
            node.pin.as_str(),
            node.owner.as_str(),
            node.tokens_full as i64,
            node.tokens_note as i64,
            node.token_model,
            node.note,
            node.provenance.source,
            node.provenance.locator,
            node.provenance.range,
            // `Node.turn` and `provenance.turn` are the same fact; prefer the
            // former so a caller that only set one of them is still stored right.
            node.turn.or(node.provenance.turn).map(|v| v as i64),
            node.provenance.call_index.map(|v| v as i64),
            node.provenance.content_hash,
            node.created_at,
            node.last_used_at,
            node.loaded_at,
            node.rev,
        ],
    )?;
    Ok(())
}

/// One node, or `None` when it does not exist, was deleted, or belongs to another
/// session. Those three cases are deliberately indistinguishable to the caller.
pub fn load_node(conn: &Connection, session_key: &str, id: &str) -> Result<Option<Node>> {
    conn.query_row(
        "SELECT * FROM ctx_nodes WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
        params![session_key, id],
        node_from_row,
    )
    .optional()
}

/// The tombstone of a deleted node, if one is kept.
pub fn load_tombstone(conn: &Connection, session_key: &str, id: &str) -> Result<Option<Node>> {
    conn.query_row(
        "SELECT * FROM ctx_nodes WHERE session_key = ?1 AND id = ?2 AND deleted = 1",
        params![session_key, id],
        node_from_row,
    )
    .optional()
}

/// Is `id` a live category of the session?
pub fn category_exists(conn: &Connection, session_key: &str, id: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM ctx_categories WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
            params![session_key, id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Turns of the chat that are no longer in its stored transcript because a
/// summary replaced them (`ctx_meta`, one row per session). The transcript is
/// stored summarized, so counting its prompts restarts at 1 after a summary;
/// this base keeps the tree's turn numbers absolute across turns. It survives
/// `ctx.reset` on purpose: it is a fact about the transcript, not the tree.
pub fn turn_base(conn: &Connection, session_key: &str) -> u32 {
    conn.query_row("SELECT value FROM ctx_meta WHERE key = ?1", params![turn_base_key(session_key)], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

/// Store the turn base of a session (see [`turn_base`]).
pub fn set_turn_base(conn: &Connection, session_key: &str, base: u32) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![turn_base_key(session_key), base.to_string()],
    )?;
    Ok(())
}

fn turn_base_key(session_key: &str) -> String {
    format!("turn_base:{session_key}")
}

/// Every live node of a session, newest first inside each category.
pub fn load_nodes(conn: &Connection, session_key: &str) -> Result<Vec<Node>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM ctx_nodes WHERE session_key = ?1 AND deleted = 0
         ORDER BY parent, ord, id",
    )?;
    let rows = stmt.query_map(params![session_key], node_from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Change an item's state and note in one statement.
pub fn set_state(
    conn: &Connection,
    session_key: &str,
    id: &str,
    state: ItemState,
    note: Option<&str>,
    now_ms: i64,
) -> Result<bool> {
    let n = conn.execute(
        "UPDATE ctx_nodes SET state = ?3, note = COALESCE(?4, note), node_rev = node_rev + 1,
            loaded_at = CASE WHEN ?3 = 'in' OR ?3 = 'note' THEN ?5 ELSE loaded_at END
         WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
        params![session_key, id, state.as_str(), note, now_ms],
    )?;
    Ok(n > 0)
}

/// Pin or unpin. A hard pin (locked/policy) is never overwritten by an AI pin.
pub fn set_pin(conn: &Connection, session_key: &str, id: &str, pin: Pin) -> Result<bool> {
    let n = conn.execute(
        "UPDATE ctx_nodes SET pin = ?3, node_rev = node_rev + 1
         WHERE session_key = ?1 AND id = ?2 AND deleted = 0 AND pin NOT IN ('locked','policy')",
        params![session_key, id, pin.as_str()],
    )?;
    Ok(n > 0)
}

/// Move a node to another home category; tags are kept.
pub fn move_node(conn: &Connection, session_key: &str, id: &str, parent: &str, order: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE ctx_nodes SET parent = ?3, ord = ?4, node_rev = node_rev + 1
         WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
        params![session_key, id, parent, order],
    )?;
    Ok(n > 0)
}

/// Add one AI tag (max four; the oldest is dropped).
pub fn add_tag(conn: &Connection, session_key: &str, id: &str, tag: &str) -> Result<bool> {
    let Some(node) = load_node(conn, session_key, id)? else { return Ok(false) };
    let mut tags = node.tags;
    if tags.iter().any(|t| t == tag) {
        return Ok(false);
    }
    tags.push(tag.to_string());
    while tags.len() > 4 {
        tags.remove(0);
    }
    let n = conn.execute(
        "UPDATE ctx_nodes SET tags = ?3, node_rev = node_rev + 1 WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
        params![session_key, id, serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into())],
    )?;
    Ok(n > 0)
}

/// Tombstone a node. The id stays taken forever.
pub fn delete_node(conn: &Connection, session_key: &str, id: &str) -> Result<bool> {
    let n = conn.execute(
        "UPDATE ctx_nodes SET deleted = 1, node_rev = node_rev + 1
         WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
        params![session_key, id],
    )?;
    Ok(n > 0)
}

/// Mark nodes as just used: this is what makes recency mean "recently relevant"
/// rather than "recently created".
pub fn touch(conn: &Connection, session_key: &str, ids: &[&str], now_ms: i64) -> Result<usize> {
    let mut n = 0;
    for id in ids {
        n += conn.execute(
            "UPDATE ctx_nodes SET last_used_at = ?3 WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
            params![session_key, id, now_ms],
        )?;
    }
    Ok(n)
}

/// Node count per kind, for quotas and for the checklist footer.
pub fn count_by_kind(conn: &Connection, session_key: &str) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT kind, COUNT(*) FROM ctx_nodes WHERE session_key = ?1 AND deleted = 0 GROUP BY kind",
    )?;
    let rows = stmt.query_map(params![session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ---------------------------------------------------------------- categories

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Category {
    pub id: String,
    pub parent: Option<String>,
    pub title: String,
    pub owner: String,
    pub order: i64,
    pub depth: i64,
    pub cap_tokens: Option<i64>,
    pub deleted: bool,
}

/// All categories of a session, including the built-in ones.
pub fn load_categories(conn: &Connection, session_key: &str) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent, title, owner, ord, depth, cap_tokens, deleted
         FROM ctx_categories WHERE session_key = ?1 ORDER BY depth, ord, id",
    )?;
    let rows = stmt.query_map(params![session_key], |r| {
        Ok(Category {
            id: r.get(0)?,
            parent: r.get(1)?,
            title: r.get(2)?,
            owner: r.get(3)?,
            order: r.get(4)?,
            depth: r.get(5)?,
            cap_tokens: r.get(6)?,
            deleted: r.get::<_, i64>(7)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Create or rename an AI category. Depth is capped at 6 so the tree cannot turn
/// into a maze the model spends calls navigating.
pub fn upsert_category(
    conn: &Connection,
    session_key: &str,
    id: &str,
    parent: Option<&str>,
    title: &str,
    owner: &str,
    cap_tokens: Option<i64>,
    now_ms: i64,
) -> Result<bool> {
    let depth = match parent {
        None => 0,
        Some(p) => conn
            .query_row(
                "SELECT depth + 1 FROM ctx_categories WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
                params![session_key, p],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0),
    };
    if depth > 6 {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO ctx_categories (session_key, id, parent, title, owner, ord, depth, cap_tokens, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8)
         ON CONFLICT(session_key, id) DO UPDATE SET
            parent = excluded.parent, title = excluded.title, depth = excluded.depth,
            cap_tokens = excluded.cap_tokens, deleted = 0
         WHERE ctx_categories.owner != 'system'",
        params![session_key, id, parent, title, owner, depth, cap_tokens, now_ms],
    )?;
    Ok(true)
}

/// Tombstone a category and re-home its nodes to the built-in catch-all, so no
/// node is ever orphaned by a delete.
pub fn delete_category(conn: &Connection, session_key: &str, id: &str, fallback: &str) -> Result<bool> {
    let owned: Option<String> = conn
        .query_row(
            "SELECT owner FROM ctx_categories WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
            params![session_key, id],
            |r| r.get(0),
        )
        .optional()?;
    match owned.as_deref() {
        None => return Ok(false),
        Some("system") => return Ok(false),
        Some(_) => {}
    }
    conn.execute(
        "UPDATE ctx_nodes SET parent = ?3, node_rev = node_rev + 1 WHERE session_key = ?1 AND parent = ?2",
        params![session_key, id, fallback],
    )?;
    conn.execute(
        "UPDATE ctx_nodes SET tags = '[]', node_rev = node_rev + 1 WHERE session_key = ?1 AND tags LIKE ?2",
        params![session_key, format!("%\"{id}\"%")],
    )?;
    conn.execute(
        "UPDATE ctx_categories SET deleted = 1 WHERE session_key = ?1 AND id = ?2",
        params![session_key, id],
    )?;
    Ok(true)
}

// ---------------------------------------------------------------- notes / temp / strategy

/// Write or update a note. Notes are the only content the model authors that the
/// tree itself owns; they are capped so a chat cannot fill the disk with prose.
pub fn put_note(
    conn: &Connection,
    session_key: &str,
    id: &str,
    title: &str,
    text: &str,
    category: &str,
    state: ItemState,
    now_ms: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_notes (session_key, id, title, text, category, state, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?7)
         ON CONFLICT(session_key, id) DO UPDATE SET
            title = excluded.title, text = excluded.text, category = excluded.category,
            state = excluded.state, updated_at = excluded.updated_at",
        params![session_key, id, title, text, category, state.as_str(), now_ms],
    )?;
    Ok(())
}

/// A note's body, for `recall`.
pub fn load_note(conn: &Connection, session_key: &str, id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT text FROM ctx_notes WHERE session_key = ?1 AND id = ?2",
            params![session_key, id],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn put_temp_summary(
    conn: &Connection,
    session_key: &str,
    id: &str,
    text: &str,
    focus: Option<&str>,
    sources: &[String],
    made_by: &str,
    tokens: u32,
    now_ms: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_temp_summaries (session_key, id, text, focus, sources, made_by, tokens, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(session_key, id) DO UPDATE SET
            text = excluded.text, focus = excluded.focus, sources = excluded.sources,
            made_by = excluded.made_by, tokens = excluded.tokens, created_at = excluded.created_at",
        params![
            session_key,
            id,
            text,
            focus,
            serde_json::to_string(sources).unwrap_or_else(|_| "[]".into()),
            made_by,
            tokens as i64,
            now_ms
        ],
    )?;
    Ok(())
}

pub fn load_temp_summary(conn: &Connection, session_key: &str, id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT text FROM ctx_temp_summaries WHERE session_key = ?1 AND id = ?2",
            params![session_key, id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Sources a temp summary stands in for.
pub fn temp_sources(conn: &Connection, session_key: &str, id: &str) -> Result<Vec<String>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT sources FROM ctx_temp_summaries WHERE session_key = ?1 AND id = ?2",
            params![session_key, id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
}

/// Never keep more than the newest 20 strategy versions: they are edits of one
/// document, and the model only ever needs the last few.
pub fn put_strategy(conn: &Connection, session_key: &str, text: &str, next_step: Option<&str>, now_ms: i64) -> Result<i64> {
    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM ctx_strategy WHERE session_key = ?1",
            params![session_key],
            |r| r.get(0),
        )
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO ctx_strategy (session_key, version, text, steps, next_step, at) VALUES (?1,?2,?3,'[]',?4,?5)",
        params![session_key, version, text, next_step, now_ms],
    )?;
    conn.execute(
        "DELETE FROM ctx_strategy WHERE session_key = ?1 AND version <= ?2",
        params![session_key, version - 20],
    )?;
    Ok(version)
}

pub fn latest_strategy(conn: &Connection, session_key: &str) -> Result<Option<(i64, String, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT version, text, next_step FROM ctx_strategy WHERE session_key = ?1 ORDER BY version DESC LIMIT 1",
            params![session_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

// ---------------------------------------------------------------- action log

/// One line of "why did this happen", written by every actor: model, policy,
/// user and engine. Without it the checklist cannot answer "why is this out?".
#[derive(Debug, Clone, Default)]
pub struct LogEntry {
    pub actor: String,
    pub tool: Option<String>,
    pub ops: String,
    pub rev_before: i64,
    pub rev_after: i64,
    pub tokens_before: usize,
    pub tokens_after: usize,
    pub reason: Option<String>,
    pub turn: Option<u32>,
    pub step: Option<u32>,
}

pub fn log_action(conn: &Connection, session_key: &str, e: &LogEntry, now_ms: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_action_log (session_key, at, turn, step, actor, tool, ops, rev_before, rev_after,
            tokens_before, tokens_after, reason)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            session_key,
            now_ms,
            e.turn.map(|v| v as i64),
            e.step.map(|v| v as i64),
            e.actor,
            e.tool,
            e.ops,
            e.rev_before,
            e.rev_after,
            e.tokens_before as i64,
            e.tokens_after as i64,
            e.reason
        ],
    )?;
    Ok(())
}

/// The newest entries first, for the UI and for `ctx` explanations.
pub fn load_log(conn: &Connection, session_key: &str, limit: usize) -> Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "SELECT seq, at, turn, step, actor, tool, ops, rev_before, rev_after, tokens_before,
                tokens_after, reason
         FROM ctx_action_log WHERE session_key = ?1 ORDER BY seq DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![session_key, limit as i64], |r| {
        Ok(serde_json::json!({
            "seq": r.get::<_, i64>(0)?,
            "at": r.get::<_, i64>(1)?,
            "turn": r.get::<_, Option<i64>>(2)?,
            "step": r.get::<_, Option<i64>>(3)?,
            "actor": r.get::<_, String>(4)?,
            "tool": r.get::<_, Option<String>>(5)?,
            "ops": r.get::<_, String>(6)?,
            "revBefore": r.get::<_, Option<i64>>(7)?,
            "revAfter": r.get::<_, Option<i64>>(8)?,
            "tokensBefore": r.get::<_, Option<i64>>(9)?,
            "tokensAfter": r.get::<_, Option<i64>>(10)?,
            "reason": r.get::<_, Option<String>>(11)?,
        }))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ---------------------------------------------------------------- gc

/// Trim the oldest nodes of each kind until the session is inside its quotas.
///
/// Order of sacrifice, cheapest first: tool results, then files, then turn parts,
/// then whole turns. Notes, strategy, essentials and anything pinned are never
/// trimmed — they are the model's own memory, not raw material.
pub fn enforce_quotas(conn: &Connection, session_key: &str, quotas: Quotas) -> Result<GcReport> {
    let mut report = GcReport::default();
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ctx_nodes WHERE session_key = ?1 AND deleted = 0",
        params![session_key],
        |r| r.get(0),
    )?;
    if total > quotas.nodes {
        let excess = total - quotas.nodes;
        let sacrifiable = ["result", "file", "turnPart", "turn", "tempSummary", "subagent"];
        for kind in sacrifiable {
            if report.nodes_trimmed as i64 >= excess {
                break;
            }
            let mut stmt = conn.prepare(
                "SELECT id FROM ctx_nodes
                 WHERE session_key = ?1 AND deleted = 0 AND kind = ?2
                   AND pin NOT IN ('locked','policy') AND state != 'in'
                 ORDER BY COALESCE(last_used_at, created_at), id
                 LIMIT ?3",
            )?;
            let ids: Vec<String> = stmt
                .query_map(params![session_key, kind, excess - report.nodes_trimmed as i64], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            for id in ids {
                if delete_node(conn, session_key, &id)? {
                    report.nodes_trimmed += 1;
                }
            }
        }
    }
    let notes_bytes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(text)), 0) FROM ctx_notes WHERE session_key = ?1",
        params![session_key],
        |r| r.get(0),
    )?;
    if notes_bytes > quotas.bytes_notes {
        let mut stmt = conn.prepare(
            "SELECT id, LENGTH(text) FROM ctx_notes WHERE session_key = ?1 ORDER BY updated_at, id",
        )?;
        let rows: Vec<(String, i64)> = stmt
            .query_map(params![session_key], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        let mut over = notes_bytes - quotas.bytes_notes;
        for (id, len) in rows {
            if over <= 0 {
                break;
            }
            conn.execute("DELETE FROM ctx_notes WHERE session_key = ?1 AND id = ?2", params![session_key, id])?;
            conn.execute(
                "UPDATE ctx_nodes SET deleted = 1 WHERE session_key = ?1 AND id = ?2",
                params![session_key, id],
            )?;
            over -= len;
            report.notes_trimmed += 1;
            report.bytes_freed += len;
        }
    }
    let temp_bytes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(text)), 0) FROM ctx_temp_summaries WHERE session_key = ?1",
        params![session_key],
        |r| r.get(0),
    )?;
    if temp_bytes > quotas.bytes_temp {
        let mut stmt = conn.prepare(
            "SELECT id, LENGTH(text) FROM ctx_temp_summaries WHERE session_key = ?1 ORDER BY created_at, id",
        )?;
        let rows: Vec<(String, i64)> = stmt
            .query_map(params![session_key], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        let mut over = temp_bytes - quotas.bytes_temp;
        for (id, len) in rows {
            if over <= 0 {
                break;
            }
            conn.execute("DELETE FROM ctx_temp_summaries WHERE session_key = ?1 AND id = ?2", params![session_key, id])?;
            conn.execute(
                "UPDATE ctx_nodes SET deleted = 1 WHERE session_key = ?1 AND id = ?2",
                params![session_key, id],
            )?;
            over -= len;
            report.temp_trimmed += 1;
            report.bytes_freed += len;
        }
    }
    Ok(report)
}

/// Everything one session holds, for the UI's storage row.
pub fn storage_report(conn: &Connection, session_key: &str) -> Result<serde_json::Value> {
    let nodes: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ctx_nodes WHERE session_key = ?1 AND deleted = 0",
        params![session_key],
        |r| r.get(0),
    )?;
    let tombstones: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ctx_nodes WHERE session_key = ?1 AND deleted = 1",
        params![session_key],
        |r| r.get(0),
    )?;
    let bytes: i64 = conn.query_row(
        "SELECT COALESCE((SELECT SUM(LENGTH(text)) FROM ctx_notes WHERE session_key = ?1), 0)
              + COALESCE((SELECT SUM(LENGTH(text)) FROM ctx_temp_summaries WHERE session_key = ?1), 0)
              + COALESCE((SELECT SUM(LENGTH(text)) FROM ctx_strategy WHERE session_key = ?1), 0)",
        params![session_key],
        |r| r.get(0),
    )?;
    Ok(serde_json::json!({
        "nodes": nodes,
        "tombstones": tombstones,
        "bytes": bytes,
        "rev": rev(conn, session_key)?,
        "schema": schema_version(conn),
    }))
}

// ---------------------------------------------------------------- rewind / reset

/// The chat was rewound to `keep_turns` turns (or its memory reset, with
/// `keep_turns = 0`): every turn node after that point describes a turn that no
/// longer exists. They are tombstoned, their notes cleared, so a new turn that
/// gets the same number is indexed fresh (state `in`) instead of inheriting the
/// old turn's `out`/`note` decision and its stale note text.
///
/// Returns how many nodes were retired. Bumps the revision and writes one
/// `engine` line to the action log when anything changed. Safe to call inside
/// the caller's transaction (it opens none of its own).
pub fn forget_turns_after(conn: &Connection, session_key: &str, keep_turns: u32, reason: &str, now_ms: i64) -> Result<usize> {
    // `keep_turns` counts the stored transcript; the tree numbers turns over the
    // whole chat, summarized turns included.
    let keep_turns = keep_turns.saturating_add(turn_base(conn, session_key));
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM ctx_nodes
             WHERE session_key = ?1 AND deleted = 0 AND kind IN ('turn','turnPart') AND turn > ?2
             ORDER BY turn, id",
        )?;
        let rows = stmt.query_map(params![session_key, keep_turns as i64], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if ids.is_empty() {
        return Ok(0);
    }
    conn.execute(
        "UPDATE ctx_nodes SET deleted = 1, note = NULL, state = 'in', pin = 'none', tags = '[]', node_rev = node_rev + 1
         WHERE session_key = ?1 AND deleted = 0 AND kind IN ('turn','turnPart') AND turn > ?2",
        params![session_key, keep_turns as i64],
    )?;
    let before = rev(conn, session_key)?;
    let after = bump_rev(conn, session_key, now_ms)?;
    let entry = LogEntry {
        actor: "engine".into(),
        tool: None,
        ops: serde_json::json!({"op": "forget_turns", "keptTurns": keep_turns, "ids": ids}).to_string(),
        rev_before: before,
        rev_after: after,
        reason: Some(reason.to_string()),
        ..LogEntry::default()
    };
    log_action(conn, session_key, &entry, now_ms)?;
    Ok(ids.len())
}

/// What [`reset_session`] removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResetReport {
    pub nodes: usize,
    pub notes: usize,
    pub temp_summaries: usize,
    pub strategy_versions: usize,
    pub log_rows: usize,
}

/// `ctx.reset`: drop every `ctx_*` row of one session. Other sessions and the
/// global settings in `ctx_meta` are untouched. The next request seeds the
/// built-in categories again and re-indexes the chat from its transcript.
pub fn reset_session(conn: &Connection, session_key: &str) -> Result<ResetReport> {
    let mut r = ResetReport::default();
    r.nodes = conn.execute("DELETE FROM ctx_nodes WHERE session_key = ?1", params![session_key])?;
    r.notes = conn.execute("DELETE FROM ctx_notes WHERE session_key = ?1", params![session_key])?;
    r.temp_summaries = conn.execute("DELETE FROM ctx_temp_summaries WHERE session_key = ?1", params![session_key])?;
    r.strategy_versions = conn.execute("DELETE FROM ctx_strategy WHERE session_key = ?1", params![session_key])?;
    r.log_rows = conn.execute("DELETE FROM ctx_action_log WHERE session_key = ?1", params![session_key])?;
    conn.execute("DELETE FROM ctx_categories WHERE session_key = ?1", params![session_key])?;
    conn.execute("DELETE FROM ctx_sessions WHERE session_key = ?1", params![session_key])?;
    // The memory part of the checklist (picks, tags, versions, files) goes
    // with the tree; the memory itself is kept.
    super::memory_checklist::reset_session(conn, session_key)?;
    // The task context policy rows of the chat (pin, tasks, events) go too.
    crate::context_policy::store::reset_session(conn, session_key)?;
    Ok(r)
}

/// Keep the action log of one session at most `max_rows` long (oldest go
/// first). Returns how many rows were removed.
pub fn trim_action_log(conn: &Connection, session_key: &str, max_rows: i64) -> Result<usize> {
    let n = conn.execute(
        "DELETE FROM ctx_action_log WHERE session_key = ?1 AND seq NOT IN (
            SELECT seq FROM ctx_action_log WHERE session_key = ?1 ORDER BY seq DESC LIMIT ?2)",
        params![session_key, max_rows.max(0)],
    )?;
    Ok(n)
}

/// Remove old tombstones of engine material (turns, turn parts, tool results,
/// files), keeping the newest `keep`. Those ids are derived from the material
/// itself, so a tombstone protects nothing once the material is gone; without
/// this every folded turn left a row behind forever. Model-authored tombstones
/// (notes, temp summaries, strategy) are kept: their numbers are never reused.
pub fn purge_tombstones(conn: &Connection, session_key: &str, keep: i64) -> Result<usize> {
    let n = conn.execute(
        "DELETE FROM ctx_nodes WHERE session_key = ?1 AND deleted = 1
           AND kind IN ('turn','turnPart','result','file')
           AND id NOT IN (
             SELECT id FROM ctx_nodes WHERE session_key = ?1 AND deleted = 1
               AND kind IN ('turn','turnPart','result','file')
             ORDER BY COALESCE(turn, 0) DESC, created_at DESC, id DESC LIMIT ?2)",
        params![session_key, keep.max(0)],
    )?;
    Ok(n)
}

/// Engine-material tombstones kept per session by [`purge_tombstones`].
pub const KEEP_TOMBSTONES: i64 = 500;

/// Rows the action log keeps per session (plan §6.6).
pub const MAX_ACTION_LOG_ROWS: i64 = 20_000;

/// How often the quotas run: every this many turns of a session (plan §6.6).
pub const GC_EVERY_TURNS: u32 = 50;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::model::{NodeKind, Owner};

    #[test]
    fn a_rewind_retires_later_turn_nodes_so_a_new_turn_starts_fresh() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        for t in 1..=5u32 {
            let mut n = node("s1", &format!("turn/t{t}"), NodeKind::Turn, ItemState::Out, Pin::None);
            n.turn = Some(t);
            n.note = Some(format!("old note {t}"));
            upsert_node(&conn, &n).unwrap();
        }
        let mut other = node("s2", "turn/t4", NodeKind::Turn, ItemState::Out, Pin::None);
        other.turn = Some(4);
        upsert_node(&conn, &other).unwrap();
        let rev0 = rev(&conn, "s1").unwrap();

        assert_eq!(forget_turns_after(&conn, "s1", 3, "the chat was rewound", 2_000).unwrap(), 2);
        assert!(load_node(&conn, "s1", "turn/t3").unwrap().is_some());
        assert!(load_node(&conn, "s1", "turn/t4").unwrap().is_none());
        assert!(load_node(&conn, "s1", "turn/t5").unwrap().is_none());
        assert!(load_node(&conn, "s2", "turn/t4").unwrap().is_some(), "another chat is untouched");
        assert_eq!(rev(&conn, "s1").unwrap(), rev0 + 1);
        let log: String = conn
            .query_row("SELECT actor || ':' || reason FROM ctx_action_log WHERE session_key = 's1' ORDER BY seq DESC LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(log, "engine:the chat was rewound");

        // The new turn 4 is indexed again: it comes back `in`, without the old note.
        let mut fresh = node("s1", "turn/t4", NodeKind::Turn, ItemState::In, Pin::None);
        fresh.turn = Some(4);
        upsert_node(&conn, &fresh).unwrap();
        let back = load_node(&conn, "s1", "turn/t4").unwrap().unwrap();
        assert_eq!(back.state, ItemState::In);
        assert_eq!(back.note, None);

        // Nothing after the kept turns: no change, no revision.
        let r = rev(&conn, "s1").unwrap();
        assert_eq!(forget_turns_after(&conn, "s1", 10, "again", 3_000).unwrap(), 0);
        assert_eq!(rev(&conn, "s1").unwrap(), r);
    }

    #[test]
    fn reset_session_drops_only_that_sessions_rows() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        ensure_session(&conn, "s2", 1_000).unwrap();
        upsert_node(&conn, &node("s1", "note/n1", NodeKind::Note, ItemState::In, Pin::None)).unwrap();
        put_note(&conn, "s1", "note/n1", "t", "body", "notes", ItemState::In, 1_000).unwrap();
        upsert_node(&conn, &node("s2", "note/n1", NodeKind::Note, ItemState::In, Pin::None)).unwrap();
        let r = reset_session(&conn, "s1").unwrap();
        assert_eq!(r.nodes, 1);
        assert_eq!(r.notes, 1);
        assert!(load_nodes(&conn, "s1").unwrap().is_empty());
        assert_eq!(rev(&conn, "s1").unwrap(), 0);
        assert_eq!(load_nodes(&conn, "s2").unwrap().len(), 1);
    }

    #[test]
    fn old_material_tombstones_are_purged_and_notes_kept() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        for t in 1..=6u32 {
            let mut n = node("s1", &format!("turn/t{t}"), NodeKind::Turn, ItemState::Out, Pin::None);
            n.turn = Some(t);
            upsert_node(&conn, &n).unwrap();
            delete_node(&conn, "s1", &format!("turn/t{t}")).unwrap();
        }
        upsert_node(&conn, &node("s1", "note/n1", NodeKind::Note, ItemState::In, Pin::None)).unwrap();
        delete_node(&conn, "s1", "note/n1").unwrap();
        assert_eq!(purge_tombstones(&conn, "s1", 2).unwrap(), 4);
        let left: Vec<String> = conn
            .prepare("SELECT id FROM ctx_nodes WHERE session_key = 's1' ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(left, vec!["note/n1", "turn/t5", "turn/t6"]);
    }

    #[test]
    fn the_action_log_is_trimmed_oldest_first() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        for i in 0..10 {
            log_action(&conn, "s1", &LogEntry { actor: "model".into(), ops: format!("op{i}"), ..LogEntry::default() }, 1_000 + i).unwrap();
        }
        assert_eq!(trim_action_log(&conn, "s1", 4).unwrap(), 6);
        let ops: Vec<String> = conn
            .prepare("SELECT ops FROM ctx_action_log WHERE session_key = 's1' ORDER BY seq")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ops, vec!["op6", "op7", "op8", "op9"]);
    }


    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        ensure_tables(&conn).expect("tables");
        conn
    }

    fn node(session: &str, id: &str, kind: NodeKind, state: ItemState, pin: Pin) -> Node {
        Node {
            id: NodeId::parse(id).expect("id"),
            session_key: session.to_string(),
            kind,
            parent: kind.home_category().to_string(),
            tags: vec![],
            order: 0,
            title: format!("node {id}"),
            state,
            pin,
            owner: Owner::Policy,
            tokens_full: 100,
            tokens_note: 10,
            token_model: "t".into(),
            note: None,
            provenance: Provenance::default(),
            created_at: 1_000,
            last_used_at: None,
            loaded_at: None,
            turn: None,
            rev: 1,
            deleted: false,
        }
    }

    #[test]
    fn tables_are_created_and_versioned_independently_of_the_engine() {
        let conn = db();
        assert_eq!(schema_version(&conn), Some(CTX_SCHEMA_VERSION));
        // Calling it twice must not fail or reset anything.
        ensure_tables(&conn).unwrap();
        assert_eq!(schema_version(&conn), Some(CTX_SCHEMA_VERSION));
        // The engine's pragma is untouched: we never write it.
        let uv: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(uv, 0);
    }

    #[test]
    fn an_engine_v6_database_keeps_its_version_and_gains_only_our_tables() {
        // A session database that the engine already owns: it uses PRAGMA
        // user_version for its own schema and has its own tables.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE turn_archive (session_key TEXT, turn INTEGER, body TEXT);
             INSERT INTO turn_archive VALUES ('s1', 1, 'their data');
             PRAGMA user_version = 6;",
        )
        .unwrap();
        ensure_tables(&conn).unwrap();
        let uv: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(uv, 6, "the engine's own schema version is not ours to move");
        assert_eq!(schema_version(&conn), Some(CTX_SCHEMA_VERSION));
        // Their rows are untouched, and a second open is a no-op.
        let body: String = conn
            .query_row("SELECT body FROM turn_archive WHERE session_key = 's1' AND turn = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "their data");
        ensure_tables(&conn).unwrap();
        ensure_session(&conn, "s1", 1_000).unwrap();
        assert_eq!(schema_version(&conn), Some(CTX_SCHEMA_VERSION));
        let uv: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(uv, 6);
    }

    #[test]
    fn a_session_starts_with_its_builtin_categories_and_rev_zero() {
        let conn = db();
        assert_eq!(ensure_session(&conn, "s1", 1_000).unwrap(), 0);
        let cats = load_categories(&conn, "s1").unwrap();
        assert_eq!(cats.len(), BUILTIN_CATEGORIES.len());
        assert!(cats.iter().any(|c| c.id == "sys" && c.owner == "system"));
        // Idempotent: a second call does not duplicate anything.
        ensure_session(&conn, "s1", 2_000).unwrap();
        assert_eq!(load_categories(&conn, "s1").unwrap().len(), BUILTIN_CATEGORIES.len());
    }

    #[test]
    fn ids_only_move_forward_even_after_deletion() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        let a = next_node_id(&conn, "s1", NodeKind::Turn, 1_000).unwrap();
        let b = next_node_id(&conn, "s1", NodeKind::Turn, 1_000).unwrap();
        assert_ne!(a, b);
        let mut n = node("s1", a.as_str(), NodeKind::Turn, ItemState::In, Pin::None);
        n.id = a.clone();
        upsert_node(&conn, &n).unwrap();
        delete_node(&conn, "s1", a.as_str()).unwrap();
        let c = next_node_id(&conn, "s1", NodeKind::Turn, 1_000).unwrap();
        assert_ne!(a, c, "a deleted id must never come back");
        assert_ne!(b, c);
    }

    #[test]
    fn nodes_round_trip_and_stay_inside_their_session() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        ensure_session(&conn, "s2", 1_000).unwrap();
        let mut n = node("s1", "turn/t1", NodeKind::Turn, ItemState::In, Pin::None);
        n.tags = vec!["cat/c1".into()];
        n.note = Some("kept because the user asked".into());
        n.provenance = Provenance { source: "memory".into(), locator: Some("t1".into()), ..Default::default() };
        upsert_node(&conn, &n).unwrap();
        let back = load_node(&conn, "s1", "turn/t1").unwrap().expect("node");
        assert_eq!(back.state, ItemState::In);
        assert_eq!(back.tags, vec!["cat/c1".to_string()]);
        assert_eq!(back.note.as_deref(), Some("kept because the user asked"));
        assert_eq!(back.provenance.locator.as_deref(), Some("t1"));
        assert!(load_node(&conn, "s2", "turn/t1").unwrap().is_none(), "no cross-session reads");
        assert!(load_nodes(&conn, "s2").unwrap().is_empty());
    }

    #[test]
    fn a_hard_pin_cannot_be_downgraded_by_the_model() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        upsert_node(&conn, &node("s1", "sys/core", NodeKind::SysPart, ItemState::In, Pin::Locked)).unwrap();
        assert!(!set_pin(&conn, "s1", "sys/core", Pin::None).unwrap(), "locked must win");
        let back = load_node(&conn, "s1", "sys/core").unwrap().unwrap();
        assert_eq!(back.pin, Pin::Locked);
        assert!(back.pin.is_hard());
    }

    #[test]
    fn deleting_a_category_rehomes_its_nodes_instead_of_orphaning_them() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        assert!(upsert_category(&conn, "s1", "cat/c1", None, "Migrations", "ai", Some(9_000), 1_000).unwrap());
        let mut n = node("s1", "file/f1", NodeKind::File, ItemState::Out, Pin::None);
        n.parent = "cat/c1".into();
        n.tags = vec!["cat/c1".into()];
        upsert_node(&conn, &n).unwrap();

        assert!(!delete_category(&conn, "s1", "sys", "turns").unwrap(), "built-ins are not deletable");
        assert!(delete_category(&conn, "s1", "cat/c1", "files").unwrap());
        let back = load_node(&conn, "s1", "file/f1").unwrap().unwrap();
        assert_eq!(back.parent, "files", "rehomed, not orphaned");
        assert!(back.tags.is_empty(), "the dead category is gone from tags");
        assert_eq!(load_categories(&conn, "s1").unwrap().iter().filter(|c| !c.deleted).count(), BUILTIN_CATEGORIES.len());
    }

    #[test]
    fn category_depth_is_capped() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        let mut parent = "turns".to_string();
        for i in 0..8 {
            let id = format!("cat/d{i}");
            upsert_category(&conn, "s1", &id, Some(&parent), "deep", "ai", None, 1_000).unwrap();
            parent = id;
        }
        let cats = load_categories(&conn, "s1").unwrap();
        assert!(cats.iter().all(|c| c.depth <= 6), "depth must stay navigable");
    }

    #[test]
    fn tags_are_capped_at_four_and_never_duplicated() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        upsert_node(&conn, &node("s1", "turn/t1", NodeKind::Turn, ItemState::Out, Pin::None)).unwrap();
        for i in 0..6 {
            add_tag(&conn, "s1", "turn/t1", &format!("cat/c{i}")).unwrap();
        }
        assert!(!add_tag(&conn, "s1", "turn/t1", "cat/c5").unwrap(), "already tagged");
        let back = load_node(&conn, "s1", "turn/t1").unwrap().unwrap();
        assert_eq!(back.tags.len(), 4);
        assert_eq!(back.tags.last().map(String::as_str), Some("cat/c5"));
    }

    #[test]
    fn the_action_log_answers_why_an_item_left() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        let e = LogEntry {
            actor: "model".into(),
            tool: Some("ctx".into()),
            ops: r#"[{"id":"turn/t9","action":"exclude"}]"#.into(),
            rev_before: 3,
            rev_after: 4,
            tokens_before: 9_000,
            tokens_after: 7_400,
            reason: Some("budget".into()),
            turn: Some(12),
            step: Some(2),
        };
        log_action(&conn, "s1", &e, 5_000).unwrap();
        let log = load_log(&conn, "s1", 10).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0]["actor"], "model");
        assert_eq!(log[0]["tokensBefore"], 9_000);
        assert_eq!(log[0]["reason"], "budget");
        assert!(load_log(&conn, "s2", 10).unwrap().is_empty());
    }

    #[test]
    fn strategy_keeps_only_the_newest_twenty_versions() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        for i in 0..25 {
            put_strategy(&conn, "s1", &format!("v{i}"), Some("step"), 1_000 + i).unwrap();
        }
        let (version, text, _) = latest_strategy(&conn, "s1").unwrap().expect("strategy");
        assert_eq!(version, 25);
        assert_eq!(text, "v24");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ctx_strategy WHERE session_key = 's1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 20);
    }

    #[test]
    fn gc_trims_raw_material_and_never_the_models_own_memory() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        for i in 0..30 {
            let mut n = node("s1", &format!("res/R{i}"), NodeKind::Result, ItemState::Out, Pin::None);
            n.created_at = 1_000 + i as i64;
            upsert_node(&conn, &n).unwrap();
        }
        upsert_node(&conn, &node("s1", "res/PIN", NodeKind::Result, ItemState::Out, Pin::Locked)).unwrap();
        upsert_node(&conn, &node("s1", "res/IN", NodeKind::Result, ItemState::In, Pin::None)).unwrap();
        upsert_node(&conn, &node("s1", "note/n1", NodeKind::Note, ItemState::In, Pin::None)).unwrap();

        let report = enforce_quotas(&conn, "s1", Quotas { nodes: 20, ..Quotas::default() }).unwrap();
        assert!(report.nodes_trimmed > 0);
        let live = load_nodes(&conn, "s1").unwrap();
        assert!(live.len() <= 21, "got {}", live.len());
        assert!(live.iter().any(|n| n.id.as_str() == "res/PIN"), "pinned survives gc");
        assert!(live.iter().any(|n| n.id.as_str() == "res/IN"), "selected items survive gc");
        assert!(live.iter().any(|n| n.id.as_str() == "note/n1"), "notes survive gc");
        assert!(!live.iter().any(|n| n.id.as_str() == "res/R0"), "the oldest result goes first");
    }

    #[test]
    fn note_and_temp_budgets_are_enforced() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        for i in 0..5 {
            put_note(&conn, "s1", &format!("note/n{i}"), "t", &"x".repeat(100), "notes", ItemState::In, 1_000 + i).unwrap();
        }
        let report = enforce_quotas(&conn, "s1", Quotas { bytes_notes: 250, ..Quotas::default() }).unwrap();
        assert!(report.notes_trimmed >= 2);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM ctx_notes WHERE session_key = 's1'", [], |r| r.get(0))
            .unwrap();
        assert!(left <= 2, "left {left}");
    }

    #[test]
    fn temp_summaries_remember_what_they_replaced() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        let sources = vec!["turn/t1".to_string(), "turn/t2".to_string()];
        put_temp_summary(&conn, "s1", "tmp/s1", "they talked about X", Some("X"), &sources, "model", 40, 1_000).unwrap();
        assert_eq!(temp_sources(&conn, "s1", "tmp/s1").unwrap(), sources);
        assert_eq!(load_temp_summary(&conn, "s1", "tmp/s1").unwrap().as_deref(), Some("they talked about X"));
    }

    #[test]
    fn storage_report_is_honest_about_tombstones() {
        let conn = db();
        ensure_session(&conn, "s1", 1_000).unwrap();
        upsert_node(&conn, &node("s1", "turn/t1", NodeKind::Turn, ItemState::Out, Pin::None)).unwrap();
        delete_node(&conn, "s1", "turn/t1").unwrap();
        let r = storage_report(&conn, "s1").unwrap();
        assert_eq!(r["nodes"], 0);
        assert_eq!(r["tombstones"], 1);
    }
}
