//! The runtime-context snapshot: the standing facts a model is told, as one sourced user message.
//!
//! A port of the snapshot half of `src/context/service.ts`, following DSH's agent loop: before
//! every request the registered contributions are rendered, and a snapshot that differs from the
//! retained one is **appended** after history (earlier ones stay, superseded); an unchanged one
//! writes nothing. The service records it ([`crate::ContextService::record_runtime_context`]); this
//! module owns its text.

use serde::{Deserialize, Serialize};

/// The `origin` of a runtime-context note.
pub const RUNTIME_CONTEXT_ORIGIN: &str = "runtime-context";
/// The prefix of a full snapshot, so a model with earlier ones in history reads the newest as current.
pub const RUNTIME_CONTEXT_HEADER: &str =
    "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
/// What a snapshot says when every contribution has gone away.
pub const CLEARED_RUNTIME_CONTEXT: &str =
    "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";

/// One named contribution, the way DSH attributes each part to its subsystem (`sandbox:policy`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeContextSection {
    /// Which subsystem said it.
    pub name: String,
    /// What it said; an empty text contributes nothing.
    pub text: String,
}

/// The snapshot text: the header and the non-empty sections joined by blank lines, or
/// [`CLEARED_RUNTIME_CONTEXT`] when none has text.
pub fn render_runtime_context(sections: &[RuntimeContextSection]) -> String {
    let _ = sections;
    todo!("render_runtime_context")
}
