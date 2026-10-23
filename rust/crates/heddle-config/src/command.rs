//! `heddle profiles` and `heddle config`: the commands that answer from the configuration alone.
//!
//! Ported from `runConfigCommand` in `src/cli.ts`, output byte for byte where the TypeScript build
//! defined it. They live here, not in the binary, so the binary's command line only parses its flags
//! and delegates, and every sentence `05-config-system` reads is written by the crate that owns it.
//!
//! These commands **must not start anything**: the question they answer is what the tree *is*, and a
//! command that started every component to describe them could not run on a broken tree — which is
//! exactly when it is needed.

use std::io::Write;
use std::path::PathBuf;

use crate::env::Env;
use crate::validate::ComponentCatalog;

/// Which configuration command to run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigCommand {
    /// `heddle profiles [--json]` — the profiles this machine holds.
    Profiles,
    /// `heddle config [--json] [--origins] [--validate]` — the composed rows, where each field came
    /// from, or the validation pass.
    Config,
}

/// The flags these commands read, as the binary parsed them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigArgs {
    /// `--profile`, already passed through [`crate::profile_argument`].
    pub profile: Option<String>,
    /// `-c` / `--config`, the explicit base layer.
    pub config: Option<PathBuf>,
    /// Every `--patch`, in order.
    pub patches: Vec<PathBuf>,
    /// `--json`: print one JSON document (two-space indented) instead of text.
    pub json: bool,
    /// `--origins`: in text, list each row's fields with the layer that supplied them. (`--json`
    /// always includes `origins`.)
    pub origins: bool,
    /// `--validate`: check every row's configuration against its component's schema.
    pub validate: bool,
}

/// What a command runs against: the environment, the working directory, and the catalog validation
/// asks for schemas.
pub struct CommandContext<'a> {
    /// The environment references and `HEDDLE_HOME` are read from.
    pub env: &'a Env,
    /// The working directory, where `cordis.yml` is looked for when nothing else is named.
    pub cwd: PathBuf,
    /// Where `--validate` finds component schemas.
    pub catalog: &'a dyn ComponentCatalog,
}

/// Run `command`, writing its report to `out` and any failure to `err`, and return the process exit
/// code.
///
/// - `profiles`: `heddle: {n} profile(s) under {HEDDLE_HOME}/profiles`, then one line per profile
///   (`  {name:<18} {layers joined ', '}`); with `--json`, the [`crate::ProfileInfo`] list.
/// - `config --validate`: `heddle: {rows} row(s) checked, {n} problem(s)`, then `  {problem}` per
///   problem; with `--json`, the [`crate::ValidationResult`]. Exit 1 when there is any problem.
/// - `config`: `heddle: {n} configured row(s) from {layer -> layer}`, then
///   `  {id or '-':<16} {name}` (plus `  disabled` / `  inject a,b`), and with `--origins`
///   `      {field:<28} {layer}` per field, else the hint
///   `heddle: pass --origins to see which layer supplied each field`; with `--json`, the list of
///   [`crate::ComposedRow::to_report`].
///
/// Any [`crate::ConfigError`] — an unknown profile, an include cycle, a missing reference, a patch
/// against a missing row — is written to `err` as `heddle: {error}` and exits 1. Exit 0 otherwise.
/// Writing to `out` or `err` failing is not reported; the exit code still is.
pub fn run(
    command: ConfigCommand,
    args: &ConfigArgs,
    context: &CommandContext<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // The layers are read before the command branches, as `runConfigCommand` did: a tree that cannot
    // be read is a failure of the description too, not a reason to print a description of nothing.
    let options = crate::profile::LayerOptions::for_inspection(
        args.profile.clone(),
        args.config.clone(),
        args.patches.clone(),
        &context.cwd,
    );
    let layers = match crate::profile::default_layers(&options, context.env) {
        Ok(layers) => layers,
        Err(error) => {
            let _ = writeln!(err, "heddle: {error}");
            return 1;
        }
    };

    match command {
        ConfigCommand::Profiles => {
            let profiles = crate::profile::list_profiles(context.env);
            if args.json {
                write_json(out, &profiles);
            } else {
                let _ = writeln!(
                    out,
                    "heddle: {} profile(s) under {}",
                    profiles.len(),
                    crate::profiles_dir(context.env).display()
                );
                for profile in &profiles {
                    let _ = writeln!(out, "  {:<18} {}", profile.name, profile.layers.join(", "));
                }
            }
            0
        }
        ConfigCommand::Config if args.validate => {
            let result = match crate::validate::validate_rows(&layers, context.env, context.catalog)
            {
                Ok(result) => result,
                Err(error) => {
                    let _ = writeln!(err, "heddle: {error}");
                    return 1;
                }
            };
            if args.json {
                write_json(out, &result);
            } else {
                let _ = writeln!(
                    out,
                    "heddle: {} row(s) checked, {} problem(s)",
                    result.rows,
                    result.problems.len()
                );
                for problem in &result.problems {
                    let _ = writeln!(out, "  {problem}");
                }
            }
            if result.problems.is_empty() { 0 } else { 1 }
        }
        ConfigCommand::Config => {
            let rows = match crate::compose::compose(&layers, context.env) {
                Ok(rows) => rows,
                Err(error) => {
                    let _ = writeln!(err, "heddle: {error}");
                    return 1;
                }
            };
            if args.json {
                let reports: Vec<_> = rows.iter().map(|row| row.to_report()).collect();
                write_json(out, &reports);
                return 0;
            }
            let names: Vec<&str> = layers.iter().map(|layer| layer.layer.as_str()).collect();
            let _ = writeln!(
                out,
                "heddle: {} configured row(s) from {}",
                rows.len(),
                names.join(" -> ")
            );
            for entry in &rows {
                let mut flags = Vec::new();
                if entry.row.disabled == Some(true) {
                    flags.push("disabled".to_string());
                }
                if let Some(inject) = &entry.row.inject {
                    flags.push(format!("inject {}", inject.join(",")));
                }
                let suffix = if flags.is_empty() {
                    String::new()
                } else {
                    format!("  {}", flags.join("  "))
                };
                let _ = writeln!(
                    out,
                    "  {:<16} {}{}",
                    entry.row.id.as_deref().unwrap_or("-"),
                    entry.row.name,
                    suffix
                );
                if args.origins {
                    for origin in &entry.fields {
                        let _ = writeln!(out, "      {:<28} {}", origin.field, origin.layer);
                    }
                }
            }
            if !args.origins {
                let _ = writeln!(
                    out,
                    "heddle: pass --origins to see which layer supplied each field"
                );
            }
            0
        }
    }
}

