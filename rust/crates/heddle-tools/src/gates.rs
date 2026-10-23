//! The ports the registry gates every call through.
//!
//! The TypeScript `ToolRegistry` is constructed with the approval service, the sandbox service and the
//! session service, and fires two waterfall hooks. Each of those belongs to another crate, so this crate
//! states only **what it asks of them** as a trait; the composing binary passes the real services (an
//! adapter per trait lives here once the owner's API lands), and a unit test passes a double.
//!
//! | Port | Owner of the real implementation | TypeScript |
//! |---|---|---|
//! | [`ApprovalGate`] | `heddle-sandbox` (approvals, escalation) | `ApprovalService.check`, `validateEscalationArgs`, `approveEscalation` |
//! | [`SandboxGate`] | `heddle-sandbox` | `SandboxService`, `classifyOutcome`, `sandboxPolicyStatement` |
//! | [`ModeResolver`] | `heddle-session` | `SessionService.effectiveMode` |
//! | [`ToolHooks`] | `heddle-events` | the `tools/pre-execute` and `tools/post-execute` waterfalls |

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use crate::tool::{ToolArgs, ToolResult};
use crate::upstream::{
    ApprovalDecision, ConfinedArgv, EscalationRefusal, EscalationSubject, SandboxDenial,
    SandboxMode, SandboxOutcome, SandboxUnavailable, SessionHandle,
};

/// The approval policy and the escalation ladder: whether an action may be taken at all.
///
/// Checked **before** the sandbox, because "outside the workspace" for a tool the policy had already
/// refused sends the reader to the wrong setting.
pub trait ApprovalGate: Send + Sync {
    /// Whether the action may be taken. A tool is checked by its name, a command as `command:<name>`.
    fn check(&self, action: &str) -> ApprovalDecision;

    /// Resolve one escalation before the call runs: validate the `sandbox_permissions` / `justification`
    /// pairing, then grant the requested mode (a repeat of the effective mode needs no approval; a wider one
    /// asks a person). The grant is this call's only; the session's mode is untouched.
    fn escalate<'a>(
        &'a self,
        request: EscalationRequest,
    ) -> BoxFuture<'a, Result<SandboxMode, EscalationError>>;
}

/// One escalation, as the registry hands it to the [`ApprovalGate`].
///
/// Mirror of the TypeScript `EscalationRequest`. The two raw argument values are passed as the model wrote
/// them — judged by the gate, never trusted — and `None` means the argument was absent.
#[derive(Debug, Clone)]
pub struct EscalationRequest {
    /// The tool being called.
    pub tool: String,
    /// The raw `sandbox_permissions` value.
    pub requested_mode: Option<serde_json::Value>,
    /// The raw `justification` value.
    pub justification: Option<serde_json::Value>,
    /// The mode the call would otherwise run under.
    pub effective_mode: SandboxMode,
    /// `command` for `bash`, `operation` for anything else.
    pub subject: EscalationSubject,
    /// The session id, when the call has one.
    pub session: Option<String>,
    /// The call's Stop, so a stop settles an open question as cancelled instead of waiting it out.
    pub cancel: Option<CancellationToken>,
}

/// Why an escalation did not produce a mode.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EscalationError {
    /// The pairing was malformed (`validateEscalationArgs` threw); reported as `BAD_ARGS`.
    #[error("{0}")]
    BadArgs(String),
    /// The ladder refused; reported as `ESCALATION_REFUSED`.
    #[error(transparent)]
    Refused(#[from] EscalationRefusal),
}

/// The sandbox: where a call's effect may land, and how a shell command is confined.
pub trait SandboxGate: Send + Sync {
    /// The workspace every relative path resolves against, and the cwd of a `bash` call.
    fn workspace_root(&self) -> &Path;

    /// The deployment's mode, which a call with no session runs under.
    fn default_mode(&self) -> SandboxMode;

    /// The modes a call may ask to escalate to on this host; empty when nothing can confine, in which case
    /// the escalation fields are not offered at all.
    fn escalation_targets(&self) -> Vec<SandboxMode>;

    /// The execution policy for `mode`, as the status route reports it (TypeScript `SandboxExecutionPolicy`).
    fn policy(&self, mode: SandboxMode) -> serde_json::Value;

    /// The sentence the loop puts in the runtime context for `mode` (TypeScript `sandboxPolicyStatement`).
    fn policy_statement(&self, mode: SandboxMode) -> String;

