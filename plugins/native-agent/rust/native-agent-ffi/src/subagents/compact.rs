//! Auto-compaction for the coordination state around agents.
//!
//! Transcripts (the main chat and every sub-agent session, forked or not)
//! already compact in the agent loop (`agent_loop::compaction`: shorten tool
//! results, summarise the oldest prefix with the model, then trim). This module
//! covers everything else that grows while a team works and is fed back into a
//! prompt or kept on disk: topic histories, the blackboard, the swarm logs
//! (auctions, votes, debates, elections, rumours, handoffs), inboxes, the
//! reports a gatherer or reviewer reads, request/reply and ask_parent context,
//! and the per-agent comms log.
//!
//! Design (docs/subagents/AUTO_COMPACTION.md):
//! - Synchronous and deterministic: no model call while a lock is held or a
//!   message is in flight. The model-written summary stays in the agent loop.
//! - Fold, never drop silently: what leaves the verbatim window becomes a
//!   `Digest` (count, time span, who, one gist line per item, newest kept),
//!   shown to agents and in the app.
//! - The newest items always stay verbatim (`keep`); compaction starts at a
//!   higher mark (`at`) so it runs in batches, not on every write (hysteresis,
//!   like Claude Code's auto-compact threshold).
//! - Text assembled into a prompt gets a budget; small parts stay whole and the
//!   rest share what is left (water-filling), each cut head + tail at a line.

use super::*;
use std::collections::{BTreeMap, VecDeque};

/// Gist lines a digest keeps (newest win).
const GIST_LINES: usize = 24;
const GIST_CHARS: usize = 140;

/// The compaction settings for a chat's coordination state.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub enabled: bool,
    /// Items kept verbatim after a compaction.
    pub keep: usize,
    /// Compaction runs when a history grows past this.
    pub at: usize,
    /// Characters of coordination text one prompt may carry.
    pub context_chars: usize,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            enabled: true,
            keep: 12,
            at: 30,
            context_chars: 24_000,
        }
    }
}

impl Policy {
    pub const KEEP_RANGE: (u32, u32) = (2, 45);
    pub const AT_RANGE: (u32, u32) = (4, 50);
    pub const CONTEXT_RANGE: (u32, u32) = (2_000, 200_000);

    pub fn new(enabled: bool, keep: u32, at: u32, context_chars: u32) -> Self {
        let keep = keep.clamp(Self::KEEP_RANGE.0, Self::KEEP_RANGE.1) as usize;
        let at = (at.clamp(Self::AT_RANGE.0, Self::AT_RANGE.1) as usize).max(keep + 1);
        Policy {
            enabled,
            keep,
            at,
            context_chars: context_chars.clamp(Self::CONTEXT_RANGE.0, Self::CONTEXT_RANGE.1)
                as usize,
        }
    }
}

/// What a compaction folded away: enough to know it happened, when, who took
/// part and roughly what was said.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Digest {
    pub count: u64,
    pub from_at: i64,
    pub to_at: i64,
    /// Items per author / kind.
    pub by: BTreeMap<String, u64>,
    /// One short line per folded item, newest last.
    pub gist: Vec<String>,
    /// How many compactions fed this digest.
    pub runs: u64,
}

impl Digest {
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn add(&mut self, who: &str, text: &str, at: i64) {
        if self.count == 0 || (at > 0 && at < self.from_at) {
            self.from_at = at;
        }
        self.to_at = self.to_at.max(at);
        self.count += 1;
        *self
            .by
            .entry(if who.is_empty() {
                "?".into()
            } else {
                who.to_string()
            })
            .or_default() += 1;
        let line = one_line(text, GIST_CHARS);
        self.gist.push(if who.is_empty() {
            line
        } else {
            format!("{}: {}", who, line)
        });
        if self.gist.len() > GIST_LINES {
            let extra = self.gist.len() - GIST_LINES;
            self.gist.drain(..extra);
        }
    }

    /// Text for a prompt: one header line and the gist lines.
    pub fn render(&self, what: &str) -> String {
        if self.is_empty() {
            return String::new();
        }
        let who: Vec<String> = self
            .by
            .iter()
            .map(|(k, v)| format!("{} {}", k, v))
            .collect();
        let shown = self.gist.len() as u64;
        let mut out = format!(
            "[{} earlier {} compacted ({}){}]",
            self.count,
            what,
            who.join(", "),
            if shown < self.count {
                format!("; the last {} in brief", shown)
            } else {
                String::new()
            }
        );
        for g in &self.gist {
            out.push_str("\n  - ");
            out.push_str(g);
        }
        out
    }
}

