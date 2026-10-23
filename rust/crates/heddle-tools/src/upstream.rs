//! The owners' types, re-exported under the names this crate published.
//!
//! `heddle-sandbox`'s vocabulary is **the owner's own**: [`SandboxMode`], the denial and unavailable errors,
//! [`ConfinedArgv`], [`SandboxOutcome`], [`ApprovalDecision`] and the escalation types are re-exported under
//! the names this crate published, so a caller names one type and the binary implements the gate ports over
//! `SandboxService`/`ApprovalService` without converting at every call (see [`crate::adapters`]).
//!
//! [`ToolSpec`] is `heddle-llm`'s type, so the registry's schemas, the agent loop's `PrepareOptions.tools` and
//! the model's `GenerateRequest.tools` are one type. [`SessionHandle`] is `heddle-session`'s. No mirror is left:
//! a caller importing any of these from `heddle_tools` names the owner's type, and the logic stays with its
//! owner, reaching this crate through the ports in [`crate::gates`].

// `heddle-llm` has landed, so the tool schema the model is told is the owner's own type: the registry's
// `describe()`, the agent loop's `PrepareOptions.tools` and the model's `GenerateRequest.tools` are one type
// with no conversion.
pub use heddle_llm::ToolSpec;

pub use heddle_sandbox::RefusalCode as EscalationRefusalCode;
pub use heddle_sandbox::SandboxUnavailableError as SandboxUnavailable;
pub use heddle_sandbox::{
    ApprovalDecision, ApprovalMode, ConfinedArgv, EscalationRefusal, EscalationSubject,
    RunnerFailureRule, SandboxDenial, SandboxEnforcement, SandboxMode, SandboxOutcome,
};

/// What a caller gets back when it opens a session: `heddle-session`'s own handle. A tool is handed one by the
/// loop, never by the model's arguments, so a call cannot name another session.
pub use heddle_session::SessionHandle;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owners_sandbox_modes_keep_the_typescript_spelling() {
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
    fn a_declared_tool_without_parameters_reads_as_an_empty_schema() {
        let tool: crate::protocol::DeclaredTool =
            serde_json::from_str(r#"{"name":"x","description":"y"}"#).unwrap();
        assert_eq!(tool.parameters, serde_json::json!({}));
    }
}
