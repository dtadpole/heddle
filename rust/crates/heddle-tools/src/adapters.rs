//! The gate ports over the real `heddle-sandbox` and `heddle-session` services.
//!
//! The binary builds one [`SandboxService`] and one [`ApprovalService`] from the profile rows — the sandbox
//! crate owns both, and every sentence, mode and ladder rule — wraps them here, and hands the pair to
//! [`ToolRegistry`](crate::ToolRegistry) through [`ToolGates`](crate::gates::ToolGates). Nothing here makes a
//! policy decision: the wrappers convert only the shapes the ports speak (a `&str` path, a `String` argv, the
//! call's Stop as a future).
//!
//! `heddle-agent` needs nothing from this module: it reaches the sandbox through
//! [`ToolRegistry::sandbox`](crate::ToolRegistry::sandbox) and the registry's gates, so the loop and the tools
//! share one policy.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;

use heddle_sandbox::{
    ApprovalService, SandboxService, approve_escalation, classify_outcome, policy_statement,
    validate_escalation_args,
};

use heddle_session::SessionService;

use crate::gates::{ApprovalGate, EscalationError, EscalationRequest, ModeResolver, SandboxGate};
use crate::upstream::{
    ApprovalDecision, ConfinedArgv, SandboxDenial, SandboxMode, SandboxOutcome, SandboxUnavailable,
    SessionHandle,
};

/// The [`ApprovalGate`] over an [`ApprovalService`]: the standing policy and the escalation ladder.
pub struct SandboxApprovals {
    service: Arc<ApprovalService>,
}

impl SandboxApprovals {
    /// Wrap the deployment's approval service.
    pub fn new(service: Arc<ApprovalService>) -> Self {
        Self { service }
    }

    /// The service this gate asks.
    pub fn service(&self) -> &Arc<ApprovalService> {
        &self.service
    }
}

impl ApprovalGate for SandboxApprovals {
    fn check(&self, action: &str) -> ApprovalDecision {
        self.service.check(action)
    }

    fn escalate<'a>(
        &'a self,
        request: EscalationRequest,
    ) -> BoxFuture<'a, Result<SandboxMode, EscalationError>> {
        Box::pin(async move {
            let EscalationRequest {
                tool,
                requested_mode,
                justification,
                effective_mode,
                subject,
                session,
                cancel,
            } = request;
            // The pairing is the one thing the tool schema cannot express; a malformed pair is BAD_ARGS,
            // judged before anything is asked or executed.
            if let Err(error) =
                validate_escalation_args(requested_mode.as_ref(), justification.as_ref())
            {
                return Err(EscalationError::BadArgs(error.message));
            }
            let ask = heddle_sandbox::EscalationRequest {
                tool,
                requested_mode: requested_mode.unwrap_or(serde_json::Value::Null),
                effective_mode,
                justification: justification
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                subject,
                session,
            };
            // A Stop must end the wait, not the answer timeout.
            let cancel = async move {
                match cancel {
                    Some(token) => token.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            };
            approve_escalation(ask, self.service.as_ref(), cancel)
                .await
                .map_err(EscalationError::Refused)
        })
    }
}

/// The [`SandboxGate`] over a [`SandboxService`]: the deployment's mode, roots, fence and confinement.
pub struct Sandbox {
    service: Arc<SandboxService>,
}

impl Sandbox {
    /// Wrap the deployment's sandbox service.
    pub fn new(service: Arc<SandboxService>) -> Self {
        Self { service }
    }

    /// The service this gate asks.
    pub fn service(&self) -> &Arc<SandboxService> {
        &self.service
    }
}

impl SandboxGate for Sandbox {
    fn workspace_root(&self) -> &Path {
        self.service.workspace_root()
    }

    fn default_mode(&self) -> SandboxMode {
        self.service.mode()
    }

    fn escalation_targets(&self) -> Vec<SandboxMode> {
        self.service.escalation_targets()
    }

    /// The policy the status route reports. `SandboxExecutionPolicy` is the owner's value, not a wire type, so
    /// the two field names the TypeScript route printed are spelled here.
    fn policy(&self, mode: SandboxMode) -> serde_json::Value {
        let policy = self.service.policy(mode);
        serde_json::json!({
            "mode": policy.mode,
            "workspaceRoot": policy.workspace_root,
            "extraWritableRoots": policy.extra_writable_roots,
        })
    }

    fn policy_statement(&self, mode: SandboxMode) -> String {
        policy_statement(&self.service.policy(mode))
    }

