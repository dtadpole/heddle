//! One tool, one command, and what each is given and answers with.
//!
//! Ported from `src/tools/service.ts` (`ToolContext`, `ToolRunContext`, `ToolResult`, `ToolDefinition`,
//! `CommandDefinition`). A TypeScript tool is an object literal `{ spec, run }`; here it is anything that
//! implements [`Tool`], and [`tool_fn`] builds one from a spec and a closure for the same convenience.

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::upstream::{SandboxDenial, SandboxMode, SessionHandle, ToolSpec};

/// A tool call's arguments: the JSON object the model wrote.
///
/// A malformed argument string never reaches a tool as a crash; the loop hands it over as
/// `{"__unparsed": "<raw>"}` so the tool refuses it as bad arguments and the model is told what it wrote.
pub type ToolArgs = serde_json::Map<String, serde_json::Value>;

/// Where a tool writes a line about what happened; never a secret.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// The stable refusal codes a [`ToolResult`] carries, which a caller (and a model) branches on.
///
/// The spelling is the TypeScript build's, so a transcript reads the same from either binary.
pub mod codes {
    /// No tool by that name is registered.
    pub const UNKNOWN_TOOL: &str = "UNKNOWN_TOOL";
    /// No command by that name is registered.
    pub const UNKNOWN_COMMAND: &str = "UNKNOWN_COMMAND";
    /// The approval policy refused the action.
    pub const DENIED: &str = "DENIED";
    /// A `tools/pre-execute` listener refused the call.
    pub const HOOKED: &str = "HOOKED";
    /// The arguments were malformed.
    pub const BAD_ARGS: &str = "BAD_ARGS";
    /// The arguments break the tool's declared parameter schema (DSH's `INVALID_ARGS`).
    pub const INVALID_ARGS: &str = "INVALID_ARGS";
    /// A wider sandbox mode was asked for and not granted.
    pub const ESCALATION_REFUSED: &str = "ESCALATION_REFUSED";
    /// The sandbox refused the effect.
    pub const SANDBOX: &str = "SANDBOX";
    /// A confined mode was asked for and nothing can enforce it, or the runner failed.
    pub const SANDBOX_UNAVAILABLE: &str = "SANDBOX_UNAVAILABLE";
    /// The tool itself failed.
    pub const TOOL_FAILED: &str = "TOOL_FAILED";
    /// A command exceeded its wall time and was killed.
    pub const TIMEOUT: &str = "TIMEOUT";
    /// A command exited non-zero.
    pub const EXIT: &str = "EXIT";
    /// The turn was stopped before or while the call ran (written by the loop, not the registry).
    pub const INTERRUPTED: &str = "INTERRUPTED";
}

/// The context a caller passes in; the registry completes it with the call's resolved access mode.
///
/// Mirror of the TypeScript `ToolContext`. `cancel` is the call's Stop (`AbortSignal` there).
#[derive(Clone)]
pub struct ToolContext {
    /// Where the effect lands, already resolved and permitted.
    pub cwd: PathBuf,
    /// The session this call belongs to, when the tool is session-scoped. Passed by the loop, never taken
    /// from the model's arguments, so a call cannot name someone else's session.
    pub session: Option<SessionHandle>,
    /// Cancelled when the call should stop.
    pub cancel: Option<CancellationToken>,
    /// Where to write a line about what happened.
    pub log: LogSink,
}

impl ToolContext {
    /// A context for `cwd` with no session, no cancellation and a log line through `tracing`.
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            session: None,
            cancel: None,
            log: Arc::new(|message: &str| tracing::info!(target: "heddle_tools", "{message}")),
        }
    }

    /// The same context, scoped to a session.
    pub fn with_session(mut self, session: SessionHandle) -> Self {
        self.session = Some(session);
        self
    }

    /// The same context, stoppable through `cancel`.
    pub fn with_cancel(mut self, cancel: CancellationToken) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// The same context, logging through `log`.
    pub fn with_log(mut self, log: LogSink) -> Self {
        self.log = log;
        self
    }

    /// Write one line to the context's log.
    pub fn log(&self, message: &str) {
        (self.log)(message);
    }

    /// Whether the call has been stopped.
    pub fn is_cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
    }
}

