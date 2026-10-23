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
use crate::home::{expand_home, profiles_dir};
use crate::layer::NamedLayer;
use crate::paths::resolve;

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
    let root = profiles_dir(env);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut profiles = Vec::new();
    for name in names {
        let dir = root.join(&name);
        let layers = layer_files(&dir);
        // Recognised by the layer files it holds, not by being a directory: a profile is commonly a
        // symlink to the project it configures.
        if !layers.is_empty() {
            profiles.push(ProfileInfo { name, dir, layers });
        }
    }
    profiles
}

/// Which of [`LAYER_FILES`] a directory holds, in that order.
fn layer_files(dir: &Path) -> Vec<String> {
    LAYER_FILES
        .iter()
        .filter(|file| dir.join(file).exists())
        .map(|file| (*file).to_string())
        .collect()
}

/// The profile a `--profile` value names, or an error that lists the names which do exist.
///
/// An **absolute** value (after `~` expansion) is a directory, accepted when it holds a layer file —
/// how a check states its profile without writing into the machine's own profiles directory. A name is
/// looked up under [`crate::profiles_dir`], with **no fallback**: a fallback once made
/// `--profile nowhere` boot the repository's tree in silence. The error reads
/// `no profile named 'nowhere' under {dir}; known profiles: dev, ...` (or `; that directory holds none`).
pub fn resolve_profile(name: &str, env: &Env) -> Result<ProfileInfo, ConfigError> {
    let expanded = expand_home(name, env);
    if expanded.is_absolute() {
        let dir = resolve(Path::new("/"), &expanded);
        let layers = layer_files(&dir);
        if layers.is_empty() {
            return Err(ConfigError::one(format!(
                "{} holds no cordis.yml or heddle.patch.yml, so it is not a profile directory",
                dir.display()
            )));
        }
        return Ok(ProfileInfo {
            name: dir.to_string_lossy().into_owned(),
            dir,
            layers,
        });
    }
    let profiles = list_profiles(env);
    if let Some(found) = profiles.iter().find(|profile| profile.name == name) {
        return Ok(found.clone());
    }
    let known: Vec<&str> = profiles
        .iter()
        .map(|profile| profile.name.as_str())
        .collect();
    let suffix = if known.is_empty() {
        "; that directory holds none".to_string()
    } else {
        format!("; known profiles: {}", known.join(", "))
    };
    Err(ConfigError::one(format!(
        "no profile named '{name}' under {}{suffix}",
        profiles_dir(env).display()
    )))
}

/// A `--profile` argument as the command line records it: a value starting with `.`, `/` or `~` is a
/// directory, made absolute against `cwd` (with `~` expanded); anything else is a name, kept as written.
///
/// The TypeScript build resolved `~/p` against the working directory without expanding it, which made a
/// `~` profile unusable; this expands it.
pub fn profile_argument(value: &str, cwd: &Path, env: &Env) -> String {
    let looks_like_path =
        value.starts_with('.') || value.starts_with('/') || value.starts_with('~');
    if looks_like_path {
        resolve(cwd, &expand_home(value, env))
            .to_string_lossy()
            .into_owned()
    } else {
        value.to_string()
    }
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
        // Asking for a profile is asking for exactly that tree: no base and no project patch.
        if profile.is_some() {
            return Self {
                profile,
                base: None,
                patches,
                include_project_patch: false,
            };
        }
        let base = config.or_else(|| {
            let candidate = cwd.join(PROJECT_BASE);
            candidate.exists().then_some(candidate)
        });
        let include_project_patch = patches.is_empty();
        Self {
            profile,
            base,
            patches,
            include_project_patch,
        }
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
        let named = config.is_some() || !patches.is_empty();
        let include_project_patch = profile.is_none() && !named;
        let base = if profile.is_none() {
            config.or_else(|| {
                let candidate = cwd.join(PROJECT_BASE);
                candidate.exists().then_some(candidate)
            })
        } else {
            None
        };
        Self {
            profile,
            base,
            patches,
            include_project_patch,
        }
    }
}