/// One JSON document, indented as `JSON.stringify(value, null, 2)` indents it, then a newline.
fn write_json<T: serde::Serialize>(out: &mut dyn Write, value: &T) {
    if let Ok(text) = serde_json::to_string_pretty(value) {
        let _ = writeln!(out, "{text}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::Schema;
    use crate::validate::{ManifestCatalog, StaticCatalog};
    use serde_json::json;
    use std::path::Path;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "heddle-config-command-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    /// A home holding `profiles/dev/` with an empty `cordis.yml` and the given project patch.
    fn profile_home(label: &str, patch: &str) -> (PathBuf, Env) {
        let root = scratch(label);
        let home = root.join("home");
        write_text(&home.join("profiles/dev/cordis.yml"), "[]\n");
        write_text(&home.join("profiles/dev/heddle.patch.yml"), patch);
        std::fs::create_dir_all(root.join("cwd")).unwrap();
        let env = Env::default().with("HEDDLE_HOME", home.to_string_lossy());
        (root, env)
    }

    fn execute(
        command: ConfigCommand,
        args: &ConfigArgs,
        env: &Env,
        root: &Path,
        catalog: &dyn crate::validate::ComponentCatalog,
    ) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            command,
            args,
            &CommandContext {
                env,
                cwd: root.join("cwd"),
                catalog,
            },
            &mut out,
            &mut err,
        );
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    const BASE_PATCH: &str = "- insert:\n    - id: alpha\n      name: alpha\n      config:\n        label: from-profile\n";

    #[test]
    fn profiles_prints_the_machines_profiles_as_json_or_text() {
        let (root, env) = profile_home("profiles", BASE_PATCH);
        let catalog = StaticCatalog::new();
        let args = ConfigArgs {
            json: true,
            ..ConfigArgs::default()
        };
        let (code, out, err) = execute(ConfigCommand::Profiles, &args, &env, &root, &catalog);
        assert_eq!((code, err.as_str()), (0, ""));
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed[0]["name"], json!("dev"));
        assert_eq!(
            parsed[0]["layers"],
            json!(["cordis.yml", "heddle.patch.yml"])
        );

        let (code, out, _) = execute(
            ConfigCommand::Profiles,
            &ConfigArgs::default(),
            &env,
            &root,
            &catalog,
        );
        assert_eq!(code, 0);
        assert!(out.contains("heddle: 1 profile(s) under"));
        assert!(out.contains("dev"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn config_prints_the_composed_rows_as_json() {
        let (root, env) = profile_home("config-json", BASE_PATCH);
        let args = ConfigArgs {
            profile: Some("dev".into()),
            json: true,
            ..ConfigArgs::default()
        };
        let (code, out, err) = execute(
            ConfigCommand::Config,
            &args,
            &env,
            &root,
            &StaticCatalog::new(),
        );
        assert_eq!((code, err.as_str()), (0, ""));
        let rows: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(rows[0]["id"], json!("alpha"));
        assert_eq!(rows[0]["config"]["label"], json!("from-profile"));
        assert_eq!(rows[0]["position"], json!(0));
        let origins = rows[0]["origins"].as_array().unwrap();
        assert!(
            origins
                .iter()
                .any(|origin| origin["field"] == json!("config.label")
                    && origin["layer"] == json!("dev/heddle.patch.yml")),
            "the report says which layer supplied the field: {origins:?}"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn config_prints_rows_layers_and_origins_as_text() {
        let (root, env) = profile_home("config-text", BASE_PATCH);
        let mut args = ConfigArgs {
            profile: Some("dev".into()),
            ..ConfigArgs::default()
        };
        let (code, out, _) = execute(
            ConfigCommand::Config,
            &args,
            &env,
            &root,
            &StaticCatalog::new(),
        );
        assert_eq!(code, 0);
        assert!(
            out.contains("heddle: 1 configured row(s) from dev/cordis.yml -> dev/heddle.patch.yml")
        );
        assert!(out.contains("alpha"));
        assert!(out.contains("heddle: pass --origins to see which layer supplied each field"));

        args.origins = true;
        let (code, out, _) = execute(
            ConfigCommand::Config,
            &args,
            &env,
            &root,
            &StaticCatalog::new(),
        );
        assert_eq!(code, 0);
        assert!(out.contains("config.label"));
        assert!(out.contains("dev/heddle.patch.yml"));
        assert!(!out.contains("pass --origins"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn validate_names_the_row_and_the_field_and_exits_one() {
        let patch = "- insert:\n    - id: alpha\n      name: alpha\n      config:\n        count: not-a-number\n";
        let (root, env) = profile_home("validate", patch);
        let catalog = StaticCatalog::new().with(
            "alpha",
            Some(
                Schema::from_json(json!({
                    "type": "object",
                    "properties": { "count": { "type": "number" } }
                }))
                .unwrap(),
            ),
        );
        let args = ConfigArgs {
            profile: Some("dev".into()),
            validate: true,
            ..ConfigArgs::default()
        };
        let (code, out, err) = execute(ConfigCommand::Config, &args, &env, &root, &catalog);
        assert_eq!(code, 1);
        assert!(err.is_empty());
        assert!(out.contains("heddle: 1 row(s) checked, 1 problem(s)"));
        assert!(
            out.contains("alpha: count is not a number"),
            "the problem names the row and the field: {out}"
        );

        let mut json_args = args.clone();
        json_args.json = true;
        let (code, out, _) = execute(ConfigCommand::Config, &json_args, &env, &root, &catalog);
        assert_eq!(code, 1);
        let result: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(result["rows"], json!(1));
        assert_eq!(result["checked"], json!(1));
        assert_eq!(result["problems"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn validate_reads_component_manifests_beside_the_profile() {
        let root = scratch("validate-manifest");
        let home = root.join("home");
        write_text(&home.join("profiles/dev/cordis.yml"), "[]\n");
        write_text(
            &home.join("profiles/dev/heddle.patch.yml"),
            "- insert:\n    - id: alpha\n      name: ./alpha.component.yml\n      config:\n        count: not-a-number\n",
        );
        write_text(
            &home.join("profiles/dev/alpha.component.yml"),
            "command: ./alpha.ts\nconfig:\n  type: object\n  properties:\n    count:\n      type: number\n",
        );
        std::fs::create_dir_all(root.join("cwd")).unwrap();
        let env = Env::default().with("HEDDLE_HOME", home.to_string_lossy());
        let args = ConfigArgs {
            profile: Some("dev".into()),
            validate: true,
            ..ConfigArgs::default()
        };
        let (code, out, err) = execute(
            ConfigCommand::Config,
            &args,
            &env,
            &root,
            &ManifestCatalog::new(),
        );
        assert_eq!(code, 1, "the bad value fails: {out}{err}");
        assert!(
            out.contains("alpha: count is not a number, which means the value in the layer could not be read as one"),
            "the manifest's schema names the row and the field: {out}"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_unknown_profile_fails_on_stderr_and_exits_one() {
        let (root, env) = profile_home("unknown", BASE_PATCH);
        let args = ConfigArgs {
            profile: Some("nowhere".into()),
            ..ConfigArgs::default()
        };
        let (code, out, err) = execute(
            ConfigCommand::Config,
            &args,
            &env,
            &root,
            &StaticCatalog::new(),
        );
        assert_eq!(code, 1);
        assert!(out.is_empty());
        assert!(
            err.starts_with("heddle: no profile named 'nowhere'"),
            "the failure names what was asked for: {err}"
        );
        assert!(err.contains("known profiles: dev"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
