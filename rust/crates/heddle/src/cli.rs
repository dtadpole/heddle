//! The command line, ported from `parseArgs` and `baseLayer` in `src/cli.ts`.
//!
//! The shape is the TypeScript build's on purpose, quirks included, because the verifiers drive it:
//! one flat [`Args`], a positional that lands in the same `target` field `-t` writes, a command word that
//! consumes the next token only for the commands that take one (`heddle web --port 3099` must not read
//! `3099` as a positional), and the same error sentences, printed by the caller as `heddle: <sentence>`.
//!
//! One deliberate difference: a numeric flag (`--port`, `--max-rounds`, `--max-output-tokens`) that is
//! not a number is a usage error here, where the TypeScript build carries `NaN` onward.

use std::path::Path;

use heddle_config::command::ConfigArgs;
use heddle_config::{Env, LayerOptions, NamedLayer};

/// A command word, the first non-flag token the parser recognises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandWord {
    /// `models`: the configured endpoints, without calling any.
    Models,
    /// `tools`: the registered tools.
    Tools,
    /// `commands`: the registered commands.
    Commands,
    /// `sessions`: the sessions the store holds.
    Sessions,
    /// `transcript <id>`: a session's events, one JSON line each.
    Transcript,
    /// `web`: serve the Web UI.
    Web,
    /// `workspaces`: the workspaces and their sessions.
    Workspaces,
    /// `workspace add|list|remove|rename ...`.
    Workspace,
    /// `tree [<path>]`: one level of the folder tree.
    Tree,
    /// `session new [<branch>]`.
    Session,
    /// `file <path>`: a text file under a workspace root.
    File,
    /// `context [<id>]`: the assembled context, without calling a model.
    Context,
    /// `goal [<id>]`: the goal a session works toward.
    Goal,
    /// `hooks`: the hook points this build emits.
    Hooks,
    /// `profiles`: the profiles this machine holds.
    Profiles,
    /// `config [--validate] [--origins]`: the composed tree.
    Config,
}

impl CommandWord {
    /// The word as typed.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Models => "models",
            Self::Tools => "tools",
            Self::Commands => "commands",
            Self::Sessions => "sessions",
            Self::Transcript => "transcript",
            Self::Web => "web",
            Self::Workspaces => "workspaces",
            Self::Workspace => "workspace",
            Self::Tree => "tree",
            Self::Session => "session",
            Self::File => "file",
            Self::Context => "context",
            Self::Goal => "goal",
            Self::Hooks => "hooks",
            Self::Profiles => "profiles",
            Self::Config => "config",
        }
    }
}

/// The word after a two-word command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subcommand {
    /// `workspace add <path> [name]`.
    Add,
    /// `workspace list`.
    List,
    /// `workspace remove <id|path>`.
    Remove,
    /// `workspace rename <id|path> <name>`.
    Rename,
    /// `session new [<branch>]`.
    New,
}

