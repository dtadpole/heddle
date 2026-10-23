//! The backend contract, platform selection, the fail-closed error and outcome classification.
//!
//! Ported from `src/sandbox/backend.ts`. A backend turns one per-call policy into a kernel runner invocation
//! and reports **what it actually governed**: enforcement completeness, the stderr dialect its kernel speaks
//! when it denies a write, and the signatures that mean the runner itself failed. The consumer (the `bash`
//! tool) reports these facts; it never negotiates permissions and never decides a mode.

use std::ffi::OsString;
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::mode::{SandboxExecutionPolicy, SandboxMode};

/// How completely a backend governs the policy's promised file effects. `partial` is a fact, not a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxEnforcement {
    /// Every promised file effect is governed.
    Full,
    /// Some are not (a Landlock kernel that reports itself partially enforced).
    Partial,
}

impl SandboxEnforcement {
    /// The wire word: `full` or `partial`.
    pub const fn as_str(self) -> &'static str {
        match self {
            SandboxEnforcement::Full => "full",
            SandboxEnforcement::Partial => "partial",
        }
    }
}

/// What a runner's own failure looks like: a fatal stderr signature, optionally gated on the exit codes the
/// runner reserves for that failure. A runner failure means the command never ran, so it outranks a denial.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerFailureRule {
    /// When set, the rule applies only if the exit code is one of these.
    pub allowed_exit_codes: Option<Vec<i32>>,
    /// Case-insensitive substrings of one stderr line.
    pub fatal_signatures: Vec<String>,
}

/// One confined execution: the argv to spawn, and the facts needed to classify what it did (`ConfinedArgv`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfinedArgv {
    /// The wrapped argv: runner, profile arguments, `--`, then the caller's argv. Spawn `argv[0]` with the rest.
    pub argv: Vec<OsString>,
    /// What the runner governs.
    pub enforcement: SandboxEnforcement,
    /// Case-insensitive stderr substrings this kernel produces for a denied file effect.
    pub denial_signatures: Vec<String>,
    /// How this runner's own failure reads.
    pub runner_failure_rules: Vec<RunnerFailureRule>,
}

impl ConfinedArgv {
    /// The `danger-full-access` shape: the argv unchanged, `full`, and no dialect (nothing can be denied).
    pub fn unconfined(argv: &[OsString]) -> ConfinedArgv {
        ConfinedArgv {
            argv: argv.to_vec(),
            enforcement: SandboxEnforcement::Full,
            denial_signatures: Vec::new(),
            runner_failure_rules: Vec::new(),
        }
    }
}

/// Which platform runner a backend is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendName {
    /// macOS `sandbox-exec`.
    Seatbelt,
    /// Linux bubblewrap.
    Bwrap,
    /// Linux Landlock, through an operator-configured launcher.
    Landlock,
}

impl BackendName {
    /// The reported word: `seatbelt`, `bwrap` or `landlock`.
    pub const fn as_str(self) -> &'static str {
        match self {
            BackendName::Seatbelt => "seatbelt",
            BackendName::Bwrap => "bwrap",
            BackendName::Landlock => "landlock",
        }
    }
}

impl fmt::Display for BackendName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One platform runner, selected once and probed on first use (`SandboxBackend`).
pub trait SandboxBackend: Send + Sync {
    /// Which runner this is.
    fn name(&self) -> BackendName;

    /// Whether this runner can enforce a profile on this machine: a **functional** probe (the kernel accepts
    /// and applies a real profile around `/usr/bin/true`), not a test that the binary exists. Implementations
    /// cache a real probe's verdict for their lifetime.
    fn probe(&self) -> bool;

    /// Wrap one exact argv under the policy. Never consulted for `danger-full-access`.
    fn confine(&self, argv: &[OsString], policy: &SandboxExecutionPolicy) -> ConfinedArgv;
}

/// The fail-closed error: a confined mode was requested and no runner can enforce it
/// (`SandboxUnavailableError`). An error, never a fallback, because running the command unconfined after being
/// asked to confine it is the one outcome this mechanism exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct SandboxUnavailableError {
    /// The confined mode that was asked for.
    pub mode: SandboxMode,
    /// The runner's own failure line, when a runner failed rather than being absent.
    pub detail: Option<String>,
}

