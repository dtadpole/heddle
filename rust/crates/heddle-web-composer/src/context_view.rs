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

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

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
    let _ = events;
    todo!("context_notes")
}

/// The view of one session, from what the host answered — pure, so the shaping is judged without a server.
pub fn context_view(
    session: &str,
    request: &AssembleRequest,
    assembly: ContextAssembly,
    surface: Surface,
    events: &[Value],
) -> ContextView {
    let _ = (session, request, assembly, surface, events);
    todo!("context_view")
}

/// `GET /api/context`.
pub fn routes<H: ContextHost>(host: Arc<H>) -> axum::Router {
    let _ = host;
    todo!("context_view::routes")
}