impl fmt::Debug for ToolContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolContext")
            .field("cwd", &self.cwd)
            .field("session", &self.session.as_ref().map(|session| &session.id))
            .field("cancelled", &self.is_cancelled())
            .finish_non_exhaustive()
    }
}

/// The context a tool actually runs with: a [`ToolContext`] plus the access mode **this call** was
/// resolved under.
///
/// Separate on purpose, as in the TypeScript build: a tool cannot forget the mode because the type has
/// one, and a caller of [`ToolRegistry::call`](crate::ToolRegistry::call) cannot pass one because the
/// registry owns the field — the model's arguments are not a policy input. Dereferences to the
/// [`ToolContext`].
#[derive(Clone, Debug)]
pub struct ToolRunContext {
    context: ToolContext,
    mode: SandboxMode,
}

impl ToolRunContext {
    /// Complete a context with its mode. The registry is the only production caller; a unit test of a tool
    /// builds one directly.
    pub fn new(context: ToolContext, mode: SandboxMode) -> Self {
        Self { context, mode }
    }

    /// The mode this call runs under: the session's own record, or the deployment mode.
    pub fn mode(&self) -> SandboxMode {
        self.mode
    }

    /// The caller's part of the context.
    pub fn context(&self) -> &ToolContext {
        &self.context
    }
}

impl std::ops::Deref for ToolRunContext {
    type Target = ToolContext;

    fn deref(&self) -> &ToolContext {
        &self.context
    }
}

/// A refusal, with the reason a user is shown. Serialized as `{ "code", "message" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolError {
    /// One of [`codes`], or a tool's own stable code.
    pub code: String,
    /// The sentence a person and the model read.
    pub message: String,
}

/// What a tool answers with. Serialized in the TypeScript shape `{ output, error?, data? }`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ToolResult {
    /// The text a model reads back.
    pub output: String,
    /// A refusal, with the reason a user is shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolError>,
    /// Anything a caller wants to keep; never sent to the model unless it is also in `output`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
}

impl ToolResult {
    /// A successful result with this output and no data.
    pub fn ok(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            error: None,
            data: None,
        }
    }

    /// A refusal with an empty output — the shape of every registry refusal.
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            output: String::new(),
            error: Some(ToolError {
                code: code.into(),
                message: message.into(),
            }),
            data: None,
        }
    }

    /// The same result carrying `data`.
    pub fn with_data(mut self, data: serde_json::Map<String, serde_json::Value>) -> Self {
        self.data = Some(data);
        self
    }

    /// The same result carrying `error`, keeping its output (a timed-out command keeps what it printed).
    pub fn with_error(mut self, code: impl Into<String>, message: impl Into<String>) -> Self {
        self.error = Some(ToolError {
            code: code.into(),
            message: message.into(),
        });
        self
    }

    /// Whether this result is a refusal or a failure.
    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
}

/// How a tool's run can fail **unexpectedly** — the TypeScript `throw` inside `run`.
///
/// An expected refusal is an `Ok(ToolResult)` with `error` set. The registry turns a failure into a result
/// too, so a model turn is told rather than crashed: a [`SandboxDenial`] becomes `SANDBOX`, anything else
/// `TOOL_FAILED`.
#[derive(Debug, thiserror::Error)]
pub enum ToolFailure {
    /// The sandbox refused a path; reported as `SANDBOX`.
    #[error(transparent)]
    Sandbox(#[from] SandboxDenial),
    /// Anything else; reported as `TOOL_FAILED` with this message.
    #[error("{0}")]
    Failed(String),
}

impl From<std::io::Error> for ToolFailure {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// What a tool's run returns.
pub type ToolFuture<'a> = BoxFuture<'a, Result<ToolResult, ToolFailure>>;

/// One tool. `spec` is what the model is told; `run` is what happens.
///
/// Implemented by the built-ins, by the goal, todo, team and delegation tools of other crates, and by
/// [`ProcessTool`](crate::outside::ProcessTool) for a tool that lives in an outside process. A tool never
/// checks the approval policy itself: the registry gates every call before `run`.
pub trait Tool: Send + Sync {
    /// What the model is told. Must carry a non-blank name and description, or registration refuses it.
    fn spec(&self) -> &ToolSpec;

    /// Run one call under `context.mode()`.
    fn run<'a>(&'a self, args: ToolArgs, context: ToolRunContext) -> ToolFuture<'a>;

