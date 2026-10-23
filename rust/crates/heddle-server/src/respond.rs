//! The response shapes, the JSON body reader and the session-id rule every route shares.
//!
//! The TypeScript server answers through one `respond(status, contentType, body)` with
//! `cache-control: no-store`, writes JSON either pretty (`JSON.stringify(x, null, 2)`) or compact, always
//! followed by a newline, and reads bodies through `readJson`. A feature crate that answers through these
//! helpers answers byte-for-byte as the route it ports did, which is what lets a verifier judge both builds.

use std::path::Path;

use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::Response;
use serde::Serialize;
use serde_json::{Map, Value};

/// The largest JSON body a route reads: 10 MiB, answered `413 request too large` above it.
pub const MAX_JSON_BODY: usize = 10 * 1024 * 1024;

/// `application/json`, pretty-printed with two spaces as `JSON.stringify(body, null, 2)` writes it, plus a
/// newline; `cache-control: no-store`.
pub fn json<T: Serialize + ?Sized>(status: StatusCode, body: &T) -> Response {
    todo!()
}

/// `application/json` on one line, plus a newline; `cache-control: no-store`.
pub fn json_compact<T: Serialize + ?Sized>(status: StatusCode, body: &T) -> Response {
    todo!()
}

/// `text/plain` with the body as given (callers include the trailing newline); `cache-control: no-store`.
pub fn text(status: StatusCode, body: impl Into<String>) -> Response {
    todo!()
}

/// `text/html; charset=utf-8`; `cache-control: no-store`.
pub fn html(status: StatusCode, body: impl Into<String>) -> Response {
    todo!()
}

/// `{"error": message}` compact, the shape every JSON route refuses with.
pub fn error(status: StatusCode, message: impl Into<String>) -> Response {
    todo!()
}

/// `{"error": message, "code": code}` compact, for refusals a client tells apart without parsing prose.
pub fn error_with_code(
    status: StatusCode,
    message: impl Into<String>,
    code: impl Into<String>,
) -> Response {
    todo!()
}

/// `400 {"error": "not a session id"}`.
pub fn not_a_session_id() -> Response {
    todo!()
}

/// `404 {"error": "no session <id>"}`.
pub fn no_session(id: &str) -> Response {
    todo!()
}

/// `503 {"error": "this profile does not load the <plugin> plugin"}` — a service the boot did not load.
pub fn plugin_missing(plugin: &str) -> Response {
    todo!()
}

/// `404 not found` in plain text, the answer for an authenticated request no route claims.
pub fn not_found() -> Response {
    todo!()
}

/// `401 unauthorized` in plain text, the answer for an unauthenticated `/api` request.
pub fn unauthorized() -> Response {
    todo!()
}

/// A JSON request body, read the way `readJson` reads it.
///
/// An empty body is `{}`; a body over [`MAX_JSON_BODY`] answers `413 request too large`; a body that is not
/// JSON answers `400 the body must be JSON` (both `text/plain`). JSON that is not an object (an array, a
/// number, `null`) reads as `{}`, which is what property reads on it gave the TypeScript routes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JsonBody(pub Map<String, Value>);

impl JsonBody {
    /// The field as a string, when it is one.
    pub fn str(&self, key: &str) -> Option<&str> {
        todo!()
    }

    /// The field as a string with surrounding whitespace trimmed, `None` when absent, not a string, or
    /// empty after trimming.
    pub fn trimmed(&self, key: &str) -> Option<&str> {
        todo!()
    }

    /// The field as a non-empty string, untrimmed.
    pub fn non_empty(&self, key: &str) -> Option<&str> {
        todo!()
    }

    /// The field as a boolean, when it is one.
    pub fn bool(&self, key: &str) -> Option<bool> {
        todo!()
    }

    /// The field as a number, when it is one.
    pub fn number(&self, key: &str) -> Option<f64> {
        todo!()
    }

    /// The raw field.
    pub fn get(&self, key: &str) -> Option<&Value> {
        todo!()
    }
}

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        todo!()
    }
}

/// A session id: `session-` followed by 36 characters of hex digits and dashes, case-insensitive.
///
/// The id is a directory name under the session root, so anything else is refused **before** it reaches a
/// store — `..%2F..%2Fetc%2Fpasswd` must be a `400`, not a path.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionId(String);

impl SessionId {
    /// The id when it has the shape, `None` otherwise.
    pub fn parse(raw: &str) -> Option<Self> {
        todo!()
    }

    pub fn as_str(&self) -> &str {
        todo!()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        todo!()
    }
}

/// The `{id}` segment of a `/api/sessions/{id}/…` route, percent-decoded and validated; a malformed id
/// answers [`not_a_session_id`].
///
/// **Every route under `/api/sessions/` names that segment `{id}`**: the router refuses two routes that
/// name the same segment differently, so a feature crate mounting `/api/sessions/{id}/log` must use `{id}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPath(pub SessionId);

impl<S: Send + Sync> FromRequestParts<S> for SessionPath {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        todo!()
    }
}

/// The type a document may embed inline, or `None` for anything a browser should not run in this origin.
///
/// Deny by default: images, audio, video, fonts and PDF by extension (case-insensitive); everything else is
/// served as a download (`application/octet-stream` with `content-disposition: attachment`).
pub fn inline_content_type(path: &Path) -> Option<&'static str> {
    todo!()
}

/// Serve a file's bytes as `/api/raw` and `/api/uploads/<leaf>` do: the inline type when there is one and
/// `content-disposition: inline`, otherwise `application/octet-stream` and
/// `attachment; filename="<name without quotes>"`; `content-length` and `cache-control: no-store`.
pub fn file_bytes(path: &Path, download_name: &str, bytes: Vec<u8>) -> Response {
    todo!()
}
