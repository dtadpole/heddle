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
//! | [`background`] | the seam `bash`'s `run_in_background` reaches the jobs row (`heddle-jobs`) through |
//! | [`config`] | the `tools` configuration row |
//! | [`protocol`] | the outside-component wire: line-delimited JSON-RPC 2.0 on stdio |
//! | [`outside`] | starting an outside component and forwarding its tools' calls |
//! | [`upstream`] | `heddle-sandbox`'s own types, and provisional mirrors of `heddle-llm`/`heddle-session` types |
//! | [`adapters`] | the gate ports over the real `heddle-sandbox` and `heddle-session` services |
//! | [`command`] | the `tools` and `commands` commands, in the owning crate (D-043) |
//!
//! Background jobs themselves live in `heddle-jobs`; this crate carries only the seam `bash` hands a background
//! call to ([`background`]), which is unattached unless the jobs row is loaded.

pub mod adapters;
pub mod background;
pub mod builtin;
pub mod command;
pub mod config;
pub mod gates;
pub mod outside;
pub mod protocol;
pub mod registry;
pub mod tool;
pub mod upstream;
pub mod validate;

pub use background::{
    BashBackground, BashBackgroundDetach, RUN_IN_BACKGROUND_DESCRIPTION, attach_bash_background,
    background_for,
};
pub use builtin::{BuiltinOptions, ShellLaunch, builtin_tools, escalation_fields, launch_shell};
pub use config::ToolsConfig;
pub use gates::{
    ApprovalGate, DefaultModes, EscalationError, EscalationRequest, ModeResolver, NoToolHooks,
    PreExecute, SandboxGate, ToolCall, ToolGates, ToolHookError, ToolHooks,
};
pub use outside::{OutsideComponent, OutsideComponentSpec, OutsideError, ProcessTool};
pub use registry::{CommandSummary, RegistrationError, ToolRegistry};
pub use tool::{
    Command, LogSink, Tool, ToolArgs, ToolContext, ToolError, ToolFailure, ToolFuture, ToolResult,
    ToolRunContext, codes, parallel_safe, tool_fn,
};
pub use upstream::{
    ApprovalDecision, ApprovalMode, ConfinedArgv, EscalationRefusal, EscalationRefusalCode,
    EscalationSubject, RunnerFailureRule, SandboxDenial, SandboxEnforcement, SandboxMode,
    SandboxOutcome, SandboxUnavailable, SessionHandle, ToolSpec,
};
pub use validate::{argument_violations, invalid_arguments, open_root};

/// The cancellation token every call carries for a Stop — the TypeScript build's `AbortSignal`.
pub use tokio_util::sync::CancellationToken;

/// Test support shared by the crate's test modules.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};

    /// A scratch folder under the system temp folder that is removed when it is dropped, so a test that fails or
    /// panics still cleans up after itself (helpers that only cleared the folder before creating it left one
    /// behind per run: tool-developer's TMPDIR count, 2026-10-29). The name is unique per process and call; it
    /// reads as a `Path` wherever one is expected.
    pub(crate) struct ScratchDir(PathBuf);

    impl ScratchDir {
        pub(crate) fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let n = NEXT.fetch_add(1, Ordering::SeqCst);
            let dir =
                std::env::temp_dir().join(format!("heddle-{label}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl std::ops::Deref for ScratchDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for ScratchDir {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<std::ffi::OsStr> for ScratchDir {
        fn as_ref(&self) -> &std::ffi::OsStr {
            self.0.as_os_str()
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
