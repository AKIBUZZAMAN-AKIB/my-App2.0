//! One engine for every multi-agent protocol (unified plan, Phase 5).
//!
//! A playbook is a short protocol run inside one room: a group
//! (`group:<gid>`), a chat's team room, or the ephemeral room of a batch.
//! The swarm patterns (debate, vote, auction, election, handoff, gossip) and
//! the batch modes (parallel, pipeline, race, review, gather) are all kinds
//! of the same thing: a row in `ws_playbooks` (`engine = 'playbook'`) and its
//! moves as rows in `ws_playbook_events`. The state of a run is never stored
//! twice: `fold` replays the events, so a restart, a preview and the real
//! post all see the same state.
//!
//! While a playbook runs it is the room's temporary rule: `steer` names who
//! is woken next (the next debater, the voters who have not voted, the
//! current holder of a handoff), and `groups::post_at` uses that in place of
//! the room's own wake rules. When it ends, the result is stored, the next
//! post (the announcement) wakes only whom the result names (the winner of
//! an auction, the elected coordinator), and the room's own rules apply
//! again.
//!
//! Gated by `SubagentSettings::unified_playbooks`: with the flag off nothing
//! starts a playbook and the per-chat swarm (`subagents::swarm`) runs as
//! before.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

use super::board;
use super::now_ms;

pub const KINDS: [&str; 11] = ["debate", "vote", "auction", "election", "handoff", "gossip", "parallel", "pipeline", "race", "review", "gather"];
/// The batch modes; their room is the batch's own ephemeral room.
pub const BATCH_KINDS: [&str; 5] = ["parallel", "pipeline", "race", "review", "gather"];
pub const VOTE_RULES: [&str; 4] = ["majority", "plurality", "unanimous", "supermajority"];
const ENGINE: &str = "playbook";
const ANNOUNCE_KEY: &str = "playbook.announce";
const MAX_ROUNDS: i64 = 5;
const MAX_HANDOFFS: i64 = 8;

/// One entry of the catalog the user picks a room's mode from: the five
/// wake-rule presets of a group and the nine protocols, one list instead of
/// three (group presets, swarm presets, batch modes).
pub struct Mode {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// The group wake-rule preset the room uses while no playbook runs.
    pub rules: &'static str,
    /// The playbook a room in this mode starts with, if any.
    pub playbook: Option<&'static str>,
    /// The matching per-chat comms preset of the team graph, if any.
    pub comms: Option<&'static str>,
}

pub const CATALOG: [Mode; 14] = [
    Mode { name: "social", title: "Open room", description: "Members answer when it makes sense; mentions always wake.", rules: "social", playbook: None, comms: Some("open-swarm") },
    Mode { name: "everyone", title: "Everyone answers", description: "Every message wakes every member.", rules: "everyone", playbook: None, comms: None },
    Mode { name: "round_table", title: "Round table", description: "Members speak in turn, one at a time.", rules: "round_table", playbook: None, comms: None },
    Mode { name: "wait_your_turn", title: "Wait your turn", description: "A member speaks only after a few unanswered messages.", rules: "wait_your_turn", playbook: None, comms: None },
    Mode { name: "moderated", title: "Moderated", description: "One moderator decides who speaks.", rules: "moderated", playbook: None, comms: Some("supervisor") },
    Mode { name: "debate", title: "Debate", description: "Members argue in turns for a few rounds; the result says whether they converged.", rules: "round_table", playbook: Some("debate"), comms: Some("debate-panel") },
    Mode { name: "vote", title: "Vote", description: "Every member casts one ballot; the rule decides the winner.", rules: "everyone", playbook: Some("vote"), comms: None },
    Mode { name: "market", title: "Market", description: "A task is announced, members bid, the best bid wins and does it.", rules: "everyone", playbook: Some("auction"), comms: Some("market") },
    Mode { name: "election", title: "Election", description: "Members elect a coordinator for the room.", rules: "everyone", playbook: Some("election"), comms: None },
    Mode { name: "handoff", title: "Handoff", description: "One member holds the task and hands it on until it is done.", rules: "wait_your_turn", playbook: Some("handoff"), comms: None },
    Mode { name: "gossip", title: "Gossip", description: "News spreads member to member, a few at a time.", rules: "social", playbook: Some("gossip"), comms: Some("gossip") },
    Mode { name: "pipeline", title: "Pipeline", description: "Each member works on the previous member's result, in order.", rules: "round_table", playbook: Some("pipeline"), comms: Some("pipeline") },
    Mode { name: "review", title: "Review", description: "One member writes, the others approve or send it back.", rules: "everyone", playbook: Some("review"), comms: None },
    Mode { name: "blackboard", title: "Blackboard", description: "No turns: members coordinate through the room's shared board.", rules: "wait_your_turn", playbook: None, comms: Some("blackboard") },
];

pub fn mode(name: &str) -> Option<&'static Mode> {
    let n = name.trim().to_lowercase().replace('-', "_");
    CATALOG.iter().find(|m| m.name == n)
}

