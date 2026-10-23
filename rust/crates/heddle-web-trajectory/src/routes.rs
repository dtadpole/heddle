//! The Trajectory view's HTTP surface.
//!
//! | Request | Answer |
//! |---|---|
//! | any of the two, id not `session-<uuid>` | `400 {"error":"not a session id"}` |
//! | any of the two, no such session | `404 {"error":"no session <id>"}` |
//! | `GET /api/sessions/{id}?view=ledger` | `200` [`LedgerView`](crate::LedgerView), pretty — through [`ledger_response`], called by the server's chat route |
//! | `GET /api/sessions/{id}/log` | `200 application/x-ndjson; charset=utf-8`, `content-disposition` from [`log_file_name`](crate::log_file_name), `content-length` — mounted by [`router`] |

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::get;
use heddle_web_composer::catalog::catalog_of;
use heddle_web_composer::http::{error, is_session_id, json_pretty, respond};
use heddle_web_composer::{SessionLookup, ToolSpec};

use crate::inspector::JsonHighlighter;
use crate::log_download::{content_disposition, log_file_name, ndjson};
use crate::view::ledger_view;

/// What the Trajectory routes read from the running harness.
pub trait TrajectoryHost: SessionLookup + JsonHighlighter {
    /// The session's title as the store lists it (`ctx.session.list()`), when it has one.
    fn session_title(&self, id: &str) -> Option<String>;
    /// The profile's tools as the tool service describes them (`ctx.tools.describe()`).
    fn tool_specs(&self) -> Vec<ToolSpec>;
}

/// The answer to `GET /api/sessions/{id}?view=ledger`, for the server's chat route to return when the query asks
/// for the ledger. `id` is the decoded path segment.
pub fn ledger_response<H: TrajectoryHost + ?Sized>(host: &H, id: &str) -> Response {
    if !is_session_id(id) {
        return error(StatusCode::BAD_REQUEST, "not a session id");
    }
    let Some(events) = host.session_events(id) else {
        return error(StatusCode::NOT_FOUND, &format!("no session {id}"));
    };
    let catalog = catalog_of(&host.tool_specs());
    json_pretty(StatusCode::OK, &ledger_view(id, &events, catalog, host))
}

/// The answer to `GET /api/sessions/{id}/log`.
pub fn log_response<H: TrajectoryHost + ?Sized>(host: &H, id: &str) -> Response {
    if !is_session_id(id) {
        return error(StatusCode::BAD_REQUEST, "not a session id");
    }
    let Some(events) = host.session_events(id) else {
        return error(StatusCode::NOT_FOUND, &format!("no session {id}"));
    };
    let name = log_file_name(host.session_title(id).as_deref(), id);
    let body = ndjson(&events);
    let length = body.len();
    let mut response = respond(StatusCode::OK, "application/x-ndjson; charset=utf-8", body);
    let headers = response.headers_mut();
    // A header is not a place for a person's typed title: the ASCII fallback is the id, and the title travels
    // in the RFC 6266 `filename*` parameter, encoded.
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(id, &name))
            .expect("a content disposition is a header value"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).expect("a length is a header value"),
    );
    response
}

/// The routes this crate mounts: `GET /api/sessions/{id}/log`.
pub fn router<H: TrajectoryHost>(host: Arc<H>) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/sessions/{id}/log",
            get(
                move |State(host): State<Arc<H>>, Path(id): Path<String>| async move {
                    log_response(&*host, &id)
                },
            ),
        )
        .with_state(host)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Method, Request};
    use axum::response::Response;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;
    use crate::test_support::Host;

    const SESSION: &str = "session-00000000-0000-4000-8000-000000000000";

    fn fixture_host() -> Host {
        Host::with_session(
            SESSION,
            vec![
                json!({"seq": 1, "at": "2026-10-17T10:00:00.000Z", "type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}),
                json!({"seq": 2, "at": "2026-10-17T10:00:00.100Z", "type": "model/request", "messages": 1, "estimatedTokens": 5}),
                json!({"seq": 3, "at": "2026-10-17T10:00:00.200Z", "type": "turn/completed", "rounds": 1}),
            ],
        )
    }

    async fn body_text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("the body fits");
        String::from_utf8(bytes.to_vec()).expect("a UTF-8 body")
    }

    fn request(method: Method, uri: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .expect("a valid request")
    }

    #[tokio::test]
    async fn the_ledger_answer_is_the_pretty_view() {
        let response = ledger_response(&fixture_host(), SESSION);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body: Value = serde_json::from_str(&body_text(response).await).expect("a JSON body");
        assert_eq!(body["id"], SESSION);
        assert_eq!(body["ledger"]["turns"].as_array().map(Vec::len), Some(1));
        assert!(body["rows"].as_array().is_some_and(|rows| !rows.is_empty()));
        assert_eq!(body["timeline"]["spans"].as_array().map(Vec::len), Some(1));
        assert!(body["tools"].as_array().is_some_and(Vec::is_empty));
    }

    #[tokio::test]
    async fn a_malformed_id_and_an_unknown_session_are_refused_before_the_store() {
        let host = fixture_host();
        let response = ledger_response(&host, "not-a-session");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"not a session id\"}\n"
        );

        let response = ledger_response(&host, "session-00000000-0000-4000-8000-000000000001");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"no session session-00000000-0000-4000-8000-000000000001\"}\n"
        );
    }

    #[tokio::test]
    async fn the_log_is_served_decoded_with_a_safe_disposition_and_its_length() {
        let mut host = fixture_host();
        host.titles
            .insert(SESSION.to_owned(), "a conversation".to_owned());
        let response = log_response(&host, SESSION);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-ndjson; charset=utf-8"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\"session-00000000-0000-4000-8000-000000000000.jsonl\"; filename*=UTF-8''a%20conversation.jsonl"
        );
        let body = body_text(response).await;
        assert_eq!(body.lines().count(), 3, "one decoded JSON object per line");
        assert!(body.ends_with('\n'));
        let first: Value = serde_json::from_str(body.lines().next().expect("a first line"))
            .expect("each line is JSON");
        assert_eq!(first["type"], "message");

        let response = log_response(&host, SESSION);
        let declared: usize = response.headers()[header::CONTENT_LENGTH]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            declared,
            body.len(),
            "the content length is the body's byte length"
        );
    }

    #[tokio::test]
    async fn the_mounted_router_answers_the_log_route() {
        let host = fixture_host();
        let response = router(Arc::new(host))
            .oneshot(request(
                Method::GET,
                &format!("/api/sessions/{SESSION}/log"),
            ))
            .await
            .expect("the router answers");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_text(response).await.lines().count(), 3);

        let host = fixture_host();
        let response = router(Arc::new(host))
            .oneshot(request(Method::GET, "/api/sessions/not-a-session/log"))
            .await
            .expect("the router answers");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"not a session id\"}\n"
        );
    }
}