    fn assert_writable(&self, path: &str, mode: SandboxMode) -> Result<PathBuf, SandboxDenial> {
        self.service.assert_writable(path, mode)
    }

    fn assert_readable(&self, path: &str, mode: SandboxMode) -> Result<PathBuf, SandboxDenial> {
        self.service.assert_readable(path, mode)
    }

    fn confine(
        &self,
        argv: &[String],
        mode: SandboxMode,
    ) -> Result<ConfinedArgv, SandboxUnavailable> {
        let argv: Vec<OsString> = argv.iter().map(OsString::from).collect();
        self.service.confine(&argv, mode)
    }

    fn classify_outcome(
        &self,
        exit_code: i32,
        stderr: &str,
        confined: Option<&ConfinedArgv>,
    ) -> SandboxOutcome {
        classify_outcome(exit_code, stderr, confined)
    }
}

/// The [`ModeResolver`] over a [`SessionService`]: a session's own `permission/mode` record outranks the
/// deployment default.
///
/// A log that cannot be read resolves to the **default**, never to a wider mode: the default is the deployment's
/// own choice, and a broken record must not be a way past it. The failure is logged.
pub struct SessionModes {
    service: Arc<SessionService>,
}

impl SessionModes {
    /// Wrap the deployment's session service.
    pub fn new(service: Arc<SessionService>) -> Self {
        Self { service }
    }
}

