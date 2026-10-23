//! The Linux rungs: bubblewrap first, Landlock second, both behind the same backend contract.
//!
//! Ported from `src/sandbox/linux.ts`. The profiles are DSH's. The launchers are **not** bundled: bubblewrap
//! is a standard system binary, and Landlock's launcher is a versioned external executable whose path is
//! configuration (`landlockRunner`). A missing launcher probes unusable and the call fails closed, which is the
//! honest answer on a host heddle cannot confine.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::backend::{
    BackendName, ConfinedArgv, RunnerFailureRule, SandboxBackend, SandboxEnforcement, probe_run,
};
use crate::mode::{SandboxExecutionPolicy, SandboxMode, host_temp_dir, writable_roots};
use crate::paths::canonical;

/// The stderr dialect bubblewrap's kernel speaks for a denied write.
pub const BWRAP_DENIAL_SIGNATURES: &[&str] = &["read-only file system"];
/// bubblewrap's own fatal diagnostic prefix.
pub const BWRAP_FATAL_SIGNATURES: &[&str] = &["bwrap: "];
/// The Landlock launcher's own failure exit code, part of its CLI contract.
pub const LANDLOCK_FAILURE_EXIT: i32 = 125;
/// The stderr dialect of a Landlock-denied write.
pub const LANDLOCK_DENIAL_SIGNATURES: &[&str] = &["permission denied"];
/// The Landlock launcher's own fatal diagnostic prefix, honoured only with [`LANDLOCK_FAILURE_EXIT`].
pub const LANDLOCK_FATAL_SIGNATURES: &[&str] = &["landlock-run: "];

/// An injected probe verdict for bubblewrap, so selection is judged without spawning anything.
pub type BwrapProbe = Arc<dyn Fn() -> bool + Send + Sync>;
/// An injected probe verdict for Landlock.
pub type LandlockProbeFn = Arc<dyn Fn() -> LandlockProbe + Send + Sync>;

/// The bubblewrap profile arguments for one policy — DSH's argv (`bwrapProfileArgs`).
///
/// Always `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`; under `workspace-write`
/// then `--tmpfs /tmp` (an **ephemeral** temp area) and `--bind <root> <root>` for every writable root that is
/// not the canonical `/tmp` or the canonical host temp dir (the tmpfs covers those).
pub fn bwrap_profile_args(policy: &SandboxExecutionPolicy) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--unshare-pid",
        "--proc",
        "/proc",
        "--die-with-parent",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    if policy.mode == SandboxMode::WorkspaceWrite {
        args.push(OsString::from("--tmpfs"));
        args.push(OsString::from("/tmp"));
        let temp_roots = [canonical(Path::new("/tmp")), canonical(host_temp_dir())];
        for root in writable_roots(policy) {
            if temp_roots.contains(&root) {
                continue;
            }
            args.push(OsString::from("--bind"));
            args.push(root.clone().into_os_string());
            args.push(root.into_os_string());
        }
    }
    args
}

/// How a [`BwrapBackend`] finds and probes bubblewrap.
#[derive(Clone)]
pub struct BwrapOptions {
    /// The command, `bwrap` (looked up on `PATH`, as the TypeScript build does) by default.
    pub command: OsString,
    /// How long the probe may take, 5 s by default.
    pub probe_timeout: Duration,
    /// When set, replaces the real probe and is asked every time (not cached).
    pub probe: Option<BwrapProbe>,
}

impl Default for BwrapOptions {
    fn default() -> BwrapOptions {
        BwrapOptions {
            command: OsString::from("bwrap"),
            probe_timeout: Duration::from_secs(5),
            probe: None,
        }
    }
}

impl fmt::Debug for BwrapOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BwrapOptions")
            .field("command", &self.command)
            .field("probe_timeout", &self.probe_timeout)
            .field("probe", &self.probe.as_ref().map(|_| "injected"))
            .finish()
    }
}

/// The bubblewrap backend (`bwrapBackend`): probe = the read-only profile around `/usr/bin/true` exits 0
/// (cached); confine = `[command, …bwrap_profile_args, "--", …argv]`, `full`, [`BWRAP_DENIAL_SIGNATURES`],
/// one rule with [`BWRAP_FATAL_SIGNATURES`] and no exit-code gate.
#[derive(Debug)]
pub struct BwrapBackend {
    options: BwrapOptions,
    verdict: OnceLock<bool>,
}

