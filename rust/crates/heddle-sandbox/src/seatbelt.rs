//! The macOS Seatbelt rung.
//!
//! Ported from `src/sandbox/seatbelt.ts`. The profile is DSH's: allow-default, deny every write, keep
//! `/dev/null` as the one literal sink a shell expects, and grant one canonical `(subpath …)` per writable
//! root. `sandbox-exec` rides Apple's deprecated private policy engine; the functional probe is what fails
//! closed if the command ever disappears.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use crate::backend::{
    BackendName, ConfinedArgv, RunnerFailureRule, SandboxBackend, SandboxEnforcement, probe_run,
};
use crate::mode::{SandboxExecutionPolicy, SandboxMode, writable_roots};

/// Where macOS ships the runner. Named, not looked up: a `PATH` entry must not be able to change the boundary.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The stderr dialect macOS speaks for a denied write, measured: `Operation not permitted`.
pub const SEATBELT_DENIAL_SIGNATURES: &[&str] = &["operation not permitted"];

/// `sandbox-exec`'s own fatal diagnostic prefix; it exits non-zero when it refuses a profile.
pub const SEATBELT_FATAL_SIGNATURES: &[&str] = &["sandbox-exec: "];

/// The SBPL profile arguments for one policy: `["-p", "<profile>"]` (`seatbeltProfileArgs`).
///
/// The profile is `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))`,
/// then — only when [`crate::mode::writable_roots`] is non-empty —
/// `(allow file-write* (subpath "<root>") …)`, forms joined by one space. Each path is an SBPL string literal
/// with `\` and `"` escaped, so a path cannot end the string early.
pub fn seatbelt_profile_args(policy: &SandboxExecutionPolicy) -> Vec<OsString> {
    let mut forms: Vec<String> = vec![
        "(version 1)".to_owned(),
        "(allow default)".to_owned(),
        "(deny file-write*)".to_owned(),
        format!(
            "(allow file-write* (literal {}))",
            sbpl_string(Path::new("/dev/null"))
        ),
    ];
    let roots = writable_roots(policy);
    if !roots.is_empty() {
        let subpaths: Vec<String> = roots
            .iter()
            .map(|root| format!("(subpath {})", sbpl_string(root)))
            .collect();
        forms.push(format!("(allow file-write* {})", subpaths.join(" ")));
    }
    vec![OsString::from("-p"), OsString::from(forms.join(" "))]
}

/// Quote one path as an SBPL string literal, so a path cannot end the string early.
fn sbpl_string(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// How a [`SeatbeltBackend`] finds and probes its runner; the fields exist so a test can judge absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatbeltOptions {
    /// The runner, [`SANDBOX_EXEC`] by default.
    pub exec: PathBuf,
    /// How long the probe may take, 5 s by default; a probe that times out is unusable.
    pub probe_timeout: Duration,
}

impl Default for SeatbeltOptions {
    fn default() -> SeatbeltOptions {
        SeatbeltOptions {
            exec: PathBuf::from(SANDBOX_EXEC),
            probe_timeout: Duration::from_secs(5),
        }
    }
}

/// The Seatbelt backend (`seatbeltBackend`): probe = the runner exists **and** applies the real read-only
/// profile around `/usr/bin/true` with exit 0, cached for the backend's lifetime; confine =
/// `[exec, …seatbelt_profile_args, "--", …argv]`, `full`, [`SEATBELT_DENIAL_SIGNATURES`], one rule with
/// [`SEATBELT_FATAL_SIGNATURES`] and no exit-code gate.
#[derive(Debug)]
pub struct SeatbeltBackend {
    options: SeatbeltOptions,
    verdict: OnceLock<bool>,
}

impl SeatbeltBackend {
    /// A backend over `options`; nothing is spawned until the first probe.
    pub fn new(options: SeatbeltOptions) -> SeatbeltBackend {
        SeatbeltBackend {
            options,
            verdict: OnceLock::new(),
        }
    }

