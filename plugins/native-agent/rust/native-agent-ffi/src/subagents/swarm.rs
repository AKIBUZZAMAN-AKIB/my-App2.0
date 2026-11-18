//! Swarm protocols on top of `channels.rs`: handoff (OpenAI Swarm /
//! LangGraph Swarm), gossip (epidemic spread with a seen-set and hop limit),
//! contract net (announce, bid, award), voting with consensus rules and a
//! quorum, multi-agent debate (Du et al.: rounds where every participant
//! reads the others' latest positions), and leader election (bully-style
//! rank or a Raft-like majority vote in a numbered term).
//!
//! Every protocol is bounded in code: max handoffs per chain, max rounds,
//! gossip hops, timeouts on every wait, and the wait-for graph refuses a
//! wait that would deadlock.

use super::channels::{Waited, SWARM_HISTORY};
use super::*;
use std::collections::{BTreeMap, VecDeque};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Bid {
    pub bidder_id: String,
    pub bidder_name: String,
    pub proposal: String,
    pub cost: Option<f64>,
    pub confidence: Option<f64>,
    pub declined: bool,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Auction {
    pub id: String,
    pub announcer_id: String,
    pub announcer_name: String,
    pub task: String,
    pub criteria: String,
    pub invited: Vec<String>,
    pub bids: Vec<Bid>,
    /// open | awarded | no_bids | cancelled
    pub status: String,
    pub policy: String,
    pub winner_id: Option<String>,
    pub winner_name: Option<String>,
    pub waiting: bool,
    pub created_at: i64,
    pub closed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Ballot {
    pub voter_id: String,
    pub voter_name: String,
    pub option: String,
    pub reason: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Vote {
    pub id: String,
    /// vote | election
    pub kind: String,
    pub caller_id: String,
    pub caller_name: String,
    pub question: String,
    pub options: Vec<String>,
    pub voters: Vec<String>,
    pub ballots: Vec<Ballot>,
    pub rule: String,
    pub quorum: u32,
    /// open | passed | no_majority | tie | no_quorum | cancelled
    pub status: String,
    pub winner: Option<String>,
    pub tally: BTreeMap<String, u32>,
    pub waiting: bool,
    pub created_at: i64,
    pub closed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DebateTurn {
    pub round: u32,
    pub agent_id: String,
    pub agent_name: String,
    pub stance: String,
    pub position: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Debate {
    pub id: String,
    pub moderator_id: String,
    pub moderator_name: String,
    pub topic: String,
    pub participants: Vec<String>,
    pub rounds: u32,
    pub round: u32,
    pub turns: Vec<DebateTurn>,
    /// Turns of early rounds folded by auto-compaction.
    pub digest: super::compact::Digest,
    /// running | converged | split | stopped
    pub status: String,
    pub created_at: i64,
    pub closed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Election {
    pub id: String,
    pub method: String,
    pub term: u64,
    pub caller_id: String,
    pub candidates: Vec<String>,
    pub winner_id: Option<String>,
    pub winner_name: Option<String>,
    pub vote_id: Option<String>,
    pub reason: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Rumor {
    pub id: String,
    pub origin_id: String,
    pub origin_name: String,
    pub fact: String,
    pub seen: Vec<String>,
    pub hops: u32,
    pub sends: u32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Handoff {
    pub from_id: String,
    pub from_name: String,
    pub to_id: String,
    pub to_name: String,
    pub note: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SwarmState {
    pub auctions: VecDeque<Auction>,
    pub votes: VecDeque<Vote>,
    pub debates: VecDeque<Debate>,
    pub elections: VecDeque<Election>,
    pub rumors: VecDeque<Rumor>,
    pub handoffs: VecDeque<Handoff>,
    /// The elected coordinator (agent id) and its term (fences stale leaders).
    pub coordinator: Option<String>,
    pub coordinator_name: Option<String>,
    pub term: u64,
    /// The agent that holds the work after the latest handoff.
    pub active_agent: Option<String>,
    /// Closed items folded out of the logs above, per kind.
    pub digests: BTreeMap<String, super::compact::Digest>,
}

impl SwarmState {
    /// Fold closed auctions, votes, debates, elections, rumours and handoffs
    /// past the policy's mark; old rounds of a long debate fold too.
    pub fn compact(&mut self, p: &super::compact::Policy) -> usize {
        use super::compact::{fold_queue, one_line};
        let mut n = 0;
        let mut d = std::mem::take(&mut self.digests);
        n += fold_queue(&mut self.auctions, d.entry("auctions".into()).or_default(), p, |a| a.status != "open", |a| {
            (a.announcer_name.clone(), format!("{} -> {}{}", one_line(&a.task, 60), a.status, a.winner_name.as_ref().map(|w| format!(" ({})", w)).unwrap_or_default()), a.closed_at.unwrap_or(a.created_at))
        });
        n += fold_queue(&mut self.votes, d.entry("votes".into()).or_default(), p, |v| v.status != "open", |v| {
            (v.caller_name.clone(), format!("{} -> {}{} ({} ballots)", one_line(&v.question, 60), v.status, v.winner.as_ref().map(|w| format!(": {}", w)).unwrap_or_default(), v.ballots.len()), v.closed_at.unwrap_or(v.created_at))
        });
        n += fold_queue(&mut self.debates, d.entry("debates".into()).or_default(), p, |x| x.status != "running", |x| {
            (x.moderator_name.clone(), format!("{} -> {} after {} round(s)", one_line(&x.topic, 60), x.status, x.round), x.closed_at.unwrap_or(x.created_at))
        });
        n += fold_queue(&mut self.elections, d.entry("elections".into()).or_default(), p, |_| true, |e| {
            (String::new(), format!("term {} by {} -> {}", e.term, e.method, e.winner_name.clone().unwrap_or_else(|| "no winner".into())), e.at)
        });
        n += fold_queue(&mut self.rumors, d.entry("rumors".into()).or_default(), p, |_| true, |r| (r.origin_name.clone(), r.fact.clone(), r.created_at));
        n += fold_queue(&mut self.handoffs, d.entry("handoffs".into()).or_default(), p, |_| true, |h| (format!("{} -> {}", h.from_name, h.to_name), h.note.clone(), h.at));
        d.retain(|_, x| !x.is_empty());
        self.digests = d;
        // A long debate keeps its last two rounds verbatim; earlier turns fold into its own digest.
        for x in self.debates.iter_mut() {
            if x.turns.len() > p.at && x.round > 2 {
                let cut = x.round - 1;
                let (old, keep): (Vec<DebateTurn>, Vec<DebateTurn>) = std::mem::take(&mut x.turns).into_iter().partition(|t| t.round < cut);
                for t in &old {
                    x.digest.add(&t.agent_name, &format!("r{} {}", t.round, if t.stance.is_empty() { &t.position } else { &t.stance }), t.at);
                }
                if !old.is_empty() {
                    x.digest.runs += 1;
                }
                n += old.len();
                x.turns = keep;
            }
        }
        n
    }
}

fn push_capped<T>(q: &mut VecDeque<T>, v: T) {
    q.push_back(v);
    while q.len() > SWARM_HISTORY {
        q.pop_front();
    }
}

fn new_id(prefix: &str) -> String {
    format!("{}_{}", prefix, &uuid::Uuid::new_v4().simple().to_string()[..8])
}

fn flag(input: &Value, k: &str) -> bool {
    input.get(k).is_some_and(|v| v.as_bool().unwrap_or(false) || v.as_str() == Some("true"))
}

fn num(input: &Value, k: &str) -> Option<f64> {
    input.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

fn str_list(input: &Value, k: &str) -> Vec<String> {
    match input.get(k) {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(|s| s.trim().to_string()).or_else(|| v.as_i64().map(|n| n.to_string()))).filter(|s| !s.is_empty()).collect(),
        Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        _ => Vec::new(),
    }
}

/// A random-enough permutation for gossip peer choice (no rand dependency).
fn shuffle<T>(v: &mut [T]) {
    for i in (1..v.len()).rev() {
        let r = uuid::Uuid::new_v4().as_u128();
        let j = (r % (i as u128 + 1)) as usize;
        v.swap(i, j);
    }
}

/// The short stance line of a debate answer: its `POSITION:` line, else its
/// first line; lower-case, punctuation trimmed (convergence compares these).
pub fn stance_of(answer: &str) -> String {
    let line = answer
        .lines()
        .find_map(|l| {
            let t = l.trim();
            let low = t.to_lowercase();
            low.strip_prefix("position:").map(|_| t[9..].trim().to_string()).or_else(|| low.strip_prefix("stance:").map(|_| t[7..].trim().to_string()))
        })
        .unwrap_or_else(|| answer.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string());
    let s: String = line.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect();
    truncate_chars(&s.split_whitespace().collect::<Vec<_>>().join(" "), 120)
}

/// Tally ballots by a consensus rule. Returns (status, winner, tally).
pub fn tally(options: &[String], voters: usize, ballots: &[Ballot], rule: &str, quorum: u32) -> (String, Option<String>, BTreeMap<String, u32>) {
    let mut t: BTreeMap<String, u32> = options.iter().map(|o| (o.clone(), 0)).collect();
    for b in ballots {
        *t.entry(b.option.clone()).or_insert(0) += 1;
    }
    let cast = ballots.len() as u32;
    if cast == 0 || (cast * 100) < quorum * voters as u32 {
        return ("no_quorum".into(), None, t);
    }
    let top = t.values().copied().max().unwrap_or(0);
    let leaders: Vec<&String> = t.iter().filter(|(_, n)| **n == top).map(|(k, _)| k).collect();
    let unique = leaders.len() == 1;
    let winner = unique.then(|| leaders[0].clone());
    let ok = match rule {
        "plurality" => unique,
        "unanimous" => unique && top == cast && cast as usize == voters,
        "supermajority" => unique && top * 3 >= cast * 2,
        _ => unique && top * 2 > cast,
    };
    if ok {
        ("passed".into(), winner, t)
    } else if !unique {
        ("tie".into(), None, t)
    } else {
        ("no_majority".into(), None, t)
    }
}

/// Bully-style ranking: leads and hubs first, then the highest in the team,
/// then the highest priority, then the oldest. Deterministic.
pub fn rank_candidates(c: &mut [SubagentRecord]) {
    c.sort_by(|a, b| {
        let lead = |r: &SubagentRecord| matches!(r.comms_role.as_deref(), Some("lead") | Some("hub"));
        lead(b).cmp(&lead(a)).then(a.depth.cmp(&b.depth)).then(b.priority.cmp(&a.priority)).then(a.created_at.cmp(&b.created_at)).then(a.id.cmp(&b.id))
    });
}

/// Pick the winning bid by policy. None with policy `manager` (the announcer picks).
pub fn pick_bid(bids: &[Bid], policy: &str) -> Option<Bid> {
    let live: Vec<&Bid> = bids.iter().filter(|b| !b.declined).collect();
    if live.is_empty() {
        return None;
    }
    let conf = |b: &Bid| b.confidence.unwrap_or(0.5);
    let cost = |b: &Bid| b.cost.unwrap_or(f64::INFINITY);
    let cmpf = |x: f64, y: f64| x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
    let mut v = live.clone();
    match policy {
        "manager" => return None,
        "first" => v.sort_by_key(|b| b.at),
        "cheapest" => v.sort_by(|a, b| cmpf(cost(a), cost(b)).then(cmpf(conf(b), conf(a))).then(a.at.cmp(&b.at))),
        "confident" => v.sort_by(|a, b| cmpf(conf(b), conf(a)).then(a.at.cmp(&b.at))),
        // best: confidence per unit of cost, so a sure cheap bid beats a sure dear one.
        _ => v.sort_by(|a, b| {
            let s = |x: &Bid| conf(x) / (1.0 + x.cost.unwrap_or(1.0).max(0.0));
            cmpf(s(b), s(a)).then(cmpf(conf(b), conf(a))).then(a.at.cmp(&b.at))
        }),
    }
    v.first().map(|b| (*b).clone())
}

impl SubagentManager {
    pub(super) async fn handle_swarm_tool(self: &Arc<Self>, me: SubagentRecord, tool: &str, input: &Value, env: ParentEnv) -> (String, bool) {
        match tool {
            channels::TOOL_HANDOFF => self.handoff_tool(&me, input, &env),
            channels::TOOL_GOSSIP => self.gossip_tool(&me, input, &env),
            channels::TOOL_ANNOUNCE => self.announce_tool(&me, input, &env).await,
            channels::TOOL_BID => self.bid_tool(&me, input, &env),
            channels::TOOL_AWARD => {
                let id = input.get("auction_id").or_else(|| input.get("auctionId")).and_then(Value::as_str).unwrap_or("").trim().to_string();
                let to = input.get("to").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
                self.award(&me, &id, to.as_deref(), &env)
            }
            channels::TOOL_CALL_VOTE => self.call_vote_tool(&me, input, &env).await,
            channels::TOOL_CAST_VOTE => self.cast_vote_tool(&me, input, &env),
            channels::TOOL_DEBATE => self.debate_tool(&me, input, &env).await,
            channels::TOOL_ELECT => self.elect_tool(&me, input, &env).await,
            _ => (format!("Unknown tool {}", tool), true),
        }
    }

    fn resolve_members(&self, me: &SubagentRecord, refs: &[String]) -> Result<Vec<SubagentRecord>, String> {
        let mut out: Vec<SubagentRecord> = Vec::new();
        for r in refs {
            if r == &me.id || r.eq_ignore_ascii_case(&me.name) || r.eq_ignore_ascii_case("me") {
                continue;
            }
            let Some(m) = self.find_member(me, r) else { return Err(format!("No visible agent {}. Call list_peers.", r)) };
            if !out.iter().any(|x| x.id == m.id) {
                out.push(m);
            }
        }
        Ok(out)
    }

    // ── Handoff ─────────────────────────────────────────────────────────────────

    /// How many handoffs led to this agent (following handed_from back).
    fn handoff_depth(&self, rec: &SubagentRecord) -> (u32, Vec<String>) {
        let mut chain = vec![rec.id.clone()];
        let mut cur = rec.handed_from.clone();
        while let Some(id) = cur {
            if chain.contains(&id) || chain.len() > 50 {
                break;
            }
            chain.push(id.clone());
            cur = self.get(&id).and_then(|r| r.handed_from);
        }
        ((chain.len() - 1) as u32, chain)
    }

    /// The agent that finally holds `id`'s work after its handoffs.
    pub fn handoff_target(&self, id: &str) -> Option<String> {
        let mut cur = self.get(id)?.handed_to?;
        let mut seen = vec![id.to_string()];
        while let Some(next) = self.get(&cur).and_then(|r| r.handed_to) {
            if seen.contains(&next) || seen.len() > 50 {
                break;
            }
            seen.push(cur.clone());
            cur = next;
        }
        Some(cur)
    }

    fn handoff_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let to_ref = input.get("to").and_then(Value::as_str).unwrap_or("").trim();
        let note = input.get("note").or_else(|| input.get("message")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let Some(target) = self.find_member(me, to_ref) else {
            return (format!("No visible agent {}. Call list_peers.", to_ref), true);
        };
        let me = self.get(&me.id).unwrap_or_else(|| me.clone());
        if let Some(t) = &me.handed_to {
            let name = self.get(t).map(|r| r.name).unwrap_or_else(|| t.clone());
            return (format!("You already handed this task to {}. End your turn.", name), true);
        }
        if let Err(e) = self.may_message(&me, &target) {
            return (e, true);
        }
        let eff = self.effective_comms(&self.root_of(&me.session_key));
        let (depth, chain) = self.handoff_depth(&me);
        if depth >= eff.max_handoffs {
            return (format!("This task has been handed on {} times, the most allowed. Finish it yourself.", depth), true);
        }
        if chain.contains(&target.id) {
            return (format!("{} already handed this task on; handing it back would loop. Finish it yourself or ask with request_peer.", target.name), true);
        }
        if target.paused || target.status == "error" && target.is_active() {
            return (format!("{} can't take work now.", target.name), true);
        }
        let hop = match self.guard_send(&me, Some(&target), false) {
            Ok(h) => h,
            Err(e) => return (e, true),
        };
        self.update(&me.id, |r| r.handed_to = Some(target.id.clone()));
        self.update(&target.id, |r| r.handed_from = Some(me.id.clone()));
        self.persist();
        // Earlier hops of this chain travel along, compacted to one line each.
        let root0 = self.root_of(&me.session_key);
        let earlier = self.read_chat(&root0, |c| c.swarm.handoffs.iter().filter(|h| chain.contains(&h.to_id)).map(|h| (format!("{} -> {}", h.from_name, h.to_name), h.note.clone(), h.at)).collect::<Vec<_>>());
        let trail = if earlier.is_empty() {
            String::new()
        } else {
            let mut d = compact::Digest::default();
            for (who, n, at) in &earlier {
                d.add(who, if n.is_empty() { "(no note)" } else { n }, *at);
            }
            format!("\n\nEarlier handoffs in this chain:\n{}", d.render("handoffs"))
        };
        let text = format!(
            "[Handoff from sub-agent \"{}\" (id {})]\n{} handed its task to you; you are now the active agent for it and your report is the answer its parent receives.\n\nTask:\n{}\n\nNote from {}:\n{}{}",
            me.name,
            me.id,
            me.name,
            compact::head_tail(&me.task, 8_000),
            me.name,
            if note.is_empty() { "(none)".into() } else { compact::head_tail(&note, 4_000) },
            trail
        );
        let target_now = self.get(&target.id).unwrap_or(target.clone());
        let how = self.send_comm(&target_now, text, hop, true, env);
        let root = self.root_of(&me.session_key);
        self.with_chat(&root, |c| {
            push_capped(&mut c.swarm.handoffs, Handoff { from_id: me.id.clone(), from_name: me.name.clone(), to_id: target.id.clone(), to_name: target.name.clone(), note: truncate_chars(&note, 2_000), at: now_ms() });
            c.swarm.active_agent = Some(target.id.clone());
        });
        self.swarm_event(env, &me, "handoff", Some(&target), "", &note, how, json!({ "depth": depth + 1 }));
        (format!("Handed your task to {} ({}). End your turn now with one short line saying you handed it to {}.", target.name, how, target.name), false)
    }

    // ── Gossip ──────────────────────────────────────────────────────────────────

    fn gossip_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let root = self.root_of(&me.session_key);
        let eff = self.effective_comms(&root);
        let rid = input.get("rumor_id").or_else(|| input.get("rumorId")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let fact = input.get("fact").or_else(|| input.get("message")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let rumor = match &rid {
            Some(id) => match self.read_chat(&root, |c| c.swarm.rumors.iter().find(|r| &r.id == id).cloned()) {
                Some(r) => r,
                None => return (format!("No rumour {}.", id), true),
            },
            None => {
                if fact.is_empty() {
                    return ("Give a `fact` to spread, or the `rumor_id` of one you received.".into(), true);
                }
                Rumor { id: new_id("gs"), origin_id: me.id.clone(), origin_name: me.name.clone(), fact: truncate_chars(&fact, 4_000), seen: vec![me.id.clone()], hops: 0, sends: 0, created_at: now_ms() }
            }
        };
        let hop = rumor.hops + 1;
        if hop > eff.max_rounds.max(1) + 2 {
            return (format!("Rumour {} has spread {} hops, the most allowed. Don't pass it on.", rumor.id, rumor.hops), true);
        }
        let mut pool: Vec<SubagentRecord> = self.reachable(me).into_iter().filter(|r| !rumor.seen.contains(&r.id)).collect();
        if pool.is_empty() {
            if rid.is_none() {
                self.with_chat(&root, |c| push_capped(&mut c.swarm.rumors, rumor.clone()));
            }
            return (format!("Everyone you can reach has already heard rumour {}.", rumor.id), false);
        }
        let sh = match self.guard_send(me, None, false) {
            Ok(h) => h,
            Err(e) => return (e, true),
        };
        shuffle(&mut pool);
        pool.truncate(eff.gossip_fanout.max(1) as usize);
        let max_hops = eff.max_rounds.max(1) + 2;
        let note = format!(
            "[Gossip {} from sub-agent \"{}\" (id {}), hop {}/{}; first said by {}]\n{}\nIf others should know too, pass it on with gossip(rumor_id=\"{}\").",
            rumor.id, me.name, me.id, hop, max_hops, rumor.origin_name, rumor.fact, rumor.id
        );
        for p in &pool {
            self.send_comm(p, note.clone(), sh, false, env);
        }
        let names: Vec<String> = pool.iter().map(|p| p.name.clone()).collect();
        let id = rumor.id.clone();
        let mut seen = rumor.seen.clone();
        if !seen.contains(&me.id) {
            seen.push(me.id.clone());
        }
        seen.extend(pool.iter().map(|p| p.id.clone()));
        let fact_text = rumor.fact.clone();
        self.with_chat(&root, |c| {
            if let Some(r) = c.swarm.rumors.iter_mut().find(|r| r.id == id) {
                r.seen = seen.clone();
                r.hops = r.hops.max(hop);
                r.sends += pool.len() as u32;
            } else {
                let mut r = rumor.clone();
                r.seen = seen.clone();
                r.hops = hop;
                r.sends = pool.len() as u32;
                push_capped(&mut c.swarm.rumors, r);
            }
        });
        self.swarm_event(env, me, "gossip", None, &names.join(", "), &fact_text, "spread", json!({ "rumorId": id, "hop": hop, "recipients": names }));
        (format!("Gossip {} passed to {} (hop {}).", id, names.join(", "), hop), false)
    }

    // ── Contract net ────────────────────────────────────────────────────────────

    async fn announce_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let task = input.get("task").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if task.is_empty() {
            return ("`task` is empty.".into(), true);
        }
        let criteria = input.get("criteria").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let refs = str_list(input, "to");
        let invited = if refs.is_empty() {
            self.reachable(me)
        } else {
            match self.resolve_members(me, &refs) {
                Ok(v) => v,
                Err(e) => return (e, true),
            }
        };
        if let Some(bad) = invited.iter().find(|r| self.may_message(me, r).is_err()) {
            return (format!("You may not message {}, so it can't bid.", bad.name), true);
        }
        if invited.is_empty() {
            return ("Nobody you may message can bid. Do the task yourself.".into(), true);
        }
        let root = self.root_of(&me.session_key);
        let eff = self.effective_comms(&root);
        let wait_s = num(input, "wait_s").or_else(|| num(input, "waitS")).map(|x| (x as u64).clamp(5, 900));
        let ids: Vec<String> = invited.iter().map(|r| r.id.clone()).collect();
        let deadlock = wait_s.and_then(|_| self.would_deadlock(&me.id, &ids));
        let hop = match self.guard_send(me, None, false) {
            Ok(h) => h,
            Err(e) => return (e, true),
        };
        let id = new_id("au");
        let waiting = wait_s.is_some() && deadlock.is_none();
        let a = Auction {
            id: id.clone(),
            announcer_id: me.id.clone(),
            announcer_name: me.name.clone(),
            task: truncate_chars(&task, 8_000),
            criteria: truncate_chars(&criteria, 2_000),
            invited: ids.clone(),
            status: "open".into(),
            policy: eff.auction_policy.clone(),
            waiting,
            created_at: now_ms(),
            ..Default::default()
        };
        self.with_chat(&root, |c| push_capped(&mut c.swarm.auctions, a));
        let note = format!(
            "[Call for proposals {} from sub-agent \"{}\" (id {})]\nTask: {}{}\nBid with bid_task(auction_id=\"{}\", proposal=..., cost=<estimated steps>, confidence=<0-1>), or bid_task(auction_id=\"{}\", decline=true) to pass.",
            id,
            me.name,
            me.id,
            truncate_chars(&task, 8_000),
            if criteria.is_empty() { String::new() } else { format!("\nCriteria: {}", criteria) },
            id,
            id
        );
        for r in &invited {
            self.send_comm(r, note.clone(), hop, eff.wake_idle, env);
        }
        let names: Vec<String> = invited.iter().map(|r| r.name.clone()).collect();
        self.swarm_event(env, me, "cfp", None, &names.join(", "), &task, "open", json!({ "auctionId": id, "invited": names }));
        let Some(wait_s) = wait_s.filter(|_| waiting) else {
            let pre = if deadlock.is_some() { "Not waiting (a bidder already waits on you, so waiting would deadlock). " } else { "" };
            return (format!("{}Announced {} to {}. Bids arrive as messages; award with award_task.", pre, id, names.join(", ")), false);
        };
        let _g = self.begin_wait(&me.id, &ids);
        let aid = id.clone();
        let root2 = root.clone();
        let end = self
            .wait_until(Duration::from_secs(wait_s), &env.abort, move |m| m.read_chat(&root2, |c| c.swarm.auctions.iter().find(|x| x.id == aid).is_none_or(|x| x.status != "open" || x.invited.iter().all(|i| x.bids.iter().any(|b| &b.bidder_id == i)))))
            .await;
        self.with_chat(&root, |c| {
            if let Some(x) = c.swarm.auctions.iter_mut().find(|x| x.id == id) {
                x.waiting = false;
            }
        });
        if end == Waited::Aborted {
            return ("Cancelled while waiting for bids.".into(), true);
        }
        let a = self.read_chat(&root, |c| c.swarm.auctions.iter().find(|x| x.id == id).cloned());
        let Some(a) = a else { return ("The auction is gone.".into(), true) };
        if a.status != "open" {
            return (format!("Auction {} is {}.", id, a.status), false);
        }
        let bids = Self::bids_text(&a);
        if a.policy == "manager" {
            return (format!("Bids for {}:\n{}\nPick one with award_task(auction_id=\"{}\", to=<name>).", id, bids, id), false);
        }
        let (out, err) = self.award(me, &id, None, env);
        (format!("Bids for {}:\n{}\n{}", id, bids, out), err)
    }

    fn bids_text(a: &Auction) -> String {
        if a.bids.is_empty() {
            return "(no bids)".into();
        }
        a.bids
            .iter()
            .map(|b| {
                if b.declined {
                    format!("- {}: declined", b.bidder_name)
                } else {
                    format!(
                        "- {}: {}{}{}",
                        b.bidder_name,
                        truncate_chars(&b.proposal, 400),
                        b.cost.map(|c| format!(" (cost {})", c)).unwrap_or_default(),
                        b.confidence.map(|c| format!(" (confidence {:.2})", c)).unwrap_or_default()
                    )
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn bid_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let id = input.get("auction_id").or_else(|| input.get("auctionId")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let root = self.root_of(&me.session_key);
        let Some(a) = self.read_chat(&root, |c| c.swarm.auctions.iter().find(|x| x.id == id).cloned()) else {
            return (format!("No auction {}.", id), true);
        };
        if a.status != "open" {
            return (format!("Auction {} is closed ({}).", id, a.status), true);
        }
        if !a.invited.contains(&me.id) {
            return (format!("You were not invited to bid on {}.", id), true);
        }
        let declined = flag(input, "decline");
        let proposal = input.get("proposal").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !declined && proposal.is_empty() {
            return ("Give a `proposal`, or decline=true.".into(), true);
        }
        let announcer = self.get(&a.announcer_id);
        if let Err(e) = self.guard_send(me, announcer.as_ref(), true) {
            return (e, true);
        }
        let bid = Bid {
            bidder_id: me.id.clone(),
            bidder_name: me.name.clone(),
            proposal: truncate_chars(&proposal, 4_000),
            cost: num(input, "cost").filter(|c| c.is_finite() && *c >= 0.0),
            confidence: num(input, "confidence").map(|c| c.clamp(0.0, 1.0)),
            declined,
            at: now_ms(),
        };
        let waiting = self.with_chat(&root, |c| {
            let x = c.swarm.auctions.iter_mut().find(|x| x.id == id)?;
            x.bids.retain(|b| b.bidder_id != me.id);
            x.bids.push(bid.clone());
            Some(x.waiting)
        });
        if waiting == Some(false) {
            if let Some(an) = &announcer {
                let line = Self::bids_text(&Auction { bids: vec![bid.clone()], ..Default::default() });
                self.send_comm(an, format!("[Bid on {} from sub-agent \"{}\" (id {})]\n{}\nAward with award_task(auction_id=\"{}\").", id, me.name, me.id, line, id), 1, false, env);
            }
        }
        self.swarm_event(env, me, "bid", announcer.as_ref(), "", if declined { "declined" } else { &proposal }, if declined { "declined" } else { "bid" }, json!({ "auctionId": id, "cost": bid.cost, "confidence": bid.confidence }));
        (if declined { format!("Declined {}.", id) } else { format!("Bid placed on {}.", id) }, false)
    }

    fn award(self: &Arc<Self>, me: &SubagentRecord, id: &str, to: Option<&str>, env: &ParentEnv) -> (String, bool) {
        let root = self.root_of(&me.session_key);
        let Some(a) = self.read_chat(&root, |c| c.swarm.auctions.iter().find(|x| x.id == id).cloned()) else {
            return (format!("No auction {}.", id), true);
        };
        if a.announcer_id != me.id {
            return (format!("Only {} can award {}.", a.announcer_name, id), true);
        }
        if a.status != "open" {
            return (format!("Auction {} is already {}.", id, a.status), true);
        }
        let win = match to {
            Some(t) => match a.bids.iter().find(|b| !b.declined && (b.bidder_id == t || b.bidder_name.eq_ignore_ascii_case(t))) {
                Some(b) => Some(b.clone()),
                None => return (format!("{} did not bid on {}.", t, id), true),
            },
            None => {
                if a.policy == "manager" {
                    return (format!("The rule here is that you pick: award_task(auction_id=\"{}\", to=<bidder>).", id), true);
                }
                pick_bid(&a.bids, &a.policy)
            }
        };
        let Some(win) = win else {
            self.with_chat(&root, |c| {
                if let Some(x) = c.swarm.auctions.iter_mut().find(|x| x.id == id) {
                    x.status = "no_bids".into();
                    x.closed_at = Some(now_ms());
                }
            });
            self.swarm_event(env, me, "award", None, "nobody", &a.task, "no_bids", json!({ "auctionId": id }));
            return (format!("Nobody bid on {}. Do the task yourself or announce it again.", id), false);
        };
        self.with_chat(&root, |c| {
            if let Some(x) = c.swarm.auctions.iter_mut().find(|x| x.id == id) {
                x.status = "awarded".into();
                x.winner_id = Some(win.bidder_id.clone());
                x.winner_name = Some(win.bidder_name.clone());
                x.closed_at = Some(now_ms());
            }
        });
        let eff = self.effective_comms(&root);
        let winner = self.get(&win.bidder_id);
        if let Some(w) = &winner {
            let note = format!(
                "[Award {} from sub-agent \"{}\" (id {})]\nYou won the task. Do it as you proposed and send the result to {} with message_peer.\nTask: {}\nYour proposal: {}",
                id, me.name, me.id, me.name, a.task, win.proposal
            );
            self.send_comm(w, note, 1, eff.wake_idle, env);
        }
        for b in a.bids.iter().filter(|b| b.bidder_id != win.bidder_id && !b.declined) {
            if let Some(l) = self.get(&b.bidder_id) {
                self.deliver(&l, format!("[Auction {} closed] {} awarded the task to {}; you don't need to do it.", id, me.name, win.bidder_name));
            }
        }
        self.swarm_event(env, me, "award", winner.as_ref(), &win.bidder_name, &a.task, "awarded", json!({ "auctionId": id, "policy": a.policy }));
        (format!("Awarded {} to {} (by {}). Its result arrives as a message.", id, win.bidder_name, if to.is_some() { "your choice".to_string() } else { format!("the {} rule", a.policy) }), false)
    }

    // ── Voting ──────────────────────────────────────────────────────────────────

    /// Open a vote and send the ballots. Returns the vote id.
    #[allow(clippy::too_many_arguments)]
    fn open_vote(self: &Arc<Self>, me: &SubagentRecord, kind: &str, question: &str, options: Vec<String>, voters: &[SubagentRecord], waiting: bool, env: &ParentEnv) -> Result<String, String> {
        let root = self.root_of(&me.session_key);
        let eff = self.effective_comms(&root);
        let hop = self.guard_send(me, None, kind == "election")?;
        let id = new_id("vt");
        let mut ids: Vec<String> = voters.iter().map(|r| r.id.clone()).collect();
        if kind == "vote" || ids.is_empty() {
            ids.insert(0, me.id.clone());
        }
        let v = Vote {
            id: id.clone(),
            kind: kind.into(),
            caller_id: me.id.clone(),
            caller_name: me.name.clone(),
            question: truncate_chars(question, 2_000),
            options: options.clone(),
            voters: ids,
            rule: if kind == "election" { "majority".into() } else { eff.consensus_rule.clone() },
            quorum: eff.quorum_percent,
            status: "open".into(),
            waiting,
            created_at: now_ms(),
            ..Default::default()
        };
        self.with_chat(&root, |c| push_capped(&mut c.swarm.votes, v));
        let note = format!(
            "[{} {} from sub-agent \"{}\" (id {})]\n{}\nOptions: {}\nCast with cast_vote(vote_id=\"{}\", option=..., reason=...).",
            if kind == "election" { "Election ballot" } else { "Vote" },
            id,
            me.name,
            me.id,
            question,
            options.join(" | "),
            id
        );
        for r in voters {
            self.send_comm(r, note.clone(), hop, eff.wake_idle || kind == "election", env);
        }
        Ok(id)
    }

    /// Close a vote: tally, store, tell the voters (and the caller when it
    /// does not wait). Returns the closed vote.
    fn close_vote(self: &Arc<Self>, root: &str, id: &str) -> Option<Vote> {
        let v = self.with_chat(root, |c| {
            let v = c.swarm.votes.iter_mut().find(|v| v.id == id)?;
            if v.status != "open" {
                return None;
            }
            let (status, winner, t) = tally(&v.options, v.voters.len(), &v.ballots, &v.rule, v.quorum);
            v.status = status;
            v.winner = winner;
            v.tally = t;
            v.closed_at = Some(now_ms());
            Some(v.clone())
        })?;
        let line = Self::vote_line(&v);
        for vid in v.voters.iter().filter(|x| **x != v.caller_id) {
            if let Some(r) = self.get(vid) {
                self.deliver(&r, format!("[Vote {} closed] {}", v.id, line));
            }
        }
        if !v.waiting && v.kind == "vote" {
            if let Some(c) = self.get(&v.caller_id) {
                self.deliver(&c, format!("[Vote {} closed] {}", v.id, line));
            }
        }
        Some(v)
    }

    fn vote_line(v: &Vote) -> String {
        let counts: Vec<String> = v.tally.iter().map(|(k, n)| format!("{} {}", k, n)).collect();
        let verdict = match (v.status.as_str(), &v.winner) {
            ("passed", Some(w)) => format!("\"{}\" wins ({} rule)", w, v.rule),
            ("tie", _) => "tie, no decision".into(),
            ("no_quorum", _) => format!("no quorum ({} of {} voted, {}% needed)", v.ballots.len(), v.voters.len(), v.quorum),
            _ => format!("no {} reached", v.rule),
        };
        format!("{}: {}. Votes: {}.", v.question, verdict, counts.join(", "))
    }

    async fn call_vote_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let question = input.get("question").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let mut options: Vec<String> = Vec::new();
        for o in str_list(input, "options") {
            let o = truncate_chars(&o, 80);
            if !options.iter().any(|x| x.eq_ignore_ascii_case(&o)) {
                options.push(o);
            }
        }
        if question.is_empty() || options.len() < 2 || options.len() > 10 {
            return ("A vote needs a `question` and 2-10 different `options`.".into(), true);
        }
        let refs = str_list(input, "voters");
        let voters = if refs.is_empty() {
            self.team_members(me)
        } else {
            match self.resolve_members(me, &refs) {
                Ok(v) => v,
                Err(e) => return (e, true),
            }
        };
        if voters.is_empty() {
            return ("Nobody else can vote.".into(), true);
        }
        let wait_s = num(input, "wait_s").or_else(|| num(input, "waitS")).map(|x| (x as u64).clamp(5, 900));
        let ids: Vec<String> = voters.iter().map(|r| r.id.clone()).collect();
        let deadlock = wait_s.and_then(|_| self.would_deadlock(&me.id, &ids));
        let waiting = wait_s.is_some() && deadlock.is_none();
        let id = match self.open_vote(me, "vote", &question, options.clone(), &voters, waiting, env) {
            Ok(id) => id,
            Err(e) => return (e, true),
        };
        let names: Vec<String> = voters.iter().map(|r| r.name.clone()).collect();
        self.swarm_event(env, me, "vote", None, &names.join(", "), &question, "open", json!({ "voteId": id, "options": options }));
        let root = self.root_of(&me.session_key);
        let Some(wait_s) = wait_s.filter(|_| waiting) else {
            return (format!("Vote {} opened for you and {}. Cast your own with cast_vote; the result arrives as a message.", id, names.join(", ")), false);
        };
        let _g = self.begin_wait(&me.id, &ids);
        let vid = id.clone();
        let root2 = root.clone();
        let me_id = me.id.clone();
        // The caller's own ballot is not awaited (it is blocked in this call).
        let end = self
            .wait_until(Duration::from_secs(wait_s), &env.abort, move |m| m.read_chat(&root2, |c| c.swarm.votes.iter().find(|v| v.id == vid).is_none_or(|v| v.status != "open" || v.voters.iter().filter(|x| **x != me_id).all(|x| v.ballots.iter().any(|b| &b.voter_id == x)))))
            .await;
        if end == Waited::Aborted {
            return ("Cancelled while waiting for votes.".into(), true);
        }
        match self.close_vote(&root, &id).or_else(|| self.read_chat(&root, |c| c.swarm.votes.iter().find(|v| v.id == id).cloned())) {
            Some(v) => {
                self.swarm_event(env, me, "vote_result", None, "", &Self::vote_line(&v), &v.status, json!({ "voteId": id, "winner": v.winner, "tally": v.tally }));
                (format!("Vote {} closed. {}", id, Self::vote_line(&v)), false)
            }
            None => ("The vote is gone.".into(), true),
        }
    }

    fn cast_vote_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let id = input.get("vote_id").or_else(|| input.get("voteId")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let option = input.get("option").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let reason = input.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let root = self.root_of(&me.session_key);
        let Some(v) = self.read_chat(&root, |c| c.swarm.votes.iter().find(|v| v.id == id).cloned()) else {
            return (format!("No vote {}.", id), true);
        };
        if v.status != "open" {
            return (format!("Vote {} is closed.", id), true);
        }
        if !v.voters.contains(&me.id) {
            return (format!("You are not a voter in {}.", id), true);
        }
        let Some(opt) = v.options.iter().find(|o| o.eq_ignore_ascii_case(&option)).cloned() else {
            return (format!("Pick one of: {}.", v.options.join(" | ")), true);
        };
        let caller = self.get(&v.caller_id);
        if me.id != v.caller_id {
            if let Err(e) = self.guard_send(me, caller.as_ref(), true) {
                return (e, true);
            }
        }
        let all_in = self.with_chat(&root, |c| {
            let Some(v) = c.swarm.votes.iter_mut().find(|v| v.id == id) else { return false };
            v.ballots.retain(|b| b.voter_id != me.id);
            v.ballots.push(Ballot { voter_id: me.id.clone(), voter_name: me.name.clone(), option: opt.clone(), reason: truncate_chars(&reason, 1_000), at: now_ms() });
            !v.waiting && v.voters.iter().all(|x| v.ballots.iter().any(|b| &b.voter_id == x))
        });
        self.swarm_event(env, me, "ballot", caller.as_ref(), "", &format!("{}{}", opt, if reason.is_empty() { String::new() } else { format!(" — {}", reason) }), "cast", json!({ "voteId": id, "option": opt }));
        if all_in {
            if let Some(closed) = self.close_vote(&root, &id) {
                return (format!("Voted {}. Everyone has voted: {}", opt, Self::vote_line(&closed)), false);
            }
        }
        (format!("Voted {} on {}.", opt, id), false)
    }

    // ── Debate ──────────────────────────────────────────────────────────────────

    async fn debate_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let topic = input.get("topic").or_else(|| input.get("question")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        if topic.is_empty() {
            return ("`topic` is empty.".into(), true);
        }
        let root = self.root_of(&me.session_key);
        let eff = self.effective_comms(&root);
        let refs = str_list(input, "participants");
        let mut parts = if refs.is_empty() {
            self.reachable(me)
        } else {
            match self.resolve_members(me, &refs) {
                Ok(v) => v,
                Err(e) => return (e, true),
            }
        };
        parts.truncate(6);
        if let Some(bad) = parts.iter().find(|r| self.may_message(me, r).is_err()) {
            return (format!("You may not message {}, so it can't debate.", bad.name), true);
        }
        if parts.len() < 2 {
            return ("A debate needs at least two other agents you may message.".into(), true);
        }
        let rounds = num(input, "rounds").map(|r| r as u32).unwrap_or(eff.max_rounds).clamp(1, eff.max_rounds.max(1));
        let ids: Vec<String> = parts.iter().map(|r| r.id.clone()).collect();
        if let Some(w) = self.would_deadlock(&me.id, &ids) {
            let name = self.get(&w).map(|r| r.name).unwrap_or(w);
            return (format!("{} is waiting on you, so a debate now would deadlock. Answer it first.", name), true);
        }
        if let Err(e) = self.guard_send(me, None, false) {
            return (e, true);
        }
        let id = new_id("db");
        self.with_chat(&root, |c| {
            push_capped(
                &mut c.swarm.debates,
                Debate {
                    id: id.clone(),
                    moderator_id: me.id.clone(),
                    moderator_name: me.name.clone(),
                    topic: truncate_chars(&topic, 2_000),
                    participants: ids.clone(),
                    rounds,
                    status: "running".into(),
                    created_at: now_ms(),
                    ..Default::default()
                },
            )
        });
        let names: Vec<String> = parts.iter().map(|r| r.name.clone()).collect();
        self.swarm_event(env, me, "debate", None, &names.join(", "), &topic, "started", json!({ "debateId": id, "rounds": rounds }));
        let _g = self.begin_wait(&me.id, &ids);
        let mut latest: Vec<(String, String, String)> = Vec::new(); // (name, stance, position)
        let mut status = "split";
        let mut done_rounds = 0;
        for round in 1..=rounds {
            let mut reqs: Vec<(SubagentRecord, String)> = Vec::new();
            for p in &parts {
                if let Err(e) = self.guard_send(me, Some(p), true) {
                    self.finish_debate(&root, &id, "stopped");
                    return (format!("Debate {} stopped: {}", id, e), true);
                }
                let rid = new_id("rq");
                let others: Vec<String> = latest.iter().filter(|(n, _, _)| n != &p.name).map(|(n, _, pos)| format!("- {}: {}", n, truncate_chars(pos, 1_500))).collect();
                let body = if round == 1 {
                    "State your position and your main reasons.".to_string()
                } else {
                    format!("The others' latest positions:\n{}\nRead them critically. Keep your position if it still holds, or revise it.", others.join("\n"))
                };
                let q = format!("Debate topic: {}\n{}", topic, body);
                self.swarm_rt.lock().unwrap().requests.insert(
                    rid.clone(),
                    channels::OpenRequest { id: rid.clone(), from_id: me.id.clone(), to_id: p.id.clone(), question: q.clone(), answer: None, waiting: true, at: now_ms() },
                );
                let note = format!(
                    "[Debate {} round {}/{}, moderated by sub-agent \"{}\"; request {}]\n{}\nStart your answer with one line \"POSITION: <your stance in a few words>\", then your reasons. Answer with reply_peer(request_id=\"{}\", answer=...).",
                    id, round, rounds, me.name, rid, q, rid
                );
                let pnow = self.get(&p.id).unwrap_or(p.clone());
                self.send_comm(&pnow, note, 1, true, env);
                reqs.push((p.clone(), rid));
            }
            let rids: Vec<String> = reqs.iter().map(|r| r.1.clone()).collect();
            let end = self
                .wait_until(Duration::from_secs(eff.request_timeout_s as u64), &env.abort, move |m| {
                    let rt = m.swarm_rt.lock().unwrap();
                    rids.iter().all(|r| rt.requests.get(r).is_none_or(|x| x.answer.is_some()))
                })
                .await;
            let mut turns = Vec::new();
            let mut now_latest = Vec::new();
            {
                let mut rt = self.swarm_rt.lock().unwrap();
                for (p, rid) in &reqs {
                    let ans = rt.requests.remove(rid).and_then(|r| r.answer);
                    let pos = ans.unwrap_or_else(|| "(no answer)".into());
                    let stance = if pos == "(no answer)" { String::new() } else { stance_of(&pos) };
                    turns.push(DebateTurn { round, agent_id: p.id.clone(), agent_name: p.name.clone(), stance: stance.clone(), position: truncate_chars(&pos, 4_000), at: now_ms() });
                    now_latest.push((p.name.clone(), stance, pos));
                }
            }
            latest = now_latest;
            done_rounds = round;
            let stances: HashSet<&String> = latest.iter().map(|(_, s, _)| s).collect();
            let converged = stances.len() == 1 && !latest.iter().any(|(_, s, _)| s.is_empty());
            self.with_chat(&root, |c| {
                if let Some(d) = c.swarm.debates.iter_mut().find(|d| d.id == id) {
                    d.turns.extend(turns);
                    d.round = round;
                }
            });
            self.swarm_event(env, me, "debate_round", None, &names.join(", "), &format!("Round {}/{}{}", round, rounds, if converged { ": agreed" } else { "" }), if converged { "converged" } else { "split" }, json!({ "debateId": id, "round": round }));
            if end == Waited::Aborted {
                self.finish_debate(&root, &id, "stopped");
                return ("Cancelled during the debate.".into(), true);
            }
            if converged {
                status = "converged";
                break;
            }
        }
        self.finish_debate(&root, &id, status);
        let lines: Vec<String> = latest.iter().map(|(n, _, p)| format!("- {}: {}", n, truncate_chars(p, 1_500))).collect();
        let verdict = if status == "converged" { format!("They agree after {} round{}.", done_rounds, if done_rounds == 1 { "" } else { "s" }) } else { format!("No agreement after {} round{}; weigh the positions yourself or call_vote.", done_rounds, if done_rounds == 1 { "" } else { "s" }) };
        (format!("Debate {} on \"{}\". {}\nFinal positions:\n{}", id, topic, verdict, lines.join("\n")), false)
    }

    fn finish_debate(&self, root: &str, id: &str, status: &str) {
        self.with_chat(root, |c| {
            if let Some(d) = c.swarm.debates.iter_mut().find(|d| d.id == id) {
                d.status = status.into();
                d.closed_at = Some(now_ms());
            }
        });
    }

    // ── Leader election ────────────────────────────────────────────────────────────────

    async fn elect_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let root = self.root_of(&me.session_key);
        let eff = self.effective_comms(&root);
        let method = input.get("method").and_then(Value::as_str).map(|m| m.trim().to_lowercase()).filter(|m| m == "rank" || m == "vote").unwrap_or(eff.election_method.clone());
        let refs = str_list(input, "candidates");
        let mut cands: Vec<SubagentRecord> = if refs.is_empty() {
            self.team_members(me)
        } else {
            match self.resolve_members(me, &refs) {
                Ok(v) => v,
                Err(e) => return (e, true),
            }
        };
        let self_in = refs.is_empty() || refs.iter().any(|r| r == &me.id || r.eq_ignore_ascii_case(&me.name) || r.eq_ignore_ascii_case("me"));
        if self_in {
            cands.insert(0, self.get(&me.id).unwrap_or(me.clone()));
        }
        cands.retain(|r| r.status != "error" && !r.paused);
        if cands.is_empty() {
            return ("No candidates.".into(), true);
        }
        let term = self.read_chat(&root, |c| c.swarm.term) + 1;
        let mut vote_id = None;
        let mut reason;
        let winner: SubagentRecord;
        if method == "vote" && cands.len() > 1 {
            let voters: Vec<SubagentRecord> = cands.iter().filter(|r| r.id != me.id).cloned().collect();
            let ids: Vec<String> = voters.iter().map(|r| r.id.clone()).collect();
            if let Some(w) = self.would_deadlock(&me.id, &ids) {
                let name = self.get(&w).map(|r| r.name).unwrap_or(w);
                return (format!("{} is waiting on you, so an election vote would deadlock. Use method rank or answer it first.", name), true);
            }
            let options: Vec<String> = cands.iter().map(|r| r.name.clone()).collect();
            let q = format!("Term {}: who should coordinate the team? Pick the agent best placed to lead.", term);
            let vid = match self.open_vote(me, "election", &q, options, &voters, true, env) {
                Ok(v) => v,
                Err(e) => return (e, true),
            };
            // The caller votes too when it is a candidate: for itself only if nobody else ranks higher.
            self.swarm_event(env, me, "election", None, &cands.iter().map(|r| r.name.clone()).collect::<Vec<_>>().join(", "), &q, "voting", json!({ "term": term, "voteId": vid }));
            let _g = self.begin_wait(&me.id, &ids);
            let v2 = vid.clone();
            let root2 = root.clone();
            let me_id = me.id.clone();
            let end = self
                .wait_until(Duration::from_secs(eff.request_timeout_s as u64), &env.abort, move |m| m.read_chat(&root2, |c| c.swarm.votes.iter().find(|v| v.id == v2).is_none_or(|v| v.status != "open" || v.voters.iter().filter(|x| **x != me_id).all(|x| v.ballots.iter().any(|b| &b.voter_id == x)))))
                .await;
            if end == Waited::Aborted {
                return ("Cancelled during the election.".into(), true);
            }
            let v = self.close_vote(&root, &vid).or_else(|| self.read_chat(&root, |c| c.swarm.votes.iter().find(|v| v.id == vid).cloned()));
            vote_id = Some(vid);
            let by_vote = v.as_ref().and_then(|v| v.winner.clone()).and_then(|w| cands.iter().find(|r| r.name == w).cloned());
            match by_vote {
                Some(w) => {
                    reason = format!("won the vote ({})", v.as_ref().map(Self::vote_line).unwrap_or_default());
                    winner = w;
                }
                None => {
                    // No majority: fall back to rank among the most-voted (or all).
                    let top: Vec<String> = v.as_ref().map(|v| {
                        let max = v.tally.values().copied().max().unwrap_or(0);
                        v.tally.iter().filter(|(_, n)| **n == max && max > 0).map(|(k, _)| k.clone()).collect()
                    }).unwrap_or_default();
                    let mut pool: Vec<SubagentRecord> = cands.iter().filter(|r| top.is_empty() || top.contains(&r.name)).cloned().collect();
                    rank_candidates(&mut pool);
                    winner = pool[0].clone();
                    reason = format!("no majority, so the highest-ranked {} won ({})", if top.len() > 1 { "of the tied candidates" } else { "candidate" }, v.as_ref().map(Self::vote_line).unwrap_or_default());
                }
            }
        } else {
            if let Err(e) = self.guard_send(me, None, true) {
                return (e, true);
            }
            rank_candidates(&mut cands);
            winner = cands[0].clone();
            reason = if matches!(winner.comms_role.as_deref(), Some("lead") | Some("hub")) {
                "ranked first: it already leads".into()
            } else {
                "ranked first: highest in the team, then priority, then the oldest".into()
            };
            if cands.len() == 1 {
                reason = "the only candidate".into();
            }
        }
        let el = Election {
            id: new_id("el"),
            method: method.clone(),
            term,
            caller_id: me.id.clone(),
            candidates: cands.iter().map(|r| r.id.clone()).collect(),
            winner_id: Some(winner.id.clone()),
            winner_name: Some(winner.name.clone()),
            vote_id,
            reason: reason.clone(),
            at: now_ms(),
        };
        self.with_chat(&root, |c| {
            c.swarm.term = term;
            c.swarm.coordinator = Some(winner.id.clone());
            c.swarm.coordinator_name = Some(winner.name.clone());
            push_capped(&mut c.swarm.elections, el);
        });
        let note = format!("[Election, term {}] {} is now the team's coordinator ({}). Coordinate through {}.", term, winner.name, reason, winner.name);
        for r in self.team_members(me) {
            self.deliver(&r, note.clone());
        }
        self.swarm_event(env, me, "election", Some(&winner), "", &reason, "elected", json!({ "term": term, "method": method }));
        let you = if winner.id == me.id { " That is you: coordinate the others." } else { "" };
        (format!("{} is the coordinator for term {} ({}).{}", winner.name, term, reason, you), false)
    }

    // ── Prompt ──────────────────────────────────────────────────────────────────

    /// The "Working with other agents" lines for an agent with comms tools.
    pub(super) fn swarm_prompt(&self, rec: &SubagentRecord, tools: &[String]) -> String {
        let topo = self.topology_of(rec);
        let has = |t: &str| tools.iter().any(|x| x == t);
        let shape = match topo.as_str() {
            "mesh" => "you may message anyone in the team",
            "swarm" => "a decentralised swarm: you decide whom to talk to, hand off to or ask for bids",
            "ring" => "you message the next agent in the ring",
            "chain" => "you message the agents right before and after you",
            "star" => "spokes talk only to the hub",
            "bus" => "no direct messages; everything goes through topics and the blackboard",
            "hierarchical" => "you talk to your own sub-team and its lead; leads talk to leads",
            "custom" => "only the user's edges decide who talks to whom",
            _ => "agents report up to their parent",
        };
        let mut s = format!("\n- Team topology: {} ({}). Messages from other agents arrive as notes in [brackets].", topo, shape);
        if has(team::TOOL_LIST_PEERS) {
            s.push_str(" list_peers shows who is in the team and whom you may message.");
        }
        if has(team::TOOL_MESSAGE_PEER) {
            s.push_str(" message_peer sends a direct message.");
        }
        let mut lines: Vec<&str> = Vec::new();
        if has(channels::TOOL_REQUEST) {
            lines.push("request_peer asks a question and can wait for the answer; answer requests sent to you with reply_peer.");
        }
        if has(channels::TOOL_BROADCAST_TEAM) {
            lines.push("broadcast_team tells everyone at once; use it rarely.");
        }
        if has(channels::TOOL_PUBLISH) {
            lines.push("Topics: subscribe_topic to follow a channel, publish_topic to post findings others can pick up.");
        }
        if has(channels::TOOL_BB_READ) {
            lines.push("The blackboard is shared state: read it before starting, write results and claims there (pass expected_version to avoid clobbering), reinforce marks that proved useful.");
        }
        if has(channels::TOOL_HANDOFF) {
            lines.push("If another agent is clearly better suited for your whole task, handoff_to_peer hands it over; then stop.");
        }
        if has(channels::TOOL_ANNOUNCE) {
            lines.push("announce_task lets others bid on a piece of work (contract net); answer calls for proposals with bid_task.");
        }
        if has(channels::TOOL_CALL_VOTE) {
            lines.push("call_vote decides a question with the team; answer ballots with cast_vote.");
        }
        if has(channels::TOOL_DEBATE) {
            lines.push("start_debate runs rounds of argument between agents for hard judgement calls.");
        }
        if has(channels::TOOL_GOSSIP) {
            lines.push("gossip spreads a fact peer to peer; pass on rumours that matter.");
        }
        if has(channels::TOOL_ELECT) {
            lines.push("elect_leader picks a coordinator when the team needs one.");
        }
        for l in lines {
            s.push_str("\n- ");
            s.push_str(l);
        }
        let eff = self.effective_comms(&self.root_of(&rec.session_key));
        if let Some(c) = self.read_chat(&self.root_of(&rec.session_key), |c| c.swarm.coordinator_name.clone()) {
            s.push_str(&format!("\n- The team's elected coordinator is {}.", c));
        }
        s.push_str(&format!("\n- Limits: a chain of agent messages stops after {} hops; keep messages purposeful and finish your own task.", eff.max_hops));
        s
    }
}