impl BwrapBackend {
    /// A backend over `options`; nothing is spawned until the first probe.
    pub fn new(options: BwrapOptions) -> BwrapBackend {
        BwrapBackend {
            options,
            verdict: OnceLock::new(),
        }
    }

    /// Apply the real read-only profile around `true`: exit 0 means the kernel accepted and enforced it.
    fn functional_probe(&self) -> bool {
        let policy = SandboxExecutionPolicy {
            mode: SandboxMode::ReadOnly,
            workspace_root: PathBuf::from("/"),
            extra_writable_roots: Vec::new(),
        };
        let mut args = bwrap_profile_args(&policy);
        args.push(OsString::from("--"));
        args.push(OsString::from("/usr/bin/true"));
        probe_run(
            self.options.command.as_os_str(),
            &args,
            self.options.probe_timeout,
        )
        .status
            == Some(0)
    }
}

impl Default for BwrapBackend {
    fn default() -> BwrapBackend {
        BwrapBackend::new(BwrapOptions::default())
    }
}

impl SandboxBackend for BwrapBackend {
    fn name(&self) -> BackendName {
        BackendName::Bwrap
    }

    fn probe(&self) -> bool {
        if let Some(injected) = &self.options.probe {
            return injected();
        }
        *self.verdict.get_or_init(|| self.functional_probe())
    }

    fn confine(&self, argv: &[OsString], policy: &SandboxExecutionPolicy) -> ConfinedArgv {
        let mut wrapped: Vec<OsString> = Vec::with_capacity(argv.len() + 16);
        wrapped.push(self.options.command.clone());
        wrapped.extend(bwrap_profile_args(policy));
        wrapped.push(OsString::from("--"));
        wrapped.extend(argv.iter().cloned());
        ConfinedArgv {
            argv: wrapped,
            enforcement: SandboxEnforcement::Full,
            denial_signatures: BWRAP_DENIAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect(),
            runner_failure_rules: vec![RunnerFailureRule {
                allowed_exit_codes: None,
                fatal_signatures: BWRAP_FATAL_SIGNATURES
                    .iter()
                    .map(|line| (*line).to_owned())
                    .collect(),
            }],
        }
    }
}

/// The Landlock launcher's grant arguments (`landlockGrantArgs`): `--ro /`, then `--rw /dev/null`, then
/// `--rw <root>` per writable root — read-only grants before read-write ones, as its CLI requires.
pub fn landlock_grant_args(policy: &SandboxExecutionPolicy) -> Vec<OsString> {
    let mut args = vec![OsString::from("--ro"), OsString::from("/")];
    let mut read_write: Vec<PathBuf> = vec![PathBuf::from("/dev/null")];
    read_write.extend(writable_roots(policy));
    for root in read_write {
        args.push(OsString::from("--rw"));
        args.push(root.into_os_string());
    }
    args
}

/// What a Landlock probe reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LandlockProbe {
    /// The launcher applies a ruleset that governs every promised effect.
    Full,
    /// It applies one, but its stdout says `partially enforced`.
    Partial,
    /// It cannot confine on this kernel (non-zero exit, timeout, or no launcher).
    Unusable,
}

/// How a [`LandlockBackend`] finds and probes its launcher.
#[derive(Clone, Default)]
pub struct LandlockOptions {
    /// The operator-configured launcher; never taken from the environment.
    pub runner: Option<PathBuf>,
    /// How long `runner --probe` may take; 5 s when `None`.
    pub probe_timeout: Option<Duration>,
    /// When set, replaces the real probe and is asked every time (not cached).
    pub probe: Option<LandlockProbeFn>,
}

impl fmt::Debug for LandlockOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LandlockOptions")
            .field("runner", &self.runner)
            .field("probe_timeout", &self.probe_timeout)
            .field("probe", &self.probe.as_ref().map(|_| "injected"))
            .finish()
    }
}

/// The Landlock backend (`landlockBackend`): probe = `runner --probe` exits 0 (`partial` when its stdout matches
/// `partially enforced`), cached; confine = `[runner, …landlock_grant_args, "--", …argv]` with the probed
/// enforcement, [`LANDLOCK_DENIAL_SIGNATURES`], one rule gated on [`LANDLOCK_FAILURE_EXIT`] with
/// [`LANDLOCK_FATAL_SIGNATURES`].
#[derive(Debug)]
pub struct LandlockBackend {
    options: LandlockOptions,
    verdict: OnceLock<LandlockProbe>,
}

