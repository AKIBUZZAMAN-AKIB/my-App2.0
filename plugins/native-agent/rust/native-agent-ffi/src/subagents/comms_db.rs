//! A chat team's coordination state in the database (unified plan, Phase 3).
//!
//! `ChatComms` keeps its shape in memory, so every protocol and every tool
//! works as before; what changes is where it is kept. Its config stays in
//! `comms.json`; its data (blackboard, topics, swarm state, counters) is
//! written to the room tables of `ws::board` for the room `team:<root>`.
//! `CommsStore::attach_db` moves an old `comms.json` into those tables once,
//! in one transaction with a count check.

use super::channels::{BoardEntry, ChatComms, Post, Topic};
use super::swarm::{Auction, Ballot, Bid, Debate, DebateTurn, Election, Handoff, Rumor, SwarmState, Vote};
use crate::ws::board::{self, id_of, pid_of};
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};

/// The `ws_meta` marker of the one-time `comms.json` move.
pub const MIGRATED_MARK: &str = "comms_json_migrated";

fn e2s(e: rusqlite::Error) -> String {
    e.to_string()
}

/// The room of a chat root.
pub fn room_of(root: &str) -> String {
    format!("team:{root}")
}

/// True when the chat holds any coordination data (not just config).
pub fn has_data(c: &ChatComms) -> bool {
    !c.topics.is_empty()
        || !c.blackboard.is_empty()
        || c.message_count > 0
        || c.compactions > 0
        || c.board_digest.count > 0
        || !swarm_is_empty(&c.swarm)
}

fn swarm_is_empty(s: &SwarmState) -> bool {
    s.auctions.is_empty() && s.votes.is_empty() && s.debates.is_empty() && s.elections.is_empty() && s.rumors.is_empty() && s.handoffs.is_empty() && s.coordinator.is_none() && s.term == 0 && s.active_agent.is_none() && s.digests.is_empty()
}

/// Rows one chat writes, per table, for the migration's count check:
/// (board, topics, subscriptions, playbooks, events).
pub fn expected_rows(c: &ChatComms) -> [i64; 5] {
    let s = &c.swarm;
    let subs: usize = c.topics.values().map(|t| dedup(&t.subscribers).len()).sum();
    let pbs = s.auctions.len() + s.votes.len() + s.debates.len() + s.elections.len() + s.rumors.len() + s.handoffs.len();
    let evs: usize = s.auctions.iter().map(|a| a.bids.len()).sum::<usize>() + s.votes.iter().map(|v| v.ballots.len()).sum::<usize>() + s.debates.iter().map(|d| d.turns.len()).sum::<usize>();
    [c.blackboard.len() as i64, c.topics.len() as i64, subs as i64, pbs as i64, evs as i64]
}

fn dedup(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v {
        if !out.contains(s) {
            out.push(s.clone());
        }
    }
    out
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
}

fn from_json<T: DeserializeOwned + Default>(s: &str) -> T {
    serde_json::from_str(s).unwrap_or_default()
}

