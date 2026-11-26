//! Edit and retry history of a sub-agent's chat, kept across reloads.
//!
//! `edit` and `regenerate` answer again from an earlier user message, so the
//! engine's transcript is cut back there and the old reply would be gone for
//! good. Before the cut the whole old transcript is kept here as a version.
//! The app merges the current transcript and the kept versions into one tree
//! (shared beginnings become one path, each difference a sibling), so the
//! `‹ 1/2 ›` switcher still works after a reload or an app restart.
//!
//! Continuing from an older version first makes it the current transcript
//! (`restore_branch`): the current one is kept as a version in its place, so
//! nothing is ever lost by switching. At most `MAX_BRANCHES` versions are kept
//! per sub-agent; the oldest goes first. Deleting the sub-agent (or only its
//! chat) deletes them too.

use super::*;

pub(super) const MAX_BRANCHES: usize = 20;
const BRANCH_DIR: &str = "branches";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub id: String,
    /// 0-based user message the versions differ from.
    pub turn: usize,
    /// edit | regenerate | restore
    pub reason: String,
    pub created_at: i64,
    /// The whole transcript of that version.
    pub messages: Vec<Message>,
}

fn safe_file_part(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

impl SubagentManager {
    fn branches_path(&self, id: &str) -> PathBuf {
        self.state_dir
            .join(BRANCH_DIR)
            .join(format!("{}.json", safe_file_part(id)))
    }

    /// Kept versions of a sub-agent's chat, oldest first.
    pub fn branches(&self, id: &str) -> Vec<Branch> {
        fs_read_json::<Vec<Branch>>(&self.branches_path(id)).unwrap_or_default()
    }

    fn write_branches(&self, id: &str, list: &[Branch]) {
        let path = self.branches_path(id);
        if list.is_empty() {
            let _ = std::fs::remove_file(&path);
            return;
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        fs_write_json(&path, &list);
    }

    /// Keep `messages` (a whole transcript) as a version. Identical copies
    /// and empty transcripts are not kept twice.
    pub(super) fn archive_branch(
        &self,
        id: &str,
        turn: usize,
        messages: Vec<Message>,
        reason: &str,
    ) -> Option<String> {
        if messages.is_empty() {
            return None;
        }
        let mut list = self.branches(id);
        let key = transcript_key(&messages);
        if list.iter().any(|b| transcript_key(&b.messages) == key) {
            return None;
        }
        let seq = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let branch_id = format!("v{}-{}", now_ms(), seq);
        list.push(Branch {
            id: branch_id.clone(),
            turn,
            reason: reason.to_string(),
            created_at: now_ms(),
            messages,
        });
        while list.len() > MAX_BRANCHES {
            list.remove(0);
        }
        self.write_branches(id, &list);
        Some(branch_id)
    }

    pub(super) fn remove_branches(&self, id: &str) {
        let _ = std::fs::remove_file(self.branches_path(id));
    }

    /// Make kept version `branch_id` the current transcript; the current one
    /// is kept as a version in its place. Not while it runs.
    pub fn restore_branch(&self, id: &str, branch_id: &str) -> Result<SubagentRecord, String> {
        let rec = self
            .get(id)
            .ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        if rec.is_active() {
            return Err("It is still running. Stop it first.".into());
        }
        let mut list = self.branches(id);
        let pos = list
            .iter()
            .position(|b| b.id == branch_id)
            .ok_or_else(|| format!("There is no kept version {}.", branch_id))?;
        let chosen = list.remove(pos);
        let current = self.runner.load_messages(&rec.session_key);
        let turn = first_difference_turn(&current, &chosen.messages);
        self.write_branches(id, &list);
        if !current.is_empty() {
            self.archive_branch(id, turn, current, "restore");
        }
        let done = RunDone {
            messages: chosen.messages,
            model: rec.model.clone().unwrap_or_default(),
            provider: rec.provider.clone().unwrap_or_default(),
            usage: None,
        };
        let tools_json = serde_json::to_string(&rec.tools).unwrap_or_else(|_| "[]".into());
        self.runner.save(
            &rec.session_key,
            &done,
            rec.started_at,
            rec.max_steps,
            &tools_json,
        );
        self.append_log(
            id,
            "subagent.branch_restored",
            &rec,
            &json!({ "branchId": branch_id, "turn": turn }),
        );
        Ok(rec)
    }
}

/// The user message (0-based, counted like `user_turns`) where two
/// transcripts first differ.
pub(super) fn first_difference_turn(a: &[Message], b: &[Message]) -> usize {
    let same = a
        .iter()
        .zip(b.iter())
        .take_while(|(x, y)| same_message(x, y))
        .count();
    SubagentManager::user_turns(&a[..same.min(a.len())]).len()
}

fn same_message(a: &Message, b: &Message) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}

fn transcript_key(messages: &[Message]) -> String {
    serde_json::to_string(messages).unwrap_or_default()
}
