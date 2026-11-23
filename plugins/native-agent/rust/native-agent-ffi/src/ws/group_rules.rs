//! The group rules engine (plan.md, Phase 3.5).
//!
//! Rules are data: a fixed set of kinds with parameters, stored in
//! `ws_group_rules`, each scoped to the whole group or to one member.
//! `decide` is a pure function: the composer's live preview and the real post
//! call it with the same inputs and get the same answer.
//!
//! Evaluation order (the same every time, also shown in the rules help sheet):
//! 1. hard blocks (left, suspended, gone, muted, can_post=0, paused -> queue,
//!    group paused/archived, comms paused, budget exhausted with `pause`,
//!    the sender itself);
//! 2. explicit triggers from the user (`@name`, `@all`, `to`, a reply);
//! 3. explicit triggers from agents (need `agent_to_agent`, the chain depth,
//!    `cooldown` and `quiet`);
//! 4. rule-based calls (`respond`, `unanswered_threshold`);
//! 5. caps last (`max_replies_per_message`, `rate`), trimming in the order
//!    user mentions, direct messages, replies, rule picks (least recent
//!    first). The user's explicit triggers are never trimmed.

use serde_json::{json, Value};

pub const KINDS: [&str; 11] = [
    "delivery",
    "respond",
    "unanswered_threshold",
    "reply_wakes_author",
    "agent_to_agent",
    "silence_nudge",
    "cooldown",
    "max_replies_per_message",
    "rate",
    "budget",
    "quiet",
];

pub const PRESETS: [&str; 5] = ["social", "everyone", "round_table", "wait_your_turn", "moderated"];

/// Tokens assumed for an agent that has never run.
pub const DEFAULT_RUN_TOKENS: i64 = 4_000;
const RATE_WINDOW_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub id: String,
    /// `group` or a member pid.
    pub scope: String,
    pub kind: String,
    pub params: Value,
    pub priority: i64,
    pub enabled: bool,
}

impl Rule {
    pub fn new(id: &str, scope: &str, kind: &str, params: Value) -> Self {
        Rule { id: id.into(), scope: scope.into(), kind: kind.into(), params, priority: 0, enabled: true }
    }
    fn s(&self, k: &str, d: &str) -> String {
        self.params.get(k).and_then(Value::as_str).unwrap_or(d).to_string()
    }
    fn n(&self, k: &str, d: i64) -> i64 {
        self.params.get(k).and_then(Value::as_i64).unwrap_or(d)
    }
    fn b(&self, k: &str, d: bool) -> bool {
        self.params.get(k).and_then(Value::as_bool).unwrap_or(d)
    }
    fn pids(&self, k: &str) -> Vec<String> {
        self.params.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
    }
    /// Lower = fewer wakes. Breaks a priority tie between two rules of the
    /// same kind and scope: the more restrictive one wins.
    fn openness(&self) -> i64 {
        match self.kind.as_str() {
            "respond" => match self.s("mode", "mention_only").as_str() {
                "mention_only" => 0,
                "round_robin" | "first_available" => 1,
                _ => 3,
            },
            "unanswered_threshold" => -self.n("n", 3),
            "reply_wakes_author" => self.b("on", true) as i64,
            "agent_to_agent" => {
                if self.b("allowed", true) {
                    1 + self.n("max_depth", 2)
                } else {
                    0
                }
            }
            "cooldown" => -self.n("secs", 0),
            "max_replies_per_message" => self.n("n", i64::MAX / 2),
            "rate" => self.n("wakes_per_10min", 12),
            "budget" => self.n("tokens_per_day", i64::MAX / 2),
            _ => 0,
        }
    }
}

/// The rule of `kind` that applies to `pid` (None = group-level only):
/// a member-scoped rule beats a group rule; then the higher priority; then
/// the more restrictive one.
pub fn effective<'a>(rules: &'a [Rule], kind: &str, pid: Option<&str>) -> Option<&'a Rule> {
    let pick = |scope_member: bool| -> Option<&'a Rule> {
        rules
            .iter()
            .filter(|r| r.enabled && r.kind == kind)
            .filter(|r| if scope_member { pid.is_some_and(|p| r.scope == p) } else { r.scope == "group" })
            .min_by(|a, b| b.priority.cmp(&a.priority).then(a.openness().cmp(&b.openness())))
    };
    pick(true).or_else(|| pick(false))
}

/// Presence, computed by the caller from the agent record and membership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Active,
    Idle,
    Paused,
    Suspended,
    Gone,
}

