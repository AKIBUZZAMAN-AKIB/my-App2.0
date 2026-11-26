//! Topology groups: several topologies at once in one chat.
//!
//! The chat's own topology (Tree by default) stays the base layer and covers
//! every agent, as before. On top of it a chat can list named groups, each
//! with its own topology and members, and an agent can be in several groups:
//! e.g. a, d, e, f in a mesh and a, e, g, h on a bus while the spawn tree
//! stays the base. A chat with no groups works exactly as it did.
//!
//! - Who may message whom: hidden and deny rules still win, then the agent's
//!   own `canMessage`, then allow rules, then the base topology; when the base
//!   says no, the message goes through if ANY group both agents are in allows
//!   it by that group's own type (mesh: anyone, ring: the next member, chain:
//!   the neighbours, star: through its hub, hierarchical: through its leads,
//!   tree: parent and child, custom: the group's own links, bus: nobody).
//! - Patterns: an agent gets the tools of the base topology plus those of
//!   every group it is in (a group's own `patterns`, else its type's).
//! - Broadcast, topic delivery and default vote / election pools stay inside
//!   the groups that allow them (`scope_members`): a bus group's broadcast
//!   reaches the bus's members only. The safety rails (hops, caps, rate) are
//!   the chat's and apply to group traffic the same way.

use super::channels::{default_patterns, edge_matches, parse_topology, PATTERNS};
use super::*;
use std::collections::HashSet;

/// At most this many groups per chat.
pub const GROUPS_CAP: usize = 50;
/// A sanity bound only: groups have no small member cap.
pub const GROUP_MEMBERS_CAP: usize = 1_000;
/// At most this many links in one custom group.
pub const GROUP_LINKS_CAP: usize = 500;

/// One undirected link of a custom group.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupLink {
    pub from: String,
    pub to: String,
}

/// A named topology over some of the chat's agents.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TopologyGroup {
    /// Stable id (`tg_…`), made when the group is saved without one.
    pub id: String,
    pub name: String,
    /// One of `ALL_TOPOLOGIES`.
    pub topology: String,
    /// Agent names or ids, in order (ring and chain follow this order).
    pub members: Vec<String>,
    /// The hub of a star group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub: Option<String>,
    /// The leads of a hierarchical group (they also count as leads elsewhere).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub leads: Vec<String>,
    /// The links of a custom group (undirected).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<GroupLink>,
    /// Patterns for this group; None = the type's defaults (`group_default_patterns`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patterns: Option<Vec<String>>,
}

/// The patterns a group of this type turns on by default. Like the chat's
/// defaults, except a tree group: its parents and children may talk directly.
pub fn group_default_patterns(topology: &str) -> Vec<String> {
    match topology {
        "tree" => vec!["direct".into(), "request".into()],
        t => default_patterns(t),
    }
}

pub fn validate_groups(groups: &[TopologyGroup]) -> Result<(), String> {
    if groups.len() > GROUPS_CAP {
        return Err(format!("At most {} topology groups per chat.", GROUPS_CAP));
    }
    let mut names: HashSet<String> = HashSet::new();
    let mut ids: HashSet<String> = HashSet::new();
    for g in groups {
        let name = g.name.trim();
        if name.is_empty() {
            return Err("Every topology group needs a name.".into());
        }
        if name.chars().count() > 60 {
            return Err(format!("Group name \"{}\" is longer than 60 characters.", name));
        }
        if !names.insert(name.to_lowercase()) {
            return Err(format!("Two topology groups are named \"{}\".", name));
        }
        let id = g.id.trim();
        if !id.is_empty() && !ids.insert(id.to_string()) {
            return Err(format!("Two topology groups have the id {}.", id));
        }
        parse_topology(&g.topology).map_err(|e| format!("Group \"{}\": {}", name, e))?;
        if g.members.len() > GROUP_MEMBERS_CAP {
            return Err(format!("Group \"{}\" has more than {} members.", name, GROUP_MEMBERS_CAP));
        }
        if g.members.iter().chain(g.leads.iter()).any(|m| m.trim().is_empty() || m.trim() == "*") {
            return Err(format!("Group \"{}\": members and leads must be agent names or ids.", name));
        }
        if g.hub.as_deref().is_some_and(|h| h.trim() == "*") {
            return Err(format!("Group \"{}\": the hub must be one agent.", name));
        }
        if g.links.len() > GROUP_LINKS_CAP {
            return Err(format!("Group \"{}\" has more than {} links.", name, GROUP_LINKS_CAP));
        }
        if g.links.iter().any(|l| l.from.trim().is_empty() || l.to.trim().is_empty()) {
            return Err(format!("Group \"{}\": every link needs two agents.", name));
        }
        if let Some(p) = &g.patterns {
            if let Some(bad) = p.iter().find(|x| !PATTERNS.contains(&x.as_str())) {
                return Err(format!("Group \"{}\": unknown pattern '{}'.", name, bad));
            }
        }
    }
    Ok(())
}

fn dedupe(list: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    list.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty() && seen.insert(m.to_lowercase())).collect()
}