pub fn catalog_json() -> Value {
    json!(CATALOG
        .iter()
        .map(|m| json!({ "name": m.name, "title": m.title, "description": m.description, "rules": m.rules, "playbook": m.playbook, "comms": m.comms }))
        .collect::<Vec<_>>())
}

fn e2s(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    board::ensure_tables(conn)
}

/// One stored move.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub seq: i64,
    pub kind: String,
    pub pid: String,
    pub body: Value,
    pub at: i64,
}

/// The state of a run, replayed from its events.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct View {
    pub done: bool,
    pub result: Value,
    /// Who is woken next, with the reason the dispatch log shows.
    pub next: Vec<(String, String)>,
    /// What each member may do now.
    pub expects: BTreeMap<String, Vec<&'static str>>,
    /// One line for the room's Mode panel and the agents' prompt.
    pub status: String,
}

impl View {
    fn expect(&mut self, pid: &str, actions: &[&'static str]) {
        self.expects.entry(pid.to_string()).or_default().extend_from_slice(actions);
    }
    fn wake(&mut self, pid: &str, reason: String) {
        if !self.next.iter().any(|(p, _)| p == pid) {
            self.next.push((pid.to_string(), reason));
        }
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn int(params: &Value, k: &str, default: i64, lo: i64, hi: i64) -> i64 {
    params.get(k).and_then(Value::as_i64).unwrap_or(default).clamp(lo, hi)
}

fn min_members(kind: &str) -> usize {
    match kind {
        "handoff" | "parallel" | "gather" => 1,
        _ => 2,
    }
}

/// A short stance from a debate turn: the explicit one, else the words.
pub fn stance(body: &Value) -> &'static str {
    match body.get("stance").and_then(Value::as_str).map(str::to_lowercase).as_deref() {
        Some("agree") | Some("for") | Some("yes") => return "agree",
        Some("disagree") | Some("against") | Some("no") => return "disagree",
        Some("neutral") => return "neutral",
        _ => {}
    }
    let t = body.get("text").and_then(Value::as_str).unwrap_or("").to_lowercase();
    if ["disagree", "i object", "not convinced", "wrong"].iter().any(|w| t.contains(w)) {
        "disagree"
    } else if ["agree", "convinced", "concur", "you're right", "you are right"].iter().any(|w| t.contains(w)) {
        "agree"
    } else {
        "neutral"
    }
}

/// The winner of a ballot count under `rule`, or None (no decision).
pub fn winner(tally: &BTreeMap<String, i64>, voters: usize, rule: &str) -> Option<String> {
    let cast: i64 = tally.values().sum();
    let best = tally.values().copied().max().unwrap_or(0);
    let leaders: Vec<&String> = tally.iter().filter(|(_, n)| **n == best && best > 0).map(|(k, _)| k).collect();
    if leaders.len() != 1 {
        return None;
    }
    let top = leaders[0].clone();
    let voters = voters.max(1) as i64;
    let ok = match rule {
        "plurality" => true,
        "unanimous" => best == voters && cast == voters,
        "supermajority" => best * 3 >= voters * 2,
        _ => best * 2 > voters,
    };
    ok.then_some(top)
}

/// Replay a run. Pure: the same events give the same view.
pub fn fold(kind: &str, params: &Value, events: &[Event]) -> View {
    let members = strs(&params["members"]);
    let n = members.len();
    let mut v = View::default();
    let closed = events.iter().any(|e| e.kind == "close");
    let results: Vec<&Event> = events.iter().filter(|e| e.kind == "result").collect();
    let has_result = |pid: &str| results.iter().any(|e| e.pid == pid);
    match kind {
        "debate" => {
            let rounds = int(params, "rounds", 2, 1, MAX_ROUNDS) as usize;
            let turns: Vec<&Event> = events.iter().filter(|e| e.kind == "turn").collect();
            if turns.len() >= rounds * n.max(1) || closed {
                v.done = true;
                let last: Vec<&str> = turns.iter().rev().take(n).map(|e| stance(&e.body)).collect();
                let mut count = BTreeMap::new();
                for s in &last {
                    *count.entry(s.to_string()).or_insert(0) += 1;
                }
                let converged = !last.is_empty() && last.iter().all(|s| *s == last[0]) && last[0] != "neutral";
                v.result = json!({ "turns": turns.len(), "stances": count, "converged": converged, "position": if converged { json!(last[0]) } else { Value::Null } });
                v.status = format!("Debate over after {} turns; {}.", turns.len(), if converged { "converged" } else { "no agreement" });
            } else {
                let speaker = &members[turns.len() % n];
                let round = turns.len() / n + 1;
                v.expect(speaker, &["turn"]);
                v.wake(speaker, format!("playbook:debate:round {round}/{rounds}"));
                v.status = format!("Debate round {round} of {rounds}; {} speaks.", speaker);
            }
        }
        "vote" | "election" => {
            let rule = if kind == "election" { "plurality".to_string() } else { params["rule"].as_str().filter(|r| VOTE_RULES.contains(r)).unwrap_or("majority").to_string() };
            let mut ballots: BTreeMap<String, (String, String)> = BTreeMap::new();
            for e in events.iter().filter(|e| e.kind == "ballot") {
                ballots.insert(e.pid.clone(), (e.body["option"].as_str().unwrap_or("").to_string(), e.body["reason"].as_str().unwrap_or("").to_string()));
            }
            let waiting: Vec<&String> = members.iter().filter(|m| !ballots.contains_key(*m)).collect();
            if waiting.is_empty() || closed {
                v.done = true;
                let mut tally: BTreeMap<String, i64> = BTreeMap::new();
                for (opt, _) in ballots.values() {
                    *tally.entry(opt.clone()).or_insert(0) += 1;
                }
                let w = winner(&tally, n, &rule);
                v.result = json!({ "rule": rule, "tally": tally, "winner": w, "ballots": ballots.iter().map(|(p, (o, r))| json!({"pid": p, "option": o, "reason": r})).collect::<Vec<_>>(), "voters": n });
                if kind == "election" {
                    v.result["coordinator"] = json!(w);
                    v.result["wake"] = json!(w.iter().collect::<Vec<_>>());
                }
                v.status = match &w {
                    Some(w) => format!("{} decided: {w}.", if kind == "vote" { "Vote" } else { "Election" }),
                    None => "No decision.".into(),
                };
            } else {
                for m in &waiting {
                    v.expect(m, &["ballot"]);
                    v.wake(m, format!("playbook:{kind}:ballot"));
                }
                v.status = format!("{} of {n} ballots in.", ballots.len());
            }
        }
        "auction" => {
            let mut bids: BTreeMap<String, (f64, f64, i64, String)> = BTreeMap::new();
            for e in events.iter().filter(|e| e.kind == "bid") {
                let cost = e.body["cost"].as_f64().unwrap_or(f64::MAX).max(0.0);
                let conf = e.body["confidence"].as_f64().unwrap_or(0.5).clamp(0.05, 1.0);
                bids.insert(e.pid.clone(), (cost, conf, e.seq, e.body["note"].as_str().unwrap_or("").to_string()));
            }
            let waiting: Vec<&String> = members.iter().filter(|m| !bids.contains_key(*m)).collect();
            if waiting.is_empty() || closed {
                v.done = true;
                // Cheapest per unit of confidence; the earlier bid wins a tie.
                let best = bids.iter().min_by(|a, b| (a.1 .0 / a.1 .1).partial_cmp(&(b.1 .0 / b.1 .1)).unwrap_or(std::cmp::Ordering::Equal).then(a.1 .2.cmp(&b.1 .2))).map(|(p, _)| p.clone());
                v.result = json!({ "winner": best, "task": params["task"], "bids": bids.iter().map(|(p, (c, f, _, note))| json!({"pid": p, "cost": c, "confidence": f, "note": note})).collect::<Vec<_>>(), "wake": best.iter().collect::<Vec<_>>() });
                v.status = match &best {
                    Some(b) => format!("Awarded to {b}."),
                    None => "No bids.".into(),
                };
            } else {
                for m in &waiting {
                    v.expect(m, &["bid"]);
                    v.wake(m, "playbook:auction:bid".into());
                }
                v.status = format!("{} of {n} bids in.", bids.len());
            }
        }
        "handoff" => {
            let max = int(params, "maxHandoffs", 4, 1, MAX_HANDOFFS);
            let mut holder = params["to"].as_str().map(str::to_string).filter(|t| members.contains(t)).unwrap_or_else(|| members.first().cloned().unwrap_or_default());
            let mut path = vec![holder.clone()];
            let mut finished: Option<&Event> = None;
            for e in events {
                match e.kind.as_str() {
                    "handoff" if e.pid == holder => {
                        if let Some(t) = e.body["to"].as_str() {
                            holder = t.to_string();
                            path.push(holder.clone());
                        }
                    }
                    "finish" if e.pid == holder => finished = Some(e),
                    _ => {}
                }
            }
            let hops = path.len() as i64 - 1;
            if finished.is_some() || hops > max || closed {
                v.done = true;
                v.result = json!({ "by": holder, "path": path, "handoffs": hops, "text": finished.map(|e| e.body["text"].clone()).unwrap_or(Value::Null), "finished": finished.is_some() });
                v.status = if finished.is_some() { format!("Done by {holder} after {hops} handoffs.") } else { format!("Stopped after {hops} handoffs.") };
            } else {
                v.expect(&holder, &["handoff", "finish"]);
                v.wake(&holder, format!("playbook:handoff:holder ({hops}/{max})"));
                v.status = format!("{holder} holds the task.");
            }
        }
        "gossip" => {
            let fanout = int(params, "fanout", 2, 1, 8) as usize;
            let seed = params["seed"].as_str().map(str::to_string).filter(|s| members.contains(s)).unwrap_or_else(|| members.first().cloned().unwrap_or_default());
            let mut heard = vec![seed];
            let mut spread: HashSet<String> = HashSet::new();
            for e in events.iter().filter(|e| e.kind == "spread") {
                if heard.contains(&e.pid) && spread.insert(e.pid.clone()) {
                    for t in strs(&e.body["to"]).into_iter().take(fanout) {
                        if members.contains(&t) && !heard.contains(&t) {
                            heard.push(t);
                        }
                    }
                }
            }
            let spreaders: Vec<String> = heard.iter().filter(|p| !spread.contains(*p)).cloned().collect();
            if heard.len() >= n || spreaders.is_empty() || closed {
                v.done = true;
                v.result = json!({ "heard": heard, "reached": heard.len(), "of": n, "fact": params["fact"] });
                v.status = format!("Reached {} of {n}.", heard.len());
            } else {
                for p in &spreaders {
                    v.expect(p, &["spread"]);
                    v.wake(p, "playbook:gossip:spread".into());
                }
                v.status = format!("{} of {n} have heard.", heard.len());
            }
        }
        "parallel" | "gather" | "race" => {
            let first = results.first();
            let all_in = members.iter().all(|m| has_result(m));
            if (kind == "race" && first.is_some()) || all_in || closed {
                v.done = true;
                let list: Vec<Value> = results.iter().map(|e| json!({"pid": e.pid, "text": e.body["text"]})).collect();
                v.result = match kind {
                    "race" => json!({ "winner": first.map(|e| e.pid.clone()), "text": first.map(|e| e.body["text"].clone()) }),
                    "gather" => json!({ "results": list, "summary": results.iter().map(|e| format!("- {}: {}", e.pid, e.body["text"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n") }),
                    _ => json!({ "results": list }),
                };
                v.status = format!("{} result(s) in; done.", results.len());
            } else {
                for m in members.iter().filter(|m| !has_result(m)) {
                    v.expect(m, &["result"]);
                    v.wake(m, format!("playbook:{kind}:work"));
                }
                v.status = format!("{} of {n} results in.", results.len());
            }
        }
        "pipeline" => {
            // A stage counts only in order: stage k is members[k].
            let mut stage = 0usize;
            let mut last: Option<&Event> = None;
            for e in &results {
                if stage < n && e.pid == members[stage] {
                    stage += 1;
                    last = Some(e);
                }
            }
            if stage >= n || closed {
                v.done = true;
                v.result = json!({ "stages": stage, "final": last.map(|e| e.body["text"].clone()), "by": last.map(|e| e.pid.clone()) });
                v.status = format!("Pipeline done after {stage} stage(s).");
            } else {
                let p = &members[stage];
                v.expect(p, &["result"]);
                v.wake(p, format!("playbook:pipeline:stage {}/{n}", stage + 1));
                v.status = format!("Stage {} of {n}: {p}.", stage + 1);
            }
        }
        "review" => {
            let max = int(params, "maxRounds", 2, 1, MAX_ROUNDS);
            let author = members.first().cloned().unwrap_or_default();
            let reviewers: Vec<String> = members.iter().skip(1).cloned().collect();
            let mut round = 0i64;
            let mut draft: Option<&Event> = None;
            let mut verdicts: BTreeMap<String, bool> = BTreeMap::new();
            let mut outcome: Option<bool> = None;
            for e in events {
                match e.kind.as_str() {
                    "result" if e.pid == author && (draft.is_none() || verdicts.len() == reviewers.len()) => {
                        round += 1;
                        draft = Some(e);
                        verdicts.clear();
                    }
                    "review" if draft.is_some() && reviewers.contains(&e.pid) && !verdicts.contains_key(&e.pid) => {
                        verdicts.insert(e.pid.clone(), e.body["approve"].as_bool().unwrap_or(false));
                        if verdicts.len() == reviewers.len() {
                            if verdicts.values().all(|a| *a) {
                                outcome = Some(true);
                            } else if round >= max {
                                outcome = Some(false);
                            }
                        }
                    }
                    _ => {}
                }
                if outcome.is_some() {
                    break;
                }
            }
            if outcome.is_some() || closed {
                v.done = true;
                let approved = outcome == Some(true);
                v.result = json!({ "approved": approved, "rounds": round, "text": draft.map(|e| e.body["text"].clone()), "verdicts": verdicts, "wake": if approved { vec![] } else { vec![author.clone()] } });
                v.status = if approved { format!("Approved after {round} round(s).") } else { format!("Not approved after {round} round(s).") };
            } else if draft.is_none() || verdicts.len() == reviewers.len() {
                v.expect(&author, &["result"]);
                v.wake(&author, format!("playbook:review:draft {}/{max}", round + 1));
                v.status = format!("Waiting for {author}'s draft (round {} of {max}).", round + 1);
            } else {
                for r in reviewers.iter().filter(|r| !verdicts.contains_key(*r)) {
                    v.expect(r, &["review"]);
                    v.wake(r, format!("playbook:review:review {round}/{max}"));
                }
                v.status = format!("{} of {} reviews in (round {round}).", verdicts.len(), reviewers.len());
            }
        }
        _ => {
            v.done = true;
            v.status = format!("Unknown playbook {kind}.");
        }
    }
    v
}

/// A playbook row with its replayed view.
#[derive(Debug, Clone)]
pub struct Playbook {
    pub room: String,
    pub id: String,
    pub kind: String,
    pub state: String,
    pub params: Value,
    pub result: Value,
    pub started_by: String,
    pub created_at: i64,
    pub events: Vec<Event>,
    pub view: View,
}

impl Playbook {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "room": self.room, "kind": self.kind, "state": self.state,
            "params": self.params, "result": self.result, "startedBy": self.started_by, "createdAt": self.created_at,
            "status": self.view.status,
            "next": self.view.next.iter().map(|(p, r)| json!({"pid": p, "reason": r})).collect::<Vec<_>>(),
            "expects": self.view.expects,
            "events": self.events.iter().map(|e| json!({"seq": e.seq, "kind": e.kind, "pid": e.pid, "body": e.body, "at": e.at})).collect::<Vec<_>>(),
        })
    }
}

fn events_of(conn: &Connection, room: &str, id: &str) -> Result<Vec<Event>, String> {
    let mut st = conn.prepare("SELECT seq, kind, COALESCE(pid, ''), body_json, at FROM ws_playbook_events WHERE room = ?1 AND playbook_id = ?2 ORDER BY seq").map_err(e2s)?;
    let rows = st
        .query_map(params![room, id], |r| {
            Ok(Event { seq: r.get(0)?, kind: r.get(1)?, pid: r.get(2)?, body: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(json!({})), at: r.get(4)? })
        })
        .map_err(e2s)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(e2s)
}

fn load(conn: &Connection, room: &str, id: &str) -> Result<Option<Playbook>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let row = conn
        .query_row(
            "SELECT kind, state, params_json, result_json, COALESCE(started_by, ''), created_at FROM ws_playbooks WHERE room = ?1 AND id = ?2 AND engine = 'playbook'",
            params![room, id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?)),
        )
        .optional()
        .map_err(e2s)?;
    let Some((kind, state, p, res, by, at)) = row else { return Ok(None) };
    let params: Value = serde_json::from_str(&p).unwrap_or(json!({}));
    let events = events_of(conn, room, id)?;
    let view = fold(&kind, &params, &events);
    Ok(Some(Playbook { room: room.into(), id: id.into(), kind, state, params, result: res.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or(Value::Null), started_by: by, created_at: at, events, view }))
}

pub fn get(conn: &Connection, room: &str, id: &str) -> Result<Option<Playbook>, String> {
    load(conn, room, id)
}

/// The room a playbook id belongs to (ids are unique across rooms).
pub fn room_of(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    ensure_tables(conn).map_err(e2s)?;
    conn.query_row("SELECT room FROM ws_playbooks WHERE id = ?1 AND engine = 'playbook'", params![id], |r| r.get(0)).optional().map_err(e2s)
}

/// Every playbook of a room, newest first.
pub fn list(conn: &Connection, room: &str) -> Result<Vec<Playbook>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let ids: Vec<String> = {
        let mut st = conn.prepare("SELECT id FROM ws_playbooks WHERE room = ?1 AND engine = 'playbook' ORDER BY pos DESC").map_err(e2s)?;
        let rows = st.query_map(params![room], |r| r.get::<_, String>(0)).map_err(e2s)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e2s)?
    };
    let mut out = Vec::new();
    for id in ids {
        if let Some(p) = load(conn, room, &id)? {
            out.push(p);
        }
    }
    Ok(out)
}