/// Rewrite a room's coordination data (the room playbooks of Phase 5, engine
/// `playbook`, are left alone). Runs inside the caller's transaction when
/// there is one.
pub fn save_room(conn: &Connection, room: &str, c: &ChatComms) -> Result<(), String> {
    board::ensure_tables(conn).map_err(e2s)?;
    crate::ws::groups::tx(conn, |tx| {
        tx.execute("DELETE FROM ws_board WHERE room = ?1", params![room]).map_err(e2s)?;
        tx.execute("DELETE FROM ws_topics WHERE room = ?1", params![room]).map_err(e2s)?;
        tx.execute("DELETE FROM ws_topic_subs WHERE room = ?1", params![room]).map_err(e2s)?;
        tx.execute("DELETE FROM ws_playbook_events WHERE room = ?1 AND playbook_id IN (SELECT id FROM ws_playbooks WHERE room = ?1 AND engine = 'swarm')", params![room]).map_err(e2s)?;
        tx.execute("DELETE FROM ws_playbooks WHERE room = ?1 AND engine = 'swarm'", params![room]).map_err(e2s)?;
        {
            let mut ins = tx
                .prepare_cached(
                    "INSERT INTO ws_board (room, key, value, version, author, author_name, weight, reinforced_at, tags_json, writes, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                )
                .map_err(e2s)?;
            for (k, e) in &c.blackboard {
                let author = e.author_id.as_deref().map(pid_of).unwrap_or_else(|| "user".into());
                ins.execute(params![room, k, e.value, e.version as i64, author, e.author_name, e.weight, e.reinforced_at, to_json(&e.tags), e.writes as i64, e.updated_at]).map_err(e2s)?;
            }
        }
        {
            let mut ins = tx
                .prepare_cached("INSERT INTO ws_topics (room, topic, created_by, created_at, total, posts_json, digest_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
                .map_err(e2s)?;
            let mut sub = tx.prepare_cached("INSERT OR IGNORE INTO ws_topic_subs (room, topic, pid, pos) VALUES (?1, ?2, ?3, ?4)").map_err(e2s)?;
            for (name, t) in &c.topics {
                ins.execute(params![room, name, t.created_by, t.created_at, t.total as i64, to_json(&t.posts), to_json(&t.digest)]).map_err(e2s)?;
                for (i, s) in dedup(&t.subscribers).iter().enumerate() {
                    sub.execute(params![room, name, pid_of(s), i as i64]).map_err(e2s)?;
                }
            }
        }
        let s = &c.swarm;
        let mut pos = 0i64;
        let mut put = |id: &str, kind: &str, state: &str, params_v: Value, result: Option<Value>, by: &str, created: i64, updated: i64, events: Vec<(&str, String, Value, i64)>| -> Result<(), String> {
            pos += 1;
            tx.execute(
                "INSERT INTO ws_playbooks (room, id, kind, state, params_json, result_json, started_by, engine, pos, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'swarm', ?8, ?9, ?10)",
                params![room, id, kind, state, params_v.to_string(), result.map(|r| r.to_string()), pid_of(by), pos, created, updated],
            )
            .map_err(e2s)?;
            let mut ev = tx.prepare_cached("INSERT INTO ws_playbook_events (room, playbook_id, seq, kind, pid, body_json, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").map_err(e2s)?;
            for (i, (k, actor, data, at)) in events.into_iter().enumerate() {
                ev.execute(params![room, id, i as i64 + 1, k, pid_of(&actor), data.to_string(), at]).map_err(e2s)?;
            }
            Ok(())
        };
        for a in &s.auctions {
            let mut p = a.clone();
            let bids = std::mem::take(&mut p.bids);
            let ev = bids.iter().map(|b| ("bid", b.bidder_id.clone(), json!(b), b.at)).collect();
            put(&a.id, "auction", &a.status, json!(p), Some(json!({"winnerId": a.winner_id, "winnerName": a.winner_name})), &a.announcer_id, a.created_at, a.closed_at.unwrap_or(a.created_at), ev)?;
        }
        for v in &s.votes {
            let mut p = v.clone();
            let ballots = std::mem::take(&mut p.ballots);
            let ev = ballots.iter().map(|b| ("ballot", b.voter_id.clone(), json!(b), b.at)).collect();
            put(&v.id, "vote", &v.status, json!(p), Some(json!({"winner": v.winner, "tally": v.tally})), &v.caller_id, v.created_at, v.closed_at.unwrap_or(v.created_at), ev)?;
        }
        for d in &s.debates {
            let mut p = d.clone();
            let turns = std::mem::take(&mut p.turns);
            let ev = turns.iter().map(|t| ("turn", t.agent_id.clone(), json!(t), t.at)).collect();
            put(&d.id, "debate", &d.status, json!(p), None, &d.moderator_id, d.created_at, d.closed_at.unwrap_or(d.created_at), ev)?;
        }
        for e in &s.elections {
            put(&e.id, "election", "closed", json!(e), Some(json!({"winnerId": e.winner_id, "winnerName": e.winner_name})), &e.caller_id, e.at, e.at, Vec::new())?;
        }
        for r in &s.rumors {
            put(&r.id, "gossip", "spreading", json!(r), None, &r.origin_id, r.created_at, r.created_at, Vec::new())?;
        }
        for (i, h) in s.handoffs.iter().enumerate() {
            put(&format!("hof_{}_{}", h.at, i), "handoff", "done", json!(h), None, &h.from_id, h.at, h.at, Vec::new())?;
        }
        let meta = json!({
            "messageCount": c.message_count,
            "boardDigest": c.board_digest,
            "compactions": c.compactions,
            "compactedItems": c.compacted_items,
            "lastCompactionAt": c.last_compaction_at,
            "coordinator": s.coordinator,
            "coordinatorName": s.coordinator_name,
            "term": s.term,
            "activeAgent": s.active_agent,
            "digests": s.digests,
        });
        board::room_meta_set(tx, room, "comms", &meta.to_string()).map_err(e2s)?;
        Ok(())
    })
}

fn events_of<T: DeserializeOwned + Default>(conn: &Connection, room: &str, id: &str) -> Result<Vec<T>, String> {
    let mut st = conn.prepare_cached("SELECT body_json FROM ws_playbook_events WHERE room = ?1 AND playbook_id = ?2 ORDER BY seq").map_err(e2s)?;
    let rows = st.query_map(params![room, id], |r| r.get::<_, String>(0)).map_err(e2s)?;
    Ok(rows.filter_map(Result::ok).map(|s| from_json::<T>(&s)).collect())
}

/// A room's coordination data (config left default: it comes from
/// `comms.json`). None when the database holds nothing for the room.
pub fn load_room(conn: &Connection, room: &str) -> Result<Option<ChatComms>, String> {
    board::ensure_tables(conn).map_err(e2s)?;
    let meta = board::room_meta_get(conn, room, "comms").map_err(e2s)?;
    let mut c = ChatComms::default();
    let mut any = meta.is_some();
    {
        let mut st = conn
            .prepare("SELECT key, value, version, author, author_name, weight, reinforced_at, tags_json, writes, updated_at FROM ws_board WHERE room = ?1")
            .map_err(e2s)?;
        let rows = st
            .query_map(params![room], |r| {
                let author: String = r.get(3)?;
                Ok((
                    r.get::<_, String>(0)?,
                    BoardEntry {
                        value: r.get(1)?,
                        version: r.get::<_, i64>(2)? as u64,
                        author_id: (author != "user").then(|| id_of(&author)),
                        author_name: r.get(4)?,
                        weight: r.get(5)?,
                        reinforced_at: r.get(6)?,
                        tags: from_json(&r.get::<_, String>(7)?),
                        writes: r.get::<_, i64>(8)? as u64,
                        updated_at: r.get(9)?,
                    },
                ))
            })
            .map_err(e2s)?;
        for row in rows {
            let (k, e) = row.map_err(e2s)?;
            c.blackboard.insert(k, e);
            any = true;
        }
    }
    {
        let mut st = conn.prepare("SELECT topic, created_by, created_at, total, posts_json, digest_json FROM ws_topics WHERE room = ?1").map_err(e2s)?;
        let rows = st
            .query_map(params![room], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Topic {
                        subscribers: Vec::new(),
                        posts: from_json::<VecDeque<Post>>(&r.get::<_, String>(4)?),
                        created_by: r.get(1)?,
                        created_at: r.get(2)?,
                        total: r.get::<_, i64>(3)? as u64,
                        digest: from_json(&r.get::<_, String>(5)?),
                    },
                ))
            })
            .map_err(e2s)?;
        for row in rows {
            let (k, t) = row.map_err(e2s)?;
            c.topics.insert(k, t);
            any = true;
        }
        let mut st = conn.prepare("SELECT topic, pid FROM ws_topic_subs WHERE room = ?1 ORDER BY topic, pos").map_err(e2s)?;
        let rows = st.query_map(params![room], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e2s)?;
        for row in rows {
            let (t, pid) = row.map_err(e2s)?;
            c.topics.entry(t).or_default().subscribers.push(id_of(&pid));
            any = true;
        }
    }
    let mut list: Vec<(String, String, String)> = Vec::new();
    {
        let mut st = conn.prepare("SELECT id, kind, params_json FROM ws_playbooks WHERE room = ?1 AND engine = 'swarm' ORDER BY pos").map_err(e2s)?;
        let rows = st.query_map(params![room], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e2s)?;
        for row in rows {
            list.push(row.map_err(e2s)?);
        }
    }
    let s = &mut c.swarm;
    for (id, kind, p) in list {
        any = true;
        match kind.as_str() {
            "auction" => {
                let mut a: Auction = from_json(&p);
                a.bids = events_of::<Bid>(conn, room, &id)?;
                s.auctions.push_back(a);
            }
            "vote" => {
                let mut v: Vote = from_json(&p);
                v.ballots = events_of::<Ballot>(conn, room, &id)?;
                s.votes.push_back(v);
            }
            "debate" => {
                let mut d: Debate = from_json(&p);
                d.turns = events_of::<DebateTurn>(conn, room, &id)?;
                s.debates.push_back(d);
            }
            "election" => s.elections.push_back(from_json::<Election>(&p)),
            "gossip" => s.rumors.push_back(from_json::<Rumor>(&p)),
            "handoff" => s.handoffs.push_back(from_json::<Handoff>(&p)),
            _ => {}
        }
    }
    if let Some(m) = meta {
        let m: Value = serde_json::from_str(&m).unwrap_or(json!({}));
        c.message_count = m["messageCount"].as_u64().unwrap_or(0);
        c.board_digest = serde_json::from_value(m["boardDigest"].clone()).unwrap_or_default();
        c.compactions = m["compactions"].as_u64().unwrap_or(0);
        c.compacted_items = m["compactedItems"].as_u64().unwrap_or(0);
        c.last_compaction_at = m["lastCompactionAt"].as_i64();
        s.coordinator = m["coordinator"].as_str().map(str::to_string);
        s.coordinator_name = m["coordinatorName"].as_str().map(str::to_string);
        s.term = m["term"].as_u64().unwrap_or(0);
        s.active_agent = m["activeAgent"].as_str().map(str::to_string);
        s.digests = serde_json::from_value::<BTreeMap<String, super::compact::Digest>>(m["digests"].clone()).unwrap_or_default();
    }
    Ok(any.then_some(c))
}

/// Row counts of the room tables for `rooms`, in `expected_rows` order.
pub fn counted_rows(conn: &Connection, rooms: &[String]) -> Result<[i64; 5], String> {
    let mut out = [0i64; 5];
    for room in rooms {
        let q = |sql: &str| conn.query_row(sql, params![room], |r| r.get::<_, i64>(0)).map_err(e2s);
        out[0] += q("SELECT COUNT(*) FROM ws_board WHERE room = ?1")?;
        out[1] += q("SELECT COUNT(*) FROM ws_topics WHERE room = ?1")?;
        out[2] += q("SELECT COUNT(*) FROM ws_topic_subs WHERE room = ?1")?;
        out[3] += q("SELECT COUNT(*) FROM ws_playbooks WHERE room = ?1 AND engine = 'swarm'")?;
        out[4] += q("SELECT COUNT(*) FROM ws_playbook_events WHERE room = ?1 AND playbook_id IN (SELECT id FROM ws_playbooks WHERE room = ?1 AND engine = 'swarm')")?;
    }
    Ok(out)
}
