//! Swarm communication: topologies, patterns and the per-chat comms config,
//! pub/sub topics, the blackboard, request/reply, broadcast, and the safety
//! rails (hops, per-pair limits, chat caps, deadlock avoidance).
//!
//! Design and research: docs/subagents/SWARM_COMMS_DESIGN.md.
//! - Who may talk to whom is data checked at dispatch time (AutoGen allowed
//!   transitions, LangGraph edges): the topology, then the user's allow/deny
//!   edges (deny wins), then the agent's own `canMessage`.
//! - Topics are a MetaGPT-style message pool scoped per chat; the blackboard
//!   is a shared store with versions (optimistic concurrency) and stigmergy
//!   marks that reinforce and evaporate.
//! - Requests carry an id like FIPA ACL `conversation-id`; a waiting asker is
//!   refused when the wait would close a cycle in the wait-for graph.
//! - The swarm protocols (handoff, contract net, voting, debate, gossip,
//!   leader election) live in `swarm.rs` and use the primitives here.

use super::*;
use std::collections::{BTreeMap, VecDeque};

pub const COMMS_FILE: &str = "comms.json";

pub const ALL_TOPOLOGIES: [&str; 9] = ["tree", "star", "mesh", "ring", "chain", "bus", "hierarchical", "swarm", "custom"];
pub const PATTERNS: [&str; 11] =
    ["direct", "broadcast", "topics", "blackboard", "request", "handoff", "gossip", "auction", "vote", "debate", "election"];
pub const ROLES: [&str; 3] = ["hub", "lead", "member"];

pub const TOOL_BROADCAST_TEAM: &str = "broadcast_team";
pub const TOOL_PUBLISH: &str = "publish_topic";
pub const TOOL_SUBSCRIBE: &str = "subscribe_topic";
pub const TOOL_UNSUBSCRIBE: &str = "unsubscribe_topic";
pub const TOOL_LIST_TOPICS: &str = "list_topics";
pub const TOOL_BB_READ: &str = "blackboard_read";
pub const TOOL_BB_WRITE: &str = "blackboard_write";
pub const TOOL_BB_SEARCH: &str = "blackboard_search";
pub const TOOL_REQUEST: &str = "request_peer";
pub const TOOL_REPLY: &str = "reply_peer";
pub const TOOL_HANDOFF: &str = "handoff_to_peer";
pub const TOOL_GOSSIP: &str = "gossip";
pub const TOOL_ANNOUNCE: &str = "announce_task";
pub const TOOL_BID: &str = "bid_task";
pub const TOOL_AWARD: &str = "award_task";
pub const TOOL_CALL_VOTE: &str = "call_vote";
pub const TOOL_CAST_VOTE: &str = "cast_vote";
pub const TOOL_DEBATE: &str = "start_debate";
pub const TOOL_ELECT: &str = "elect_leader";

pub const COMMS_TOOL_NAMES: [&str; 19] = [
    TOOL_BROADCAST_TEAM,
    TOOL_PUBLISH,
    TOOL_SUBSCRIBE,
    TOOL_UNSUBSCRIBE,
    TOOL_LIST_TOPICS,
    TOOL_BB_READ,
    TOOL_BB_WRITE,
    TOOL_BB_SEARCH,
    TOOL_REQUEST,
    TOOL_REPLY,
    TOOL_HANDOFF,
    TOOL_GOSSIP,
    TOOL_ANNOUNCE,
    TOOL_BID,
    TOOL_AWARD,
    TOOL_CALL_VOTE,
    TOOL_CAST_VOTE,
    TOOL_DEBATE,
    TOOL_ELECT,
];

/// Hard caps; with compaction on, histories fold well before these.
const TOPIC_POSTS: usize = 60;
const TOPICS_CAP: usize = 100;
const BOARD_CAP: usize = 200;
const BOARD_VALUE_CHARS: usize = 8_000;
pub(super) const SWARM_HISTORY: usize = 60;
const HOP_WINDOW_MS: i64 = 10 * 60_000;
const PAIR_WINDOW_MS: i64 = 10 * 60_000;
const EDGES_CAP: usize = 300;
const PRESETS_CAP: usize = 100;
/// The key of the defaults every chat starts from (the Settings page).
pub const GLOBAL_KEY: &str = "*";

/// Which tools each pattern turns on.
pub fn pattern_tools(p: &str) -> &'static [&'static str] {
    match p {
        "direct" => &[team::TOOL_MESSAGE_PEER],
        "broadcast" => &[TOOL_BROADCAST_TEAM],
        "topics" => &[TOOL_PUBLISH, TOOL_SUBSCRIBE, TOOL_UNSUBSCRIBE, TOOL_LIST_TOPICS],
        "blackboard" => &[TOOL_BB_READ, TOOL_BB_WRITE, TOOL_BB_SEARCH],
        "request" => &[TOOL_REQUEST, TOOL_REPLY],
        "handoff" => &[TOOL_HANDOFF],
        "gossip" => &[TOOL_GOSSIP],
        "auction" => &[TOOL_ANNOUNCE, TOOL_BID, TOOL_AWARD],
        "vote" => &[TOOL_CALL_VOTE, TOOL_CAST_VOTE],
        "debate" => &[TOOL_DEBATE, TOOL_REPLY],
        "election" => &[TOOL_ELECT, TOOL_CAST_VOTE],
        _ => &[],
    }
}

/// Patterns a topology turns on when the chat does not list its own.
pub fn default_patterns(topology: &str) -> Vec<String> {
    let v: &[&str] = match topology {
        "ring" | "chain" | "custom" | "star" => &["direct", "request"],
        "mesh" => &["direct", "broadcast", "topics", "blackboard", "request"],
        "bus" => &["broadcast", "topics", "blackboard"],
        "hierarchical" => &["direct", "broadcast", "topics", "blackboard", "request", "vote"],
        "swarm" => &PATTERNS,
        _ => &[],
    };
    v.iter().map(|s| s.to_string()).collect()
}

/// A topology name from a model or the app; an unknown one is an error.
pub fn parse_topology(t: &str) -> Result<String, String> {
    let n = team::normalize_topology(t);
    let raw = t.trim().to_lowercase();
    if n == "tree" && !matches!(raw.as_str(), "tree" | "bush" | "") {
        return Err(format!("Unknown topology \"{}\". Use one of: {}.", t.trim(), ALL_TOPOLOGIES.join(", ")));
    }
    Ok(n)
}

pub fn normalize_role(r: &str) -> Option<String> {
    let r = r.trim().to_lowercase();
    let r = match r.as_str() {
        "leader" | "coordinator" | "supervisor" => "lead",
        "centre" | "center" => "hub",
        "worker" | "spoke" => "member",
        o => o,
    };
    ROLES.contains(&r).then(|| r.to_string())
}

fn norm_topic(t: &str) -> String {
    let t: String = t.trim().trim_start_matches('#').to_lowercase().chars().map(|c| if c.is_alphanumeric() || "-_./".contains(c) { c } else { '-' }).collect();
    truncate_chars(t.trim_matches('-'), 60)
}

fn short_id(prefix: &str) -> String {
    format!("{}_{}", prefix, &uuid::Uuid::new_v4().simple().to_string()[..8])
}

// ── Config ────────────────────────────────────────────────────────────────

/// One user rule about who may message whom. `from`/`to`: an id, a name or
/// `*`. Deny always wins over allow and over the topology.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub allow: bool,
    /// Both directions.
    pub both: bool,
}

/// A chat's communication config. Every field is optional so a preset or a
/// patch can set only some; `effective` fills in the rest.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CommsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patterns: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edges: Option<Vec<Edge>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_hops: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_pair_messages: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_messages: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_handoffs: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gossip_fanout: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consensus_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quorum_percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auction_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who_can_broadcast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who_can_spawn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blackboard_writers: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_idle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_timeout_s: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pheromone_half_life_min: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub election_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    /// Auto-compaction of topics, swarm logs, inboxes and assembled context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_keep: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_at: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_context_chars: Option<u32>,
    /// Topology groups on top of the chat's topology (`groups.rs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<groups::TopologyGroup>>,
}

/// The config with every value filled in.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    pub topology: String,
    /// None = each agent's topology decides (`default_patterns`).
    pub patterns: Option<Vec<String>>,
    pub edges: Vec<Edge>,
    /// Topology groups (empty = the chat's topology alone, as before groups).
    pub groups: Vec<groups::TopologyGroup>,
    pub max_hops: u32,
    pub max_pair_messages: u32,
    pub max_messages: u32,
    pub max_rounds: u32,
    pub max_handoffs: u32,
    pub gossip_fanout: u32,
    pub consensus_rule: String,
    pub quorum_percent: u32,
    pub auction_policy: String,
    pub who_can_broadcast: String,
    pub who_can_spawn: String,
    pub blackboard_writers: String,
    pub wake_idle: bool,
    pub request_timeout_s: u32,
    pub pheromone_half_life_min: u32,
    pub election_method: String,
    pub paused: bool,
    pub compaction: compact::Policy,
}

const RULES: [&str; 4] = ["majority", "plurality", "unanimous", "supermajority"];
const POLICIES: [&str; 5] = ["best", "cheapest", "confident", "first", "manager"];
const WHO: [&str; 3] = ["all", "leads", "none"];
const ELECTION: [&str; 2] = ["rank", "vote"];

impl CommsConfig {
    /// `self` with every set field of `over` on top.
    pub fn overlay(&self, over: &CommsConfig) -> CommsConfig {
        let a = serde_json::to_value(self).unwrap_or(json!({}));
        let b = serde_json::to_value(over).unwrap_or(json!({}));
        let mut m = a.as_object().cloned().unwrap_or_default();
        for (k, v) in b.as_object().cloned().unwrap_or_default() {
            m.insert(k, v);
        }
        serde_json::from_value(Value::Object(m)).unwrap_or_default()
    }

    /// Apply an app patch: a key set to null clears it (back to inherited).
    /// Returns the keys whose values were rejected.
    pub fn patched(&self, patch: &Value) -> (CommsConfig, Vec<String>) {
        let mut m = serde_json::to_value(self).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        let mut rejected = Vec::new();
        let Some(p) = patch.as_object() else { return (self.clone(), rejected) };
        for (k, v) in p {
            if v.is_null() {
                m.remove(k);
                continue;
            }
            let mut trial = m.clone();
            trial.insert(k.clone(), v.clone());
            match serde_json::from_value::<CommsConfig>(Value::Object(trial.clone())) {
                Ok(c) if c.validate().is_ok() && serde_json::to_value(&c).ok().and_then(|x| x.get(k).cloned()).is_some() => m = trial,
                _ => rejected.push(k.clone()),
            }
        }
        let out: CommsConfig = serde_json::from_value(Value::Object(m)).unwrap_or_default();
        (out.normalized(), rejected)
    }

