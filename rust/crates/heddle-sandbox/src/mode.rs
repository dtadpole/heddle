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
    if policy.mode != SandboxMode::WorkspaceWrite {
        return Vec::new();
    }
    let mut candidates: Vec<PathBuf> = Vec::with_capacity(4 + policy.extra_writable_roots.len());
    candidates.push(policy.workspace_root.clone());
    candidates.extend(policy.extra_writable_roots.iter().cloned());
    candidates.push(PathBuf::from("/tmp"));
    candidates.push(host_temp_dir());
    let mut roots: Vec<PathBuf> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let root = crate::paths::canonical(&candidate);
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
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
    let chosen = ["TMPDIR", "TMP", "TEMP"]
        .into_iter()
        .filter_map(&lookup)
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| "/tmp".to_owned());
    let trimmed = if chosen.len() > 1 && chosen.ends_with('/') {
        &chosen[..chosen.len() - 1]
    } else {
        chosen.as_str()
    };
    PathBuf::from(trimmed)
}

/// The policy as one model-visible sentence (`sandboxPolicyStatement`) — the `sandbox:policy` section of
/// the runtime-context snapshot. Verifiers match its prefix `Current heddle file policy: <mode>`, and under
/// `workspace-write` the quoted workspace path.
pub fn policy_statement(policy: &SandboxExecutionPolicy) -> String {
    match policy.mode {
        SandboxMode::ReadOnly => "Current heddle file policy: read-only. Any available operation enforced by heddle’s file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial guidance it returns.".to_owned(),
        SandboxMode::WorkspaceWrite => format!(
            "Current heddle file policy: workspace-write. Any available operation enforced by heddle’s file sandbox may modify files under the session workspace: \"{}\". The host temp areas may also be writable.",
            policy.workspace_root.display()
        ),
        SandboxMode::DangerFullAccess => "Current heddle file policy: danger-full-access. The heddle file sandbox does not restrict file modifications by available operations.".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        SandboxExecutionPolicy, SandboxMode, host_temp_dir, host_temp_dir_from, policy_statement,
        writable_roots,
    };
    use crate::paths::canonical;
    use crate::testfs::TempDir;

    fn policy(
        mode: SandboxMode,
        workspace: impl Into<std::path::PathBuf>,
    ) -> SandboxExecutionPolicy {
        SandboxExecutionPolicy {
            mode,
            workspace_root: workspace.into(),
            extra_writable_roots: Vec::new(),
        }
    }

    /// An environment lookup over a fixed table, so the rule is judged without touching the process.
    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn the_ladder_is_the_variant_order_and_exact_words_parse() {
        assert!(SandboxMode::ReadOnly < SandboxMode::WorkspaceWrite);
        assert!(SandboxMode::WorkspaceWrite < SandboxMode::DangerFullAccess);
        assert_eq!(
            [0, 1, 2],
            [
                SandboxMode::ReadOnly.rank(),
                SandboxMode::WorkspaceWrite.rank(),
                SandboxMode::DangerFullAccess.rank(),
            ]
        );
        assert_eq!(
            SandboxMode::parse("workspace-write"),
            Some(SandboxMode::WorkspaceWrite)
        );
        for refused in [
            "Workspace-Write",
            " workspace-write",
            "workspace-write ",
            "workspace_write",
        ] {
            assert_eq!(
                SandboxMode::parse(refused),
                None,
                "{refused:?} is not the word"
            );
        }
    }

    #[test]
    fn writable_roots_is_empty_outside_workspace_write() {
        let dir = TempDir::new("roots-empty");
        assert!(writable_roots(&policy(SandboxMode::ReadOnly, dir.path())).is_empty());
        assert!(writable_roots(&policy(SandboxMode::DangerFullAccess, dir.path())).is_empty());
    }

    #[test]
    fn writable_roots_is_the_workspace_extra_roots_and_the_two_temp_areas_canonicalised() {
        let dir = TempDir::new("roots-set");
        let workspace = dir.child("ws");
        let extra = dir.child("extra");
        let mut subject = policy(SandboxMode::WorkspaceWrite, &workspace);
        subject.extra_writable_roots = vec![extra.clone()];

        let roots = writable_roots(&subject);
        let mut expected = vec![canonical(&workspace), canonical(&extra)];
        for built_in in [std::path::PathBuf::from("/tmp"), host_temp_dir()] {
            let root = canonical(&built_in);
            if !expected.contains(&root) {
                expected.push(root);
            }
        }
        assert_eq!(roots, expected);
        assert_eq!(roots[0], canonical(&workspace), "the workspace comes first");
    }

    #[test]
    fn writable_roots_removes_duplicates_and_keeps_first_seen_order() {
        let dir = TempDir::new("roots-dedup");
        let workspace = dir.child("ws");
        let mut subject = policy(SandboxMode::WorkspaceWrite, &workspace);
        subject.extra_writable_roots = vec![workspace.clone(), std::path::PathBuf::from("/tmp")];

        let roots = writable_roots(&subject);
        let workspace_root = canonical(&workspace);
        let temp_root = canonical(std::path::Path::new("/tmp"));
        assert_eq!(roots[0], workspace_root);
        assert_eq!(
            roots.iter().filter(|root| **root == workspace_root).count(),
            1
        );
        assert_eq!(
            roots.iter().filter(|root| **root == temp_root).count(),
            1,
            "named extra root and the built-in /tmp are one root"
        );
    }

    #[test]
    fn writable_roots_resolves_a_symlinked_workspace_to_its_target() {
        let dir = TempDir::new("roots-symlink");
        let real = dir.child("real");
        let link = dir.join("link");
        crate::testfs::symlink(&real, &link);

        let roots = writable_roots(&policy(SandboxMode::WorkspaceWrite, &link));
        assert_eq!(
            roots[0],
            canonical(&real),
            "Seatbelt matches resolved paths"
        );
        assert_ne!(
            roots[0], link,
            "the link itself is not a root the kernel can match"
        );
    }

    #[test]
    fn the_host_temp_area_follows_tmpdir_then_tmp_then_temp_then_tmp() {
        let dir = std::path::PathBuf::from;

        assert_eq!(
            host_temp_dir_from(env(&[("TMPDIR", "/var/folders/ab/")])),
            dir("/var/folders/ab"),
            "one trailing slash is stripped"
        );
        assert_eq!(
            host_temp_dir_from(env(&[("TMP", "/var/tmp")])),
            dir("/var/tmp"),
            "TMP is read when TMPDIR is unset"
        );
        assert_eq!(
            host_temp_dir_from(env(&[("TMPDIR", ""), ("TMP", "/var/tmp")])),
            dir("/var/tmp"),
            "an empty value counts as unset"
        );
        assert_eq!(
            host_temp_dir_from(env(&[("TMPDIR", ""), ("TMP", ""), ("TEMP", "/tmp/")])),
            dir("/tmp"),
            "TEMP is the last variable"
        );
        assert_eq!(host_temp_dir_from(env(&[])), dir("/tmp"), "nothing set");
        assert_eq!(
            host_temp_dir_from(env(&[("TMPDIR", "/")])),
            dir("/"),
            "a bare root keeps its slash"
        );
        assert_eq!(
            host_temp_dir_from(env(&[("TMPDIR", "/tmp//")])),
            dir("/tmp/"),
            "exactly one trailing slash is stripped"
        );
    }

    #[test]
    fn the_policy_statement_is_byte_for_byte_the_typescript_sentence() {
        let workspace = std::path::Path::new("/tmp/ws");
        assert_eq!(
            policy_statement(&policy(SandboxMode::ReadOnly, workspace)),
            "Current heddle file policy: read-only. Any available operation enforced by heddle’s file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial guidance it returns."
        );
        assert_eq!(
            policy_statement(&policy(SandboxMode::WorkspaceWrite, workspace)),
            "Current heddle file policy: workspace-write. Any available operation enforced by heddle’s file sandbox may modify files under the session workspace: \"/tmp/ws\". The host temp areas may also be writable."
        );
        assert_eq!(
            policy_statement(&policy(SandboxMode::DangerFullAccess, workspace)),
            "Current heddle file policy: danger-full-access. The heddle file sandbox does not restrict file modifications by available operations."
        );
    }

    #[test]
    fn the_workspace_quote_carries_the_path_as_given() {
        let subject = SandboxExecutionPolicy {
            mode: SandboxMode::WorkspaceWrite,
            workspace_root: std::path::PathBuf::from("/Users/someone/work tree"),
            extra_writable_roots: Vec::new(),
        };
        assert!(
            policy_statement(&subject).contains("session workspace: \"/Users/someone/work tree\"."),
            "the path is quoted verbatim, spaces and all"
        );
    }
}