/// Everything the command line can say: one field per field of the TypeScript `Args`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Args {
    /// `-p, --punctuation <mark>`: what the greeting service appends.
    pub punctuation: Option<String>,
    /// `-t, --target <name>`, and also the positional of `transcript`, `context`, `goal`, `tree`, `file`,
    /// `session new`, `workspace add|remove|rename` — one field, as in the TypeScript build.
    pub target: Option<String>,
    /// `-q, --quiet`.
    pub quiet: bool,
    /// `-h, --help`.
    pub help: bool,
    /// `-c, --config <path>`: the base layer instead of the default profile.
    pub config: Option<String>,
    /// `--profile <name|dir>`, as typed. A name and a directory are told apart by the argument itself
    /// (`.`, `/` or `~` starts a directory), never by the working directory, which is
    /// `heddle_config::profile_argument`'s rule; [`layer_options`] applies it.
    pub profile: Option<String>,
    /// `--patch <path>`, repeatable, in order.
    pub patch: Vec<String>,
    /// `--turn <text>`.
    pub turn: Option<String>,
    /// `--resume <id>`.
    pub resume: Option<String>,
    /// `--endpoint <name>`.
    pub endpoint: Option<String>,
    /// `--model <id>`.
    pub model: Option<String>,
    /// `--system <text>`.
    pub system: Option<String>,
    /// `--max-rounds <n>`.
    pub max_rounds: Option<u32>,
    /// `--max-output-tokens <n>`.
    pub max_output_tokens: Option<u32>,
    /// `--session-root <path>` (undocumented in the usage, as in the TypeScript build).
    pub session_root: Option<String>,
    /// `--sandbox-root <path>`.
    pub sandbox_root: Option<String>,
    /// `--dry-run`.
    pub dry_run: bool,
    /// `--port <n>` (`web`; `0` asks for an ephemeral port).
    pub port: Option<u16>,
    /// `--host <name>` (`web`).
    pub host: Option<String>,
    /// `--stream`.
    pub stream: bool,
    /// `--validate` (`config`).
    pub validate: bool,
    /// `--origins` (`config`).
    pub origins: bool,
    /// `--list`.
    pub list: bool,
    /// `--json`.
    pub json: bool,
    /// `--new`: start a new session in the folder rather than continuing its own.
    pub fresh: bool,
    /// `--generated <name>`, repeatable: folders a tool writes.
    pub generated: Vec<String>,
    /// `--force` (`workspace remove`).
    pub force: bool,
    /// The optional name of `workspace add` and the name of `workspace rename`.
    pub name: Option<String>,
    /// The command word; the last one given wins, as in the TypeScript build.
    pub command: Option<CommandWord>,
    /// The word after `workspace` or `session`.
    pub subcommand: Option<Subcommand>,
}

/// A command line the parser refuses. Its text is the TypeScript build's sentence, verbatim.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct UsageError(pub String);

/// Parse the arguments after the program name.
///
/// Port of `parseArgs` in `src/cli.ts`: every flag, the command words and their positionals, and the
/// sentences `unknown argument: X`, `unknown workspace subcommand 'X'; try ...`, `workspace add needs a
/// path`, `workspace remove needs a workspace id or path`, `workspace rename needs a ...`,
/// `unknown session subcommand 'X'; try ...` and `file needs a path`.
pub fn parse_args(argv: &[String]) -> Result<Args, UsageError> {
    let _ = argv;
    todo!("port parseArgs from src/cli.ts")
}

/// The layers a run boots: `heddle_config::LayerOptions::for_run` over the parsed flags, with the profile
/// argument resolved by `heddle_config::profile_argument` (port of `baseLayer` and `bootFromArgs`).
pub fn layer_options(args: &Args, cwd: &Path, env: &Env) -> LayerOptions {
    let _ = (args, cwd, env);
    todo!("LayerOptions::for_run(profile_argument(..), --config, --patch, cwd)")
}

/// The flags `profiles` and `config` read, for `heddle_config::command::run`, which owns those commands'
/// output: port of the flag half of `runConfigCommand`.
pub fn config_args(args: &Args, cwd: &Path, env: &Env) -> ConfigArgs {
    let _ = (args, cwd, env);
    todo!("ConfigArgs from --profile, --config, --patch, --json, --origins, --validate")
}

/// The inline layer `--session-root` and `--sandbox-root` become, applied after every file layer: a
/// patch of the `session` row's `config` to `{ root }` and of the `sandbox` row's to `{ workspaceRoot }`,
/// each path resolved against `cwd`. A patch **replaces** a row's `config`, as every patch does. `None`
/// when neither flag was given.
pub fn root_overrides(args: &Args, cwd: &Path) -> Option<NamedLayer> {
    let _ = (args, cwd);
    todo!("NamedLayer::inline(0, Layer::patching([...]))")
}

/// Whether the command line names a tree at all: port of `hasProfile`.
///
/// When it does not (no profile, no `--config`, no `--patch`, no `<cwd>/cordis.yml`), a bare `heddle`
/// builds the three-plugin application of `src/app.ts` instead of booting a configured tree.
pub fn names_a_tree(args: &Args, project_base_exists: bool) -> bool {
    let _ = (args, project_base_exists);
    todo!("port hasProfile from src/cli.ts")
}
