//! `GET /api/context?session=<id>[&endpoint=<name>][&model=<id>]` — how one session's context is composed.
//!
//! Ported from the `/api/context` route of `src/server/web.ts`. A budget is checkable from numbers; "the
//! instructions on the surface are the current ones" and "the summary is in there once, where the span was" are
//! claims about the messages themselves, so the view answers with provenance: the instruction files the baseline
//! read, the harness's notes with their origin, the surface as seqs and the replacements a compaction made.
//!
//! The order of the reads is part of the contract: assembling may write the baseline notes on its first call, so
//! the route assembles **first** and only then reads the surface and the notes.
//!
//! | Answer | When |
//! |---|---|
//! | `503 {"error":"this profile does not load the context plugin"}` | [`ContextHost::has_context`] is false |
//! | `400 {"error":"a session is required"}` | `session` missing or empty |
//! | `404 {"error":"no session <id>"}` | the store has no such session |
//! | `200` [`ContextView`], pretty | otherwise |

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use serde::Serialize;
use serde_json::Value;

use crate::http::{error, json_pretty};
use crate::session::SessionLookup;

/// What `/api/context` reads from the running harness.
pub trait ContextHost: SessionLookup {
    /// Whether the profile loads the context plugin (`ctx.context !== undefined`).
    fn has_context(&self) -> bool;

    /// The directory the run resolves its instructions from: the session's folder, else the sandbox's workspace
    /// root, else the process's working directory.
    fn session_cwd(&self, id: &str) -> String;

    /// Assemble the session's context as the next request would (`ctx.context.assemble(handle, …)` with the
    /// profile's tools). May append the baseline notes to the log on a first call.
    fn assemble_context(&self, id: &str, request: &AssembleRequest) -> ContextAssembly;

    /// The session's surface: the seqs the model can see, in surface order, and the replacements.
    fn surface(&self, id: &str) -> Surface;
}

/// What one assembly is asked for.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AssembleRequest {
    pub cwd: String,
    /// The `endpoint` query parameter, when non-empty.
    pub endpoint: Option<String>,
    /// The `model` query parameter, when non-empty.
    pub model: Option<String>,
}

/// The context service's report, as much of it as the view prints (`ContextReport` of
/// `src/context/service.ts`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ContextAssembly {
    /// The instruction files the baseline carried, in order.
    pub instructions: Vec<String>,
    pub estimated_tokens: u64,
    pub context_window: u64,
    pub threshold_tokens: u64,
    /// How many oversized tool results this assembly rewrote.
    pub pruned: u64,
    pub compacted: bool,
    pub messages: Vec<ContextMessage>,
}

/// One message the model would read, already described as text (`describeContent` of `src/llm/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub text: String,
}

/// The positional view of a log (`SurfaceState` of `src/session/store.ts`, without its generations).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Surface {
    /// The `seq` of every node, in surface order — which is not seq order after a replacement.
    pub nodes: Vec<u64>,
    pub replacements: Vec<SurfaceReplacement>,
}

/// One compaction: the event `seq` that replaced the span `startSeq..endSeq`, and the seqs it shadows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceReplacement {
    pub seq: u64,
    pub start_seq: u64,
    pub end_seq: u64,
    pub shadowed_seqs: Vec<u64>,
}

/// One `context/note` event: what the harness composed, and which kind of note it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContextNote {
    /// The event's `seq`; `null` when the event carried none.
    pub seq: Option<u64>,
    /// The note's `origin` (`system-prompt`, `instructions`, `runtime-context`, …); `""` when absent.
    pub origin: String,
    /// The concatenated `text` parts of the note's message.
    pub text: String,
}

/// The body of a `200` from `/api/context`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextView {
    pub session: String,
    pub cwd: String,
    /// The `endpoint` that was asked for, or `null`.
    pub endpoint: Option<String>,
    pub instructions: Vec<String>,
    pub estimated_tokens: u64,
    pub context_window: u64,
    pub threshold_tokens: u64,
    pub pruned: u64,
    pub compacted: bool,
    pub surface: Surface,
    pub notes: Vec<ContextNote>,
    pub messages: Vec<ContextMessage>,
}

