//! The escalation ladder: how one call may ask for a wider mode, and how that ask is approved.
//!
//! Ported from `src/sandbox/escalation.ts`. A denied call may be retried **once** at a strictly wider mode with
//! a one-sentence justification, and the retry is approved by a person **before** it executes. The ladder is
//! checked at execution, never baked into a tool schema: schemas are registry-global while the effective mode is
//! per-call truth. A grant is the returned mode for that one call; the session's own mode is never touched.

use std::fmt;
use std::future::Future;

use serde_json::Value;

use crate::approvals::{ApprovalAsk, ApprovalOutcome};
use crate::mode::SandboxMode;

/// Every mode a call could ever escalate **to** (`ESCALATION_TARGETS`). Advertised whole whenever the host can
/// confine — cutting it to the modes above the deployment default would strand a session switched below it.
pub const ESCALATION_TARGETS: [SandboxMode; 2] =
    [SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess];

/// The strictly-wider table (`WIDER_MODES`): what a call whose effective mode is `mode` may escalate to.
pub const fn wider_modes(mode: SandboxMode) -> &'static [SandboxMode] {
    match mode {
        SandboxMode::ReadOnly => &[SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess],
        SandboxMode::WorkspaceWrite => &[SandboxMode::DangerFullAccess],
        SandboxMode::DangerFullAccess => &[],
    }
}

/// The family's noun for the escalated action, as the question and the refusal say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EscalationSubject {
    /// A shell (`bash`): "this command".
    Command,
    /// A file mutation: "this operation".
    Operation,
}

impl EscalationSubject {
    /// `command` or `operation`.
    pub const fn as_str(self) -> &'static str {
        match self {
            EscalationSubject::Command => "command",
            EscalationSubject::Operation => "operation",
        }
    }

    /// The registry's rule: `bash` asks about a command, every other tool about an operation.
    pub fn for_tool(tool: &str) -> EscalationSubject {
        if tool == "bash" {
            EscalationSubject::Command
        } else {
            EscalationSubject::Operation
        }
    }
}

impl fmt::Display for EscalationSubject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A malformed `sandbox_permissions` / `justification` pairing; the registry reports it under `BAD_ARGS`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EscalationArgsError {
    /// One of the three TypeScript sentences, verbatim.
    pub message: String,
}

/// Validate the pairing a tool schema cannot express (`validateEscalationArgs`).
///
/// `None` is an absent argument; `Some(Value::Null)` is present (JavaScript's `undefined` versus `null`).
/// In order: permissions without a justification → `invalid escalation: sandbox_permissions requires a
/// justification`; a justification without permissions → `invalid escalation: justification is only valid
/// together with sandbox_permissions`; a justification that is not a string with non-whitespace content →
/// `invalid justification: expected a non-empty sentence`. Two absences are valid.
pub fn validate_escalation_args(
    permissions: Option<&Value>,
    justification: Option<&Value>,
) -> Result<(), EscalationArgsError> {
    let _ = (permissions, justification);
    todo!("port validateEscalationArgs from src/sandbox/escalation.ts")
}

/// Why an escalation did not happen, as a stable code a caller can report rather than guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefusalCode {
    /// The requested value is not a mode a call can escalate to.
    Malformed,
    /// The requested mode is not strictly wider than the effective one.
    NotWider,
    /// A person said no.
    Rejected,
    /// The ask was withdrawn: a Stop, or the answer timeout.
    Cancelled,
    /// No one could answer on this run.
    Unavailable,
}

impl RefusalCode {
    /// `MALFORMED`, `NOT_WIDER`, `REJECTED`, `CANCELLED` or `UNAVAILABLE`.
    pub const fn as_str(self) -> &'static str {
        match self {
            RefusalCode::Malformed => "MALFORMED",
            RefusalCode::NotWider => "NOT_WIDER",
            RefusalCode::Rejected => "REJECTED",
            RefusalCode::Cancelled => "CANCELLED",
            RefusalCode::Unavailable => "UNAVAILABLE",
        }
    }
}

/// An escalation that did not happen (`EscalationRefusal`). The registry reports it under
/// [`EscalationRefusal::TOOL_CODE`] with [`EscalationRefusal::message`] as the tool result's message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EscalationRefusal {
    /// Why.
    pub code: RefusalCode,
    /// The sentence a person and the model read. Verifiers match `rejected` and `no one can approve`.
    pub message: String,
}

impl EscalationRefusal {
    /// The tool-result error code every refusal is reported under.
    pub const TOOL_CODE: &'static str = "ESCALATION_REFUSED";
}

/// What one escalation request is judged on (`EscalationRequest`).
#[derive(Debug, Clone, PartialEq)]
pub struct EscalationRequest {
    /// The tool asking.
    pub tool: String,
    /// The raw `sandbox_permissions` value, judged here rather than trusted.
    pub requested_mode: Value,
    /// The call's effective mode: the session's own, or the deployment default.
    pub effective_mode: SandboxMode,
    /// The model's one-sentence reason, already validated by [`validate_escalation_args`]; carried verbatim.
    pub justification: String,
    /// `command` for a shell, `operation` for a file mutation.
    pub subject: EscalationSubject,
    /// The session the call belongs to — the page draws the card only for its own session.
    pub session: Option<String>,
}

/// The minimal approval channel the ladder needs (`EscalationApproval`); [`crate::ApprovalService`]
/// implements it, and a test supplies a double.
pub trait EscalationApproval {
    /// Ask one question and wait for its outcome; `cancel` resolving settles it as
    /// [`ApprovalOutcome::Cancelled`] (a Stop must end the wait, not the answer timeout).
    fn request<C>(
        &self,
        ask: ApprovalAsk,
        cancel: C,
    ) -> impl Future<Output = ApprovalOutcome> + Send
    where
        C: Future<Output = ()> + Send;
}

/// Resolve one escalation before anything executes (`approveEscalation`).
///
/// - a requested value that is not a mode word → [`RefusalCode::Malformed`]:
///   `'<value>' is not a sandbox mode that a call can escalate to` (the value as JavaScript's `String()` shows
///   it);
/// - the effective mode itself → granted **without** asking (it is the same boundary);
/// - a mode not in [`wider_modes`] of the effective one → [`RefusalCode::NotWider`]:
///   `an escalation to '<target>' is not strictly wider than this call's '<effective>' mode`;
/// - otherwise one ask, with `reason` = `escalate sandbox to <target>: <justification>` and `display_reason` =
///   `Allow this <subject> with <target> permissions: <justification>`: `allowed-once` grants `<target>`;
///   `rejected` → `the request to run this <subject> with '<target>' permissions was rejected; the call stays
///   under '<effective>'`; `cancelled` → the same with `was cancelled`; `unavailable` → `no one can approve
///   running this <subject> with '<target>' permissions on this run; the call stays under '<effective>'`.
///
/// The returned mode is the caller's per-call policy; nothing here executes anything.
pub async fn approve_escalation<A, C>(
    request: EscalationRequest,
    approval: &A,
    cancel: C,
) -> Result<SandboxMode, EscalationRefusal>
where
    A: EscalationApproval + Sync,
    C: Future<Output = ()> + Send,
{
    let _ = (request, approval, cancel);
    todo!("port approveEscalation from src/sandbox/escalation.ts")
}