/// The first line of `text`, whitespace collapsed, at most `max` chars.
pub fn one_line(text: &str, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let mut s: String = flat.chars().take(max.saturating_sub(1)).collect();
        s.push('\u{2026}');
        s
    }
}

/// Fold the oldest items of `q` into `digest` once it holds more than
/// `policy.at`, keeping the newest `policy.keep`. `can_fold` keeps open items
/// (a running vote) in place; `gist` gives (who, text, at). Returns how many
/// were folded.
pub fn fold_queue<T>(
    q: &mut VecDeque<T>,
    digest: &mut Digest,
    policy: &Policy,
    can_fold: impl Fn(&T) -> bool,
    gist: impl Fn(&T) -> (String, String, i64),
) -> usize {
    if !policy.enabled || q.len() <= policy.at {
        return 0;
    }
    // The newest `keep` stay verbatim by position; older open items stay too.
    let foldable_zone = q.len() - policy.keep;
    let mut kept = VecDeque::with_capacity(q.len());
    let mut folded = 0;
    let mut i = 0;
    while let Some(item) = q.pop_front() {
        let old = i < foldable_zone;
        i += 1;
        if old && can_fold(&item) {
            let (who, text, at) = gist(&item);
            digest.add(&who, &text, at);
            folded += 1;
        } else {
            kept.push_back(item);
        }
    }
    *q = kept;
    if folded > 0 {
        digest.runs += 1;
    }
    folded
}

/// Cut `text` to `max` chars keeping its head and tail, at line breaks when
/// they are near, with a marker saying how much was left out.
pub fn head_tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let marker_room = 48;
    if max <= marker_room + 20 {
        return one_line(text, max.max(8));
    }
    let room = max - marker_room;
    let head_n = room * 2 / 3;
    let tail_n = room - head_n;
    let snap_back = |end: usize| -> usize {
        // Prefer ending the head at a newline within the last fifth.
        let floor = end - end / 5;
        (floor..end)
            .rev()
            .find(|&i| chars[i] == '\n')
            .map(|i| i + 1)
            .unwrap_or(end)
    };
    let snap_fwd = |start: usize| -> usize {
        let ceil = (start + (chars.len() - start) / 5).min(chars.len());
        (start..ceil)
            .find(|&i| chars[i] == '\n')
            .map(|i| i + 1)
            .unwrap_or(start)
    };
    let h = snap_back(head_n);
    let t = snap_fwd(chars.len() - tail_n);
    let left_out = t.saturating_sub(h);
    let head: String = chars[..h].iter().collect();
    let tail: String = chars[t..].iter().collect();
    format!(
        "{}\n[\u{2026} {} chars compacted \u{2026}]\n{}",
        head.trim_end(),
        left_out,
        tail.trim_start()
    )
}

/// Share `budget` chars among `parts`: parts under the fair share stay whole,
/// the others split what is left equally (water-filling), each cut head+tail.
/// `cap` bounds any one part.
pub fn share_budget(parts: &[String], budget: usize, cap: usize) -> Vec<String> {
    let lens: Vec<usize> = parts.iter().map(|p| p.chars().count().min(cap)).collect();
    let mut alloc = vec![0usize; parts.len()];
    let mut left = budget;
    let mut open: Vec<usize> = (0..parts.len()).collect();
    while !open.is_empty() {
        let share = left / open.len();
        let (small, big): (Vec<usize>, Vec<usize>) = open.iter().partition(|&&i| lens[i] <= share);
        if small.is_empty() {
            for &i in &big {
                alloc[i] = share;
            }
            break;
        }
        for &i in &small {
            alloc[i] = lens[i];
            left -= lens[i];
        }
        open = big;
    }
    parts
        .iter()
        .zip(alloc)
        .map(|(p, n)| {
            if p.chars().count() <= n {
                p.clone()
            } else {
                head_tail(p, n.max(80))
            }
        })
        .collect()
}

