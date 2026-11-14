//! Token-aware file reads.
//!
//! `read_file` (workspace) and `device__folder_read` (shared folders, including
//! the extracted text of DOCX/PPTX/XLSX/ODT/ODS/ODP) page by bytes or by
//! characters, not by tokens. One page of Bangla text or a 200 KB folder page
//! can be 50k+ tokens, which on a small context window pushes the rest of the
//! conversation out (or makes the next request fail).
//!
//! This module sits where a tool result is handed to the model (see
//! `agent_loop::run_agent_turn`). It never blocks a read. When the text in a
//! result is larger than the per-read token limit it:
//!
//!  * cuts the text at the last line boundary that fits (inside one very long
//!    line it falls back to a whitespace or character boundary, so the cut is
//!    always UTF-8 safe and always makes progress);
//!  * recomputes the offset the tool needs for the next part, in the tool's own
//!    unit: UTF-8 bytes for `read_file` and folder text files, UTF-16 code units
//!    for extracted document text (the JS side slices a JS string);
//!  * returns the first part with the total size, estimated tokens, the part
//!    returned and the next offset, and tells the model to summarise this part,
//!    then read the next one, and repeat.
//!
//! The limit for one read is the smallest of 25k tokens, a quarter of the
//! context window and half of the budget still free, and never below 1k.
//! The same policy is used by Claude Code (≈25k token read cap, then
//! offset/limit paging) and OpenHands (truncate, then `view_range`).

use serde_json::{json, Map, Value};

/// Hard ceiling for one read, whatever the window.
pub const MAX_READ_TOKENS: usize = 25_000;
/// Floor: a read must always be able to make progress.
pub const MIN_READ_TOKENS: usize = 1_000;

const UNTRUSTED_OPEN: &str = "<untrusted_folder_file>\n";
const UNTRUSTED_CLOSE: &str = "\n</untrusted_folder_file>";

/// Tools whose results this module may cut.
pub fn applies_to(tool_name: &str) -> bool {
    matches!(tool_name, "read_file" | "device__folder_read" | "folder_read")
}

/// Per-read token limit: min(25k, window/4, remaining/2), at least 1k.
///
/// `context_window` is the model's verified window when the catalog knows it;
/// without one the transcript budget stands in for it. `used` is what the
/// transcript (including results already added in this step) costs now.
pub fn read_limit(context_window: Option<u64>, context_budget: usize, used: usize) -> usize {
    let window = context_window
        .map(|w| w.min(usize::MAX as u64) as usize)
        .unwrap_or(context_budget);
    let remaining = context_budget.saturating_sub(used);
    MAX_READ_TOKENS
        .min(window / 4)
        .min(remaining / 2)
        .max(MIN_READ_TOKENS)
}

/// What a cut did, for the event log and the tests.
#[derive(Debug, Clone, PartialEq)]
pub struct CutReport {
    pub limit_tokens: usize,
    pub chunk_tokens: usize,
    pub returned_tokens: usize,
    pub start: u64,
    pub next_offset: u64,
    pub total: u64,
    /// "bytes", "utf16" or "items".
    pub unit: &'static str,
}

impl CutReport {
    pub fn to_json(&self, tool: &str) -> Value {
        json!({
            "tool": tool,
            "limitTokens": self.limit_tokens,
            "chunkTokens": self.chunk_tokens,
            "returnedTokens": self.returned_tokens,
            "start": self.start,
            "nextOffset": self.next_offset,
            "total": self.total,
            "unit": self.unit,
        })
    }
}

/// Fit one tool result into `limit` tokens. Results that already fit, errors
/// and results of another shape come back unchanged with `None`.
pub fn fit_tool_result(
    tool_name: &str,
    content: &str,
    is_error: bool,
    limit: usize,
    count: &dyn Fn(&str) -> usize,
) -> (String, Option<CutReport>) {
    if is_error || !applies_to(tool_name) {
        return (content.to_string(), None);
    }
    let fitted = match tool_name {
        "read_file" => fit_read_file(content, limit, count),
        _ => fit_folder_read(content, limit, count),
    };
    match fitted {
        Some((text, report)) => (text, Some(report)),
        None => (content.to_string(), None),
    }
}