/// Read the layers `options` names, in order: the profile's [`LAYER_FILES`] (named
/// `{profile}/{file}`), or the base (named by its absolute path) and, when asked, the project patch
/// beside it; then every patch (named by its absolute path).
///
/// Fails on an unknown profile, and on anything [`crate::read_layer`] refuses.
pub fn default_layers(options: &LayerOptions, env: &Env) -> Result<Vec<NamedLayer>, ConfigError> {
    let mut layers = Vec::new();
    if let Some(profile) = &options.profile {
        let profile = resolve_profile(profile, env)?;
        for file in &profile.layers {
            let path = profile.dir.join(file);
            layers.push(NamedLayer::read(
                format!("{}/{}", profile.name, file),
                &path,
                env,
            )?);
        }
    } else if let Some(base) = &options.base {
        let path = absolute(base, env);
        layers.push(NamedLayer::read(
            path.to_string_lossy().into_owned(),
            &path,
            env,
        )?);
        if options.include_project_patch {
            // The project patch sits beside the **base layer**, not beside the working directory.
            let anchor = path.parent().map(Path::to_path_buf).unwrap_or_default();
            let project_patch = anchor.join(PROJECT_PATCH);
            if project_patch.exists() {
                layers.push(NamedLayer::read(
                    project_patch.to_string_lossy().into_owned(),
                    &project_patch,
                    env,
                )?);
            }
        }
    }
    for patch in &options.patches {
        let path = absolute(patch, env);
        layers.push(NamedLayer::read(
            path.to_string_lossy().into_owned(),
            &path,
            env,
        )?);
    }
    Ok(layers)
}

