//! The answer shapes the TypeScript server writes, shared by the routes of this crate and of
//! `heddle-web-trajectory`.
//!
//! Ported from `respond` and `readJson` in `src/server/web.ts`: a body is written with one content type and
//! `cache-control: no-store`; JSON answers are `JSON.stringify(value, null, 2)` plus a newline, errors are the
//! compact `{"error":"..."}` plus a newline; a request body is at most 10 MiB, empty means `{}`, and anything
//! that does not parse is a `400` in plain text.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};

/// The content type of every JSON answer — without a charset, as the TypeScript server sends it.
pub const JSON_CONTENT_TYPE: &str = "application/json";

/// The largest request body a route reads, in bytes (`readJson`'s 10 MiB).
pub const MAX_JSON_BODY: usize = 10 * 1024 * 1024;

/// A body with one content type and `cache-control: no-store` — `respond(response, status, type, body)`.
pub fn respond(status: StatusCode, content_type: &str, body: String) -> Response {
    let _ = (status, content_type, body);
    todo!("respond")
}

/// `JSON.stringify(value, null, 2)` plus a newline, as `application/json`.
pub fn json_pretty<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let _ = (status, value);
    todo!("json_pretty")
}

/// `JSON.stringify(value)` plus a newline, as `application/json` — the routes that answer compactly
/// (`/api/status`, `/stop`, every error).
pub fn json_compact<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let _ = (status, value);
    todo!("json_compact")
}

/// `{"error": message}` plus a newline, compact, as `application/json`.
pub fn error(status: StatusCode, message: &str) -> Response {
    let _ = (status, message);
    todo!("error")
}

/// Whether `id` is a session id the store could hold: `^session-[0-9a-f-]{36}$`, case-insensitive.
///
/// The id names a directory under the session root, so anything else is refused before it reaches the store.
pub fn is_session_id(id: &str) -> bool {
    let _ = id;
    todo!("is_session_id")
}

/// Why a request body was refused before any route looked at it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyRefusal {
    /// More than [`MAX_JSON_BODY`] bytes: `413 text/plain "request too large\n"`.
    TooLarge,
    /// Not JSON: `400 text/plain "the body must be JSON\n"`.
    NotJson,
}

impl IntoResponse for BodyRefusal {
    fn into_response(self) -> Response {
        todo!("BodyRefusal::into_response")
    }
}

/// A request body read as `readJson` reads it.
///
/// Empty is `{}`; more than [`MAX_JSON_BODY`] is [`BodyRefusal::TooLarge`]; JSON that does not parse is
/// [`BodyRefusal::NotJson`]. A body that parses to something other than an object reads as an empty object, so a
/// field lookup finds nothing rather than failing.
pub fn read_json(body: &[u8]) -> Result<Map<String, Value>, BodyRefusal> {
    let _ = body;
    todo!("read_json")
}

/// A string field as the routes read one: present, a string, and non-empty once trimmed — else `None`.
pub fn trimmed_field<'a>(body: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    let _ = (body, name);
    todo!("trimmed_field")
}