/// The `context/note` events of a log, in order, read defensively: a note whose message has no text parts has
/// empty text, and only parts of type `text` count.
pub fn context_notes(events: &[Value]) -> Vec<ContextNote> {
    let mut notes = Vec::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("context/note") {
            continue;
        }
        let seq = event.get("seq").and_then(Value::as_u64);
        let origin = event
            .get("origin")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let mut text = String::new();
        if let Some(parts) = event
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
        {
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    text.push_str(part.get("text").and_then(Value::as_str).unwrap_or(""));
                }
            }
        }
        notes.push(ContextNote { seq, origin, text });
    }
    notes
}

/// The view of one session, from what the host answered — pure, so the shaping is judged without a server.
pub fn context_view(
    session: &str,
    request: &AssembleRequest,
    assembly: ContextAssembly,
    surface: Surface,
    events: &[Value],
) -> ContextView {
    ContextView {
        session: session.to_owned(),
        cwd: request.cwd.clone(),
        endpoint: request.endpoint.clone(),
        instructions: assembly.instructions,
        estimated_tokens: assembly.estimated_tokens,
        context_window: assembly.context_window,
        threshold_tokens: assembly.threshold_tokens,
        pruned: assembly.pruned,
        compacted: assembly.compacted,
        surface,
        notes: context_notes(events),
        messages: assembly.messages,
    }
}

