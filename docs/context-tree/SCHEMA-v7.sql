-- Context tree — schema v7 (additive only: nothing is dropped, nothing renamed)
--
-- Store rules the Rust side relies on:
--   * nodes are an INDEX over existing storage (turn_archive, tool_results,
--     workspace files, turn_memory segments, sub-agent records); only temp
--     summaries, notes, strategy, categories and the action log own content here;
--   * every row is scoped by session_key; there is no cross-session query;
--   * one transaction per tree revision (`rev` is bumped on the session row);
--   * a deleted node keeps a tombstone so an id is never reused.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ctx_sessions (
    session_key   TEXT PRIMARY KEY,
    rev           INTEGER NOT NULL DEFAULT 0,   -- tree revision, bumped per commit
    next_node_no  INTEGER NOT NULL DEFAULT 1,   -- ids are never reused
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ctx_nodes (
    session_key   TEXT NOT NULL,
    id            TEXT NOT NULL,
    kind          TEXT NOT NULL,               -- sysPart | essential | turn | turnPart | summary |
                                               -- result | file | tempSummary | note | strategy | subagent | category
    parent        TEXT NOT NULL,               -- home category id
    tags          TEXT NOT NULL DEFAULT '[]',  -- extra AI category ids (max 4)
    ord           INTEGER NOT NULL DEFAULT 0,  -- gaps of 1024 so reordering is cheap
    title         TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'out', -- in | note | temp | out
    pin           TEXT NOT NULL DEFAULT 'none',-- none | locked | policy | ai
    owner         TEXT NOT NULL DEFAULT 'policy', -- system | policy | ai | subagent:<id>
    tokens_full   INTEGER NOT NULL DEFAULT 0,
    tokens_note   INTEGER NOT NULL DEFAULT 0,
    token_model   TEXT NOT NULL DEFAULT '',
    note          TEXT,
    source        TEXT NOT NULL DEFAULT 'engine',
    locator       TEXT,
    range         TEXT,
    turn          INTEGER,
    call_index    INTEGER,
    content_hash  TEXT,
    temp_of       TEXT,                        -- for nodes in state 'temp'
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    loaded_at     INTEGER,
    rev           INTEGER NOT NULL DEFAULT 1,
    deleted       INTEGER NOT NULL DEFAULT 0,  -- tombstone
    PRIMARY KEY (session_key, id)
);
CREATE INDEX IF NOT EXISTS ctx_nodes_parent ON ctx_nodes(session_key, parent, ord);
CREATE INDEX IF NOT EXISTS ctx_nodes_state  ON ctx_nodes(session_key, state);
CREATE INDEX IF NOT EXISTS ctx_nodes_lru    ON ctx_nodes(session_key, last_used_at);

CREATE TABLE IF NOT EXISTS ctx_categories (
    session_key  TEXT NOT NULL,
    id           TEXT NOT NULL,
    parent       TEXT,                          -- NULL = root
    title        TEXT NOT NULL,
    owner        TEXT NOT NULL,                 -- system | policy | ai
    ord          INTEGER NOT NULL DEFAULT 0,
    depth        INTEGER NOT NULL DEFAULT 0,    -- max 6
    cap_tokens   INTEGER,                       -- per-category budget cap (NULL = none)
    created_at   INTEGER NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_key, id)
);
CREATE INDEX IF NOT EXISTS ctx_categories_parent ON ctx_categories(session_key, parent, ord);

CREATE TABLE IF NOT EXISTS ctx_notes (
    session_key TEXT NOT NULL,
    id          TEXT NOT NULL,
    title       TEXT NOT NULL,
    text        TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'notes',
    state       TEXT NOT NULL DEFAULT 'in',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (session_key, id)
);

CREATE TABLE IF NOT EXISTS ctx_temp_summaries (
    session_key   TEXT NOT NULL,
    id            TEXT NOT NULL,
    text          TEXT NOT NULL,
    focus         TEXT,
    sources       TEXT NOT NULL DEFAULT '[]',  -- node ids the summary replaces
    source_hashes TEXT NOT NULL DEFAULT '[]',  -- content hashes at summarization time
    made_by       TEXT NOT NULL,               -- 'model' | 'subagent:<id>'
    tokens        INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (session_key, id)
);

CREATE TABLE IF NOT EXISTS ctx_strategy_versions (
    session_key TEXT NOT NULL,
    version     INTEGER NOT NULL,             -- keep the newest 20
    text        TEXT NOT NULL,
    steps       TEXT NOT NULL DEFAULT '[]',   -- [{n,text,done,done_at}]
    next_step   TEXT,
    at          INTEGER NOT NULL,
    PRIMARY KEY (session_key, version)
);

-- "Why is this out?" — one row per applied op, by any actor.
CREATE TABLE IF NOT EXISTS ctx_action_log (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key   TEXT NOT NULL,
    at            INTEGER NOT NULL,
    turn          INTEGER,
    step          INTEGER,
    actor         TEXT NOT NULL,               -- model | policy | user | engine
    tool          TEXT,                        -- ctx / ctx_view / policy / ...
    ops           TEXT NOT NULL,               -- JSON array of applied ops
    rev_before    INTEGER,
    rev_after     INTEGER,
    tokens_before INTEGER,
    tokens_after  INTEGER,
    reason        TEXT                         -- 'budget' | 'warn_hard' | 'pin_override' | 'gc' | ...
);
CREATE INDEX IF NOT EXISTS ctx_action_log_session ON ctx_action_log(session_key, seq);
CREATE INDEX IF NOT EXISTS ctx_action_log_actor   ON ctx_action_log(session_key, actor, seq);

CREATE TABLE IF NOT EXISTS ctx_quotas (
    session_key   TEXT PRIMARY KEY,
    nodes         INTEGER NOT NULL DEFAULT 0,
    bytes_notes   INTEGER NOT NULL DEFAULT 0,
    bytes_temp    INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);

-- Per-kind quotas: one global node cap breaks long chats (≈4.5 nodes per turn
-- means a 4,000-node cap is ~850 turns). GC trims the oldest of each kind.
INSERT OR IGNORE INTO ctx_quotas (session_key, nodes, bytes_notes, bytes_temp, updated_at)
VALUES ('__defaults__', 4000, 524288, 1048576, 0);
