//! The composer's turn controls: `POST /api/sessions/{id}/steer` and `POST /api/sessions/{id}/stop`.
//!
//! Ported from the two routes of `src/server/web.ts`. Both act on a turn the server's `/api/turn` started, so the
//! turn registry (what is running, and the abort handles) stays the server's and is reached through
//! [`TurnControlHost`].
//!
//! **Steer** delivers a message to the running turn by recording it: the same user event a turn of its own would
//! have written, so the loop's next round reads it and every reader sees it through the one write path. A steer
//! whose turn has ended cannot arrive, so it is DSH's `409` with `code: "session/steer-unavailable"`, and the
//! composer falls back to queueing it.
//!
//! | Steer answer | When |
//! |---|---|
//! | `400 {"error":"not a session id"}` | the id is not `session-<uuid>` |
//! | `400` / `413` plain text | the body is not JSON / is larger than 10 MiB |
//! | `400 {"error":"a prompt is required"}` | `prompt` missing or blank |
//! | `400 {"error":"<attachment refusal>"}` | [`TurnControlHost::read_attachments`] refused |
//! | `409 {"error":"the current turn no longer accepts steering","code":"session/steer-unavailable"}` | nothing runs |
//! | `404 {"error":"no session <id>"}` | the store has no such session |
//! | `200 {"accepted":true,"session":"<id>"}`, pretty | the message was recorded |
//!
//! **Stop** aborts what runs, now. `stopped: 0` is not an error — the turn may have ended between the click and
//! the request — so it is `200 {"stopped":N,"session":"<id>"}`, compact, or `400` for a malformed id.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::http::{error, is_session_id, json_compact, json_pretty, read_json, trimmed_field};
use crate::session::SessionLookup;

/// What the turn controls read from and do to the running harness.
pub trait TurnControlHost: SessionLookup {
    /// Whether a turn of the session is running now (`state.running.get(id) > 0`).
    fn is_running(&self, id: &str) -> bool;

    /// Abort every running turn of the session and answer how many were aborted (`abortSession`).
    fn abort_session(&self, id: &str) -> u64;

    /// `readAttachments(body.attachments)`: the content parts the attachments become, or the sentence of the
    /// refusal (`AttachmentInputError.message`). `None` is a body without `attachments`.
    fn read_attachments(&self, raw: Option<&Value>) -> Result<Vec<Value>, String>;

    /// `ctx.session.userContent(handle, content)`: append a user message to the session's log.
    fn record_user_content(&self, id: &str, content: Vec<Value>);
}

/// A steer body, validated: the trimmed prompt and the attachment parts that follow it.
#[derive(Debug, Clone, PartialEq)]
pub struct Steer {
    pub prompt: String,
    pub attachments: Vec<Value>,
}

impl Steer {
    /// The message content a steer records: `[{"type":"text","text":prompt}, ...attachments]`.
    pub fn content(&self) -> Vec<Value> {
        let mut content = Vec::with_capacity(self.attachments.len() + 1);
        content.push(json!({"type": "text", "text": self.prompt}));
        content.extend(self.attachments.iter().cloned());
        content
    }
}

/// The `200` body of a steer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SteerAccepted {
    pub accepted: bool,
    pub session: String,
}

/// The `200` body of a stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stopped {
    pub stopped: u64,
    pub session: String,
}

/// Validate a steer body: a non-blank prompt, then attachments the host accepts. `Err` is the `400` sentence.
pub fn validate_steer<H: TurnControlHost + ?Sized>(
    host: &H,
    body: &Map<String, Value>,
) -> Result<Steer, String> {
    let prompt = trimmed_field(body, "prompt")
        .ok_or_else(|| "a prompt is required".to_owned())?
        .to_owned();
    let attachments = host.read_attachments(body.get("attachments"))?;
    Ok(Steer {
        prompt,
        attachments,
    })
}

