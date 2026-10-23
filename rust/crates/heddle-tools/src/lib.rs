//! `heddle-tools` — the tool registry, the built-in tools, and outside tools as processes.
//!
//! Ported from the TypeScript build: `src/tools/service.ts`, `src/tools/builtin.ts`, `src/plugins/tools.ts`.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/40-pluggable-tools`.
//!
//! The public API is the contract other crates build against; every body is ported, with its unit tests
//! beside it, and the port plan in `INDEX.md` records what each step covers.
//!
//! | Module | What it is |
//! |---|---|
//! | [`tool`] | one tool ([`Tool`]), one command, their contexts and [`ToolResult`] |
//! | [`registry`] | [`ToolRegistry`]: registration, the allow list, and the gate order of every call |
//! | [`gates`] | the ports the registry gates through — approvals, sandbox, per-session mode, hooks |
//! | [`builtin`] | `write_file`, `read_file`, `list_dir`, `bash` |
//! | [`config`] | the `tools` configuration row |
//! | [`protocol`] | the outside-component wire: line-delimited JSON-RPC 2.0 on stdio |
//! | [`outside`] | starting an outside component and forwarding its tools' calls |
//! | [`upstream`] | `heddle-sandbox`'s own types, and provisional mirrors of `heddle-llm`/`heddle-session` types |
//! | [`adapters`] | the gate ports over the real `heddle-sandbox` and `heddle-session` services |
//! | [`command`] | the `tools` and `commands` commands, in the owning crate (D-043) |
//!
//! Background jobs are named in this crate's description but have no TypeScript source and no verifier
//! yet; they are not part of this API until the oracle has them.

pub mod adapters;
pub mod builtin;
pub mod command;
pub mod config;
pub mod gates;
pub mod outside;
pub mod protocol;
pub mod registry;
pub mod tool;
pub mod upstream;

pub use builtin::{BuiltinOptions, builtin_tools, escalation_fields};
pub use config::ToolsConfig;
pub use gates::{
    ApprovalGate, DefaultModes, EscalationError, EscalationRequest, ModeResolver, NoToolHooks,
    PreExecute, SandboxGate, ToolCall, ToolGates, ToolHooks,
};
pub use outside::{OutsideComponent, OutsideComponentSpec, OutsideError, ProcessTool};
pub use registry::{CommandSummary, RegistrationError, ToolRegistry};
pub use tool::{
    Command, LogSink, Tool, ToolArgs, ToolContext, ToolError, ToolFailure, ToolFuture, ToolResult,
    ToolRunContext, codes, tool_fn,
};
pub use upstream::{
    ApprovalDecision, ApprovalMode, ConfinedArgv, EscalationRefusal, EscalationRefusalCode,
    EscalationSubject, RunnerFailureRule, SandboxDenial, SandboxEnforcement, SandboxMode,
    SandboxOutcome, SandboxUnavailable, SessionHandle, ToolSpec,
};

/// The cancellation token every call carries for a Stop — the TypeScript build's `AbortSignal`.
pub use tokio_util::sync::CancellationToken;