    /// Whether a call may run alongside the other parallel-safe calls of one model step (DSH's
    /// `isConcurrencySafe`). The default is exclusive: the call runs alone, a barrier between groups, which is the
    /// safe answer for a tool that writes. [`parallel_safe`] marks a tool.
    fn concurrency_safe(&self) -> bool {
        false
    }
}

/// `tool`, marked parallel-safe ([`Tool::concurrency_safe`]); its spec and its run are unchanged.
pub fn parallel_safe(tool: Arc<dyn Tool>) -> Arc<dyn Tool> {
    Arc::new(ParallelSafe(tool))
}

struct ParallelSafe(Arc<dyn Tool>);

impl Tool for ParallelSafe {
    fn spec(&self) -> &ToolSpec {
        self.0.spec()
    }

    fn run<'a>(&'a self, args: ToolArgs, context: ToolRunContext) -> ToolFuture<'a> {
        self.0.run(args, context)
    }

    fn concurrency_safe(&self) -> bool {
        true
    }
}

/// The closure a [`tool_fn`] tool runs.
pub type ToolFn = dyn Fn(ToolArgs, ToolRunContext) -> BoxFuture<'static, Result<ToolResult, ToolFailure>>
    + Send
    + Sync;

/// A tool made of a spec and a closure — the TypeScript `{ spec, run }` literal.
pub struct FnTool {
    spec: ToolSpec,
    run: Box<ToolFn>,
}

impl Tool for FnTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn run<'a>(&'a self, args: ToolArgs, context: ToolRunContext) -> ToolFuture<'a> {
        (self.run)(args, context)
    }
}

/// Build a tool from a spec and a closure returning a boxed future.
///
/// ```ignore
/// let shout = tool_fn(spec, |args, _ctx| Box::pin(async move { Ok(ToolResult::ok("wrote shout.txt")) }));
/// ```
pub fn tool_fn<F>(spec: ToolSpec, run: F) -> Arc<dyn Tool>
where
    F: Fn(ToolArgs, ToolRunContext) -> BoxFuture<'static, Result<ToolResult, ToolFailure>>
        + Send
        + Sync
        + 'static,
{
    Arc::new(FnTool {
        spec,
        run: Box::new(run),
    })
}

/// One command: a name a person types, sharing the registry's gates and result shape with a tool.
///
/// Mirror of the TypeScript `CommandDefinition`. The TypeScript build registers none today; the surface is
/// kept because `heddle commands` lists it.
pub trait Command: Send + Sync {
    /// The name a person types.
    fn name(&self) -> &str;
    /// What it does, one line.
    fn description(&self) -> &str;
    /// Run it. Commands run under no access mode: they get the caller's context unchanged.
    fn run<'a>(&'a self, args: Vec<String>, context: ToolContext) -> BoxFuture<'a, ToolResult>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_serializes_in_the_typescript_shape_without_absent_fields() {
        assert_eq!(
            serde_json::to_string(&ToolResult::ok("hi")).unwrap(),
            r#"{"output":"hi"}"#
        );
        let refused = ToolResult::refused(codes::DENIED, "no");
        assert_eq!(
            serde_json::to_string(&refused).unwrap(),
            r#"{"output":"","error":{"code":"DENIED","message":"no"}}"#
        );
        assert!(refused.is_error());
    }

    #[test]
    fn a_run_context_reports_its_mode_and_reads_through_to_the_caller_context() {
        let context = ToolRunContext::new(ToolContext::new("/w"), SandboxMode::ReadOnly);
        assert_eq!(context.mode(), SandboxMode::ReadOnly);
        assert_eq!(context.cwd, PathBuf::from("/w"));
        assert!(!context.is_cancelled());
    }

    #[test]
    fn a_cancelled_token_reads_as_cancelled() {
        let token = CancellationToken::new();
        let context = ToolContext::new("/w").with_cancel(token.clone());
        token.cancel();
        assert!(context.is_cancelled());
    }

    #[test]
    fn a_sandbox_denial_converts_to_the_sandbox_failure() {
        let denial = SandboxDenial {
            message: "outside".into(),
            path: "/etc/x".into(),
            mode: SandboxMode::WorkspaceWrite,
            workspace_root: "/w".into(),
        };
        assert!(matches!(ToolFailure::from(denial), ToolFailure::Sandbox(_)));
    }
}
