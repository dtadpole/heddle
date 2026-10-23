//! The answer shapes the TypeScript server writes, shared by the routes of this crate and of
//! `heddle-web-trajectory`.
//!
//! Ported from `respond` and `readJson` in `src/server/web.ts`: a body is written with one content type and
//! `cache-control: no-store`; JSON answers are `JSON.stringify(value, null, 2)` plus a newline, errors are the
//! compact `{"error":"..."}` plus a newline; a request body is at most 10 MiB, empty means `{}`, and anything
//! that does not parse is a `400` in plain text.

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::js;

/// The content type of every JSON answer — without a charset, as the TypeScript server sends it.
pub const JSON_CONTENT_TYPE: &str = "application/json";

/// The largest request body a route reads, in bytes (`readJson`'s 10 MiB).
pub const MAX_JSON_BODY: usize = 10 * 1024 * 1024;

/// A body with one content type and `cache-control: no-store` — `respond(response, status, type, body)`.
pub fn respond(status: StatusCode, content_type: &str, body: String) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).expect("a content type is a valid header value"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `JSON.stringify(value, null, 2)` plus a newline, as `application/json`.
pub fn json_pretty<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = match serde_json::to_value(value) {
        Ok(value) => js::stringify_pretty(&value),
        Err(error) => {
            tracing::error!(%error, "a JSON answer could not be serialised");
            "null".to_owned()
        }
    };
    respond(status, JSON_CONTENT_TYPE, format!("{body}\n"))
}

/// `JSON.stringify(value)` plus a newline, as `application/json` — the routes that answer compactly
/// (`/api/status`, `/stop`, every error).
pub fn json_compact<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = match serde_json::to_value(value) {
        Ok(value) => js::stringify_compact(&value),
        Err(error) => {
            tracing::error!(%error, "a JSON answer could not be serialised");
            "null".to_owned()
        }
    };
    respond(status, JSON_CONTENT_TYPE, format!("{body}\n"))
}

/// `{"error": message}` plus a newline, compact, as `application/json`.
pub fn error(status: StatusCode, message: &str) -> Response {
    json_compact(status, &json!({ "error": message }))
}

/// Whether `id` is a session id the store could hold: `^session-[0-9a-f-]{36}$`, case-insensitive.
///
/// The id names a directory under the session root, so anything else is refused before it reaches the store.
pub fn is_session_id(id: &str) -> bool {
    const PREFIX: &str = "session-";
    let bytes = id.as_bytes();
    if bytes.len() != PREFIX.len() + 36 {
        return false;
    }
    if !bytes[..PREFIX.len()].eq_ignore_ascii_case(PREFIX.as_bytes()) {
        return false;
    }
    bytes[PREFIX.len()..]
        .iter()
        .all(|byte| byte.is_ascii_hexdigit() || *byte == b'-')
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
        match self {
            BodyRefusal::TooLarge => respond(
                StatusCode::PAYLOAD_TOO_LARGE,
                "text/plain",
                "request too large\n".to_owned(),
            ),
            BodyRefusal::NotJson => respond(
                StatusCode::BAD_REQUEST,
                "text/plain",
                "the body must be JSON\n".to_owned(),
            ),
        }
    }
}

/// A request body read as `readJson` reads it.
///
/// Empty is `{}`; more than [`MAX_JSON_BODY`] is [`BodyRefusal::TooLarge`]; JSON that does not parse is
/// [`BodyRefusal::NotJson`]. A body that parses to something other than an object reads as an empty object, so a
/// field lookup finds nothing rather than failing.
pub fn read_json(body: &[u8]) -> Result<Map<String, Value>, BodyRefusal> {
    if body.len() > MAX_JSON_BODY {
        return Err(BodyRefusal::TooLarge);
    }
    if body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(_) => Err(BodyRefusal::NotJson),
    }
}

