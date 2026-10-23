//! The command line, ported from `parseArgs` and `baseLayer` in `src/cli.ts`.
//!
//! The shape is the TypeScript build's on purpose, quirks included, because the verifiers drive it:
//! one flat [`Args`], a positional that lands in the same `target` field `-t` writes, a command word that
//! consumes the next token only for the commands that take one (`heddle web --port 3099` must not read
//! `3099` as a positional), and the same error sentences, printed by the caller as `heddle: <sentence>`.
//!
//! One deliberate difference: a numeric flag (`--port`, `--max-rounds`, `--max-output-tokens`) that is
//! not a number is a usage error here, where the TypeScript build carries `NaN` onward.

use std::path::{Path, PathBuf};

use heddle_config::command::ConfigArgs;
use heddle_config::paths::resolve;
use heddle_config::{Env, Layer, LayerOptions, NamedLayer};

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
    let mut args = Args::default();
    let mut index = 0;
    while index < argv.len() {
        match argv[index].as_str() {
            "-p" | "--punctuation" => args.punctuation = take(argv, &mut index),
            "-t" | "--target" => args.target = take(argv, &mut index),
            "-c" | "--config" => args.config = take(argv, &mut index),
            // A profile value is kept as typed: `layer_options` and `config_args` hand it to
            // `heddle_config::profile_argument`, which owns telling a name from a directory.
            "--profile" => args.profile = Some(take(argv, &mut index).unwrap_or_default()),
            "--patch" => args.patch.push(take(argv, &mut index).unwrap_or_default()),
            "--turn" => args.turn = take(argv, &mut index),
            "--force" => args.force = true,
            "--resume" => args.resume = take(argv, &mut index),
            "--new" => args.fresh = true,
            "--generated" => args
                .generated
                .push(take(argv, &mut index).unwrap_or_default()),
            "--endpoint" => args.endpoint = take(argv, &mut index),
            "--model" => args.model = take(argv, &mut index),
            "--system" => args.system = take(argv, &mut index),
            "--max-rounds" => args.max_rounds = number(argv, &mut index, "--max-rounds")?,
            "--max-output-tokens" => {
                args.max_output_tokens = number(argv, &mut index, "--max-output-tokens")?
            }
            "--session-root" => args.session_root = take(argv, &mut index),
            "--sandbox-root" => args.sandbox_root = take(argv, &mut index),
            "--port" => args.port = port_number(argv, &mut index)?,
            "--host" => args.host = take(argv, &mut index),
            "--stream" => args.stream = true,
            "--dry-run" => args.dry_run = true,
            "--validate" => args.validate = true,
            "--origins" => args.origins = true,
            "--list" => args.list = true,
            "--json" => args.json = true,
            "-q" | "--quiet" => args.quiet = true,
            "-h" | "--help" => args.help = true,
            "goal" => {
                args.command = Some(CommandWord::Goal);
                args.target = optional_positional(argv, &mut index);
            }
            "models" => args.command = Some(CommandWord::Models),
            "tools" => args.command = Some(CommandWord::Tools),
            "commands" => args.command = Some(CommandWord::Commands),
            "sessions" => args.command = Some(CommandWord::Sessions),
            "workspaces" => args.command = Some(CommandWord::Workspaces),
            "hooks" => args.command = Some(CommandWord::Hooks),
            "profiles" => args.command = Some(CommandWord::Profiles),
            "config" => args.command = Some(CommandWord::Config),
            // `transcript` and `context` take a session id, and consume the next token the way
            // `parseArgs` does — even a flag, which is the TypeScript build's quirk, kept here.
            "transcript" => {
                args.command = Some(CommandWord::Transcript);
                args.target = take(argv, &mut index);
            }
            "context" => {
                args.command = Some(CommandWord::Context);
                args.target = take(argv, &mut index);
            }
            "web" => args.command = Some(CommandWord::Web),
            "tree" => {
                args.command = Some(CommandWord::Tree);
                args.target = optional_positional(argv, &mut index);
            }
            "workspace" => workspace(argv, &mut index, &mut args)?,
            "session" => session(argv, &mut index, &mut args)?,
            "file" => {
                args.command = Some(CommandWord::File);
                match take(argv, &mut index) {
                    Some(path) if !path.starts_with('-') => args.target = Some(path),
                    _ => return Err(UsageError("file needs a path".to_owned())),
                }
            }
            other => return Err(UsageError(format!("unknown argument: {other}"))),
        }
        index += 1;
    }
    Ok(args)
}

