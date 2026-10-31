//! The response shapes, the JSON body reader and the session-id rule every route shares.
//!
//! The TypeScript server answers through one `respond(status, contentType, body)` with
//! `cache-control: no-store`, writes JSON either pretty (`JSON.stringify(x, null, 2)`) or compact, always
//! followed by a newline, and reads bodies through `readJson`. A feature crate that answers through these
//! helpers answers byte-for-byte as the route it ported did, which is what lets a verifier judge both builds.

use std::path::{Path, PathBuf};

use axum::body::{Body, to_bytes};
use axum::extract::{FromRequest, FromRequestParts, Path as AxumPath, Request};
use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use axum::http::request::Parts;
use axum::response::Response;
use serde::Serialize;
use serde_json::{Map, Value};

/// The largest JSON body a route reads: 10 MiB, answered `413 request too large` above it.
pub const MAX_JSON_BODY: usize = 10 * 1024 * 1024;

/// Build one response with the headers every route carries: the type and `no-store`.
fn response(status: StatusCode, content_type: &'static str, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header("cache-control", "no-store")
        .body(body.into())
        .expect("a response builder with static headers")
}

/// The compact one-line JSON of `body`, followed by a newline.
fn compact_line<T: Serialize + ?Sized>(body: &T) -> String {
    format!(
        "{}\n",
        serde_json::to_string(body).expect("a serializable response body")
    )
}

/// `application/json`, pretty-printed with two spaces as `JSON.stringify(body, null, 2)` writes it, plus a
/// newline; `cache-control: no-store`.
pub fn json<T: Serialize + ?Sized>(status: StatusCode, body: &T) -> Response {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(body).expect("a serializable response body")
    );
    response(status, "application/json", text)
}

/// `application/json` with a body a service already wrote (its trailing newline included); `cache-control: no-store`.
pub fn raw_json(status: StatusCode, body: String) -> Response {
    response(status, "application/json", body)
}

/// `application/json` on one line, plus a newline; `cache-control: no-store`.
pub fn json_compact<T: Serialize + ?Sized>(status: StatusCode, body: &T) -> Response {
    response(status, "application/json", compact_line(body))
}

/// `text/plain` with the body as given (callers include the trailing newline); `cache-control: no-store`.
pub fn text(status: StatusCode, body: impl Into<String>) -> Response {
    response(status, "text/plain", body.into())
}

/// `text/html; charset=utf-8`; `cache-control: no-store`.
pub fn html(status: StatusCode, body: impl Into<String>) -> Response {
    response(status, "text/html; charset=utf-8", body.into())
}

/// `{"error": message}` compact, the shape every JSON route refuses with.
pub fn error(status: StatusCode, message: impl Into<String>) -> Response {
    let message = message.into();
    let text = format!(
        "{{\"error\":{}}}\n",
        serde_json::to_string(&message).expect("a string serializes")
    );
    response(status, "application/json", text)
}

/// `{"error": message, "code": code}` compact, for refusals a client tells apart without parsing prose.
pub fn error_with_code(
    status: StatusCode,
    message: impl Into<String>,
    code: impl Into<String>,
) -> Response {
    let message = message.into();
    let code = code.into();
    let text = format!(
        "{{\"error\":{},\"code\":{}}}\n",
        serde_json::to_string(&message).expect("a string serializes"),
        serde_json::to_string(&code).expect("a string serializes")
    );
    response(status, "application/json", text)
}

/// `400 {"error": "not a session id"}`.
pub fn not_a_session_id() -> Response {
    error(StatusCode::BAD_REQUEST, "not a session id")
}

/// `404 {"error": "no session <id>"}`.
pub fn no_session(id: &str) -> Response {
    error(StatusCode::NOT_FOUND, format!("no session {id}"))
}

/// `503 {"error": "this profile does not load the <plugin> plugin"}` — a service the boot did not load.
pub fn plugin_missing(plugin: &str) -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        format!("this profile does not load the {plugin} plugin"),
    )
}

/// `500 internal error: <message>` in plain text — what the TypeScript server's catch-all writes when a
/// route throws, so a failure a route cannot answer more precisely still says what went wrong.
pub fn internal_error(message: impl std::fmt::Display) -> Response {
    text(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("internal error: {message}\n"),
    )
}