/// The playbook running in a room, if any (one at a time). A run whose
/// deadline (`params.deadlineMs`, an absolute time) has passed is closed
/// with what it has.
pub fn active(conn: &Connection, room: &str) -> Result<Option<Playbook>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let id: Option<String> = conn
        .query_row("SELECT id FROM ws_playbooks WHERE room = ?1 AND engine = 'playbook' AND state = 'running' ORDER BY pos DESC LIMIT 1", params![room], |r| r.get(0))
        .optional()
        .map_err(e2s)?;
    let Some(id) = id else { return Ok(None) };
    let Some(pb) = load(conn, room, &id)? else { return Ok(None) };
    if pb.params["deadlineMs"].as_i64().is_some_and(|d| d <= now_ms()) {
        act(conn, room, &id, "user", "close", &json!({ "reason": "deadline" }))?;
        return Ok(None);
    }
    Ok(Some(pb))
}

/// Start a playbook in a room. `params.members` (pids, in order) are the
/// participants. Refused while another one runs in the room.
pub fn start(conn: &Connection, room: &str, kind: &str, params_in: &Value, by: &str) -> Result<Playbook, String> {
    let kind = kind.trim().to_lowercase();
    let kind = mode(&kind).and_then(|m| m.playbook).map(str::to_string).unwrap_or(kind);
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("Unknown playbook {kind}; one of {}.", KINDS.join(", ")));
    }
    if let Some(a) = active(conn, room)? {
        return Err(format!("A {} ({}) is already running here; finish or cancel it first.", a.kind, a.id));
    }
    let mut params = params_in.clone();
    if !params.is_object() {
        params = json!({});
    }
    let mut members = strs(&params["members"]);
    members.dedup();
    if members.len() < min_members(&kind) {
        return Err(format!("A {kind} needs at least {} member(s); it has {}.", min_members(&kind), members.len()));
    }
    params["members"] = json!(members);
    if kind == "vote" {
        let options = strs(&params["options"]);
        if options.len() < 2 {
            return Err("A vote needs at least two options.".into());
        }
        if let Some(r) = params["rule"].as_str() {
            if !VOTE_RULES.contains(&r) {
                return Err(format!("Unknown rule {r}; one of {}.", VOTE_RULES.join(", ")));
            }
        }
    }
    if let Some(secs) = params["timeoutSeconds"].as_i64().filter(|s| *s > 0) {
        params["deadlineMs"] = json!(now_ms() + secs * 1000);
    }
    let id = super::ids::new_id("pb");
    let now = now_ms();
    crate::turn_memory::store::write_tx(conn, |c| {
        let pos: i64 = c.query_row("SELECT COALESCE(MAX(pos), 0) + 1 FROM ws_playbooks WHERE room = ?1", params![room], |r| r.get(0))?;
        c.execute(
            "INSERT INTO ws_playbooks (room, id, kind, state, params_json, started_by, engine, pos, created_at, updated_at) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7, ?8, ?8)",
            params![room, id, kind, params.to_string(), by, ENGINE, pos, now],
        )?;
        Ok(())
    })
    .map_err(|e: rusqlite::Error| e.to_string())?;
    load(conn, room, &id)?.ok_or_else(|| "The playbook was not stored.".into())
}

