//! One guard for every send between agents (unified plan, Phase 2): direct
//! messages, broadcasts and topics (`guard_send`), and an agent's post in a
//! group room. The same pause, pair and send-rule limits apply everywhere.

use super::*;
use super::channels::{HOP_WINDOW_MS, PAIR_WINDOW_MS};

impl SubagentManager {
    /// Check whether `from` may send now and count the send. Returns the
    /// hop count the message travels with.
    ///
    /// - `to`: the receiving agent (pair limit); `None` for one-to-many.
    /// - `room`: `Some("group:<id>")` for a post in a group room. A room has
    ///   its own wake caps and budget (its rules), so the chat's hop chain
    ///   and message cap do not apply there; the sender's home chat pause,
    ///   the pair limit and the agent's send rules do. Call it once without
    ///   `to`, then once per mentioned agent.
    /// - `reply`: answering skips the send-rate and pair limits (it keeps a
    ///   conversation from deadlocking).
    pub(super) fn guard(&self, from: &SubagentRecord, to: Option<&SubagentRecord>, room: Option<&str>, reply: bool) -> Result<u32, String> {
        let root = self.root_of(&from.session_key);
        let eff = self.effective_comms(&root);
        if eff.paused {
            return Err("The user has paused messages between the agents of this chat. Carry on with your own task and report to your parent.".into());
        }
        let now = now_ms();
        let in_room = room.is_some();
        let hop = if in_room {
            1
        } else {
            let rt = self.swarm_rt.lock().unwrap();
            rt.hops.get(&from.id).filter(|(_, at)| now - at < HOP_WINDOW_MS).map(|(h, _)| *h).unwrap_or(0) + 1
        };
        if !in_room && !reply && hop > eff.max_hops {
            return Err(format!(
                "This message would be hop {} of a chain of agent messages; the limit is {}. Stop relaying and finish your task with what you have.",
                hop, eff.max_hops
            ));
        }
        if !in_room && eff.max_messages > 0 && self.read_chat(&root, |c| c.message_count) >= eff.max_messages as u64 {
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
                        let where_ = if in_room { " (group mentions count too)" } else { "" };
                        return Err(format!(
                            "You have sent {} {} messages in 10 minutes, the most allowed between two agents{where_}. Stop the back-and-forth and decide.",
                            q.len(),
                            to.name
                        ));
                    }
                    q.push_back(now);
                }
            }
            // A room post checks the sender's send rules once (the call
            // without `to`), then the pair limit per mentioned agent.
            if !in_room || to.is_none() {
                self.check_send_rules(from)?;
            }
        } else if self.settings().comms_paused {
            return Err("The user has paused messages between agents. Carry on with your own task and report to your parent.".into());
        }
        if !in_room {
            self.with_chat(&root, |c| c.message_count += 1);
        }
        Ok(hop.min(eff.max_hops.max(1)))
    }
}