    /// Apply the **real read-only profile** around `true`: exit 0 means the kernel accepted and enforced it.
    /// `sandbox-exec` exits non-zero when `sandbox_init` refuses a profile, so a broken profile is not mistaken
    /// for a usable rung.
    fn functional_probe(&self) -> bool {
        if !self.options.exec.exists() {
            return false;
        }
        let policy = SandboxExecutionPolicy {
            mode: SandboxMode::ReadOnly,
            workspace_root: PathBuf::from("/"),
            extra_writable_roots: Vec::new(),
        };
        let mut args = seatbelt_profile_args(&policy);
        args.push(OsString::from("--"));
        args.push(OsString::from("/usr/bin/true"));
        probe_run(
            self.options.exec.as_os_str(),
            &args,
            self.options.probe_timeout,
        )
        .status
            == Some(0)
    }
}

impl Default for SeatbeltBackend {
    fn default() -> SeatbeltBackend {
        SeatbeltBackend::new(SeatbeltOptions::default())
    }
}

impl SandboxBackend for SeatbeltBackend {
    fn name(&self) -> BackendName {
        BackendName::Seatbelt
    }

    fn probe(&self) -> bool {
        *self.verdict.get_or_init(|| self.functional_probe())
    }

    fn confine(&self, argv: &[OsString], policy: &SandboxExecutionPolicy) -> ConfinedArgv {
        let mut wrapped: Vec<OsString> = Vec::with_capacity(argv.len() + 4);
        wrapped.push(self.options.exec.clone().into_os_string());
        wrapped.extend(seatbelt_profile_args(policy));
        wrapped.push(OsString::from("--"));
        wrapped.extend(argv.iter().cloned());
        ConfinedArgv {
            argv: wrapped,
            enforcement: SandboxEnforcement::Full,
            denial_signatures: SEATBELT_DENIAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect(),
            runner_failure_rules: vec![RunnerFailureRule {
                allowed_exit_codes: None,
                fatal_signatures: SEATBELT_FATAL_SIGNATURES
                    .iter()
                    .map(|line| (*line).to_owned())
                    .collect(),
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use super::{
        SANDBOX_EXEC, SEATBELT_DENIAL_SIGNATURES, SEATBELT_FATAL_SIGNATURES, SeatbeltBackend,
        SeatbeltOptions, seatbelt_profile_args,
    };
    use crate::backend::{SandboxBackend, SandboxEnforcement};
    use crate::mode::{SandboxExecutionPolicy, SandboxMode, writable_roots};
    use crate::paths::canonical;
    use crate::testfs::{TempDir, script};

    fn policy(mode: SandboxMode, workspace: impl Into<PathBuf>) -> SandboxExecutionPolicy {
        SandboxExecutionPolicy {
            mode,
            workspace_root: workspace.into(),
            extra_writable_roots: Vec::new(),
        }
    }

    fn profile_string(policy: &SandboxExecutionPolicy) -> String {
        let args = seatbelt_profile_args(policy);
        assert_eq!(args[0], OsString::from("-p"));
        args[1].to_string_lossy().into_owned()
    }

    #[test]
    fn the_read_only_profile_is_the_golden_sbpl() {
        let args = seatbelt_profile_args(&policy(SandboxMode::ReadOnly, "/tmp/ws"));
        assert_eq!(
            args,
            vec![
                OsString::from("-p"),
                OsString::from(
                    "(version 1) (allow default) (deny file-write*) (allow file-write* (literal \"/dev/null\"))"
                ),
            ],
            "no writable root under read-only, and /dev/null stays the one literal sink"
        );
    }

    #[test]
    fn the_workspace_write_profile_grants_one_subpath_per_canonical_root() {
        let dir = TempDir::new("sbpl-roots");
        let workspace = dir.child("ws");
        let extra = dir.child("extra");
        let mut subject = policy(SandboxMode::WorkspaceWrite, &workspace);
        subject.extra_writable_roots = vec![extra.clone()];

        let profile = profile_string(&subject);
        assert!(profile.starts_with(
            "(version 1) (allow default) (deny file-write*) (allow file-write* (literal \"/dev/null\")) (allow file-write* "
        ));
        let roots = writable_roots(&subject);
        for root in &roots {
            assert!(
                profile.contains(&format!("(subpath \"{}\")", root.display())),
                "{root:?} is granted"
            );
        }
        let grants = profile.matches("(subpath ").count();
        assert_eq!(grants, roots.len(), "one subpath per root, no duplicates");
    }

    #[test]
    fn a_path_cannot_end_the_sbpl_string_early() {
        let dir = TempDir::new("sbpl-escape");
        for name in ["quo\"te", "back\\slash"] {
            let profile = profile_string(&policy(SandboxMode::WorkspaceWrite, dir.join(name)));
            let escaped = canonical(dir.join(name))
                .to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            assert!(
                profile.contains(&format!("(subpath \"{escaped}\")")),
                "the path {name:?} is escaped, not left to end the literal: {profile}"
            );
        }
    }

    #[test]
    fn confine_wraps_the_call_between_the_profile_and_the_caller_argv() {
        let backend = SeatbeltBackend::new(SeatbeltOptions {
            exec: PathBuf::from(SANDBOX_EXEC),
            ..SeatbeltOptions::default()
        });
        let argv = vec![
            OsString::from("/bin/sh"),
            OsString::from("-c"),
            OsString::from("echo hi"),
        ];
        let confined = backend.confine(&argv, &policy(SandboxMode::ReadOnly, "/tmp/ws"));

        assert_eq!(confined.argv[0], OsString::from(SANDBOX_EXEC));
        assert_eq!(confined.argv[1], OsString::from("-p"));
        assert_eq!(confined.argv[3], OsString::from("--"));
        assert_eq!(&confined.argv[4..], &argv[..]);
        assert_eq!(confined.enforcement, SandboxEnforcement::Full);
        assert_eq!(
            confined.denial_signatures,
            SEATBELT_DENIAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect::<Vec<_>>()
        );
        assert_eq!(confined.runner_failure_rules.len(), 1);
        assert_eq!(confined.runner_failure_rules[0].allowed_exit_codes, None);
        assert_eq!(
            confined.runner_failure_rules[0].fatal_signatures,
            SEATBELT_FATAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect::<Vec<_>>()
        );
    }

    fn backend_over(exec: &Path, probe_timeout: Duration) -> SeatbeltBackend {
        SeatbeltBackend::new(SeatbeltOptions {
            exec: exec.to_path_buf(),
            probe_timeout,
        })
    }

    #[test]
    fn a_missing_runner_probes_unusable() {
        let dir = TempDir::new("sbpl-missing");
        assert!(!backend_over(&dir.join("absent"), Duration::from_secs(1)).probe());
    }

    #[test]
    fn a_profile_the_runner_accepts_probes_usable() {
        let dir = TempDir::new("sbpl-ok");
        let runner = script(&dir, "runner", "#!/bin/sh\nexit 0\n");
        assert!(backend_over(&runner, Duration::from_secs(2)).probe());
    }

    #[test]
    fn a_runner_that_refuses_the_profile_probes_unusable() {
        let dir = TempDir::new("sbpl-refuse");
        let runner = script(&dir, "runner", "#!/bin/sh\nexit 1\n");
        assert!(!backend_over(&runner, Duration::from_secs(2)).probe());
    }

    #[test]
    fn the_verdict_is_cached_for_the_backends_lifetime() {
        let dir = TempDir::new("sbpl-cached");
        let counter = dir.join("runs");
        let runner = script(
            &dir,
            "runner",
            &format!("#!/bin/sh\necho run >> {}\nexit 0\n", counter.display()),
        );
        let backend = backend_over(&runner, Duration::from_secs(2));
        assert!(backend.probe());
        assert!(backend.probe());
        let runs = std::fs::read_to_string(&counter).expect("the counter");
        assert_eq!(runs.lines().count(), 1, "the real probe runs once");
    }

    #[test]
    fn a_hung_runner_probes_unusable_at_the_timeout() {
        let dir = TempDir::new("sbpl-hang");
        let runner = script(&dir, "runner", "#!/bin/sh\nexec /bin/sleep 10\n");
        let started = Instant::now();
        assert!(!backend_over(&runner, Duration::from_millis(150)).probe());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the probe does not wait out the hung runner"
        );
    }
}
