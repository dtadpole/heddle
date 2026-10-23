//! The sandbox service: one policy, two jobs.
//!
//! Ported from `SandboxService` in `src/sandbox/service.ts`. For the harness's own file tools it is an
//! **in-process fence** — may this path be written or read — decided on canonical paths, by component, because
//! `/tmp/workspace-2` starts with `/tmp/workspace` as a string and a symlink inside the workspace to `/etc` is
//! the other half of the same trap. For a shell it is a **backend seam**: it hands the caller a kernel-wrapped
//! argv and the facts needed to classify the result, or refuses (fails closed) when nothing can confine.
//!
//! Every check takes the **call's** mode explicitly. The tool registry resolves it once per call (the session's
//! own mode over [`SandboxService::mode`], or an approved one-call escalation), so one service decides two calls
//! under two sessions at the same instant.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::backend::{
    BackendName, ConfinedArgv, Platform, SandboxBackend, SandboxUnavailableError,
};
use crate::mode::{SandboxExecutionPolicy, SandboxMode};

/// Which runner may confine a shell call (`backend` in the profile row).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum BackendChoice {
    /// `auto`: the platform's chain, probed on first use.
    #[default]
    #[serde(rename = "auto")]
    Auto,
    /// `none`: no backend at all, so every confined shell call fails closed (what the fail-closed check uses).
    #[serde(rename = "none")]
    Disabled,
}

/// The `sandbox` row's `config`, as the profile writes it (camelCase keys).
///
/// Unknown keys are ignored, not refused: the TypeScript schema strips them, and the verifiers' profiles still
/// carry a retired `tempRoot` key. A mode outside the vocabulary is a deserialisation error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SandboxConfig {
    /// The deployment mode; `workspace-write` by default.
    pub mode: SandboxMode,
    /// The directory writes are confined to; the process's current directory when absent. Relative paths
    /// resolve against it too.
    pub workspace_root: Option<PathBuf>,
    /// Extra roots a write may also reach, beyond the workspace and the host temp areas.
    pub extra_writable_roots: Vec<PathBuf>,
    /// `auto` or `none`.
    pub backend: BackendChoice,
    /// The Landlock launcher on Linux. Configuration, never an environment variable: which binary confines a
    /// process must not be decidable by the environment a session inherited.
    pub landlock_runner: Option<PathBuf>,
}

impl Default for SandboxConfig {
    fn default() -> SandboxConfig {
        SandboxConfig {
            mode: SandboxMode::WorkspaceWrite,
            workspace_root: None,
            extra_writable_roots: Vec::new(),
            backend: BackendChoice::Auto,
            landlock_runner: None,
        }
    }
}

/// The facts about the host the service is built on, passed in rather than read inside it so a test can
/// choose them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxHost {
    /// The process's directory — the workspace when the config names none.
    pub cwd: PathBuf,
    /// The harness's own directory (`$HEDDLE_HOME`, else `~/.heddle`), as the configuration crate resolves it.
    /// A confined run may read under it, so it can read the profile it started from and its own uploads.
    pub harness_home: PathBuf,
    /// Which backend chain applies.
    pub platform: Platform,
}

impl SandboxHost {
    /// The current directory and platform, with the harness home the caller resolved.
    pub fn detect(harness_home: impl Into<PathBuf>) -> std::io::Result<SandboxHost> {
        Ok(SandboxHost {
            cwd: std::env::current_dir()?,
            harness_home: harness_home.into(),
            platform: Platform::current(),
        })
    }
}

/// Why the fence refused a path (`SandboxDenial`); the registry reports it under [`SandboxDenial::CODE`] with
/// the message as the tool result's message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SandboxDenial {
    /// The sentence a person and the model read; verifiers match `outside the sandbox root` and `read-only`.
    pub message: String,
    /// The resolved, canonical path that was refused.
    pub path: PathBuf,
    /// The call's mode.
    pub mode: SandboxMode,
    /// The canonical workspace.
    pub workspace_root: PathBuf,
}

impl SandboxDenial {
    /// The tool-result error code a fence refusal is reported under.
    pub const CODE: &'static str = "SANDBOX";
}

/// The sandbox service (`SandboxService`). Share it as `Arc<SandboxService>`; every method takes `&self`.
pub struct SandboxService {
    mode: SandboxMode,
    workspace_root: PathBuf,
    extra_writable_roots: Vec<PathBuf>,
    harness_home: PathBuf,
    backend: Option<Arc<dyn SandboxBackend>>,
}

impl SandboxService {
    /// Build the service: the roots are canonicalised once here, and the backend is selected with
    /// [`crate::backend::select_backend`] for `host.platform` unless `config.backend` is `none`. Nothing is
    /// probed until a call needs it.
    pub fn new(config: &SandboxConfig, host: &SandboxHost) -> SandboxService {
        let _ = (config, host);
        todo!("canonicalise the roots and select the backend")
    }