/// A string field as the routes read one: present, a string, and non-empty once trimmed — else `None`.
pub fn trimmed_field<'a>(body: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    let value = body.get(name)?.as_str()?;
    let trimmed = js::trim(value);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body_text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("the body fits");
        String::from_utf8(bytes.to_vec()).expect("a UTF-8 body")
    }

    #[test]
    fn a_session_id_is_session_dash_a_uuid_shape() {
        assert!(is_session_id(
            "session-00000000-0000-4000-8000-000000000000"
        ));
        assert!(
            is_session_id("session-ABCDEF01-2345-6789-abcd-ef0123456789"),
            "the guard is case-insensitive"
        );
        assert!(!is_session_id("session-short"), "too short");
        assert!(
            !is_session_id("session-00000000-0000-4000-8000-00000000000g"),
            "not hex"
        );
        assert!(
            !is_session_id("sessions-00000000-0000-4000-8000-000000000000"),
            "wrong prefix"
        );
        assert!(
            !is_session_id("session-00000000-0000-4000-8000-000000000000/"),
            "a slash is never an id"
        );
        assert!(!is_session_id(""));
    }

    #[tokio::test]
    async fn a_response_carries_its_type_and_no_store() {
        let response = respond(StatusCode::OK, "text/plain", "hi\n".to_owned());
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(body_text(response).await, "hi\n");
    }

    #[tokio::test]
    async fn json_answers_are_pretty_and_compact_in_the_servers_two_shapes() {
        let pretty = json_pretty(StatusCode::OK, &json!({"session": "s", "accepted": true}));
        assert_eq!(pretty.headers()[header::CONTENT_TYPE], JSON_CONTENT_TYPE);
        assert_eq!(
            body_text(pretty).await,
            "{\n  \"session\": \"s\",\n  \"accepted\": true\n}\n"
        );

        let compact = json_compact(StatusCode::OK, &json!({"stopped": 0, "session": "s"}));
        assert_eq!(
            body_text(compact).await,
            "{\"stopped\":0,\"session\":\"s\"}\n"
        );
    }

    #[tokio::test]
    async fn an_error_is_the_compact_shape() {
        let response = error(StatusCode::NOT_FOUND, "no session session-1");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"no session session-1\"}\n"
        );
    }

    #[tokio::test]
    async fn a_body_refusal_answers_the_typescript_status_and_sentence() {
        let too_large = BodyRefusal::TooLarge.into_response();
        assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(too_large.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(too_large.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(body_text(too_large).await, "request too large\n");

        let not_json = BodyRefusal::NotJson.into_response();
        assert_eq!(not_json.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_text(not_json).await, "the body must be JSON\n");
    }

    #[test]
    fn reading_a_body_follows_the_ten_mib_empty_and_invalid_rules() {
        assert_eq!(
            read_json(b""),
            Ok(Map::new()),
            "an empty body reads as an empty object"
        );
        assert_eq!(
            read_json(br#"{"endpoint":"scripted"}"#),
            Ok(serde_json::from_str::<Map<String, Value>>(r#"{"endpoint":"scripted"}"#).unwrap())
        );
        assert_eq!(
            read_json(b"[1,2]"),
            Ok(Map::new()),
            "a non-object reads as an empty object"
        );
        assert_eq!(read_json(b"null"), Ok(Map::new()));
        assert_eq!(read_json(b"not json"), Err(BodyRefusal::NotJson));
        assert_eq!(
            read_json(b" "),
            Err(BodyRefusal::NotJson),
            "whitespace is not an empty body"
        );
        let oversized = vec![b'x'; MAX_JSON_BODY + 1];
        assert_eq!(read_json(&oversized), Err(BodyRefusal::TooLarge));
    }

    #[test]
    fn a_trimmed_field_is_present_a_string_and_non_empty() {
        let body = serde_json::from_str::<Map<String, Value>>(
            r#"{"endpoint":"  scripted  ","blank":"  ","number":7,"none":null}"#,
        )
        .unwrap();
        assert_eq!(trimmed_field(&body, "endpoint"), Some("scripted"));
        assert_eq!(trimmed_field(&body, "blank"), None);
        assert_eq!(trimmed_field(&body, "number"), None);
        assert_eq!(trimmed_field(&body, "none"), None);
        assert_eq!(trimmed_field(&body, "missing"), None);
    }
}