/// `404 not found` in plain text, the answer for an authenticated request no route claims.
pub fn not_found() -> Response {
    text(StatusCode::NOT_FOUND, "not found\n")
}

/// `401 unauthorized` in plain text, the answer for an unauthenticated `/api` request.
pub fn unauthorized() -> Response {
    text(StatusCode::UNAUTHORIZED, "unauthorized\n")
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
        self.0.get(key).and_then(Value::as_str)
    }

    /// The field as a string with surrounding whitespace trimmed, `None` when absent, not a string, or
    /// empty after trimming.
    pub fn trimmed(&self, key: &str) -> Option<&str> {
        self.str(key)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    /// The field as a non-empty string, untrimmed.
    pub fn non_empty(&self, key: &str) -> Option<&str> {
        self.str(key).filter(|value| !value.is_empty())
    }

    /// The field as a boolean, when it is one.
    pub fn bool(&self, key: &str) -> Option<bool> {
        self.0.get(key).and_then(Value::as_bool)
    }

    /// The field as a number, when it is one.
    pub fn number(&self, key: &str) -> Option<f64> {
        self.0.get(key).and_then(Value::as_f64)
    }

    /// The raw field.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }
}

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let _ = state;
        let bytes = match to_bytes(request.into_body(), MAX_JSON_BODY).await {
            Ok(bytes) => bytes,
            Err(_) => return Err(text(StatusCode::PAYLOAD_TOO_LARGE, "request too large\n")),
        };
        if bytes.is_empty() {
            return Ok(JsonBody(Map::new()));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => Ok(JsonBody(map)),
            // A non-object reads as `{}`: property reads on an array, a number or `null` gave the
            // TypeScript routes nothing to read.
            Ok(_) => Ok(JsonBody(Map::new())),
            Err(_) => Err(text(StatusCode::BAD_REQUEST, "the body must be JSON\n")),
        }
    }
}

/// A canonical absolute path, as `canonicalPath` in `src/paths.ts` returns it: the `realpath` when
/// the path exists, the lexically resolved absolute path when it does not.
///
/// Routes canonicalize **before** asking a workspace whether it owns a path: `/a/b/../etc` and a
/// symlinked spelling are not a different folder, and a containment check on the raw string is a
/// containment check a caller can walk out of. A relative path is resolved from the server's working
/// directory, `.` is dropped and `..` pops but never above the root.
pub fn canonical_path(path: impl AsRef<Path>) -> PathBuf {
    use std::path::Component;

    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(name) => normalized.push(name),
        }
    }
    std::fs::canonicalize(&normalized).unwrap_or(normalized)
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
        let rest = raw.strip_prefix("session-")?;
        if rest.len() == 36 && rest.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            Some(SessionId(raw.to_owned()))
        } else {
            None
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
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
        let AxumPath(raw) = AxumPath::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_| not_a_session_id())?;
        SessionId::parse(&raw)
            .map(SessionPath)
            .ok_or_else(not_a_session_id)
    }
}