/// The next token, consumed: `next()` in `parseArgs`.
fn take(argv: &[String], index: &mut usize) -> Option<String> {
    *index += 1;
    argv.get(*index).cloned()
}

/// The token after the current one, without consuming it: the `argv[index + 1]` checks.
fn peek(argv: &[String], index: usize) -> Option<&str> {
    argv.get(index + 1).map(String::as_str)
}

/// An optional positional, taken only when it is not a flag (`goal`, `tree`).
fn optional_positional(argv: &[String], index: &mut usize) -> Option<String> {
    match peek(argv, *index) {
        Some(candidate) if !candidate.starts_with('-') => take(argv, index),
        _ => None,
    }
}

/// `--max-rounds` and `--max-output-tokens`: a whole number, or the usage error the port prefers to
/// carrying `NaN` onward.
fn number(argv: &[String], index: &mut usize, flag: &str) -> Result<Option<u32>, UsageError> {
    match take(argv, index) {
        None => Err(UsageError(format!("{flag} needs a whole number"))),
        Some(value) => value
            .parse::<u32>()
            .map(Some)
            .map_err(|_| UsageError(format!("{flag} needs a whole number, got '{value}'"))),
    }
}

/// `--port`: a port number, `0` included, because `0` asks for an ephemeral one.
fn port_number(argv: &[String], index: &mut usize) -> Result<Option<u16>, UsageError> {
    match take(argv, index) {
        None => Err(UsageError("--port needs a port number".to_owned())),
        Some(value) => value.parse::<u16>().map(Some).map_err(|_| {
            UsageError(format!(
                "--port needs a port number between 0 and 65535, got '{value}'"
            ))
        }),
    }
}

/// `workspace add|list|remove|rename ...`, with its own sentences.
fn workspace(argv: &[String], index: &mut usize, args: &mut Args) -> Result<(), UsageError> {
    args.command = Some(CommandWord::Workspace);
    let word = take(argv, index).unwrap_or_default();
    match word.as_str() {
        "list" => args.subcommand = Some(Subcommand::List),
        "add" => {
            args.subcommand = Some(Subcommand::Add);
            match take(argv, index) {
                Some(path) if !path.starts_with('-') => args.target = Some(path),
                _ => return Err(UsageError("workspace add needs a path".to_owned())),
            }
            // The optional name, taken only when it is not a flag.
            if let Some(candidate) = peek(argv, *index)
                && !candidate.starts_with('-')
            {
                args.name = take(argv, index);
            }
        }
        "remove" => {
            args.subcommand = Some(Subcommand::Remove);
            match take(argv, index) {
                Some(id) if !id.starts_with('-') => args.target = Some(id),
                _ => {
                    return Err(UsageError(
                        "workspace remove needs a workspace id or path".to_owned(),
                    ));
                }
            }
        }
        "rename" => {
            args.subcommand = Some(Subcommand::Rename);
            match take(argv, index) {
                Some(id) if !id.starts_with('-') => args.target = Some(id),
                _ => {
                    return Err(UsageError(
                        "workspace rename needs a workspace id or path".to_owned(),
                    ));
                }
            }
            match take(argv, index) {
                Some(name) if !name.starts_with('-') => args.name = Some(name),
                _ => return Err(UsageError("workspace rename needs a name".to_owned())),
            }
        }
        other => {
            return Err(UsageError(format!(
                "unknown workspace subcommand '{other}'; try 'heddle workspace add <path> [name]', \
                 'heddle workspace rename <id|path> <name>', 'heddle workspace remove <id|path>' \
                 or 'heddle workspace list'"
            )));
        }
    }
    Ok(())
}

/// `session new [<branch>]`, the one session verb that writes.
fn session(argv: &[String], index: &mut usize, args: &mut Args) -> Result<(), UsageError> {
    args.command = Some(CommandWord::Session);
    let word = take(argv, index).unwrap_or_default();
    if word != "new" {
        return Err(UsageError(format!(
            "unknown session subcommand '{word}'; try 'heddle session new [<branch>]'"
        )));
    }
    args.subcommand = Some(Subcommand::New);
    args.target = optional_positional(argv, index);
    Ok(())
}

