//! The downloaded session log: its file name, its header, and its body.
//!
//! Ported from `src/server/log-download.ts` and the `/log` route of `src/server/web.ts`. DSH puts `Download
//! session log` in its session header. The log on disk is zstd frames, so it is served **decoded** — one JSON
//! object per line — and the only free text that reaches the file name is the session's title, which a person
//! types, so it is made safe and the header carries it only in the encoded RFC 6266 `filename*` parameter.

use serde_json::Value;

use heddle_web_composer::js;

use crate::js_json;

/// The name a downloaded log is filed under: the trimmed title with control characters as spaces,
/// `\ / : * ? " < > |` as dashes, whitespace runs collapsed, at most 80 UTF-16 units, leading and trailing dots,
/// spaces and dashes stripped — or the id when nothing usable is left — plus `.jsonl`.
pub fn log_file_name(title: Option<&str>, id: &str) -> String {
    let trimmed = title.map(js::trim).unwrap_or("");
    let source = if !trimmed.is_empty() { trimmed } else { id };
    // Keep letters, digits, spaces and a small set of separators; replace everything else with a dash. A
    // filename is a boundary a person's text should not be able to cross, and `Content-Disposition` is a header
    // where a quote or a newline is a real hazard.
    let mut replaced = String::with_capacity(source.len());
    for c in source.chars() {
        if c.is_ascii_control() || c == '\u{7f}' {
            replaced.push(' ');
        } else if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            replaced.push('-');
        } else {
            replaced.push(c);
        }
    }
    let collapsed = js::collapse_spaces(&replaced);
    let bounded = js::utf16_slice(js::trim(&collapsed), 80);
    let safe = trim_edge_punctuation(bounded);
    let safe = if safe.is_empty() { id } else { safe };
    format!("{safe}.jsonl")
}

/// `.replace(/^[.\s-]+|[.\s-]+$/g, '')`: strip leading and trailing dots, whitespace and dashes.
fn trim_edge_punctuation(text: &str) -> &str {
    let is_edge = |c: char| c == '.' || c == '-' || js::is_space(c);
    let start = text
        .char_indices()
        .find(|(_, c)| !is_edge(*c))
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    let end = text
        .char_indices()
        .rev()
        .find(|(_, c)| !is_edge(*c))
        .map(|(index, c)| index + c.len_utf8())
        .unwrap_or(0);
    if start >= end { "" } else { &text[start..end] }
}

/// `attachment; filename="<id>.jsonl"; filename*=UTF-8''<encodeURIComponent(file_name)>`.
pub fn content_disposition(id: &str, file_name: &str) -> String {
    format!(
        "attachment; filename=\"{id}.jsonl\"; filename*=UTF-8''{}",
        js::encode_uri_component(file_name)
    )
}

