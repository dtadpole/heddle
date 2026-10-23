//! A session's access mode, recorded as one append-only `permission/mode` event.
//!
//! Ported from `src/session/mode.ts`. DSH keeps `sandbox/mode` as a log-only event folded over the
//! deployment default; this is the same mechanism with heddle's names. The event takes no surface
//! position, so it never reaches a model as conversation.
//!
//! # The vocabulary is the sandbox's
//!
//! The fold is one rule — the last event wins, and a recorded word outside the vocabulary is an error
//! naming the event — and it lives here, beside the log. The vocabulary (`read-only`,
//! `workspace-write`, `danger-full-access`) is `heddle-sandbox`'s, so these functions are generic over
//! any mode type that parses from its word and spells itself back: `heddle-sandbox`'s `SandboxMode`
//! implements `FromStr` (refusing anything else) and `AsRef<str>`. The session crate therefore does not
//! depend on the sandbox, and there is still one list of modes.

use std::str::FromStr;

use crate::error::SessionError;
use crate::event::{SessionEvent, SessionHandle};
use crate::store::SessionStore;

/// The event type one mode change appends.
pub const MODE_EVENT: &str = "permission/mode";

/// The mode a log records, or `None` when it records none.
///
/// The last `permission/mode` event wins. Its `mode` must be a string the vocabulary accepts; anything
/// else is [`SessionError::UnknownRecordedMode`] — falling back to the default would run a session under
/// a policy nobody chose and make a corrupt log look healthy.
pub fn recorded_mode<M, E>(events: &[E]) -> Result<Option<M>, SessionError>
where
    M: FromStr,
    E: std::borrow::Borrow<SessionEvent>,
{
    todo!()
}

/// The mode a call runs under: the log's last record, else `fallback` (the deployment default).
pub fn effective_mode<M, E>(events: &[E], fallback: M) -> Result<M, SessionError>
where
    M: FromStr,
    E: std::borrow::Borrow<SessionEvent>,
{
    todo!()
}

/// Give a child session the mode its parent runs under, at creation.
///
/// Delegation must not widen access as a side effect: without this a child of a `read-only` parent would
/// run under the deployment default. A parent that recorded no mode gives nothing, because it is itself
/// running under that default. Answers with the inherited mode.
pub fn inherit_recorded_mode<M>(
    store: &SessionStore,
    parent: &SessionHandle,
    child: &SessionHandle,
) -> Result<Option<M>, SessionError>
where
    M: FromStr + AsRef<str>,
{
    todo!()
}
