//! Profiles, and the layers a run uses.
//!
//! Ported from `listProfiles`, `resolveProfile` and `defaultLayers` in `src/config/schema.ts`, and from
//! the two places `src/cli.ts` chose layer options (`baseLayer` for a run, `runConfigCommand` for the
//! configuration commands) so the binary does not hold a second copy of those rules.
//!
//! A **profile** is a directory under `$HEDDLE_HOME/profiles/` that holds `cordis.yml`,
//! `heddle.patch.yml`, or both; which tree runs is a name rather than a path. A directory is recognised
//! by the layer files it holds, not by being a directory, because a profile is commonly a symlink to the
//! project it configures.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::env::Env;
use crate::error::ConfigError;
use crate::layer::NamedLayer;

/// The layer files a profile directory may hold, in the order they are applied.
pub const LAYER_FILES: [&str; 2] = ["cordis.yml", "heddle.patch.yml"];

/// The project patch looked for beside a base layer.
pub const PROJECT_PATCH: &str = "heddle.patch.yml";

/// The base layer looked for in the working directory when no profile or `--config` is named.
pub const PROJECT_BASE: &str = "cordis.yml";

/// A directory recognised as a profile. Serializes as `heddle profiles --json` prints it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProfileInfo {
    /// The name `--profile` takes; for a profile named by its directory, the absolute directory.
    pub name: String,
    /// The profile's directory.
    pub dir: PathBuf,
    /// Which of [`LAYER_FILES`] it holds, in that order; never empty.
    pub layers: Vec<String>,
}

/// The profiles this machine holds, sorted by name. A missing profiles directory is no profiles.
pub fn list_profiles(env: &Env) -> Vec<ProfileInfo> {
    let _ = env;
    todo!("heddle-config: list_profiles")
}

/// The profile a `--profile` value names, or an error that lists the names which do exist.
///
/// An **absolute** value (after `~` expansion) is a directory, accepted when it holds a layer file —
/// how a check states its profile without writing into the machine's own profiles directory. A name is
/// looked up under [`crate::profiles_dir`], with **no fallback**: a fallback once made
/// `--profile nowhere` boot the repository's tree in silence. The error reads
/// `no profile named 'nowhere' under {dir}; known profiles: dev, ...` (or `; that directory holds none`).
pub fn resolve_profile(name: &str, env: &Env) -> Result<ProfileInfo, ConfigError> {
    let _ = (name, env);
    todo!("heddle-config: resolve_profile")
}

/// A `--profile` argument as the command line records it: a value starting with `.`, `/` or `~` is a
/// directory, made absolute against `cwd` (with `~` expanded); anything else is a name, kept as written.
///
/// The TypeScript build resolved `~/p` against the working directory without expanding it, which made a
/// `~` profile unusable; this expands it.
pub fn profile_argument(value: &str, cwd: &Path, env: &Env) -> String {
    let _ = (value, cwd, env);
    todo!("heddle-config: profile_argument")
}

/// Which layers to read, before they are read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LayerOptions {
    /// A profile name or absolute directory; when set, `base` and the project patch are not used.
    pub profile: Option<String>,
    /// An explicit base layer, used when no profile is named.
    pub base: Option<PathBuf>,
    /// Layers applied after the profile or base, in order; the last write wins per row.
    pub patches: Vec<PathBuf>,
    /// Also apply [`PROJECT_PATCH`] from **the base layer's directory** (not the working directory)
    /// when it exists.
    pub include_project_patch: bool,
}

impl LayerOptions {
    /// The layers a run boots, as `baseLayer` in `src/cli.ts` chose them.
    ///
    /// A named profile excludes the project's base layer. Otherwise the base is `config`, else
    /// `cwd/cordis.yml` when it exists; the project patch is applied only when no `--patch` was given.
    pub fn for_run(
        profile: Option<String>,
        config: Option<PathBuf>,
        patches: Vec<PathBuf>,
        cwd: &Path,
    ) -> Self {
        let _ = (profile, config, patches, cwd);
        todo!("heddle-config: LayerOptions::for_run")
    }

    /// The layers `heddle config` and `heddle profiles` describe, as `runConfigCommand` in `src/cli.ts`
    /// chose them.
    ///
    /// The same as [`LayerOptions::for_run`] except in one case, kept as the TypeScript build has it:
    /// with `--config` and no `--patch`, a run applies the project patch beside the base and this does
    /// not.
    pub fn for_inspection(
        profile: Option<String>,
        config: Option<PathBuf>,
        patches: Vec<PathBuf>,
        cwd: &Path,
    ) -> Self {
        let _ = (profile, config, patches, cwd);
        todo!("heddle-config: LayerOptions::for_inspection")
    }
}

/// Read the layers `options` names, in order: the profile's [`LAYER_FILES`] (named
/// `{profile}/{file}`), or the base (named by its absolute path) and, when asked, the project patch
/// beside it; then every patch (named by its absolute path).
///
/// Fails on an unknown profile, and on anything [`crate::read_layer`] refuses.
pub fn default_layers(options: &LayerOptions, env: &Env) -> Result<Vec<NamedLayer>, ConfigError> {
    let _ = (options, env);
    todo!("heddle-config: default_layers")
}