impl SandboxUnavailableError {
    /// The tool-result error code a consumer reports this under.
    pub const CODE: &'static str = "SANDBOX_UNAVAILABLE";

    /// No usable backend for `mode`.
    pub fn new(mode: SandboxMode) -> SandboxUnavailableError {
        SandboxUnavailableError { mode, detail: None }
    }
}

impl fmt::Display for SandboxUnavailableError {
    /// The TypeScript sentence, byte for byte; verifiers match `no sandbox backend`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "sandbox mode \"{}\" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), or ensure sandbox-exec is usable (macOS).",
            self.mode
        )?;
        if let Some(detail) = &self.detail {
            write!(f, " Runner failure: {detail}")?;
        }
        Ok(())
    }
}

/// The platform a backend chain is chosen for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    /// macOS: exactly one candidate, Seatbelt.
    MacOs,
    /// Linux: bubblewrap, then Landlock when a launcher is configured.
    Linux,
    /// Anything else: no chain, so a confined call fails closed.
    Other,
}

impl Platform {
    /// The platform this process runs on.
    pub fn current() -> Platform {
        Platform::from_os(std::env::consts::OS)
    }

    /// From an OS word: Rust's `macos` or Node's `darwin`, `linux`, anything else is [`Platform::Other`].
    pub fn from_os(os: &str) -> Platform {
        match os {
            "macos" | "darwin" => Platform::MacOs,
            "linux" => Platform::Linux,
            _ => Platform::Other,
        }
    }
}

/// The platform runner chain, in DSH's order (`selectBackend`).
///
/// macOS: the Seatbelt backend, returned **unprobed** (probing arbitrates between candidates; it does not
/// re-validate a choice with no alternative — the service probes before use). Linux:
/// [`crate::linux::select_linux_backend`] over bubblewrap and, only when `landlock_runner` is given, the
/// Landlock launcher at that path — never a path found in the environment. Other: `None`, and the caller
/// fails closed.
pub fn select_backend(
    platform: Platform,
    landlock_runner: Option<&Path>,
) -> Option<Arc<dyn SandboxBackend>> {
    match platform {
        Platform::MacOs => Some(Arc::new(crate::seatbelt::SeatbeltBackend::default())),
        Platform::Linux => {
            let bwrap: Arc<dyn SandboxBackend> = Arc::new(crate::linux::BwrapBackend::default());
            let landlock: Option<Arc<dyn SandboxBackend>> = landlock_runner.and_then(|runner| {
                crate::linux::LandlockBackend::new(crate::linux::LandlockOptions {
                    runner: Some(runner.to_path_buf()),
                    ..crate::linux::LandlockOptions::default()
                })
                .map(|backend| Arc::new(backend) as Arc<dyn SandboxBackend>)
            });
            crate::linux::select_linux_backend(bwrap, landlock)
        }
        Platform::Other => None,
    }
}

/// What one settled command did, as far as the sandbox is concerned (`SandboxOutcome`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxOutcome {
    /// The runner itself failed, so the command never ran. `detail` is the trimmed stderr line that matched.
    RunnerFailure {
        /// The matching stderr line, trimmed.
        detail: String,
    },
    /// The command failed and its stderr speaks the backend's denial dialect.
    Denied,
    /// An ordinary result the sandbox has no opinion about.
    Exited,
}

