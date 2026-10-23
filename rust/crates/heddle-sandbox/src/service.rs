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
use crate::mode::{SandboxExecutionPolicy, SandboxMode, writable_roots};
use crate::paths::{canonical, contains, resolve};

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
        let backend = match config.backend {
            BackendChoice::Disabled => None,
            BackendChoice::Auto => {
                crate::backend::select_backend(host.platform, config.landlock_runner.as_deref())
            }
        };
        SandboxService::with_backend(config, host, backend)
    }

    /// [`SandboxService::new`] with the backend chosen by the caller (a test double, or `None` for no backend);
    /// `config.backend` and `config.landlock_runner` are then ignored.
    pub fn with_backend(
        config: &SandboxConfig,
        host: &SandboxHost,
        backend: Option<Arc<dyn SandboxBackend>>,
    ) -> SandboxService {
        let workspace_root = canonical(
            config
                .workspace_root
                .as_deref()
                .unwrap_or(host.cwd.as_path()),
        );
        let extra_writable_roots = config.extra_writable_roots.iter().map(canonical).collect();
        SandboxService {
            mode: config.mode,
            workspace_root,
            extra_writable_roots,
            harness_home: host.harness_home.clone(),
            backend,
        }
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
        match &self.backend {
            Some(backend) if backend.probe() => crate::escalation::ESCALATION_TARGETS.to_vec(),
            _ => Vec::new(),
        }
    }

    /// Resolve a caller-supplied path against the workspace **and canonicalise it** (`resolvePath`): absolute
    /// paths stand, relative ones join the workspace; then [`crate::paths::canonical`].
    pub fn resolve_path(&self, path: impl AsRef<Path>) -> PathBuf {
        canonical(resolve(&self.workspace_root, path.as_ref()))
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
        if mode == SandboxMode::DangerFullAccess {
            return Ok(ConfinedArgv::unconfined(argv));
        }
        let Some(backend) = &self.backend else {
            return Err(SandboxUnavailableError::new(mode));
        };
        if !backend.probe() {
            return Err(SandboxUnavailableError::new(mode));
        }
        Ok(backend.confine(argv, &self.policy(mode)))
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
        let given = path.as_ref();
        let target = self.resolve_path(given);
        if mode == SandboxMode::DangerFullAccess {
            return Ok(target);
        }
        if mode == SandboxMode::ReadOnly {
            return Err(self.denial(
                format!(
                    "the sandbox is read-only, so '{}' cannot be written",
                    given.display()
                ),
                target,
                mode,
            ));
        }
        let allowed = writable_roots(&self.policy(mode));
        if allowed.iter().any(|root| contains(root, &target)) {
            return Ok(target);
        }
        Err(self.denial(
            format!(
                "'{}' is outside the sandbox root {}, so it cannot be written",
                target.display(),
                self.workspace_root.display()
            ),
            target,
            mode,
        ))
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
        let target = self.resolve_path(path.as_ref());
        if mode == SandboxMode::DangerFullAccess {
            return Ok(target);
        }
        // Reading follows the roots the call may write, plus the workspace and named extra roots under
        // read-only (which has no writable root at all), plus the harness's own directory so a confined run can
        // read the profile it started from.
        let mut allowed = if mode == SandboxMode::WorkspaceWrite {
            writable_roots(&self.policy(mode))
        } else {
            let mut roots = Vec::with_capacity(1 + self.extra_writable_roots.len());
            roots.push(self.workspace_root.clone());
            roots.extend(self.extra_writable_roots.iter().cloned());
            roots
        };
        allowed.push(canonical(&self.harness_home));
        if allowed.iter().any(|root| contains(root, &target)) {
            return Ok(target);
        }
        Err(self.denial(
            format!(
                "'{}' is outside the sandbox root {}, so it cannot be read in '{}' mode",
                target.display(),
                self.workspace_root.display(),
                mode
            ),
            target,
            mode,
        ))
    }

    /// Whether a write would be admitted, without the denial (`writable`).
    pub fn writable(&self, path: impl AsRef<Path>, mode: SandboxMode) -> bool {
        self.assert_writable(path, mode).is_ok()
    }

    /// One refusal, with the facts a person and the registry need.
    fn denial(&self, message: String, path: PathBuf, mode: SandboxMode) -> SandboxDenial {
        SandboxDenial {
            message,
            path,
            mode,
            workspace_root: self.workspace_root.clone(),
        }
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

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::{BackendChoice, SandboxConfig, SandboxHost, SandboxService};
    use crate::backend::{BackendName, ConfinedArgv, Platform, SandboxBackend, SandboxEnforcement};
    use crate::escalation::ESCALATION_TARGETS;
    use crate::mode::{SandboxMode, host_temp_dir};
    use crate::paths::canonical;
    use crate::testfs::TempDir;

    fn host(dir: &TempDir, platform: Platform) -> SandboxHost {
        SandboxHost {
            cwd: dir.path().to_path_buf(),
            harness_home: dir.join("home"),
            platform,
        }
    }

    fn config(mode: SandboxMode, workspace: &Path) -> SandboxConfig {
        SandboxConfig {
            mode,
            workspace_root: Some(workspace.to_path_buf()),
            ..SandboxConfig::default()
        }
    }

    /// A backend whose probe answers one fixed verdict and which records the modes it was asked to confine.
    struct Double {
        name: BackendName,
        verdict: bool,
        seen: Mutex<Vec<SandboxMode>>,
    }

    impl Double {
        fn new(verdict: bool) -> Arc<Double> {
            Arc::new(Double {
                name: BackendName::Seatbelt,
                verdict,
                seen: Mutex::new(Vec::new()),
            })
        }

        fn seen(&self) -> Vec<SandboxMode> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl SandboxBackend for Double {
        fn name(&self) -> BackendName {
            self.name
        }

        fn probe(&self) -> bool {
            self.verdict
        }

        fn confine(
            &self,
            argv: &[OsString],
            policy: &crate::mode::SandboxExecutionPolicy,
        ) -> ConfinedArgv {
            self.seen.lock().unwrap().push(policy.mode);
            let mut wrapped = vec![OsString::from("confiner")];
            wrapped.extend(argv.iter().cloned());
            ConfinedArgv {
                argv: wrapped,
                enforcement: SandboxEnforcement::Full,
                denial_signatures: vec!["denied".to_owned()],
                runner_failure_rules: Vec::new(),
            }
        }
    }

    fn argv() -> Vec<OsString> {
        vec![
            OsString::from("/bin/sh"),
            OsString::from("-c"),
            OsString::from("echo hi"),
        ]
    }

    #[test]
    fn the_service_canonicalises_the_workspace_and_the_extra_roots() {
        let dir = TempDir::new("svc-canonical");
        let real = dir.child("real");
        let link = dir.join("link");
        crate::testfs::symlink(&real, &link);

        let mut cfg = config(SandboxMode::WorkspaceWrite, &link);
        cfg.extra_writable_roots = vec![link.clone()];
        let service = SandboxService::with_backend(&cfg, &host(&dir, Platform::Other), None);

        assert_eq!(service.workspace_root(), canonical(&real));
        assert_eq!(service.extra_writable_roots(), &[canonical(&real)]);
        assert_eq!(service.mode(), SandboxMode::WorkspaceWrite);
    }

    #[test]
    fn resolve_path_joins_the_workspace_and_normalises_the_result() {
        let dir = TempDir::new("svc-resolve");
        let workspace = dir.child("ws");
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &workspace),
            &host(&dir, Platform::Other),
            None,
        );

        assert_eq!(
            service.resolve_path("a/../b/c"),
            canonical(&workspace).join("b/c"),
            "a relative path joins the workspace and .. is lexical"
        );
        assert_eq!(
            service.resolve_path("/etc/../tmp"),
            canonical(Path::new("/tmp")),
            "an absolute path ignores the workspace and is canonicalised"
        );
    }

    #[test]
    fn full_access_admits_any_read_or_write() {
        let dir = TempDir::new("svc-full");
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &dir.child("ws")),
            &host(&dir, Platform::Other),
            None,
        );
        assert_eq!(
            service.assert_writable("/etc/passwd", SandboxMode::DangerFullAccess),
            Ok(canonical(Path::new("/etc/passwd")))
        );
        assert_eq!(
            service.assert_readable("/etc/passwd", SandboxMode::DangerFullAccess),
            Ok(canonical(Path::new("/etc/passwd")))
        );
    }

    #[test]
    fn workspace_write_admits_an_inside_write_and_refuses_an_outside_one() {
        let dir = TempDir::outside_host_temp("svc-fence");
        let workspace = dir.child("ws");
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &workspace),
            &host(&dir, Platform::Other),
            None,
        );

        let inside = workspace.join("file.txt");
        assert_eq!(
            service.assert_writable(&inside, SandboxMode::WorkspaceWrite),
            Ok(canonical(&workspace).join("file.txt")),
            "a file that does not exist yet is admitted under a resolved ancestor"
        );

        let outside = dir.join("outside.txt");
        let denial = service
            .assert_writable(&outside, SandboxMode::WorkspaceWrite)
            .unwrap_err();
        let resolved = canonical(&outside);
        assert_eq!(
            denial.message,
            format!(
                "'{}' is outside the sandbox root {}, so it cannot be written",
                resolved.display(),
                canonical(&workspace).display()
            )
        );
        assert_eq!(denial.path, resolved);
        assert_eq!(denial.mode, SandboxMode::WorkspaceWrite);
        assert_eq!(denial.workspace_root, canonical(&workspace));
        assert!(!service.writable(&outside, SandboxMode::WorkspaceWrite));
    }

    #[test]
    fn a_prefix_sibling_is_outside_the_root() {
        let dir = TempDir::outside_host_temp("svc-sibling");
        let workspace = dir.child("ws");
        let sibling = dir.child("ws-extra");
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &workspace),
            &host(&dir, Platform::Other),
            None,
        );
        assert!(
            !service.writable(sibling.join("file.txt"), SandboxMode::WorkspaceWrite),
            "ws-extra starts with the root as a string but is not under it"
        );
    }

    #[test]
    fn the_host_temp_areas_are_writable_under_workspace_write() {
        let dir = TempDir::new("svc-temp");
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &dir.child("ws")),
            &host(&dir, Platform::Other),
            None,
        );
        let temp_file = host_temp_dir().join("heddle-sandbox-temp-probe.txt");
        assert!(service.writable(&temp_file, SandboxMode::WorkspaceWrite));
        assert!(service.writable(
            "/tmp/heddle-sandbox-temp-probe.txt",
            SandboxMode::WorkspaceWrite
        ));
    }

    #[test]
    fn a_symlink_inside_the_workspace_cannot_reach_out() {
        let dir = TempDir::new("svc-symlink");
        let workspace = dir.child("ws");
        let escape = workspace.join("escape");
        crate::testfs::symlink(Path::new("/etc"), &escape);
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &workspace),
            &host(&dir, Platform::Other),
            None,
        );

        let denial = service
            .assert_writable(escape.join("passwd"), SandboxMode::WorkspaceWrite)
            .unwrap_err();
        assert_eq!(
            denial.path,
            canonical(Path::new("/etc/passwd")),
            "the denial names the resolved path, not the link"
        );
    }

    #[test]
    fn read_only_refuses_every_write_with_its_own_sentence() {
        let dir = TempDir::new("svc-readonly-write");
        let workspace = dir.child("ws");
        let service = SandboxService::with_backend(
            &config(SandboxMode::ReadOnly, &workspace),
            &host(&dir, Platform::Other),
            None,
        );
        let given = workspace.join("file.txt");
        let denial = service
            .assert_writable(&given, SandboxMode::ReadOnly)
            .unwrap_err();
        assert_eq!(
            denial.message,
            format!(
                "the sandbox is read-only, so '{}' cannot be written",
                given.display()
            ),
            "the sentence quotes the path as the caller gave it"
        );
        assert!(!service.writable(&given, SandboxMode::ReadOnly));
    }

    #[test]
    fn read_only_reads_the_workspace_the_extra_roots_and_the_harness_home() {
        let dir = TempDir::new("svc-readonly-read");
        let workspace = dir.child("ws");
        let extra = dir.child("extra");
        let fixture = dir.join("home/heddle.yml");
        std::fs::create_dir_all(dir.join("home")).expect("create the harness home");
        std::fs::write(&fixture, b"profile: default\n").expect("write the profile");

        let mut cfg = config(SandboxMode::ReadOnly, &workspace);
        cfg.extra_writable_roots = vec![extra.clone()];
        let service = SandboxService::with_backend(&cfg, &host(&dir, Platform::Other), None);

        assert!(
            service
                .assert_readable(workspace.join("a.txt"), SandboxMode::ReadOnly)
                .is_ok()
        );
        assert!(
            service
                .assert_readable(extra.join("b.txt"), SandboxMode::ReadOnly)
                .is_ok()
        );
        assert!(
            service
                .assert_readable(&fixture, SandboxMode::ReadOnly)
                .is_ok(),
            "a confined run can read the profile it started from"
        );
        assert!(
            service
                .assert_readable(dir.join("elsewhere.txt"), SandboxMode::ReadOnly)
                .is_err(),
            "the workspace's parent is not readable"
        );
        let denial = service
            .assert_readable("/etc/passwd", SandboxMode::ReadOnly)
            .unwrap_err();
        assert_eq!(
            denial.message,
            format!(
                "'{}' is outside the sandbox root {}, so it cannot be read in 'read-only' mode",
                canonical(Path::new("/etc/passwd")).display(),
                canonical(&workspace).display()
            )
        );
    }

    #[test]
    fn workspace_write_reads_the_writable_roots_and_the_harness_home_too() {
        let dir = TempDir::new("svc-ww-read");
        let workspace = dir.child("ws");
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &workspace),
            &host(&dir, Platform::Other),
            None,
        );
        assert!(
            service
                .assert_readable(workspace.join("a.txt"), SandboxMode::WorkspaceWrite)
                .is_ok()
        );
        assert!(
            service
                .assert_readable("/tmp/a.txt", SandboxMode::WorkspaceWrite)
                .is_ok(),
            "the temp area is readable because it is writable"
        );
        assert!(
            service
                .assert_readable(dir.join("home/heddle.yml"), SandboxMode::WorkspaceWrite)
                .is_ok()
        );
        assert!(
            service
                .assert_readable("/etc/passwd", SandboxMode::WorkspaceWrite)
                .is_err()
        );
    }

    #[test]
    fn confine_bypasses_only_in_full_access() {
        let dir = TempDir::new("svc-confine-full");
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &dir.child("ws")),
            &host(&dir, Platform::Other),
            None,
        );

        let unconfined = service
            .confine(&argv(), SandboxMode::DangerFullAccess)
            .expect("full access never needs a backend");
        assert_eq!(unconfined.argv, argv());
        assert_eq!(unconfined.enforcement, SandboxEnforcement::Full);
        assert!(unconfined.denial_signatures.is_empty());

        for mode in [SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite] {
            let error = service
                .confine(&argv(), mode)
                .expect_err("a confined mode with no backend fails closed");
            assert!(
                error
                    .to_string()
                    .starts_with(&format!("sandbox mode \"{mode}\" is requested")),
                "{error}"
            );
        }
    }

    #[test]
    fn confine_fails_closed_when_the_probe_fails() {
        let dir = TempDir::new("svc-probe-fail");
        let backend = Double::new(false);
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &dir.child("ws")),
            &host(&dir, Platform::Other),
            Some(backend.clone()),
        );
        assert!(
            service
                .confine(&argv(), SandboxMode::WorkspaceWrite)
                .is_err()
        );
        assert!(
            backend.seen().is_empty(),
            "an unusable backend is never asked to confine"
        );
    }

    #[test]
    fn confine_wraps_through_a_usable_backend_with_the_calls_policy() {
        let dir = TempDir::new("svc-confine-ok");
        let workspace = dir.child("ws");
        let backend = Double::new(true);
        let service = SandboxService::with_backend(
            &config(SandboxMode::WorkspaceWrite, &workspace),
            &host(&dir, Platform::Other),
            Some(backend.clone()),
        );
        let confined = service
            .confine(&argv(), SandboxMode::ReadOnly)
            .expect("a usable backend confines");
        assert_eq!(confined.argv[0], OsString::from("confiner"));
        assert_eq!(&confined.argv[1..], &argv()[..]);
        assert_eq!(
            backend.seen(),
            vec![SandboxMode::ReadOnly],
            "the call's mode, not the deployment mode, is the policy"
        );
    }

    #[test]
    fn escalation_targets_are_empty_without_a_usable_backend() {
        let dir = TempDir::new("svc-targets");
        let cfg = config(SandboxMode::WorkspaceWrite, &dir.child("ws"));
        let none = SandboxService::with_backend(&cfg, &host(&dir, Platform::Other), None);
        assert!(none.escalation_targets().is_empty());

        let failing = SandboxService::with_backend(
            &cfg,
            &host(&dir, Platform::Other),
            Some(Double::new(false)),
        );
        assert!(
            failing.escalation_targets().is_empty(),
            "an escalation the host cannot enforce is not offered"
        );

        let usable = SandboxService::with_backend(
            &cfg,
            &host(&dir, Platform::Other),
            Some(Double::new(true)),
        );
        assert_eq!(usable.escalation_targets(), ESCALATION_TARGETS.to_vec());
    }

    #[test]
    fn backend_name_reports_the_selection_without_probing() {
        let dir = TempDir::new("svc-selection");
        let mac = SandboxService::new(
            &config(SandboxMode::WorkspaceWrite, &dir.child("ws")),
            &host(&dir, Platform::MacOs),
        );
        assert_eq!(mac.backend_name(), Some(BackendName::Seatbelt));

        let other = SandboxService::new(
            &config(SandboxMode::WorkspaceWrite, &dir.child("ws")),
            &host(&dir, Platform::Other),
        );
        assert_eq!(other.backend_name(), None, "no chain on this platform");

        let mut disabled = config(SandboxMode::WorkspaceWrite, &dir.child("ws"));
        disabled.backend = BackendChoice::Disabled;
        let disabled = SandboxService::new(&disabled, &host(&dir, Platform::MacOs));
        assert_eq!(
            disabled.backend_name(),
            None,
            "backend: none forces the absence"
        );
    }

    #[test]
    fn the_config_reads_camel_case_strips_unknown_keys_and_honours_defaults() {
        let parsed: SandboxConfig = serde_json::from_value(json!({
            "workspaceRoot": "/tmp/ws",
            "extraWritableRoots": ["/tmp/extra"],
            "backend": "none",
            "landlockRunner": "/opt/landlock-run",
            "tempRoot": true
        }))
        .expect("the row parses, unknown keys stripped");
        assert_eq!(parsed.mode, SandboxMode::WorkspaceWrite, "the default mode");
        assert_eq!(parsed.workspace_root, Some(PathBuf::from("/tmp/ws")));
        assert_eq!(
            parsed.extra_writable_roots,
            vec![PathBuf::from("/tmp/extra")]
        );
        assert_eq!(parsed.backend, BackendChoice::Disabled);
        assert_eq!(
            parsed.landlock_runner,
            Some(PathBuf::from("/opt/landlock-run"))
        );

        let defaults: SandboxConfig = serde_json::from_value(json!({})).expect("an empty row");
        assert_eq!(defaults, SandboxConfig::default());
        assert_eq!(defaults.mode, SandboxMode::WorkspaceWrite);
        assert_eq!(defaults.backend, BackendChoice::Auto);

        assert!(
            serde_json::from_value::<SandboxConfig>(json!({"mode": "read-write"})).is_err(),
            "a mode outside the vocabulary is refused at the boundary"
        );
    }
}
