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
//! the mode type and read and write it **through serde**: the event's `mode` field is deserialized into
//! `M` (a word the type refuses is the error) and `M` is serialized into it. `heddle-sandbox`'s
//! `SandboxMode` (`Serialize + Deserialize`, kebab-case) fits as it is, the session crate does not depend
//! on the sandbox, and there is still one list of modes.

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::SessionError;
use crate::event::{SessionEvent, SessionHandle};
use crate::store::SessionStore;

/// The event type one mode change appends: `{"type":"permission/mode","mode":"<word>"}`.
pub const MODE_EVENT: &str = "permission/mode";

/// The mode a log records, or `None` when it records none.
///
/// The last `permission/mode` event wins. Its `mode` must deserialize into `M`; anything else —
/// another word, a number, no field — is [`SessionError::UnknownRecordedMode`] naming the event's seq,
/// because falling back to the default would run a session under a policy nobody chose and make a
/// corrupt log look healthy.
pub fn recorded_mode<M, E>(events: &[E]) -> Result<Option<M>, SessionError>
where
    M: DeserializeOwned,
    E: std::borrow::Borrow<SessionEvent>,
{
    todo!()
}

/// The mode a call runs under: the log's last record, else `fallback` (the deployment default).
pub fn effective_mode<M, E>(events: &[E], fallback: M) -> Result<M, SessionError>
where
    M: DeserializeOwned,
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
    M: Serialize + DeserializeOwned,
{
    todo!()
}