    pub fn validate(&self) -> Result<(), String> {
        if let Some(t) = &self.topology {
            parse_topology(t)?;
        }
        if let Some(p) = &self.patterns {
            if let Some(bad) = p.iter().find(|x| !PATTERNS.contains(&x.as_str())) {
                return Err(format!("Unknown pattern {}.", bad));
            }
        }
        let one_of = |v: &Option<String>, list: &[&str], what: &str| -> Result<(), String> {
            match v {
                Some(x) if !list.contains(&x.as_str()) => Err(format!("{} must be one of {}.", what, list.join(", "))),
                _ => Ok(()),
            }
        };
        one_of(&self.consensus_rule, &RULES, "consensusRule")?;
        one_of(&self.auction_policy, &POLICIES, "auctionPolicy")?;
        one_of(&self.who_can_broadcast, &WHO, "whoCanBroadcast")?;
        one_of(&self.who_can_spawn, &WHO, "whoCanSpawn")?;
        one_of(&self.blackboard_writers, &WHO, "blackboardWriters")?;
        one_of(&self.election_method, &ELECTION, "electionMethod")?;
        let range = |v: Option<u32>, lo: u32, hi: u32, what: &str| -> Result<(), String> {
            match v {
                Some(x) if x < lo || x > hi => Err(format!("{} must be {}-{}.", what, lo, hi)),
                _ => Ok(()),
            }
        };
        range(self.max_hops, 1, 50, "maxHops")?;
        range(self.max_pair_messages, 0, 1000, "maxPairMessages")?;
        range(self.max_messages, 0, 100_000, "maxMessages")?;
        range(self.max_rounds, 1, 10, "maxRounds")?;
        range(self.max_handoffs, 0, 20, "maxHandoffs")?;
        range(self.gossip_fanout, 1, 10, "gossipFanout")?;
        range(self.quorum_percent, 0, 100, "quorumPercent")?;
        range(self.request_timeout_s, 5, 1800, "requestTimeoutS")?;
        range(self.pheromone_half_life_min, 1, 10_080, "pheromoneHalfLifeMin")?;
        let (kl, kh) = compact::Policy::KEEP_RANGE;
        let (al, ah) = compact::Policy::AT_RANGE;
        let (cl, ch) = compact::Policy::CONTEXT_RANGE;
        range(self.compact_keep, kl, kh, "compactKeep")?;
        range(self.compact_at, al, ah, "compactAt")?;
        range(self.compact_context_chars, cl, ch, "compactContextChars")?;
        if let Some(e) = &self.edges {
            if e.len() > EDGES_CAP {
                return Err(format!("At most {} edges.", EDGES_CAP));
            }
            if e.iter().any(|x| x.from.trim().is_empty() || x.to.trim().is_empty()) {
                return Err("Every edge needs a from and a to.".into());
            }
        }
        if let Some(g) = &self.groups {
            groups::validate_groups(g)?;
        }
        Ok(())
    }

    fn normalized(mut self) -> Self {
        if let Some(t) = &self.topology {
            self.topology = parse_topology(t).ok();
        }
        if let Some(p) = &mut self.patterns {
            let mut seen = Vec::new();
            for x in PATTERNS {
                if p.iter().any(|y| y == x) {
                    seen.push(x.to_string());
                }
            }
            *p = seen;
        }
        if let Some(e) = &mut self.edges {
            for x in e.iter_mut() {
                x.from = x.from.trim().to_string();
                x.to = x.to.trim().to_string();
            }
            e.dedup();
        }
        if let Some(g) = &mut self.groups {
            groups::normalize_groups(g);
        }
        self
    }

    /// The coordination compaction policy (built-in defaults under the config).
    pub fn compaction(&self) -> compact::Policy {
        let d = compact::Policy::default();
        compact::Policy::new(self.compact.unwrap_or(d.enabled), self.compact_keep.unwrap_or(d.keep as u32), self.compact_at.unwrap_or(d.at as u32), self.compact_context_chars.unwrap_or(d.context_chars as u32))
    }

