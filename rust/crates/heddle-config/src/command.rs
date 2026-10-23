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
    let _ = (command, args, context, out, err);
    todo!("heddle-config: command::run")
}