    /// Resolve `path` against the workspace and refuse it if `mode` does not admit a write there.
    fn assert_writable(&self, path: &str, mode: SandboxMode) -> Result<PathBuf, SandboxDenial>;

    /// Resolve `path` against the workspace and refuse it if `mode` does not admit a read there.
    fn assert_readable(&self, path: &str, mode: SandboxMode) -> Result<PathBuf, SandboxDenial>;

    /// Wrap one exact argv so the whole process tree runs under `mode`, or fail closed.
    fn confine(
        &self,
        argv: &[String],
        mode: SandboxMode,
    ) -> Result<ConfinedArgv, SandboxUnavailable>;

    /// Classify one settled command: a runner failure outranks a denial, and a denial needs a non-zero exit
    /// and the backend's stderr dialect. `confined` is `None` for an unconfined call, which is never denied.
    fn classify_outcome(
        &self,
        exit_code: i32,
        stderr: &str,
        confined: Option<&ConfinedArgv>,
    ) -> SandboxOutcome;
}

/// The per-session access mode: a session's own record outranks the deployment default.
pub trait ModeResolver: Send + Sync {
    /// The mode a call in `session` runs under, `default` when the session recorded none.
    fn effective_mode(&self, session: &SessionHandle, default: SandboxMode) -> SandboxMode;
}

/// A [`ModeResolver`] for a composition without sessions: every call runs under the default.
#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultModes;

impl ModeResolver for DefaultModes {
    fn effective_mode(&self, _session: &SessionHandle, default: SandboxMode) -> SandboxMode {
        default
    }
}

/// What a hook is shown of a call.
#[derive(Debug, Clone, Copy)]
pub struct ToolCall<'a> {
    /// The tool's name.
    pub name: &'a str,
    /// The arguments as the model wrote them.
    pub args: &'a ToolArgs,
}

/// A `tools/pre-execute` listener's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreExecute {
    /// Let the call run.
    Allowed,
    /// Refuse it; reported as `HOOKED` with the reason, or `a hook refused '<name>'`.
    Refused {
        /// The sentence the model is told.
        reason: Option<String>,
    },
}

/// A `tools/pre-execute` listener that failed rather than answered.
///
/// In the TypeScript build the waterfall runs before the call's `try`, so a throwing listener escapes
/// `ToolRegistry.call`, and the agent loop's catch answers the call with `INTERRUPTED` and the listener's
/// message (`src/agent/loop.ts`): the model is told, and the turn goes on.
/// [`ToolRegistry::try_call`](crate::ToolRegistry::try_call) surfaces it so the loop can do exactly that.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ToolHookError {
    /// The listener's sentence, attributed by the bus to the point and the scope.
    pub message: String,
}

impl ToolHookError {
    /// A failure with this sentence.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// The two hook points around a tool call, modelled on DSH's `tools/pre-execute` and `tools/post-execute`.
///
/// Both are waterfalls in the TypeScript build. `pre_execute` may stop a call but cannot rewrite its
/// arguments (DSH's rule, kept), and may fail ([`ToolHookError`]); `post_execute` may replace the result —
/// how a policy redacts a secret or spills a huge result — and, because the TypeScript build runs it inside
/// the call's `try`, a failing listener there is a `TOOL_FAILED` result its implementation returns. The
/// defaults do nothing, so [`NoToolHooks`] is the composition without listeners.
pub trait ToolHooks: Send + Sync {
    /// Before the call runs, after the approval gate.
    fn pre_execute(&self, call: &ToolCall<'_>) -> Result<PreExecute, ToolHookError> {
        let _ = call;
        Ok(PreExecute::Allowed)
    }

    /// After the call ran; returns what stands in the result's place.
    fn post_execute(&self, call: &ToolCall<'_>, result: ToolResult) -> ToolResult {
        let _ = call;
        result
    }
}

/// A [`ToolHooks`] with no listeners.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoToolHooks;

impl ToolHooks for NoToolHooks {}

/// Everything a [`ToolRegistry`](crate::ToolRegistry) gates through, in one value.
#[derive(Clone)]
pub struct ToolGates {
    /// The approval policy and escalation ladder.
    pub approvals: Arc<dyn ApprovalGate>,
    /// The sandbox.
    pub sandbox: Arc<dyn SandboxGate>,
    /// The per-session access mode.
    pub modes: Arc<dyn ModeResolver>,
    /// The hook points.
    pub hooks: Arc<dyn ToolHooks>,
}