/// The layers a run boots: `heddle_config::LayerOptions::for_run` over the parsed flags, with the profile
/// argument resolved by `heddle_config::profile_argument` (port of `baseLayer` and `bootFromArgs`).
pub fn layer_options(args: &Args, cwd: &Path, env: &Env) -> LayerOptions {
    LayerOptions::for_run(
        args.profile
            .as_deref()
            .map(|value| heddle_config::profile_argument(value, cwd, env)),
        args.config.as_ref().map(PathBuf::from),
        args.patch.iter().map(PathBuf::from).collect(),
        cwd,
    )
}

/// The flags `profiles` and `config` read, for `heddle_config::command::run`, which owns those commands'
/// output: port of the flag half of `runConfigCommand`.
pub fn config_args(args: &Args, cwd: &Path, env: &Env) -> ConfigArgs {
    ConfigArgs {
        profile: args
            .profile
            .as_deref()
            .map(|value| heddle_config::profile_argument(value, cwd, env)),
        config: args.config.as_ref().map(PathBuf::from),
        patches: args.patch.iter().map(PathBuf::from).collect(),
        json: args.json,
        origins: args.origins,
        validate: args.validate,
    }
}

/// The inline layer `--session-root` and `--sandbox-root` become, applied after every file layer: a
/// patch of the `session` row's `config` to `{ root }` and of the `sandbox` row's to `{ workspaceRoot }`,
/// each path resolved against `cwd`. A patch **replaces** a row's `config`, as every patch does. `None`
/// when neither flag was given.
///
/// The layer is numbered from 1, as `src/boot.ts` names its overrides (`override 1`), so provenance and
/// `config --origins` print the TypeScript build's label.
pub fn root_overrides(args: &Args, cwd: &Path) -> Option<NamedLayer> {
    if args.session_root.is_none() && args.sandbox_root.is_none() {
        return None;
    }
    let mut patch = Vec::new();
    if let Some(root) = &args.session_root {
        patch.push(serde_json::json!({
            "id": "session",
            "config": { "root": resolve(cwd, Path::new(root)) },
        }));
    }
    if let Some(root) = &args.sandbox_root {
        patch.push(serde_json::json!({
            "id": "sandbox",
            "config": { "workspaceRoot": resolve(cwd, Path::new(root)) },
        }));
    }
    Some(NamedLayer::inline(1, Layer::patching(patch)))
}

