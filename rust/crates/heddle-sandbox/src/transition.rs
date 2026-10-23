//! The one rule that decides a session's mode change.
//!
//! Ported from `permissionTransition` in `src/sandbox/service.ts`. A pure function on purpose: the HTTP route
//! (`POST /api/sessions/<id>/permission`), the page's dialog and the unit suite judge one statement instead of
//! each re-deriving it. A tool call can never reach it — no tool argument names a session mode — which is what
//! makes a mode change an explicit owner action, never a side effect.

use serde_json::Value;

use crate::mode::SandboxMode;

/// The confirmation token a widening to `danger-full-access` must carry (`confirm: 'full-access'`).
pub const FULL_ACCESS_CONFIRMATION: &str = "full-access";

/// An accepted change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ModeChange {
    /// The mode in effect after the change.
    pub mode: SandboxMode,
    /// `false` when the target is the mode already in effect — a no-op appends no event.
    pub changed: bool,
}

/// Why a change was refused; the route answers both with a non-2xx status (the TypeScript route sends 409).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransitionRefusal {
    /// The target is not one of the three words:
    /// `'<value>' is not one of read-only, workspace-write, danger-full-access`.
    #[error("{reason}")]
    UnknownMode {
        /// The sentence, with the value as JavaScript's `String()` shows it (`undefined` when absent).
        reason: String,
    },
    /// A widening to `danger-full-access` without [`FULL_ACCESS_CONFIRMATION`]:
    /// `widening to 'danger-full-access' needs the owner's explicit confirmation; send confirm: 'full-access'
    /// only after the risk gate has been acknowledged`.
    #[error("{reason}")]
    NeedsConfirmation {
        /// The sentence above, verbatim.
        reason: String,
    },
}

impl TransitionRefusal {
    /// The sentence the route returns as `error`.
    pub fn reason(&self) -> &str {
        match self {
            TransitionRefusal::UnknownMode { reason }
            | TransitionRefusal::NeedsConfirmation { reason } => reason,
        }
    }
}

/// Decide one session-mode change (`permissionTransition`).
///
/// `target` and `confirmation` are the raw JSON body fields (`mode`, `confirm`); `None` is an absent field.
/// The rule, DSH's with one strengthening: a word outside the vocabulary is refused; the current mode is a
/// no-op (`changed: false`); a narrowing, or a widening to `workspace-write`, is accepted; a widening to
/// `danger-full-access` is refused unless `confirmation` is exactly the string `"full-access"` — enforced by the
/// server too, so a stale page or a script cannot widen access by accident.
pub fn permission_transition(
    current: SandboxMode,
    target: Option<&Value>,
    confirmation: Option<&Value>,
) -> Result<ModeChange, TransitionRefusal> {
    let _ = (current, target, confirmation);
    todo!("port permissionTransition from src/sandbox/service.ts")
}
