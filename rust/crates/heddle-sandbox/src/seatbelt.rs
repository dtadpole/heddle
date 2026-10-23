//! The macOS Seatbelt rung.
//!
//! Ported from `src/sandbox/seatbelt.ts`. The profile is DSH's: allow-default, deny every write, keep
//! `/dev/null` as the one literal sink a shell expects, and grant one canonical `(subpath …)` per writable
//! root. `sandbox-exec` rides Apple's deprecated private policy engine; the functional probe is what fails
//! closed if the command ever disappears.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use crate::backend::{BackendName, ConfinedArgv, SandboxBackend};
use crate::mode::SandboxExecutionPolicy;

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
    let _ = policy;
    todo!("port seatbeltProfileArgs from src/sandbox/seatbelt.ts")
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
        let _ = (&self.options, &self.verdict);
        todo!("functional probe, cached in self.verdict")
    }

    fn confine(&self, argv: &[OsString], policy: &SandboxExecutionPolicy) -> ConfinedArgv {
        let _ = (argv, policy);
        todo!("wrap argv under seatbelt_profile_args(policy)")
    }
}