impl LandlockBackend {
    /// A backend over `options`, or `None` when there is neither a runner nor an injected probe — the rung is
    /// then unavailable and selection moves on (or fails closed).
    pub fn new(options: LandlockOptions) -> Option<LandlockBackend> {
        if options.runner.is_none() && options.probe.is_none() {
            return None;
        }
        Some(LandlockBackend {
            options,
            verdict: OnceLock::new(),
        })
    }

    /// The probe's verdict: an injected probe is asked every time (selection changes between calls in a test);
    /// a real `runner --probe` is run once and cached.
    fn run_probe(&self) -> LandlockProbe {
        if let Some(injected) = &self.options.probe {
            return injected();
        }
        *self.verdict.get_or_init(|| self.functional_probe())
    }

    fn functional_probe(&self) -> LandlockProbe {
        let Some(runner) = &self.options.runner else {
            return LandlockProbe::Unusable;
        };
        let run = probe_run(
            runner.as_os_str(),
            &[OsString::from("--probe")],
            self.options.probe_timeout.unwrap_or(Duration::from_secs(5)),
        );
        match run.status {
            Some(0) => {
                if String::from_utf8_lossy(&run.stdout).contains("partially enforced") {
                    LandlockProbe::Partial
                } else {
                    LandlockProbe::Full
                }
            }
            _ => LandlockProbe::Unusable,
        }
    }
}

impl SandboxBackend for LandlockBackend {
    fn name(&self) -> BackendName {
        BackendName::Landlock
    }

    fn probe(&self) -> bool {
        self.run_probe() != LandlockProbe::Unusable
    }

    fn confine(&self, argv: &[OsString], policy: &SandboxExecutionPolicy) -> ConfinedArgv {
        let enforcement = match self.run_probe() {
            LandlockProbe::Partial => SandboxEnforcement::Partial,
            // The TypeScript maps an unusable probe to `full` here; confine is only reached after a usable
            // probe, so this arm keeps the mapping total without changing a governed call.
            LandlockProbe::Full | LandlockProbe::Unusable => SandboxEnforcement::Full,
        };
        let mut wrapped: Vec<OsString> = Vec::with_capacity(argv.len() + 8);
        // An injected-probe-only backend has no launcher; selection never confines with one, and an empty
        // argv[0] fails to spawn rather than running the command unconfined.
        wrapped.push(
            self.options
                .runner
                .as_ref()
                .map(|runner| runner.clone().into_os_string())
                .unwrap_or_default(),
        );
        wrapped.extend(landlock_grant_args(policy));
        wrapped.push(OsString::from("--"));
        wrapped.extend(argv.iter().cloned());
        ConfinedArgv {
            argv: wrapped,
            enforcement,
            denial_signatures: LANDLOCK_DENIAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect(),
            runner_failure_rules: vec![RunnerFailureRule {
                allowed_exit_codes: Some(vec![LANDLOCK_FAILURE_EXIT]),
                fatal_signatures: LANDLOCK_FATAL_SIGNATURES
                    .iter()
                    .map(|line| (*line).to_owned())
                    .collect(),
            }],
        }
    }
}