/// Fold a list of notes (oldest first) to fit `budget`: the newest stay whole
/// while they fit, the older ones become one compacted note at the front.
pub fn fold_notes(notes: Vec<String>, budget: usize) -> Vec<String> {
    let total: usize = notes.iter().map(|n| n.chars().count()).sum();
    if total <= budget || notes.len() <= 1 {
        return notes
            .into_iter()
            .map(|n| {
                if n.chars().count() > budget {
                    head_tail(&n, budget)
                } else {
                    n
                }
            })
            .collect();
    }
    let digest_room = budget / 4;
    let mut used = 0;
    let mut split = notes.len();
    while split > 0 {
        let c = notes[split - 1].chars().count();
        if used + c > budget - digest_room && split < notes.len() {
            break;
        }
        used += c.min(budget - digest_room);
        split -= 1;
    }
    let mut d = Digest::default();
    for n in &notes[..split] {
        d.add("", n, 0);
    }
    let mut out = Vec::with_capacity(notes.len() - split + 1);
    if !d.is_empty() {
        out.push(head_tail(&d.render("notes"), digest_room.max(200)));
    }
    for n in notes.into_iter().skip(split) {
        out.push(if n.chars().count() > budget - digest_room {
            head_tail(&n, budget - digest_room)
        } else {
            n
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_counts_spans_and_keeps_the_newest_gist() {
        let mut d = Digest::default();
        for i in 0..40 {
            d.add(
                if i % 2 == 0 { "a" } else { "b" },
                &format!("post number {}\nsecond line", i),
                1_000 + i,
            );
        }
        assert_eq!((d.count, d.from_at, d.to_at), (40, 1_000, 1_039));
        assert_eq!(d.by["a"], 20);
        assert_eq!(d.gist.len(), GIST_LINES);
        assert!(d
            .gist
            .last()
            .unwrap()
            .starts_with("b: post number 39 second line"));
        let r = d.render("posts");
        assert!(
            r.starts_with("[40 earlier posts compacted (a 20, b 20); the last 24 in brief]"),
            "{r}"
        );
    }

    #[test]
    fn fold_queue_waits_for_the_mark_keeps_newest_and_open_items() {
        let p = Policy::new(true, 3, 6, 10_000);
        let mut q: VecDeque<(u32, bool)> = (0..6).map(|i| (i, true)).collect();
        let mut d = Digest::default();
        assert_eq!(
            fold_queue(
                &mut q,
                &mut d,
                &p,
                |x| x.1,
                |x| (String::new(), x.0.to_string(), 0)
            ),
            0,
            "not past the mark yet"
        );
        q.push_back((6, true));
        q[1].1 = false; // item 1 is still open
        let n = fold_queue(
            &mut q,
            &mut d,
            &p,
            |x| x.1,
            |x| (String::new(), x.0.to_string(), 0),
        );
        assert_eq!(n, 3, "only closed items older than the newest 3 fold");
        assert_eq!(
            q.iter().map(|x| x.0).collect::<Vec<_>>(),
            vec![1, 4, 5, 6],
            "open item stays, newest 3 stay"
        );
        assert_eq!(d.count, 3);
        let off = Policy {
            enabled: false,
            ..p
        };
        let mut q2: VecDeque<(u32, bool)> = (0..20).map(|i| (i, true)).collect();
        assert_eq!(
            fold_queue(
                &mut q2,
                &mut d,
                &off,
                |x| x.1,
                |x| (String::new(), x.0.to_string(), 0)
            ),
            0
        );
    }

    #[test]
    fn head_tail_keeps_both_ends_and_says_how_much_went() {
        let text: String = (0..400).map(|i| format!("line {}\n", i)).collect();
        let out = head_tail(&text, 600);
        assert!(out.chars().count() <= 600, "{}", out.chars().count());
        assert!(out.starts_with("line 0\n") && out.trim_end().ends_with("line 399"));
        assert!(out.contains("chars compacted"));
        assert_eq!(head_tail("short", 600), "short");
    }

    #[test]
    fn share_budget_keeps_small_parts_whole_and_splits_the_rest() {
        let parts = vec!["x".repeat(100), "y".repeat(5_000), "z".repeat(9_000)];
        let out = share_budget(&parts, 3_100, 6_000);
        assert_eq!(out[0], parts[0], "small part untouched");
        let (b, c) = (out[1].chars().count(), out[2].chars().count());
        assert!(
            b <= 1_500 && c <= 1_500 && b > 1_000 && c > 1_000,
            "{b} {c}"
        );
        let total: usize = out.iter().map(|o| o.chars().count()).sum();
        assert!(total <= 3_100, "{total}");
    }

    #[test]
    fn fold_notes_keeps_the_newest_whole_and_compacts_the_rest() {
        let notes: Vec<String> = (0..30)
            .map(|i| format!("note {} {}", i, "w".repeat(400)))
            .collect();
        let out = fold_notes(notes.clone(), 4_000);
        let total: usize = out.iter().map(|o| o.chars().count()).sum();
        assert!(total <= 4_000 + 200, "{total}");
        assert!(
            out[0].starts_with("[") && out[0].contains("earlier notes compacted"),
            "{}",
            out[0]
        );
        assert_eq!(out.last().unwrap(), notes.last().unwrap());
        assert_eq!(fold_notes(notes[..2].to_vec(), 4_000), notes[..2].to_vec());
    }
}