/// Classify one settled command (`classifyOutcome`).
///
/// `confined` is the wrapped call's facts, or `None` for an unconfined call, which is always `Exited`. The order
/// is the mechanism: a runner-failure rule (gated on its exit codes) whose signature appears in any stderr line
/// wins; otherwise a **non-zero** exit with a denial signature in any stderr line is `Denied` (a command that
/// merely prints `Operation not permitted` and exits 0 succeeded); otherwise `Exited`. Matching is
/// case-insensitive substring per `\n`-separated line. A process killed by a signal is classified with exit
/// code 1, as the TypeScript `code ?? 1` does.
pub fn classify_outcome(
    exit_code: i32,
    stderr: &str,
    confined: Option<&ConfinedArgv>,
) -> SandboxOutcome {
    let Some(confined) = confined else {
        return SandboxOutcome::Exited;
    };
    let lines: Vec<&str> = stderr.split('\n').collect();
    let mentions = |line: &str, signature: &str| -> bool {
        line.to_lowercase().contains(&signature.to_lowercase())
    };

    for rule in &confined.runner_failure_rules {
        if rule
            .allowed_exit_codes
            .as_ref()
            .is_some_and(|codes| !codes.contains(&exit_code))
        {
            continue;
        }
        for line in &lines {
            if rule
                .fatal_signatures
                .iter()
                .any(|signature| mentions(line, signature))
            {
                return SandboxOutcome::RunnerFailure {
                    detail: line.trim().to_owned(),
                };
            }
        }
    }

    if exit_code != 0 {
        for line in &lines {
            if confined
                .denial_signatures
                .iter()
                .any(|signature| mentions(line, signature))
            {
                return SandboxOutcome::Denied;
            }
        }
    }
    SandboxOutcome::Exited
}

/// The tool-result message for a [`SandboxOutcome::Denied`] shell call:
/// `[sandbox: file access denied under <mode> mode]`. Verifiers match it; the `bash` tool reports it under code
/// `SANDBOX`. Kept here so the sentence has one home.
pub fn shell_denial_message(mode: SandboxMode) -> String {
    format!("[sandbox: file access denied under {mode} mode]")
}

/// The tool-result message for a [`SandboxOutcome::RunnerFailure`], reported under
/// [`SandboxUnavailableError::CODE`]:
/// `the sandbox runner failed under '<mode>' mode — the command did not run: <detail>`.
pub fn runner_failure_message(mode: SandboxMode, detail: &str) -> String {
    format!("the sandbox runner failed under '{mode}' mode — the command did not run: {detail}")
}

/// One runner probe's result.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct ProbeRun {
    /// The exit code, or `None` when the runner could not be spawned, was killed by a signal, or timed out.
    pub status: Option<i32>,
    /// Standard output, for launchers whose verdict is a word (`partially enforced`).
    pub stdout: Vec<u8>,
}

