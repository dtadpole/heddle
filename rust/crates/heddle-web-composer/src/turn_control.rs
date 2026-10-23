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

use serde::Serialize;
use serde_json::{Map, Value};

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
        todo!("Steer::content")
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
    let _ = (host, body);
    todo!("validate_steer")
}

/// `POST /api/sessions/{id}/steer` and `POST /api/sessions/{id}/stop`.
pub fn routes<H: TurnControlHost>(host: Arc<H>) -> axum::Router {
    let _ = host;
    todo!("turn_control::routes")
}