/// Trim names, lower-case types, drop duplicate members and give every group an id.
pub fn normalize_groups(groups: &mut [TopologyGroup]) {
    for g in groups.iter_mut() {
        g.name = g.name.trim().to_string();
        g.topology = parse_topology(&g.topology).unwrap_or_else(|_| "mesh".into());
        g.members = dedupe(&g.members);
        g.leads = dedupe(&g.leads);
        g.hub = g.hub.as_deref().map(str::trim).filter(|h| !h.is_empty()).map(String::from);
        for l in g.links.iter_mut() {
            l.from = l.from.trim().to_string();
            l.to = l.to.trim().to_string();
        }
        if let Some(p) = &g.patterns {
            g.patterns = Some(PATTERNS.iter().filter(|x| p.iter().any(|y| y == *x)).map(|x| x.to_string()).collect());
        }
        if g.id.trim().is_empty() {
            g.id = format!("tg_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        } else {
            g.id = g.id.trim().to_string();
        }
    }
}

/// A group with its member references matched to the chat's agents.
#[derive(Debug, Clone)]
pub(super) struct ResolvedGroup {
    pub group: TopologyGroup,
    /// Live agents, in the group's member order.
    pub members: Vec<SubagentRecord>,
    pub hub: Option<String>,
    pub leads: Vec<String>,
    pub links: Vec<(String, String)>,
    /// Member references that match no agent of the chat (yet).
    pub missing: Vec<String>,
}

impl ResolvedGroup {
    fn index(&self, id: &str) -> Option<usize> {
        self.members.iter().position(|m| m.id == id)
    }

    pub fn has(&self, id: &str) -> bool {
        self.index(id).is_some()
    }

    fn is_lead(&self, id: &str) -> bool {
        self.leads.iter().any(|l| l == id)
    }

    /// The patterns this group turns on for its members. A star with no hub turns on nothing.
    pub fn patterns(&self) -> Vec<String> {
        if self.group.topology == "star" && self.hub.is_none() {
            return Vec::new();
        }
        self.group.patterns.clone().unwrap_or_else(|| group_default_patterns(&self.group.topology))
    }

    /// Whether this group's type lets `from` message `to` (both must be members).
    pub fn allows(&self, from: &SubagentRecord, to: &SubagentRecord) -> bool {
        let (Some(i), Some(j)) = (self.index(&from.id), self.index(&to.id)) else {
            return false;
        };
        if i == j {
            return false;
        }
        let n = self.members.len();
        match self.group.topology.as_str() {
            "mesh" | "swarm" => true,
            "ring" => n >= 2 && j == (i + 1) % n,
            "chain" => i.abs_diff(j) == 1,
            "star" => self.hub.as_deref().is_some_and(|h| h == from.id || h == to.id),
            "tree" => to.parent_id.as_deref() == Some(from.id.as_str()) || from.parent_id.as_deref() == Some(to.id.as_str()),
            "hierarchical" => {
                // Leads talk to everyone in the group; members talk to a lead and to their own sub-team
                // (same parent, or parent and child).
                self.is_lead(&from.id)
                    || self.is_lead(&to.id)
                    || from.parent_id == to.parent_id
                    || to.parent_id.as_deref() == Some(from.id.as_str())
                    || from.parent_id.as_deref() == Some(to.id.as_str())
            }
            "custom" => self.links.iter().any(|(a, b)| (*a == from.id && *b == to.id) || (*a == to.id && *b == from.id)),
            _ => false, // bus: no direct messages, only broadcast, topics and the blackboard
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.group.id,
            "name": self.group.name,
            "topology": self.group.topology,
            "members": self.group.members,
            "memberIds": self.members.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
            "hubId": self.hub,
            "leadIds": self.leads,
            "links": self.links.iter().map(|(a, b)| json!({ "from": a, "to": b })).collect::<Vec<_>>(),
            "patterns": self.patterns(),
            "missing": self.missing,
        })
    }
}

fn resolve_ref<'a>(recs: &'a [SubagentRecord], r: &str) -> Option<&'a SubagentRecord> {
    let r = r.trim();
    if r.is_empty() || r == "*" {
        return None;
    }
    recs.iter().find(|x| x.id == r).or_else(|| recs.iter().find(|x| edge_matches(r, x)))
}

impl SubagentManager {
    /// The chat's groups with their members matched to its live agents.
    pub(super) fn resolved_groups(&self, root: &str) -> Vec<ResolvedGroup> {
        let groups = self.effective_comms(root).groups;
        if groups.is_empty() {
            return Vec::new();
        }
        let recs: Vec<SubagentRecord> = self.records.lock().unwrap().iter().filter(|r| !r.chat_deleted).cloned().collect();
        let recs: Vec<SubagentRecord> = recs.into_iter().filter(|r| self.root_of(&r.session_key) == root).collect();
        Self::resolve_groups(&groups, &recs)
    }