/// Spawn `program` with `args` and wait at most `timeout`, killing it on expiry.
///
/// The probe is the one place a kernel runner is asked a question instead of given a command, so a hung launcher
/// must not hang the call: a timeout is [`ProbeRun::status`] `None`, which every probe treats as unusable.
pub(crate) fn probe_run(
    program: &std::ffi::OsStr,
    args: &[OsString],
    timeout: Duration,
) -> ProbeRun {
    let spawned = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else {
        return ProbeRun::default();
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return ProbeRun::default();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return ProbeRun::default();
            }
        }
    };
    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    ProbeRun { status, stdout }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{
        ConfinedArgv, Platform, RunnerFailureRule, SandboxEnforcement, SandboxOutcome,
        SandboxUnavailableError, classify_outcome, runner_failure_message, select_backend,
        shell_denial_message,
    };
    use crate::mode::SandboxMode;

    fn confined() -> ConfinedArgv {
        ConfinedArgv {
            argv: vec![
                OsString::from("runner"),
                OsString::from("--"),
                OsString::from("sh"),
            ],
            enforcement: SandboxEnforcement::Full,
            denial_signatures: vec!["operation not permitted".to_owned()],
            runner_failure_rules: vec![RunnerFailureRule {
                allowed_exit_codes: None,
                fatal_signatures: vec!["sandbox-exec: ".to_owned()],
            }],
        }
    }

    #[test]
    fn an_unconfined_call_is_never_denied() {
        assert_eq!(
            classify_outcome(1, "operation not permitted", None),
            SandboxOutcome::Exited
        );
        assert_eq!(classify_outcome(0, "", None), SandboxOutcome::Exited);
    }

    #[test]
    fn a_denial_needs_a_non_zero_exit_and_the_backends_dialect() {
        assert_eq!(
            classify_outcome(
                1,
                "sh: cannot create x: Operation not permitted\n",
                Some(&confined())
            ),
            SandboxOutcome::Denied
        );
        assert_eq!(
            classify_outcome(0, "Operation not permitted\n", Some(&confined())),
            SandboxOutcome::Exited,
            "a command that prints the sentence and succeeds was not denied"
        );
        assert_eq!(
            classify_outcome(2, "some other failure\n", Some(&confined())),
            SandboxOutcome::Exited
        );
    }

    #[test]
    fn matching_is_case_insensitive_per_line() {
        assert_eq!(
            classify_outcome(
                1,
                "cannot write: OPERATION NOT PERMITTED\n",
                Some(&confined())
            ),
            SandboxOutcome::Denied
        );
    }

    #[test]
    fn a_runner_failure_outranks_a_denial() {
        let outcome = classify_outcome(
            1,
            "  sandbox-exec: profile rejected  \noperation not permitted\n",
            Some(&confined()),
        );
        assert_eq!(
            outcome,
            SandboxOutcome::RunnerFailure {
                detail: "sandbox-exec: profile rejected".to_owned(),
            },
            "the command never ran, so the denial dialect is irrelevant"
        );
    }

    #[test]
    fn a_gated_runner_failure_rule_only_fires_on_its_exit_codes() {
        let gated = ConfinedArgv {
            runner_failure_rules: vec![RunnerFailureRule {
                allowed_exit_codes: Some(vec![125]),
                fatal_signatures: vec!["landlock-run: ".to_owned()],
            }],
            ..confined()
        };
        assert_eq!(
            classify_outcome(1, "landlock-run: boom\n", Some(&gated)),
            SandboxOutcome::Exited,
            "exit 1 is not the launcher's own failure signal"
        );
        assert_eq!(
            classify_outcome(125, "landlock-run: boom\n", Some(&gated)),
            SandboxOutcome::RunnerFailure {
                detail: "landlock-run: boom".to_owned(),
            }
        );
    }

    #[test]
    fn the_platform_words_include_nodes_name_for_macos() {
        assert_eq!(Platform::from_os("macos"), Platform::MacOs);
        assert_eq!(Platform::from_os("darwin"), Platform::MacOs);
        assert_eq!(Platform::from_os("linux"), Platform::Linux);
        assert_eq!(Platform::from_os("windows"), Platform::Other);
        assert_eq!(Platform::from_os("freebsd"), Platform::Other);
    }

    #[test]
    fn macos_selects_seatbelt_unprobed_and_other_platforms_fail_closed() {
        let backend = select_backend(Platform::MacOs, None).expect("a macOS chain");
        assert_eq!(backend.name().as_str(), "seatbelt");
        assert_eq!(backend.name(), crate::backend::BackendName::Seatbelt);
        assert!(select_backend(Platform::Other, None).is_none());
    }

    #[test]
    fn the_unavailable_sentence_names_the_mode_and_both_platforms_runners() {
        let error = SandboxUnavailableError::new(SandboxMode::WorkspaceWrite);
        assert_eq!(
            error.to_string(),
            "sandbox mode \"workspace-write\" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), or ensure sandbox-exec is usable (macOS)."
        );
        assert_eq!(SandboxUnavailableError::CODE, "SANDBOX_UNAVAILABLE");

        let with_detail = SandboxUnavailableError {
            mode: SandboxMode::ReadOnly,
            detail: Some("sandbox-exec: profile rejected".to_owned()),
        };
        assert!(
            with_detail
                .to_string()
                .ends_with(" Runner failure: sandbox-exec: profile rejected")
        );
    }

    #[test]
    fn the_two_tool_messages_are_the_ones_a_verifier_matches() {
        assert_eq!(
            shell_denial_message(SandboxMode::WorkspaceWrite),
            "[sandbox: file access denied under workspace-write mode]"
        );
        assert_eq!(
            runner_failure_message(SandboxMode::ReadOnly, "boom"),
            "the sandbox runner failed under 'read-only' mode — the command did not run: boom"
        );
    }

    #[test]
    fn the_unconfined_shape_keeps_the_argv_and_has_no_dialect() {
        let argv = vec![
            OsString::from("sh"),
            OsString::from("-c"),
            OsString::from("true"),
        ];
        let unconfined = ConfinedArgv::unconfined(&argv);
        assert_eq!(unconfined.argv, argv);
        assert_eq!(unconfined.enforcement, SandboxEnforcement::Full);
        assert!(unconfined.denial_signatures.is_empty());
        assert!(unconfined.runner_failure_rules.is_empty());
    }
}
