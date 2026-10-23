//! Provisional mirrors of types other crates own.
//!
//! Every crate's public API lands in the same round, so the types this crate needs from `heddle-llm`,
//! `heddle-sandbox` and `heddle-session` do not exist yet. Each item here copies the TypeScript shape it
//! stands for, field for field and with the same JSON spelling, and names the crate that owns it. When that
//! crate's API lands, the item becomes a `pub use` of the owner's type and this file shrinks; a caller that
//! imports it from `heddle_tools` does not change.
//!
//! Nothing in this file has behaviour beyond construction and display: the logic (path checks, confinement,
//! escalation, approvals) stays with its owner and reaches this crate through the ports in
//! [`crate::gates`].

use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// One tool the model may ask for, in the provider's shape.
///
/// Mirror of `heddle_llm::ToolSpec` (TypeScript `ToolSpec`, `src/llm/types.ts`). `parameters` is a JSON
/// Schema object, sent to the provider unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    /// What the model calls the tool by; unique within a registry.
    pub name: String,
    /// What the model is told the tool does; written for a model, not for a person reading the source.
    pub description: String,
    /// JSON Schema for the arguments.
    #[serde(default = "empty_object")]
    pub parameters: serde_json::Value,
}

fn empty_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// The three access modes a call can run under.
///
/// Mirror of `heddle_sandbox::SandboxMode` (TypeScript `SandboxMode`, `src/sandbox/policy.ts`), spelled the
/// same on the wire: `read-only`, `workspace-write`, `danger-full-access`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    /// Reads anywhere the policy admits; no writes.
    ReadOnly,
    /// Writes only under the workspace and the host's temporary areas.
    WorkspaceWrite,
    /// Unconfined.
    DangerFullAccess,
}

impl SandboxMode {
    /// The wire spelling, which is also what a person reads in a refusal.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

impl fmt::Display for SandboxMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a caller gets back when it opens a session.
///
/// Mirror of `heddle_session::SessionHandle` (TypeScript `SessionHandle`, `src/session/store.ts`). A tool
/// is handed one by the loop, never by the model's arguments, so a call cannot name another session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionHandle {
    /// The session id.
    pub id: String,
    /// The folder this session's files are in.
    pub dir: PathBuf,
    /// Where the transcript is.
    pub transcript: PathBuf,
    /// Where the metadata is.
    pub meta: PathBuf,
}

/// A path the sandbox refused under a mode.
///
/// Mirror of `heddle_sandbox::SandboxDenial` (TypeScript `SandboxDenial`, `src/sandbox/service.ts`). A tool
/// returns it through `?`; the registry reports it as the `SANDBOX` refusal.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SandboxDenial {
    /// The sentence a person and the model read.
    pub message: String,
    /// The path as resolved.
    pub path: PathBuf,
    /// The mode that refused it.
    pub mode: SandboxMode,
    /// The workspace the mode is relative to.
    pub workspace_root: PathBuf,
}

/// A confined mode was asked for and nothing on this host can enforce it.
///
/// Mirror of `heddle_sandbox::SandboxUnavailableError` (TypeScript `SandboxUnavailableError`,
/// `src/sandbox/backend.ts`). Fail closed: the command is refused, never run unconfined.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SandboxUnavailable {
    /// The mode that could not be enforced.
    pub mode: SandboxMode,
    /// What is missing, naming the platform's runner.
    pub message: String,
}

/// How much of the policy a runner enforces.
///
/// Mirror of `heddle_sandbox::SandboxEnforcement` (TypeScript `'full' | 'partial'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxEnforcement {
    /// The whole profile is enforced.
    Full,
    /// Part of it is, and the result says so.
    Partial,
}

/// What a runner's own failure looks like. Mirror of `heddle_sandbox::RunnerFailureRule`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerFailureRule {
    /// The exit codes this rule applies to; every code when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_exit_codes: Option<Vec<i32>>,
    /// Case-insensitive stderr substrings that mean the runner failed and the command never ran.
    pub fatal_signatures: Vec<String>,
}

/// One confined execution: the argv to spawn and the facts needed to classify what it did.
///
/// Mirror of `heddle_sandbox::ConfinedArgv` (TypeScript `ConfinedArgv`, `src/sandbox/backend.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfinedArgv {
    /// The wrapped argv: runner, profile arguments, separator, then the caller's argv.
    pub argv: Vec<String>,
    /// How much of the policy the runner enforces.
    pub enforcement: SandboxEnforcement,
    /// Case-insensitive stderr substrings this kernel produces for a denied file effect.
    pub denial_signatures: Vec<String>,
    /// How this runner's own failure looks.
    pub runner_failure_rules: Vec<RunnerFailureRule>,
}

/// What one settled command did, as far as the sandbox is concerned.
///
/// Mirror of `heddle_sandbox::SandboxOutcome` (TypeScript `SandboxOutcome`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxOutcome {
    /// The runner failed, so the command never ran; outranks a denial.
    RunnerFailure {
        /// The stderr line that matched.
        detail: String,
    },
    /// The command failed and its stderr speaks the backend's denial dialect.
    Denied,
    /// An ordinary result the sandbox has no opinion about.
    Exited,
}

/// The approval policy's answer for one action.
///
/// Mirror of `heddle_sandbox::ApprovalDecision` (TypeScript `ApprovalDecision`, `src/approvals/service.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalDecision {
    /// Whether the action may be taken.
    pub allowed: bool,
    /// Why not, in a sentence a person is shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Why an escalation did not happen. Mirror of `heddle_sandbox::EscalationRefusal`'s `code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EscalationRefusalCode {
    /// The requested value is not a mode a call can escalate to.
    Malformed,
    /// The requested mode is not strictly wider than the call's.
    NotWider,
    /// A person said no.
    Rejected,
    /// The call was stopped while the question was open.
    Cancelled,
    /// No one can answer on this run.
    Unavailable,
}

/// An escalation refusal with the sentence a person and the model read.
///
/// Mirror of `heddle_sandbox::EscalationRefusal` (TypeScript `EscalationRefusal`, `src/sandbox/escalation.ts`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EscalationRefusal {
    /// The stable code a caller branches on.
    pub code: EscalationRefusalCode,
    /// The sentence.
    pub message: String,
}

/// The noun an approval prompt uses for the escalated action. Mirror of TypeScript `'command' | 'operation'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EscalationSubject {
    /// A shell command (`bash`).
    Command,
    /// A file mutation or any other tool.
    Operation,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_modes_keep_the_typescript_spelling() {
        for (mode, wire) in [
            (SandboxMode::ReadOnly, "\"read-only\""),
            (SandboxMode::WorkspaceWrite, "\"workspace-write\""),
            (SandboxMode::DangerFullAccess, "\"danger-full-access\""),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), wire);
            assert_eq!(serde_json::from_str::<SandboxMode>(wire).unwrap(), mode);
            assert_eq!(format!("\"{mode}\""), wire);
        }
    }

    #[test]
    fn a_tool_spec_reads_and_writes_the_provider_shape() {
        let text =
            r#"{"name":"read_file","description":"Read a file.","parameters":{"type":"object"}}"#;
        let spec: ToolSpec = serde_json::from_str(text).unwrap();
        assert_eq!(spec.name, "read_file");
        assert_eq!(serde_json::to_string(&spec).unwrap(), text);
    }

    #[test]
    fn a_tool_spec_without_parameters_reads_as_an_empty_schema() {
        let spec: ToolSpec = serde_json::from_str(r#"{"name":"x","description":"y"}"#).unwrap();
        assert_eq!(spec.parameters, serde_json::json!({}));
    }
}