// ── Other large outputs: web fetch/search, grep, shell ──────────────────────
//
// These tools have no offset parameter of their own. The whole result is
// stored first (turn_memory::tool_results, by result ID), so a cut here loses
// nothing: the note tells the model how to read the next part of the stored
// result, or to ask a question about all of it.

/// Tools whose outputs are fitted by `fit_large_output`.
pub fn applies_to_output(tool_name: &str) -> bool {
    if applies_to(tool_name) {
        return false;
    }
    let n = tool_name.to_ascii_lowercase();
    matches!(n.as_str(), "web_fetch" | "grep_files" | "execute_command" | "git_diff" | "git_log" | "search_documents")
        || ["search", "fetch", "grep", "shell", "command", "exec", "browse", "scrape", "crawl"].iter().any(|k| n.contains(k))
}

const TEXT_FIELDS: [&str; 8] = ["body", "content", "stdout", "output", "text", "markdown", "result", "stderr"];
const LIST_FIELDS: [&str; 5] = ["matches", "results", "items", "hits", "documents"];

/// The text a stored result is paged by: the largest main text field of a
/// JSON object result, else the whole result. Returns (field, text).
pub fn primary_text(content: &str) -> (Option<String>, String) {
    if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(content) {
        let best = TEXT_FIELDS
            .iter()
            .filter_map(|k| o.get(*k).and_then(Value::as_str).map(|t| (*k, t)))
            .max_by_key(|(_, t)| t.len());
        if let Some((k, t)) = best {
            if t.len() * 2 >= content.len() {
                return (Some(k.to_string()), t.to_string());
            }
        }
    }
    (None, content.to_string())
}

fn output_note(result_id: &str, limit: usize, start: u64, next: u64, total: u64, estimated: u64) -> String {
    format!(
        "This output is larger than one read can hold in your context (about {} tokens per read; the whole output is about {} tokens). You have bytes {}\u{2013}{} of {}. \
         The complete output is stored as result #{}: call recall_turns with result_id \"{}\" and offset {} for the next part (repeat until it says complete), \
         or with result_id and a question to search all of it. Summarise this part for yourself before reading on.",
        limit, estimated, start, next, total, result_id, result_id, next
    )
}