    /// [`SandboxService::new`] with the backend chosen by the caller (a test double, or `None` for no backend);
    /// `config.backend` and `config.landlock_runner` are then ignored.
    pub fn with_backend(
        config: &SandboxConfig,
        host: &SandboxHost,
        backend: Option<Arc<dyn SandboxBackend>>,
    ) -> SandboxService {
        let _ = (config, host, backend);
        todo!("canonicalise the roots and keep the given backend")
    }

    /// The deployment mode — what a call runs under when its session records none.
    pub fn mode(&self) -> SandboxMode {
        self.mode
    }

    /// The canonical workspace; also the shell's working directory.
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    /// The canonical extra writable roots.
    pub fn extra_writable_roots(&self) -> &[PathBuf] {
        &self.extra_writable_roots
    }

    /// The policy a call under `mode` runs under, so every consumer shares one value (`policy(mode)`).
    pub fn policy(&self, mode: SandboxMode) -> SandboxExecutionPolicy {
        SandboxExecutionPolicy {
            mode,
            workspace_root: self.workspace_root.clone(),
            extra_writable_roots: self.extra_writable_roots.clone(),
        }
    }

    /// The selected runner, or `None` when this host (or the config) can confine nothing — reported, not
    /// guessed. Selection only; it does not probe.
    pub fn backend_name(&self) -> Option<BackendName> {
        self.backend.as_ref().map(|backend| backend.name())
    }

    /// The modes one call may escalate to on this host (`escalationTargets`): all of
    /// [`crate::escalation::ESCALATION_TARGETS`] when a backend is selected **and** probes usable, else empty —
    /// an offered escalation the host cannot enforce would be a prompt whose grant could not run. The tool
    /// layer advertises `sandbox_permissions` / `justification` only when this is non-empty.
    pub fn escalation_targets(&self) -> Vec<SandboxMode> {
        todo!("probe the backend; all targets or none")
    }

    /// Resolve a caller-supplied path against the workspace **and canonicalise it** (`resolvePath`): absolute
    /// paths stand, relative ones join the workspace; then [`crate::paths::canonical`].
    pub fn resolve_path(&self, path: impl AsRef<Path>) -> PathBuf {
        let _ = path;
        todo!("resolve against the workspace, then canonical")
    }

    /// Wrap one exact argv for the shell under the call's mode (`confine`).
    ///
    /// `danger-full-access` returns [`ConfinedArgv::unconfined`] without consulting any backend — the only
    /// bypass. A confined mode with no backend, or one whose probe fails, is
    /// `Err(`[`SandboxUnavailableError`]`)`: the caller reports it and **does not run the command**.
    pub fn confine(
        &self,
        argv: &[OsString],
        mode: SandboxMode,
    ) -> Result<ConfinedArgv, SandboxUnavailableError> {
        let _ = (argv, mode);
        todo!("port confine from src/sandbox/service.ts")
    }

    /// Refuse a write unless the path is inside one of the call's writable roots (`assertWritable`); returns
    /// the resolved path to write.
    ///
    /// `danger-full-access` admits anything. `read-only` refuses everything with
    /// `the sandbox is read-only, so '<path as given>' cannot be written`. `workspace-write` admits a path under
    /// [`crate::mode::writable_roots`] and otherwise refuses with
    /// `'<resolved>' is outside the sandbox root <workspace>, so it cannot be written`. A refusal is an `Err`
    /// rather than a `false` because a caller must handle it.
    pub fn assert_writable(
        &self,
        path: impl AsRef<Path>,
        mode: SandboxMode,
    ) -> Result<PathBuf, SandboxDenial> {
        let _ = (path, mode);
        todo!("port assertWritable from src/sandbox/service.ts")
    }

    /// Refuse a read outside the call's readable roots (`assertReadable`); returns the resolved path to read.
    ///
    /// `danger-full-access` admits anything. Under `workspace-write` the readable roots are the writable roots;
    /// under `read-only` they are the workspace and the extra roots; under both, the canonical harness home is
    /// added. A refusal reads
    /// `'<resolved>' is outside the sandbox root <workspace>, so it cannot be read in '<mode>' mode`.
    pub fn assert_readable(
        &self,
        path: impl AsRef<Path>,
        mode: SandboxMode,
    ) -> Result<PathBuf, SandboxDenial> {
        let _ = (path, mode, &self.harness_home);
        todo!("port assertReadable from src/sandbox/service.ts")
    }

    /// Whether a write would be admitted, without the denial (`writable`).
    pub fn writable(&self, path: impl AsRef<Path>, mode: SandboxMode) -> bool {
        self.assert_writable(path, mode).is_ok()
    }
}

impl fmt::Debug for SandboxService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SandboxService")
            .field("mode", &self.mode)
            .field("workspace_root", &self.workspace_root)
            .field("extra_writable_roots", &self.extra_writable_roots)
            .field("harness_home", &self.harness_home)
            .field("backend", &self.backend_name())
            .finish()
    }
}
