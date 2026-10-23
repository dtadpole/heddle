//! The Linux rungs: bubblewrap first, Landlock second, both behind the same backend contract.
//!
//! Ported from `src/sandbox/linux.ts`. The profiles are DSH's. The launchers are **not** bundled: bubblewrap
//! is a standard system binary, and Landlock's launcher is a versioned external executable whose path is
//! configuration (`landlockRunner`). A missing launcher probes unusable and the call fails closed, which is the
//! honest answer on a host heddle cannot confine.

use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::backend::{BackendName, ConfinedArgv, SandboxBackend};
use crate::mode::SandboxExecutionPolicy;

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
    let _ = policy;
    todo!("port bwrapProfileArgs from src/sandbox/linux.ts")
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
        let _ = (&self.options, &self.verdict);
        todo!("injected probe, else the cached functional probe")
    }

    fn confine(&self, argv: &[OsString], policy: &SandboxExecutionPolicy) -> ConfinedArgv {
        let _ = (argv, policy);
        todo!("wrap argv under bwrap_profile_args(policy)")
    }
}

/// The Landlock launcher's grant arguments (`landlockGrantArgs`): `--ro /`, then `--rw /dev/null`, then
/// `--rw <root>` per writable root — read-only grants before read-write ones, as its CLI requires.
pub fn landlock_grant_args(policy: &SandboxExecutionPolicy) -> Vec<OsString> {
    let _ = policy;
    todo!("port landlockGrantArgs from src/sandbox/linux.ts")
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
}

impl SandboxBackend for LandlockBackend {
    fn name(&self) -> BackendName {
        BackendName::Landlock
    }

    fn probe(&self) -> bool {
        let _ = (&self.options, &self.verdict);
        todo!("the probe's verdict is not Unusable")
    }

    fn confine(&self, argv: &[OsString], policy: &SandboxExecutionPolicy) -> ConfinedArgv {
        let _ = (argv, policy);
        todo!("wrap argv under landlock_grant_args(policy), enforcement from the probe")
    }
}

/// The Linux chain in DSH's order (`selectLinuxBackend`): bubblewrap when its probe passes, else Landlock when
/// present and its probe passes, else `None` — and the caller fails closed. The candidates are parameters so the
/// order is judged without spawning anything.
pub fn select_linux_backend(
    bwrap: Arc<dyn SandboxBackend>,
    landlock: Option<Arc<dyn SandboxBackend>>,
) -> Option<Arc<dyn SandboxBackend>> {
    let _ = (bwrap, landlock);
    todo!("port selectLinuxBackend from src/sandbox/linux.ts")
}