/// The type a document may embed inline, or `None` for anything a browser should not run in this origin.
///
/// Deny by default: images, audio, video, fonts and PDF by extension (case-insensitive); everything else is
/// served as a download (`application/octet-stream` with `content-disposition: attachment`).
pub fn inline_content_type(path: &Path) -> Option<&'static str> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)?;
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// Serve a file's bytes as `/api/raw` and `/api/uploads/<leaf>` do: the inline type when there is one and
/// `content-disposition: inline`, otherwise `application/octet-stream` and
/// `attachment; filename="<name without quotes>"`; `content-length` and `cache-control: no-store`.
pub fn file_bytes(path: &Path, download_name: &str, bytes: Vec<u8>) -> Response {
    let inline = inline_content_type(path);
    let filename = download_name.replace('"', "");
    let disposition = if inline.is_some() {
        "inline".to_owned()
    } else {
        format!("attachment; filename=\"{filename}\"")
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, inline.unwrap_or("application/octet-stream"))
        .header("content-length", bytes.len().to_string())
        .header("content-disposition", disposition)
        .header("cache-control", "no-store")
        .body(Body::from(bytes))
        .expect("a response builder with static headers")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    async fn body_of(response: Response) -> (StatusCode, String, String) {
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            content_type,
            String::from_utf8(bytes.to_vec()).unwrap(),
        )
    }

    #[tokio::test]
    async fn json_is_pretty_and_newline_terminated() {
        let (status, content_type, body) =
            body_of(json(StatusCode::OK, &serde_json::json!({"a": 1, "b": [2]}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "application/json");
        assert_eq!(body, "{\n  \"a\": 1,\n  \"b\": [\n    2\n  ]\n}\n");
    }

    #[tokio::test]
    async fn json_compact_is_one_line_and_newline_terminated() {
        let (_, _, body) = body_of(json_compact(
            StatusCode::OK,
            &serde_json::json!({"ok": true}),
        ))
        .await;
        assert_eq!(body, "{\"ok\":true}\n");
    }

    #[tokio::test]
    async fn text_html_and_errors_carry_the_shared_headers() {
        let (status, content_type, body) =
            body_of(text(StatusCode::NOT_FOUND, "not found\n")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(content_type, "text/plain");
        assert_eq!(body, "not found\n");

        let (_, content_type, body) = body_of(html(StatusCode::UNAUTHORIZED, "<p>x</p>")).await;
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert_eq!(body, "<p>x</p>");

        let (status, _, body) = body_of(error(StatusCode::BAD_REQUEST, "nope")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, "{\"error\":\"nope\"}\n");

        let (_, _, body) = body_of(error_with_code(
            StatusCode::CONFLICT,
            "refused",
            "session/steer-unavailable",
        ))
        .await;
        assert_eq!(
            body,
            "{\"error\":\"refused\",\"code\":\"session/steer-unavailable\"}\n"
        );
    }

    #[tokio::test]
    async fn the_named_refusals_are_the_typescript_sentences() {
        assert_eq!(
            body_of(not_a_session_id()).await.2,
            "{\"error\":\"not a session id\"}\n"
        );
        assert_eq!(
            body_of(no_session("session-x")).await.2,
            "{\"error\":\"no session session-x\"}\n"
        );
        assert_eq!(
            body_of(plugin_missing("workspace")).await.2,
            "{\"error\":\"this profile does not load the workspace plugin\"}\n"
        );
        assert_eq!(body_of(not_found()).await.2, "not found\n");
        assert_eq!(body_of(unauthorized()).await.2, "unauthorized\n");
    }

    #[test]
    fn json_body_reads_the_fields_routes_read() {
        let body = JsonBody(
            serde_json::from_str::<Map<String, Value>>(
                r#"{"s":"  x  ","empty":"","b":true,"n":1.5,"null":null,"obj":{"a":1}}"#,
            )
            .unwrap(),
        );
        assert_eq!(body.str("s"), Some("  x  "));
        assert_eq!(body.trimmed("s"), Some("x"));
        assert_eq!(body.trimmed("empty"), None);
        assert_eq!(body.non_empty("empty"), None);
        assert_eq!(body.bool("b"), Some(true));
        assert_eq!(body.number("n"), Some(1.5));
        assert_eq!(body.str("n"), None);
        assert_eq!(body.get("null"), Some(&Value::Null));
        assert_eq!(body.get("missing"), None);
    }

    #[tokio::test]
    async fn json_body_reads_empty_as_empty_object_and_refuses_a_bad_body() {
        let empty =
            JsonBody::from_request(HttpRequest::builder().body(Body::empty()).unwrap(), &())
                .await
                .unwrap();
        assert_eq!(empty, JsonBody::default());

        let array = JsonBody::from_request(
            HttpRequest::builder().body(Body::from("[1,2]")).unwrap(),
            &(),
        )
        .await
        .unwrap();
        assert_eq!(array, JsonBody::default());

        let bad = JsonBody::from_request(
            HttpRequest::builder()
                .body(Body::from("{not json"))
                .unwrap(),
            &(),
        )
        .await
        .unwrap_err();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_of(bad).await.2, "the body must be JSON\n");
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_413() {
        let too_large = vec![b' '; MAX_JSON_BODY + 1];
        let rejected = JsonBody::from_request(
            HttpRequest::builder().body(Body::from(too_large)).unwrap(),
            &(),
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body_of(rejected).await.2, "request too large\n");
    }

    #[test]
    fn a_session_id_is_session_plus_thirty_six_hex_or_dash() {
        // Placeholder-shaped vectors only (D-046): the nil id and the version-4 placeholder. Upper-case
        // hex is accepted by construction (`is_ascii_hexdigit`), as web.ts's `/i` regex accepts it.
        assert!(SessionId::parse("session-00000000-0000-0000-0000-000000000000").is_some());
        assert!(SessionId::parse("session-00000000-0000-4000-8000-000000000001").is_some());
        for bad in [
            "",
            "session-",
            "session-00000000-0000-0000-0000-00000000000",
            "session-00000000-0000-0000-0000-0000000000000",
            "session-zzzzzzzz-0000-0000-0000-000000000000",
            "../session-00000000-0000-0000-0000-000000000000",
            "session-00000000-0000-0000-0000-000000000000/../x",
            "SESSION-00000000-0000-0000-0000-000000000000",
        ] {
            assert!(SessionId::parse(bad).is_none(), "{bad}");
        }
        assert_eq!(
            SessionId::parse("session-00000000-0000-0000-0000-000000000000")
                .unwrap()
                .to_string(),
            "session-00000000-0000-0000-0000-000000000000"
        );
    }

    #[tokio::test]
    async fn session_path_decodes_and_refuses() {
        let router = axum::Router::new().route(
            "/api/sessions/{id}",
            axum::routing::get(async |path: SessionPath| path.0.to_string()),
        );
        let response = router
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/sessions/session-00000000-0000-0000-0000-000000000000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = router
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/sessions/not-an-id")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_of(response).await.2,
            "{\"error\":\"not a session id\"}\n"
        );
    }

    #[test]
    fn canonical_path_resolves_and_normalizes() {
        let current = std::env::current_dir().unwrap();
        assert_eq!(
            canonical_path("."),
            std::fs::canonicalize(&current).unwrap()
        );
        assert_eq!(canonical_path(current.join("a/../b")), current.join("b"));
        assert_eq!(canonical_path("/a/../b"), PathBuf::from("/b"));
        // `..` at the root cannot climb above it.
        assert_eq!(canonical_path("/../a"), PathBuf::from("/a"));
        // An existing directory is the real path, so a symlink and its target compare equal.
        let root = std::env::temp_dir().join(format!(
            "heddle-canonical-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let link = root.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(
            canonical_path(&target),
            std::fs::canonicalize(&target).unwrap()
        );
        #[cfg(unix)]
        assert_eq!(canonical_path(&link), canonical_path(&target));
        // A path that does not exist is still absolute and normalized.
        assert_eq!(
            canonical_path(root.join("missing/../new")),
            root.join("new")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn inline_types_are_deny_by_default() {
        assert_eq!(
            inline_content_type(Path::new("a/b/IMAGE.PNG")),
            Some("image/png")
        );
        assert_eq!(
            inline_content_type(Path::new("font.woff2")),
            Some("font/woff2")
        );
        assert_eq!(inline_content_type(Path::new("doc.html")), None);
        assert_eq!(inline_content_type(Path::new("run.js")), None);
        assert_eq!(inline_content_type(Path::new("no-extension")), None);
    }

    #[tokio::test]
    async fn file_bytes_inlines_what_a_document_embeds_and_downloads_the_rest() {
        let response = file_bytes(
            Path::new("/tmp/image.png"),
            "image.png",
            vec![0x89, b'P', b'N', b'G'],
        );
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(response.headers()["content-disposition"], "inline");
        assert_eq!(response.headers()["content-length"], "4");

        let response = file_bytes(
            Path::new("/tmp/notes.html"),
            "a \"quoted\".html",
            b"<script>".to_vec(),
        );
        assert_eq!(
            response.headers()["content-type"],
            "application/octet-stream"
        );
        assert_eq!(
            response.headers()["content-disposition"],
            "attachment; filename=\"a quoted.html\""
        );
    }
}