/// Whether the command line names a tree at all: port of `hasProfile`.
///
/// When it does not (no profile, no `--config`, no `--patch`, no `<cwd>/cordis.yml`), a bare `heddle`
/// builds the three-plugin application of `src/app.ts` instead of booting a configured tree.
pub fn names_a_tree(args: &Args, project_base_exists: bool) -> bool {
    args.profile.is_some() || args.config.is_some() || !args.patch.is_empty() || project_base_exists
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(list: &[&str]) -> Args {
        let argv: Vec<String> = list.iter().map(|word| (*word).to_owned()).collect();
        parse_args(&argv).expect("the command line parses")
    }

    fn refused(list: &[&str]) -> String {
        let argv: Vec<String> = list.iter().map(|word| (*word).to_owned()).collect();
        parse_args(&argv)
            .expect_err("the command line is refused")
            .0
    }

    #[test]
    fn an_empty_command_line_is_the_typescript_initial_object() {
        assert_eq!(parse(&[]), Args::default());
    }

    #[test]
    fn every_flag_sets_its_own_field() {
        let args = parse(&[
            "-p",
            "?",
            "-t",
            "bob",
            "-c",
            "base.yml",
            "--profile",
            "dev",
            "--patch",
            "first.yml",
            "--patch",
            "second.yml",
            "--turn",
            "hello",
            "--resume",
            "session-1",
            "--endpoint",
            "fast",
            "--model",
            "m-1",
            "--system",
            "be brief",
            "--max-rounds",
            "3",
            "--max-output-tokens",
            "900",
            "--session-root",
            "sessions",
            "--sandbox-root",
            "/tmp/box",
            "--dry-run",
            "--stream",
            "--validate",
            "--origins",
            "--list",
            "--json",
            "--new",
            "--force",
            "--generated",
            "dist",
            "--generated",
            "build",
            "-q",
            "-h",
        ]);
        assert_eq!(args.punctuation, Some("?".to_owned()));
        assert_eq!(args.target, Some("bob".to_owned()));
        assert_eq!(args.config, Some("base.yml".to_owned()));
        assert_eq!(args.profile, Some("dev".to_owned()));
        assert_eq!(args.patch, vec!["first.yml", "second.yml"]);
        assert_eq!(args.turn, Some("hello".to_owned()));
        assert_eq!(args.resume, Some("session-1".to_owned()));
        assert_eq!(args.endpoint, Some("fast".to_owned()));
        assert_eq!(args.model, Some("m-1".to_owned()));
        assert_eq!(args.system, Some("be brief".to_owned()));
        assert_eq!(args.max_rounds, Some(3));
        assert_eq!(args.max_output_tokens, Some(900));
        assert_eq!(args.session_root, Some("sessions".to_owned()));
        assert_eq!(args.sandbox_root, Some("/tmp/box".to_owned()));
        assert!(args.dry_run && args.stream && args.validate && args.origins);
        assert!(args.list && args.json && args.fresh && args.force && args.quiet && args.help);
        assert_eq!(args.generated, vec!["dist", "build"]);
        assert_eq!(args.command, None);
    }

    #[test]
    fn a_short_and_a_long_spelling_agree() {
        let pairs: [(&[&str], &[&str]); 5] = [
            (&["-p", "!"], &["--punctuation", "!"]),
            (&["-t", "x"], &["--target", "x"]),
            (&["-c", "a.yml"], &["--config", "a.yml"]),
            (&["-q"], &["--quiet"]),
            (&["-h"], &["--help"]),
        ];
        for (short, long) in pairs {
            assert_eq!(parse(short), parse(long), "{short:?} and {long:?}");
        }
    }

    #[test]
    fn a_profile_is_kept_as_typed_for_heddle_config_to_resolve() {
        // `profile_argument` owns telling a name from a directory, so no path is resolved here.
        assert_eq!(parse(&["--profile", "dev"]).profile, Some("dev".to_owned()));
        assert_eq!(parse(&["--profile", "./x"]).profile, Some("./x".to_owned()));
        assert_eq!(parse(&["--profile", "~/p"]).profile, Some("~/p".to_owned()));
        // `parseArgs` writes the empty string when the flag has no value; kept, as the build has it.
        assert_eq!(parse(&["--profile"]).profile, Some(String::new()));
    }

    #[test]
    fn a_flag_without_a_value_sets_nothing() {
        let args = parse(&["--turn", "-p"]);
        assert_eq!(args.turn, Some("-p".to_owned()), "next() takes the flag");
        assert_eq!(args.punctuation, None);

        let args = parse(&["-p", "--json"]);
        assert_eq!(
            args.punctuation,
            Some("--json".to_owned()),
            "next() takes the flag"
        );
        assert!(!args.json, "the token was the value, not a flag");
    }

    #[test]
    fn repeatable_flags_keep_their_order() {
        let args = parse(&["--patch", "a", "--patch", "b", "--generated", "dist"]);
        assert_eq!(args.patch, vec!["a", "b"]);
        assert_eq!(args.generated, vec!["dist"]);
        assert_eq!(parse(&["--patch"]).patch, vec![""], "the build pushes ''");
    }

    #[test]
    fn a_number_flag_that_is_not_a_number_is_a_usage_error() {
        assert_eq!(
            refused(&["--max-rounds", "many"]),
            "--max-rounds needs a whole number, got 'many'"
        );
        assert_eq!(
            refused(&["--max-output-tokens", "1e3"]),
            "--max-output-tokens needs a whole number, got '1e3'"
        );
        assert_eq!(
            refused(&["--port", "eighty"]),
            "--port needs a port number between 0 and 65535, got 'eighty'"
        );
        assert_eq!(
            refused(&["--port", "70000"]),
            "--port needs a port number between 0 and 65535, got '70000'"
        );
        assert_eq!(
            refused(&["--max-rounds"]),
            "--max-rounds needs a whole number"
        );
        assert_eq!(refused(&["--port"]), "--port needs a port number");
    }

    #[test]
    fn port_zero_is_the_ephemeral_port_not_an_error() {
        let args = parse(&["web", "--port", "0", "--host", "127.0.0.1"]);
        assert_eq!(args.command, Some(CommandWord::Web));
        assert_eq!(args.port, Some(0));
        assert_eq!(args.host, Some("127.0.0.1".to_owned()));
    }

    #[test]
    fn every_command_word_is_recognised() {
        let words = [
            ("models", CommandWord::Models),
            ("tools", CommandWord::Tools),
            ("commands", CommandWord::Commands),
            ("sessions", CommandWord::Sessions),
            ("web", CommandWord::Web),
            ("workspaces", CommandWord::Workspaces),
            ("context", CommandWord::Context),
            ("hooks", CommandWord::Hooks),
            ("profiles", CommandWord::Profiles),
            ("config", CommandWord::Config),
        ];
        for (word, command) in words {
            assert_eq!(parse(&[word]).command, Some(command), "{word}");
            assert_eq!(command.as_str(), word);
        }
    }

    #[test]
    fn the_last_command_word_wins() {
        assert_eq!(
            parse(&["models", "tools"]).command,
            Some(CommandWord::Tools)
        );
    }

    #[test]
    fn transcript_and_context_consume_the_next_token_as_a_session_id() {
        let args = parse(&["transcript", "session-7"]);
        assert_eq!(args.command, Some(CommandWord::Transcript));
        assert_eq!(args.target, Some("session-7".to_owned()));

        assert_eq!(parse(&["context"]).target, None);

        // The TypeScript build consumes the token whether or not it is a flag; kept as measured.
        let args = parse(&["transcript", "--json"]);
        assert_eq!(args.target, Some("--json".to_owned()));
        assert!(!args.json);
    }

    #[test]
    fn goal_and_tree_take_an_optional_positional_only_when_it_is_not_a_flag() {
        assert_eq!(
            parse(&["goal", "session-1"]).target,
            Some("session-1".to_owned())
        );
        assert_eq!(parse(&["goal"]).target, None);
        assert_eq!(parse(&["tree", "src"]).target, Some("src".to_owned()));
        assert_eq!(parse(&["tree"]).target, None);
        let args = parse(&["tree", "--json"]);
        assert_eq!(args.target, None, "--json is a flag, not a folder");
        assert!(args.json);
    }

    #[test]
    fn workspace_add_takes_a_path_and_an_optional_name() {
        let args = parse(&["workspace", "add", "~/proj"]);
        assert_eq!(args.command, Some(CommandWord::Workspace));
        assert_eq!(args.subcommand, Some(Subcommand::Add));
        assert_eq!(args.target, Some("~/proj".to_owned()));
        assert_eq!(args.name, None);

        let args = parse(&["workspace", "add", "~/proj", "project"]);
        assert_eq!(args.name, Some("project".to_owned()));

        // `--json` after the path is a flag, not a workspace named `--json`.
        let args = parse(&["workspace", "add", "~/proj", "--json"]);
        assert_eq!(args.name, None);
        assert!(args.json);

        let args = parse(&["workspace", "list"]);
        assert_eq!(args.subcommand, Some(Subcommand::List));
    }

    #[test]
    fn workspace_refuses_what_it_cannot_do_in_the_typescript_sentence() {
        assert_eq!(
            refused(&["workspace"]),
            "unknown workspace subcommand ''; try 'heddle workspace add <path> [name]', \
             'heddle workspace rename <id|path> <name>', 'heddle workspace remove <id|path>' \
             or 'heddle workspace list'"
        );
        assert_eq!(
            refused(&["workspace", "bogus"]),
            "unknown workspace subcommand 'bogus'; try 'heddle workspace add <path> [name]', \
             'heddle workspace rename <id|path> <name>', 'heddle workspace remove <id|path>' \
             or 'heddle workspace list'"
        );
        assert_eq!(refused(&["workspace", "add"]), "workspace add needs a path");
        assert_eq!(
            refused(&["workspace", "add", "--json"]),
            "workspace add needs a path"
        );
        assert_eq!(
            refused(&["workspace", "remove"]),
            "workspace remove needs a workspace id or path"
        );
        assert_eq!(
            refused(&["workspace", "rename", "abc"]),
            "workspace rename needs a name"
        );
        assert_eq!(
            refused(&["workspace", "rename", "--json", "name"]),
            "workspace rename needs a workspace id or path"
        );
    }

    #[test]
    fn session_new_takes_an_optional_branch() {
        let args = parse(&["session", "new"]);
        assert_eq!(args.command, Some(CommandWord::Session));
        assert_eq!(args.subcommand, Some(Subcommand::New));
        assert_eq!(args.target, None);

        assert_eq!(
            parse(&["session", "new", "main"]).target,
            Some("main".to_owned())
        );
        // A flag is not a branch.
        assert_eq!(parse(&["session", "new", "--json"]).target, None);
        assert_eq!(
            refused(&["session", "bogus"]),
            "unknown session subcommand 'bogus'; try 'heddle session new [<branch>]'"
        );
        assert_eq!(
            refused(&["session"]),
            "unknown session subcommand ''; try 'heddle session new [<branch>]'"
        );
    }

    #[test]
    fn file_needs_a_path() {
        assert_eq!(
            parse(&["file", "src/lib.rs"]).target,
            Some("src/lib.rs".to_owned())
        );
        assert_eq!(refused(&["file"]), "file needs a path");
        assert_eq!(refused(&["file", "--json"]), "file needs a path");
    }

    #[test]
    fn an_unknown_argument_is_named_verbatim() {
        assert_eq!(refused(&["--bogus"]), "unknown argument: --bogus");
        assert_eq!(refused(&["nonsense"]), "unknown argument: nonsense");
    }

    #[test]
    fn a_tree_is_named_by_a_profile_a_config_a_patch_or_the_project_base() {
        assert!(!names_a_tree(&Args::default(), false));
        assert!(names_a_tree(&Args::default(), true));
        let args = parse(&["--profile", "dev"]);
        assert!(names_a_tree(&args, false));
        let args = parse(&["--config", "a.yml"]);
        assert!(names_a_tree(&args, false));
        let args = parse(&["--patch", "p.yml"]);
        assert!(names_a_tree(&args, false));
        let args = parse(&["--turn", "hi"]);
        assert!(!names_a_tree(&args, false), "--turn alone names no tree");
    }

    /// The override layer's patch as plain JSON, the conversion `--origins` also makes.
    fn plain_patch(layer: &NamedLayer) -> Vec<serde_json::Value> {
        layer.entries[0]
            .patch
            .iter()
            .map(|value| heddle_config::plain_json(value).expect("a plain value"))
            .collect()
    }

    #[test]
    fn root_overrides_are_a_patch_of_the_session_and_sandbox_rows() {
        assert_eq!(root_overrides(&Args::default(), Path::new("/work")), None);

        let args = parse(&["--session-root", "sessions"]);
        let layer = root_overrides(&args, Path::new("/work")).expect("one override");
        assert_eq!(
            layer.layer, "override 1",
            "the build numbers overrides from 1"
        );
        assert_eq!(
            plain_patch(&layer),
            vec![serde_json::json!({
                "id": "session",
                "config": { "root": "/work/sessions" },
            })]
        );

        let args = parse(&["--session-root", "/tmp/s", "--sandbox-root", "../box"]);
        let layer = root_overrides(&args, Path::new("/work/sub")).expect("two overrides");
        assert_eq!(
            plain_patch(&layer),
            vec![
                serde_json::json!({ "id": "session", "config": { "root": "/tmp/s" } }),
                serde_json::json!({
                    "id": "sandbox",
                    "config": { "workspaceRoot": "/work/box" },
                }),
            ]
        );
    }

    #[test]
    fn config_args_carry_the_flags_the_configuration_commands_read() {
        let args = parse(&[
            "--config",
            "base.yml",
            "--patch",
            "p.yml",
            "--json",
            "--origins",
            "--validate",
        ]);
        let env = Env::from_pairs([("HOME", "/home/seat")]);
        let config = config_args(&args, Path::new("/work"), &env);
        assert_eq!(config.config, Some(PathBuf::from("base.yml")));
        assert_eq!(config.patches, vec![PathBuf::from("p.yml")]);
        assert!(config.json && config.origins && config.validate);
        assert_eq!(config.profile, None);
    }
}
