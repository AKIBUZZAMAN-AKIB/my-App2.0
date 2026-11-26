//! "Always allow" scoped to one chat: the tool runs without asking in that
//! chat and in every sub-agent started from it (at any depth), and still asks
//! everywhere else. Kept in session_allows.json next to the registry.

use super::*;

pub(crate) const SESSION_ALLOWS_FILE: &str = "session_allows.json";
/// Chats remembered; the oldest entries go first.
const MAX_CHATS: usize = 200;

impl SubagentManager {
    /// Allow `tool` without asking in chat `chat_key` and its sub-agents.
    pub fn allow_tool_in_chat(&self, chat_key: &str, tool: &str) -> Vec<String> {
        let (chat_key, tool) = (chat_key.trim(), tool.trim());
        if chat_key.is_empty() || tool.is_empty() {
            return Vec::new();
        }
        let mut map = self.session_allows.lock().unwrap();
        let list = map.entry(chat_key.to_string()).or_default();
        if !list.iter().any(|t| t == tool) {
            list.push(tool.to_string());
        }
        let out = list.clone();
        if map.len() > MAX_CHATS {
            let extra: Vec<String> = map.keys().take(map.len() - MAX_CHATS).cloned().collect();
            for k in extra {
                if k != chat_key {
                    map.remove(&k);
                }
            }
        }
        fs_write_json(&self.state_dir.join(SESSION_ALLOWS_FILE), &*map);
        out
    }

    /// Remove one tool (or all, when `tool` is None) from a chat's allows.
    pub fn revoke_tool_in_chat(&self, chat_key: &str, tool: Option<&str>) -> Vec<String> {
        let mut map = self.session_allows.lock().unwrap();
        let out = match tool {
            Some(t) => {
                let list = map.entry(chat_key.to_string()).or_default();
                list.retain(|x| x != t);
                list.clone()
            }
            None => {
                map.remove(chat_key);
                Vec::new()
            }
        };
        map.retain(|_, v| !v.is_empty());
        fs_write_json(&self.state_dir.join(SESSION_ALLOWS_FILE), &*map);
        out
    }

    pub fn chat_allows(&self, chat_key: &str) -> Vec<String> {
        self.session_allows
            .lock()
            .unwrap()
            .get(chat_key)
            .cloned()
            .unwrap_or_default()
    }

    /// Whether `tool` may run without asking in `session_key`: a chat, or a
    /// sub-agent session whose chat allowed it.
    ///
    /// An allow can also be scoped to one agent (`allowTool` with
    /// `scope: "agent"`, kept under its own session key): it covers that agent
    /// and every agent below it, and nobody else.
    pub fn chat_allows_tool(&self, session_key: &str, tool: &str) -> bool {
        let mut keys = vec![session_key.to_string(), self.root_of(session_key)];
        // The agents above it, up to the chat.
        let mut cur = self.record_by_session(session_key);
        let mut hops = 0;
        while let Some(r) = cur {
            if hops > 16 {
                break;
            }
            keys.push(r.parent_session_key.clone());
            cur = self.record_by_session(&r.parent_session_key);
            hops += 1;
        }
        let map = self.session_allows.lock().unwrap();
        keys.iter().any(|k| {
            map.get(k)
                .map(|l| l.iter().any(|t| t == tool))
                .unwrap_or(false)
        })
    }
}
