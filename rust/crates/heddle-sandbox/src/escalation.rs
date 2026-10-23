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
    if permissions.is_some() && justification.is_none() {
        return Err(EscalationArgsError {
            message: "invalid escalation: sandbox_permissions requires a justification".to_owned(),
        });
    }
    if justification.is_some() && permissions.is_none() {
        return Err(EscalationArgsError {
            message:
                "invalid escalation: justification is only valid together with sandbox_permissions"
                    .to_owned(),
        });
    }
    if let Some(justification) = justification {
        let sentence = justification
            .as_str()
            .is_some_and(|text| !text.trim().is_empty());
        if !sentence {
            return Err(EscalationArgsError {
                message: "invalid justification: expected a non-empty sentence".to_owned(),
            });
        }
    }
    Ok(())
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
    let Some(target) = request.requested_mode.as_str().and_then(SandboxMode::parse) else {
        return Err(EscalationRefusal {
            code: RefusalCode::Malformed,
            message: format!(
                "'{}' is not a sandbox mode that a call can escalate to",
                crate::js::string_of(Some(&request.requested_mode))
            ),
        });
    };
    let effective = request.effective_mode;
    if target == effective {
        return Ok(target);
    }
    if !wider_modes(effective).contains(&target) {
        return Err(EscalationRefusal {
            code: RefusalCode::NotWider,
            message: format!(
                "an escalation to '{target}' is not strictly wider than this call's '{effective}' mode"
            ),
        });
    }
    let justification = request.justification;
    let subject = request.subject;
    let ask = ApprovalAsk {
        tool: request.tool,
        reason: format!("escalate sandbox to {target}: {justification}"),
        display_reason: Some(format!(
            "Allow this {subject} with {target} permissions: {justification}"
        )),
        session: request.session,
    };
    match approval.request(ask, cancel).await {
        ApprovalOutcome::AllowedOnce => Ok(target),
        outcome => Err(refusal_for(outcome, target, effective, subject)),
    }
}

