//! The mode vocabulary, the resolved per-call policy, and the one writable-root set.
//!
//! Ported from `src/sandbox/policy.ts`. The vocabulary and the writable-root list live here, not in the
//! service, because the service, the in-process file fence and every kernel profile consume them: one home is
//! what keeps the kernel boundary and the in-process check from drifting.

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// How much of the filesystem a call may touch.
///
/// The three words are DSH's: `read-only` permits only the required sinks, `workspace-write` adds the
/// workspace and the host temp areas, and `danger-full-access` is the escape hatch a person asks for by name.
///
/// **The variant order is the ladder, narrowest first**, so the derived `Ord` *is* "wider": an escalation
/// is a move to a greater mode, and full access ranks above the boundary the two confined modes keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    /// `read-only` — no writable root; `/dev/null` is a literal exception in each kernel profile.
    ReadOnly,
    /// `workspace-write` — the workspace, the named extra roots and the host temp areas.
    WorkspaceWrite,
    /// `danger-full-access` — the only bypass; no backend is consulted.
    DangerFullAccess,
}

impl SandboxMode {
    /// The closed vocabulary, narrowest first (`SANDBOX_MODES`).
    pub const ALL: [SandboxMode; 3] = [
        SandboxMode::ReadOnly,
        SandboxMode::WorkspaceWrite,
        SandboxMode::DangerFullAccess,
    ];

    /// The wire word: `read-only`, `workspace-write` or `danger-full-access`.
    pub const fn as_str(self) -> &'static str {
        match self {
            SandboxMode::ReadOnly => "read-only",
            SandboxMode::WorkspaceWrite => "workspace-write",
            SandboxMode::DangerFullAccess => "danger-full-access",
        }
    }

    /// Where the mode sits on the ladder: 0 read-only, 1 workspace-write, 2 danger-full-access
    /// (`sandboxModeRank`).
    pub const fn rank(self) -> u8 {
        match self {
            SandboxMode::ReadOnly => 0,
            SandboxMode::WorkspaceWrite => 1,
            SandboxMode::DangerFullAccess => 2,
        }
    }

    /// The mode a word names, or `None` — so a stored or posted word cannot become a policy
    /// (`isSandboxMode`). Exact match only: no trimming, no case folding.
    pub fn parse(word: &str) -> Option<SandboxMode> {
        SandboxMode::ALL
            .into_iter()
            .find(|mode| mode.as_str() == word)
    }
}

impl fmt::Display for SandboxMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A word outside the three modes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("'{word}' is not one of read-only, workspace-write, danger-full-access")]
pub struct UnknownMode {
    /// The word that was refused, verbatim.
    pub word: String,
}

impl FromStr for SandboxMode {
    type Err = UnknownMode;

    fn from_str(word: &str) -> Result<Self, Self::Err> {
        SandboxMode::parse(word).ok_or_else(|| UnknownMode {
            word: word.to_owned(),
        })
    }
}

/// One resolved policy, which is what a check is actually decided against (`SandboxExecutionPolicy`).
///
/// The roots are expected to be canonical already (the service canonicalises them once at construction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxExecutionPolicy {
    /// The mode this call runs under — the session's effective mode or an approved one-call escalation.
    pub mode: SandboxMode,
    /// The workspace the mode promises.
    pub workspace_root: PathBuf,
    /// Extra absolute roots a write may also reach, named one by one.
    pub extra_writable_roots: Vec<PathBuf>,
}

/// The writable-root set — **the** fact the fence and every kernel profile share (`writableRoots`).
///
/// Under `workspace-write`: the workspace, the extra roots, `/tmp` and [`host_temp_dir`], each passed through
/// [`crate::paths::canonical`] (Seatbelt matches resolved paths, so `/tmp` is `/private/tmp` on macOS), with
/// duplicates removed and first-seen order kept. Under `read-only` and `danger-full-access`: empty —
/// `read-only` has no writable root, and full access is not a root set at all.
pub fn writable_roots(policy: &SandboxExecutionPolicy) -> Vec<PathBuf> {
    let _ = policy;
    todo!("port writableRoots from src/sandbox/policy.ts")
}

/// The host temp area as Node's `os.tmpdir()` reports it on POSIX, read from the process environment.
///
/// `$TMPDIR`, else `$TMP`, else `$TEMP`, else `/tmp`, with one trailing `/` removed (unless the value is
/// `/`). Not `std::env::temp_dir()`, which reads only `$TMPDIR`: the TypeScript build's root set is the
/// contract.
pub fn host_temp_dir() -> PathBuf {
    host_temp_dir_from(|name| std::env::var(name).ok())
}

/// [`host_temp_dir`] over an explicit lookup, so the rule is judged without touching the process environment.
/// An empty value counts as unset, as in Node.
pub fn host_temp_dir_from(lookup: impl Fn(&str) -> Option<String>) -> PathBuf {
    let _ = lookup;
    todo!("port os.tmpdir()'s POSIX rule")
}

/// The policy as one model-visible sentence (`sandboxPolicyStatement`) — the `sandbox:policy` section of
/// the runtime-context snapshot. Verifiers match its prefix `Current heddle file policy: <mode>`, and under
/// `workspace-write` the quoted workspace path.
pub fn policy_statement(policy: &SandboxExecutionPolicy) -> String {
    let _ = policy;
    todo!("port sandboxPolicyStatement from src/sandbox/policy.ts, byte for byte")
}