    pub fn effective(&self, global_topology: &str) -> Effective {
        Effective {
            topology: self.topology.clone().map(|t| team::normalize_topology(&t)).unwrap_or_else(|| team::normalize_topology(global_topology)),
            patterns: self.patterns.clone(),
            edges: self.edges.clone().unwrap_or_default(),
            groups: self.groups.clone().unwrap_or_default(),
            max_hops: self.max_hops.unwrap_or(8),
            max_pair_messages: self.max_pair_messages.unwrap_or(30),
            max_messages: self.max_messages.unwrap_or(500),
            max_rounds: self.max_rounds.unwrap_or(3),
            max_handoffs: self.max_handoffs.unwrap_or(5),
            gossip_fanout: self.gossip_fanout.unwrap_or(2),
            consensus_rule: self.consensus_rule.clone().unwrap_or_else(|| "majority".into()),
            quorum_percent: self.quorum_percent.unwrap_or(50),
            auction_policy: self.auction_policy.clone().unwrap_or_else(|| "best".into()),
            who_can_broadcast: self.who_can_broadcast.clone().unwrap_or_else(|| "all".into()),
            who_can_spawn: self.who_can_spawn.clone().unwrap_or_else(|| "all".into()),
            blackboard_writers: self.blackboard_writers.clone().unwrap_or_else(|| "all".into()),
            wake_idle: self.wake_idle.unwrap_or(true),
            request_timeout_s: self.request_timeout_s.unwrap_or(120),
            pheromone_half_life_min: self.pheromone_half_life_min.unwrap_or(30),
            election_method: self.election_method.clone().unwrap_or_else(|| "rank".into()),
            paused: self.paused.unwrap_or(false),
            compaction: self.compaction(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CommsPreset {
    pub name: String,
    pub title: String,
    pub description: String,
    pub config: CommsConfig,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub builtin: bool,
}

fn preset(name: &str, title: &str, description: &str, config: Value) -> CommsPreset {
    CommsPreset { name: name.into(), title: title.into(), description: description.into(), config: serde_json::from_value(config).unwrap_or_default(), builtin: true }
}

pub fn builtin_presets() -> Vec<CommsPreset> {
    vec![
        preset("strict-tree", "Strict tree", "Agents only report up; no talk between peers.", json!({"topology": "tree", "patterns": []})),
        preset("supervisor", "Supervisor", "A hub coordinates; spokes talk only to the hub.", json!({"topology": "star", "patterns": ["direct", "request"]})),
        preset(
            "open-swarm",
            "Open swarm",
            "Agents decide whom to talk to, hand off, bid, vote and elect a coordinator.",
            json!({"topology": "swarm", "patterns": PATTERNS, "maxHops": 10, "maxHandoffs": 5}),
        ),
        preset(
            "research-team",
            "Research team",
            "Sub-teams with leads; leads coordinate, findings go to topics and the blackboard.",
            json!({"topology": "hierarchical", "patterns": ["direct", "topics", "blackboard", "request", "vote"], "whoCanBroadcast": "leads", "whoCanSpawn": "leads"}),
        ),
        preset(
            "debate-panel",
            "Debate panel",
            "Agents argue in rounds, read each other and converge; unanimous decisions.",
            json!({"topology": "mesh", "patterns": ["direct", "request", "debate", "vote"], "consensusRule": "unanimous", "maxRounds": 3}),
        ),
        preset("market", "Market", "Contract net: tasks are announced, agents bid, the cheapest bid wins.", json!({"topology": "mesh", "patterns": ["direct", "request", "auction"], "auctionPolicy": "cheapest"})),
        preset("blackboard", "Blackboard", "No direct talk: agents coordinate through topics and shared marks.", json!({"topology": "bus", "patterns": ["topics", "blackboard", "broadcast"]})),
        preset("pipeline", "Pipeline", "Each agent talks to its neighbours only.", json!({"topology": "chain", "patterns": ["direct", "request"]})),
        preset("gossip", "Gossip network", "News spreads peer to peer, a few at a time.", json!({"topology": "mesh", "patterns": ["gossip", "blackboard"], "gossipFanout": 2})),
    ]
}

// ── Per-chat state ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Post {
    pub seq: u64,
    pub from_id: Option<String>,
    pub from_name: String,
    pub text: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Topic {
    pub subscribers: Vec<String>,
    pub posts: VecDeque<Post>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub total: u64,
    /// Posts folded out of `posts` by auto-compaction.
    pub digest: compact::Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardEntry {
    pub value: String,
    pub version: u64,
    pub author_id: Option<String>,
    pub author_name: String,
    pub updated_at: i64,
    pub weight: f64,
    pub reinforced_at: i64,
    pub tags: Vec<String>,
    pub writes: u64,
}

impl BoardEntry {
    /// The mark's weight now: it halves every half-life (evaporation).
    pub fn weight_now(&self, half_life_min: u32, now: i64) -> f64 {
        let age = (now - self.reinforced_at).max(0) as f64;
        let hl = (half_life_min.max(1) as f64) * 60_000.0;
        self.weight * 0.5f64.powf(age / hl)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatComms {
    pub config: CommsConfig,
    pub topics: BTreeMap<String, Topic>,
    pub blackboard: BTreeMap<String, BoardEntry>,
    pub swarm: swarm::SwarmState,
    pub message_count: u64,
    /// Blackboard marks that evaporated and were folded away.
    pub board_digest: compact::Digest,
    /// Compaction runs and items folded, for the app.
    pub compactions: u64,
    pub compacted_items: u64,
    pub last_compaction_at: Option<i64>,
}

impl ChatComms {
    /// Fold what grew past the policy's mark: topic posts, closed swarm items,
    /// old debate rounds and evaporated blackboard marks. Returns items folded.
    pub fn compact(&mut self, p: &compact::Policy, half_life_min: u32, now: i64) -> usize {
        if !p.enabled {
            return 0;
        }
        let mut n = 0;
        for t in self.topics.values_mut() {
            n += compact::fold_queue(&mut t.posts, &mut t.digest, p, |_| true, |x| (x.from_name.clone(), x.text.clone(), x.at));
        }
        n += self.swarm.compact(p);
        // Evaporated marks (weight under 5% of a fresh one, untouched for a half-life) leave once the board passes the mark.
        let board_mark = BOARD_CAP * p.at / compact::Policy::AT_RANGE.1 as usize;
        if self.blackboard.len() > board_mark.max(p.keep) {
            let hl_ms = half_life_min.max(1) as i64 * 60_000;
            let mut gone: Vec<(String, i64)> = self
                .blackboard
                .iter()
                .filter(|(_, e)| e.weight_now(half_life_min, now) < 0.05 && now - e.updated_at.max(e.reinforced_at) > hl_ms)
                .map(|(k, e)| (k.clone(), e.updated_at))
                .collect();
            gone.sort_by_key(|g| g.1);
            gone.truncate(self.blackboard.len() - p.keep.min(self.blackboard.len()));
            for (k, _) in &gone {
                if let Some(e) = self.blackboard.remove(k) {
                    self.board_digest.add(&e.author_name, &format!("{} = {}", k, e.value), e.updated_at);
                    n += 1;
                }
            }
            if !gone.is_empty() {
                self.board_digest.runs += 1;
            }
        }
        if n > 0 {
            self.compactions += 1;
            self.compacted_items += n as u64;
            self.last_compaction_at = Some(now);
        }
        n
    }

    /// For the app: what auto-compaction has folded in this chat.
    pub fn compaction_json(&self, p: &compact::Policy) -> Value {
        let topics: u64 = self.topics.values().map(|t| t.digest.count).sum();
        json!({
            "policy": p,
            "runs": self.compactions,
            "items": self.compacted_items,
            "lastAt": self.last_compaction_at,
            "folded": { "topics": topics, "blackboard": self.board_digest.count, "swarm": self.swarm.digests.values().map(|d| d.count).sum::<u64>() },
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CommsStore {
    #[serde(skip)]
    path: PathBuf,
    pub chats: BTreeMap<String, ChatComms>,
    pub presets: Vec<CommsPreset>,
}

impl CommsStore {
    pub fn load(path: &Path) -> Self {
        let mut s: CommsStore = fs_read_json(path).unwrap_or_default();
        s.path = path.to_path_buf();
        s
    }
    fn save(&self) {
        if !self.path.as_os_str().is_empty() {
            fs_write_json(&self.path, self);
        }
    }
}

/// An open request (request_peer, or a debate round the engine runs).
#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub question: String,
    pub answer: Option<String>,
    /// The asker (or the engine) is blocked on it: no note on reply.
    pub waiting: bool,
    pub at: i64,
}

#[derive(Default)]
pub struct Runtime {
    /// Hop count of the message chain an agent was last reached by.
    pub hops: HashMap<String, (u32, i64)>,
    /// Recent sends per "from>to" pair.
    pub pair: HashMap<String, VecDeque<i64>>,
    pub requests: HashMap<String, OpenRequest>,
    /// Wait-for graph: agent -> agents it is blocked on.
    pub waits: HashMap<String, HashSet<String>>,
}

/// Removes a wait from the wait-for graph when the wait ends.
pub(super) struct WaitGuard<'a> {
    mgr: &'a SubagentManager,
    waiter: String,
    targets: Vec<String>,
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        let mut rt = self.mgr.swarm_rt.lock().unwrap();
        if let Some(set) = rt.waits.get_mut(&self.waiter) {
            for t in &self.targets {
                set.remove(t);
            }
            if set.is_empty() {
                rt.waits.remove(&self.waiter);
            }
        }
    }
}

#[derive(Debug, PartialEq)]
pub(super) enum Waited {
    Done,
    Timeout,
    Aborted,
}

pub(super) fn edge_matches(r: &str, rec: &SubagentRecord) -> bool {
    let r = r.trim();
    r == "*" || (!r.is_empty() && (rec.id == r || rec.name.eq_ignore_ascii_case(r) || rec.title.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(r))))
}

fn edge_hits(e: &Edge, from: &SubagentRecord, to: &SubagentRecord) -> bool {
    (edge_matches(&e.from, from) && edge_matches(&e.to, to)) || (e.both && edge_matches(&e.from, to) && edge_matches(&e.to, from))
}

impl SubagentManager {
    // ── Config ──────────────────────────────────────────────────────────────

    /// A chat's own config (not merged).
    pub fn chat_comms_config(&self, root: &str) -> CommsConfig {
        self.comms_store.lock().unwrap().chats.get(root).map(|c| c.config.clone()).unwrap_or_default()
    }

    /// The chat's config on top of the defaults (Settings) on top of built-in values.
    pub fn effective_comms(&self, root: &str) -> Effective {
        let store = self.comms_store.lock().unwrap();
        let global = store.chats.get(GLOBAL_KEY).map(|c| c.config.clone()).unwrap_or_default();
        let chat = if root == GLOBAL_KEY { CommsConfig::default() } else { store.chats.get(root).map(|c| c.config.clone()).unwrap_or_default() };
        drop(store);
        global.overlay(&chat).effective(&self.settings().topology)
    }

    pub fn set_comms_config(&self, root: &str, patch: &Value) -> (CommsConfig, Vec<String>) {
        let mut store = self.comms_store.lock().unwrap();
        let chat = store.chats.entry(root.to_string()).or_default();
        let (next, rejected) = chat.config.patched(patch);
        chat.config = next.clone();
        store.save();
        (next, rejected)
    }

    /// Run `f` on a chat's state and save it.
    pub(super) fn with_chat<R>(&self, root: &str, f: impl FnOnce(&mut ChatComms) -> R) -> R {
        let mut store = self.comms_store.lock().unwrap();
        let out = f(store.chats.entry(root.to_string()).or_default());
        // Every change to a chat's coordination state is a chance to compact it.
        let global = store.chats.get(GLOBAL_KEY).map(|c| c.config.clone()).unwrap_or_default();
        let c = store.chats.entry(root.to_string()).or_default();
        let cfg = global.overlay(&c.config);
        let half_life = cfg.pheromone_half_life_min.unwrap_or(30);
        c.compact(&cfg.compaction(), half_life, now_ms());
        store.save();
        out
    }

    /// The chat's coordination compaction policy.
    pub(super) fn comms_compaction(&self, root: &str) -> compact::Policy {
        self.effective_comms(root).compaction
    }

    pub(super) fn read_chat<R>(&self, root: &str, f: impl FnOnce(&ChatComms) -> R) -> R {
        let store = self.comms_store.lock().unwrap();
        let empty = ChatComms::default();
        f(store.chats.get(root).unwrap_or(&empty))
    }

    pub fn comms_presets(&self) -> Vec<CommsPreset> {
        let mut out = builtin_presets();
        out.extend(self.comms_store.lock().unwrap().presets.clone());
        out
    }

    pub fn save_comms_preset(&self, req: &Value) -> Result<CommsPreset, String> {
        let name = sanitize_name(req.get("name").and_then(Value::as_str).unwrap_or(""));
        if name.is_empty() {
            return Err("A preset needs a name.".into());
        }
        if builtin_presets().iter().any(|p| p.name == name) {
            return Err(format!("{} is a built-in preset; pick another name.", name));
        }
        let config: CommsConfig = serde_json::from_value(req.get("config").cloned().unwrap_or(json!({}))).map_err(|e| format!("Invalid config: {}", e))?;
        config.validate()?;
        let p = CommsPreset {
            title: req.get("title").and_then(Value::as_str).map(|s| truncate_chars(s.trim(), 80)).filter(|s| !s.is_empty()).unwrap_or_else(|| name.clone()),
            description: req.get("description").and_then(Value::as_str).map(|s| truncate_chars(s.trim(), 300)).unwrap_or_default(),
            name: name.clone(),
            config: config.normalized(),
            builtin: false,
        };
        let mut store = self.comms_store.lock().unwrap();
        store.presets.retain(|x| x.name != name);
        if store.presets.len() >= PRESETS_CAP {
            return Err(format!("At most {} saved presets.", PRESETS_CAP));
        }
        store.presets.push(p.clone());
        store.save();
        Ok(p)
    }

    pub fn delete_comms_preset(&self, name: &str) -> bool {
        let mut store = self.comms_store.lock().unwrap();
        let before = store.presets.len();
        store.presets.retain(|x| x.name != name);
        let changed = store.presets.len() != before;
        if changed {
            store.save();
        }
        changed
    }

    /// Replace a chat's config with a preset's (edges the chat drew are kept).
    pub fn apply_comms_preset(&self, root: &str, name: &str) -> Result<CommsConfig, String> {
        let p = self.comms_presets().into_iter().find(|p| p.name == name).ok_or_else(|| format!("No preset named {}.", name))?;
        let mut store = self.comms_store.lock().unwrap();
        let chat = store.chats.entry(root.to_string()).or_default();
        let edges = chat.config.edges.clone();
        let groups = chat.config.groups.clone();
        chat.config = p.config.clone();
        if chat.config.edges.is_none() {
            chat.config.edges = edges;
        }
        // Groups name the chat's agents, like edges: a preset keeps them.
        if chat.config.groups.is_none() {
            chat.config.groups = groups;
        }
        let out = chat.config.clone();
        store.save();
        Ok(out)
    }

    // ── Team shape ──────────────────────────────────────────────────────────

    /// The topology that decides what this agent may send.
    pub fn topology_of(&self, rec: &SubagentRecord) -> String {
        match &rec.topology {
            Some(t) => team::normalize_topology(t),
            None => self.effective_comms(&self.root_of(&rec.session_key)).topology,
        }
    }

    pub(super) fn siblings_of(&self, rec: &SubagentRecord) -> Vec<SubagentRecord> {
        self.records.lock().unwrap().iter().filter(|r| r.parent_session_key == rec.parent_session_key && !r.chat_deleted).cloned().collect()
    }

    /// A sub-team lead: role lead or hub, the chat's coordinator, or an agent with children.
    pub fn is_lead(&self, rec: &SubagentRecord) -> bool {
        if matches!(rec.comms_role.as_deref(), Some("lead") | Some("hub")) {
            return true;
        }
        if self.group_lead(rec) {
            return true;
        }
        let root = self.root_of(&rec.session_key);
        if self.read_chat(&root, |c| c.swarm.coordinator.as_deref() == Some(rec.id.as_str())) {
            return true;
        }
        self.records.lock().unwrap().iter().any(|r| r.parent_id.as_deref() == Some(rec.id.as_str()) && !r.chat_deleted)
    }

    fn hub_of(&self, rec: &SubagentRecord) -> Option<SubagentRecord> {
        self.siblings_of(rec).into_iter().find(|r| r.comms_role.as_deref() == Some("hub"))
    }

    /// The user's edges: Some(false) = denied, Some(true) = allowed, None = no edge.
    pub(super) fn edge_rule(&self, from: &SubagentRecord, to: &SubagentRecord) -> Option<bool> {
        let edges = self.effective_comms(&self.root_of(&from.session_key)).edges;
        if edges.iter().any(|e| !e.allow && edge_hits(e, from, to)) {
            return Some(false);
        }
        if edges.iter().any(|e| e.allow && edge_hits(e, from, to)) {
            return Some(true);
        }
        None
    }

    /// The topology's own answer for a direct message (after hidden, edges and canMessage).
    pub(super) fn topology_allows(&self, from: &SubagentRecord, to: &SubagentRecord) -> Result<(), String> {
        let topo = self.topology_of(from);
        match topo.as_str() {
            "mesh" | "swarm" => Ok(()),
            "ring" => {
                let next = self.ring_next(from);
                if next.as_ref().map(|n| n.id == to.id).unwrap_or(false) {
                    Ok(())
                } else {
                    Err(format!("In the ring topology you may only message the next sub-agent{}.", next.map(|n| format!(" ({})", n.name)).unwrap_or_default()))
                }
            }
            "chain" => {
                let sibs = self.siblings_of(from);
                let i = sibs.iter().position(|r| r.id == from.id);
                let ok = i.is_some_and(|i| (i > 0 && sibs[i - 1].id == to.id) || sibs.get(i + 1).is_some_and(|n| n.id == to.id));
                if ok {
                    Ok(())
                } else {
                    Err("In the chain topology you may only message the sub-agents right before and after you.".into())
                }
            }
            "star" => match self.hub_of(from) {
                Some(h) if h.id == from.id && to.parent_session_key == from.parent_session_key => Ok(()),
                Some(h) if h.id == to.id => Ok(()),
                Some(h) => Err(format!("In the star topology spokes message only the hub ({}).", h.name)),
                None => Err("Sub-agents can't message each other in the star topology. Report to your parent instead.".into()),
            },
            "hierarchical" => {
                let same_team = to.parent_session_key == from.parent_session_key;
                let up_down = to.parent_id.as_deref() == Some(from.id.as_str()) || from.parent_id.as_deref() == Some(to.id.as_str());
                if same_team || up_down || (self.is_lead(from) && self.is_lead(to)) {
                    Ok(())
                } else {
                    Err(format!("In the hierarchical topology you message your own sub-team and its lead; ask your lead to reach {}.", to.name))
                }
            }
            "bus" => Err("In the bus topology agents don't message each other directly: post with publish_topic or write to the blackboard.".into()),
            "custom" => Err(format!("Only the user's edges allow messages here, and none lets you message {}.", to.name)),
            t => Err(format!("Sub-agents can't message each other in the {} topology. Report to your parent instead.", t)),
        }
    }

    /// Patterns this agent may use.
    pub fn patterns_for(&self, rec: &SubagentRecord) -> Vec<String> {
        let mut p = self.base_patterns(rec);
        // Every topology group the agent is in adds its own type's patterns.
        for x in self.group_patterns_for(rec) {
            if !p.contains(&x) {
                p.push(x);
            }
        }
        PATTERNS.iter().filter(|x| p.iter().any(|y| y == *x)).map(|x| x.to_string()).collect()
    }

    /// The patterns of the agent's base topology alone (the chat's, or its own), before groups.
    pub(super) fn base_patterns(&self, rec: &SubagentRecord) -> Vec<String> {
        let eff = self.effective_comms(&self.root_of(&rec.session_key));
        let topo = self.topology_of(rec);
        let mut p = match (&eff.patterns, &rec.topology) {
            // An agent spawned with its own topology gets that topology's patterns
            // unless the chat lists its own.
            (Some(p), _) => p.clone(),
            (None, _) => default_patterns(&topo),
        };
        // A star without a hub has nobody to talk to.
        if topo == "star" && eff.patterns.is_none() && self.hub_of(rec).is_none() {
            p.clear();
        }
        p
    }

    /// Visible agents of the chat that no deny edge separates from `me`
    /// (broadcast, topics and votes reach these).
    pub(super) fn team_members(&self, me: &SubagentRecord) -> Vec<SubagentRecord> {
        let root = self.root_of(&me.session_key);
        let all: Vec<SubagentRecord> = self.records.lock().unwrap().iter().filter(|r| r.id != me.id && !r.chat_deleted).cloned().collect();
        all.into_iter()
            .filter(|r| self.root_of(&r.session_key) == root && !Self::hidden_from(r, me) && self.edge_rule(me, r) != Some(false))
            .collect()
    }

    fn who_rule_allows(&self, rule: &str, rec: &SubagentRecord) -> bool {
        match rule {
            "none" => false,
            "leads" => self.is_lead(rec),
            _ => true,
        }
    }

    pub(super) fn may_broadcast(&self, rec: &SubagentRecord) -> bool {
        if let Some(b) = rec.can_broadcast {
            return b;
        }
        let eff = self.effective_comms(&self.root_of(&rec.session_key));
        self.who_rule_allows(&eff.who_can_broadcast, rec)
    }

    /// Whether a sub-agent may start agents under the chat's swarm rule.
    pub(super) fn may_spawn_by_rule(&self, rec: &SubagentRecord) -> Result<(), String> {
        let eff = self.effective_comms(&self.root_of(&rec.session_key));
        if self.who_rule_allows(&eff.who_can_spawn, rec) {
            Ok(())
        } else if eff.who_can_spawn == "none" {
            Err("The user's swarm rules let no sub-agent start agents in this chat. Do the work yourself or ask your parent.".into())
        } else {
            Err("The user's swarm rules let only leads start agents in this chat. Ask your lead, or do the work yourself.".into())
        }
    }

    /// The comms tools this agent gets (beyond ask_parent / message_peer / list_peers).
    pub(super) fn comms_tool_names(&self, rec: &SubagentRecord) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in self.patterns_for(rec) {
            if p == "broadcast" && !self.may_broadcast(rec) {
                continue;
            }
            for t in pattern_tools(&p) {
                if *t != team::TOOL_MESSAGE_PEER && !out.iter().any(|x| x == t) {
                    out.push(t.to_string());
                }
            }
        }
        // Keep a stable order.
        COMMS_TOOL_NAMES.iter().filter(|t| out.iter().any(|x| x == *t)).map(|t| t.to_string()).collect()
    }

    // ── Safety rails ────────────────────────────────────────────────────────

    /// Checks before an agent sends anything to another agent. `to` = None
    /// for one-to-many sends (broadcast, topic). `reply` skips the send-rate
    /// and per-pair limits (answering keeps a conversation from deadlocking).
    /// Returns the hop count the message travels with.
    pub(super) fn guard_send(&self, from: &SubagentRecord, to: Option<&SubagentRecord>, reply: bool) -> Result<u32, String> {
        let root = self.root_of(&from.session_key);
        let eff = self.effective_comms(&root);
        if eff.paused {
            return Err("The user has paused messages between the agents of this chat. Carry on with your own task and report to your parent.".into());
        }
        let now = now_ms();
        let hop = {
            let rt = self.swarm_rt.lock().unwrap();
            rt.hops.get(&from.id).filter(|(_, at)| now - at < HOP_WINDOW_MS).map(|(h, _)| *h).unwrap_or(0) + 1
        };
        if !reply && hop > eff.max_hops {
            return Err(format!(
                "This message would be hop {} of a chain of agent messages; the limit is {}. Stop relaying and finish your task with what you have.",
                hop, eff.max_hops
            ));
        }
        if eff.max_messages > 0 && self.read_chat(&root, |c| c.message_count) >= eff.max_messages as u64 {
            return Err(format!("This chat's agents have sent {} messages, the most the user allows. Finish your task without messaging.", eff.max_messages));
        }
        if !reply {
            if let Some(to) = to {
                if eff.max_pair_messages > 0 {
                    let mut rt = self.swarm_rt.lock().unwrap();
                    let q = rt.pair.entry(format!("{}>{}", from.id, to.id)).or_default();
                    while q.front().is_some_and(|t| now - *t > PAIR_WINDOW_MS) {
                        q.pop_front();
                    }
                    if q.len() as u32 >= eff.max_pair_messages {
                        return Err(format!(
                            "You have sent {} {} messages in 10 minutes, the most allowed between two agents. Stop the back-and-forth and decide.",
                            q.len(),
                            to.name
                        ));
                    }
                    q.push_back(now);
                }
            }
            self.check_send_rules(from)?;
        } else if self.settings().comms_paused {
            return Err("The user has paused messages between agents. Carry on with your own task and report to your parent.".into());
        }
        self.with_chat(&root, |c| c.message_count += 1);
        Ok(hop.min(eff.max_hops.max(1)))
    }

    /// Deliver a note from one agent to another and remember its hop count.
    /// With `wake`, an idle (not paused) agent starts a run with it.
    pub(super) fn send_comm(self: &Arc<Self>, to: &SubagentRecord, note: String, hop: u32, wake: bool, env: &ParentEnv) -> &'static str {
        let how = if wake && !to.is_active() && !to.paused {
            let wenv = ParentEnv { abort: None, tool_names: Vec::new(), ..env.clone() };
            match self.rerun_existing(&to.id, note.clone(), PendingPrior::Resume, &wenv, false) {
                Ok(_) => "started",
                Err(_) => self.deliver(to, note),
            }
        } else {
            self.deliver(to, note)
        };
        let now = now_ms();
        let mut rt = self.swarm_rt.lock().unwrap();
        let e = rt.hops.entry(to.id.clone()).or_insert((0, now));
        if now - e.1 >= HOP_WINDOW_MS || hop > e.0 {
            *e = (hop, now);
        } else {
            e.1 = now;
        }
        how
    }

    /// Whether `waiter` blocking on any of `targets` would close a cycle of
    /// waits. Returns the agent that already waits on `waiter`.
    pub(super) fn would_deadlock(&self, waiter: &str, targets: &[String]) -> Option<String> {
        let rt = self.swarm_rt.lock().unwrap();
        for t in targets {
            let mut stack = vec![t.clone()];
            let mut seen: HashSet<String> = HashSet::new();
            while let Some(cur) = stack.pop() {
                if cur == waiter {
                    return Some(t.clone());
                }
                if !seen.insert(cur.clone()) {
                    continue;
                }
                if let Some(next) = rt.waits.get(&cur) {
                    stack.extend(next.iter().cloned());
                }
            }
        }
        None
    }

    pub(super) fn begin_wait(&self, waiter: &str, targets: &[String]) -> WaitGuard<'_> {
        let mut rt = self.swarm_rt.lock().unwrap();
        let set = rt.waits.entry(waiter.to_string()).or_default();
        for t in targets {
            set.insert(t.clone());
        }
        WaitGuard { mgr: self, waiter: waiter.to_string(), targets: targets.to_vec() }
    }

    /// Poll until `done` holds, the timeout passes, or the caller is cancelled.
    pub(super) async fn wait_until(&self, timeout: Duration, abort: &Option<Arc<Mutex<bool>>>, done: impl Fn(&Self) -> bool) -> Waited {
        let end = Instant::now() + timeout;
        loop {
            if done(self) {
                return Waited::Done;
            }
            if is_aborted(abort) {
                return Waited::Aborted;
            }
            if Instant::now() >= end {
                return Waited::Timeout;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Log a swarm event in the sender's log (comms timeline) and tell the app.
    pub(super) fn swarm_event(&self, env: &ParentEnv, me: &SubagentRecord, kind: &str, to: Option<&SubagentRecord>, to_name: &str, text: &str, status: &str, extra: Value) {
        let mut payload = json!({
            "kind": kind,
            "to": to.map(|t| t.id.clone()),
            "toName": if to_name.is_empty() { to.map(|t| t.name.clone()).unwrap_or_default() } else { to_name.to_string() },
            "text": truncate_chars(text, 2_000),
            "status": status,
        });
        if let (Some(o), Some(m)) = (payload.as_object_mut(), extra.as_object()) {
            for (k, v) in m {
                o.insert(k.clone(), v.clone());
            }
        }
        self.emit(&env.callback, &format!("subagent.swarm_{}", kind), me, payload);
    }

    pub(super) fn find_member(&self, me: &SubagentRecord, r: &str) -> Option<SubagentRecord> {
        let r = r.trim();
        self.team_members(me).into_iter().find(|x| x.id == r || x.name.eq_ignore_ascii_case(r) || x.title.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(r)))
    }

    /// Agents `me` may send a direct message to.
    pub(super) fn reachable(&self, me: &SubagentRecord) -> Vec<SubagentRecord> {
        self.team_members(me).into_iter().filter(|r| self.may_message(me, r).is_ok()).collect()
    }

    // ── Tools ───────────────────────────────────────────────────────────────

    pub(super) async fn handle_comms_tool(self: &Arc<Self>, me: SubagentRecord, tool: &str, input: &Value, env: ParentEnv) -> (String, bool) {
        let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        let root = self.root_of(&me.session_key);
        match tool {
            TOOL_BROADCAST_TEAM => {
                let text = s("message");
                if text.is_empty() {
                    return ("`message` is empty.".into(), true);
                }
                if !self.may_broadcast(&me) {
                    return ("You may not broadcast in this chat.".into(), true);
                }
                let hop = match self.guard_send(&me, None, false) {
                    Ok(h) => h,
                    Err(e) => return (e, true),
                };
                // Inside the topology groups that allow broadcast (or one named group), else the team.
                let group = s("group");
                let targets = match self.scope_members(&me, "broadcast", &group) {
                    Ok(t) => t,
                    Err(e) => return (e, true),
                };
                if targets.is_empty() {
                    return (if group.is_empty() { "No other agents are in this chat.".into() } else { format!("Nobody else is in the {} group.", group) }, false);
                }
                let to_whom = if group.is_empty() { "the team".to_string() } else { format!("group {}", group) };
                let note = format!("[Broadcast from sub-agent \"{}\" (id {}) to {}]\n{}", me.name, me.id, to_whom, truncate_chars(&text, 8_000));
                for t in &targets {
                    self.send_comm(t, note.clone(), hop, false, &env);
                }
                let names: Vec<String> = targets.iter().map(|t| t.name.clone()).collect();
                self.swarm_event(&env, &me, "team_broadcast", None, &format!("{} agents", targets.len()), &text, "sent", json!({ "recipients": names }));
                (format!("Broadcast to {} agents: {}.", targets.len(), names.join(", ")), false)
            }
            TOOL_SUBSCRIBE | TOOL_UNSUBSCRIBE => {
                let topic = norm_topic(&s("topic"));
                if topic.is_empty() {
                    return ("`topic` is empty.".into(), true);
                }
                let sub = tool == TOOL_SUBSCRIBE;
                let res = self.with_chat(&root, |c| {
                    if sub && !c.topics.contains_key(&topic) && c.topics.len() >= TOPICS_CAP {
                        return Err(format!("This chat has {} topics, the most allowed.", TOPICS_CAP));
                    }
                    let t = c.topics.entry(topic.clone()).or_insert_with(|| Topic { created_by: Some(me.id.clone()), created_at: now_ms(), ..Default::default() });
                    t.subscribers.retain(|x| x != &me.id);
                    if sub {
                        t.subscribers.push(me.id.clone());
                    }
                    let mut lines: Vec<String> = Vec::new();
                    if !t.digest.is_empty() && t.posts.len() < 5 {
                        lines.push(compact::one_line(&t.digest.render("posts"), 400));
                    }
                    lines.extend(t.posts.iter().rev().take(5).rev().map(|p| format!("- {}: {}", p.from_name, truncate_chars(&p.text, 300))));
                    Ok(lines)
                });
                match res {
                    Err(e) => (e, true),
                    Ok(recent) => {
                        self.swarm_event(&env, &me, if sub { "subscribe" } else { "unsubscribe" }, None, &format!("#{}", topic), "", "ok", json!({ "topic": topic }));
                        if !sub {
                            return (format!("Unsubscribed from #{}.", topic), false);
                        }
                        let tail = if recent.is_empty() { String::new() } else { format!(" Latest posts:\n{}", recent.join("\n")) };
                        (format!("Subscribed to #{}: new posts arrive as messages.{}", topic, tail), false)
                    }
                }
            }
            TOOL_PUBLISH => {
                let topic = norm_topic(&s("topic"));
                let text = s("message");
                if topic.is_empty() || text.is_empty() {
                    return ("`topic` and `message` are required.".into(), true);
                }
                if self.read_chat(&root, |c| !c.topics.contains_key(&topic) && c.topics.len() >= TOPICS_CAP) {
                    return (format!("This chat has {} topics, the most allowed.", TOPICS_CAP), true);
                }
                // Topic delivery stays inside the topology groups that allow topics (or one named group).
                let members = match self.scope_members(&me, "topics", &s("group")) {
                    Ok(m) => m,
                    Err(e) => return (e, true),
                };
                let hop = match self.guard_send(&me, None, false) {
                    Ok(h) => h,
                    Err(e) => return (e, true),
                };
                let subs = self.post_to_topic(&root, &topic, Some(&me), &text);
                let targets: Vec<SubagentRecord> = members.into_iter().filter(|r| subs.contains(&r.id)).collect();
                let note = format!("[Post on #{} from sub-agent \"{}\" (id {})]\n{}", topic, me.name, me.id, truncate_chars(&text, 8_000));
                for t in &targets {
                    self.send_comm(t, note.clone(), hop, false, &env);
                }
                self.swarm_event(&env, &me, "topic_post", None, &format!("#{}", topic), &text, &format!("{} subscribers", targets.len()), json!({ "topic": topic, "delivered": targets.len() }));
                (format!("Posted on #{}; delivered to {} subscriber{}.", topic, targets.len(), if targets.len() == 1 { "" } else { "s" }), false)
            }
            TOOL_LIST_TOPICS => {
                let names = self.name_map(&root);
                let lines = self.read_chat(&root, |c| {
                    c.topics
                        .iter()
                        .map(|(k, t)| {
                            let subs: Vec<String> = t.subscribers.iter().map(|i| names.get(i).cloned().unwrap_or_else(|| i.clone())).collect();
                            let last: Vec<String> = t.posts.iter().rev().take(3).rev().map(|p| format!("    {}: {}", p.from_name, truncate_chars(&p.text, 200))).collect();
                            format!(
                                "- #{} ({} post{}; subscribers: {}){}{}{}",
                                k,
                                t.total,
                                if t.total == 1 { "" } else { "s" },
                                if subs.is_empty() { "none".into() } else { subs.join(", ") },
                                if t.subscribers.contains(&me.id) { "; you are subscribed" } else { "" },
                                if t.digest.is_empty() { String::new() } else { format!("; {} older compacted", t.digest.count) },
                                if last.is_empty() { String::new() } else { format!("\n{}", last.join("\n")) }
                            )
                        })
                        .collect::<Vec<_>>()
                });
                if lines.is_empty() {
                    ("No topics yet. subscribe_topic or publish_topic creates one.".into(), false)
                } else {
                    (lines.join("\n"), false)
                }
            }
            TOOL_BB_READ => {
                let key = s("key");
                let hl = self.effective_comms(&root).pheromone_half_life_min;
                let now = now_ms();
                if key.is_empty() {
                    let mut rows = self.read_chat(&root, |c| c.blackboard.iter().map(|(k, e)| (k.clone(), e.clone())).collect::<Vec<_>>());
                    if rows.is_empty() {
                        return ("The blackboard is empty.".into(), false);
                    }
                    rows.sort_by(|a, b| b.1.weight_now(hl, now).partial_cmp(&a.1.weight_now(hl, now)).unwrap_or(std::cmp::Ordering::Equal).then(b.1.updated_at.cmp(&a.1.updated_at)));
                    let lines: Vec<String> = rows
                        .iter()
                        .take(40)
                        .map(|(k, e)| format!("- {} (v{}, by {}, weight {:.1}): {}", k, e.version, e.author_name, e.weight_now(hl, now), truncate_chars(&e.value, 160)))
                        .collect();
                    return (format!("Blackboard ({} keys, strongest marks first):\n{}", rows.len(), lines.join("\n")), false);
                }
                match self.read_chat(&root, |c| c.blackboard.get(&key).cloned()) {
                    Some(e) => (format!("{} (version {}, by {}, weight {:.1}):\n{}", key, e.version, e.author_name, e.weight_now(hl, now), e.value), false),
                    None => (format!("No blackboard key {}.", key), false),
                }
            }
            TOOL_BB_WRITE => {
                let key = truncate_chars(&s("key"), 120);
                if key.is_empty() {
                    return ("`key` is empty.".into(), true);
                }
                let eff = self.effective_comms(&root);
                if !self.who_rule_allows(&eff.blackboard_writers, &me) {
                    return ("The user lets only leads write to the blackboard in this chat.".into(), true);
                }
                if let Err(e) = self.guard_send(&me, None, true) {
                    return (e, true);
                }
                let value = input.get("value").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()));
                let expected = input.get("expected_version").or_else(|| input.get("expectedVersion")).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|x| x.parse().ok())));
                let reinforce = input.get("reinforce").is_some_and(|v| v.as_bool().unwrap_or(false) || v.as_str() == Some("true"));
                let delete = input.get("delete").is_some_and(|v| v.as_bool().unwrap_or(false) || v.as_str() == Some("true"));
                let tags: Option<Vec<String>> = input.get("tags").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|t| truncate_chars(t.trim(), 40)).take(10).collect());
                match self.board_write(&root, &key, value, expected, reinforce, delete, tags, Some(&me), eff.pheromone_half_life_min) {
                    Ok((op, version)) => {
                        self.swarm_event(&env, &me, "blackboard", None, "Blackboard", &key, op, json!({ "key": key, "op": op, "version": version }));
                        let msg = match op {
                            "deleted" => format!("Deleted {} from the blackboard.", key),
                            "reinforced" => format!("Reinforced the mark {} (version {}).", key, version),
                            _ => format!("Wrote {} (version {}).", key, version),
                        };
                        (msg, false)
                    }
                    Err(e) => (e, true),
                }
            }
            TOOL_BB_SEARCH => {
                let q = s("query").to_lowercase();
                if q.is_empty() {
                    return ("`query` is empty.".into(), true);
                }
                let hits = self.read_chat(&root, |c| {
                    c.blackboard
                        .iter()
                        .filter(|(k, e)| k.to_lowercase().contains(&q) || e.value.to_lowercase().contains(&q) || e.tags.iter().any(|t| t.to_lowercase().contains(&q)))
                        .take(10)
                        .map(|(k, e)| format!("- {} (v{}, by {}): {}", k, e.version, e.author_name, truncate_chars(&e.value, 300)))
                        .collect::<Vec<_>>()
                });
                if hits.is_empty() {
                    (format!("Nothing on the blackboard matches \"{}\".", q), false)
                } else {
                    (hits.join("\n"), false)
                }
            }
            TOOL_REQUEST => self.request_tool(&me, input, &env).await,
            TOOL_REPLY => self.reply_tool(&me, input, &env),
            TOOL_HANDOFF | TOOL_GOSSIP | TOOL_ANNOUNCE | TOOL_BID | TOOL_AWARD | TOOL_CALL_VOTE | TOOL_CAST_VOTE | TOOL_DEBATE | TOOL_ELECT => {
                self.handle_swarm_tool(me, tool, input, env).await
            }
            _ => (format!("Unknown tool {}", tool), true),
        }
    }

    pub(super) fn name_map(&self, root: &str) -> HashMap<String, String> {
        let recs = self.list();
        recs.into_iter().filter(|r| self.root_of(&r.session_key) == root).map(|r| (r.id.clone(), r.name.clone())).collect()
    }

    /// Append a post to a topic (creating it); returns its subscribers.
    pub(super) fn post_to_topic(&self, root: &str, topic: &str, from: Option<&SubagentRecord>, text: &str) -> Vec<String> {
        self.with_chat(root, |c| {
            let t = c.topics.entry(topic.to_string()).or_insert_with(|| Topic { created_by: from.map(|f| f.id.clone()), created_at: now_ms(), ..Default::default() });
            t.total += 1;
            let seq = t.total;
            t.posts.push_back(Post { seq, from_id: from.map(|f| f.id.clone()), from_name: from.map(|f| f.name.clone()).unwrap_or_else(|| "You".into()), text: truncate_chars(text, 8_000), at: now_ms() });
            while t.posts.len() > TOPIC_POSTS {
                t.posts.pop_front();
            }
            t.subscribers.clone()
        })
    }

    /// Write, reinforce or delete a blackboard key. Returns (op, version).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn board_write(
        &self,
        root: &str,
        key: &str,
        value: Option<String>,
        expected: Option<u64>,
        reinforce: bool,
        delete: bool,
        tags: Option<Vec<String>>,
        by: Option<&SubagentRecord>,
        half_life_min: u32,
    ) -> Result<(&'static str, u64), String> {
        self.with_chat(root, |c| {
            let cur = c.blackboard.get(key).cloned();
            if let (Some(exp), Some(cur)) = (expected, &cur) {
                if cur.version != exp {
                    return Err(format!(
                        "Conflict: {} is at version {} (by {}), not {}. Read it again, merge, and write with expected_version={}. Current value:\n{}",
                        key,
                        cur.version,
                        cur.author_name,
                        exp,
                        cur.version,
                        truncate_chars(&cur.value, 2_000)
                    ));
                }
            }
            if expected.is_some_and(|e| e > 0) && cur.is_none() {
                return Err(format!("Conflict: {} no longer exists.", key));
            }
            if delete {
                return match c.blackboard.remove(key) {
                    Some(e) => Ok(("deleted", e.version)),
                    None => Err(format!("No blackboard key {}.", key)),
                };
            }
            if cur.is_none() && c.blackboard.len() >= BOARD_CAP {
                return Err(format!("The blackboard holds {} keys, the most allowed. Delete or reuse one.", BOARD_CAP));
            }
            if value.is_none() && !reinforce {
                return Err("Give a `value`, or reinforce=true to strengthen the mark.".into());
            }
            let now = now_ms();
            let e = c.blackboard.entry(key.to_string()).or_insert_with(|| BoardEntry { weight: 0.0, reinforced_at: now, ..Default::default() });
            let w = e.weight_now(half_life_min, now);
            let op = if let Some(v) = value {
                e.value = truncate_chars(&v, BOARD_VALUE_CHARS);
                e.version += 1;
                "written"
            } else {
                if e.version == 0 {
                    e.version = 1;
                }
                "reinforced"
            };
            e.weight = w + 1.0;
            e.reinforced_at = now;
            e.updated_at = now;
            e.writes += 1;
            e.author_id = by.map(|b| b.id.clone());
            e.author_name = by.map(|b| b.name.clone()).unwrap_or_else(|| "You".into());
            if let Some(t) = tags {
                e.tags = t;
            }
            Ok((op, e.version))
        })
    }

    async fn request_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let to_ref = input.get("to").and_then(Value::as_str).unwrap_or("");
        let q = input.get("question").or_else(|| input.get("message")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        if q.is_empty() {
            return ("`question` is empty.".into(), true);
        }
        let Some(target) = self.find_member(me, to_ref) else {
            return (format!("No visible agent {}. Call list_peers.", to_ref), true);
        };
        if let Err(e) = self.may_message(me, &target) {
            self.append_log(&me.id, "subagent.comms_blocked", me, &json!({ "to": target.id, "toName": target.name, "text": truncate_chars(&q, 500), "reason": e }));
            return (e, true);
        }
        let wait = input.get("wait").is_some_and(|v| v.as_bool().unwrap_or(false) || v.as_str() == Some("true"));
        let eff = self.effective_comms(&self.root_of(&me.session_key));
        let timeout = input.get("timeout_s").or_else(|| input.get("timeoutS")).and_then(Value::as_u64).unwrap_or(eff.request_timeout_s as u64).clamp(5, 1800);
        let deadlock = if wait { self.would_deadlock(&me.id, std::slice::from_ref(&target.id)) } else { None };
        let hop = match self.guard_send(me, Some(&target), false) {
            Ok(h) => h,
            Err(e) => {
                self.append_log(&me.id, "subagent.comms_blocked", me, &json!({ "to": target.id, "toName": target.name, "text": truncate_chars(&q, 500), "reason": e }));
                return (e, true);
            }
        };
        let id = short_id("rq");
        let waiting = wait && deadlock.is_none();
        self.swarm_rt.lock().unwrap().requests.insert(
            id.clone(),
            OpenRequest { id: id.clone(), from_id: me.id.clone(), to_id: target.id.clone(), question: q.clone(), answer: None, waiting, at: now_ms() },
        );
        let note = format!(
            "[Request {} from sub-agent \"{}\" (id {}){}]\n{}\nAnswer with reply_peer(request_id=\"{}\", answer=...).",
            id,
            me.name,
            me.id,
            if waiting { ", it is waiting for your answer" } else { "" },
            truncate_chars(&q, 8_000),
            id
        );
        let how = self.send_comm(&target, note, hop, eff.wake_idle, env);
        self.swarm_event(env, me, "request", Some(&target), "", &q, how, json!({ "requestId": id, "wait": waiting }));
        if !waiting {
            let lead = match deadlock {
                Some(_) => format!("Sent request {} to {} without waiting: {} is already waiting on you, so waiting would deadlock. ", id, target.name, target.name),
                None => format!("Sent request {} to {} ({}). ", id, target.name, how),
            };
            return (format!("{}Its reply arrives as a message.", lead), false);
        }
        let _g = self.begin_wait(&me.id, std::slice::from_ref(&target.id));
        let rid = id.clone();
        let end = self.wait_until(Duration::from_secs(timeout), &env.abort, |m| m.swarm_rt.lock().unwrap().requests.get(&rid).is_some_and(|r| r.answer.is_some())).await;
        let answer = {
            let mut rt = self.swarm_rt.lock().unwrap();
            let a = rt.requests.get(&id).and_then(|r| r.answer.clone());
            if a.is_some() {
                rt.requests.remove(&id);
            } else if let Some(r) = rt.requests.get_mut(&id) {
                // A late reply now arrives as a message.
                r.waiting = false;
            }
            a
        };
        match (end, answer) {
            (_, Some(a)) => (format!("{} replies: {}", target.name, a), false),
            (Waited::Aborted, _) => ("Cancelled while waiting for the reply.".into(), true),
            _ => (format!("No reply from {} within {}s. A late reply arrives as a message; carry on meanwhile.", target.name, timeout), true),
        }
    }

    fn reply_tool(self: &Arc<Self>, me: &SubagentRecord, input: &Value, env: &ParentEnv) -> (String, bool) {
        let rid = input.get("request_id").or_else(|| input.get("requestId")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let answer = input.get("answer").or_else(|| input.get("message")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        if answer.is_empty() {
            return ("`answer` is empty.".into(), true);
        }
        let req = self.swarm_rt.lock().unwrap().requests.get(&rid).cloned();
        let Some(req) = req else {
            return (format!("No open request {}. It may have been answered already.", rid), true);
        };
        if req.to_id != me.id {
            return (format!("Request {} was not sent to you.", rid), true);
        }
        if req.answer.is_some() {
            return (format!("You already answered {}.", rid), true);
        }
        let asker = self.get(&req.from_id);
        if let Err(e) = self.guard_send(me, asker.as_ref(), true) {
            return (e, true);
        }
        let waiting = {
            let mut rt = self.swarm_rt.lock().unwrap();
            match rt.requests.get_mut(&rid) {
                Some(r) => {
                    r.answer = Some(truncate_chars(&answer, 8_000));
                    r.waiting
                }
                None => false,
            }
        };
        if !waiting {
            self.swarm_rt.lock().unwrap().requests.remove(&rid);
            if let Some(a) = &asker {
                let note = format!("[Reply to request {} from sub-agent \"{}\" (id {})]\n{}", rid, me.name, me.id, truncate_chars(&answer, 8_000));
                let hop = self.swarm_rt.lock().unwrap().hops.get(&me.id).map(|h| h.0).unwrap_or(0) + 1;
                self.send_comm(a, note, hop, false, env);
            }
        }
        self.swarm_event(env, me, "reply", asker.as_ref(), "", &answer, if waiting { "answered" } else { "sent" }, json!({ "requestId": rid }));
        (format!("Answered {}.", rid), false)
    }

    /// Requests an agent has not answered yet (for tests and the swarm panel).
    pub fn open_requests_for(&self, id: &str) -> Vec<(String, String)> {
        let rt = self.swarm_rt.lock().unwrap();
        let mut v: Vec<&OpenRequest> = rt.requests.values().filter(|r| r.to_id == id && r.answer.is_none()).collect();
        v.sort_by_key(|r| r.at);
        v.into_iter().map(|r| (r.id.clone(), r.question.clone())).collect()
    }

    pub(super) fn comms_tool_definitions() -> Vec<ToolDefinition> {
        let def = |name: &str, description: &str, schema: Value| ToolDefinition { name: name.into(), description: description.into(), input_schema: schema, webview_only: false, approval_policy: None };
        let obj = |props: Value, req: &[&str]| json!({"type": "object", "properties": props, "required": req});
        vec![
            def(TOOL_BROADCAST_TEAM, "Send one message to every agent of this chat you can see (a status update, a finding everyone needs, a change of plan). Use sparingly: it reaches everyone.", obj(json!({"message": {"type": "string"}, "group": {"type": "string", "description": "Optional: a topology group you are in; only its members receive it."}}), &["message"])),
            def(TOOL_PUBLISH, "Post a message on a topic channel of this chat (publish/subscribe). Every agent subscribed to the topic receives it; the last posts stay readable with list_topics. Creates the topic if new.", obj(json!({"topic": {"type": "string", "description": "Short name, e.g. findings, bugs, api"}, "message": {"type": "string"}, "group": {"type": "string", "description": "Optional: a topology group you are in; only its subscribed members receive it."}}), &["topic", "message"])),
            def(TOOL_SUBSCRIBE, "Subscribe to a topic channel: its new posts arrive as messages to you. Returns its latest posts.", obj(json!({"topic": {"type": "string"}}), &["topic"])),
            def(TOOL_UNSUBSCRIBE, "Stop receiving a topic's posts.", obj(json!({"topic": {"type": "string"}}), &["topic"])),
            def(TOOL_LIST_TOPICS, "List this chat's topics with subscribers and their latest posts.", obj(json!({}), &[])),
            def(TOOL_BB_READ, "Read the team's shared blackboard: without `key`, every key with its version, author and mark weight (strongest first); with `key`, its full value and version.", obj(json!({"key": {"type": "string"}}), &[])),
            def(
                TOOL_BB_WRITE,
                "Write to the shared blackboard. Pass expected_version (from blackboard_read) to avoid overwriting someone else's change: a stale version is refused with the current value. reinforce=true strengthens a mark (like a pheromone trail) so others see it first; marks fade over time. delete=true removes the key.",
                obj(json!({"key": {"type": "string"}, "value": {"type": "string"}, "expected_version": {"type": "integer"}, "reinforce": {"type": "boolean"}, "delete": {"type": "boolean"}, "tags": {"type": "array", "items": {"type": "string"}}}), &["key"]),
            ),
            def(TOOL_BB_SEARCH, "Search the blackboard's keys, values and tags.", obj(json!({"query": {"type": "string"}}), &["query"])),
            def(
                TOOL_REQUEST,
                "Ask another agent something and get its answer (request/reply). wait=true blocks until it replies or timeout_s passes; otherwise the reply arrives as a message. The other agent answers with reply_peer.",
                obj(json!({"to": {"type": "string", "description": "Agent id or name."}, "question": {"type": "string"}, "wait": {"type": "boolean"}, "timeout_s": {"type": "integer", "minimum": 5, "maximum": 1800}}), &["to", "question"]),
            ),
            def(TOOL_REPLY, "Answer a request another agent sent you (its id starts with rq_), or a debate round.", obj(json!({"request_id": {"type": "string"}, "answer": {"type": "string"}}), &["request_id", "answer"])),
            def(
                TOOL_HANDOFF,
                "Hand your whole task over to another agent that is better suited (swarm handoff). It receives your task and your note and becomes the active agent; its report goes to whoever waits for you. After a handoff, end your turn with one line saying so.",
                obj(json!({"to": {"type": "string"}, "note": {"type": "string", "description": "What you did so far and what is left."}}), &["to", "note"]),
            ),
            def(
                TOOL_GOSSIP,
                "Spread a fact peer to peer: it goes to a few agents that have not heard it, and they may pass it on (gossip). To pass on a rumour you received, give its rumor_id.",
                obj(json!({"fact": {"type": "string"}, "rumor_id": {"type": "string"}}), &[]),
            ),
            def(
                TOOL_ANNOUNCE,
                "Contract net: announce a task to other agents and let them bid. With wait_s, you wait for the bids and the best one is awarded by the chat's rule; otherwise bids arrive as messages and you call award_task.",
                obj(json!({"task": {"type": "string"}, "criteria": {"type": "string"}, "to": {"type": "array", "items": {"type": "string"}, "description": "Only these agents (default: everyone you may message)."}, "wait_s": {"type": "integer", "minimum": 5, "maximum": 900}}), &["task"]),
            ),
            def(
                TOOL_BID,
                "Bid on a task announced to you (id starts with au_): your proposal, your cost estimate (lower is better, e.g. steps) and your confidence 0-1. decline=true to pass.",
                obj(json!({"auction_id": {"type": "string"}, "proposal": {"type": "string"}, "cost": {"type": "number"}, "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "decline": {"type": "boolean"}}), &["auction_id"]),
            ),
            def(TOOL_AWARD, "Award a task you announced: to a bidder by name, or leave `to` out to award by the chat's rule. The winner gets the task; the others are told.", obj(json!({"auction_id": {"type": "string"}, "to": {"type": "string"}}), &["auction_id"])),
            def(
                TOOL_CALL_VOTE,
                "Ask the team to vote on a question with fixed options. The result follows the chat's consensus rule (majority, plurality, unanimous or supermajority) and quorum. With wait_s you wait for the result.",
                obj(json!({"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 10}, "voters": {"type": "array", "items": {"type": "string"}}, "group": {"type": "string", "description": "Optional: a topology group you are in; its members are the default pool."}, "wait_s": {"type": "integer", "minimum": 5, "maximum": 900}}), &["question", "options"]),
            ),
            def(TOOL_CAST_VOTE, "Cast your vote (id starts with vt_) for one of its options, with a short reason.", obj(json!({"vote_id": {"type": "string"}, "option": {"type": "string"}, "reason": {"type": "string"}}), &["vote_id", "option"])),
            def(
                TOOL_DEBATE,
                "Run a debate: the participants state positions, then over several rounds read each other's latest positions and revise. Returns the final positions and whether they agree. Use for hard judgement calls.",
                obj(json!({"topic": {"type": "string"}, "participants": {"type": "array", "items": {"type": "string"}}, "rounds": {"type": "integer", "minimum": 1, "maximum": 10}}), &["topic"]),
            ),
            def(
                TOOL_ELECT,
                "Elect a coordinator for the team: method rank (highest priority, then highest in the team, then the oldest; instant) or vote (every candidate votes; a majority wins). The winner leads; everyone is told.",
                obj(json!({"method": {"type": "string", "enum": ["rank", "vote"]}, "candidates": {"type": "array", "items": {"type": "string"}}, "group": {"type": "string", "description": "Optional: a topology group you are in; its members are the default pool."}}), &[]),
            ),
        ]
    }
}

// ── App API ──────────────────────────────────────────────────────────────

impl SubagentManager {
    /// Topics, blackboard and swarm state for the Explorer and the Swarm panel.
    pub(super) fn swarm_graph(&self, session_key: &str, recs: &[SubagentRecord]) -> Value {
        let root = self.root_of(session_key);
        let eff = self.effective_comms(&root);
        let now = now_ms();
        // Who may message whom: the topology edges the Explorer draws.
        let live: Vec<&SubagentRecord> = recs.iter().filter(|r| !r.chat_deleted).collect();
        let mut topo_edges: Vec<Value> = Vec::new();
        if live.len() <= 60 {
            for a in &live {
                for b in &live {
                    if a.id != b.id && !Self::hidden_from(b, a) && self.may_message(a, b).is_ok() {
                        let rule = self.edge_rule(a, b);
                        topo_edges.push(json!({ "from": a.id, "to": b.id, "kind": "topology", "rule": match rule { Some(true) => "allow", _ => "topology" } }));
                    }
                }
            }
        }
        // The topology groups with their members matched to this chat's agents (the Explorer draws them).
        let groups: Vec<Value> = Self::resolve_groups(&eff.groups, &live.iter().map(|r| (*r).clone()).collect::<Vec<_>>()).iter().map(|g| g.to_json()).collect();
        self.read_chat(&root, |c| {
            let topics: Vec<Value> = c
                .topics
                .iter()
                .map(|(k, t)| json!({ "name": k, "subscribers": t.subscribers, "total": t.total, "createdBy": t.created_by, "lastAt": t.posts.back().map(|p| p.at), "posts": t.posts.iter().rev().take(20).collect::<Vec<_>>(), "digest": t.digest }))
                .collect();
            let board: Vec<Value> = c
                .blackboard
                .iter()
                .map(|(k, e)| json!({ "key": k, "value": truncate_chars(&e.value, 4_000), "version": e.version, "authorId": e.author_id, "authorName": e.author_name, "updatedAt": e.updated_at, "weight": (e.weight_now(eff.pheromone_half_life_min, now) * 100.0).round() / 100.0, "writes": e.writes, "tags": e.tags }))
                .collect();
            json!({
                "topology": eff.topology,
                "topologyEdges": topo_edges,
                "groups": groups,
                "rules": eff.edges,
                "topics": topics,
                "blackboard": board,
                "auctions": c.swarm.auctions,
                "votes": c.swarm.votes,
                "debates": c.swarm.debates,
                "elections": c.swarm.elections,
                "rumors": c.swarm.rumors,
                "handoffs": c.swarm.handoffs,
                "coordinator": c.swarm.coordinator,
                "coordinatorName": c.swarm.coordinator_name,
                "term": c.swarm.term,
                "activeAgent": c.swarm.active_agent,
                "messageCount": c.message_count,
                "paused": eff.paused,
                "boardDigest": c.board_digest,
                "digests": c.swarm.digests,
                "compaction": c.compaction_json(&eff.compaction),
            })
        })
    }

    fn comms_config_payload(&self, root: &str) -> Value {
        let eff = self.effective_comms(root);
        json!({
            "sessionKey": root,
            "config": self.chat_comms_config(root),
            "defaults": self.chat_comms_config(GLOBAL_KEY),
            "effective": eff,
            "effectivePatterns": eff.patterns.clone().unwrap_or_else(|| default_patterns(&eff.topology)),
            "presets": self.comms_presets(),
            "topologies": ALL_TOPOLOGIES,
            "patterns": PATTERNS,
            "defaultPatterns": ALL_TOPOLOGIES.iter().map(|t| (t.to_string(), json!(default_patterns(t)))).collect::<serde_json::Map<String, Value>>(),
            "groupPatterns": ALL_TOPOLOGIES.iter().map(|t| (t.to_string(), json!(groups::group_default_patterns(t)))).collect::<serde_json::Map<String, Value>>(),
            "groupsCap": groups::GROUPS_CAP,
        })
    }

    /// Stop every running agent of a chat and pause its comms.
    pub fn comms_stop_all(self: &Arc<Self>, root: &str) -> Vec<String> {
        self.set_comms_config(root, &json!({ "paused": true }));
        let ids: Vec<String> = self.list().into_iter().filter(|r| r.is_active() && self.root_of(&r.session_key) == root).map(|r| r.id).collect();
        let mut stopped = Vec::new();
        for id in ids.iter().rev() {
            if self.stop(id, "cancelled") {
                stopped.push(id.clone());
            }
        }
        // Nobody is left to bid, vote or award: close what is still open, so
        // the app does not count it as an open decision and compaction can fold it.
        let now = now_ms();
        self.with_chat(root, |c| {
            for a in c.swarm.auctions.iter_mut().filter(|a| a.status == "open") {
                a.status = "cancelled".into();
                a.waiting = false;
                a.closed_at = Some(now);
            }
            for v in c.swarm.votes.iter_mut().filter(|v| v.status == "open") {
                v.status = "cancelled".into();
                v.waiting = false;
                v.closed_at = Some(now);
            }
        });
        stopped
    }

    pub(super) fn channels_app_request(self: &Arc<Self>, action: &str, req: &Value, env: &ParentEnv) -> Option<Result<Value, String>> {
        let session = req.get("sessionKey").and_then(Value::as_str).unwrap_or(&env.session_key).to_string();
        // "*" edits the defaults every chat starts from.
        let root = if session == GLOBAL_KEY { GLOBAL_KEY.to_string() } else { self.root_of(&session) };
        let str_of = |k: &str| req.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        Some(match action {
            "commsConfig" => Ok(self.comms_config_payload(&root)),
            "setCommsConfig" => {
                let patch = req.get("patch").cloned().unwrap_or(json!({}));
                if !patch.is_object() {
                    return Some(Err("`patch` must be an object.".into()));
                }
                let (_, rejected) = self.set_comms_config(&root, &patch);
                let mut out = self.comms_config_payload(&root);
                out["rejected"] = json!(rejected);
                if !rejected.is_empty() && rejected.len() == patch.as_object().map(|o| o.len()).unwrap_or(0) {
                    return Some(Err(format!("Invalid value for {}.", rejected.join(", "))));
                }
                Ok(out)
            }
            "commsPresets" => Ok(json!({ "presets": self.comms_presets() })),
            "saveCommsPreset" => self.save_comms_preset(req).map(|p| json!({ "preset": p, "presets": self.comms_presets() })),
            "deleteCommsPreset" => {
                let n = str_of("name");
                if self.delete_comms_preset(&n) {
                    Ok(json!({ "presets": self.comms_presets() }))
                } else {
                    Err(format!("No saved preset named {}.", n))
                }
            }
            "applyCommsPreset" => self.apply_comms_preset(&root, &str_of("name")).map(|_| self.comms_config_payload(&root)),
            "swarmState" => {
                let recs: Vec<SubagentRecord> = self.list().into_iter().filter(|r| self.root_of(&r.session_key) == root).collect();
                Ok(self.swarm_graph(&root, &recs))
            }
            "blackboardWrite" | "blackboardDelete" => {
                let key = truncate_chars(&str_of("key"), 120);
                if key.is_empty() {
                    return Some(Err("`key` is empty.".into()));
                }
                let del = action == "blackboardDelete";
                let value = req.get("value").and_then(Value::as_str).map(str::to_string);
                if !del && value.is_none() {
                    return Some(Err("`value` is required.".into()));
                }
                let expected = req.get("expectedVersion").and_then(Value::as_u64);
                let hl = self.effective_comms(&root).pheromone_half_life_min;
                let tags: Option<Vec<String>> = req.get("tags").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|t| truncate_chars(t.trim(), 40)).take(10).collect());
                self.board_write(&root, &key, value, expected, false, del, tags, None, hl).map(|(op, v)| json!({ "op": op, "version": v, "key": key }))
            }
            "topicCreate" => {
                let t = norm_topic(&str_of("topic"));
                if t.is_empty() {
                    return Some(Err("`topic` is empty.".into()));
                }
                let made = self.with_chat(&root, |c| {
                    if c.topics.contains_key(&t) {
                        return Ok(false);
                    }
                    if c.topics.len() >= TOPICS_CAP {
                        return Err(format!("At most {} topics.", TOPICS_CAP));
                    }
                    c.topics.insert(t.clone(), Topic { created_at: now_ms(), ..Default::default() });
                    Ok(true)
                });
                made.map(|m| json!({ "topic": t, "created": m }))
            }
            "topicDelete" => {
                let t = norm_topic(&str_of("topic"));
                let removed = self.with_chat(&root, |c| c.topics.remove(&t).is_some());
                if removed {
                    Ok(json!({ "topic": t }))
                } else {
                    Err(format!("No topic #{}.", t))
                }
            }
            "topicSubscribe" => {
                // The user subscribes (or unsubscribes) an agent.
                let t = norm_topic(&str_of("topic"));
                let id = str_of("id");
                let on = req.get("subscribed").and_then(Value::as_bool).unwrap_or(true);
                if t.is_empty() || self.get(&id).is_none() {
                    return Some(Err("Need a `topic` and an agent `id`.".into()));
                }
                let subs = self.with_chat(&root, |c| {
                    let tp = c.topics.entry(t.clone()).or_insert_with(|| Topic { created_at: now_ms(), ..Default::default() });
                    tp.subscribers.retain(|x| x != &id);
                    if on {
                        tp.subscribers.push(id.clone());
                    }
                    tp.subscribers.clone()
                });
                Ok(json!({ "topic": t, "subscribers": subs }))
            }
            "topicPublish" => {
                let t = norm_topic(&str_of("topic"));
                let text = str_of("message");
                if t.is_empty() || text.is_empty() {
                    return Some(Err("`topic` and `message` are required.".into()));
                }
                let subs = self.post_to_topic(&root, &t, None, &text);
                let note = format!("[Post on #{} from the user]\n{}", t, truncate_chars(&text, 8_000));
                let mut n = 0;
                for id in &subs {
                    if let Some(r) = self.get(id) {
                        self.deliver(&r, note.clone());
                        n += 1;
                    }
                }
                Ok(json!({ "topic": t, "delivered": n }))
            }
            "commsStopAll" => Ok(json!({ "stopped": self.comms_stop_all(&root) })),
            "setCommsRole" => {
                let id = str_of("id");
                let role = req.get("role").and_then(Value::as_str).and_then(normalize_role);
                if role.is_none() && req.get("role").and_then(Value::as_str).is_some_and(|r| !r.trim().is_empty()) {
                    return Some(Err(format!("`role` must be one of {}.", ROLES.join(", "))));
                }
                let topo = match req.get("topology").and_then(Value::as_str) {
                    Some("") | None => None,
                    Some(t) => match parse_topology(t) {
                        Ok(t) => Some(t),
                        Err(e) => return Some(Err(e)),
                    },
                };
                let clear_topo = req.get("topology").is_some_and(|v| v.is_null() || v.as_str() == Some(""));
                let has_role = req.get("role").is_some();
                let rec = self.update(&id, |r| {
                    if has_role {
                        r.comms_role = role.clone();
                    }
                    if topo.is_some() {
                        r.topology = topo.clone();
                    } else if clear_topo {
                        r.topology = None;
                    }
                    if let Some(b) = req.get("canBroadcast") {
                        r.can_broadcast = b.as_bool();
                    }
                });
                self.persist();
                rec.map(|r| json!({ "subagent": r })).ok_or_else(|| format!("No sub-agent with id {}.", id))
            }
            _ => return None,
        })
    }
}