/// A layer path as the TypeScript build made it: `~` expanded and resolved against the working
/// directory, so a relative `--config` names the same file `read_layer` opens.
fn absolute(path: &Path, env: &Env) -> PathBuf {
    crate::paths::resolve_from_cwd(&expand_home(&path.to_string_lossy(), env))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "heddle-config-profile-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env_at(home: &Path) -> Env {
        Env::default().with("HEDDLE_HOME", home.to_string_lossy())
    }

    fn write(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, "[]\n").unwrap();
    }

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn a_symlinked_profile_is_listed() {
        let root = scratch("symlink");
        let target = root.join("target");
        write(&target.join("heddle.patch.yml"));
        let profiles = root.join("profiles");
        std::fs::create_dir_all(&profiles).unwrap();
        std::os::unix::fs::symlink(&target, profiles.join("dev")).unwrap();

        let listed = list_profiles(&env_at(&root));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "dev");
        assert_eq!(listed[0].layers, ["heddle.patch.yml"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn profiles_are_sorted_and_list_their_layers_in_order() {
        let root = scratch("sorted");
        write(&root.join("profiles/dev/cordis.yml"));
        write(&root.join("profiles/dev/heddle.patch.yml"));
        write(&root.join("profiles/alpha/heddle.patch.yml"));
        std::fs::create_dir_all(root.join("profiles/empty")).unwrap();

        let listed = list_profiles(&env_at(&root));
        assert_eq!(
            listed
                .iter()
                .map(|profile| profile.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "dev"]
        );
        assert_eq!(listed[1].layers, ["cordis.yml", "heddle.patch.yml"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_profiles_directory_is_no_profiles() {
        let env = env_at(Path::new("/no/such/heddle/profiles-root"));
        assert!(list_profiles(&env).is_empty());
    }

    #[test]
    fn an_unknown_profile_lists_the_ones_that_exist() {
        let root = scratch("unknown");
        write(&root.join("profiles/dev/cordis.yml"));
        let error = resolve_profile("nowhere", &env_at(&root)).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "no profile named 'nowhere' under {}; known profiles: dev",
                root.join("profiles").display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_machine_with_no_profiles_says_so() {
        let root = scratch("none");
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        let error = resolve_profile("nowhere", &env_at(&root)).unwrap_err();
        assert!(error.problems()[0].ends_with("; that directory holds none"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_absolute_directory_is_a_profile_when_it_holds_a_layer_file() {
        let root = scratch("absolute");
        let dir = root.join("tree");
        write(&dir.join("cordis.yml"));
        let found = resolve_profile(dir.to_str().unwrap(), &env_at(Path::new("/unused"))).unwrap();
        assert_eq!(found.name, dir.to_string_lossy());
        assert_eq!(found.layers, ["cordis.yml"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_absolute_directory_without_a_layer_file_is_refused() {
        let root = scratch("absolute-empty");
        let dir = root.join("tree");
        std::fs::create_dir_all(&dir).unwrap();
        let error = resolve_profile(dir.to_str().unwrap(), &env_at(&root)).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{} holds no cordis.yml or heddle.patch.yml, so it is not a profile directory",
                dir.display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_profile_argument_is_a_directory_only_when_it_looks_like_one() {
        let env = Env::default().with("HOME", "/home/someone");
        assert_eq!(profile_argument("dev", Path::new("/work"), &env), "dev");
        assert_eq!(profile_argument("./p", Path::new("/work"), &env), "/work/p");
        assert_eq!(profile_argument("../p", Path::new("/work"), &env), "/p");
        assert_eq!(
            profile_argument("~/p", Path::new("/work"), &env),
            "/home/someone/p"
        );
        assert_eq!(
            profile_argument("/abs/p", Path::new("/work"), &env),
            "/abs/p"
        );
    }

    #[test]
    fn a_run_applies_the_project_patch_unless_a_profile_or_patch_is_named() {
        let root = scratch("run");
        let cwd = root.join("project");
        write(&cwd.join("cordis.yml"));
        let options = LayerOptions::for_run(None, None, Vec::new(), &cwd);
        assert_eq!(options.base, Some(cwd.join("cordis.yml")));
        assert!(options.include_project_patch);

        let patched = LayerOptions::for_run(None, None, vec![PathBuf::from("/p/extra.yml")], &cwd);
        assert!(!patched.include_project_patch);

        let profiled = LayerOptions::for_run(
            Some("dev".into()),
            Some(PathBuf::from("/elsewhere/cordis.yml")),
            Vec::new(),
            &cwd,
        );
        assert_eq!(profiled.base, None, "a profile excludes the project's base");
        assert!(!profiled.include_project_patch);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_config_command_keeps_the_typescript_difference_beside_an_explicit_config() {
        let root = scratch("inspect");
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let config = root.join("elsewhere/cordis.yml");
        let options = LayerOptions::for_inspection(None, Some(config.clone()), Vec::new(), &cwd);
        assert_eq!(options.base, Some(config));
        assert!(
            !options.include_project_patch,
            "`heddle --config X config` does not apply the project patch beside X"
        );

        let plain = LayerOptions::for_inspection(None, None, Vec::new(), &cwd);
        assert_eq!(plain.base, None);

        let with_default = {
            write(&cwd.join("cordis.yml"));
            LayerOptions::for_inspection(None, None, Vec::new(), &cwd)
        };
        assert_eq!(with_default.base, Some(cwd.join("cordis.yml")));
        assert!(with_default.include_project_patch);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_project_patch_is_read_beside_the_base_not_from_the_cwd() {
        let root = scratch("default-base");
        let project = root.join("project");
        write(&project.join("cordis.yml"));
        write_text(
            &project.join("heddle.patch.yml"),
            "- insert:\n    - id: alpha\n      name: ./alpha\n",
        );
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();

        let options = LayerOptions::for_run(
            None,
            Some(project.join("cordis.yml")),
            Vec::new(),
            &elsewhere,
        );
        let layers = default_layers(&options, &Env::default()).unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(
            layers[0].file,
            project.join("cordis.yml").to_string_lossy(),
            "the base is named by its absolute path"
        );
        assert!(layers[0].entries.is_empty());
        assert_eq!(
            layers[1].file,
            project.join("heddle.patch.yml").to_string_lossy(),
            "the project patch is looked for beside the base, not in the cwd"
        );
        assert_eq!(
            layers[1].entries[0].insert[0]
                .get("id")
                .and_then(crate::value::LayerValue::as_str),
            Some("alpha")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_profile_reads_its_layer_files_in_order_under_its_name() {
        let root = scratch("default-profile");
        let home = root.join("home");
        write(&home.join("profiles/dev/cordis.yml"));
        write_text(
            &home.join("profiles/dev/heddle.patch.yml"),
            "- insert:\n    - id: alpha\n      name: ./alpha\n",
        );
        let env = env_at(&home);
        let options =
            LayerOptions::for_run(Some("dev".into()), None, Vec::new(), Path::new("/unused"));
        let layers = default_layers(&options, &env).unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0].layer, "dev/cordis.yml");
        assert_eq!(layers[1].layer, "dev/heddle.patch.yml");
        assert_eq!(
            layers[1].file,
            home.join("profiles/dev/heddle.patch.yml").to_string_lossy()
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_unknown_profile_fails_through_default_layers() {
        let root = scratch("default-unknown");
        let home = root.join("home");
        std::fs::create_dir_all(home.join("profiles")).unwrap();
        let options = LayerOptions::for_run(
            Some("nowhere".into()),
            None,
            Vec::new(),
            Path::new("/unused"),
        );
        let error = default_layers(&options, &env_at(&home)).unwrap_err();
        assert!(error.problems()[0].contains("no profile named 'nowhere'"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn patches_are_read_after_the_base_and_named_by_their_path() {
        let root = scratch("default-patches");
        let project = root.join("project");
        write(&project.join("cordis.yml"));
        let patch = root.join("extra.yml");
        write_text(&patch, "- insert:\n    - id: beta\n      name: ./beta\n");
        let options = LayerOptions::for_run(
            None,
            Some(project.join("cordis.yml")),
            vec![patch.clone()],
            Path::new("/unused"),
        );
        let layers = default_layers(&options, &Env::default()).unwrap();
        assert_eq!(
            layers.len(),
            2,
            "an explicit patch excludes the project patch"
        );
        assert_eq!(layers[1].file, patch.to_string_lossy());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