impl Presence {
    pub fn as_str(&self) -> &'static str {
        match self {
            Presence::Active => "active",
            Presence::Idle => "idle",
            Presence::Paused => "paused",
            Presence::Suspended => "suspended",
            Presence::Gone => "gone",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Member {
    pub pid: String,
    pub name: String,
    pub role: String,
    /// joined | suspended | left
    pub membership: String,
    pub suspended_reason: Option<String>,
    pub presence: Presence,
    pub can_post: bool,
    pub muted_until: Option<i64>,
    pub last_spoke_at: Option<i64>,
    pub last_woken_at: Option<i64>,
    pub engaged_until: Option<i64>,
    /// Already running or queued for this group: a new wake coalesces.
    pub pending_group_wake: bool,
    /// Group messages since this member last spoke (before this one).
    pub since_spoke: i64,
    /// Average tokens of one run (0 = never ran).
    pub avg_tokens: i64,
}

impl Member {
    pub fn new(pid: &str, name: &str) -> Self {
        Member {
            pid: pid.into(),
            name: name.into(),
            role: "member".into(),
            membership: "joined".into(),
            suspended_reason: None,
            presence: Presence::Idle,
            can_post: true,
            muted_until: None,
            last_spoke_at: None,
            last_woken_at: None,
            engaged_until: None,
            pending_group_wake: false,
            since_spoke: 0,
            avg_tokens: 0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct GroupState {
    pub unanswered: i64,
    pub last_message_at: Option<i64>,
    pub last_agent_reply_at: Option<i64>,
    pub chain_depth: i64,
    pub wakes_window_start: Option<i64>,
    pub wakes_in_window: i64,
    pub tokens_day: Option<String>,
    pub tokens_used: i64,
    pub rr_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GroupInfo {
    /// active | paused | archived | trashed | deleted
    pub state: String,
    /// The user paused messages between agents (for the sender's chat).
    pub comms_paused: bool,
    pub confirm_agents: usize,
    pub confirm_tokens: i64,
    /// Today, `YYYY-MM-DD` (budget day).
    pub today: String,
}

impl Default for GroupInfo {
    fn default() -> Self {
        GroupInfo { state: "active".into(), comms_paused: false, confirm_agents: 4, confirm_tokens: 20_000, today: String::new() }
    }
}

/// The message being decided.
#[derive(Debug, Clone, Default)]
pub struct Incoming {
    pub from: String,
    pub from_user: bool,
    /// Parsed mentions (pids, or `@all`).
    pub mentions: Vec<String>,
    /// Direct recipients inside the group.
    pub to: Vec<String>,
    /// Author of the message this one replies to.
    pub reply_to_author: Option<String>,
    pub text_chars: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pick {
    pub pid: String,
    pub reason: String,
    pub rule_id: Option<String>,
    pub est_tokens: i64,
    /// 0 user mention, 1 direct, 2 reply, 3 agent trigger, 4 rule pick.
    pub order: u8,
    pub user_explicit: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Dispatch {
    pub wake: Vec<Pick>,
    pub deliver: Vec<(String, String)>,
    pub skip: Vec<(String, String)>,
    pub queue: Vec<(String, String)>,
    pub coalesce: Vec<(String, String)>,
    pub needs_confirm: Option<Value>,
    /// Round-robin cursor after this message.
    pub rr_cursor: Option<String>,
    /// Agent-to-agent chain depth after this message.
    pub chain_depth: i64,
}

impl Dispatch {
    /// One row per member: `(pid, decision, reason, rule_id, est_tokens)`.
    pub fn rows(&self) -> Vec<(String, &'static str, String, Option<String>, i64)> {
        let mut out = Vec::new();
        for p in &self.wake {
            out.push((p.pid.clone(), "wake", p.reason.clone(), p.rule_id.clone(), p.est_tokens));
        }
        for (list, d) in [(&self.deliver, "deliver"), (&self.skip, "skip"), (&self.queue, "queue"), (&self.coalesce, "coalesce")] {
            for (pid, r) in list {
                out.push((pid.clone(), d, r.clone(), None, 0));
            }
        }
        out
    }

    pub fn to_json(&self) -> Value {
        json!({
            "wake": self.wake.iter().map(|p| json!({"pid": p.pid, "reason": p.reason, "ruleId": p.rule_id, "estTokens": p.est_tokens})).collect::<Vec<_>>(),
            "deliver": self.deliver.iter().map(|(p, r)| json!({"pid": p, "reason": r})).collect::<Vec<_>>(),
            "skip": self.skip.iter().map(|(p, r)| json!({"pid": p, "reason": r})).collect::<Vec<_>>(),
            "queue": self.queue.iter().map(|(p, r)| json!({"pid": p, "reason": r})).collect::<Vec<_>>(),
            "coalesce": self.coalesce.iter().map(|(p, r)| json!({"pid": p, "reason": r})).collect::<Vec<_>>(),
            "needsConfirm": self.needs_confirm,
            "estTokens": self.wake.iter().map(|p| p.est_tokens).sum::<i64>(),
        })
    }
}

pub fn est_tokens(m: &Member, note_chars: usize) -> i64 {
    let base = if m.avg_tokens > 0 { m.avg_tokens } else { DEFAULT_RUN_TOKENS };
    base + (note_chars as i64) / 4
}

fn budget_exhausted(rules: &[Rule], group: &GroupInfo, state: &GroupState) -> Option<String> {
    let r = effective(rules, "budget", None)?;
    let cap = r.n("tokens_per_day", 0);
    if cap <= 0 {
        return None;
    }
    let used = if state.tokens_day.as_deref() == Some(group.today.as_str()) { state.tokens_used } else { 0 };
    (used >= cap).then(|| r.s("on_exhausted", "mentions_only"))
}

/// Decide who is woken, delivered, skipped or queued for one message.
pub fn decide(group: &GroupInfo, msg: &Incoming, members: &[Member], rules: &[Rule], state: &GroupState, now: i64) -> Dispatch {
    let mut d = Dispatch { rr_cursor: state.rr_cursor.clone(), chain_depth: if msg.from_user { 0 } else { state.chain_depth }, ..Default::default() };
    let budget = budget_exhausted(rules, group, state);
    let at_all = msg.mentions.iter().any(|m| m == "@all");
    let note_chars = msg.text_chars + 200;
    let mut rule_candidates: Vec<&Member> = Vec::new();
    let mut agent_triggered = false;

    for m in members {
        // 1. Hard blocks.
        if m.pid == msg.from {
            d.skip.push((m.pid.clone(), "blocked:self".into()));
            continue;
        }
        if m.membership == "left" {
            d.skip.push((m.pid.clone(), "blocked:left".into()));
            continue;
        }
        if m.membership == "suspended" || m.presence == Presence::Suspended {
            d.skip.push((m.pid.clone(), format!("blocked:suspended:{}", m.suspended_reason.as_deref().unwrap_or("unknown"))));
            continue;
        }
        if m.presence == Presence::Gone {
            d.skip.push((m.pid.clone(), "blocked:gone".into()));
            continue;
        }
        if group.state != "active" {
            d.deliver.push((m.pid.clone(), format!("blocked:group_{}", group.state)));
            continue;
        }
        if m.muted_until.is_some_and(|t| t > now) {
            d.deliver.push((m.pid.clone(), "blocked:muted".into()));
            continue;
        }
        if !m.can_post {
            d.deliver.push((m.pid.clone(), "blocked:can_post".into()));
            continue;
        }
        if !msg.from_user && group.comms_paused {
            d.deliver.push((m.pid.clone(), "blocked:comms_paused".into()));
            continue;
        }
        if budget.as_deref() == Some("pause") {
            d.deliver.push((m.pid.clone(), "blocked:budget".into()));
            continue;
        }

        // The explicit trigger for this member, if any.
        let trigger: Option<(&str, u8)> = if msg.mentions.iter().any(|x| x == &m.pid) {
            Some(("mention", 0))
        } else if at_all {
            Some(("at_all", 0))
        } else if msg.to.iter().any(|x| x == &m.pid) {
            Some(("direct", 1))
        } else if msg.reply_to_author.as_deref() == Some(m.pid.as_str()) {
            let on = effective(rules, "reply_wakes_author", Some(&m.pid)).is_none_or(|r| r.b("on", true));
            if on {
                Some(("reply", 2))
            } else {
                None
            }
        } else {
            None
        };

        if let Some((reason, order)) = trigger {
            if m.presence == Presence::Paused {
                d.queue.push((m.pid.clone(), "blocked:paused".into()));
                continue;
            }
            if m.pending_group_wake {
                d.coalesce.push((m.pid.clone(), reason.into()));
                continue;
            }
            if msg.from_user {
                // 2. The user's explicit triggers override the soft rules.
                d.wake.push(Pick { pid: m.pid.clone(), reason: reason.into(), rule_id: None, est_tokens: est_tokens(m, note_chars), order, user_explicit: true });
                continue;
            }
            // 3. Triggers from agents.
            if budget.is_some() {
                d.deliver.push((m.pid.clone(), "budget:mentions_only".into()));
                continue;
            }
            let a2a = effective(rules, "agent_to_agent", Some(&m.pid));
            let allowed = a2a.is_none_or(|r| r.b("allowed", true));
            let max_depth = a2a.map_or(2, |r| r.n("max_depth", 2));
            if !allowed {
                d.deliver.push((m.pid.clone(), "rule:agent_to_agent_off".into()));
                continue;
            }
            if state.chain_depth >= max_depth {
                d.deliver.push((m.pid.clone(), format!("rule:agent_to_agent_depth ({} of {})", state.chain_depth, max_depth)));
                continue;
            }
            if let Some(why) = soft_block(rules, m, now) {
                d.deliver.push((m.pid.clone(), why));
                continue;
            }
            agent_triggered = true;
            d.wake.push(Pick { pid: m.pid.clone(), reason: format!("agent_{reason}"), rule_id: a2a.map(|r| r.id.clone()), est_tokens: est_tokens(m, note_chars), order: 3, user_explicit: false });
            continue;
        }
        rule_candidates.push(m);
    }
    if agent_triggered {
        d.chain_depth = state.chain_depth + 1;
    }

    // 4. Rule-based calls, for members with no explicit trigger.
    let mut picked: Vec<(String, String, Option<String>)> = Vec::new();
    if budget.is_none() {
        let eligible: Vec<&Member> = rule_candidates.iter().copied().filter(|m| m.presence != Presence::Paused).collect();
        // respond
        let mut rr_pool: Vec<(&Member, String)> = Vec::new();
        let mut fa_pool: Vec<(&Member, String)> = Vec::new();
        for m in &eligible {
            let Some(r) = effective(rules, "respond", Some(&m.pid)) else { continue };
            let on_all = r.s("on", "user_messages") == "all_messages";
            if !msg.from_user && !on_all {
                continue;
            }
            match r.s("mode", "mention_only").as_str() {
                "everyone" => picked.push((m.pid.clone(), "rule:everyone_replies".into(), Some(r.id.clone()))),
                "round_robin" => rr_pool.push((m, r.id.clone())),
                "first_available" => fa_pool.push((m, r.id.clone())),
                _ => {}
            }
        }
        if !rr_pool.is_empty() {
            let pos = d.rr_cursor.as_ref().and_then(|c| rr_pool.iter().position(|(m, _)| &m.pid == c));
            let next = match pos {
                Some(i) => (i + 1) % rr_pool.len(),
                None => match &d.rr_cursor {
                    // The cursor's member left the pool: continue after it by order of pid.
                    Some(c) => rr_pool.iter().position(|(m, _)| m.pid.as_str() > c.as_str()).unwrap_or(0),
                    None => 0,
                },
            };
            let (m, rid) = &rr_pool[next];
            picked.push((m.pid.clone(), "rule:round_robin".into(), Some(rid.clone())));
            d.rr_cursor = Some(m.pid.clone());
        }
        if let Some((m, rid)) = fa_pool.iter().min_by_key(|(m, _)| (m.last_woken_at.unwrap_or(0).max(m.last_spoke_at.unwrap_or(0)), m.pid.clone())) {
            picked.push((m.pid.clone(), "rule:first_available".into(), Some(rid.clone())));
        }
        // unanswered_threshold
        let unanswered_now = if msg.from_user { state.unanswered + 1 } else { 0 };
        let mut group_rule_done = false;
        for m in &eligible {
            let Some(r) = effective(rules, "unanswered_threshold", Some(&m.pid)) else { continue };
            if picked.iter().any(|p| p.0 == m.pid) {
                continue;
            }
            let n = r.n("n", 3).max(1);
            let count = if r.s("count", "group") == "member" { m.since_spoke + 1 } else { unanswered_now };
            if count < n {
                continue;
            }
            if r.scope != "group" {
                picked.push((m.pid.clone(), format!("rule:unanswered_threshold ({count} of {n})"), Some(r.id.clone())));
                continue;
            }
            if group_rule_done {
                continue;
            }
            group_rule_done = true;
            let pool: Vec<&Member> = eligible
                .iter()
                .copied()
                .filter(|x| effective(rules, "unanswered_threshold", Some(&x.pid)).is_some_and(|rr| rr.id == r.id))
                .filter(|x| !picked.iter().any(|p| p.0 == x.pid))
                .collect();
            let reason = format!("rule:unanswered_threshold ({count} of {n})");
            let chosen: Vec<&Member> = match r.params.get("wake") {
                Some(Value::Array(_)) => {
                    let names = r.pids("wake");
                    pool.into_iter().filter(|x| names.contains(&x.pid)).collect()
                }
                _ => match r.s("wake", "all").as_str() {
                    "least_recent" | "round_robin" => pool.into_iter().min_by_key(|x| (x.last_spoke_at.unwrap_or(0), x.pid.clone())).into_iter().collect(),
                    _ => pool,
                },
            };
            for x in chosen {
                picked.push((x.pid.clone(), reason.clone(), Some(r.id.clone())));
            }
        }
    }
    for m in rule_candidates {
        match picked.iter().find(|p| p.0 == m.pid) {
            Some((_, reason, rid)) => {
                if m.presence == Presence::Paused {
                    d.queue.push((m.pid.clone(), "blocked:paused".into()));
                } else if m.pending_group_wake {
                    d.coalesce.push((m.pid.clone(), reason.clone()));
                } else if let Some(why) = soft_block(rules, m, now) {
                    d.deliver.push((m.pid.clone(), why));
                } else {
                    d.wake.push(Pick { pid: m.pid.clone(), reason: reason.clone(), rule_id: rid.clone(), est_tokens: est_tokens(m, note_chars), order: 4, user_explicit: false });
                }
            }
            None if m.presence == Presence::Paused => d.queue.push((m.pid.clone(), "paused".into())),
            None => {
                let why = match effective(rules, "unanswered_threshold", Some(&m.pid)) {
                    Some(r) => {
                        let n = r.n("n", 3).max(1);
                        let count = if r.s("count", "group") == "member" { m.since_spoke + 1 } else if msg.from_user { state.unanswered + 1 } else { 0 };
                        format!("rule:wait_your_turn ({} of {} unanswered)", count.min(n), n)
                    }
                    None if budget.is_some() => "budget:mentions_only".into(),
                    None => "delivery".into(),
                };
                match effective(rules, "delivery", Some(&m.pid)).map(|r| r.s("mode", "all")).as_deref() {
                    Some("none") | Some("mentions_and_replies") => d.skip.push((m.pid.clone(), "rule:delivery".into())),
                    _ => d.deliver.push((m.pid.clone(), why)),
                }
            }
        }
    }

    // 5. Caps last.
    d.wake.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| {
        let la = members.iter().find(|m| m.pid == a.pid).and_then(|m| m.last_spoke_at).unwrap_or(0);
        let lb = members.iter().find(|m| m.pid == b.pid).and_then(|m| m.last_spoke_at).unwrap_or(0);
        la.cmp(&lb)
    }));
    if let Some(r) = effective(rules, "max_replies_per_message", None) {
        let n = r.n("n", 0);
        if n > 0 {
            trim(&mut d, n as usize, "cap:max_replies");
        }
    }
    if let Some(r) = effective(rules, "rate", None) {
        let limit = r.n("wakes_per_10min", 12).max(0);
        let used = match state.wakes_window_start {
            Some(s) if now - s < RATE_WINDOW_MS => state.wakes_in_window,
            _ => 0,
        };
        let room = (limit - used).max(0) as usize;
        trim(&mut d, room, "cap:rate");
    }
    let total: i64 = d.wake.iter().map(|p| p.est_tokens).sum();
    if msg.from_user && (d.wake.len() > group.confirm_agents || total > group.confirm_tokens) {
        d.needs_confirm = Some(json!({ "agents": d.wake.len(), "estTokens": total, "thresholdAgents": group.confirm_agents, "thresholdTokens": group.confirm_tokens }));
    }
    d
}

/// Keep at most `n` wakes; the user's explicit triggers are never trimmed.
fn trim(d: &mut Dispatch, n: usize, reason: &str) {
    let mut kept = 0usize;
    let mut out = Vec::new();
    for p in std::mem::take(&mut d.wake) {
        if p.user_explicit || kept < n {
            kept += 1;
            out.push(p);
        } else {
            d.deliver.push((p.pid, reason.to_string()));
        }
    }
    d.wake = out;
}

/// `cooldown` and `quiet` (soft blocks the user's explicit triggers override).
fn soft_block(rules: &[Rule], m: &Member, now: i64) -> Option<String> {
    if rules.iter().any(|r| r.enabled && r.kind == "quiet" && (r.scope == m.pid || r.pids("members").contains(&m.pid))) {
        return Some("rule:quiet".into());
    }
    if let Some(r) = effective(rules, "cooldown", Some(&m.pid)) {
        let secs = r.n("secs", 0);
        if secs > 0 && m.last_spoke_at.is_some_and(|t| now - t < secs * 1000) {
            return Some(format!("rule:cooldown ({secs}s)"));
        }
    }
    None
}

/// Whether the silence nudge is due for the newest unanswered user message
/// (fires once per message: `already_fired_for` is the message it last fired
/// for). Returns the rule's action.
pub fn silence_due(rules: &[Rule], last_user_msg: Option<(&str, i64)>, answered: bool, already_fired_for: Option<&str>, now: i64) -> Option<Value> {
    let (mid, at) = last_user_msg?;
    if answered || already_fired_for == Some(mid) {
        return None;
    }
    let r = effective(rules, "silence_nudge", None)?;
    let after = r.n("after_secs", 120).max(1);
    if now - at < after * 1000 {
        return None;
    }
    let action = match r.params.get("action") {
        Some(Value::Object(o)) if o.contains_key("wake") => json!({ "wake": o["wake"].clone() }),
        _ => json!(r.s("action", "notify_user")),
    };
    Some(json!({ "messageId": mid, "action": action, "ruleId": r.id }))
}

/// The rule list a preset starts with: `(kind, params)`, all group-scoped.
pub fn preset_rules(preset: &str) -> Vec<(&'static str, Value)> {
    let base_nudge = ("silence_nudge", json!({"after_secs": 120, "action": "notify_user"}));
    let rate = ("rate", json!({"wakes_per_10min": 12}));
    match preset {
        "everyone" => vec![
            ("respond", json!({"mode": "everyone", "on": "user_messages"})),
            ("reply_wakes_author", json!({"on": true})),
            ("agent_to_agent", json!({"allowed": true, "max_depth": 1})),
            base_nudge,
            ("rate", json!({"wakes_per_10min": 30})),
        ],
        "round_table" => vec![
            ("respond", json!({"mode": "round_robin", "on": "user_messages"})),
            ("reply_wakes_author", json!({"on": true})),
            ("agent_to_agent", json!({"allowed": true, "max_depth": 2})),
            base_nudge,
            rate,
        ],
        "wait_your_turn" => vec![
            ("respond", json!({"mode": "mention_only", "on": "user_messages"})),
            ("unanswered_threshold", json!({"n": 3, "count": "group", "wake": "least_recent"})),
            ("reply_wakes_author", json!({"on": true})),
            ("agent_to_agent", json!({"allowed": true, "max_depth": 2})),
            base_nudge,
            rate,
        ],
        "moderated" => vec![
            ("respond", json!({"mode": "mention_only", "on": "user_messages"})),
            ("reply_wakes_author", json!({"on": true})),
            ("agent_to_agent", json!({"allowed": false, "max_depth": 0})),
            base_nudge,
            rate,
        ],
        _ => vec![
            ("delivery", json!({"mode": "all"})),
            ("respond", json!({"mode": "mention_only", "on": "user_messages"})),
            ("reply_wakes_author", json!({"on": true})),
            ("agent_to_agent", json!({"allowed": true, "max_depth": 2})),
            base_nudge,
            rate,
        ],
    }
}

pub fn preset_label(p: &str) -> &'static str {
    match p {
        "everyone" => "Everyone answers",
        "round_table" => "Round table",
        "wait_your_turn" => "Wait your turn",
        "moderated" => "Moderated",
        "custom" => "Custom",
        _ => "Social",
    }
}

/// Checks run on every save. Errors block the save; warnings are shown.
pub fn validate(rules: &[Rule], member_pids: &[String], names: &dyn Fn(&str) -> String) -> Value {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let is_member = |p: &str| member_pids.iter().any(|m| m == p);
    for r in rules {
        if !KINDS.contains(&r.kind.as_str()) {
            errors.push(format!("Unknown rule kind {}.", r.kind));
            continue;
        }
        if r.scope != "group" && !is_member(&r.scope) {
            errors.push(format!("Rule {} names {}, who is not a member.", r.kind, r.scope));
        }
        for k in ["n", "secs", "wakes_per_10min", "after_secs"] {
            if let Some(v) = r.params.get(k) {
                match v.as_i64() {
                    Some(x) if (k == "n" && x < 1) || x < 0 => errors.push(format!("Rule {}: {} must be at least {}.", r.kind, k, if k == "n" { 1 } else { 0 })),
                    None => errors.push(format!("Rule {}: {} must be a number.", r.kind, k)),
                    _ => {}
                }
            }
        }
        if r.kind == "delivery" && !matches!(r.s("mode", "all").as_str(), "all" | "mentions_and_replies" | "none") {
            errors.push(format!("Rule delivery: unknown mode {}.", r.s("mode", "")));
        }
        if r.kind == "respond" && !matches!(r.s("mode", "mention_only").as_str(), "mention_only" | "everyone" | "round_robin" | "first_available") {
            errors.push(format!("Rule respond: unknown mode {}.", r.s("mode", "")));
        }
        for key in ["members", "wake"] {
            for p in r.pids(key) {
                if !is_member(&p) {
                    errors.push(format!("Rule {} names {}, who is not a member.", r.kind, p));
                }
            }
        }
    }
    // Conflicts worth a warning.
    if let Some(g) = rules.iter().find(|r| r.enabled && r.kind == "respond" && r.scope == "group" && r.s("mode", "") == "everyone") {
        let _ = g;
        for r in rules.iter().filter(|r| r.enabled && r.scope != "group" && (r.kind == "unanswered_threshold" || (r.kind == "respond" && r.s("mode", "") != "everyone"))) {
            let who = names(&r.scope);
            let what = if r.kind == "unanswered_threshold" { "Wait your turn".to_string() } else { format!("respond {}", r.s("mode", "")) };
            warnings.push(format!("Everyone answers is on for the group, but {who} has {what}, so {who} follows {what}."));
        }
    }
    if let Some(a) = effective(rules, "agent_to_agent", None) {
        let reply_on = effective(rules, "reply_wakes_author", None).is_none_or(|r| r.b("on", true));
        if (!a.b("allowed", true) || a.n("max_depth", 2) == 0) && reply_on {
            warnings.push("agent_to_agent depth 0 makes reply_wakes_author useless for agent messages.".into());
        }
    }
    for r in rules.iter().filter(|r| !r.enabled && r.params.get("disabledReason").is_some()) {
        warnings.push(format!("Rule {} is disabled: {}.", r.kind, r.s("disabledReason", "")));
    }
    json!({ "ok": errors.is_empty(), "errors": errors, "warnings": warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members() -> Vec<Member> {
        vec![Member::new("agent:a", "Researcher"), Member::new("agent:b", "Writer"), Member::new("agent:c", "Critic")]
    }
    fn rules(preset: &str) -> Vec<Rule> {
        preset_rules(preset).into_iter().enumerate().map(|(i, (k, p))| Rule::new(&format!("r{i}"), "group", k, p)).collect()
    }
    fn user(text: &str) -> Incoming {
        Incoming { from: "user".into(), from_user: true, text_chars: text.len(), ..Default::default() }
    }
    fn woken(d: &Dispatch) -> Vec<&str> {
        d.wake.iter().map(|p| p.pid.as_str()).collect()
    }
    fn g() -> GroupInfo {
        GroupInfo { today: "2026-11-23".into(), ..Default::default() }
    }

    #[test]
    fn default_social_wakes_nobody_without_mention() {
        let d = decide(&g(), &user("hi all"), &members(), &rules("social"), &GroupState::default(), 1);
        assert!(d.wake.is_empty());
        assert_eq!(d.deliver.len(), 3);
        let mut m = user("@Writer hi");
        m.mentions = vec!["agent:b".into()];
        let d = decide(&g(), &m, &members(), &rules("social"), &GroupState::default(), 1);
        assert_eq!(woken(&d), vec!["agent:b"]);
        assert_eq!(d.wake[0].reason, "mention");
    }

    #[test]
    fn everyone_replies_wakes_all_on_user_message() {
        let d = decide(&g(), &user("thoughts?"), &members(), &rules("everyone"), &GroupState::default(), 1);
        assert_eq!(woken(&d).len(), 3);
        assert!(d.wake.iter().all(|p| p.reason == "rule:everyone_replies"));
    }

    #[test]
    fn everyone_on_user_messages_ignores_agent_messages() {
        let m = Incoming { from: "agent:a".into(), text_chars: 5, ..Default::default() };
        let d = decide(&g(), &m, &members(), &rules("everyone"), &GroupState::default(), 1);
        assert!(d.wake.is_empty());
    }

    #[test]
    fn unanswered_threshold_waits_for_n_then_wakes() {
        let r = rules("wait_your_turn");
        let mut st = GroupState::default();
        let d = decide(&g(), &user("1"), &members(), &r, &st, 1);
        assert!(d.wake.is_empty());
        assert!(d.deliver.iter().any(|(_, why)| why.contains("1 of 3")));
        st.unanswered = 2;
        let d = decide(&g(), &user("3"), &members(), &r, &st, 1);
        assert_eq!(d.wake.len(), 1, "least_recent wakes one");
        assert!(d.wake[0].reason.starts_with("rule:unanswered_threshold"));
    }

    #[test]
    fn unanswered_resets_on_agent_reply() {
        // An agent's post resets the count: the next user message is 1 of 3.
        let r = rules("wait_your_turn");
        let st = GroupState { unanswered: 0, ..Default::default() };
        let d = decide(&g(), &user("after reply"), &members(), &r, &st, 1);
        assert!(d.wake.is_empty());
    }

    #[test]
    fn member_count_mode_uses_last_spoke() {
        let r = vec![Rule::new("t", "agent:c", "unanswered_threshold", json!({"n": 2, "count": "member"}))];
        let mut ms = members();
        ms[2].since_spoke = 1;
        let d = decide(&g(), &user("x"), &ms, &r, &GroupState::default(), 1);
        assert_eq!(woken(&d), vec!["agent:c"]);
        ms[2].since_spoke = 0;
        let d = decide(&g(), &user("x"), &ms, &r, &GroupState::default(), 1);
        assert!(d.wake.is_empty());
    }

    #[test]
    fn round_robin_rotates_and_persists_cursor() {
        let r = rules("round_table");
        let mut st = GroupState::default();
        let mut order = Vec::new();
        for _ in 0..4 {
            let d = decide(&g(), &user("q"), &members(), &r, &st, 1);
            assert_eq!(d.wake.len(), 1);
            order.push(d.wake[0].pid.clone());
            st.rr_cursor = d.rr_cursor.clone();
        }
        assert_eq!(order, vec!["agent:a", "agent:b", "agent:c", "agent:a"]);
    }

    #[test]
    fn reply_wakes_author() {
        let mut m = user("re");
        m.reply_to_author = Some("agent:c".into());
        let d = decide(&g(), &m, &members(), &rules("social"), &GroupState::default(), 1);
        assert_eq!(woken(&d), vec!["agent:c"]);
        let mut r = rules("social");
        r.push(Rule::new("off", "agent:c", "reply_wakes_author", json!({"on": false})));
        let d = decide(&g(), &m, &members(), &r, &GroupState::default(), 1);
        assert!(d.wake.is_empty());
    }

    #[test]
    fn agent_to_agent_depth_stops_chain() {
        let r = rules("social");
        let m = Incoming { from: "agent:a".into(), mentions: vec!["agent:b".into()], ..Default::default() };
        let d = decide(&g(), &m, &members(), &r, &GroupState { chain_depth: 1, ..Default::default() }, 1);
        assert_eq!(woken(&d), vec!["agent:b"]);
        assert_eq!(d.chain_depth, 2);
        let d = decide(&g(), &m, &members(), &r, &GroupState { chain_depth: 2, ..Default::default() }, 1);
        assert!(d.wake.is_empty());
        assert!(d.deliver.iter().any(|(p, why)| p == "agent:b" && why.starts_with("rule:agent_to_agent_depth")));
    }

    #[test]
    fn cooldown_blocks_agent_trigger_not_user_mention() {
        let mut r = rules("social");
        r.push(Rule::new("cd", "group", "cooldown", json!({"secs": 60})));
        let mut ms = members();
        ms[1].last_spoke_at = Some(100_000);
        let a = Incoming { from: "agent:a".into(), mentions: vec!["agent:b".into()], ..Default::default() };
        let d = decide(&g(), &a, &ms, &r, &GroupState::default(), 120_000);
        assert!(d.wake.is_empty());
        let mut u = user("@b");
        u.mentions = vec!["agent:b".into()];
        let d = decide(&g(), &u, &ms, &r, &GroupState::default(), 120_000);
        assert_eq!(woken(&d), vec!["agent:b"]);
    }

    #[test]
    fn user_mention_overrides_threshold_and_quiet() {
        let mut r = rules("wait_your_turn");
        r.push(Rule::new("q", "group", "quiet", json!({"members": ["agent:c"]})));
        let mut u = user("@c");
        u.mentions = vec!["agent:c".into()];
        let d = decide(&g(), &u, &members(), &r, &GroupState::default(), 1);
        assert_eq!(woken(&d), vec!["agent:c"]);
    }

    #[test]
    fn hard_block_beats_user_mention() {
        let mut ms = members();
        ms[0].presence = Presence::Paused;
        ms[1].membership = "suspended".into();
        ms[1].suspended_reason = Some("not_shareable".into());
        ms[2].muted_until = Some(10);
        let mut u = user("@all");
        u.mentions = vec!["@all".into()];
        let d = decide(&g(), &u, &ms, &rules("social"), &GroupState::default(), 1);
        assert!(d.wake.is_empty());
        assert_eq!(d.queue, vec![("agent:a".to_string(), "blocked:paused".to_string())]);
        assert!(d.skip.iter().any(|(p, r)| p == "agent:b" && r == "blocked:suspended:not_shareable"));
        assert!(d.deliver.iter().any(|(p, r)| p == "agent:c" && r == "blocked:muted"));
    }

    #[test]
    fn member_rule_beats_group_rule() {
        let mut r = rules("everyone");
        r.push(Rule::new("m", "agent:c", "respond", json!({"mode": "mention_only"})));
        let d = decide(&g(), &user("q"), &members(), &r, &GroupState::default(), 1);
        assert_eq!(woken(&d), vec!["agent:a", "agent:b"]);
    }

    #[test]
    fn priority_then_restrictive_tie_break() {
        let mut a = Rule::new("a", "group", "respond", json!({"mode": "everyone"}));
        let b = Rule::new("b", "group", "respond", json!({"mode": "mention_only"}));
        assert_eq!(effective(&[a.clone(), b.clone()], "respond", None).unwrap().id, "b", "tie: more restrictive");
        a.priority = 5;
        assert_eq!(effective(&[a, b], "respond", None).unwrap().id, "a", "higher priority wins");
    }

    #[test]
    fn caps_trim_in_documented_order() {
        let mut r = rules("everyone");
        r.push(Rule::new("cap", "group", "max_replies_per_message", json!({"n": 1})));
        let mut ms = members();
        ms.push(Member::new("agent:d", "Dee"));
        ms[1].last_spoke_at = Some(50);
        ms[2].last_spoke_at = Some(10);
        ms[0].last_spoke_at = Some(90);
        let mut u = user("@Dee q");
        u.mentions = vec!["agent:d".into()];
        let d = decide(&g(), &u, &ms, &r, &GroupState::default(), 1);
        // The user's mention is kept and counts; one more slot? No: n=1 is used by the mention.
        assert_eq!(woken(&d), vec!["agent:d"]);
        assert_eq!(d.deliver.iter().filter(|(_, r)| r == "cap:max_replies").count(), 3);
        r.retain(|x| x.id != "cap");
        r.push(Rule::new("cap", "group", "max_replies_per_message", json!({"n": 2})));
        let d = decide(&g(), &u, &ms, &r, &GroupState::default(), 1);
        // Then rule picks by least recent reply: Critic (10).
        assert_eq!(woken(&d), vec!["agent:d", "agent:c"]);
    }

    #[test]
    fn rate_cap_counts_the_window() {
        let r = rules("everyone");
        let st = GroupState { wakes_window_start: Some(0), wakes_in_window: 29, ..Default::default() };
        let d = decide(&g(), &user("q"), &members(), &r, &st, 1_000);
        assert_eq!(d.wake.len(), 1);
        assert_eq!(d.deliver.iter().filter(|(_, r)| r == "cap:rate").count(), 2);
    }

    #[test]
    fn budget_exhausted_degrades_to_mentions_only() {
        let mut r = rules("everyone");
        r.push(Rule::new("bud", "group", "budget", json!({"tokens_per_day": 100, "on_exhausted": "mentions_only"})));
        let st = GroupState { tokens_day: Some("2026-11-23".into()), tokens_used: 100, ..Default::default() };
        let d = decide(&g(), &user("q"), &members(), &r, &st, 1);
        assert!(d.wake.is_empty());
        let mut u = user("@a");
        u.mentions = vec!["agent:a".into()];
        let d = decide(&g(), &u, &members(), &r, &st, 1);
        assert_eq!(woken(&d), vec!["agent:a"]);
        // Another day: the budget is fresh.
        let st2 = GroupState { tokens_day: Some("2026-11-22".into()), tokens_used: 100, ..Default::default() };
        assert_eq!(decide(&g(), &user("q"), &members(), &r, &st2, 1).wake.len(), 3);
        // on_exhausted pause is a hard block, even for mentions.
        r.retain(|x| x.id != "bud");
        r.push(Rule::new("bud", "group", "budget", json!({"tokens_per_day": 100, "on_exhausted": "pause"})));
        assert!(decide(&g(), &u, &members(), &r, &st, 1).wake.is_empty());
    }

    #[test]
    fn silence_nudge_fires_once_per_message() {
        let r = rules("social");
        assert!(silence_due(&r, Some(("m1", 0)), false, None, 60_000).is_none());
        let due = silence_due(&r, Some(("m1", 0)), false, None, 121_000).unwrap();
        assert_eq!(due["action"], "notify_user");
        assert!(silence_due(&r, Some(("m1", 0)), false, Some("m1"), 300_000).is_none());
        assert!(silence_due(&r, Some(("m1", 0)), true, None, 300_000).is_none());
    }

    #[test]
    fn decide_is_pure_preview_equals_post() {
        let r = rules("round_table");
        let st = GroupState { rr_cursor: Some("agent:a".into()), ..Default::default() };
        let a = decide(&g(), &user("q"), &members(), &r, &st, 7);
        let b = decide(&g(), &user("q"), &members(), &r, &st, 7);
        assert_eq!(a, b);
        assert_eq!(a.wake[0].pid, "agent:b");
    }

    #[test]
    fn validate_reports_conflicts_and_errors() {
        let pids = vec!["agent:a".to_string(), "agent:b".to_string()];
        let names = |p: &str| p.replace("agent:", "");
        let mut r = rules("everyone");
        r.push(Rule::new("w", "agent:b", "unanswered_threshold", json!({"n": 3})));
        let v = validate(&r, &pids, &names);
        assert_eq!(v["ok"], true);
        assert!(v["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("b follows Wait your turn")));
        let bad = vec![Rule::new("x", "group", "telepathy", json!({})), Rule::new("y", "group", "unanswered_threshold", json!({"n": 0})), Rule::new("z", "agent:zz", "cooldown", json!({"secs": 1}))];
        let v = validate(&bad, &pids, &names);
        assert_eq!(v["ok"], false);
        assert_eq!(v["errors"].as_array().unwrap().len(), 3);
        let m = vec![Rule::new("m", "group", "agent_to_agent", json!({"allowed": true, "max_depth": 0}))];
        assert!(validate(&m, &pids, &names)["warnings"][0].as_str().unwrap().contains("depth 0"));
    }

    #[test]
    fn delivery_none_skips_quiet_inbox() {
        let mut r = rules("social");
        r.push(Rule::new("dn", "agent:c", "delivery", json!({"mode": "none"})));
        let d = decide(&g(), &user("hi"), &members(), &r, &GroupState::default(), 1);
        assert!(d.skip.iter().any(|(p, why)| p == "agent:c" && why == "rule:delivery"));
        assert_eq!(d.deliver.len(), 2);
    }

    #[test]
    fn paused_member_queued_and_second_wake_coalesces() {
        let mut ms = members();
        ms[0].pending_group_wake = true;
        let mut u = user("@all");
        u.mentions = vec!["@all".into()];
        let d = decide(&g(), &u, &ms, &rules("social"), &GroupState::default(), 1);
        assert_eq!(d.coalesce, vec![("agent:a".to_string(), "at_all".to_string())]);
        assert_eq!(woken(&d), vec!["agent:b", "agent:c"]);
    }

    #[test]
    fn confirm_sheet_above_threshold() {
        let mut ms = members();
        ms.push(Member::new("agent:d", "D"));
        ms.push(Member::new("agent:e", "E"));
        let mut u = user("@all");
        u.mentions = vec!["@all".into()];
        let d = decide(&g(), &u, &ms, &rules("social"), &GroupState::default(), 1);
        assert_eq!(d.wake.len(), 5);
        assert!(d.needs_confirm.is_some());
    }
}
