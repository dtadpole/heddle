//! The downloaded session log: its file name, its header, and its body.
//!
//! Ported from `src/server/log-download.ts` and the `/log` route of `src/server/web.ts`. DSH puts `Download
//! session log` in its session header. The log on disk is zstd frames, so it is served **decoded** — one JSON
//! object per line — and the only free text that reaches the file name is the session's title, which a person
//! types, so it is made safe and the header carries it only in the encoded RFC 6266 `filename*` parameter.

use serde_json::Value;

/// The name a downloaded log is filed under: the trimmed title with control characters as spaces,
/// `\ / : * ? " < > |` as dashes, whitespace runs collapsed, at most 80 UTF-16 units, leading and trailing dots,
/// spaces and dashes stripped — or the id when nothing usable is left — plus `.jsonl`.
pub fn log_file_name(title: Option<&str>, id: &str) -> String {
    let _ = (title, id);
    todo!("log_file_name")
}

/// `attachment; filename="<id>.jsonl"; filename*=UTF-8''<encodeURIComponent(file_name)>`.
pub fn content_disposition(id: &str, file_name: &str) -> String {
    let _ = (id, file_name);
    todo!("content_disposition")
}

/// The body: every event as compact JSON in its written key order, one per line, ending with a newline.
pub fn ndjson(events: &[Value]) -> String {
    let _ = events;
    todo!("ndjson")
}
