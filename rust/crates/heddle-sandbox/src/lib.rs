//! `heddle-sandbox` — the permission modes, their enforcement backends, escalation and approvals.
//!
//! Ported from the TypeScript build's `src/sandbox/` and `src/approvals/`, and judged through the `heddle`
//! binary (`HEDDLE_BIN`) by `_verifiers_/75-permission-sandbox` and `_verifiers_/80-web-ui` (check-approval).
//!
//! | Module | What it holds | Ported from |
//! |---|---|---|
//! | [`mode`] | [`SandboxMode`], [`SandboxExecutionPolicy`], [`writable_roots`], [`policy_statement`] | `sandbox/policy.ts` |
//! | [`paths`] | [`canonical`], [`contains`], [`paths::resolve`] | `sandbox/paths.ts` |
//! | [`backend`] | [`SandboxBackend`], [`ConfinedArgv`], [`select_backend`], [`classify_outcome`], [`SandboxUnavailableError`] | `sandbox/backend.ts` |
//! | [`seatbelt`] | the macOS rung | `sandbox/seatbelt.ts` |
//! | [`linux`] | the bubblewrap and Landlock rungs | `sandbox/linux.ts` |
//! | [`escalation`] | [`approve_escalation`], [`validate_escalation_args`], [`EscalationRefusal`] | `sandbox/escalation.ts` |
//! | [`transition`] | [`permission_transition`] | `sandbox/service.ts` |
//! | [`service`] | [`SandboxService`], [`SandboxConfig`], [`SandboxDenial`] | `sandbox/service.ts` |
//! | [`approvals`] | [`ApprovalService`], [`ApprovalsConfig`], [`ApprovalRequest`] | `approvals/service.ts` |
//!
//! [`testfs`] is the test-only scratch directory and symlink helper.
//!
//! The crate depends on no other heddle crate. What it needs from them arrives as values: the profile rows'
//! `config` deserialises into [`SandboxConfig`] and [`ApprovalsConfig`], the harness home arrives in
//! [`SandboxHost`], and a published approval question is a [`tokio::sync::broadcast`] receiver the server (or
//! boot, onto the event bus) subscribes to.
//!
//! **Contract first:** the signatures and documents here are the API other crates build against; bodies marked
//! `todo!()` are being ported, with unit tests beside each.

pub mod approvals;
pub mod backend;
pub mod escalation;
pub mod linux;
pub mod mode;
pub mod paths;
pub mod seatbelt;
pub mod service;
pub mod transition;

pub use approvals::{
    Answer, AnswererGuard, ApprovalAsk, ApprovalDecision, ApprovalMode, ApprovalOutcome,
    ApprovalRequest, ApprovalService, ApprovalsConfig, DecisionRecord, Unanswered, is_approval_id,
};
pub use backend::{
    BackendName, ConfinedArgv, Platform, RunnerFailureRule, SandboxBackend, SandboxEnforcement,
    SandboxOutcome, SandboxUnavailableError, classify_outcome, runner_failure_message,
    select_backend, shell_denial_message,
};
pub use escalation::{
    ESCALATION_TARGETS, EscalationApproval, EscalationArgsError, EscalationRefusal,
    EscalationRequest, EscalationSubject, RefusalCode, approve_escalation,
    validate_escalation_args, wider_modes,
};
pub use mode::{
    SandboxExecutionPolicy, SandboxMode, UnknownMode, host_temp_dir, policy_statement,
    writable_roots,
};
pub use paths::{canonical, contains};
pub use service::{BackendChoice, SandboxConfig, SandboxDenial, SandboxHost, SandboxService};
pub use transition::{
    FULL_ACCESS_CONFIRMATION, ModeChange, TransitionRefusal, permission_transition,
};

/// Test-only scratch directories and symlinks, so a path rule is judged on the filesystem it describes.
#[cfg(test)]
pub(crate) mod testfs {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A directory under the host temp area, removed when dropped.
    pub(crate) struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        /// Create a fresh directory named for `label` and this process.
        pub(crate) fn new(label: &str) -> TempDir {
            let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "heddle-sandbox-{}-{label}-{serial}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create the test directory");
            TempDir { path }
        }

        /// The directory's path, not canonicalised: a test that wants the resolved form resolves it.
        pub(crate) fn path(&self) -> &Path {
            &self.path
        }

        /// A path inside the directory.
        pub(crate) fn join(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }

        /// A subdirectory created under it.
        pub(crate) fn child(&self, name: &str) -> PathBuf {
            let path = self.join(name);
            std::fs::create_dir_all(&path).expect("create the test subdirectory");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A symlink at `link` pointing at `target`. The crate is POSIX-only (Seatbelt, Landlock).
    pub(crate) fn symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("create the test symlink");
    }
}