/// The Linux chain in DSH's order (`selectLinuxBackend`): bubblewrap when its probe passes, else Landlock when
/// present and its probe passes, else `None` — and the caller fails closed. The candidates are parameters so the
/// order is judged without spawning anything.
pub fn select_linux_backend(
    bwrap: Arc<dyn SandboxBackend>,
    landlock: Option<Arc<dyn SandboxBackend>>,
) -> Option<Arc<dyn SandboxBackend>> {
    if bwrap.probe() {
        return Some(bwrap);
    }
    match landlock {
        Some(backend) if backend.probe() => Some(backend),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::{
        BWRAP_DENIAL_SIGNATURES, BWRAP_FATAL_SIGNATURES, BwrapBackend, BwrapOptions, BwrapProbe,
        LANDLOCK_DENIAL_SIGNATURES, LANDLOCK_FAILURE_EXIT, LANDLOCK_FATAL_SIGNATURES,
        LandlockBackend, LandlockOptions, LandlockProbe, LandlockProbeFn, bwrap_profile_args,
        landlock_grant_args, select_linux_backend,
    };
    use crate::backend::{BackendName, ConfinedArgv, SandboxBackend, SandboxEnforcement};
    use crate::mode::{SandboxExecutionPolicy, SandboxMode, host_temp_dir, writable_roots};
    use crate::paths::canonical;
    use crate::testfs::{TempDir, script};

    fn policy(mode: SandboxMode, workspace: impl Into<PathBuf>) -> SandboxExecutionPolicy {
        SandboxExecutionPolicy {
            mode,
            workspace_root: workspace.into(),
            extra_writable_roots: Vec::new(),
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    const BWRAP_BASE: [&str; 9] = [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--unshare-pid",
        "--proc",
        "/proc",
        "--die-with-parent",
    ];

    fn base_args() -> Vec<String> {
        BWRAP_BASE.iter().map(|arg| (*arg).to_owned()).collect()
    }

    fn binds(args: &[String]) -> Vec<(String, String)> {
        args.windows(3)
            .filter(|window| window[0] == "--bind")
            .map(|window| (window[1].clone(), window[2].clone()))
            .collect()
    }

    #[test]
    fn the_read_only_bwrap_profile_is_the_golden_argv() {
        assert_eq!(
            strings(&bwrap_profile_args(&policy(
                SandboxMode::ReadOnly,
                "/tmp/ws"
            ))),
            BWRAP_BASE
        );
    }

    #[test]
    fn the_workspace_write_bwrap_profile_mounts_an_ephemeral_tmp_and_binds_every_other_root() {
        let dir = TempDir::new("bwrap-profile");
        let workspace = dir.child("ws");
        let extra = dir.child("extra");
        let mut subject = policy(SandboxMode::WorkspaceWrite, &workspace);
        subject.extra_writable_roots = vec![extra.clone()];

        let args = strings(&bwrap_profile_args(&subject));
        assert_eq!(&args[..9], &base_args()[..]);
        assert_eq!(&args[9..11], &["--tmpfs".to_owned(), "/tmp".to_owned()][..]);

        let workspace = canonical(&workspace).display().to_string();
        let extra = canonical(&extra).display().to_string();
        let binds = binds(&args);
        assert!(binds.contains(&(workspace.clone(), workspace.clone())));
        assert!(binds.contains(&(extra.clone(), extra.clone())));

        for temp_root in [
            canonical(std::path::Path::new("/tmp")),
            canonical(host_temp_dir()),
        ] {
            let temp_root = temp_root.display().to_string();
            assert!(
                !binds
                    .iter()
                    .any(|(from, to)| *from == temp_root && *to == temp_root),
                "the tmpfs covers {temp_root}, so it is not bound back in"
            );
        }
    }

    #[test]
    fn the_read_only_landlock_grants_are_the_golden_argv() {
        assert_eq!(
            strings(&landlock_grant_args(&policy(
                SandboxMode::ReadOnly,
                "/tmp/ws"
            ))),
            ["--ro", "/", "--rw", "/dev/null"]
        );
    }

    #[test]
    fn the_workspace_write_landlock_grants_come_read_only_then_read_write() {
        let dir = TempDir::new("landlock-grants");
        let workspace = dir.child("ws");
        let subject = policy(SandboxMode::WorkspaceWrite, &workspace);
        let args = strings(&landlock_grant_args(&subject));

        assert_eq!(&args[..4], ["--ro", "/", "--rw", "/dev/null"]);
        let expected: Vec<String> = writable_roots(&subject)
            .iter()
            .map(|root| root.display().to_string())
            .collect();
        let granted: Vec<String> = args[4..]
            .chunks(2)
            .map(|pair| {
                assert_eq!(pair[0], "--rw");
                pair[1].clone()
            })
            .collect();
        assert_eq!(granted, expected);
    }

    fn bwrap_over(command: &std::path::Path, probe_timeout: Duration) -> BwrapBackend {
        BwrapBackend::new(BwrapOptions {
            command: command.as_os_str().to_owned(),
            probe_timeout,
            probe: None,
        })
    }

    #[test]
    fn an_injected_bwrap_probe_is_asked_every_time() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let probe: BwrapProbe = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            true
        });
        let backend = BwrapBackend::new(BwrapOptions {
            probe: Some(probe),
            ..BwrapOptions::default()
        });
        assert!(backend.probe());
        assert!(backend.probe());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "an injected probe is not cached"
        );
    }

    #[test]
    fn a_bwrap_runner_that_accepts_the_profile_probes_usable_and_is_cached() {
        let dir = TempDir::new("bwrap-probe");
        let counter = dir.join("runs");
        let runner = script(
            &dir,
            "bwrap",
            &format!("#!/bin/sh\necho run >> {}\nexit 0\n", counter.display()),
        );
        let backend = bwrap_over(&runner, Duration::from_secs(2));
        assert!(backend.probe());
        assert!(backend.probe());
        let runs = std::fs::read_to_string(&counter).expect("the counter");
        assert_eq!(runs.lines().count(), 1, "the real probe runs once");
    }

    #[test]
    fn a_bwrap_runner_that_fails_or_hangs_probes_unusable() {
        let dir = TempDir::new("bwrap-fail");
        let failing = script(&dir, "failing", "#!/bin/sh\nexit 1\n");
        assert!(!bwrap_over(&failing, Duration::from_secs(2)).probe());

        let hanging = script(&dir, "hanging", "#!/bin/sh\nexec /bin/sleep 10\n");
        let started = Instant::now();
        assert!(!bwrap_over(&hanging, Duration::from_millis(150)).probe());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn the_bwrap_confine_argv_is_command_profile_separator_and_call() {
        let backend = bwrap_over(std::path::Path::new("/opt/bwrap"), Duration::from_secs(1));
        let argv = vec![
            OsString::from("/bin/sh"),
            OsString::from("-c"),
            OsString::from("true"),
        ];
        let confined = backend.confine(&argv, &policy(SandboxMode::ReadOnly, "/tmp/ws"));
        assert_eq!(confined.argv[0], OsString::from("/opt/bwrap"));
        assert_eq!(
            &strings(&confined.argv[1..10]),
            &base_args()[..],
            "the profile sits between the command and the separator"
        );
        assert_eq!(confined.argv[10], OsString::from("--"));
        assert_eq!(&confined.argv[11..], &argv[..]);
        assert_eq!(confined.enforcement, SandboxEnforcement::Full);
        assert_eq!(
            confined.denial_signatures,
            BWRAP_DENIAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect::<Vec<_>>()
        );
        assert_eq!(confined.runner_failure_rules.len(), 1);
        assert_eq!(confined.runner_failure_rules[0].allowed_exit_codes, None);
        assert_eq!(
            confined.runner_failure_rules[0].fatal_signatures,
            BWRAP_FATAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_landlock_backend_needs_a_runner_or_an_injected_probe() {
        assert!(LandlockBackend::new(LandlockOptions::default()).is_none());
        assert!(
            LandlockBackend::new(LandlockOptions {
                probe: Some(Arc::new(|| LandlockProbe::Full)),
                ..LandlockOptions::default()
            })
            .is_some()
        );
    }

    #[test]
    fn an_injected_landlock_probe_maps_every_verdict() {
        let full: LandlockProbeFn = Arc::new(|| LandlockProbe::Full);
        let backend = LandlockBackend::new(LandlockOptions {
            probe: Some(full),
            ..LandlockOptions::default()
        })
        .unwrap();
        assert!(backend.probe());
        assert_eq!(
            backend
                .confine(
                    &[OsString::from("sh")],
                    &policy(SandboxMode::ReadOnly, "/tmp/ws")
                )
                .enforcement,
            SandboxEnforcement::Full
        );

        let partial: LandlockProbeFn = Arc::new(|| LandlockProbe::Partial);
        let backend = LandlockBackend::new(LandlockOptions {
            probe: Some(partial),
            ..LandlockOptions::default()
        })
        .unwrap();
        assert!(backend.probe());
        assert_eq!(
            backend
                .confine(
                    &[OsString::from("sh")],
                    &policy(SandboxMode::ReadOnly, "/tmp/ws")
                )
                .enforcement,
            SandboxEnforcement::Partial,
            "a partially enforced kernel is a fact the caller reports"
        );

        let unusable: LandlockProbeFn = Arc::new(|| LandlockProbe::Unusable);
        let backend = LandlockBackend::new(LandlockOptions {
            probe: Some(unusable),
            ..LandlockOptions::default()
        })
        .unwrap();
        assert!(!backend.probe());
    }

    #[test]
    fn a_real_landlock_probe_reads_partially_enforced_from_stdout() {
        let dir = TempDir::new("landlock-probe");
        let partial = script(
            &dir,
            "landlock-run",
            "#!/bin/sh\necho 'ruleset applied; partially enforced'\nexit 0\n",
        );
        let backend = LandlockBackend::new(LandlockOptions {
            runner: Some(partial),
            probe_timeout: Some(Duration::from_secs(2)),
            probe: None,
        })
        .unwrap();
        assert!(backend.probe());
        assert_eq!(
            backend
                .confine(
                    &[OsString::from("sh")],
                    &policy(SandboxMode::ReadOnly, "/tmp/ws")
                )
                .enforcement,
            SandboxEnforcement::Partial
        );

        let full = script(&dir, "full", "#!/bin/sh\nexit 0\n");
        let backend = LandlockBackend::new(LandlockOptions {
            runner: Some(full),
            probe_timeout: Some(Duration::from_secs(2)),
            probe: None,
        })
        .unwrap();
        assert!(backend.probe());
        assert_eq!(
            backend
                .confine(
                    &[OsString::from("sh")],
                    &policy(SandboxMode::ReadOnly, "/tmp/ws")
                )
                .enforcement,
            SandboxEnforcement::Full
        );

        let refusing = script(&dir, "refusing", "#!/bin/sh\nexit 125\n");
        let backend = LandlockBackend::new(LandlockOptions {
            runner: Some(refusing),
            probe_timeout: Some(Duration::from_secs(2)),
            probe: None,
        })
        .unwrap();
        assert!(!backend.probe());
    }

    #[test]
    fn the_landlock_confine_argv_carries_the_launcher_grants_separator_and_call() {
        let dir = TempDir::new("landlock-confine");
        let runner = script(&dir, "landlock-run", "#!/bin/sh\nexit 0\n");
        let backend = LandlockBackend::new(LandlockOptions {
            runner: Some(runner.clone()),
            probe_timeout: Some(Duration::from_secs(2)),
            probe: None,
        })
        .unwrap();
        let policy = policy(SandboxMode::ReadOnly, "/tmp/ws");
        let confined = backend.confine(&[OsString::from("sh")], &policy);
        assert_eq!(confined.argv[0], runner.into_os_string());
        assert_eq!(
            &confined.argv[1..5],
            &[
                OsString::from("--ro"),
                OsString::from("/"),
                OsString::from("--rw"),
                OsString::from("/dev/null")
            ][..]
        );
        assert_eq!(confined.argv[5], OsString::from("--"));
        assert_eq!(confined.argv[6], OsString::from("sh"));
        assert_eq!(
            confined.denial_signatures,
            LANDLOCK_DENIAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            confined.runner_failure_rules[0].allowed_exit_codes,
            Some(vec![LANDLOCK_FAILURE_EXIT])
        );
        assert_eq!(
            confined.runner_failure_rules[0].fatal_signatures,
            LANDLOCK_FATAL_SIGNATURES
                .iter()
                .map(|line| (*line).to_owned())
                .collect::<Vec<_>>()
        );
    }

    /// A backend whose probe answers one fixed verdict, so the chain's order is judged without spawning.
    struct Stub {
        name: BackendName,
        verdict: bool,
        probes: Arc<AtomicUsize>,
    }

    impl Stub {
        fn new(name: BackendName, verdict: bool) -> Arc<Stub> {
            Arc::new(Stub {
                name,
                verdict,
                probes: Arc::new(AtomicUsize::new(0)),
            })
        }
    }

    impl SandboxBackend for Stub {
        fn name(&self) -> BackendName {
            self.name
        }

        fn probe(&self) -> bool {
            self.probes.fetch_add(1, Ordering::SeqCst);
            self.verdict
        }

        fn confine(&self, argv: &[OsString], _policy: &SandboxExecutionPolicy) -> ConfinedArgv {
            ConfinedArgv::unconfined(argv)
        }
    }

    #[test]
    fn the_linux_chain_prefers_bwrap_and_only_then_landlock() {
        let bwrap = Stub::new(BackendName::Bwrap, true);
        let landlock = Stub::new(BackendName::Landlock, true);
        let chosen = select_linux_backend(bwrap, Some(landlock.clone())).expect("bwrap");
        assert_eq!(chosen.name(), BackendName::Bwrap);
        assert_eq!(
            landlock.probes.load(Ordering::SeqCst),
            0,
            "the Landlock rung is not probed once bubblewrap answers"
        );

        let bwrap = Stub::new(BackendName::Bwrap, false);
        let landlock = Stub::new(BackendName::Landlock, true);
        let chosen = select_linux_backend(bwrap, Some(landlock)).expect("landlock");
        assert_eq!(chosen.name(), BackendName::Landlock);

        let bwrap = Stub::new(BackendName::Bwrap, false);
        let landlock = Stub::new(BackendName::Landlock, false);
        assert!(select_linux_backend(bwrap, Some(landlock)).is_none());

        let bwrap = Stub::new(BackendName::Bwrap, false);
        assert!(
            select_linux_backend(bwrap, None).is_none(),
            "no chain, so the caller fails closed"
        );
    }
}
