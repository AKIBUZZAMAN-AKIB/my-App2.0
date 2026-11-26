//! Deterministic slot supersession (no model call).
//!
//! Two current decisions (or two current facts, or two current preferences)
//! that state a value for the same subject cannot both be in force: the one
//! from the later turn replaces the earlier one. This is the code-side
//! safety net for a summarizer that recorded both values but did not link
//! them (the real-provider runs left "server port 8742" and "server port
//! 9150" without a `superseded` link, or never recorded the old one).
//!
//! "The same subject" is decided conservatively, because merging two
//! unrelated decisions would silently retire one that still holds (spec
//! §5.6: sharing words is never enough):
//!
//! 1. Both carry an explicit `key` (the summarizer names the subject:
//!    "server port", "database") and the normalized keys are equal.
//!    Different keys never match, whatever the texts say.
//! 2. Otherwise (one or both have no key), the two texts must be identical
//!    once ONE trailing value token is removed from each, that token must
//!    hold a digit ("server port 8742" / "server port 9150", "Python
//!    version 3.11" / "Python version 3.12"), and what remains must have at
//!    least two words. "Phase 1" / "Phase 2" (one word left), "port 8080
//!    for the API" / "port 9090 for admin" (value not last, texts differ)
//!    and "deadline 20 December" / "deadline 5 January" (last token has no
//!    digit) never match.
//!
//! The later turn wins only when it is strictly later; a tie on the turn
//! is ambiguous and changes nothing (logged). Items or decisions with an
//! unknown turn (0, the earlier memory format) never take part.
//!
//! Precedent: temporal knowledge graphs invalidate an older fact only when
//! a newer one is about the same entity pair, and give the newer one
//! priority (Zep/Graphiti, arXiv:2501.13956, `resolve_edge_contradictions`);
//! Graphiti's prompt forbids treating facts as contradicted from recency or
//! shared entities alone. The key/template rule is the deterministic,
//! model-free counterpart of that candidate restriction.

/// Token separators besides whitespace (Bengali danda, quotes, dashes).
fn is_sep(c: char) -> bool {
    c.is_whitespace() || c.is_ascii_punctuation() || "\u{0964}\u{0965}\u{060C}\u{3001}\u{201C}\u{201D}\u{2018}\u{2019}\u{2026}\u{2013}\u{2014}".contains(c)
}