/// Fit a large web/grep/shell output into `limit` tokens. The cut keeps JSON
/// valid: the main text field is cut at a line boundary, or a list field
/// keeps the items that fit. Returns `None` when it already fits.
pub fn fit_large_output(content: &str, is_error: bool, limit: usize, count: &dyn Fn(&str) -> usize, result_id: &str) -> Option<(String, CutReport)> {
    if is_error && content.len() < 64 * 1024 {
        return None;
    }
    let chunk_tokens = count(content);
    if chunk_tokens <= limit {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(content).ok();
    if let Some(Value::Object(obj)) = &parsed {
        let (field, text) = primary_text(content);
        if let Some(field) = field {
            let rest = {
                let mut o = obj.clone();
                o.remove(&field);
                count(&Value::Object(o).to_string())
            };
            let room = limit.saturating_sub(rest + 200).max(limit / 4).max(200);
            let cut = cut_point(&text, room, count);
            let total = text.len() as u64;
            let estimated = estimate_total_tokens(count(&text[..cut]).max(1), cut as u64, total);
            let mut out = obj.clone();
            out.insert(field.clone(), Value::String(text[..cut].to_string()));
            out.insert("truncated".into(), Value::Bool(true));
            out.insert("resultId".into(), json!(result_id));
            out.insert("readBudget".into(), json!({"limitTokens": limit, "field": field, "returned": format!("bytes 0\u{2013}{} of {} ({}%)", cut, total, percent(cut as u64, total)), "nextOffset": cut}));
            out.insert("note".into(), Value::String(output_note(result_id, limit, 0, cut as u64, total, estimated)));
            let s = Value::Object(out).to_string();
            let returned_tokens = count(&s);
            return Some((s, CutReport { limit_tokens: limit, chunk_tokens, returned_tokens, start: 0, next_offset: cut as u64, total, unit: "bytes" }));
        }
        if let Some((k, items)) = LIST_FIELDS.iter().find_map(|k| obj.get(*k).and_then(Value::as_array).map(|a| (*k, a))) {
            let mut kept = Vec::new();
            let mut used = 200;
            for it in items {
                let c = count(&it.to_string());
                if used + c > limit && !kept.is_empty() {
                    break;
                }
                used += c;
                kept.push(it.clone());
                if used > limit {
                    break;
                }
            }
            let mut out = obj.clone();
            let n = kept.len();
            out.insert(k.to_string(), Value::Array(kept));
            out.insert("truncated".into(), Value::Bool(true));
            out.insert("resultId".into(), json!(result_id));
            out.insert(
                "note".into(),
                Value::String(format!(
                    "Showing {} of {} {} (about {} tokens per read). The complete output is stored as result #{}: call recall_turns with result_id \"{}\" and a question to search all of it, or with offset to page through the raw text.",
                    n,
                    items.len(),
                    k,
                    limit,
                    result_id,
                    result_id
                )),
            );
            let s = Value::Object(out).to_string();
            let returned_tokens = count(&s);
            return Some((s, CutReport { limit_tokens: limit, chunk_tokens, returned_tokens, start: 0, next_offset: n as u64, total: items.len() as u64, unit: "items" }));
        }
    }
    let room = limit.saturating_sub(250).max(200);
    let cut = cut_point(content, room, count);
    let total = content.len() as u64;
    let estimated = estimate_total_tokens(count(&content[..cut]).max(1), cut as u64, total);
    let s = format!("{}\n\n[{}]", &content[..cut], output_note(result_id, limit, 0, cut as u64, total, estimated));
    let returned_tokens = count(&s);
    Some((s, CutReport { limit_tokens: limit, chunk_tokens, returned_tokens, start: 0, next_offset: cut as u64, total, unit: "bytes" }))
}

// ── read_file ────────────────────────────────────────────────────────────────

fn fit_read_file(content: &str, limit: usize, count: &dyn Fn(&str) -> usize) -> Option<(String, CutReport)> {
    let value: Value = serde_json::from_str(content).ok()?;
    let obj = value.as_object()?;
    if obj.contains_key("error") {
        return None;
    }
    let text = obj.get("content")?.as_str()?;
    let chunk_tokens = count(text);
    if chunk_tokens <= limit {
        return None;
    }
    let cut = cut_point(text, limit, count);
    let kept = &text[..cut];
    let returned_tokens = count(kept);
    let start = obj.get("offsetBytes").and_then(Value::as_u64).unwrap_or(0);
    let total = obj
        .get("fileBytes")
        .and_then(Value::as_u64)
        .unwrap_or(start + text.len() as u64);
    let next = start + cut as u64;
    let estimated_total = estimate_total_tokens(chunk_tokens, text.len() as u64, total);

    let mut out = Map::new();
    out.insert("content".into(), Value::String(kept.to_string()));
    for key in ["fileBytes", "modifiedMs"] {
        if let Some(v) = obj.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    out.insert("offsetBytes".into(), json!(start));
    out.insert("endBytes".into(), json!(next));
    out.insert("nextOffsetBytes".into(), json!(next));
    out.insert("truncated".into(), Value::Bool(true));
    out.insert(
        "readBudget".into(),
        json!({
            "limitTokens": limit,
            "returnedTokens": returned_tokens,
            "estimatedFileTokens": estimated_total,
            "returned": format!("bytes {}\u{2013}{} of {} ({}%)", start, next, total, percent(next, total)),
            "cutAt": if kept.ends_with('\n') { "line" } else { "character" },
        }),
    );
    out.insert(
        "note".into(),
        Value::String(format!(
            "This file is larger than one read can hold in your context (about {} tokens per read; the whole file is about {} tokens). \
             You have bytes {}\u{2013}{} of {}. Write a short summary of this part for yourself now, then call read_file with \
             offset_bytes={} for the next part, and repeat until nextOffsetBytes is null. Do not re-read parts you have already summarised.",
            limit, estimated_total, start, next, total, next
        )),
    );
    let report = CutReport {
        limit_tokens: limit,
        chunk_tokens,
        returned_tokens,
        start,
        next_offset: next,
        total,
        unit: "bytes",
    };
    Some((Value::Object(out).to_string(), report))
}

// ── device__folder_read ──────────────────────────────────────────────────────
//
// The MCP result is flattened in lib.rs::normalize_mcp_result to:
//   <header>\n<untrusted_folder_file>\n<body>\n</untrusted_folder_file>[\nShowing …]\n<structuredContent JSON>

fn fit_folder_read(content: &str, limit: usize, count: &dyn Fn(&str) -> usize) -> Option<(String, CutReport)> {
    let (rest, last_line) = content.rsplit_once('\n')?;
    let structured: Value = serde_json::from_str(last_line).ok()?;
    let mut structured = structured.as_object()?.clone();
    let kind = structured.get("kind").and_then(Value::as_str)?.to_string();
    if kind != "text" && kind != "document" {
        return None;
    }
    let start = structured.get("offset").and_then(Value::as_u64).unwrap_or(0);
    let open = rest.find(UNTRUSTED_OPEN)?;
    let body_start = open + UNTRUSTED_OPEN.len();
    let close = rest.rfind(UNTRUSTED_CLOSE)?;
    if close < body_start {
        return None;
    }
    let header = &rest[..open];
    let body = &rest[body_start..close];
    let chunk_tokens = count(body);
    if chunk_tokens <= limit {
        return None;
    }
    let cut = cut_point(body, limit, count);
    let kept = &body[..cut];
    let returned_tokens = count(kept);

    let document = kind == "document";
    // Lengths in the tool's own unit, with the wrapper escaping undone.
    let unit_len = |s: &str| -> u64 {
        let raw = if document { s.encode_utf16().count() } else { s.len() };
        raw.saturating_sub(escape_overhead(s)) as u64
    };
    let next = start + unit_len(kept);
    let chunk_units = unit_len(body);
    let total = if document {
        structured.get("totalChars").and_then(Value::as_u64)
    } else {
        structured.get("size").and_then(Value::as_u64)
    }
    .unwrap_or(start + chunk_units);
    let estimated_total = estimate_total_tokens(chunk_tokens, chunk_units, total);
    let what = if document { "characters" } else { "bytes" };

    structured.insert("end".into(), json!(next));
    structured.insert("eof".into(), Value::Bool(false));
    structured.insert("nextOffset".into(), json!(next));
    structured.insert(
        "readBudget".into(),
        json!({
            "limitTokens": limit,
            "returnedTokens": returned_tokens,
            "estimatedFileTokens": estimated_total,
            "unit": if document { "utf16" } else { "bytes" },
        }),
    );
    let note = format!(
        "Showing {what} {start}\u{2013}{next} of {total} ({pct}%), about {returned_tokens} tokens; the whole file is about {estimated_total} tokens, \
         more than one read can hold in your context (about {limit} tokens per read). Write a short summary of this part for yourself now, \
         then call folder_read again with offset {next} for the next part, and repeat until eof. Do not re-read parts you have already summarised.",
        pct = percent(next, total)
    );
    let text = format!(
        "{header}{UNTRUSTED_OPEN}{kept}{UNTRUSTED_CLOSE}\n{note}\n{}",
        Value::Object(structured)
    );
    let report = CutReport {
        limit_tokens: limit,
        chunk_tokens,
        returned_tokens,
        start,
        next_offset: next,
        total,
        unit: if document { "utf16" } else { "bytes" },
    };
    Some((text, report))
}

/// The folder tools escape `<untrusted_*>` look-alikes inside file text
/// (`<` → `&lt;`, `>` → `&gt;`), adding three units per escaped bracket. The
/// file itself does not contain them, so offsets must not count them.
fn escape_overhead(s: &str) -> usize {
    if !s.contains("&lt;") {
        return 0;
    }
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?i)&lt;\s*/?\s*untrusted_[a-z_]+.*?&gt;").expect("valid regex"));
    re.find_iter(s)
        .map(|m| 3 * (m.as_str().matches("&lt;").count() + m.as_str().matches("&gt;").count()))
        .sum()
}

// ── cutting ──────────────────────────────────────────────────────────────────

/// Largest prefix of `text` that fits `limit` tokens, ending at a line break.
/// When not even the first line fits, cut inside it at the last whitespace (or
/// any character boundary). Always returns at least one whole character.
pub fn cut_point(text: &str, limit: usize, count: &dyn Fn(&str) -> usize) -> usize {
    if text.is_empty() || count(text) <= limit {
        return text.len();
    }
    let breaks: Vec<usize> = text
        .match_indices('\n')
        .map(|(i, _)| i + 1)
        .filter(|&i| i < text.len())
        .collect();
    // Binary search the last line break whose prefix fits.
    let (mut lo, mut hi) = (0usize, breaks.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if count(&text[..breaks[mid]]) <= limit {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo > 0 {
        return breaks[lo - 1];
    }
    // The first line alone is over the limit: cut inside it.
    let line_end = breaks.first().copied().unwrap_or(text.len());
    let line = &text[..line_end];
    let bounds: Vec<usize> = line.char_indices().map(|(i, c)| i + c.len_utf8()).collect();
    let (mut lo, mut hi) = (0usize, bounds.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if count(&line[..bounds[mid]]) <= limit {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let end = if lo == 0 { bounds[0] } else { bounds[lo - 1] };
    // Prefer to end after whitespace when that keeps most of the part.
    if let Some(ws) = line[..end].rfind(char::is_whitespace) {
        let after = ws + line[ws..].chars().next().map(char::len_utf8).unwrap_or(1);
        if after >= end / 2 && after > 0 {
            return after;
        }
    }
    end
}

fn estimate_total_tokens(chunk_tokens: usize, chunk_units: u64, total_units: u64) -> u64 {
    if chunk_units == 0 {
        return chunk_tokens as u64;
    }
    ((chunk_tokens as f64) * (total_units.max(chunk_units) as f64) / (chunk_units as f64)).ceil() as u64
}

fn percent(part: u64, total: u64) -> u64 {
    if total == 0 {
        100
    } else {
        (part.saturating_mul(100) / total).min(100)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::TokenMeter;

    /// One token per four bytes, like a rough English estimate; deterministic.
    fn quarter(s: &str) -> usize {
        s.len().div_ceil(4)
    }

    fn bangla_lines(n: usize) -> String {
        (0..n).map(|i| format!("আমার সোনার বাংলা, আমি তোমায় ভালোবাসি — লাইন {i}\n")).collect()
    }

    #[test]
    fn limit_is_the_smallest_of_the_three_with_a_floor() {
        // Big window, lots free: the 25k ceiling wins.
        assert_eq!(read_limit(Some(1_000_000), 900_000, 0), 25_000);
        // A quarter of a 32k window.
        assert_eq!(read_limit(Some(32_000), 28_000, 0), 8_000);
        // Half of what is left.
        assert_eq!(read_limit(Some(200_000), 180_000, 170_000), 5_000);
        // Never below 1k, even when the budget is spent.
        assert_eq!(read_limit(Some(8_000), 4_000, 4_000), 1_000);
        // No catalog window: the budget stands in for it.
        assert_eq!(read_limit(None, 40_000, 0), 10_000);
    }

    #[test]
    fn small_results_and_errors_pass_through_unchanged() {
        let small = json!({"content": "hello\n", "fileBytes": 6, "offsetBytes": 0, "nextOffsetBytes": null, "truncated": false}).to_string();
        assert_eq!(fit_tool_result("read_file", &small, false, 1_000, &quarter), (small.clone(), None));
        let err = json!({"error": "Failed to read file"}).to_string();
        assert_eq!(fit_tool_result("read_file", &err, false, 1, &quarter).1, None);
        assert_eq!(fit_tool_result("read_file", &"x".repeat(10_000), true, 1, &quarter).1, None);
        assert_eq!(fit_tool_result("write_file", &"x".repeat(10_000), false, 1, &quarter).1, None);
    }

    #[test]
    fn read_file_is_cut_at_a_line_boundary_with_a_utf8_next_offset() {
        let text = bangla_lines(400);
        let start = 1_000u64;
        let file_bytes = start + text.len() as u64 + 5_000;
        let result = json!({"content": text, "fileBytes": file_bytes, "offsetBytes": start, "nextOffsetBytes": start + text.len() as u64, "truncated": true}).to_string();
        let (out, report) = fit_tool_result("read_file", &result, false, 2_000, &quarter);
        let report = report.expect("cut");
        let v: Value = serde_json::from_str(&out).unwrap();
        let kept = v["content"].as_str().unwrap();
        assert!(kept.ends_with('\n'), "cut at a line boundary");
        assert!(quarter(kept) <= 2_000);
        assert!(text.starts_with(kept));
        // The next line would not have fitted.
        let next_line_end = text[kept.len()..].find('\n').unwrap() + kept.len() + 1;
        assert!(quarter(&text[..next_line_end]) > 2_000);
        let next = v["nextOffsetBytes"].as_u64().unwrap();
        assert_eq!(next, start + kept.len() as u64);
        assert_eq!(report.next_offset, next);
        assert!(text.is_char_boundary(kept.len()));
        assert_eq!(v["truncated"], true);
        assert_eq!(v["fileBytes"].as_u64().unwrap(), file_bytes);
        assert!(v["readBudget"]["estimatedFileTokens"].as_u64().unwrap() > report.chunk_tokens as u64);
        let note = v["note"].as_str().unwrap();
        assert!(note.contains(&format!("offset_bytes={next}")));
        assert!(note.contains("summary"));
    }

    #[test]
    fn paging_with_the_returned_offsets_covers_the_whole_file_exactly_once() {
        // Simulate read_file + middleware over a whole Bangla file.
        let file = bangla_lines(3_000);
        let bytes = file.as_bytes();
        let mut offset = 0usize;
        let mut rebuilt = String::new();
        let mut reads = 0;
        while offset < bytes.len() {
            let end = (offset + 50_000).min(bytes.len());
            let mut end = end;
            while !file.is_char_boundary(end) {
                end -= 1;
            }
            let chunk = &file[offset..end];
            let next = if end < bytes.len() { Some(end) } else { None };
            let result = json!({"content": chunk, "fileBytes": bytes.len(), "offsetBytes": offset, "nextOffsetBytes": next, "truncated": next.is_some()}).to_string();
            let (out, _) = fit_tool_result("read_file", &result, false, 3_000, &quarter);
            let v: Value = serde_json::from_str(&out).unwrap();
            rebuilt.push_str(v["content"].as_str().unwrap());
            match v["nextOffsetBytes"].as_u64() {
                Some(n) => {
                    assert!(n as usize > offset, "progress");
                    offset = n as usize;
                }
                None => break,
            }
            reads += 1;
            assert!(reads < 1_000);
        }
        assert_eq!(rebuilt, file);
    }

    #[test]
    fn one_huge_line_is_cut_at_a_character_boundary_and_still_progresses() {
        let line = "বাংলা".repeat(20_000); // no newline, 3 bytes per char
        let cut = cut_point(&line, 1_000, &quarter);
        assert!(cut > 0 && cut < line.len());
        assert!(line.is_char_boundary(cut));
        assert!(quarter(&line[..cut]) <= 1_000);
        // A single character over the limit still returns that character.
        assert_eq!(cut_point("অ", 0, &quarter), "অ".len());
        // Whitespace is preferred inside a long line.
        let words = "word ".repeat(5_000);
        let cut = cut_point(&words, 1_000, &quarter);
        assert!(words[..cut].ends_with(' '));
    }

    fn folder_result(body: &str, structured: Value, more: &str) -> String {
        // What lib.rs::normalize_mcp_result makes of the bridge's folderResult.
        format!("Docs/notes.txt (1.2 MB):\n<untrusted_folder_file>\n{body}\n</untrusted_folder_file>{more}\n{structured}")
    }

    #[test]
    fn folder_text_files_get_a_byte_offset_and_keep_their_wrapper() {
        let body = bangla_lines(500);
        let structured = json!({"folder": {"id": "f1"}, "path": "notes.txt", "size": 1_200_000, "kind": "text", "offset": 0, "end": body.len(), "eof": false});
        let content = folder_result(&body, structured, &format!("\nShowing bytes 0\u{2013}{} of 1200000. Call again with offset {} for more.", body.len(), body.len()));
        let (out, report) = fit_tool_result("device__folder_read", &content, false, 2_500, &quarter);
        let report = report.expect("cut");
        assert!(out.starts_with("Docs/notes.txt (1.2 MB):\n<untrusted_folder_file>\n"));
        let kept = &out[out.find(UNTRUSTED_OPEN).unwrap() + UNTRUSTED_OPEN.len()..out.rfind(UNTRUSTED_CLOSE).unwrap()];
        assert!(kept.ends_with('\n'));
        assert!(quarter(kept) <= 2_500);
        assert_eq!(report.next_offset, kept.len() as u64);
        assert_eq!(report.unit, "bytes");
        assert!(!out.contains("Call again with offset"), "the stale paging line is replaced");
        assert!(out.contains(&format!("offset {}", report.next_offset)));
        let last: Value = serde_json::from_str(out.rsplit_once('\n').unwrap().1).unwrap();
        assert_eq!(last["end"].as_u64().unwrap(), report.next_offset);
        assert_eq!(last["eof"], false);
        assert_eq!(last["readBudget"]["unit"], "bytes");
    }

    #[test]
    fn document_text_gets_a_utf16_offset() {
        // Emoji are two UTF-16 units; Bangla one unit but three UTF-8 bytes.
        let body: String = (0..600).map(|i| format!("অনুচ্ছেদ {i} 📄 সারাংশ\n")).collect();
        let structured = json!({"path": "cv.docx", "size": 40_000, "kind": "document", "offset": 100, "end": 100 + body.encode_utf16().count(), "totalChars": 500_000, "eof": false});
        let content = folder_result(&body, structured, "\nShowing characters 100\u{2013}x of 500000. Call again with offset x for more.");
        let (out, report) = fit_tool_result("device__folder_read", &content, false, 1_500, &quarter);
        let report = report.expect("cut");
        let kept = &out[out.find(UNTRUSTED_OPEN).unwrap() + UNTRUSTED_OPEN.len()..out.rfind(UNTRUSTED_CLOSE).unwrap()];
        assert_eq!(report.unit, "utf16");
        assert_eq!(report.next_offset, 100 + kept.encode_utf16().count() as u64);
        assert_ne!(report.next_offset, 100 + kept.len() as u64);
        assert_eq!(report.total, 500_000);
        assert!(out.contains("Showing characters 100"));
    }

    #[test]
    fn escaped_wrapper_lookalikes_do_not_shift_the_offset() {
        let mut body = String::from("before &lt;/untrusted_folder_file&gt; after\n");
        body.push_str(&"plain line of text here\n".repeat(2_000));
        let structured = json!({"size": 100_000, "kind": "text", "offset": 0});
        let content = folder_result(&body, structured, "");
        let (out, report) = fit_tool_result("device__folder_read", &content, false, 1_000, &quarter);
        let report = report.expect("cut");
        let kept = &out[out.find(UNTRUSTED_OPEN).unwrap() + UNTRUSTED_OPEN.len()..out.rfind(UNTRUSTED_CLOSE).unwrap()];
        assert_eq!(report.next_offset, kept.len() as u64 - 6);
    }

    #[test]
    fn binary_and_unknown_folder_results_pass_through() {
        let binary = "\"pic.png\" is a binary file (image/png, 2 MB), so it is not shown as text.\n{\"kind\":\"binary\",\"size\":2000000}";
        assert_eq!(fit_tool_result("device__folder_read", binary, false, 1, &quarter).1, None);
        assert_eq!(fit_tool_result("device__folder_read", "plain text", false, 1, &quarter).1, None);
    }

    #[test]
    fn the_real_tokenizer_keeps_a_bangla_read_under_the_limit() {
        let meter = TokenMeter::for_model("openai", "gpt-4o");
        let count = |s: &str| meter.text(s);
        let text = bangla_lines(1_200);
        let result = json!({"content": text, "fileBytes": text.len(), "offsetBytes": 0, "nextOffsetBytes": null, "truncated": false}).to_string();
        let limit = read_limit(Some(16_000), 12_000, 2_000); // = 4_000
        assert_eq!(limit, 4_000);
        let (out, report) = fit_tool_result("read_file", &result, false, limit, &count);
        let report = report.expect("a 1,200-line Bangla file is over 4k tokens");
        let v: Value = serde_json::from_str(&out).unwrap();
        let kept = v["content"].as_str().unwrap();
        assert!(meter.text(kept) <= limit);
        assert!(report.returned_tokens > limit / 2, "most of the budget is used");
        assert!(kept.ends_with('\n'));
    }

    fn tk(s: &str) -> usize {
        s.len() / 4 + 1
    }

    #[test]
    fn web_grep_and_shell_outputs_get_the_same_budget() {
        for name in ["web_fetch", "grep_files", "execute_command", "web_search", "device__web_fetch", "mcp__brave__search"] {
            assert!(applies_to_output(name), "{}", name);
        }
        for name in ["read_file", "device__folder_read", "write_file", "memory_save"] {
            assert!(!applies_to_output(name), "{}", name);
        }
    }

    #[test]
    fn a_large_fetch_body_is_cut_with_valid_json_and_a_way_to_read_the_rest() {
        let body = "পৃষ্ঠার লেখা line\n".repeat(50_000);
        let content = serde_json::json!({"url": "https://x.test", "status": 200, "body": body}).to_string();
        let (out, rep) = fit_large_output(&content, false, 2_000, &tk, "R7").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["url"], "https://x.test");
        assert_eq!(v["truncated"], true);
        assert_eq!(v["resultId"], "R7");
        let kept = v["body"].as_str().unwrap();
        assert!(body.starts_with(kept) && kept.ends_with('\n'), "cut at a line, characters intact");
        assert_eq!(rep.next_offset as usize, kept.len());
        assert!(v["note"].as_str().unwrap().contains("result_id \"R7\" and offset"));
        assert!(tk(&out) <= 2_000 + 300);
        assert!(fit_large_output("{\"body\":\"small\"}", false, 2_000, &tk, "R1").is_none());
    }

    #[test]
    fn a_large_match_list_keeps_whole_items_and_plain_shell_text_is_cut_at_a_line() {
        let items: Vec<Value> = (0..5_000).map(|i| serde_json::json!({"file": format!("src/f{}.rs", i), "line": i, "text": "TODO fix this"})).collect();
        let content = serde_json::json!({"matches": items, "count": 5_000}).to_string();
        let (out, rep) = fit_large_output(&content, false, 3_000, &tk, "R3").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let n = v["matches"].as_array().unwrap().len();
        assert!(n > 10 && n < 5_000);
        assert_eq!((rep.unit, rep.next_offset as usize, rep.total), ("items", n, 5_000));
        assert!(v["note"].as_str().unwrap().contains(&format!("Showing {} of 5000 matches", n)));
        let shell = "build output line\n".repeat(40_000);
        let (out, _) = fit_large_output(&shell, false, 1_500, &tk, "R4").unwrap();
        let (head, note) = out.split_once("\n\n[").unwrap();
        assert!(shell.starts_with(head) && head.ends_with("line\n"));
        assert!(note.contains("result #R4"));
    }
}