/// The body: every event as compact JSON in its written key order, one per line, ending with a newline.
pub fn ndjson(events: &[Value]) -> String {
    let mut body = String::new();
    for event in events {
        body.push_str(&js_json::stringify_compact(event));
        body.push('\n');
    }
    if events.is_empty() {
        body.push('\n');
    }
    body
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_title_becomes_a_safe_file_name_and_a_missing_one_falls_back_to_the_id() {
        assert_eq!(
            log_file_name(Some("a conversation"), "session-1"),
            "a conversation.jsonl",
            "an ordinary title is kept"
        );
        assert_eq!(
            log_file_name(None, "session-1"),
            "session-1.jsonl",
            "no title means the id names the file"
        );
        assert_eq!(
            log_file_name(Some("   "), "session-1"),
            "session-1.jsonl",
            "a blank title is treated as none"
        );
    }

    #[test]
    fn characters_that_would_break_a_path_or_a_header_are_replaced_not_dropped() {
        assert_eq!(log_file_name(Some("a/b:c"), "session-1"), "a-b-c.jsonl");
        let quoted = log_file_name(Some("he said \"no\"\r\nand left"), "session-1");
        assert!(
            !quoted.contains('"') && !quoted.contains('\r') && !quoted.contains('\n'),
            "no quote or line break survives: {quoted:?}"
        );
        for name in [
            log_file_name(Some("../../etc/passwd"), "session-1"),
            log_file_name(Some("..\\..\\windows"), "session-1"),
        ] {
            assert!(
                !name.contains('/') && !name.contains('\\'),
                "no separator in {name}"
            );
            assert!(!name.starts_with('.'), "and no leading dot in {name}");
        }
    }

    #[test]
    fn a_very_long_or_almost_empty_title_still_yields_a_usable_name() {
        let long = log_file_name(Some(&"x".repeat(300)), "session-1");
        assert!(long.len() <= 86, "the name is bounded ({})", long.len());
        assert!(long.ends_with(".jsonl"), "and keeps its extension");
        assert_eq!(
            log_file_name(Some("\u{1}\u{2}"), "session-1"),
            "session-1.jsonl",
            "control characters are whitespace"
        );
        assert_eq!(
            log_file_name(Some("..."), "session-1"),
            "session-1.jsonl",
            "trailing dots are not a name"
        );
        assert_eq!(log_file_name(Some("- - -"), "session-1"), "session-1.jsonl");
    }

    #[test]
    fn the_header_carries_the_id_as_ascii_and_the_title_encoded() {
        let header = content_disposition("session-1", "a conversation.jsonl");
        assert_eq!(
            header,
            "attachment; filename=\"session-1.jsonl\"; filename*=UTF-8''a%20conversation.jsonl"
        );
        let non_ascii = content_disposition("session-1", "会话.jsonl");
        assert!(
            non_ascii.contains("filename*=UTF-8''%E4%BC%9A%E8%AF%9D.jsonl"),
            "a Chinese title travels encoded"
        );
        assert!(!non_ascii.contains('会'), "and never raw in the header");
    }

    #[test]
    fn a_logged_float_comes_back_byte_for_byte() {
        // `JSON.parse` reads a float correctly rounded, so the TypeScript download writes back the bytes it
        // read. serde_json does so only with `float_roundtrip`; without it the first case reads back as
        // `…492` — measured on a live session's timeline position.
        for text in [
            "0.9999551342447491",
            "0.9040877429444507",
            "0.30000000000000004",
            "0.1",
            "5e-324",
            "1.7976931348623157e+308",
        ] {
            let event: Value =
                serde_json::from_str(&format!("{{\"seq\":1,\"x\":{text}}}")).unwrap();
            assert_eq!(
                ndjson(std::slice::from_ref(&event)),
                format!("{{\"seq\":1,\"x\":{text}}}\n"),
                "{text} survives the download unchanged"
            );
        }
    }

    #[test]
    fn a_log_written_with_rust_style_numbers_downloads_as_javascript_writes_it() {
        // The TypeScript route is `JSON.stringify(event)` over what it read, so `1500.0` leaves as `1500` and
        // `1e21` as `1e+21`, whichever build wrote the log.
        let event: Value =
            serde_json::from_str("{\"durationMs\":1500.0,\"big\":1e21,\"n\":7}").unwrap();
        assert_eq!(
            ndjson(&[event]),
            "{\"durationMs\":1500,\"big\":1e+21,\"n\":7}\n"
        );
    }

    #[test]
    fn the_body_is_one_compact_event_per_line_in_written_order() {
        let events = vec![
            json!({"seq": 1, "at": "2026-10-11T10:00:00.000Z", "type": "message", "message": {"role": "user"}}),
            json!({"seq": 2, "type": "assistant/chunk", "chunk": {"type": "done"}}),
        ];
        assert_eq!(
            ndjson(&events),
            "{\"seq\":1,\"at\":\"2026-10-11T10:00:00.000Z\",\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n{\"seq\":2,\"type\":\"assistant/chunk\",\"chunk\":{\"type\":\"done\"}}\n"
        );
        assert_eq!(
            ndjson(&[]),
            "\n",
            "an empty log is still a body with a final newline"
        );
    }
}
