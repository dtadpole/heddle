//! The **surface**: the positional view of a log, which a model request is derived from.
//!
//! Ported from the pure functions of `src/session/store.ts`. An append-only log cannot by itself let
//! something be *replaced* without being *erased*; the surface can. Three rules hold it up:
//!
//! - **Only message-producing events take a position**: `message`, `context/note`, and one node per
//!   streamed run of `assistant/chunk` events (the seq of its first chunk). Everything else is log-only.
//! - **What the harness wrote is not what a person said**: a system prompt or a compaction checkpoint is
//!   a `context/note`, never a `message`, so a transcript view cannot mistake it for a turn.
//! - **A replacement names positions, not a new history**: it is written later, so its seq is higher than
//!   what it shadows; it splices the span between its two endpoints and records which seqs it found.
//!
//! Every function here is generic over `E: Borrow<SessionEvent>` so it reads a store snapshot
//! (`&[Arc<SessionEvent>]`) and a test's `&[SessionEvent]` alike.

use std::borrow::Borrow;
use std::collections::HashMap;

use serde::Serialize;

use crate::error::SessionError;
use crate::event::SessionEvent;
use crate::message::Message;

/// The event types that can take a position on the surface.
pub const SURFACE_EVENT_TYPES: [&str; 3] = ["message", "context/note", "assistant/chunk"];

/// One landed replacement, kept so a reader can see what a node shadowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceReplacement {
    pub seq: u64,
    pub start_seq: u64,
    pub end_seq: u64,
    pub shadowed_seqs: Vec<u64>,
}

/// The positional view of a log: the nodes the model can see, in order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceState {
    /// The seq of every node, in surface order — which is not seq order after a replacement.
    pub nodes: Vec<u64>,
    /// Bumped by an append and by a replacement: the derivation cache key.
    pub content_generation: u64,
    /// Bumped only by a replacement: "a rewrite has landed", which is what a retry waits for.
    pub replace_generation: u64,
    pub replacements: Vec<SurfaceReplacement>,
}

/// Whether an event type can take a position on the surface.
pub fn is_surface_eligible(kind: &str) -> bool {
    todo!()
}

/// Fold a log into its surface.
///
/// A `message` or `context/note` takes a position and closes any open chunk run; the first
/// `assistant/chunk` of a run takes one and a `done` chunk closes the run; a replacement splices the
/// positions between its endpoints (both must be on the surface, end not before start) and closes the
/// run. A replacement the fold cannot place is [`SessionError::UnfoldableReplacement`] — a log that
/// carries one is a log nothing should silently half-read.
pub fn fold_surface<E: Borrow<SessionEvent>>(events: &[E]) -> Result<SurfaceState, SessionError> {
    todo!()
}

/// Index a log by seq, which every derivation over it wants.
pub fn index_by_seq<E: Borrow<SessionEvent>>(events: &[E]) -> HashMap<u64, &SessionEvent> {
    todo!()
}

/// The message one node derives to, or `None` when it produces none.
///
/// A `message` or `context/note` node is its `message` field, when that parses and has content. A chunk
/// node is the run that starts at it, in order, until a `done` chunk or the first non-chunk seq:
/// `text-delta` → a `text` part, `reasoning-delta` → `reasoning`, `tool-call` → `tool-call`; the
/// result is an `assistant` message, or `None` when the run produced no part.
///
/// A `message` field that does not parse as a [`Message`] derives to `None` (the TypeScript build passed
/// such an object through unchecked; no writer produces one).
pub fn derive_message(by_seq: &HashMap<u64, &SessionEvent>, seq: u64) -> Option<Message> {
    todo!()
}

/// The message one node derives to, indexing the log first.
pub fn derive_node_message<E: Borrow<SessionEvent>>(events: &[E], seq: u64) -> Option<Message> {
    todo!()
}

/// The events a fork inherits: everything up to and including the **last** `turn/completed`.
///
/// A log with no `turn/completed` comes back whole; whether that is forkable is the caller's call.
pub fn completed_prefix<E: Borrow<SessionEvent> + Clone>(events: &[E]) -> Vec<E> {
    todo!()
}

/// Whether the conversation a fork would inherit contains an assistant answer.
///
/// True when a surface node of the completed prefix derives to an `assistant` message (a fork's own log
/// holds copied messages and no chunks), or when the prefix holds an `assistant/completed` event.
pub fn inherits_answer<E: Borrow<SessionEvent> + Clone>(
    events: &[E],
) -> Result<bool, SessionError> {
    todo!()
}