/// The refusal sentence for an ask that was answered no, withdrawn, or not answerable.
fn refusal_for(
    outcome: ApprovalOutcome,
    target: SandboxMode,
    effective: SandboxMode,
    subject: EscalationSubject,
) -> EscalationRefusal {
    let (code, message) = match outcome {
        ApprovalOutcome::Rejected => (
            RefusalCode::Rejected,
            format!(
                "the request to run this {subject} with '{target}' permissions was rejected; the call stays under '{effective}'"
            ),
        ),
        ApprovalOutcome::Cancelled => (
            RefusalCode::Cancelled,
            format!(
                "the request to run this {subject} with '{target}' permissions was cancelled; the call stays under '{effective}'"
            ),
        ),
        // `allowed-once` was handled by the caller; treating it as unavailable keeps this total rather than
        // panicking on an outcome the caller forgot.
        ApprovalOutcome::Unavailable | ApprovalOutcome::AllowedOnce => (
            RefusalCode::Unavailable,
            format!(
                "no one can approve running this {subject} with '{target}' permissions on this run; the call stays under '{effective}'"
            ),
        ),
    };
    EscalationRefusal { code, message }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::Mutex;

    use serde_json::{Value, json};

    use super::{
        ESCALATION_TARGETS, EscalationApproval, EscalationRequest, EscalationSubject, RefusalCode,
        approve_escalation, validate_escalation_args, wider_modes,
    };
    use crate::approvals::{ApprovalAsk, ApprovalOutcome};
    use crate::mode::SandboxMode;

    const JUSTIFICATION: &str = "need to write the generated file";

    /// An approval channel that records the ask and answers with one fixed outcome.
    struct Recorder {
        outcome: ApprovalOutcome,
        asks: Mutex<Vec<ApprovalAsk>>,
    }

    impl Recorder {
        fn new(outcome: ApprovalOutcome) -> Recorder {
            Recorder {
                outcome,
                asks: Mutex::new(Vec::new()),
            }
        }

        fn asks(&self) -> Vec<ApprovalAsk> {
            self.asks.lock().unwrap().clone()
        }
    }

    impl EscalationApproval for Recorder {
        fn request<C>(
            &self,
            ask: ApprovalAsk,
            _cancel: C,
        ) -> impl Future<Output = ApprovalOutcome> + Send
        where
            C: Future<Output = ()> + Send,
        {
            self.asks.lock().unwrap().push(ask);
            std::future::ready(self.outcome)
        }
    }

    fn request(tool: &str, requested: Value, effective: SandboxMode) -> EscalationRequest {
        EscalationRequest {
            tool: tool.to_owned(),
            requested_mode: requested,
            effective_mode: effective,
            justification: JUSTIFICATION.to_owned(),
            subject: EscalationSubject::for_tool(tool),
            session: Some("session-1".to_owned()),
        }
    }

    #[test]
    fn the_escalation_targets_are_the_two_wider_modes() {
        assert_eq!(
            ESCALATION_TARGETS,
            [SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess]
        );
        assert_eq!(wider_modes(SandboxMode::ReadOnly).len(), 2);
        assert_eq!(
            wider_modes(SandboxMode::WorkspaceWrite),
            &[SandboxMode::DangerFullAccess]
        );
        assert!(wider_modes(SandboxMode::DangerFullAccess).is_empty());
    }

    #[test]
    fn the_argument_pairing_errors_fire_in_the_typescript_order() {
        let permissions = || json!("workspace-write");
        let reason = || json!(JUSTIFICATION);

        assert_eq!(validate_escalation_args(None, None), Ok(()));
        assert_eq!(
            validate_escalation_args(Some(&permissions()), None),
            Err(super::EscalationArgsError {
                message: "invalid escalation: sandbox_permissions requires a justification"
                    .to_owned(),
            })
        );
        assert_eq!(
            validate_escalation_args(None, Some(&reason())),
            Err(super::EscalationArgsError {
                message:
                    "invalid escalation: justification is only valid together with sandbox_permissions"
                        .to_owned(),
            })
        );
        for bad in [json!(""), json!("   "), json!(7), json!(null), json!(["x"])] {
            assert_eq!(
                validate_escalation_args(Some(&permissions()), Some(&bad)),
                Err(super::EscalationArgsError {
                    message: "invalid justification: expected a non-empty sentence".to_owned(),
                }),
                "{bad:?} is not a non-empty sentence"
            );
        }
        assert_eq!(
            validate_escalation_args(Some(&permissions()), Some(&reason())),
            Ok(())
        );
        assert_eq!(
            validate_escalation_args(None, Some(&json!(null))),
            Err(super::EscalationArgsError {
                message:
                    "invalid escalation: justification is only valid together with sandbox_permissions"
                        .to_owned(),
            }),
            "a present null is still a present justification"
        );
    }

    #[tokio::test]
    async fn a_value_that_is_not_a_mode_is_malformed_and_asks_nobody() {
        for (requested, quoted) in [
            (json!("workspace"), "workspace"),
            (json!(1), "1"),
            (json!(null), "null"),
            (json!({"mode": "read-only"}), "[object Object]"),
        ] {
            let recorder = Recorder::new(ApprovalOutcome::AllowedOnce);
            let refusal = approve_escalation(
                request("write_file", requested, SandboxMode::WorkspaceWrite),
                &recorder,
                std::future::pending(),
            )
            .await
            .unwrap_err();
            assert_eq!(refusal.code, RefusalCode::Malformed);
            assert_eq!(
                refusal.message,
                format!("'{quoted}' is not a sandbox mode that a call can escalate to")
            );
            assert!(recorder.asks().is_empty(), "nobody was asked");
        }
    }

    #[tokio::test]
    async fn repeating_the_effective_mode_grants_it_without_asking() {
        let recorder = Recorder::new(ApprovalOutcome::Rejected);
        let granted = approve_escalation(
            request(
                "write_file",
                json!("workspace-write"),
                SandboxMode::WorkspaceWrite,
            ),
            &recorder,
            std::future::pending(),
        )
        .await;
        assert_eq!(granted, Ok(SandboxMode::WorkspaceWrite));
        assert!(
            recorder.asks().is_empty(),
            "the same boundary needs no question"
        );
    }

    #[tokio::test]
    async fn a_mode_that_is_not_strictly_wider_is_refused_without_asking() {
        for (requested, effective) in [
            (json!("read-only"), SandboxMode::WorkspaceWrite),
            (json!("read-only"), SandboxMode::DangerFullAccess),
            (json!("workspace-write"), SandboxMode::DangerFullAccess),
        ] {
            let recorder = Recorder::new(ApprovalOutcome::AllowedOnce);
            let target = requested.as_str().unwrap().to_owned();
            let refusal = approve_escalation(
                request("write_file", requested, effective),
                &recorder,
                std::future::pending(),
            )
            .await
            .unwrap_err();
            assert_eq!(refusal.code, RefusalCode::NotWider);
            assert_eq!(
                refusal.message,
                format!(
                    "an escalation to '{target}' is not strictly wider than this call's '{effective}' mode"
                )
            );
            assert!(recorder.asks().is_empty());
        }
    }

    #[tokio::test]
    async fn a_wider_mode_asks_with_the_justification_verbatim_and_grants_one_call() {
        let recorder = Recorder::new(ApprovalOutcome::AllowedOnce);
        let granted = approve_escalation(
            request(
                "write_file",
                json!("workspace-write"),
                SandboxMode::ReadOnly,
            ),
            &recorder,
            std::future::pending(),
        )
        .await;
        assert_eq!(granted, Ok(SandboxMode::WorkspaceWrite));

        let asks = recorder.asks();
        assert_eq!(asks.len(), 1, "exactly one question");
        assert_eq!(asks[0].tool, "write_file");
        assert_eq!(
            asks[0].reason,
            format!("escalate sandbox to workspace-write: {JUSTIFICATION}")
        );
        assert_eq!(
            asks[0].display_reason.as_deref(),
            Some(
                "Allow this operation with workspace-write permissions: need to write the generated file"
            )
        );
        assert_eq!(asks[0].session.as_deref(), Some("session-1"));
    }

    #[tokio::test]
    async fn a_shell_escalation_asks_about_a_command() {
        let recorder = Recorder::new(ApprovalOutcome::AllowedOnce);
        approve_escalation(
            request(
                "bash",
                json!("danger-full-access"),
                SandboxMode::WorkspaceWrite,
            ),
            &recorder,
            std::future::pending(),
        )
        .await
        .expect("granted once");
        let asks = recorder.asks();
        assert_eq!(
            asks[0].display_reason.as_deref(),
            Some(
                "Allow this command with danger-full-access permissions: need to write the generated file"
            )
        );
    }

    #[tokio::test]
    async fn each_no_answer_maps_to_its_typescript_sentence() {
        let cases = [
            (
                ApprovalOutcome::Rejected,
                RefusalCode::Rejected,
                "the request to run this command with 'danger-full-access' permissions was rejected; the call stays under 'workspace-write'",
            ),
            (
                ApprovalOutcome::Cancelled,
                RefusalCode::Cancelled,
                "the request to run this command with 'danger-full-access' permissions was cancelled; the call stays under 'workspace-write'",
            ),
            (
                ApprovalOutcome::Unavailable,
                RefusalCode::Unavailable,
                "no one can approve running this command with 'danger-full-access' permissions on this run; the call stays under 'workspace-write'",
            ),
        ];
        for (outcome, code, message) in cases {
            let recorder = Recorder::new(outcome);
            let refusal = approve_escalation(
                request(
                    "bash",
                    json!("danger-full-access"),
                    SandboxMode::WorkspaceWrite,
                ),
                &recorder,
                std::future::pending(),
            )
            .await
            .unwrap_err();
            assert_eq!(refusal.code, code);
            assert_eq!(refusal.message, message);
        }
    }

    #[tokio::test]
    async fn a_file_escalation_refusal_says_operation_not_command() {
        let recorder = Recorder::new(ApprovalOutcome::Unavailable);
        let refusal = approve_escalation(
            request(
                "write_file",
                json!("workspace-write"),
                SandboxMode::ReadOnly,
            ),
            &recorder,
            std::future::pending(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            refusal.message,
            "no one can approve running this operation with 'workspace-write' permissions on this run; the call stays under 'read-only'"
        );
    }

    #[test]
    fn a_tool_names_its_subject_by_whether_it_is_a_shell() {
        assert_eq!(
            EscalationSubject::for_tool("bash"),
            EscalationSubject::Command
        );
        assert_eq!(
            EscalationSubject::for_tool("write_file"),
            EscalationSubject::Operation
        );
        assert_eq!(EscalationSubject::Command.as_str(), "command");
        assert_eq!(EscalationSubject::Operation.as_str(), "operation");
    }

    #[test]
    fn a_refusal_reports_under_the_tool_code() {
        assert_eq!(super::EscalationRefusal::TOOL_CODE, "ESCALATION_REFUSED");
        assert_eq!(RefusalCode::Malformed.as_str(), "MALFORMED");
        assert_eq!(RefusalCode::NotWider.as_str(), "NOT_WIDER");
        assert_eq!(RefusalCode::Rejected.as_str(), "REJECTED");
        assert_eq!(RefusalCode::Cancelled.as_str(), "CANCELLED");
        assert_eq!(RefusalCode::Unavailable.as_str(), "UNAVAILABLE");
    }

    #[tokio::test]
    async fn the_ladder_runs_with_the_approval_service_as_its_channel() {
        use std::sync::Arc;
        use std::time::Duration;

        use crate::approvals::{Answer, ApprovalService, ApprovalsConfig};

        let service = Arc::new(ApprovalService::new(ApprovalsConfig::default()));
        let _guard = service.attach_answerer();
        let channel = Arc::clone(&service);
        let handle = tokio::spawn(async move {
            approve_escalation(
                request(
                    "write_file",
                    json!("workspace-write"),
                    SandboxMode::ReadOnly,
                ),
                &*channel,
                std::future::pending::<()>(),
            )
            .await
        });

        let published = loop {
            if let Some(published) = service.pending_requests().into_iter().next() {
                break published;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        };
        assert_eq!(published.tool, "write_file");
        assert_eq!(
            published.reason,
            format!("escalate sandbox to workspace-write: {JUSTIFICATION}")
        );
        assert_eq!(
            published.display_reason,
            format!("Allow this operation with workspace-write permissions: {JUSTIFICATION}"),
            "the justification reaches the person verbatim"
        );

        assert!(service.answer(&published.id, Answer::AllowedOnce));
        assert_eq!(
            handle.await.expect("the escalation task"),
            Ok(SandboxMode::WorkspaceWrite),
            "one approved wider retry"
        );
    }

    #[tokio::test]
    async fn a_rejected_escalation_through_the_service_names_the_subject_and_modes() {
        use std::sync::Arc;
        use std::time::Duration;

        use crate::approvals::{Answer, ApprovalService, ApprovalsConfig};

        let service = Arc::new(ApprovalService::new(ApprovalsConfig::default()));
        let _guard = service.attach_answerer();
        let channel = Arc::clone(&service);
        let handle = tokio::spawn(async move {
            approve_escalation(
                request(
                    "bash",
                    json!("danger-full-access"),
                    SandboxMode::WorkspaceWrite,
                ),
                &*channel,
                std::future::pending::<()>(),
            )
            .await
        });

        let published = loop {
            if let Some(published) = service.pending_requests().into_iter().next() {
                break published;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        };
        assert_eq!(
            published.display_reason,
            format!("Allow this command with danger-full-access permissions: {JUSTIFICATION}")
        );
        assert!(service.answer(&published.id, Answer::Rejected));
        let refusal = handle
            .await
            .expect("the escalation task")
            .expect_err("a rejection refuses the call");
        assert_eq!(refusal.code, RefusalCode::Rejected);
        assert_eq!(
            refusal.message,
            "the request to run this command with 'danger-full-access' permissions was rejected; the call stays under 'workspace-write'"
        );
    }
}