/// What one move did.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub playbook: Playbook,
    /// The run ended with this move.
    pub finished: bool,
    /// Text the actor posts in the room (debate turns, results, finishes);
    /// ballots and bids stay private until the result.
    pub post: Option<String>,
}

fn may_close(pb: &Playbook, pid: &str) -> bool {
    pid == "user" || pid == pb.started_by
}

/// Record one move by `pid` and advance the run.
pub fn act(conn: &Connection, room: &str, id: &str, pid: &str, action: &str, body: &Value) -> Result<Outcome, String> {
    let pb = load(conn, room, id)?.ok_or_else(|| format!("No playbook {id} here."))?;
    if pb.state != "running" {
        return Err(format!("That {} is {} already.", pb.kind, pb.state));
    }
    let action = action.trim().to_lowercase();
    let members = strs(&pb.params["members"]);
    let mut body = if body.is_object() { body.clone() } else { json!({}) };
    if action == "close" {
        if !may_close(&pb, pid) {
            return Err("Only whoever started it (or the user) can close it.".into());
        }
    } else {
        let allowed = pb.view.expects.get(pid).cloned().unwrap_or_default();
        if !allowed.contains(&action.as_str()) {
            return Err(if allowed.is_empty() {
                format!("It is not your move in this {} ({}).", pb.kind, pb.view.status)
            } else {
                format!("In this {} you can: {}.", pb.kind, allowed.join(", "))
            });
        }
        // Check the move's own values.
        match action.as_str() {
            "ballot" => {
                let opt = body["option"].as_str().unwrap_or("").trim().to_string();
                let options = if pb.kind == "election" { strs(&pb.params["candidates"]).into_iter().chain(members.clone()).collect::<Vec<_>>() } else { strs(&pb.params["options"]) };
                let hit = options.iter().find(|o| o.eq_ignore_ascii_case(&opt) || o.strip_prefix("agent:").is_some_and(|x| x.eq_ignore_ascii_case(&opt)));
                match hit {
                    Some(o) => body["option"] = json!(o),
                    None => return Err(format!("Pick one of: {}.", options.join(", "))),
                }
            }
            "bid" => {
                if !body["cost"].as_f64().is_some_and(|c| c >= 0.0) {
                    return Err("A bid needs a cost (a number, 0 or more).".into());
                }
            }
            "handoff" => {
                let to = body["to"].as_str().unwrap_or("").trim();
                let to = members.iter().find(|m| m.as_str() == to || m.strip_prefix("agent:") == Some(to)).cloned();
                match to {
                    Some(t) if t != pid => body["to"] = json!(t),
                    _ => return Err("Hand off to another member of the playbook.".into()),
                }
            }
            "spread" => {
                let to: Vec<String> = strs(&body["to"]).into_iter().filter_map(|t| members.iter().find(|m| m.as_str() == t || m.strip_prefix("agent:") == Some(t.as_str())).cloned()).collect();
                if to.is_empty() {
                    return Err("Name the members to tell (to: [...]).".into());
                }
                body["to"] = json!(to);
            }
            "turn" | "result" | "finish" => {
                if body["text"].as_str().is_none_or(|t| t.trim().is_empty()) {
                    return Err("Say something (text).".into());
                }
            }
            "review" => {
                if body["approve"].as_bool().is_none() {
                    return Err("A review needs approve: true or false.".into());
                }
            }
            _ => {}
        }
    }
    let now = now_ms();
    let events_after = {
        let mut e = pb.events.clone();
        e.push(Event { seq: e.last().map(|x| x.seq + 1).unwrap_or(1), kind: action.clone(), pid: pid.into(), body: body.clone(), at: now });
        e
    };
    let view = fold(&pb.kind, &pb.params, &events_after);
    let seq = events_after.last().map(|e| e.seq).unwrap_or(1);
    crate::turn_memory::store::write_tx(conn, |c| {
        c.execute(
            "INSERT INTO ws_playbook_events (room, playbook_id, seq, kind, pid, body_json, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![room, id, seq, action, pid, body.to_string(), now],
        )?;
        if view.done {
            c.execute("UPDATE ws_playbooks SET state = 'done', result_json = ?3, updated_at = ?4 WHERE room = ?1 AND id = ?2", params![room, id, view.result.to_string(), now])?;
            c.execute(
                "INSERT INTO ws_room_meta (room, k, v) VALUES (?1, ?2, ?3) ON CONFLICT(room, k) DO UPDATE SET v = excluded.v",
                params![room, ANNOUNCE_KEY, id],
            )?;
            if pb.kind == "election" {
                if let Some(w) = view.result["coordinator"].as_str() {
                    c.execute("INSERT INTO ws_room_meta (room, k, v) VALUES (?1, 'coordinator', ?2) ON CONFLICT(room, k) DO UPDATE SET v = excluded.v", params![room, w])?;
                }
            }
        } else {
            c.execute("UPDATE ws_playbooks SET updated_at = ?3 WHERE room = ?1 AND id = ?2", params![room, id, now])?;
        }
        Ok(())
    })
    .map_err(|e: rusqlite::Error| e.to_string())?;
    let post = match action.as_str() {
        "turn" | "result" | "finish" => body["text"].as_str().map(str::to_string),
        "handoff" => Some(format!("Handing over to {}{}", body["to"].as_str().unwrap_or(""), body["note"].as_str().map(|n| format!(": {n}")).unwrap_or_default())),
        "review" => Some(format!("{}{}", if body["approve"] == true { "Approved" } else { "Changes requested" }, body["text"].as_str().map(|t| format!(": {t}")).unwrap_or_default())),
        _ => None,
    };
    let playbook = load(conn, room, id)?.ok_or("The playbook is gone.")?;
    Ok(Outcome { finished: view.done, playbook, post })
}