/// `GET /api/context`.
pub fn routes<H: ContextHost>(host: Arc<H>) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/context",
            get(
                move |State(host): State<Arc<H>>, Query(query): Query<HashMap<String, String>>| async move {
                    if !host.has_context() {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "this profile does not load the context plugin",
                        );
                    }
                    let session = query.get("session").map(String::as_str).filter(|id| !id.is_empty());
                    let Some(session) = session else {
                        return error(StatusCode::BAD_REQUEST, "a session is required");
                    };
                    let Some(events) = host.session_events(session) else {
                        return error(StatusCode::NOT_FOUND, &format!("no session {session}"));
                    };
                    let request = AssembleRequest {
                        cwd: host.session_cwd(session),
                        endpoint: query.get("endpoint").cloned().filter(|value| !value.is_empty()),
                        model: query.get("model").cloned().filter(|value| !value.is_empty()),
                    };
                    // Assemble first: the baseline notes may be written by this call, and the surface and the
                    // notes are read afterwards so both describe the same composition.
                    let assembly = host.assemble_context(session, &request);
                    let surface = host.surface(session);
                    json_pretty(StatusCode::OK, &context_view(session, &request, assembly, surface, &events))
                },
            ),
        )
        .with_state(host)
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, header};
    use serde_json::json;

    use super::*;
    use crate::test_support::{Host, assert_answer_headers, body_text, call};

    const SESSION: &str = "session-00000000-0000-4000-8000-000000000000";

    #[test]
    fn a_note_carries_its_text_and_origin_and_only_text_parts_count() {
        let events = vec![
            json!({"seq": 2, "type": "context/note", "origin": "instructions", "message": {"content": [{"type": "text", "text": "be terse"}]}}),
            json!({"seq": 3, "type": "context/note", "message": {"content": [{"type": "image", "text": "ignored"}, {"type": "text"}, {"type": "text", "text": "baseline"}]}}),
            json!({"seq": 4, "type": "message", "message": {"role": "user"}}),
            json!({"type": "context/note", "message": {"content": "not an array"}}),
        ];
        let notes = context_notes(&events);
        assert_eq!(notes.len(), 3, "only context notes, read defensively");
        assert_eq!(notes[0].seq, Some(2));
        assert_eq!(notes[0].origin, "instructions");
        assert_eq!(notes[0].text, "be terse");
        assert_eq!(
            notes[1].origin, "",
            "a note with no origin says so rather than inventing one"
        );
        assert_eq!(
            notes[1].text, "baseline",
            "a non-text part contributes nothing"
        );
        assert_eq!(notes[2].seq, None, "an event without a seq keeps null");
    }

    #[test]
    fn the_view_travels_every_field_the_page_reads() {
        let request = AssembleRequest {
            cwd: "/work".to_owned(),
            endpoint: Some("scripted".to_owned()),
            model: None,
        };
        let assembly = ContextAssembly {
            instructions: vec!["/work/AGENTS.md".to_owned()],
            estimated_tokens: 42,
            context_window: 128_000,
            threshold_tokens: 96_000,
            pruned: 1,
            compacted: false,
            messages: vec![ContextMessage {
                role: "user".to_owned(),
                tool_call_id: None,
                text: "hello".to_owned(),
            }],
        };
        let surface = Surface {
            nodes: vec![2, 3],
            replacements: Vec::new(),
        };
        let events = vec![
            json!({"seq": 2, "type": "context/note", "origin": "instructions", "message": {"content": [{"type": "text", "text": "be terse"}]}}),
        ];
        let view = context_view(SESSION, &request, assembly, surface, &events);
        assert_eq!(view.session, SESSION);
        assert_eq!(view.cwd, "/work");
        assert_eq!(view.endpoint.as_deref(), Some("scripted"));
        assert_eq!(view.context_window, 128_000);
        assert_eq!(view.threshold_tokens, 96_000);
        assert_eq!(view.notes[0].text, "be terse");
        let serialised = serde_json::to_value(&view).expect("the view serialises");
        assert_eq!(serialised["estimatedTokens"], 42);
        assert_eq!(serialised["surface"]["nodes"], json!([2, 3]));
        assert_eq!(serialised["messages"][0]["text"], "hello");
    }

    #[tokio::test]
    async fn the_route_refuses_a_profile_without_the_plugin_and_a_missing_session() {
        let without = Host {
            has_context: false,
            ..Host::default()
        };
        let response = call(
            routes(Arc::new(without)),
            Method::GET,
            "/api/context?session=x",
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"this profile does not load the context plugin\"}\n"
        );

        let host = Host::default();
        let response = call(routes(Arc::new(host)), Method::GET, "/api/context", None).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"a session is required\"}\n"
        );
        let host = Host::default();
        let response = call(
            routes(Arc::new(host)),
            Method::GET,
            "/api/context?session=",
            None,
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "an empty session is absent"
        );

        let host = Host::default();
        let response = call(
            routes(Arc::new(host)),
            Method::GET,
            "/api/context?session=session-1",
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_route_answers_the_composition_with_its_provenance() {
        let mut host = Host::with_session(
            SESSION,
            vec![
                json!({"seq": 1, "type": "context/note", "origin": "instructions", "message": {"content": [{"type": "text", "text": "be terse"}]}}),
            ],
        );
        host.cwd = "/work".to_owned();
        host.assembly = ContextAssembly {
            instructions: vec!["/work/AGENTS.md".to_owned()],
            estimated_tokens: 10,
            context_window: 4096,
            threshold_tokens: 3000,
            pruned: 0,
            compacted: false,
            messages: vec![ContextMessage {
                role: "user".to_owned(),
                tool_call_id: None,
                text: "hi".to_owned(),
            }],
        };
        host.surface = Surface {
            nodes: vec![1],
            replacements: Vec::new(),
        };
        let router = routes(Arc::new(host));
        let response = call(
            router,
            Method::GET,
            &format!("/api/context?session={SESSION}&endpoint=scripted"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_answer_headers(&response, crate::http::JSON_CONTENT_TYPE);
        assert!(response.headers().get(header::CONTENT_TYPE).is_some());
        let body: Value = serde_json::from_str(&body_text(response).await).expect("a JSON body");
        assert_eq!(body["session"], SESSION);
        assert_eq!(body["cwd"], "/work");
        assert_eq!(body["endpoint"], "scripted");
        assert_eq!(body["instructions"], json!(["/work/AGENTS.md"]));
        assert_eq!(body["estimatedTokens"], 10);
        assert_eq!(body["surface"]["nodes"], json!([1]));
        assert_eq!(body["notes"][0]["origin"], "instructions");
        assert_eq!(body["messages"][0]["text"], "hi");
        assert_eq!(body["compacted"], false);
    }
}
