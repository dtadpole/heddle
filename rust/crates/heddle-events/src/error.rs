//! What a failed listener reports: a deliberate refusal or a broken hook, named by point and listener.

use std::fmt;

use serde::{Deserialize, Serialize};

/// The prefix a refusal's message carries — the one the TypeScript loop's `isHookRefusal` recognises, and
/// the one a person reads first in the failure.
pub const REFUSAL_PREFIX: &str = "refused by hook: ";

/// Whether a listener meant to stop the step or broke while running.
///
/// The distinction is the person's: "the policy refused this" and "the policy is broken" call for different
/// actions, and `60-hooks` judges both — a refusing pre-step hook stops the round and says which hook refused
/// it; a throwing hook fails the turn and the failure names the hook.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookErrorKind {
    /// Refused on purpose — the TypeScript build's `HookRefusal`.
    Refused,
    /// Broken: it failed, timed out, died, or answered something that is not a value of the point's type.
    Failed,
}

/// A listener's failure, carried out of a dispatch.
///
/// A listener builds one with [`HookError::refuse`] or [`HookError::fail`]; the bus then fills in the point
/// and the listener (its scope's name) if the listener did not, so the caller can say *which* hook failed
/// without knowing the plugins. An error that passes through an outer listener's `next` keeps the innermost
/// attribution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookError {
    kind: HookErrorKind,
    message: String,
    point: Option<String>,
    listener: Option<String>,
}

impl HookError {
    /// A deliberate refusal; `reason` is what the person reads after [`REFUSAL_PREFIX`].
    pub fn refuse(reason: impl Into<String>) -> Self {
        Self {
            kind: HookErrorKind::Refused,
            message: reason.into(),
            point: None,
            listener: None,
        }
    }

    /// A broken listener; `message` says what went wrong.
    pub fn fail(message: impl Into<String>) -> Self {
        Self {
            kind: HookErrorKind::Failed,
            message: message.into(),
            point: None,
            listener: None,
        }
    }

    /// Refused or failed.
    pub fn kind(&self) -> HookErrorKind {
        self.kind
    }

    /// Whether the listener meant to refuse.
    pub fn is_refusal(&self) -> bool {
        self.kind == HookErrorKind::Refused
    }

    /// The listener's own words, without any prefix.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The hook point the failure happened at, once the bus has attributed it.
    pub fn point(&self) -> Option<&str> {
        self.point.as_deref()
    }

    /// The name of the scope whose listener failed, once the bus has attributed it.
    pub fn listener(&self) -> Option<&str> {
        self.listener.as_deref()
    }

    /// Fill in the point and the listener where they are still missing; an existing attribution is kept.
    pub fn attributed(mut self, point: &str, listener: &str) -> Self {
        if self.point.is_none() {
            self.point = Some(point.to_owned());
        }
        if self.listener.is_none() {
            self.listener = Some(listener.to_owned());
        }
        self
    }
}

impl fmt::Display for HookError {
    /// A refusal reads `refused by hook: <reason>` (the prefix is not doubled when the reason already has it);
    /// a broken hook reads `a hook failed at <point> (<listener>) — <message>`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            HookErrorKind::Refused if self.message.starts_with(REFUSAL_PREFIX) => {
                f.write_str(&self.message)
            }
            HookErrorKind::Refused => write!(f, "{REFUSAL_PREFIX}{}", self.message),
            HookErrorKind::Failed => {
                f.write_str("a hook failed")?;
                if let Some(point) = &self.point {
                    write!(f, " at {point}")?;
                }
                if let Some(listener) = &self.listener {
                    write!(f, " ({listener})")?;
                }
                write!(f, " — {}", self.message)
            }
        }
    }
}

impl std::error::Error for HookError {}

/// The failures of a [`parallel`](crate::EventBus::parallel) dispatch: every listener ran, and these failed.
///
/// Cordis rejects with an `AggregateError` of every rejected listener; this is its Rust shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParallelError {
    /// One entry per failed listener, in registration order.
    pub errors: Vec<HookError>,
}

impl fmt::Display for ParallelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} listener(s) failed", self.errors.len())?;
        for error in &self.errors {
            write!(f, "; {error}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ParallelError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_reads_as_a_policy_decision_and_the_prefix_is_not_doubled() {
        let plain = HookError::refuse("this hook refuses writes");
        assert!(plain.is_refusal());
        assert_eq!(
            plain.to_string(),
            "refused by hook: this hook refuses writes"
        );
        let prefixed = HookError::refuse("refused by hook: this hook refuses to send the request");
        assert_eq!(
            prefixed.to_string(),
            "refused by hook: this hook refuses to send the request"
        );
    }

    #[test]
    fn a_broken_hook_names_the_point_and_the_listener() {
        let error =
            HookError::fail("this hook is broken").attributed("tools/pre-execute", "broken-hook");
        assert!(!error.is_refusal());
        assert_eq!(
            error.to_string(),
            "a hook failed at tools/pre-execute (broken-hook) — this hook is broken"
        );
        assert_eq!(HookError::fail("x").to_string(), "a hook failed — x");
    }

    #[test]
    fn the_innermost_attribution_is_kept() {
        let inner = HookError::fail("boom").attributed("model/request", "inner-hook");
        let passed_out = inner.attributed("model/request", "outer-hook");
        assert_eq!(passed_out.listener(), Some("inner-hook"));
        assert_eq!(passed_out.point(), Some("model/request"));
    }
}
