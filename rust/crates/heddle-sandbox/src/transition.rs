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
    let Some(target) = target.and_then(Value::as_str).and_then(SandboxMode::parse) else {
        return Err(TransitionRefusal::UnknownMode {
            reason: format!(
                "'{}' is not one of read-only, workspace-write, danger-full-access",
                crate::js::string_of(target)
            ),
        });
    };
    if target == current {
        return Ok(ModeChange {
            mode: current,
            changed: false,
        });
    }
    let escalates = target.rank() > current.rank();
    let confirmed = confirmation.and_then(Value::as_str) == Some(FULL_ACCESS_CONFIRMATION);
    if escalates && target == SandboxMode::DangerFullAccess && !confirmed {
        return Err(TransitionRefusal::NeedsConfirmation {
            reason: "widening to 'danger-full-access' needs the owner's explicit confirmation; send confirm: 'full-access' only after the risk gate has been acknowledged".to_owned(),
        });
    }
    Ok(ModeChange {
        mode: target,
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{FULL_ACCESS_CONFIRMATION, ModeChange, TransitionRefusal, permission_transition};
    use crate::mode::SandboxMode;

    fn accepted(mode: SandboxMode, changed: bool) -> Result<ModeChange, TransitionRefusal> {
        Ok(ModeChange { mode, changed })
    }

    fn refused_unknown(word: &str) -> Result<ModeChange, TransitionRefusal> {
        Err(TransitionRefusal::UnknownMode {
            reason: format!(
                "'{word}' is not one of read-only, workspace-write, danger-full-access"
            ),
        })
    }

    #[test]
    fn a_word_outside_the_vocabulary_is_refused_with_the_javascript_string_of_the_value() {
        assert_eq!(
            permission_transition(
                SandboxMode::WorkspaceWrite,
                Some(&json!("workspace_write")),
                None
            ),
            refused_unknown("workspace_write")
        );
        assert_eq!(
            permission_transition(SandboxMode::WorkspaceWrite, None, None),
            refused_unknown("undefined"),
            "an absent field is undefined"
        );
        assert_eq!(
            permission_transition(SandboxMode::WorkspaceWrite, Some(&Value::Null), None),
            refused_unknown("null")
        );
        assert_eq!(
            permission_transition(SandboxMode::WorkspaceWrite, Some(&json!(1)), None),
            refused_unknown("1")
        );
    }

    #[test]
    fn the_mode_already_in_effect_is_a_no_op() {
        for mode in SandboxMode::ALL {
            assert_eq!(
                permission_transition(mode, Some(&json!(mode.as_str())), None),
                accepted(mode, false),
                "no confirmation is needed to stay put, even in {mode}"
            );
        }
    }

    #[test]
    fn narrowing_is_free() {
        assert_eq!(
            permission_transition(
                SandboxMode::DangerFullAccess,
                Some(&json!("read-only")),
                None
            ),
            accepted(SandboxMode::ReadOnly, true)
        );
        assert_eq!(
            permission_transition(
                SandboxMode::DangerFullAccess,
                Some(&json!("workspace-write")),
                None
            ),
            accepted(SandboxMode::WorkspaceWrite, true)
        );
        assert_eq!(
            permission_transition(SandboxMode::WorkspaceWrite, Some(&json!("read-only")), None),
            accepted(SandboxMode::ReadOnly, true)
        );
    }

    #[test]
    fn a_widening_to_workspace_write_is_free_but_full_access_needs_the_token() {
        assert_eq!(
            permission_transition(SandboxMode::ReadOnly, Some(&json!("workspace-write")), None),
            accepted(SandboxMode::WorkspaceWrite, true)
        );
        assert_eq!(
            permission_transition(
                SandboxMode::WorkspaceWrite,
                Some(&json!("danger-full-access")),
                Some(&json!(FULL_ACCESS_CONFIRMATION))
            ),
            accepted(SandboxMode::DangerFullAccess, true)
        );
    }

    #[test]
    fn widening_to_full_access_without_the_exact_token_is_refused() {
        let sentence = "widening to 'danger-full-access' needs the owner's explicit confirmation; send confirm: 'full-access' only after the risk gate has been acknowledged";
        let refusals = vec![
            None,
            Some(json!("full-access ")),
            Some(json!(true)),
            Some(Value::Null),
            Some(json!("FULL-ACCESS")),
        ];
        for confirmation in &refusals {
            assert_eq!(
                permission_transition(
                    SandboxMode::WorkspaceWrite,
                    Some(&json!("danger-full-access")),
                    confirmation.as_ref()
                ),
                Err(TransitionRefusal::NeedsConfirmation {
                    reason: sentence.to_owned(),
                }),
                "confirmation {confirmation:?} is not the token"
            );
        }
    }

    #[test]
    fn the_sentence_is_what_the_route_returns_as_the_error() {
        let refusal = permission_transition(
            SandboxMode::WorkspaceWrite,
            Some(&json!("danger-full-access")),
            None,
        )
        .unwrap_err();
        assert!(
            refusal
                .reason()
                .starts_with("widening to 'danger-full-access'")
        );
    }
}