/// Cancel a running playbook (the user, or whoever started it).
pub fn cancel(conn: &Connection, room: &str, id: &str, by: &str) -> Result<(), String> {
    let pb = load(conn, room, id)?.ok_or_else(|| format!("No playbook {id} here."))?;
    if !may_close(&pb, by) {
        return Err("Only whoever started it (or the user) can cancel it.".into());
    }
    conn.execute("UPDATE ws_playbooks SET state = 'cancelled', updated_at = ?3 WHERE room = ?1 AND id = ?2 AND state = 'running'", params![room, id, now_ms()]).map_err(e2s)?;
    Ok(())
}

/// The room's temporary rule for one post.
#[derive(Debug, Clone, PartialEq)]
pub struct Steer {
    pub playbook: String,
    pub kind: String,
    /// Members to wake, with the reason; everyone else is only delivered.
    pub wake: Vec<(String, String)>,
    /// This post announces a result: wake only whom the result names.
    pub announce: bool,
}

/// Who a post in `room` wakes while a playbook runs (or right after one
/// ended). None: no playbook, the room's own rules decide.
pub fn steer(conn: &Connection, room: &str, from: &str) -> Option<Steer> {
    ensure_tables(conn).ok()?;
    if let Some(id) = board::room_meta_get(conn, room, ANNOUNCE_KEY).ok().flatten().filter(|v| !v.is_empty()) {
        if let Ok(Some(pb)) = load(conn, room, &id) {
            let wake = strs(&pb.result["wake"]).into_iter().filter(|p| p != from).map(|p| (p, format!("playbook:{}:result", pb.kind))).collect();
            return Some(Steer { playbook: id, kind: pb.kind, wake, announce: true });
        }
    }
    let pb = active(conn, room).ok().flatten()?;
    let wake = pb.view.next.iter().filter(|(p, _)| p != from).cloned().collect();
    Some(Steer { playbook: pb.id, kind: pb.kind, wake, announce: false })
}

