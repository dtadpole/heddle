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
//! A private [`js`] module holds the one thing the refusal sentences need from another language: the
//! `String()` coercion the TypeScript messages interpolate. [`testfs`] is the test-only scratch directory and
//! symlink helper.
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

/// The JavaScript value coercions the TypeScript refusal sentences interpolate.
///
/// A refusal sentence quotes the offending value the way a page or a log does, so the Rust port has to agree
/// with `String(value)` — `undefined` for an absent field, `null`, `[object Object]`, and an array joined with
/// `,`. `serde_json::Value` cannot tell an absent field from a present one, so the caller passes `None` for
/// absent and `Some(Value::Null)` for present-and-null.
mod js {
    use serde_json::Value;

    /// `String(value)` for a JSON value, or `undefined` when the field was absent.
    pub(crate) fn string_of(value: Option<&Value>) -> String {
        match value {
            None => "undefined".to_owned(),
            Some(Value::Null) => "null".to_owned(),
            Some(Value::Bool(flag)) => flag.to_string(),
            Some(Value::Number(number)) => number_to_string(number),
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    other => string_of(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(","),
            Some(Value::Object(_)) => "[object Object]".to_owned(),
        }
    }

    /// `String(number)`: an integral value prints without a fractional part.
    fn number_to_string(number: &serde_json::Number) -> String {
        if let Some(integer) = number.as_i64() {
            return integer.to_string();
        }
        if let Some(integer) = number.as_u64() {
            return integer.to_string();
        }
        let float = number.as_f64().unwrap_or(f64::NAN);
        if float.is_finite() && float.fract() == 0.0 {
            return format!("{}", float as i64);
        }
        number.to_string()
    }

    #[cfg(test)]
    mod tests {
        use serde_json::json;

        use super::string_of;

        #[test]
        fn an_absent_field_is_undefined_and_a_present_null_is_null() {
            assert_eq!(string_of(None), "undefined");
            assert_eq!(string_of(Some(&json!(null))), "null");
        }

        #[test]
        fn scalars_print_the_way_javascript_does() {
            assert_eq!(string_of(Some(&json!(true))), "true");
            assert_eq!(string_of(Some(&json!(false))), "false");
            assert_eq!(string_of(Some(&json!(3))), "3");
            assert_eq!(string_of(Some(&json!(1.5))), "1.5");
            assert_eq!(string_of(Some(&json!(2.0))), "2");
            assert_eq!(string_of(Some(&json!("read-only"))), "read-only");
        }

        #[test]
        fn arrays_join_with_commas_and_nulls_print_empty() {
            assert_eq!(string_of(Some(&json!([1, null, 2]))), "1,,2");
            assert_eq!(string_of(Some(&json!([["a", "b"]]))), "a,b");
        }

        #[test]
        fn an_object_is_its_constructor_name() {
            assert_eq!(
                string_of(Some(&json!({"mode": "read-only"}))),
                "[object Object]"
            );
        }
    }
}

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

    /// An executable `/bin/sh` script at `dir/name`, for the runner probes' stand-ins.
    pub(crate) fn script(dir: &TempDir, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join(name);
        std::fs::write(&path, body).expect("write the test script");
        let mut permissions = std::fs::metadata(&path)
            .expect("stat the test script")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("make the test script executable");
        path
    }
}