impl ModeResolver for SessionModes {
    fn effective_mode(&self, session: &SessionHandle, default: SandboxMode) -> SandboxMode {
        match self.service.effective_mode(session, default) {
            Ok(mode) => mode,
            Err(error) => {
                tracing::warn!(
                    target: "heddle_tools",
                    session = session.id.as_str(),
                    "the session's mode record could not be read, so the deployment mode applies: {error}"
                );
                default
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use heddle_sandbox::{
        ApprovalMode, ApprovalsConfig, BackendChoice, Platform, SandboxConfig, SandboxHost,
    };
    use serde_json::json;

    use super::*;
    use crate::upstream::{EscalationRefusalCode, EscalationSubject};

    fn scratch(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "heddle-adapters-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A workspace-write service with no backend: the fence works through the paths, and confinement fails
    /// closed, which is what a host without a runner sees.
    fn sandbox_at(root: &Path) -> Arc<SandboxService> {
        let config = SandboxConfig {
            mode: SandboxMode::WorkspaceWrite,
            workspace_root: Some(root.to_path_buf()),
            backend: BackendChoice::Disabled,
            ..SandboxConfig::default()
        };
        let host = SandboxHost {
            cwd: root.to_path_buf(),
            harness_home: root.join(".heddle"),
            platform: Platform::current(),
        };
        Arc::new(SandboxService::with_backend(&config, &host, None))
    }

    fn approvals(config: ApprovalsConfig) -> SandboxApprovals {
        SandboxApprovals::new(Arc::new(ApprovalService::new(config)))
    }

    #[test]
    fn the_gate_reports_the_deployments_mode_and_policy() {
        let root = scratch("policy");
        let gate = Sandbox::new(sandbox_at(&root));
        assert_eq!(gate.default_mode(), SandboxMode::WorkspaceWrite);
        assert_eq!(gate.workspace_root(), root.canonicalize().unwrap());
        assert!(
            gate.policy_statement(SandboxMode::WorkspaceWrite)
                .contains("workspace-write")
        );
        let policy = gate.policy(SandboxMode::ReadOnly);
        assert_eq!(policy["mode"], "read-only");
        assert_eq!(policy["workspaceRoot"], json!(root.canonicalize().unwrap()));
        assert_eq!(policy["extraWritableRoots"], json!([]));
        assert!(
            gate.escalation_targets().is_empty(),
            "no usable backend means no offered escalation"
        );
    }

    #[test]
    fn the_fence_admits_the_workspace_and_refuses_an_absolute_outside_path() {
        let root = scratch("fence");
        let gate = Sandbox::new(sandbox_at(&root));
        let admitted = gate
            .assert_writable("notes/a.txt", SandboxMode::WorkspaceWrite)
            .unwrap();
        assert!(admitted.starts_with(root.canonicalize().unwrap()));
        let refusal = gate
            .assert_writable("/etc/passwd", SandboxMode::WorkspaceWrite)
            .unwrap_err();
        assert_eq!(refusal.mode, SandboxMode::WorkspaceWrite);
        assert!(refusal.message.contains("outside"), "{}", refusal.message);
    }

    #[test]
    fn confinement_without_a_backend_fails_closed() {
        let root = scratch("confine");
        let gate = Sandbox::new(sandbox_at(&root));
        let error = gate
            .confine(
                &["/bin/sh".to_owned(), "-c".to_owned(), "true".to_owned()],
                SandboxMode::ReadOnly,
            )
            .unwrap_err();
        assert_eq!(error.mode, SandboxMode::ReadOnly);
        assert!(error.to_string().contains("no sandbox backend"), "{error}");
        assert_eq!(
            gate.classify_outcome(0, "", None),
            SandboxOutcome::Exited,
            "an unconfined call is never denied"
        );
    }

    #[test]
    fn the_standing_policy_allows_or_refuses_by_name() {
        let allowed = approvals(ApprovalsConfig::default());
        assert!(allowed.check("read_file").allowed);
        let denied = approvals(ApprovalsConfig {
            mode: ApprovalMode::Allow,
            deny: vec!["bash".to_owned()],
            ..ApprovalsConfig::default()
        });
        let decision = denied.check("bash");
        assert!(!decision.allowed);
        assert!(decision.reason.is_some());
    }

    fn sessions_at(root: &Path) -> Arc<SessionService> {
        let config = heddle_session::SessionConfig {
            root: Some(root.to_str().unwrap().to_owned()),
        };
        Arc::new(SessionService::new(
            &config,
            &heddle_config::Env::default(),
            None,
        ))
    }

    #[test]
    fn a_session_with_no_mode_record_runs_under_the_deployment_mode() {
        let root = scratch("modes-none");
        let sessions = sessions_at(&root);
        let handle = sessions
            .store()
            .create(heddle_session::CreateOptions::default())
            .unwrap();
        let modes = SessionModes::new(Arc::clone(&sessions));
        assert_eq!(
            modes.effective_mode(&handle, SandboxMode::WorkspaceWrite),
            SandboxMode::WorkspaceWrite
        );
    }

    #[test]
    fn a_sessions_own_record_outranks_the_deployment_mode() {
        let root = scratch("modes-record");
        let sessions = sessions_at(&root);
        let handle = sessions
            .store()
            .create(heddle_session::CreateOptions::default())
            .unwrap();
        let change = sessions
            .set_mode(&handle, SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite)
            .unwrap();
        assert!(change.changed);
        let modes = SessionModes::new(Arc::clone(&sessions));
        assert_eq!(
            modes.effective_mode(&handle, SandboxMode::WorkspaceWrite),
            SandboxMode::ReadOnly
        );
    }

    #[tokio::test]
    async fn the_ladder_judges_the_pairing_then_asks() {
        let gate = approvals(ApprovalsConfig::default());
        let malformed = gate
            .escalate(EscalationRequest {
                tool: "bash".to_owned(),
                requested_mode: Some(json!("danger-full-access")),
                justification: None,
                effective_mode: SandboxMode::WorkspaceWrite,
                subject: EscalationSubject::Command,
                session: None,
                cancel: None,
            })
            .await
            .unwrap_err();
        match malformed {
            EscalationError::BadArgs(message) => {
                assert!(message.contains("requires a justification"), "{message}")
            }
            other => panic!("expected BAD_ARGS, got {other}"),
        }
    }

    #[tokio::test]
    async fn a_wider_mode_with_nobody_to_ask_is_refused_and_a_repeat_needs_no_ask() {
        let gate = approvals(ApprovalsConfig::default());
        let refused = gate
            .escalate(EscalationRequest {
                tool: "write_file".to_owned(),
                requested_mode: Some(json!("danger-full-access")),
                justification: Some(json!("needed for the task")),
                effective_mode: SandboxMode::WorkspaceWrite,
                subject: EscalationSubject::Operation,
                session: Some("s".to_owned()),
                cancel: None,
            })
            .await
            .unwrap_err();
        match refused {
            EscalationError::Refused(refusal) => {
                assert_eq!(refusal.code, EscalationRefusalCode::Unavailable);
                assert!(
                    refusal.message.contains("no one can approve"),
                    "{}",
                    refusal.message
                );
            }
            other => panic!("expected ESCALATION_REFUSED, got {other}"),
        }

        // Asking for the mode the call already runs under is not an escalation: no question, no refusal.
        let same = gate
            .escalate(EscalationRequest {
                tool: "write_file".to_owned(),
                requested_mode: Some(json!("workspace-write")),
                justification: Some(json!("same mode")),
                effective_mode: SandboxMode::WorkspaceWrite,
                subject: EscalationSubject::Operation,
                session: None,
                cancel: None,
            })
            .await
            .unwrap();
        assert_eq!(same, SandboxMode::WorkspaceWrite);
    }
}