/// A key as compared: lowercase words joined by one space.
pub fn norm_key(key: &str) -> String {
    key.split(is_sep)
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Words of a text with punctuation trimmed from their ends (a value such
/// as "3.11" or "kakatua-17.lan" keeps its inner punctuation).
fn tokens(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| is_sep(c)).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

fn has_digit(w: &str) -> bool {
    w.chars().any(|c| c.is_numeric())
}

/// The text with its trailing value removed, when the rule applies:
/// (words before the value, the value).
pub fn value_template(text: &str) -> Option<(String, String)> {
    let t = tokens(text);
    let (value, rest) = t.split_last()?;
    if !has_digit(value) || rest.len() < 2 {
        return None;
    }
    Some((rest.join(" "), value.clone()))
}

/// Whether two entries clearly state a value for the same subject; returns
/// the subject as written in the log.
pub fn same_slot(a_key: &str, a_text: &str, b_key: &str, b_text: &str) -> Option<String> {
    let (ka, kb) = (norm_key(a_key), norm_key(b_key));
    if !ka.is_empty() && !kb.is_empty() {
        return if ka == kb {
            Some(format!("key \"{}\"", ka))
        } else {
            None
        };
    }
    let (ta, va) = value_template(a_text)?;
    let (tb, vb) = value_template(b_text)?;
    if ta == tb && va != vb {
        Some(format!("\"{} …\"", ta))
    } else {
        None
    }
}

/// One entry taking part: (key, text, turn).
pub struct Entry<'a> {
    pub key: &'a str,
    pub text: &'a str,
    pub turn: u32,
}

/// For every entry that a strictly later entry about the same subject
/// replaces: (old index, new index, subject). The replacement is the next
/// newer entry, so a chain 8080 → 8742 → 9150 keeps every link. An entry
/// whose match shares its turn, or whose next newer turn is shared by two
/// matches, is ambiguous: it is listed in `ambiguous` and left alone.
pub fn plan(
    entries: &[Entry<'_>],
    ambiguous: &mut Vec<(usize, usize)>,
) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    for (i, a) in entries.iter().enumerate() {
        if a.turn == 0 {
            continue;
        }
        let mut best: Option<(usize, String)> = None;
        let mut tie = None;
        for (j, b) in entries.iter().enumerate() {
            if i == j || b.turn == 0 {
                continue;
            }
            let Some(label) = same_slot(a.key, a.text, b.key, b.text) else {
                continue;
            };
            if b.turn == a.turn {
                tie = Some(j);
                break;
            }
            if b.turn < a.turn {
                continue;
            }
            match &best {
                Some((k, _)) if entries[*k].turn < b.turn => {}
                Some((k, _)) if entries[*k].turn == b.turn => tie = Some(j),
                _ => best = Some((j, label)),
            }
        }
        if let Some(j) = tie {
            ambiguous.push((i, j));
            continue;
        }
        if let Some((j, label)) = best {
            out.push((i, j, label));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_values_of_the_same_subject_match() {
        assert!(same_slot("", "সার্ভার পোর্ট 8742", "", "সার্ভার পোর্ট 9150").is_some());
        assert!(same_slot("", "Server port: 8080", "", "server port 9150.").is_some());
        assert!(same_slot("", "পোর্ট নম্বর ৮০৮০", "", "পোর্ট নম্বর ৯১৫০").is_some());
        assert!(same_slot("", "Python version 3.11", "", "Python version 3.12").is_some());
    }

    #[test]
    fn shared_words_alone_never_match() {
        for (a, b) in [
            ("Phase 1", "Phase 2"),
            ("port 8080 for the API", "port 9090 for admin"),
            ("API port 8080", "admin port 9090"),
            ("deadline 20 December", "deadline 5 January"),
            ("ডেডলাইন ২০ ডিসেম্বর", "ডেডলাইন ৫ জানুয়ারি"),
            (
                "use SQLite for the cache",
                "use SQLite for the app database",
            ),
            ("server port 9150", "server port 9150"),
            ("staging server kakatua-17.lan", "staging server port 9150"),
        ] {
            assert!(same_slot("", a, "", b).is_none(), "{a} / {b}");
        }
    }

    #[test]
    fn explicit_keys_decide_when_both_have_one() {
        assert!(same_slot(
            "Server Port",
            "use 8742",
            "server  port",
            "move to 9150 now"
        )
        .is_some());
        assert!(
            same_slot("api port", "port 8080", "admin port", "port 9090").is_none(),
            "different keys never match"
        );
        assert!(
            same_slot("server port", "server port 8742", "", "server port 9150").is_some(),
            "one key: the text rule"
        );
    }

    #[test]
    fn the_next_newer_entry_replaces_and_ties_change_nothing() {
        let e = |key, text, turn| Entry { key, text, turn };
        let list = [
            e("", "server port 8080", 2),
            e("", "server port 9150", 6),
            e("", "server port 8742", 4),
            e("", "database SQLite", 3),
        ];
        let mut amb = Vec::new();
        let mut p = plan(&list, &mut amb);
        p.sort();
        assert_eq!(
            p.iter().map(|(a, b, _)| (*a, *b)).collect::<Vec<_>>(),
            vec![(0, 2), (2, 1)]
        );
        assert!(amb.is_empty());
        let tie = [e("", "server port 8080", 5), e("", "server port 9150", 5)];
        assert!(plan(&tie, &mut amb).is_empty());
        assert_eq!(amb.len(), 2);
        let unknown = [e("", "server port 8080", 0), e("", "server port 9150", 5)];
        assert!(plan(&unknown, &mut Vec::new()).is_empty());
    }
}