    pub(super) fn resolve_groups(groups: &[TopologyGroup], recs: &[SubagentRecord]) -> Vec<ResolvedGroup> {
        groups
            .iter()
            .map(|g| {
                let mut members: Vec<SubagentRecord> = Vec::new();
                let mut missing: Vec<String> = Vec::new();
                for m in &g.members {
                    match resolve_ref(recs, m) {
                        Some(r) if !members.iter().any(|x| x.id == r.id) => members.push(r.clone()),
                        Some(_) => {}
                        None => missing.push(m.clone()),
                    }
                }
                let in_group = |r: &str| resolve_ref(recs, r).map(|x| x.id.clone()).filter(|id| members.iter().any(|m| &m.id == id));
                let hub = g.hub.as_deref().and_then(in_group);
                let leads: Vec<String> = g.leads.iter().filter_map(|l| in_group(l)).collect();
                let links: Vec<(String, String)> = g.links.iter().filter_map(|l| Some((in_group(&l.from)?, in_group(&l.to)?))).collect();
                ResolvedGroup { group: g.clone(), members, hub, leads, links, missing }
            })
            .collect()
    }

    /// The groups this agent is a member of.
    pub(super) fn groups_of(&self, rec: &SubagentRecord) -> Vec<ResolvedGroup> {
        let root = self.root_of(&rec.session_key);
        self.resolved_groups(&root).into_iter().filter(|g| g.has(&rec.id)).collect()
    }

    /// The first group both agents are in whose type lets `from` message `to`.
    pub(super) fn group_allowing(&self, from: &SubagentRecord, to: &SubagentRecord) -> Option<String> {
        self.groups_of(from).into_iter().find(|g| g.allows(from, to)).map(|g| g.group.name)
    }

    /// Whether a group makes this agent a lead (a star's hub or a hierarchical lead).
    pub(super) fn group_lead(&self, rec: &SubagentRecord) -> bool {
        self.groups_of(rec).iter().any(|g| g.hub.as_deref() == Some(rec.id.as_str()) || g.is_lead(&rec.id))
    }

    /// The patterns the agent's groups add to its base topology's.
    pub(super) fn group_patterns_for(&self, rec: &SubagentRecord) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for g in self.groups_of(rec) {
            for p in g.patterns() {
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        out
    }

    /// Who a broadcast, topic post, vote or election of `me` reaches for this pattern.
    /// `group` (a name or id) keeps it inside one group; empty = the whole team when the
    /// base topology has the pattern, else the members of every group of `me` that has it.
    pub(super) fn scope_members(&self, me: &SubagentRecord, pattern: &str, group: &str) -> Result<Vec<SubagentRecord>, String> {
        let team = self.team_members(me);
        let mine = self.groups_of(me);
        let group = group.trim();
        if !group.is_empty() {
            let Some(g) = mine.iter().find(|g| g.group.id == group || g.group.name.eq_ignore_ascii_case(group)) else {
                let names: Vec<String> = mine.iter().map(|g| g.group.name.clone()).collect();
                return Err(if names.is_empty() {
                    format!("You are not in a topology group named \"{}\" (you are in none).", group)
                } else {
                    format!("You are not in a topology group named \"{}\". Your groups: {}.", group, names.join(", "))
                });
            };
            if !g.patterns().iter().any(|p| p == pattern) {
                return Err(format!("The {} group ({}) doesn't allow {}.", g.group.name, g.group.topology, pattern));
            }
            return Ok(team.into_iter().filter(|r| g.has(&r.id)).collect());
        }
        // Not in any group, or the base topology has the pattern: the whole team, as before groups.
        if mine.is_empty() || self.base_patterns(me).iter().any(|p| p == pattern) {
            return Ok(team);
        }
        let ids: HashSet<String> =
            mine.iter().filter(|g| g.patterns().iter().any(|p| p == pattern)).flat_map(|g| g.members.iter().map(|m| m.id.clone())).collect();
        Ok(team.into_iter().filter(|r| ids.contains(&r.id)).collect())
    }

    /// One line per group of this agent for its system prompt; empty when it is in none.
    pub(super) fn groups_prompt(&self, rec: &SubagentRecord) -> String {
        let mine = self.groups_of(rec);
        if mine.is_empty() {
            return String::new();
        }
        let lines: Vec<String> = mine
            .iter()
            .map(|g| {
                let others: Vec<String> = g.members.iter().filter(|m| m.id != rec.id).map(|m| m.name.clone()).collect();
                let mut role = String::new();
                if g.hub.as_deref() == Some(rec.id.as_str()) {
                    role = " — you are its hub".into();
                } else if g.is_lead(&rec.id) {
                    role = " — you are a lead".into();
                }
                format!("- {} ({}) with {}{}", g.group.name, g.group.topology, if others.is_empty() { "nobody yet".into() } else { others.join(", ") }, role)
            })
            .collect();
        format!(
            "You are also in these topology groups; each lets you reach its members by its own type:\n{}\nPass group=\"<name>\" to broadcast_team, publish_topic, call_vote or elect_leader to keep it inside one group.",
            lines.join("\n")
        )
    }
}