/// After a post that announced a result: the room's rules apply again.
pub fn announced(conn: &Connection, room: &str) {
    let _ = board::room_meta_set(conn, room, ANNOUNCE_KEY, "");
}

/// The result as one line for the room.
pub fn result_line(pb: &Playbook) -> String {
    let r = &pb.result;
    let who = |v: &Value| v.as_str().map(|s| s.strip_prefix("agent:").unwrap_or(s).to_string()).unwrap_or_else(|| "nobody".into());
    match pb.kind.as_str() {
        "vote" => match r["winner"].as_str() {
            Some(w) => format!("[vote result] {w} ({} rule; tally {}).", r["rule"].as_str().unwrap_or(""), r["tally"]),
            None => format!("[vote result] No decision ({} rule; tally {}).", r["rule"].as_str().unwrap_or(""), r["tally"]),
        },
        "election" => format!("[election] Coordinator: {}.", who(&r["coordinator"])),
        "auction" => format!("[market] Awarded to {}: {}", who(&r["winner"]), r["task"].as_str().unwrap_or("the task")),
        "debate" => format!("[debate] {} turns; {}.", r["turns"], if r["converged"] == true { format!("converged on {}", r["position"].as_str().unwrap_or("")) } else { "no agreement".into() }),
        "handoff" => format!("[handoff] {} by {} after {} handoff(s).", if r["finished"] == true { "Done" } else { "Stopped" }, who(&r["by"]), r["handoffs"]),
        "gossip" => format!("[gossip] Reached {} of {}.", r["reached"], r["of"]),
        "race" => format!("[race] First: {}.", who(&r["winner"])),
        "review" => format!("[review] {} after {} round(s).", if r["approved"] == true { "Approved" } else { "Not approved" }, r["rounds"]),
        "pipeline" => format!("[pipeline] Done after {} stage(s).", r["stages"]),
        k => format!("[{k}] Done: {} result(s).", r["results"].as_array().map(|a| a.len()).unwrap_or(0)),
    }
}