/// `POST /api/sessions/{id}/steer` and `POST /api/sessions/{id}/stop`.
pub fn routes<H: TurnControlHost>(host: Arc<H>) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/sessions/{id}/steer",
            post(
                move |State(host): State<Arc<H>>, Path(id): Path<String>, body: Bytes| async move {
                    if !is_session_id(&id) {
                        return error(StatusCode::BAD_REQUEST, "not a session id");
                    }
                    let body = match read_json(&body) {
                        Ok(body) => body,
                        Err(refusal) => return refusal.into_response(),
                    };
                    let steer = match validate_steer(&*host, &body) {
                        Ok(steer) => steer,
                        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
                    };
                    if !host.is_running(&id) {
                        return json_compact(
                            StatusCode::CONFLICT,
                            &json!({
                                "error": "the current turn no longer accepts steering",
                                "code": "session/steer-unavailable",
                            }),
                        );
                    }
                    if !host.session_exists(&id) {
                        return error(StatusCode::NOT_FOUND, &format!("no session {id}"));
                    }
                    host.record_user_content(&id, steer.content());
                    json_pretty(
                        StatusCode::OK,
                        &SteerAccepted {
                            accepted: true,
                            session: id,
                        },
                    )
                },
            ),
        )
        .route(
            "/api/sessions/{id}/stop",
            post(
                move |State(host): State<Arc<H>>, Path(id): Path<String>| async move {
                    if !is_session_id(&id) {
                        return error(StatusCode::BAD_REQUEST, "not a session id");
                    }
                    let stopped = host.abort_session(&id);
                    json_compact(
                        StatusCode::OK,
                        &Stopped {
                            stopped,
                            session: id,
                        },
                    )
                },
            ),
        )
        .with_state(host)
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use serde_json::json;

    use super::*;
    use crate::test_support::{Host, assert_answer_headers, body_text, call};

    const SESSION: &str = "session-00000000-0000-4000-8000-000000000000";

    #[test]
    fn a_steer_records_its_prompt_then_its_attachments() {
        let steer = Steer {
            prompt: "look at this".to_owned(),
            attachments: vec![json!({"type": "image", "name": "a.png"})],
        };
        assert_eq!(
            steer.content(),
            vec![
                json!({"type": "text", "text": "look at this"}),
                json!({"type": "image", "name": "a.png"}),
            ]
        );
        let bare = Steer {
            prompt: "hi".to_owned(),
            attachments: Vec::new(),
        };
        assert_eq!(bare.content(), vec![json!({"type": "text", "text": "hi"})]);
    }

    #[test]
    fn a_steer_needs_a_prompt_before_its_attachments_are_read() {
        let mut host = Host {
            attachment_error: Some("the attachment is too large".to_owned()),
            ..Host::default()
        };
        assert_eq!(
            validate_steer(&host, &json!({}).as_object().unwrap().clone()),
            Err("a prompt is required".to_owned()),
            "the prompt is judged first"
        );
        assert_eq!(
            validate_steer(&host, &json!({"prompt": "hi"}).as_object().unwrap().clone()),
            Err("the attachment is too large".to_owned()),
            "the host's own refusal travels unchanged"
        );
        host.attachment_error = None;
        let steer = validate_steer(
            &host,
            &json!({"prompt": "  hi  ", "attachments": ["a.png"]})
                .as_object()
                .unwrap()
                .clone(),
        )
        .expect("a valid steer");
        assert_eq!(steer.prompt, "hi", "the prompt is trimmed");
        assert_eq!(steer.attachments.len(), 1);
    }

    #[tokio::test]
    async fn steering_refuses_what_the_route_table_says() {
        let host = Host::with_session(SESSION, Vec::new());
        let router = routes(Arc::new(host));
        let path = |id: &str| format!("/api/sessions/{id}/steer");

        let response = call(router.clone(), Method::POST, &path("nope"), Some("{}")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"not a session id\"}\n"
        );

        let response = call(router.clone(), Method::POST, &path(SESSION), Some("[]")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"a prompt is required\"}\n"
        );

        let response = call(
            router.clone(),
            Method::POST,
            &path(SESSION),
            Some("{\"prompt\":\"hi\"}"),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::CONFLICT,
            "nothing runs, so a steer cannot arrive"
        );
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"the current turn no longer accepts steering\",\"code\":\"session/steer-unavailable\"}\n"
        );

        let running = Host {
            running: true,
            ..Host::default()
        };
        let response = call(
            routes(Arc::new(running)),
            Method::POST,
            &path("session-00000000-0000-4000-8000-000000000001"),
            Some("{\"prompt\":\"hi\"}"),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "a running turn still needs a session"
        );
    }

    #[tokio::test]
    async fn a_running_turns_steer_is_recorded_and_accepted() {
        let host = Host {
            running: true,
            ..Host::with_session(SESSION, Vec::new())
        };
        let recorded = Arc::clone(&host.recorded);
        let response = call(
            routes(Arc::new(host)),
            Method::POST,
            &format!("/api/sessions/{SESSION}/steer"),
            Some("{\"prompt\":\"go on\"}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_answer_headers(&response, crate::http::JSON_CONTENT_TYPE);
        assert_eq!(
            body_text(response).await,
            format!("{{\n  \"accepted\": true,\n  \"session\": \"{SESSION}\"\n}}\n")
        );
        let recorded = recorded.lock().expect("the record log is not poisoned");
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].0, SESSION);
        assert_eq!(
            recorded[0].1,
            vec![json!({"type": "text", "text": "go on"})]
        );
    }

    #[tokio::test]
    async fn stopping_answers_how_many_were_aborted_and_zero_is_not_an_error() {
        let mut host = Host::with_session(SESSION, Vec::new());
        host.aborted = 2;
        let response = call(
            routes(Arc::new(host)),
            Method::POST,
            &format!("/api/sessions/{SESSION}/stop"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_text(response).await,
            format!("{{\"stopped\":2,\"session\":\"{SESSION}\"}}\n")
        );

        let host = Host::with_session(SESSION, Vec::new());
        let response = call(
            routes(Arc::new(host)),
            Method::POST,
            &format!("/api/sessions/{SESSION}/stop"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_text(response).await,
            format!("{{\"stopped\":0,\"session\":\"{SESSION}\"}}\n")
        );
    }
}