/// The batch's ephemeral room: a batch runs as a playbook there, so the
/// unified graph and the Mode panel see it like any other run.
pub fn batch_room(root: &str, batch_id: &str) -> String {
    format!("batch:{root}/{batch_id}")
}

/// The batch mode as a playbook kind (`fanout` is the old name of
/// `parallel`; a `review` batch is a review; anything else is parallel).
pub fn batch_kind(mode: &str) -> &'static str {
    match mode {
        "pipeline" => "pipeline",
        "race" => "race",
        "review" => "review",
        "gather" | "map_reduce" | "mapreduce" => "gather",
        _ => "parallel",
    }
}

/// The unified graph (Phase 5): one node per principal that took part in
/// something, edges for who messaged whom, who ran where, and who took part
/// in which playbook, all from the `ws_*` tables.
pub fn unified_graph(conn: &Connection, root: Option<&str>) -> Result<Value, String> {
    ensure_tables(conn).map_err(e2s)?;
    super::principals::ensure_tables(conn).map_err(e2s)?;
    let mut nodes: BTreeMap<String, Value> = BTreeMap::new();
    let mut edges: BTreeMap<(String, String, String), i64> = BTreeMap::new();
    let mut add_node = |conn: &Connection, pid: &str| {
        if !pid.is_empty() && !nodes.contains_key(pid) {
            let kind = pid.split(':').next().unwrap_or("agent").to_string();
            nodes.insert(pid.to_string(), json!({ "pid": pid, "kind": kind, "name": super::principals::display_name(conn, pid) }));
        }
    };
    // Messages: sender to each recipient.
    let has = |t: &str| conn.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", params![t], |_| Ok(())).optional().ok().flatten().is_some();
    if has("ws_messages") {
        let mut st = conn.prepare("SELECT from_pid, to_json, COUNT(*) FROM ws_messages WHERE deleted_at IS NULL GROUP BY from_pid, to_json").map_err(e2s)?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).map_err(e2s)?;
        for (from, to, n) in rows.flatten() {
            let to: Value = serde_json::from_str(&to).unwrap_or(json!([]));
            for t in to.as_array().into_iter().flatten() {
                let pid = t.as_str().map(str::to_string).or_else(|| t["pid"].as_str().map(str::to_string)).unwrap_or_default();
                if pid.is_empty() {
                    continue;
                }
                add_node(conn, &from);
                add_node(conn, &pid);
                *edges.entry((from.clone(), pid, "message".into())).or_insert(0) += n;
            }
        }
    }
    // Runs: who ran in which room.
    if has("ws_runs") {
        let mut st = conn.prepare("SELECT agent, room, COUNT(*) FROM ws_runs GROUP BY agent, room").map_err(e2s)?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?))).map_err(e2s)?;
        for (pid, conv, n) in rows.flatten() {
            let Some(conv) = conv else { continue };
            add_node(conn, &pid);
            add_node(conn, &conv);
            *edges.entry((pid, conv, "run".into())).or_insert(0) += n;
        }
    }
    // Playbooks: each participant to the room the playbook ran in.
    let mut st = conn.prepare("SELECT room, kind, params_json FROM ws_playbooks WHERE engine = 'playbook'").map_err(e2s)?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e2s)?;
    for (room, kind, p) in rows.flatten() {
        let params: Value = serde_json::from_str(&p).unwrap_or(json!({}));
        add_node(conn, &room);
        for m in strs(&params["members"]) {
            add_node(conn, &m);
            *edges.entry((m, room.clone(), format!("playbook:{kind}"))).or_insert(0) += 1;
        }
    }
    let keep = |pid: &str| match root {
        None => true,
        Some(r) => !pid.starts_with("session:") || pid.ends_with(r),
    };
    Ok(json!({
        "nodes": nodes.values().filter(|n| keep(n["pid"].as_str().unwrap_or(""))).cloned().collect::<Vec<_>>(),
        "edges": edges.iter().filter(|((a, b, _), _)| keep(a) && keep(b)).map(|((a, b, k), n)| json!({"from": a, "to": b, "kind": k, "count": n})).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
#[path = "playbooks_tests.rs"]
mod tests;
